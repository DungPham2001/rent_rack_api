/**
 * Holds (giữ chỗ, spec 5.10): a customer pays a reservation fee to keep a piece for dates before there is an order.
 * An active hold blocks the calendar like a rental. It ends as: converted (an order is created with `holdId`),
 * released (the shop frees it, optionally refunding), or expired (the background job, when `until` passes).
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const schedule = require('./schedule');
const ledger = require('./ledger');
const pieceState = require('./pieceState');
const customers = require('./customers');
const audit = require('./audit');
const { Checker } = require('../lib/validate');
const { withTx } = require('../lib/tx');
const { AppError, notFound } = require('../lib/errors');
const { uuid, iso } = require('../lib/util');
const { paging, page } = require('../resources/engine');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const opt = (session) => (session ? { session } : {});

async function presentMany(rows) {
  const [custs, pieces] = await Promise.all([
    M('Customer').find({ _id: { $in: [...new Set(rows.map((h) => h.customerId))] } }).lean(),
    M('Piece').find({ _id: { $in: [...new Set(rows.map((h) => h.pieceId))] } }).lean(),
  ]);
  const styles = await M('Style').find({ _id: { $in: pieces.map((p) => p.styleId) } }).lean();
  const cm = new Map(custs.map((c) => [c._id, c]));
  const pm = new Map(pieces.map((p) => [p._id, p]));
  const sm = new Map(styles.map((s) => [s._id, s]));
  return rows.map((h) => ({
    id: h._id, customerId: h.customerId, customer: cm.has(h.customerId) ? { id: h.customerId, name: cm.get(h.customerId).name, phone: cm.get(h.customerId).phone || '' } : null,
    pieceId: h.pieceId, pieceCode: pm.get(h.pieceId)?.code || '', styleName: sm.get(pm.get(h.pieceId)?.styleId)?.name || '', from: h.from, to: h.to, until: iso(h.until),
    amount: h.amount, method: h.method, status: h.status, orderId: h.orderId, note: h.note, createdAt: iso(h.createdAt), updatedAt: iso(h.updatedAt),
  }));
}

async function load(id, session) {
  const h = await M('Hold').findById(id).session(session || null).lean();
  if (!h) throw notFound();
  return h;
}
const get = async (id) => (await presentMany([await load(id)]))[0];

async function list(query) {
  const f = {};
  if (query.status) f.status = { $in: String(query.status).split(',') };
  for (const k of ['pieceId', 'customerId']) if (query[k]) f[k] = String(query[k]);
  const p = paging(query, { big: true });
  const [rows, total] = await Promise.all([M('Hold').find(f).sort({ until: 1 }).skip(p.skip).limit(p.limit + 1).lean(), M('Hold').countDocuments(f)]);
  return page(await presentMany(rows.slice(0, p.limit)).then((x) => x.concat(rows.length > p.limit ? [null] : [])), p, total);
}

/** POST /holds { customerId | customerName + phone, pieceId, from, to, until, amount, method, note } (Idempotency-Key) */
async function create(auth, body) {
  const c = new Checker();
  const d = {
    customerId: c.id(body, 'customerId'), customerName: c.str(body, 'customerName', { max: 100 }), phone: c.str(body, 'phone', { max: 30 }),
    pieceId: c.id(body, 'pieceId', { required: true }), from: c.date(body, 'from', { required: true }), to: c.date(body, 'to', { required: true }),
    until: c.datetime(body, 'until'), amount: c.money(body, 'amount'), method: c.oneOf(body, 'method', ['cash', 'transfer'], { def: 'cash' }), note: c.str(body, 'note', { max: 500 }) || '',
  };
  c.done();
  if (d.to < d.from) throw new AppError(422, 'invalid', { fields: [{ field: 'to', code: 'before_from' }] });
  if (!(d.amount > 0)) throw new AppError(422, 'hold_payment_required');
  if (!d.customerId && !d.customerName) throw new AppError(422, 'required_missing', { fields: [{ field: 'customerName', code: 'required' }] });
  const S = await settings.ctx();
  const until = d.until || T.localToUtc(T.addDays(S.today, S.rules.holdDays), '23:59', S.tz);
  if (until <= new Date()) throw new AppError(422, 'invalid', { fields: [{ field: 'until', code: 'in_past' }] });

  const id = await withTx(async (session) => {
    const piece = await M('Piece').findById(d.pieceId).session(session || null).lean();
    if (!piece) throw notFound();
    await pieceState.lock([piece._id], session);
    await schedule.assertAvailable([piece], d.from, d.to, { session });
    const customer = await customers.resolve({ customerId: d.customerId, customerName: d.customerName, phone: d.phone }, { session });
    const now = new Date();
    const hid = uuid();
    await M('Hold').create([{ _id: hid, customerId: customer._id, pieceId: d.pieceId, from: d.from, to: d.to, until, amount: d.amount, method: d.method, status: 'active', note: d.note, createdBy: auth.accountId, createdAt: now, updatedAt: now }], opt(session));
    await M('Payment').create([ledger.make({ holdId: hid, kind: 'hold', method: d.method, amount: d.amount, note: d.note }, auth)], opt(session));
    await pieceState.setStatus(d.pieceId, 'held', { from: ['ready'], session });
    return hid;
  });
  return { status: 201, body: await get(id) };
}

/** POST /holds/:id/extend { until } */
async function extend(auth, id, body) {
  const c = new Checker();
  const until = c.datetime(body, 'until', { required: true });
  c.done();
  const h = await load(id);
  if (h.status !== 'active') throw new AppError(422, 'invalid_transition');
  if (until <= new Date()) throw new AppError(422, 'invalid', { fields: [{ field: 'until', code: 'in_past' }] });
  await M('Hold').updateOne({ _id: id }, { $set: { until, updatedAt: new Date() } });
  return get(id);
}

/** POST /holds/:id/release { refund, method }: frees the piece, optionally refunding part or all of the fee. */
async function release(auth, id, body) {
  const refund = body?.refund === undefined ? 0 : body.refund;
  const method = body?.method === 'transfer' ? 'transfer' : 'cash';
  if (!Number.isInteger(refund) || refund < 0) throw new AppError(400, 'validation_failed', { fields: [{ field: 'refund', code: 'out_of_range' }] });
  await withTx(async (session) => {
    const h = await load(id, session);
    if (h.status !== 'active') throw new AppError(422, 'invalid_transition');
    if (refund > h.amount) throw new AppError(422, 'invalid', { fields: [{ field: 'refund', code: 'exceeds_paid' }] });
    await M('Hold').updateOne({ _id: id, status: 'active' }, { $set: { status: 'released', updatedAt: new Date() } }, opt(session));
    if (refund > 0) await M('Payment').create([ledger.make({ holdId: id, kind: 'refund', method, amount: refund, note: 'Hoàn giữ chỗ' }, auth)], opt(session));
    await pieceState.releaseIfFree(h.pieceId, { exceptHold: id, session });
  });
  await audit.log(auth, 'holds', id, 'release', `refund ${refund}`);
  return get(id);
}

/** Background job: holds past `until` expire, their pieces go back to the shelf. Logged as the system. */
async function expireDue() {
  const due = await M('Hold').find({ status: 'active', until: { $lt: new Date() } }).limit(500).lean();
  let n = 0;
  for (const h of due) {
    const r = await M('Hold').updateOne({ _id: h._id, status: 'active' }, { $set: { status: 'expired', updatedAt: new Date() } });
    if (!r.modifiedCount) continue;
    await pieceState.releaseIfFree(h.pieceId, { exceptHold: h._id });
    await audit.log(null, 'holds', h._id, 'auto_expire', `piece ${h.pieceId}`);
    n += 1;
  }
  return n;
}

module.exports = { get, list, create, extend, release, expireDue, presentMany };
