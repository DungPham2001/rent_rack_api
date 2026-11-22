/**
 * Calendar and double-booking rules (spec 5.4).
 * A booking of a piece covers [from, to + bufferDays] (the buffer is the laundry gap after the return). Sources: order
 * lines of orders that are not cancelled/expired, and active holds. The real `to` is the actual return date for a line
 * already returned (earlier or later than planned) and "today" for a line still out past its due date (it still blocks).
 * Two ranges clash when they share any day, both ends inclusive.
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const T = require('../lib/time');
const { AppError, notFound } = require('../lib/errors');
const { noAccent } = require('../lib/util');

const M = (name) => mongoose.model(name);
const INACTIVE = ['cancelled', 'expired'];
const NOT_RENTABLE = ['retired', 'disposed'];
const OFF_SHELF = ['wait_wash', 'washing', 'repair'];

const sessionOpt = (q, session) => (session ? q.session(session) : q);

/** Bookings of several pieces: Map pieceId -> [{ kind, from, to, end, orderId, holdId, lineId, code }]. */
async function bookingsOf(pieceIds, { from, exceptOrder, exceptHold, session } = {}) {
  const S = await settings.ctx();
  const buffer = S.rules.bufferDays;
  const out = new Map(pieceIds.map((id) => [id, []]));
  if (!pieceIds.length) return out;
  const horizon = from ? T.addDays(from, -60) : '0000-00-00';
  const orders = await sessionOpt(M('Order').find({
    'lines.pieceId': { $in: pieceIds },
    status: { $nin: INACTIVE },
    ...(exceptOrder ? { _id: { $ne: exceptOrder } } : {}),
    $or: [{ status: { $in: ['reserved', 'paid', 'delivered'] } }, { dueDate: { $gte: horizon } }, ...(from ? [{ returnedAt: { $gte: T.localToUtc(from) } }] : [])],
  }).lean(), session).lean();
  for (const o of orders) {
    for (const l of o.lines) {
      if (!out.has(l.pieceId)) continue;
      let to = l.to;
      if (l.status === 'returned' || l.status === 'lost') {
        const back = S.localDate(l.returnedAt || o.returnedAt);
        if (back) to = back < l.from ? l.from : back;
      } else if (o.status === 'delivered' && S.today > l.to) to = S.today;
      out.get(l.pieceId).push({ kind: 'rent', from: l.from, to, end: T.addDays(to, buffer), orderId: o._id, code: o.code, lineId: l.id });
    }
  }
  const holds = await sessionOpt(M('Hold').find({ pieceId: { $in: pieceIds }, status: 'active', ...(exceptHold ? { _id: { $ne: exceptHold } } : {}) }), session).lean();
  for (const h of holds) out.get(h.pieceId).push({ kind: 'hold', from: h.from, to: h.to, end: T.addDays(h.to, buffer), holdId: h._id });
  return out;
}

const clashes = (list, from, to, buffer) => list.filter((b) => b.from <= T.addDays(to, buffer) && from <= b.end);

/** Date from which an off-shelf piece (washing / repair) can be rented again. */
async function readyDate(piece, S) {
  const job = await M('Cleaning').findOne({ pieceId: piece._id, status: { $ne: 'done' } }).sort({ startedAt: -1 }).lean();
  return job?.dueAt ? S.localDate(job.dueAt) : T.addDays(S.today, S.rules.bufferDays);
}

/**
 * Checks that every piece can be rented from `from` to `to`: rentable status, ready by then, no clash.
 * Throws 409 piece_not_ready / booking_conflict (data = pieceId). `force` only passes clashes when conflictMode = warn.
 */
async function assertAvailable(pieces, from, to, { exceptOrder, exceptHold, force = false, session } = {}) {
  const S = await settings.ctx();
  const map = await bookingsOf(pieces.map((p) => p._id), { from, exceptOrder, exceptHold, session });
  for (const p of pieces) {
    if (NOT_RENTABLE.includes(p.status)) throw new AppError(409, 'piece_not_ready', { data: p._id });
    if (OFF_SHELF.includes(p.status) && !S.rules.allowNotReady && from < (await readyDate(p, S))) throw new AppError(409, 'piece_not_ready', { data: p._id });
    if (clashes(map.get(p._id), from, to, S.rules.bufferDays).length && !(force && S.rules.conflictMode === 'warn')) {
      throw new AppError(409, 'booking_conflict', { data: p._id });
    }
  }
}

const bookingsApi = async (pieceId) => {
  if (!(await M('Piece').exists({ _id: pieceId }))) throw notFound();
  const S = await settings.ctx();
  const items = (await bookingsOf([pieceId])).get(pieceId).filter((b) => b.end >= T.addDays(S.today, -30)).sort((a, b) => (a.from < b.from ? -1 : 1));
  return { items };
};

/** GET /pieces/:id/calendar?month=yyyy-MM -> one entry per busy day: rent | hold | buffer | repair. */
async function calendar(pieceId, month) {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month || '')) throw new AppError(400, 'validation_failed', { fields: [{ field: 'month', code: 'invalid_format' }] });
  if (!(await M('Piece').exists({ _id: pieceId }))) throw notFound();
  const S = await settings.ctx();
  const first = `${month}-01`;
  const [yy, mm] = month.split('-').map(Number);
  const last = new Date(Date.UTC(yy, mm, 0)).toISOString().slice(0, 10);
  const days = new Map();
  const rank = { rent: 4, hold: 3, repair: 2, buffer: 1 };
  const mark = (date, kind) => {
    if (date < first || date > last) return;
    if (!days.has(date) || rank[kind] > rank[days.get(date)]) days.set(date, kind);
  };
  const span = (from, to, kind) => { for (let d = from; d <= to && d <= last; d = T.addDays(d, 1)) mark(d, kind); };
  for (const b of (await bookingsOf([pieceId], { from: first })).get(pieceId)) {
    span(b.from, b.to, b.kind);
    span(T.addDays(b.to, 1), b.end, 'buffer');
  }
  for (const job of await M('Cleaning').find({ pieceId, status: { $ne: 'done' } }).lean()) {
    const from = S.localDate(job.startedAt);
    const to = job.dueAt ? S.localDate(job.dueAt) : from;
    span(from, to < from ? from : to, job.kind === 'repair' ? 'repair' : 'buffer');
  }
  return { month, items: [...days.entries()].sort().map(([date, kind]) => ({ date, kind })) };
}

/**
 * GET /v1/availability: pieces free from `from` to `to` (the shop's rules apply: buffer days, not-ready pieces).
 * Pieces the customer once tried on and fitted come first (`customerId`, spec 5.4 fitMemory).
 */
async function availability(q) {
  const S = await settings.ctx();
  const from = q.from;
  const to = q.to || q.from;
  if (!T.isDate(from) || !T.isDate(to) || to < from) throw new AppError(400, 'validation_failed', { fields: [{ field: 'from', code: 'invalid_format' }] });
  const maxPrice = q.maxPrice !== undefined && q.maxPrice !== '' ? Number(q.maxPrice) : null;

  const styleFilter = {};
  if (q.styleId) styleFilter._id = String(q.styleId);
  if (q.categoryId) styleFilter.categoryId = String(q.categoryId);
  if (q.occasion) styleFilter.occasions = String(q.occasion);
  if (q.color) styleFilter.search = { $regex: noAccent(q.color).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  styleFilter.visible = { $ne: false };
  const styles = await M('Style').find(styleFilter).lean();
  const styleMap = new Map(styles.map((s) => [s._id, s]));
  const pieceFilter = { styleId: { $in: styles.map((s) => s._id) }, status: { $nin: NOT_RENTABLE } };
  if (q.size) pieceFilter.size = String(q.size);
  let pieces = await M('Piece').find(pieceFilter).sort({ code: 1 }).limit(2000).lean();
  if (q.q) {
    const needle = noAccent(q.q);
    pieces = pieces.filter((p) => noAccent(`${p.code} ${styleMap.get(p.styleId).search || ''} ${styleMap.get(p.styleId).name}`).includes(needle));
  }
  const bookings = await bookingsOf(pieces.map((p) => p._id), { from, exceptOrder: q.exceptOrder });
  const prices = await M('Price').find({ $or: [{ pieceId: { $in: pieces.map((p) => p._id) } }, { styleId: { $in: [...styleMap.keys()] } }] }).lean();
  const { pickPrice } = require('./pricing');
  const fitted = new Set();
  if (q.customerId) for (const f of await M('FitMemory').find({ customerId: String(q.customerId) }).lean()) fitted.add(f.pieceId);

  const items = [];
  for (const p of pieces) {
    if (clashes(bookings.get(p._id), from, to, S.rules.bufferDays).length) continue;
    if (OFF_SHELF.includes(p.status) && !S.rules.allowNotReady && from < (await readyDate(p, S))) continue;
    const row = pickPrice(prices, p, S.today);
    if (maxPrice !== null && row && row.day > maxPrice) continue;
    const s = styleMap.get(p.styleId);
    items.push({
      pieceId: p._id, code: p.code, styleId: p.styleId, styleCode: s.code, styleName: s.name, color: s.color, size: p.size, shelf: p.shelf, status: p.status,
      price: row ? { day: row.day, tier3: row.tier3, tier7: row.tier7, extraDay: row.extraDay } : null, fitted: fitted.has(p._id),
    });
  }
  items.sort((a, b) => Number(b.fitted) - Number(a.fitted) || (a.code < b.code ? -1 : 1));
  return { items: items.slice(0, 200), total: items.length };
}

/**
 * POST /v1/availability/fit { person: { bust, waist, hip, shoulder, length }, pieceIds | styleId }
 * A hint, not a rule: compares each piece's `measures[key] = { mm, adj }` with the wearer's (same unit as stored);
 * "good" when within the piece's adjustable margin on every shared key, "near" within twice that margin.
 */
async function fitHints(body) {
  const person = body?.person && typeof body.person === 'object' ? body.person : {};
  const keys = Object.keys(person).filter((k) => Number.isFinite(Number(person[k])));
  const filter = Array.isArray(body?.pieceIds) && body.pieceIds.length ? { _id: { $in: body.pieceIds.slice(0, 500).map(String) } } : body?.styleId ? { styleId: String(body.styleId) } : null;
  if (!filter) throw new AppError(400, 'validation_failed', { fields: [{ field: 'pieceIds', code: 'required' }] });
  const pieces = await M('Piece').find({ ...filter, status: { $nin: NOT_RENTABLE } }).limit(500).lean();
  const items = pieces.map((p) => {
    let worst = 0;
    let compared = 0;
    const detail = {};
    for (const k of keys) {
      const m = p.measures?.[k];
      if (!m || !Number.isFinite(Number(m.mm))) continue;
      const adj = Math.max(0, Number(m.adj) || 0);
      const diff = Number(person[k]) - Number(m.mm);
      detail[k] = { diff, adj };
      compared += 1;
      const over = Math.max(0, Math.abs(diff) - adj);
      worst = Math.max(worst, adj > 0 ? over / adj : over > 0 ? 99 : 0);
    }
    return { pieceId: p._id, code: p.code, size: p.size, compared, fit: !compared ? 'unknown' : worst === 0 ? 'good' : worst <= 1 ? 'near' : 'no', detail };
  });
  const order = { good: 0, near: 1, unknown: 2, no: 3 };
  items.sort((a, b) => order[a.fit] - order[b.fit]);
  return { items };
}

module.exports = { bookingsOf, clashes, assertAvailable, bookingsApi, calendar, availability, fitHints, readyDate, INACTIVE, NOT_RENTABLE, OFF_SHELF };
