/**
 * `Idempotency-Key` (spec 1, 5.9): money-writing and order-creating commands run once per key. A retry with the same
 * key and the same body returns the stored response; the same key with another body is 422 `idempotency_mismatch`;
 * a retry while the first call is still running is 409 `request_in_progress`. Failed calls leave no trace (the app
 * may retry with the same key). Without the header the command simply runs.
 */
const { Receipt } = require('../models');
const tenant = require('./tenant');
const { sha256 } = require('./util');
const { AppError } = require('./errors');

const TTL_MS = 24 * 3600 * 1000;
const STALE_PENDING_MS = 2 * 60 * 1000;

/** `fn()` must resolve to `{ status, body }`. */
async function idempotent(req, scope, fn) {
  const raw = req.get('idempotency-key');
  if (!raw) return fn();
  const key = String(raw).slice(0, 100);
  const _id = `idem|${tenant.current()}|${scope}|${sha256(key)}`;
  const fingerprint = sha256(`${req.method} ${(req.originalUrl || req.url).split('?')[0]} ${JSON.stringify(req.body || {})}`);
  const now = Date.now();
  try {
    await Receipt.create({ _id, state: 'pending', result: { fingerprint, at: now }, expireAt: new Date(now + TTL_MS) });
  } catch (err) {
    if (err.code !== 11000) throw err;
    const prior = await Receipt.findById(_id).lean();
    if (!prior) return idempotent(req, scope, fn);
    if (prior.result?.fingerprint !== fingerprint) throw new AppError(422, 'idempotency_mismatch');
    if (prior.state === 'done') return { status: prior.status, body: prior.result.body };
    if (now - (prior.result?.at || 0) < STALE_PENDING_MS) throw new AppError(409, 'request_in_progress');
    await Receipt.deleteOne({ _id, state: 'pending' });
    return idempotent(req, scope, fn);
  }
  try {
    const out = await fn();
    await Receipt.updateOne({ _id }, { $set: { state: 'done', status: out.status, result: { fingerprint, at: now, body: out.body } } });
    return out;
  } catch (err) {
    await Receipt.deleteOne({ _id }).catch(() => {});
    throw err;
  }
}

module.exports = { idempotent };
