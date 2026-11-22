/**
 * Read-only reports computed from the data (spec 3, 9). Every report takes the same range:
 * `range=today|d7|d14|m1|m3|m6|y1|all|custom` (+ `from`, `to`); the previous period is the same length right before it.
 * "Today" and all day boundaries use the shop's timezone.
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const schedule = require('./schedule');
const ledger = require('./ledger');
const { AppError } = require('../lib/errors');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const INACTIVE = ['cancelled', 'expired'];
const DAYS = { today: 1, d7: 7, d14: 14, m1: 30, m3: 90, m6: 182, y1: 365 };

const bad = (field) => new AppError(400, 'validation_failed', { fields: [{ field, code: 'invalid_format' }] });

/** { from, to, days, previous: { from, to } } */
async function resolveRange(query = {}) {
  const S = await settings.ctx();
  const range = query.range || 'd7';
  let from;
  let to = S.today;
  if (range === 'custom') {
    if (!T.isDate(query.from)) throw bad('from');
    if (!T.isDate(query.to) || query.to < query.from) throw bad('to');
    ({ from, to } = query);
  } else if (range === 'all') {
    const [o, p] = await Promise.all([M('Order').findOne({}).sort({ createdAt: 1 }).select('createdAt').lean(), M('Payment').findOne({}).sort({ at: 1 }).select('at').lean()]);
    const firsts = [o?.createdAt, p?.at].filter(Boolean).map((d) => S.localDate(d)).sort();
    from = firsts[0] || S.today;
  } else if (DAYS[range]) {
    from = T.addDays(S.today, -(DAYS[range] - 1));
  } else throw bad('range');
  const days = T.diffDays(from, to) + 1;
  const prevTo = T.addDays(from, -1);
  return { range, from, to, days, previous: { from: T.addDays(prevTo, -(days - 1)), to: prevTo }, S };
}

const utcRange = (S, from, to) => [T.localToUtc(from, '00:00', S.tz), T.localToUtc(T.addDays(to, 1), '00:00', S.tz)];

const paymentsIn = (S, from, to) => {
  const [a, b] = utcRange(S, from, to);
  return M('Payment').find({ at: { $gte: a, $lt: b } }).lean();
};
const ordersCreatedIn = (S, from, to) => {
  const [a, b] = utcRange(S, from, to);
  return M('Order').find({ createdAt: { $gte: a, $lt: b }, status: { $nin: INACTIVE } }).lean();
};

/** Chart columns: 1 day -> 24 hours; <= 31 days -> days; <= 190 days -> weeks (Monday); longer -> months. */
function makeBuckets(from, to) {
  const days = T.diffDays(from, to) + 1;
  const out = [];
  if (days === 1) {
    for (let h = 0; h < 24; h += 1) out.push({ label: String(h).padStart(2, '0'), start: `${from}T${String(h).padStart(2, '0')}:00`, end: `${from}T${String(h).padStart(2, '0')}:59`, kind: 'hour', h });
  } else if (days <= 31) {
    for (let d = from; d <= to; d = T.addDays(d, 1)) out.push({ label: d.slice(8), start: d, end: d, kind: 'day' });
  } else if (days <= 190) {
    for (let d = from; d <= to;) {
      const end = T.addDays(T.weekStart(d), 6);
      out.push({ label: d.slice(5), start: d, end: end > to ? to : end, kind: 'week' });
      d = T.addDays(end, 1);
    }
  } else {
    for (let d = from; d <= to;) {
      const [y, m] = d.split('-').map(Number);
      const end = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
      out.push({ label: d.slice(0, 7), start: d, end: end > to ? to : end, kind: 'month' });
      d = T.addDays(end, 1);
    }
  }
  return out;
}

/** Index of the bucket holding the local instant `at` (a Date) or the local date `date`. */
function bucketIndex(buckets, S, { at, date }) {
  const d = date || S.localDate(at);
  if (buckets[0].kind === 'hour') return d === buckets[0].start.slice(0, 10) ? Math.floor(S.minuteOf(at) / 60) : -1;
  return buckets.findIndex((b) => d >= b.start && d <= b.end);
}

async function revenueBuckets(r) {
  const { S } = r;
  const cur = makeBuckets(r.from, r.to);
  const prev = makeBuckets(r.previous.from, r.previous.to);
  const [pays, orders, prevPays] = await Promise.all([paymentsIn(S, r.from, r.to), ordersCreatedIn(S, r.from, r.to), paymentsIn(S, r.previous.from, r.previous.to)]);
  const rows = cur.map((b) => ({ label: b.label, start: b.start, end: b.end, revenue: 0, prevRevenue: 0, orders: 0 }));
  for (const p of pays) {
    const i = bucketIndex(cur, S, { at: p.at });
    if (i >= 0) rows[i].revenue += ledger.revenueOf([p]);
  }
  for (const p of prevPays) {
    const i = bucketIndex(prev, S, { at: p.at });
    if (i >= 0 && i < rows.length) rows[i].prevRevenue += ledger.revenueOf([p]);
  }
  for (const o of orders) {
    const i = bucketIndex(cur, S, { at: o.createdAt });
    if (i >= 0) rows[i].orders += 1;
  }
  return { rows, pays, orders, prevPays };
}

async function occupancy(r) {
  const { S } = r;
  const pieces = await M('Piece').find({ status: { $nin: ['retired', 'disposed'] } }).lean();
  if (!pieces.length) return { rate: 0, rentedDays: 0, availableDays: 0 };
  const map = await schedule.bookingsOf(pieces.map((p) => p._id), { from: r.from });
  let rented = 0;
  let avail = 0;
  for (const p of pieces) {
    const start = [p.purchasedDate || S.localDate(p.createdAt), r.from].sort().pop();
    if (start > r.to) continue;
    avail += T.diffDays(start, r.to) + 1;
    const used = new Set();
    for (const b of map.get(p._id)) {
      if (b.kind !== 'rent') continue;
      for (let d = b.from > start ? b.from : start; d <= b.to && d <= r.to; d = T.addDays(d, 1)) used.add(d);
    }
    rented += used.size;
  }
  return { rate: avail ? Math.min(1, rented / avail) : 0, rentedDays: rented, availableDays: avail };
}

async function styleRanking(r, limit = 20, orders) {
  const list = orders || (await ordersCreatedIn(r.S, r.from, r.to));
  const by = new Map();
  for (const o of list) for (const l of o.lines) {
    const x = by.get(l.styleId) || { styleId: l.styleId, name: l.styleName || '', count: 0, revenue: 0 };
    x.count += 1;
    x.revenue += l.unit + l.surcharge;
    by.set(l.styleId, x);
  }
  const rows = [...by.values()].sort((a, b) => b.count - a.count || b.revenue - a.revenue).slice(0, limit);
  const styles = await M('Style').find({ _id: { $in: rows.map((x) => x.styleId) } }).select('name').lean();
  const nm = new Map(styles.map((s) => [s._id, s.name]));
  return rows.map((x) => ({ ...x, name: nm.get(x.styleId) || x.name }));
}

const pct = (cur, prev) => (prev > 0 ? Math.round(((cur - prev) / prev) * 1000) / 10 : null);

/** Revenue summary block shared by Home and the revenue report. */
async function revenueSummary(r) {
  const { rows, pays, orders, prevPays } = await revenueBuckets(r);
  const current = ledger.revenueOf(pays);
  const previous = ledger.revenueOf(prevPays);
  return { rows, pays, orders, summary: { current, previous, deltaPct: pct(current, previous) }, avgPerDay: Math.round(current / r.days) };
}

async function revenue(query) {
  const r = await resolveRange(query);
  const rv = await revenueSummary(r);
  const orderIds = [...new Set(rv.pays.filter((p) => p.orderId).map((p) => p.orderId))];
  const orders = await M('Order').find({ _id: { $in: orderIds } }).select('source customerId').lean();
  const om = new Map(orders.map((o) => [o._id, o]));
  const bySource = {};
  const byCustomer = {};
  for (const p of rv.pays) {
    const v = ledger.revenueOf([p]);
    const o = om.get(p.orderId);
    const src = o?.source || 'hold';
    bySource[src] = (bySource[src] || 0) + v;
    if (o) byCustomer[o.customerId] = (byCustomer[o.customerId] || 0) + v;
  }
  const custs = await M('Customer').find({ _id: { $in: Object.keys(byCustomer) } }).select('name phone').lean();
  const cm = new Map(custs.map((c) => [c._id, c]));
  return {
    range: { from: r.from, to: r.to, previous: r.previous }, revenue: rv.summary, ordersCreated: rv.orders.length, avgPerDay: rv.avgPerDay, buckets: rv.rows.map((b) => ({ label: b.label, start: b.start, end: b.end, revenue: b.revenue, prevRevenue: b.prevRevenue, orders: b.orders })),
    bySource: Object.entries(bySource).map(([source, revenue]) => ({ source, revenue })).sort((a, b) => b.revenue - a.revenue),
    byCustomer: Object.entries(byCustomer).map(([customerId, revenue]) => ({ customerId, name: cm.get(customerId)?.name || '', phone: cm.get(customerId)?.phone || '', revenue })).sort((a, b) => b.revenue - a.revenue).slice(0, 50),
  };
}

/** Profit and loss per piece (spec 9): order revenue shared by line, minus laundry / repair / alteration cost and depreciation. */
async function economics(query) {
  const r = await resolveRange({ range: 'all', ...query });
  const orders = await ordersCreatedIn(r.S, r.from, r.to);
  const by = new Map();
  const row = (id, code) => { if (!by.has(id)) by.set(id, { pieceId: id, code: code || '', rentals: 0, revenue: 0, cost: 0, depreciation: 0, profit: 0 }); return by.get(id); };
  for (const o of orders) {
    const base = o.rent + o.surcharge;
    for (const l of o.lines) {
      const x = row(l.pieceId, l.pieceCode);
      x.rentals += 1;
      x.revenue += base > 0 ? Math.round(((l.unit + l.surcharge) * (base - o.discount)) / base) : 0;
    }
  }
  const [pieces, jobs, alts] = await Promise.all([M('Piece').find({}).lean(), M('Cleaning').find({}).lean(), M('Alteration').find({}).lean()]);
  const pm = new Map(pieces.map((p) => [p._id, p]));
  for (const j of jobs) if (by.has(j.pieceId) || pm.has(j.pieceId)) row(j.pieceId, pm.get(j.pieceId)?.code).cost += j.cost || 0;
  for (const a of alts) if (by.has(a.pieceId) || pm.has(a.pieceId)) row(a.pieceId, pm.get(a.pieceId)?.code).cost += a.cost || 0;
  const items = [...by.values()].map((x) => {
    const p = pm.get(x.pieceId);
    x.code = p?.code || x.code;
    x.depreciation = p?.maxRentals > 0 ? Math.round((p.purchasePrice / p.maxRentals) * x.rentals) : 0;
    x.purchasePrice = p?.purchasePrice || 0;
    x.profit = x.revenue - x.cost - x.depreciation;
    return x;
  }).sort((a, b) => b.profit - a.profit);
  return { items, totals: items.reduce((t, x) => ({ revenue: t.revenue + x.revenue, cost: t.cost + x.cost, depreciation: t.depreciation + x.depreciation, profit: t.profit + x.profit }), { revenue: 0, cost: 0, depreciation: 0, profit: 0 }) };
}

/** Occurrences of an expense in [from, to]: once if not recurring, else once per month from its start date. */
function expenseHits(e, from, to) {
  if (!e.recurring) return e.date >= from && e.date <= to ? 1 : 0;
  let n = 0;
  const [y, m, d] = e.date.split('-').map(Number);
  for (let k = 0; k < 600; k += 1) {
    const last = new Date(Date.UTC(y, m - 1 + k + 1, 0)).getUTCDate();
    const date = new Date(Date.UTC(y, m - 1 + k, Math.min(d, last))).toISOString().slice(0, 10);
    if (date > to) break;
    if (date >= from) n += 1;
  }
  return n;
}

async function expenses(query) {
  const r = await resolveRange({ range: 'm1', ...query });
  const list = await M('Expense').find({}).lean();
  const byCategory = {};
  let total = 0;
  for (const e of list) {
    const n = expenseHits(e, r.from, r.to);
    if (n) { byCategory[e.category] = (byCategory[e.category] || 0) + e.amount * n; total += e.amount * n; }
  }
  return {
    range: { from: r.from, to: r.to }, total, byCategory: Object.entries(byCategory).map(([category, amount]) => ({ category, amount })).sort((a, b) => b.amount - a.amount),
    monthlyFixed: list.filter((e) => e.recurring).reduce((t, e) => t + e.amount, 0),
  };
}

async function vsTarget(query) {
  const S = await settings.ctx();
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(query.month || '') ? query.month : S.today.slice(0, 7);
  const [y, m] = month.split('-').map(Number);
  const to = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);
  const [t, pays] = await Promise.all([M('Target').findOne({ month }).lean(), paymentsIn(S, `${month}-01`, to)]);
  const rev = ledger.revenueOf(pays);
  return { month, target: t?.amount || 0, revenue: rev, pct: t?.amount ? Math.round((rev / t.amount) * 1000) / 10 : null };
}

/** Only with at least one year of data; otherwise `forecast: null`. Same month last year, scaled by the recent trend. */
async function forecast() {
  const S = await settings.ctx();
  const first = await M('Payment').findOne({}).sort({ at: 1 }).select('at').lean();
  if (!first || T.diffDays(S.localDate(first.at), S.today) < 365) return { forecast: null };
  const monthRev = async (ym) => {
    const [y, m] = ym.split('-').map(Number);
    return ledger.revenueOf(await paymentsIn(S, `${ym}-01`, new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10)));
  };
  const shift = (ym, k) => { const [y, m] = ym.split('-').map(Number); const d = new Date(Date.UTC(y, m - 1 + k, 1)); return d.toISOString().slice(0, 7); };
  const cur = S.today.slice(0, 7);
  let recent = 0;
  let before = 0;
  for (let k = 1; k <= 3; k += 1) { recent += await monthRev(shift(cur, -k)); before += await monthRev(shift(cur, -k - 12)); }
  const trend = before > 0 ? Math.min(2, Math.max(0.5, recent / before)) : 1;
  const months = [];
  for (let k = 1; k <= 3; k += 1) { const ym = shift(cur, k); months.push({ month: ym, forecast: Math.round((await monthRev(shift(ym, -12))) * trend) }); }
  return { forecast: { trend: Math.round(trend * 100) / 100, months } };
}

async function missed(query) {
  const r = await resolveRange({ range: 'm3', ...query });
  const rows = await M('Missed').find({ date: { $gte: r.from, $lte: r.to } }).lean();
  const by = new Map();
  for (const x of rows) by.set(x.styleId || '', (by.get(x.styleId || '') || 0) + 1);
  const styles = await M('Style').find({ _id: { $in: [...by.keys()].filter(Boolean) } }).select('name').lean();
  const nm = new Map(styles.map((s) => [s._id, s.name]));
  return { total: rows.length, items: [...by.entries()].map(([styleId, count]) => ({ styleId: styleId || null, name: nm.get(styleId) || '', count })).sort((a, b) => b.count - a.count) };
}

/** Styles that rented most in the same calendar months of past years (next 3 months ahead). */
async function seasonal() {
  const S = await settings.ctx();
  const orders = await M('Order').find({ status: { $nin: INACTIVE }, receiveDate: { $lt: `${S.today.slice(0, 4)}-01-01` } }).select('receiveDate lines.styleId lines.styleName').lean();
  const upcoming = [1, 2, 3].map((k) => new Date(Date.UTC(+S.today.slice(0, 4), +S.today.slice(5, 7) - 1 + k, 1)).toISOString().slice(5, 7));
  return {
    items: await Promise.all(upcoming.map(async (mm) => {
      const by = new Map();
      for (const o of orders) if (o.receiveDate.slice(5, 7) === mm) for (const l of o.lines) by.set(l.styleId, (by.get(l.styleId) || 0) + 1);
      const styles = await M('Style').find({ _id: { $in: [...by.keys()] } }).select('name').lean();
      const nm = new Map(styles.map((s) => [s._id, s.name]));
      return { month: mm, items: [...by.entries()].map(([styleId, count]) => ({ styleId, name: nm.get(styleId) || '', count })).sort((a, b) => b.count - a.count).slice(0, 5) };
    })),
  };
}

async function turnaround(query) {
  const r = await resolveRange({ range: 'm3', ...query });
  const [a, b] = utcRange(r.S, r.from, r.to);
  const jobs = await M('Cleaning').find({ kind: 'dry', status: 'done', doneAt: { $gte: a, $lt: b } }).lean();
  const hours = jobs.map((j) => (j.doneAt - (j.returnedAt || j.startedAt)) / 3600000);
  return { jobs: jobs.length, turnaroundHours: hours.length ? Math.round((hours.reduce((x, y) => x + y, 0) / hours.length) * 10) / 10 : null };
}

const REPORTS = {
  revenue, economics, expenses, 'vs-target': vsTarget, forecast, missed, seasonal, turnaround,
  occupancy: async (q) => { const r = await resolveRange(q); return { range: { from: r.from, to: r.to }, ...(await occupancy(r)) }; },
  styles: async (q) => { const r = await resolveRange(q); return { range: { from: r.from, to: r.to }, items: await styleRanking(r, 50) }; },
};

async function run(name, query) {
  if (!REPORTS[name]) throw new AppError(404, 'not_found');
  return REPORTS[name](query || {});
}

module.exports = { resolveRange, makeBuckets, revenueBuckets, revenueSummary, occupancy, styleRanking, ordersCreatedIn, paymentsIn, utcRange, run, expenseHits, REPORTS };
