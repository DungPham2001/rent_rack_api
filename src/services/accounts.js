/**
 * Accounts, sessions, password flows, admins of a shop (spec 2). One role only: admin. Every admin of a shop has the
 * same rights. Email is unique across the whole system. Validation errors here use the codes of spec 12
 * (required_missing, invalid_email, weak_password... all 422), not the generic validation_failed.
 */
const models = require('../models');
const config = require('../config');
const tenant = require('../lib/tenant');
const { AppError, unauthorized, forbidden, conflict, notFound } = require('../lib/errors');
const { uuid, sha256, humanCode, normalizeCode, iso, noAccent, randomToken } = require('../lib/util');
const password = require('../lib/password');
const attempts = require('../lib/attempts');
const mailer = require('../lib/mailer');
const tokens = require('./tokens');
const settings = require('./settings');
const audit = require('./audit');

const { Account, Session, PasswordReset, Receipt } = models;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
const LANGS = ['vi', 'en'];

const fail = (status, code, field) => new AppError(status, code, field ? { fields: [{ field, code }] } : {});

// ---------- input checks ----------

function email(body, key = 'email') {
  const v = typeof body?.[key] === 'string' ? body[key].trim().toLowerCase() : '';
  if (!v) throw fail(422, 'required_missing', key);
  if (v.length > 254 || !EMAIL.test(v)) throw fail(422, 'invalid_email', key);
  return v;
}

function newPassword(body, key = 'password') {
  const v = body?.[key];
  if (typeof v !== 'string' || !v) throw fail(422, 'required_missing', key);
  if (Buffer.byteLength(v, 'utf8') > 72 || v.length < 8 || !/\p{Lu}/u.test(v) || !/\p{Ll}/u.test(v) || !/\d/.test(v)) throw fail(422, 'weak_password', key);
  return v;
}

function text(body, key, { required = false, max = 200 } = {}) {
  const v = typeof body?.[key] === 'string' ? body[key].trim() : '';
  if (required && !v) throw fail(422, 'required_missing', key);
  if (v.length > max) throw fail(400, 'validation_failed', key);
  return v;
}

const device = (body) => {
  const d = body?.device;
  const o = typeof d === 'string' ? { name: d } : d && typeof d === 'object' ? d : {};
  return {
    deviceName: String(o.name || body?.deviceName || '').slice(0, 80),
    clientDeviceId: String(o.id || body?.deviceId || '').slice(0, 100) || null,
    remember: body?.remember === true,
  };
};

// ---------- presenters ----------

const presentMe = (a) => ({ id: a._id, email: a.email, name: a.name, phone: a.phone || '', language: a.language, shopId: a.shopId, status: a.status, createdAt: iso(a.createdAt) });

async function shopOf(account) {
  const s = await tenant.run(account.shopId, () => settings.get('shop'));
  return { id: account.shopId, name: s.name || '' };
}

async function authResponse(account, dev) {
  const t = await tokens.openSession(account, dev);
  const { refreshToken, refreshTokenExpiresAt, ...rest } = t;
  return { ...rest, refreshToken, refreshTokenExpiresAt, me: presentMe(account), shop: await shopOf(account) };
}

const loadAccount = (id) => Account.findById(id).lean();
const searchOf = (a) => noAccent([a.name, a.email, a.phone].filter(Boolean).join(' '));

// ---------- register / login ----------

/** POST /v1/auth/register-shop: creates the shop, its first admin and the session in one go. Public. */
async function registerShop(body, { lang, idempotencyKey }) {
  const shopName = text(body, 'shopName', { required: true, max: 120 });
  const ownerName = text(body, 'ownerName', { required: true, max: 100 });
  const mail = email(body);
  const plain = newPassword(body);
  const shopPhone = text(body, 'shopPhone', { max: 30 });
  const address = text(body, 'address', { max: 300 });
  const dev = device(body);
  const idemKey = typeof idempotencyKey === 'string' && idempotencyKey ? idempotencyKey.slice(0, 100) : null;

  if (idemKey) {
    const receipt = await Receipt.findById(`register|${sha256(idemKey)}`).lean();
    if (receipt?.state === 'done') {
      const prior = await loadAccount(receipt.result.accountId);
      if (!prior || prior.email !== mail || !(await password.verify(plain, prior.passwordHash))) throw conflict('email_taken');
      return { status: 200, body: await authResponse(prior, dev) };
    }
  }
  if (await Account.exists({ email: mail })) throw conflict('email_taken');

  const now = new Date();
  const id = uuid();
  const doc = {
    _id: id, email: mail, passwordHash: await password.hash(plain), name: ownerName, phone: '', language: LANGS.includes(lang) ? lang : 'vi',
    shopId: id, status: 'active', passwordChangedAt: now, createdAt: now, updatedAt: now,
  };
  doc.search = searchOf(doc);
  try {
    await Account.create(doc);
  } catch (err) {
    if (err.code === 11000) throw conflict('email_taken');
    throw err;
  }
  await tenant.run(id, () => settings.initShop({ name: shopName, phone: shopPhone, address, owner: ownerName }));
  if (idemKey) await Receipt.create({ _id: `register|${sha256(idemKey)}`, state: 'done', result: { accountId: id }, expireAt: new Date(Date.now() + 86400000) }).catch(() => {});
  return { status: 201, body: await authResponse(doc, dev) };
}

async function checkCredentials(mail, plain) {
  const account = await Account.findOne({ email: mail }).lean();
  const lockKey = account ? account._id : `login:${mail}`;
  await attempts.assertNotLocked('login', lockKey);
  if (!(await password.verify(plain, account?.passwordHash))) {
    await attempts.recordFailure('login', lockKey);
    throw unauthorized('invalid_credentials');
  }
  await attempts.clearFailures('login', lockKey);
  return account;
}

/** POST /v1/auth/login { email, password, device, remember } */
async function login(body) {
  const mail = email(body);
  if (typeof body?.password !== 'string' || !body.password) throw fail(422, 'required_missing', 'password');
  const account = await checkCredentials(mail, body.password);
  if (account.status === 'revoked') throw forbidden('account_revoked');
  Account.updateOne({ _id: account._id }, { $set: { lastLoginAt: new Date() } }).catch(() => {});
  return authResponse(account, device(body));
}

const refreshable = async (id) => {
  const a = await loadAccount(id);
  if (a?.status === 'revoked') throw forbidden('account_revoked');
  return a;
};

/** POST /v1/auth/refresh { refreshToken } */
async function refresh(body) {
  const t = await tokens.refresh(body?.refreshToken, refreshable);
  const account = await loadAccount((await Session.findById(t.sessionId).lean()).accountId);
  return { ...t, me: presentMe(account), shop: await shopOf(account) };
}

/** POST /v1/auth/resume { sessionId, resumeToken } ("Ghi nhớ": the app reopens straight on the dashboard) */
async function resume(body) {
  const { account, tokens: t } = await tokens.resume(body?.sessionId, body?.resumeToken, refreshable);
  return { ...t, me: presentMe(account), shop: await shopOf(account) };
}

async function logout(body, auth) {
  const rt = typeof body?.refreshToken === 'string' ? body.refreshToken : '';
  if (rt.includes('.')) {
    const [sid] = rt.split('.');
    await Session.updateOne({ _id: sid, refreshHash: sha256(rt), revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: 'logout' } });
  }
  const sid = auth?.sessionId || (typeof body?.sessionId === 'string' ? body.sessionId : null);
  if (sid && auth) await tokens.revoke({ _id: sid, accountId: auth.accountId }, 'logout');
}

// ---------- password ----------

/** POST /v1/auth/forgot { email }: always the same answer, whether the email exists or not. */
async function forgot(body, { lang }) {
  const mail = email(body);
  const out = { status: 'accepted' };
  if ((await attempts.bump(`forgot|${sha256(mail)}`, 3600)) > 3) return out;
  const account = await Account.findOne({ email: mail }).lean();
  if (!account || account.status === 'revoked') return out;
  const code = humanCode(8);
  await PasswordReset.updateMany({ accountId: account._id, usedAt: null }, { $set: { usedAt: new Date() } });
  await PasswordReset.create({ _id: uuid(), accountId: account._id, codeHash: sha256(code), expiresAt: new Date(Date.now() + config.resetCodeSec * 1000) });
  const sent = await mailer.sendResetCode(account.email, code, lang || account.language, account.name);
  if (!sent && !mailer.enabled() && config.env !== 'production') out.devToken = mailer.pretty(code);
  return out;
}

/** POST /v1/auth/reset { token, password } (or newPassword): signs out every device. */
async function reset(body, { lang } = {}) {
  const code = typeof body?.token === 'string' ? body.token : '';
  if (!code) throw fail(422, 'required_missing', 'token');
  const plain = newPassword({ password: body.password ?? body.newPassword });
  const now = new Date();
  const r = await PasswordReset.findOneAndUpdate({ codeHash: sha256(normalizeCode(code)), usedAt: null, expiresAt: { $gt: now } }, { $set: { usedAt: now } }, { new: true }).lean();
  if (!r) throw new AppError(400, 'reset_invalid');
  const account = await Account.findOneAndUpdate({ _id: r.accountId }, { $set: { passwordHash: await password.hash(plain), passwordChangedAt: now, updatedAt: now } }, { new: true }).lean();
  await tokens.revoke({ accountId: r.accountId }, 'password_reset');
  if (account) {
    await Promise.all([attempts.clearFailures('login', account._id), attempts.clearFailures('confirm', account._id)]);
    await mailer.sendPasswordChanged(account, { via: 'reset', lang });
  }
}

/** Password re-check for sensitive actions (change password, delete account): counts toward the lock. */
async function confirmPassword(account, plain, field = 'password') {
  await attempts.assertNotLocked('confirm', account._id);
  if (typeof plain !== 'string' || !(await password.verify(plain, account.passwordHash))) {
    await attempts.recordFailure('confirm', account._id);
    throw fail(422, 'wrong_password', field);
  }
  await attempts.clearFailures('confirm', account._id);
}

/** POST /v1/auth/change-password { current, next }: the other devices are signed out. */
async function changePassword(auth, body, { lang } = {}) {
  if (typeof body?.current !== 'string' || !body.current) throw fail(422, 'required_missing', 'current');
  const plain = newPassword({ next: body.next }, 'next');
  await confirmPassword(auth.account, body.current, 'current');
  if (body.current === plain) throw fail(422, 'same_password', 'next');
  const now = new Date();
  await Account.updateOne({ _id: auth.accountId }, { $set: { passwordHash: await password.hash(plain), passwordChangedAt: now, updatedAt: now } });
  const r = await tokens.revoke({ accountId: auth.accountId, _id: { $ne: auth.sessionId } }, 'password_changed');
  await mailer.sendPasswordChanged(auth.account, { via: 'change', deviceName: auth.deviceName, lang });
  return { status: 'ok', revokedSessions: r.modifiedCount || 0 };
}

// ---------- me ----------

/** PATCH /v1/me { name, phone, language } (email is read-only) */
async function updateMe(auth, body) {
  const set = {};
  if (body?.name !== undefined) set.name = text(body, 'name', { required: true, max: 100 });
  if (body?.phone !== undefined) set.phone = text(body, 'phone', { max: 30 });
  if (body?.language !== undefined) {
    if (!LANGS.includes(body.language)) throw new AppError(400, 'validation_failed', { fields: [{ field: 'language', code: 'invalid_enum' }] });
    set.language = body.language;
  }
  set.search = searchOf({ ...auth.account, ...set });
  set.updatedAt = new Date();
  await Account.updateOne({ _id: auth.accountId }, { $set: set });
  return presentMe(await loadAccount(auth.accountId));
}

/** DELETE /v1/me { password }: the last admin of a shop takes the whole shop with them (real deletion). */
async function deleteAccount(account, plain) {
  await confirmPassword(account, plain);
  const others = await Account.countDocuments({ shopId: account.shopId, _id: { $ne: account._id } });
  if (!others) {
    await require('./privacy').purgeShop(account.shopId);
    return { shopDeleted: true };
  }
  await Session.deleteMany({ accountId: account._id });
  await PasswordReset.deleteMany({ accountId: account._id });
  await Account.deleteOne({ _id: account._id });
  await audit.log({ accountId: null, account: { name: account.name } }, 'account', account._id, 'self_deleted', account.email);
  return { shopDeleted: false };
}

/** Web deletion form: email + password. */
async function deleteByCredentials(body) {
  const mail = email(body);
  const account = await checkCredentials(mail, body?.password);
  return tenant.run(account.shopId, () => deleteAccount(account, body.password));
}

// ---------- devices ----------

async function listSessions(auth) {
  const rows = await Session.find({ accountId: auth.accountId, revokedAt: null, absoluteExpiresAt: { $gt: new Date() } }).sort({ lastSeenAt: -1 }).lean();
  return { items: rows.map((s) => ({ id: s._id, name: s.name || '', remember: !!s.remember, createdAt: iso(s.createdAt), lastSeenAt: iso(s.lastSeenAt), expiresAt: iso(s.absoluteExpiresAt), isCurrent: s._id === auth.sessionId })) };
}

async function removeSession(auth, id) {
  const r = await tokens.revoke({ _id: id, accountId: auth.accountId }, 'removed');
  if (!r.matchedCount) throw notFound();
}

// ---------- admins of the shop ----------

async function listAdmins(auth) {
  const rows = await Account.find({ shopId: auth.shopId }).sort({ createdAt: 1 }).lean();
  return { items: rows.map((a) => ({ ...presentMe(a), lastLoginAt: iso(a.lastLoginAt), isOwner: a._id === a.shopId })) };
}

/** POST /v1/admins { email, name, password }: the person changes the password later in Hồ sơ. */
async function createAdmin(auth, body) {
  const mail = email(body);
  const name = text(body, 'name', { required: true, max: 100 });
  const plain = newPassword(body);
  if (await Account.exists({ email: mail })) throw conflict('email_taken');
  const now = new Date();
  const doc = { _id: uuid(), email: mail, passwordHash: await password.hash(plain), name, phone: text(body, 'phone', { max: 30 }), language: 'vi', shopId: auth.shopId, status: 'active', passwordChangedAt: now, createdAt: now, updatedAt: now };
  doc.search = searchOf(doc);
  try {
    await Account.create(doc);
  } catch (err) {
    if (err.code === 11000) throw conflict('email_taken');
    throw err;
  }
  await audit.log(auth, 'account', doc._id, 'admin_added', mail);
  return presentMe(doc);
}

async function targetAdmin(auth, id) {
  const target = await Account.findOne({ _id: id, shopId: auth.shopId }).lean();
  if (!target) throw notFound(); // another shop's account looks like a missing one
  return target;
}

async function revokeAdmin(auth, id) {
  const target = await targetAdmin(auth, id);
  if (target.status === 'revoked') return presentMe(target);
  const others = await Account.countDocuments({ shopId: auth.shopId, status: 'active', _id: { $ne: target._id } });
  if (!others) throw conflict('last_admin'); // the shop always keeps one active admin
  if (target._id === auth.accountId) throw forbidden('forbidden'); // nobody revokes themselves: use "delete account"
  await Account.updateOne({ _id: target._id }, { $set: { status: 'revoked', updatedAt: new Date() } });
  await tokens.revoke({ accountId: target._id }, 'admin_revoked');
  await audit.log(auth, 'account', target._id, 'admin_revoked', target.email);
  return presentMe(await loadAccount(target._id));
}

/** POST /v1/admins/:id/reset-password { password }: signs the person out everywhere. */
async function resetAdminPassword(auth, id, body) {
  const target = await targetAdmin(auth, id);
  const plain = newPassword(body);
  const now = new Date();
  await Account.updateOne({ _id: id }, { $set: { passwordHash: await password.hash(plain), passwordChangedAt: now, updatedAt: now } });
  await tokens.revoke({ accountId: id }, 'password_reset');
  await Promise.all([attempts.clearFailures('login', id), attempts.clearFailures('confirm', id)]);
  await audit.log(auth, 'account', id, 'admin_password_reset', target.email);
}

const tempPassword = () => `Tp${randomToken(9).replace(/[-_]/g, 'x')}7a`; // upper + lower + digit, for scripts

module.exports = {
  presentMe, registerShop, login, refresh, resume, logout, forgot, reset, changePassword, confirmPassword, updateMe,
  deleteAccount, deleteByCredentials, listSessions, removeSession, listAdmins, createAdmin, revokeAdmin, resetAdminPassword, tempPassword, searchOf,
};
