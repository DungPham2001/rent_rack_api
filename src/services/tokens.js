/**
 * Sessions and tokens (spec 2.3).
 * - access token: JWT HS256, 2 h, claims sub (account), sid (session). Never trusted alone: every request re-reads
 *   the session and the account, so logout, revoke, password reset and device removal take effect at once.
 * - refresh token: "<sessionId>.<random>", only its sha256 is stored, rotated on every use (reuse revokes the session).
 *   Not remembered: sliding 3 h idle, 12 h absolute. Remembered: sliding 30 days idle.
 * - resume token ("Ghi nhớ"): random, only its sha256 is stored, valid 30 days of non-use (sliding). The app calls
 *   `resume` with it after a restart and lands on the dashboard.
 */
const jwt = require('jsonwebtoken');
const config = require('../config');
const { Session } = require('../models');
const { uuid, sha256, randomToken, iso, safeEqual } = require('../lib/util');
const { unauthorized } = require('../lib/errors');

const S = config.session;

function signAccess(account, session) {
  const now = Math.floor(Date.now() / 1000);
  const exp = Math.min(now + S.accessTtlSec, Math.floor(session.absoluteExpiresAt.getTime() / 1000));
  const token = jwt.sign(
    { sub: account._id, sid: session._id, iat: now, exp },
    config.jwt.secret,
    { algorithm: 'HS256', issuer: config.jwt.issuer, audience: config.jwt.audience },
  );
  return { token, expiresAt: new Date(exp * 1000), ttl: exp - now };
}

function bundle(account, session, refreshToken, resumeToken) {
  const access = signAccess(account, session);
  const out = {
    tokenType: 'Bearer',
    accessToken: access.token,
    accessTokenExpiresAt: iso(access.expiresAt),
    expiresIn: Math.max(0, access.ttl),
    sessionId: session._id,
    refreshToken,
    refreshTokenExpiresAt: iso(session.refreshExpiresAt),
    sessionExpiresAt: iso(session.absoluteExpiresAt),
  };
  if (resumeToken) out.resumeToken = resumeToken;
  return out;
}

const newRefresh = (sessionId) => `${sessionId}.${randomToken(32)}`;
const idleSec = (remember) => (remember ? S.rememberIdleSec : S.refreshIdleSec);
const idleUntil = (remember, absolute) => new Date(Math.min(Date.now() + idleSec(remember) * 1000, absolute.getTime()));

/** New session for a login / sign-up. One session per (account, clientDeviceId); the oldest beyond the cap are revoked. */
async function openSession(account, { deviceName, clientDeviceId, remember = false } = {}) {
  const now = new Date();
  if (clientDeviceId) {
    await Session.updateMany({ accountId: account._id, clientDeviceId, revokedAt: null }, { $set: { revokedAt: now, revokeReason: 'replaced' } });
  }
  const _id = uuid();
  const refreshToken = newRefresh(_id);
  const resumeToken = remember ? randomToken(32) : null;
  const absoluteExpiresAt = new Date(now.getTime() + (remember ? S.rememberMaxSec : S.maxAgeSec) * 1000);
  const session = await Session.create({
    _id,
    accountId: account._id,
    name: deviceName || '',
    clientDeviceId: clientDeviceId || null,
    remember: !!remember,
    refreshHash: sha256(refreshToken),
    refreshExpiresAt: idleUntil(remember, absoluteExpiresAt),
    absoluteExpiresAt,
    resumeHash: resumeToken ? sha256(resumeToken) : null,
    resumeExpiresAt: resumeToken ? new Date(now.getTime() + S.rememberIdleSec * 1000) : null,
    createdAt: now,
    lastSeenAt: now,
    expireAt: new Date(absoluteExpiresAt.getTime() + 7 * 86400000),
  });

  const active = await Session.find({ accountId: account._id, revokedAt: null, absoluteExpiresAt: { $gt: now } }).sort({ lastSeenAt: -1 }).select('_id').lean();
  const extra = active.slice(S.maxPerAccount).map((x) => x._id);
  if (extra.length) await Session.updateMany({ _id: { $in: extra } }, { $set: { revokedAt: now, revokeReason: 'too_many_sessions' } });

  return bundle(account, session.toObject(), refreshToken, resumeToken);
}

/** Exchanges a refresh token for a new pair (rotation + reuse detection). */
async function refresh(refreshToken, loadAccount) {
  const raw = typeof refreshToken === 'string' ? refreshToken : '';
  const sessionId = raw.split('.')[0];
  if (!sessionId || !raw.includes('.')) throw unauthorized('session_expired');
  const hash = sha256(raw);
  const now = new Date();

  const session = await Session.findById(sessionId).lean();
  if (!session || session.revokedAt) throw unauthorized('session_expired');
  if (session.prevRefreshHash && hash === session.prevRefreshHash) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'refresh_reused' } });
    throw unauthorized('session_expired');
  }
  if (hash !== session.refreshHash) throw unauthorized('session_expired');
  if (session.absoluteExpiresAt <= now || session.refreshExpiresAt <= now) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'expired' } });
    throw unauthorized('session_expired');
  }
  const account = await loadAccount(session.accountId);
  if (!account) throw unauthorized('session_expired');

  const next = newRefresh(sessionId);
  const set = { refreshHash: sha256(next), prevRefreshHash: hash, refreshExpiresAt: idleUntil(session.remember, session.absoluteExpiresAt), lastSeenAt: now };
  if (session.remember) set.resumeExpiresAt = new Date(now.getTime() + S.rememberIdleSec * 1000);
  const updated = await Session.findOneAndUpdate({ _id: sessionId, refreshHash: hash, revokedAt: null }, { $set: set }, { new: true }).lean();
  if (!updated) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'refresh_reused' } });
    throw unauthorized('session_expired');
  }
  return bundle(account, updated, next);
}

/** "Ghi nhớ": new access + refresh token from `sessionId` + `resumeToken`. The resume token itself does not change. */
async function resume(sessionId, resumeToken, loadAccount) {
  const now = new Date();
  const session = typeof sessionId === 'string' && sessionId ? await Session.findById(sessionId).lean() : null;
  if (!session || session.revokedAt || !session.remember || !session.resumeHash || typeof resumeToken !== 'string') throw unauthorized('session_expired');
  if (!safeEqual(session.resumeHash, sha256(resumeToken))) throw unauthorized('session_expired');
  if (session.resumeExpiresAt <= now || session.absoluteExpiresAt <= now) {
    await Session.updateOne({ _id: sessionId }, { $set: { revokedAt: now, revokeReason: 'expired' } });
    throw unauthorized('session_expired');
  }
  const account = await loadAccount(session.accountId);
  if (!account) throw unauthorized('session_expired');
  const next = newRefresh(sessionId);
  const updated = await Session.findOneAndUpdate(
    { _id: sessionId, revokedAt: null },
    { $set: { refreshHash: sha256(next), prevRefreshHash: null, refreshExpiresAt: idleUntil(true, session.absoluteExpiresAt), resumeExpiresAt: new Date(now.getTime() + S.rememberIdleSec * 1000), lastSeenAt: now } },
    { new: true },
  ).lean();
  if (!updated) throw unauthorized('session_expired');
  return { account, tokens: bundle(account, updated, next) };
}

function verifyAccess(token) {
  try {
    return jwt.verify(token, config.jwt.secret, { algorithms: ['HS256'], issuer: config.jwt.issuer, audience: config.jwt.audience });
  } catch {
    throw unauthorized('session_expired'); // the app refreshes (or signs in again) on every 401 session_expired
  }
}

/** Revokes sessions matching `filter` (logout, password change, device removal, revoked admin, account deletion). */
const revoke = (filter, reason) => Session.updateMany({ ...filter, revokedAt: null }, { $set: { revokedAt: new Date(), revokeReason: reason } });

module.exports = { openSession, refresh, resume, verifyAccess, revoke };
