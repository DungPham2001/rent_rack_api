/** Piece operations beyond plain CRUD (spec 6): manual status, disposal, care, purchases, attention lists, supplies. */
const mongoose = require('mongoose');
const settings = require('./settings');
const pieceState = require('./pieceState');
const { PIECE_STATUS, byPath } = require('../resources/defs');
const { AppError, notFound } = require('../lib/errors');
const { uuid, iso } = require('../lib/util');
const { Checker } = require('../lib/validate');
const { withTx } = require('../lib/tx');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const INACTIVE = ['cancelled', 'expired'];

async function load(id) {
  const p = await M('Piece').findById(id).lean();
  if (!p) throw notFound();
  return p;
}

/** POST /pieces/:id/status { status, note }. Rented -> ready directly is refused (the piece must come back first). */
async function setStatus(auth, id, body) {
  const status = body?.status;
  if (!PIECE_STATUS.includes(status)) throw new AppError(400, 'validation_failed', { fields: [{ field: 'status', code: 'invalid_enum' }] });
  const p = await load(id);
  if (status === 'disposed' || p.status === 'disposed') throw new AppError(422, 'invalid_transition'); // disposal has its own endpoint, and is final
  if (p.status === 'rented' && status === 'ready') throw new AppError(422, 'invalid_transition');
  await pieceState.setStatus(id, status);
  await pieceState.log(id, 'status', `${p.status} -> ${status}${body?.note ? `: ${body.note}` : ''}`, { by: auth.accountId });
  return M('Piece').findById(id).lean().then((x) => ({ id: x._id, status: x.status, updatedAt: iso(x.updatedAt) }));
}

/** POST /pieces/:id/dispose { kind, price, reason } -> piece `disposed`, a `disposals` row, a sensitive-action log. */
async function dispose(auth, id, body) {
  const c = new Checker();
  const kind = c.oneOf(body, 'kind', ['sold', 'discarded', 'donated', 'other'], { required: true });
  const price = c.money(body, 'price') || 0;
  const reason = c.str(body, 'reason', { max: 500 }) || '';
  c.done();
  const p = await load(id);
  if (p.status === 'disposed') throw new AppError(422, 'invalid_transition');
  const busyOrder = await M('Order').countDocuments({ 'lines.pieceId': id, status: { $in: ['reserved', 'paid', 'delivered'] } });
  const busyHold = await M('Hold').countDocuments({ pieceId: id, status: 'active' });
  if (busyOrder || busyHold) throw new AppError(409, 'in_use', { data: { blockedBy: [{ resource: 'orders', count: busyOrder }, { resource: 'holds', count: busyHold }] } });
  await withTx(async (session) => {
    await pieceState.setStatus(id, 'disposed', { session });
    await M('Disposal').create([{ _id: uuid(), pieceId: id, kind, price, reason, at: new Date(), by: auth.accountId }], { session: session || undefined });
  });
  await require('./audit').log(auth, 'pieces', id, 'dispose', `${p.code} ${kind} ${price}${reason ? `: ${reason}` : ''}`);
  return { id, status: 'disposed' };
}

/** POST /pieces/:id/care { note } */
async function care(auth, id, body) {
  await load(id);
  const now = new Date();
  await M('Piece').updateOne({ _id: id }, { $set: { lastCareAt: now, updatedAt: now } });
  await pieceState.log(id, 'care', typeof body?.note === 'string' ? body.note : '', { by: auth.accountId });
  return { id, lastCareAt: iso(now) };
}

async function logs(id) {
  await load(id);
  const rows = await M('PieceLog').find({ pieceId: id }).sort({ at: -1 }).limit(200).lean();
  return { items: rows.map((r) => ({ id: r._id, kind: r.kind, note: r.note, orderId: r.orderId, at: iso(r.at), by: r.by })) };
}

/** Rentals per piece: Map pieceId -> { count, last }. Cancelled / expired orders do not count. */
async function rentStats() {
  const rows = await M('Order').aggregate([
    { $match: { status: { $nin: INACTIVE } } }, { $unwind: '$lines' }, { $group: { _id: '$lines.pieceId', count: { $sum: 1 }, last: { $max: '$lines.from' } } },
  ]);
  return new Map(rows.map((r) => [r._id, { count: r.count, last: r.last }]));
}

/** Care due, stale and end-of-life pieces (spec 6). */
async function insights() {
  const S = await settings.ctx();
  const [pieces, stats] = await Promise.all([M('Piece').find({ status: { $nin: ['retired', 'disposed'] } }).lean(), rentStats()]);
  const out = { careDue: [], stale: [], endOfLife: [] };
  for (const p of pieces) {
    const st = stats.get(p._id) || { count: 0, last: null };
    const careBase = p.lastCareAt ? S.localDate(p.lastCareAt) : p.purchasedDate || S.localDate(p.createdAt);
    if (T.diffDays(careBase, S.today) >= (p.careDays || S.rules.careDays)) out.careDue.push(p._id);
    const rentedBase = st.last || p.purchasedDate || S.localDate(p.createdAt);
    if (p.status !== 'rented' && T.diffDays(rentedBase, S.today) > S.rules.staleDays) out.stale.push(p._id);
    if (p.maxRentals > 0 && (st.count * 100) / p.maxRentals >= S.rules.lifecycleWarnPct) out.endOfLife.push(p._id);
  }
  return out;
}

/** GET /pieces/alerts -> the three lists with the piece rows. */
async function alerts() {
  const i = await insights();
  const ids = [...new Set([...i.careDue, ...i.stale, ...i.endOfLife])];
  const pieces = await M('Piece').find({ _id: { $in: ids } }).lean();
  const stats = await rentStats();
  const row = (p) => ({ id: p._id, code: p.code, styleId: p.styleId, status: p.status, size: p.size, shelf: p.shelf, rentals: stats.get(p._id)?.count || 0, maxRentals: p.maxRentals, lastRentedOn: stats.get(p._id)?.last || null, lastCareAt: iso(p.lastCareAt) });
  const pm = new Map(pieces.map((p) => [p._id, p]));
  return { careDue: i.careDue.map((id) => row(pm.get(id))), stale: i.stale.map((id) => row(pm.get(id))), endOfLife: i.endOfLife.map((id) => row(pm.get(id))) };
}

/** GET /pieces/:id/summary */
async function summary(id) {
  const p = await load(id);
  const S = await settings.ctx();
  const st = (await rentStats()).get(id) || { count: 0, last: null };
  const job = await M('Cleaning').findOne({ pieceId: id, status: { $ne: 'done' } }).lean();
  return {
    id, rentals: st.count, lastRentedOn: st.last, lifecyclePct: p.maxRentals > 0 ? Math.round((st.count * 100) / p.maxRentals) : null, washCount: p.washCount, lastCareAt: iso(p.lastCareAt),
    careDays: p.careDays || S.rules.careDays, openCleaning: job ? { id: job._id, kind: job.kind, status: job.status, dueAt: iso(job.dueAt) } : null,
  };
}

/** POST /purchases { supplierId, piece: { code, styleId, size... }, cost, date } -> creates the piece (ready) and the purchase. */
async function purchase(auth, body) {
  const c = new Checker();
  const cost = c.money(body, 'cost', { required: true });
  const date = c.date(body, 'date', { required: true });
  const supplierId = c.id(body, 'supplierId');
  const piece = c.obj(body, 'piece', { required: true });
  c.done();
  if (supplierId && !(await M('Supplier').exists({ _id: supplierId }))) throw notFound();
  const doc = await byPath.pieces.insert({ ...piece, purchasePrice: cost, purchasedDate: date }, auth);
  await M('Purchase').create({ _id: uuid(), supplierId: supplierId || null, pieceId: doc._id, cost, date, at: new Date(), by: auth.accountId });
  return { piece: byPath.pieces.present(doc), cost, date, supplierId: supplierId || null };
}

/** POST /supplies/:id/move { qty, type: in|out, note } */
async function moveSupply(auth, id, body) {
  const c = new Checker();
  const qty = c.num(body, 'qty', { required: true, min: 0.0001, max: 1e9 });
  const type = c.oneOf(body, 'type', ['in', 'out'], { required: true });
  const note = c.str(body, 'note', { max: 300 }) || '';
  c.done();
  const r = await M('Supply').findOneAndUpdate({ _id: id, ...(type === 'out' ? { qty: { $gte: qty } } : {}) }, { $inc: { qty: type === 'in' ? qty : -qty }, $set: { updatedAt: new Date() } }, { new: true }).lean();
  if (!r) {
    if (!(await M('Supply').exists({ _id: id }))) throw notFound();
    throw new AppError(422, 'invalid', { fields: [{ field: 'qty', code: 'insufficient_stock' }] });
  }
  await M('SupplyMove').create({ _id: uuid(), supplyId: id, type, qty, note, at: new Date(), by: auth.accountId });
  return { id, qty: r.qty, low: r.qty < r.min };
}

async function supplyMoves(id) {
  if (!(await M('Supply').exists({ _id: id }))) throw notFound();
  const rows = await M('SupplyMove').find({ supplyId: id }).sort({ at: -1 }).limit(200).lean();
  return { items: rows.map((m) => ({ id: m._id, type: m.type, qty: m.qty, note: m.note, at: iso(m.at), by: m.by })) };
}

module.exports = { setStatus, dispose, care, logs, rentStats, insights, alerts, summary, purchase, moveSupply, supplyMoves };
