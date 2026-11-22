/** Waiting list (spec 5.11): each open request with the pieces that are free right now for its style, size and dates. */
const mongoose = require('mongoose');
const schedule = require('./schedule');
const { byPath } = require('../resources/defs');
const { paging, page } = require('../resources/engine');
const T = require('../lib/time');
const settings = require('./settings');

async function list(query) {
  const S = await settings.ctx();
  const f = {};
  if (query.status) f.status = String(query.status);
  const p = paging(query, {});
  const M = mongoose.model('Wait');
  const [rows, total] = await Promise.all([M.find(f).sort({ from: 1 }).skip(p.skip).limit(p.limit + 1).lean(), M.countDocuments(f)]);
  const items = rows.map(byPath.waits.present);
  for (const w of items.slice(0, p.limit)) {
    w.matches = [];
    if (w.status === 'open' && w.to >= S.today && T.isDate(w.from) && T.isDate(w.to)) {
      const a = await schedule.availability({ from: w.from < S.today ? S.today : w.from, to: w.to, styleId: w.styleId, size: w.size || undefined, customerId: w.customerId || undefined });
      w.matches = a.items.slice(0, 5);
    }
  }
  return page(items, p, total);
}

module.exports = { list };
