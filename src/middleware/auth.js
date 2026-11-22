/**
 * Identity comes only from the access token. The session and the account are re-read on every request, so logout,
 * password reset, device removal and admin revocation take effect immediately (spec 2.3). Every admin of a shop has
 * the same rights; the shop of the request is the account's `shopId`, never a value sent by the client.
 *
 * - session revoked / expired / unknown -> 401 session_expired
 * - account revoked                     -> 403 account_revoked
 */
const { Account, Session } = require('../models');
const { verifyAccess } = require('../services/tokens');
const tenant = require('../lib/tenant');
const { asyncHandler, unauthorized, forbidden } = require('../lib/errors');

const TOUCH_MS = 5 * 60 * 1000;

async function resolve(req) {
  const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
  if (!m) throw unauthorized('session_expired');
  const claims = verifyAccess(m[1]);
  const [session, account] = await Promise.all([Session.findById(claims.sid).lean(), Account.findById(claims.sub).lean()]);
  if (!account || !session || session.accountId !== claims.sub) throw unauthorized('session_expired');
  if (account.status === 'revoked') throw forbidden('account_revoked');
  if (session.revokedAt || session.absoluteExpiresAt <= new Date()) throw unauthorized('session_expired');
  if (Date.now() - new Date(session.lastSeenAt).getTime() > TOUCH_MS) {
    Session.updateOne({ _id: session._id }, { $set: { lastSeenAt: new Date() } }).catch(() => {});
  }
  return { accountId: account._id, account, shopId: account.shopId, sessionId: session._id, deviceName: session.name || '' };
}

/** Authenticates, then runs the rest of the request inside the account's shop. */
const authenticate = asyncHandler(async (req, _res, next) => {
  req.auth = await resolve(req);
  tenant.run(req.auth.shopId, () => next());
});

module.exports = { authenticate, resolve };
