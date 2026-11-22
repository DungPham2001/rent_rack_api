/**
 * `GET /v1/sync?since=<ISO>&limit=500` — everything that changed since `since` (all when omitted), plus deleted ids, for
 * an app that keeps a local copy (spec 13.2 option a). Rows come oldest change first; when a resource has more than
 * `limit` rows the response says `hasMore` and `nextSince`: call again with it. `since` is inclusive, so the app upserts
 * by id (a row may arrive twice). The first call's `serverTime` is the safe `since` for the next full cycle.
 */
const mongoose = require('mongoose');
const { resources } = require('../resources/defs');
const orders = require('./orders');
const holds = require('./holds');
const cleaning = require('./cleaning');
const { AppError } = require('../lib/errors');
const { iso } = require('../lib/util');

const M = (name) => mongoose.model(name);

const SPECIAL = {
  orders: { model: 'Order', present: orders.presentMany },
  holds: { model: 'Hold', present: holds.presentMany },
  cleaning: { model: 'Cleaning', present: cleaning.presentMany },
};

async function sync(query) {
  const serverTime = new Date();
  let since = null;
  if (query.since) {
    since = new Date(query.since);
    if (Number.isNaN(since.getTime())) throw new AppError(400, 'validation_failed', { fields: [{ field: 'since', code: 'invalid_format' }] });
  }
  const limit = Math.min(Math.max(parseInt(query.limit, 10) || 500, 1), 2000);
  const want = query.resources ? new Set(String(query.resources).split(',')) : null;
  const filter = since ? { updatedAt: { $gte: since } } : {};
  const changes = {};
  let hasMore = false;
  let nextSince = null;

  const jobs = [
    ...resources.filter((r) => r.def.path !== 'fit-memory').map((r) => ({ path: r.def.path, model: r.model, present: (rows) => rows.map(r.present) })),
    ...Object.entries(SPECIAL).map(([path, s]) => ({ path, model: M(s.model), present: s.present })),
  ].filter((j) => !want || want.has(j.path));

  for (const j of jobs) {
    const rows = await j.model.find(filter).sort({ updatedAt: 1, _id: 1 }).limit(limit + 1).lean();
    const more = rows.length > limit;
    const slice = rows.slice(0, limit);
    changes[j.path] = await j.present(slice);
    if (more) {
      hasMore = true;
      const last = iso(slice[slice.length - 1].updatedAt);
      if (!nextSince || last < nextSince) nextSince = last;
    }
  }
  const tombs = await M('Tombstone').find(since ? { at: { $gte: since } } : {}).sort({ at: 1 }).limit(5000).lean();
  return {
    serverTime: iso(serverTime), hasMore, nextSince: hasMore ? nextSince : iso(serverTime), changes,
    deleted: tombs.filter((t) => !want || want.has(t.resource)).map((t) => ({ resource: t.resource, id: t.rid, at: iso(t.at) })),
  };
}

module.exports = { sync };
