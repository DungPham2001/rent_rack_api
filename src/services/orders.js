/**
 * Rental orders, part 1: presenting, listing, quote, creating (spec 5.1-5.3). Later steps of the life cycle
 * (deliver, return, settle, cancel, edits) are in orderFlow.js.
 * Every step is a command run in one transaction (`withTx`); the server always re-prices (client prices are never trusted).
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const pricing = require('./pricing');
const schedule = require('./schedule');
const ledger = require('./ledger');
const pieceState = require('./pieceState');
const customers = require('./customers');
const audit = require('./audit');
const { Checker } = require('../lib/validate');
const { withTx } = require('../lib/tx');
const { AppError, notFound } = require('../lib/errors');
const { uuid, iso, noAccent } = require('../lib/util');
const { paging, page } = require('../resources/engine');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const opt = (session) => (session ? { session } : {});
const ACTIVE = ['reserved', 'paid', 'delivered'];
const OPEN = ['reserved', 'paid', 'delivered', 'returned']; // not yet completed / cancelled
const SOURCES = ['phone', 'zalo', 'counter', 'family', 'other'];

const grandOf = (o) => Math.max(0, o.rent + o.surcharge + (o.receiveFee || 0) + (o.returnFee || 0) - o.discount);

/** Suggested late fee (spec 5.8): pct of the rent per day late, or a fixed amount per day. */
const lateFeeOf = (o, lateDays, rules) => (lateDays <= 0 ? 0 : rules.lateKind === 'pct' ? Math.round((o.rent * rules.lateValue * lateDays) / 100) : rules.lateValue * lateDays);

function presentOrder(o, { sum, customer, S }) {
  const grand = grandOf(o);
  const returnedDate = o.returnedAt ? S.localDate(o.returnedAt) : null;
  const lateDays = o.status === 'delivered' ? Math.max(0, T.diffDays(o.dueDate, S.today)) : returnedDate ? Math.max(0, T.diffDays(o.dueDate, returnedDate)) : 0;
  const s = sum || { paidRent: 0, paidRentReal: 0, depositHeld: 0 };
  return {
    id: o._id, code: o.code, customerId: o.customerId,
    customer: customer ? { id: customer._id, name: customer.name, phone: customer.phone || '', attention: customer.attention || '' } : null,
    source: o.source, status: o.status, receiveDate: o.receiveDate, dueDate: o.dueDate, receiveMinute: o.receiveMinute,
    returnedAt: iso(o.returnedAt), deliveredAt: iso(o.deliveredAt),
    receiveMode: o.receiveMode, returnMode: o.returnMode, receiveAddr: o.receiveAddr, returnAddr: o.returnAddr, receiveFee: o.receiveFee, returnFee: o.returnFee, zoneId: o.zoneId,
    rent: o.rent, normalRent: o.normalRent, surcharge: o.surcharge, discount: o.discount, discountNote: o.discountNote, deposit: o.deposit, holdAmount: o.holdAmount, payOnReceive: o.payOnReceive,
    compReason: o.compReason, specialRent: o.specialRent, bundleId: o.bundleId, promoCode: o.promoCode, redeemPoints: o.redeemPoints,
    note: o.note, internalNote: o.internalNote, policySnap: o.policySnap, feeSnap: o.feeSnap,
    lines: o.lines.map((l) => ({ ...l, returnedAt: iso(l.returnedAt) })), acc: o.acc,
    settlement: o.settlement ? { ...o.settlement, at: iso(o.settlement.at) } : null, changes: (o.changes || []).map((c) => ({ ...c, at: iso(c.at) })),
    contacted: !!o.contacted, cancelInfo: o.cancelInfo ? { ...o.cancelInfo, at: iso(o.cancelInfo.at) } : null,
    grand, lateDays, overdue: o.status === 'delivered' && S.today > o.dueDate,
    paidRent: s.paidRent, depositHeld: s.depositHeld, balance: Math.max(0, grand - s.paidRent), lateFee: lateFeeOf(o, lateDays, S.rules),
    createdBy: o.createdBy, createdAt: iso(o.createdAt), updatedAt: iso(o.updatedAt),
  };
}

/** Presents several orders with one query for customers and one for payments. */
async function presentMany(orders) {
  const S = await settings.ctx();
  const [sums, custs] = await Promise.all([
    ledger.summaries(orders.map((o) => o._id)),
    mongoose.model('Customer').find({ _id: { $in: [...new Set(orders.map((o) => o.customerId))] } }).lean(),
  ]);
  const cm = new Map(custs.map((c) => [c._id, c]));
  return orders.map((o) => presentOrder(o, { sum: sums.get(o._id), customer: cm.get(o.customerId), S }));
}

async function load(id, session) {
  const o = await M('Order').findById(id).session(session || null).lean();
  if (!o) throw notFound();
  return o;
}

const get = async (id) => (await presentMany([await load(id)]))[0];

/**
 * GET /v1/orders?status=a,b&q=&from=&to=&dateField=receive|due|created&customerId=&source=&overdue=true&sort=&limit=&cursor=
 * `q` finds the code, the customer's name or phone (accent-free). `from`/`to` are local dates.
 */
async function list(query) {
  const S = await settings.ctx();
  const f = {};
  if (query.status) f.status = { $in: String(query.status).split(',').filter(Boolean) };
  if (query.customerId) f.customerId = String(query.customerId);
  if (query.source) f.source = String(query.source);
  if (query.q) f.search = { $regex: noAccent(query.q).replace(/[.*+?^${}()|[\]\\]/g, '\\$&') };
  if (query.overdue === 'true' || query.overdue === '1') { f.status = 'delivered'; f.dueDate = { $lt: S.today }; }
  if (query.from || query.to) {
    const field = query.dateField === 'created' ? null : { due: 'dueDate' }[query.dateField] || 'receiveDate';
    if (field) f[field] = { ...(query.from && { $gte: query.from }), ...(query.to && { $lte: query.to }) };
    else f.createdAt = { ...(query.from && { $gte: T.localToUtc(query.from, '00:00', S.tz) }), ...(query.to && { $lt: T.localToUtc(T.addDays(query.to, 1), '00:00', S.tz) }) };
  }
  const sorts = { receiveDate: { receiveDate: 1, createdAt: -1 }, '-receiveDate': { receiveDate: -1, createdAt: -1 }, dueDate: { dueDate: 1 }, '-dueDate': { dueDate: -1 }, created: { createdAt: 1 }, '-created': { createdAt: -1 } };
  const p = paging(query, { big: true });
  const [rows, total] = await Promise.all([
    M('Order').find(f).sort(sorts[query.sort] || { createdAt: -1 }).skip(p.skip).limit(p.limit + 1).lean(),
    M('Order').countDocuments(f),
  ]);
  return page(await presentMany(rows.slice(0, p.limit)).then((items) => items.concat(rows.length > p.limit ? [null] : [])), p, total);
}

/** Orders for the dashboard-like lists: call list (due within 2 days), outside (all delivered), overdue. Not paged. */
async function specialList(kind) {
  const S = await settings.ctx();
  const f = { status: 'delivered' };
  if (kind === 'call-list') f.dueDate = { $lte: T.addDays(S.today, 2) };
  const rows = await M('Order').find(f).sort({ dueDate: 1 }).limit(500).lean();
  const items = await presentMany(rows);
  return { items, total: items.length };
}

// ---------- quote ----------

/** POST /v1/orders/quote */
const quote = (body) => pricing.quoteBody(body);

// ---------- create ----------

function parseCreate(body) {
  const c = new Checker();
  const o = {
    customerId: c.id(body, 'customerId'), customerName: c.str(body, 'customerName', { max: 100 }), phone: c.str(body, 'phone', { max: 30 }),
    source: c.oneOf(body, 'source', SOURCES), receiveDate: c.date(body, 'receiveDate', { required: true }), dueDate: c.date(body, 'dueDate', { required: true }),
    receiveMinute: c.int(body, 'receiveMinute', { max: 1439 }),
    receiveMode: c.oneOf(body, 'receiveMode', ['store', 'delivery'], { def: 'store' }), returnMode: c.oneOf(body, 'returnMode', ['store', 'delivery'], { def: 'store' }),
    receiveAddr: c.str(body, 'receiveAddr', { max: 300 }) || '', returnAddr: c.str(body, 'returnAddr', { max: 300 }) || '',
    receiveFee: c.money(body, 'receiveFee'), returnFee: c.money(body, 'returnFee'), zoneId: c.id(body, 'zoneId'),
    bundleId: c.id(body, 'bundleId'), promoCode: c.str(body, 'promoCode', { max: 30 }) || '', redeemPoints: c.int(body, 'redeemPoints', { max: 1e7 }) || 0,
    specialRent: c.money(body, 'specialRent'), compReason: c.str(body, 'compReason', { max: 300 }) || '',
    note: c.str(body, 'note', { max: 1000 }) || '', internalNote: c.str(body, 'internalNote', { max: 1000 }) || '',
    forceConflict: c.bool(body, 'forceConflict', { def: false }), payMethod: c.oneOf(body, 'payMethod', ['cash', 'transfer', 'comp'], { def: 'cash' }),
    paidNow: c.money(body, 'paidNow') || 0, counter: c.bool(body, 'counter', { def: false }), holdId: c.id(body, 'holdId'),
  };
  const lines = c.arr(body, 'lines', { required: true, max: 50 }) || [];
  o.lines = lines.map((l, i) => ({ pieceId: c.id(l, 'pieceId', { field: `lines[${i}].pieceId`, required: true }), person: c.str(l, 'person', { field: `lines[${i}].person`, max: 100 }) || '' }));
  const acc = c.arr(body, 'acc', { max: 50 }) || [];
  o.acc = acc.map((a, i) => ({ accessoryId: c.id(a, 'accessoryId', { field: `acc[${i}].accessoryId`, required: true }), qty: c.int(a, 'qty', { field: `acc[${i}].qty`, min: 1, max: 999, required: true }) }));
  c.done();
  if (!o.lines.length) throw new AppError(422, 'no_lines');
  if (new Set(o.lines.map((l) => l.pieceId)).size !== o.lines.length) throw new AppError(422, 'invalid', { fields: [{ field: 'lines', code: 'duplicate_piece' }] });
  if (o.dueDate < o.receiveDate) throw new AppError(422, 'invalid', { fields: [{ field: 'dueDate', code: 'before_receive' }] });
  if (!o.customerId && !o.customerName) throw new AppError(422, 'required_missing', { fields: [{ field: 'customerName', code: 'required' }] });
  return o;
}

/** `RR{yy}{mm}-{nnn}`, counted per month of the shop (counter row per shop and month). */
async function nextCode(S, session) {
  const l = T.toLocal(new Date(), S.tz).date;
  const yymm = `${l.slice(2, 4)}${l.slice(5, 7)}`;
  const shop = require('../lib/tenant').current();
  const row = await M('Counter').findOneAndUpdate({ _id: `${shop}|${yymm}` }, { $inc: { seq: 1 } }, { upsert: true, new: true, ...opt(session) }).lean();
  return `RR${yymm}-${String(row.seq).padStart(3, '0')}`;
}

/** POST /v1/orders — see spec 5.3. Returns { status: 201, body: order }. */
async function create(auth, body) {
  const d = parseCreate(body);
  const S = await settings.ctx();
  const isComp = d.payMethod === 'comp';
  if ((isComp || d.specialRent !== undefined) && !d.compReason) throw new AppError(422, 'comp_reason_required');
  if (!d.counter && !(d.paidNow > 0 || d.holdId || isComp)) throw new AppError(422, 'hold_payment_required');

  const order = await withTx(async (session) => {
    const hold = d.holdId ? await M('Hold').findOne({ _id: d.holdId, status: 'active' }).session(session || null).lean() : null;
    if (d.holdId && !hold) throw new AppError(422, 'invalid_transition');
    const customerId = d.customerId || hold?.customerId;
    const pieces = await M('Piece').find({ _id: { $in: d.lines.map((l) => l.pieceId) } }).session(session || null).lean();
    if (pieces.length !== d.lines.length) throw notFound();
    await pieceState.lock(pieces.map((p) => p._id), session);
    await schedule.assertAvailable(pieces, d.receiveDate, d.dueDate, { exceptHold: hold?._id, force: d.forceConflict, session });

    const q = await pricing.quote({ ...d, customerId }, {});
    if (q.promoError) throw new AppError(422, 'promo_invalid', { data: q.promoError });
    if (q.missingPrice && d.specialRent === undefined && !d.bundleId) throw new AppError(422, 'price_missing');
    const grand = q.grand;
    if (!isComp && d.paidNow > grand) throw new AppError(422, 'invalid', { fields: [{ field: 'paidNow', code: 'exceeds_total' }] });

    const customer = await customers.resolve({ customerId, customerName: d.customerName, phone: d.phone, persons: d.lines.map((l) => l.person) }, { session });
    const [styles, accessories, fees, policy] = await Promise.all([
      M('Style').find({ _id: { $in: pieces.map((p) => p.styleId) } }).lean(), M('Accessory').find({ _id: { $in: d.acc.map((a) => a.accessoryId) } }).lean(),
      M('Fee').find({}).lean(), settings.get('policy'),
    ]);
    if (accessories.length !== new Set(d.acc.map((a) => a.accessoryId)).size) throw notFound();
    const pm = new Map(pieces.map((p) => [p._id, p]));
    const sm = new Map(styles.map((s) => [s._id, s]));
    const am = new Map(accessories.map((a) => [a._id, a]));

    const id = uuid();
    const now = new Date();
    const code = await nextCode(S, session);
    const pays = [];
    const pay = (kind, method, amount, note, holdId) => { if (amount > 0) pays.push(ledger.make({ orderId: id, kind, method, amount, note, holdId }, auth)); };
    let holdAmount = 0;
    if (d.counter) {
      pay('rent', d.payMethod, grand, d.compReason);
      pay('deposit', isComp ? 'cash' : d.payMethod, q.deposit);
    } else if (isComp) {
      pay('hold', 'comp', grand, d.compReason);
      holdAmount = grand;
    } else {
      pay('hold', d.payMethod, d.paidNow);
      holdAmount = d.paidNow;
    }
    if (hold) holdAmount += (await M('Payment').find({ holdId: hold._id }).session(session || null).lean()).filter((p) => p.kind === 'hold').reduce((t, p) => t + p.amount, 0);

    const status = d.counter ? 'delivered' : holdAmount >= grand ? 'paid' : 'reserved';
    const doc = {
      _id: id, code, customerId: customer._id, source: d.source || (d.counter ? 'counter' : 'other'), status,
      receiveDate: d.receiveDate, dueDate: d.dueDate, receiveMinute: d.receiveMinute ?? null, deliveredAt: d.counter ? now : null,
      receiveMode: d.receiveMode, returnMode: d.returnMode, receiveAddr: d.receiveAddr, returnAddr: d.returnAddr, receiveFee: q.receiveFee, returnFee: q.returnFee, zoneId: d.zoneId || null,
      rent: q.rent, normalRent: q.normalRent, surcharge: q.surcharge, discount: q.discount, discountNote: q.discountNote, deposit: q.deposit,
      holdAmount, payOnReceive: d.counter ? 0 : Math.max(0, grand - holdAmount) + q.deposit,
      compReason: d.compReason, specialRent: q.specialRent, bundleId: d.bundleId || null, promoCode: q.discountDetail.promoCode || '', redeemPoints: q.discountDetail.pointsUsed || 0,
      note: d.note, internalNote: d.internalNote, policySnap: policy.text, feeSnap: fees.map((f) => ({ kind: f.kind, name: f.name, amount: f.amount })),
      lines: q.lines.map((l) => ({
        id: uuid(), person: l.person, styleId: l.styleId, styleName: sm.get(l.styleId)?.name || '', pieceId: l.pieceId, pieceCode: pm.get(l.pieceId).code, size: l.size,
        from: d.receiveDate, to: d.dueDate, unit: l.unit, surcharge: l.surcharge, deposit: l.deposit, condOut: '', condIn: '', status: 'out', returnedAt: null,
      })),
      acc: d.acc.map((a) => ({ accessoryId: a.accessoryId, name: am.get(a.accessoryId).name, qty: a.qty, returned: 0, lost: 0 })),
      settlement: null, changes: [], contacted: false, search: noAccent(`${code} ${customer.name} ${customer.phone || ''}`), createdBy: auth.accountId, createdAt: now, updatedAt: now,
    };
    await M('Order').create([doc], opt(session));
    if (pays.length) await M('Payment').insertMany(pays, opt(session));
    if (d.counter) {
      await M('Delivery').create([{ _id: uuid(), orderId: id, kind: 'out', receiver: customer.name, mode: 'store', address: '', fee: 0, condition: {}, note: '', at: now, by: auth.accountId }], opt(session));
      await pieceState.setStatus(pieces.map((p) => p._id), 'rented', { session });
    } else {
      await pieceState.setStatus(pieces.map((p) => p._id), 'held', { from: ['ready'], session });
    }
    if (q.discountDetail.promo > 0) await M('Promo').updateOne({ code: q.discountDetail.promoCode }, { $inc: { used: 1 } }, opt(session));
    if (q.discountDetail.pointsUsed > 0) await M('Loyalty').create([{ _id: uuid(), customerId: customer._id, points: -q.discountDetail.pointsUsed, reason: 'redeem', refId: id, at: now }], opt(session));
    if (hold) {
      await M('Hold').updateOne({ _id: hold._id }, { $set: { status: 'converted', orderId: id, updatedAt: now } }, opt(session));
      await M('Payment').updateMany({ holdId: hold._id }, { $set: { orderId: id } }, opt(session));
      if (!pm.has(hold.pieceId)) await pieceState.releaseIfFree(hold.pieceId, { exceptHold: hold._id, session });
    }
    return doc;
  });

  if (order.compReason) await audit.log(auth, 'orders', order._id, 'comp_order', `${order.code}: ${order.compReason}`);
  return { status: 201, body: await get(order._id) };
}

module.exports = { ACTIVE, OPEN, SOURCES, grandOf, lateFeeOf, presentOrder, presentMany, load, get, list, specialList, quote, create, nextCode, opt };
