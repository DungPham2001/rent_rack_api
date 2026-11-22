/**
 * Cash handling (spec 7): shifts, cash book, end-of-day totals.
 * Expected cash in the till = opening cash + cash payments of the shift (everything in, refunds and deposit refunds out;
 * deposits taken still count in) + cash-book entries (in adds, out subtracts).
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const ledger = require('./ledger');
const { Checker } = require('../lib/validate');
const { AppError, notFound } = require('../lib/errors');
const { uuid, iso } = require('../lib/util');
const { paging, page } = require('../resources/engine');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const OUT = ['refund', 'deposit_refund'];

async function expectedCash(shift, until = shift.endAt || new Date()) {
  const [pays, book] = await Promise.all([
    M('Payment').find({ method: 'cash', at: { $gte: shift.startAt, $lte: until } }).lean(),
    M('CashEntry').find({ at: { $gte: shift.startAt, $lte: until } }).lean(),
  ]);
  const inn = pays.filter((p) => !OUT.includes(p.kind)).reduce((t, p) => t + p.amount, 0);
  const out = pays.filter((p) => OUT.includes(p.kind)).reduce((t, p) => t + p.amount, 0);
  const bin = book.filter((e) => e.type === 'in').reduce((t, e) => t + e.amount, 0);
  const bout = book.filter((e) => e.type === 'out').reduce((t, e) => t + e.amount, 0);
  return { expected: shift.startCash + inn - out + bin - bout, cashIn: inn, cashOut: out, bookIn: bin, bookOut: bout };
}

async function presentShift(s) {
  const live = s.status === 'open' ? await expectedCash(s) : null;
  return {
    id: s._id, status: s.status, openedBy: s.openedBy, openedByName: s.openedByName, startAt: iso(s.startAt), startCash: s.startCash, endAt: iso(s.endAt),
    counted: s.counted, expected: live ? live.expected : s.expected, diff: s.diff, note: s.note, ...(live ? { live } : {}),
  };
}

/** POST /shifts/open { startCash } — one open shift per shop. */
async function open(auth, body) {
  const c = new Checker();
  const startCash = c.money(body, 'startCash') || 0;
  c.done();
  if (await M('Shift').exists({ status: 'open' })) throw new AppError(409, 'shift_open');
  const doc = { _id: uuid(), openedBy: auth.accountId, openedByName: auth.account?.name || '', startAt: new Date(), startCash, status: 'open', note: '' };
  try {
    await M('Shift').create(doc);
  } catch (err) {
    if (err.code === 11000) throw new AppError(409, 'shift_open');
    throw err;
  }
  return presentShift(doc);
}

/** POST /shifts/close { counted, note } */
async function close(auth, body) {
  const c = new Checker();
  const counted = c.money(body, 'counted', { required: true });
  const note = c.str(body, 'note', { max: 500 }) || '';
  c.done();
  const shift = await M('Shift').findOne({ status: 'open' }).lean();
  if (!shift) throw new AppError(422, 'shift_required');
  const endAt = new Date();
  const { expected } = await expectedCash(shift, endAt);
  const r = await M('Shift').findOneAndUpdate({ _id: shift._id, status: 'open' }, { $set: { status: 'closed', endAt, counted, expected, diff: counted - expected, note } }, { new: true }).lean();
  if (!r) throw new AppError(422, 'shift_required');
  await require('./audit').log(auth, 'shifts', r._id, 'close', `expected ${expected}, counted ${counted}, diff ${counted - expected}`);
  return presentShift(r);
}

async function current() {
  const s = await M('Shift').findOne({ status: 'open' }).lean();
  return { shift: s ? await presentShift(s) : null };
}

async function list(query) {
  const p = paging(query, { big: true });
  const [rows, total] = await Promise.all([M('Shift').find({}).sort({ startAt: -1 }).skip(p.skip).limit(p.limit + 1).lean(), M('Shift').countDocuments({})]);
  const items = [];
  for (const r of rows.slice(0, p.limit)) items.push(await presentShift(r));
  return page(items.concat(rows.length > p.limit ? [null] : []), p, total);
}

// ---------- cash book ----------

const presentCash = (e) => ({ id: e._id, type: e.type, amount: e.amount, reason: e.reason, date: e.date, at: iso(e.at), by: e.by });

async function addCash(auth, body) {
  const c = new Checker();
  const S = await settings.ctx();
  const d = { type: c.oneOf(body, 'type', ['in', 'out'], { required: true }), amount: c.money(body, 'amount', { required: true }), reason: c.str(body, 'reason', { max: 300 }) || '', date: c.date(body, 'date') || S.today };
  c.done();
  if (!(d.amount > 0)) throw new AppError(400, 'validation_failed', { fields: [{ field: 'amount', code: 'out_of_range' }] });
  const doc = { _id: uuid(), ...d, at: new Date(), by: auth.accountId };
  await M('CashEntry').create(doc);
  return presentCash(doc);
}

async function listCash(query) {
  const f = {};
  if (query.type) f.type = String(query.type);
  if (query.from || query.to) f.date = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
  const p = paging(query, { big: true });
  const [rows, total] = await Promise.all([M('CashEntry').find(f).sort({ at: -1 }).skip(p.skip).limit(p.limit + 1).lean(), M('CashEntry').countDocuments(f)]);
  return page(rows.map(presentCash), p, total);
}

async function deleteCash(auth, id) {
  const r = await M('CashEntry').deleteOne({ _id: id });
  if (!r.deletedCount) throw notFound();
  await require('./audit').log(auth, 'cash', id, 'delete', '');
}

// ---------- end of day ----------

/** GET /day-close?date= — totals from `payments` to compare with the bank statement (read only). */
async function dayClose(date) {
  const S = await settings.ctx();
  const day = date || S.today;
  if (!T.isDate(day)) throw new AppError(400, 'validation_failed', { fields: [{ field: 'date', code: 'invalid_format' }] });
  const [from, to] = [T.localToUtc(day, '00:00', S.tz), T.localToUtc(T.addDays(day, 1), '00:00', S.tz)];
  const [pays, book] = await Promise.all([M('Payment').find({ at: { $gte: from, $lt: to } }).sort({ at: 1 }).lean(), M('CashEntry').find({ at: { $gte: from, $lt: to } }).lean()]);
  const sum = (f) => pays.filter(f).reduce((t, p) => t + p.amount, 0);
  const by = (kinds, method) => sum((p) => kinds.includes(p.kind) && p.method === method);
  const money = ['hold', 'rent', 'fee'];
  const out = {
    date: day,
    revenue: ledger.revenueOf(pays),
    sales: { cash: by(money, 'cash'), transfer: by(money, 'transfer'), comp: by(money, 'comp'), fromDeposit: by(['fee'], 'deposit') },
    refunds: { cash: by(['refund'], 'cash'), transfer: by(['refund'], 'transfer') },
    deposits: { receivedCash: by(['deposit'], 'cash'), receivedTransfer: by(['deposit'], 'transfer'), refundedCash: by(['deposit_refund'], 'cash'), refundedTransfer: by(['deposit_refund'], 'transfer') },
    cashBook: { in: book.filter((e) => e.type === 'in').reduce((t, e) => t + e.amount, 0), out: book.filter((e) => e.type === 'out').reduce((t, e) => t + e.amount, 0) },
  };
  out.netCash = out.sales.cash - out.refunds.cash + out.deposits.receivedCash - out.deposits.refundedCash + out.cashBook.in - out.cashBook.out;
  out.netTransfer = out.sales.transfer - out.refunds.transfer + out.deposits.receivedTransfer - out.deposits.refundedTransfer;
  out.payments = pays.map(ledger.present);
  return out;
}

module.exports = { open, close, current, list, expectedCash, addCash, listCash, deleteCash, dayClose };
