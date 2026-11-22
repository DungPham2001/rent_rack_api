/** Sensitive actions (spec 10). Only the server writes here: `GET /v1/admin-log` is read-only. */
const { AdminAction } = require('../models');
const { uuid, iso } = require('../lib/util');
const { paging, page } = require('../resources/engine');

/** `auth` = req.auth, or null/"system" for jobs. */
async function log(auth, target, targetId, action, note = '') {
  await AdminAction.create({
    _id: uuid(), by: auth?.accountId || 'system', byName: auth?.account?.name || (auth ? '' : 'system'), target, targetId: targetId ? String(targetId) : null,
    action, note: String(note || '').slice(0, 1000), at: new Date(),
  });
}

async function list(query) {
  const filter = {};
  for (const k of ['target', 'targetId', 'action', 'by']) if (query[k]) filter[k] = String(query[k]);
  if (query.from || query.to) {
    filter.at = {};
    if (query.from) filter.at.$gte = new Date(`${query.from}T00:00:00Z`);
    if (query.to) filter.at.$lte = new Date(`${query.to}T23:59:59Z`);
  }
  const p = paging(query, { big: true });
  const [rows, total] = await Promise.all([
    AdminAction.find(filter).sort({ at: -1 }).skip(p.skip).limit(p.limit + 1).lean(),
    AdminAction.countDocuments(filter),
  ]);
  return page(rows.map((r) => ({ id: r._id, by: r.by, byName: r.byName, target: r.target, targetId: r.targetId, action: r.action, note: r.note, at: iso(r.at) })), p, total);
}

module.exports = { log, list };
