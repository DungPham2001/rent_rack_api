/**
 * Laundry and repair queue (spec 6). One open job per piece.
 *   dry:    waiting -> washing -> ironing -> qc -> done      repair: repairing -> qc -> done
 * `done` needs every item of the shop's QC checklist ticked (422 qc_incomplete). Piece status follows the job:
 * waiting -> wait_wash, repairing -> repair, done -> ready (or held when someone is waiting for it), the rest -> washing.
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const pieceState = require('./pieceState');
const { Checker, isObj } = require('../lib/validate');
const { withTx } = require('../lib/tx');
const { AppError, notFound } = require('../lib/errors');
const { uuid, iso } = require('../lib/util');
const { paging, page } = require('../resources/engine');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const opt = (session) => (session ? { session } : {});
const FLOW = { dry: ['waiting', 'washing', 'ironing', 'qc', 'done'], repair: ['repairing', 'qc', 'done'] };
const pieceStatusOf = { waiting: 'wait_wash', repairing: 'repair', washing: 'washing', ironing: 'washing', qc: 'washing' };

const present = (j, piece) => ({
  id: j._id, pieceId: j.pieceId, pieceCode: piece?.code || '', kind: j.kind, status: j.status, partnerId: j.partnerId, staffId: j.staffId, startedAt: iso(j.startedAt), dueAt: iso(j.dueAt), doneAt: iso(j.doneAt),
  cost: j.cost, qc: j.qc || {}, orderId: j.orderId, returnedAt: iso(j.returnedAt), note: j.note, createdAt: iso(j.createdAt), updatedAt: iso(j.updatedAt),
});

async function presentMany(rows) {
  const pieces = await M('Piece').find({ _id: { $in: rows.map((r) => r.pieceId) } }).lean();
  const pm = new Map(pieces.map((p) => [p._id, p]));
  return rows.map((r) => present(r, pm.get(r.pieceId)));
}

async function load(id, session) {
  const j = await M('Cleaning').findById(id).session(session || null).lean();
  if (!j) throw notFound();
  return j;
}
const get = async (id) => (await presentMany([await load(id)]))[0];

/** GET /cleaning?status=&open=true&pieceId=&kind= */
async function list(query) {
  const f = {};
  if (query.status) f.status = { $in: String(query.status).split(',') };
  if (query.open === 'true') f.status = { $ne: 'done' };
  for (const k of ['pieceId', 'kind', 'partnerId', 'staffId']) if (query[k]) f[k] = String(query[k]);
  const p = paging(query, { big: true });
  const [rows, total] = await Promise.all([
    M('Cleaning').find(f).sort({ dueAt: 1, startedAt: -1 }).skip(p.skip).limit(p.limit + 1).lean(), M('Cleaning').countDocuments(f),
  ]);
  return page(await presentMany(rows.slice(0, p.limit)).then((x) => x.concat(rows.length > p.limit ? [null] : [])), p, total);
}

/** POST /cleaning { pieceId, kind, partnerId, staffId, dueAt, cost, note } */
async function start(auth, body) {
  const c = new Checker();
  const d = {
    pieceId: c.id(body, 'pieceId', { required: true }), kind: c.oneOf(body, 'kind', ['dry', 'repair'], { def: 'dry' }), partnerId: c.id(body, 'partnerId'), staffId: c.id(body, 'staffId'),
    dueAt: c.datetime(body, 'dueAt'), cost: c.money(body, 'cost') || 0, note: c.str(body, 'note', { max: 500 }) || '',
  };
  c.done();
  const S = await settings.ctx();
  const id = await withTx(async (session) => {
    const piece = await M('Piece').findById(d.pieceId).session(session || null).lean();
    if (!piece) throw notFound();
    if (['retired', 'disposed', 'rented'].includes(piece.status)) throw new AppError(422, 'invalid_transition');
    if (await M('Cleaning').exists({ pieceId: d.pieceId, status: { $ne: 'done' } }).session(session || null)) throw new AppError(409, 'cleaning_open');
    if (d.partnerId && !(await M('Partner').exists({ _id: d.partnerId }))) throw notFound();
    const now = new Date();
    const status = d.kind === 'repair' ? 'repairing' : 'waiting';
    const jid = uuid();
    await M('Cleaning').create([{
      _id: jid, pieceId: d.pieceId, kind: d.kind, status, partnerId: d.partnerId || null, staffId: d.staffId || null, startedAt: now,
      dueAt: d.dueAt || T.localToUtc(T.addDays(S.today, Math.max(1, S.rules.bufferDays)), '23:59', S.tz), cost: d.cost, qc: {}, note: d.note, createdAt: now, updatedAt: now,
    }], opt(session));
    await pieceState.setStatus(d.pieceId, pieceStatusOf[status], { session });
    return jid;
  });
  return { status: 201, body: await get(id) };
}

/** POST /cleaning/:id/move { status } */
async function move(auth, id, body) {
  const next = body?.status;
  await withTx(async (session) => {
    const j = await load(id, session);
    if (j.status === 'done') throw new AppError(422, 'invalid_transition');
    const flow = FLOW[j.kind] || FLOW.dry;
    if (!flow.includes(next)) throw new AppError(422, 'invalid_transition');
    const now = new Date();
    if (next === 'done') {
      const items = await M('Checklist').find({ kind: 'qc' }).session(session || null).lean();
      if (items.some((it) => !(j.qc || {})[it._id])) throw new AppError(422, 'qc_incomplete');
      await M('Cleaning').updateOne({ _id: id, status: { $ne: 'done' } }, { $set: { status: 'done', doneAt: now, updatedAt: now } }, opt(session));
      await M('Piece').updateOne({ _id: j.pieceId }, { $set: { lastCareAt: now, updatedAt: now }, ...(j.kind === 'dry' ? { $inc: { washCount: 1 } } : {}) }, opt(session));
      await pieceState.backOnShelf(j.pieceId, { session });
    } else {
      await M('Cleaning').updateOne({ _id: id }, { $set: { status: next, updatedAt: now } }, opt(session));
      await pieceState.setStatus(j.pieceId, pieceStatusOf[next], { session });
    }
  });
  return get(id);
}

/** PUT /cleaning/:id/qc { itemId, value } */
async function setQc(auth, id, body) {
  const itemId = typeof body?.itemId === 'string' ? body.itemId : '';
  if (!itemId || typeof body?.value !== 'boolean') throw new AppError(400, 'validation_failed', { fields: [{ field: !itemId ? 'itemId' : 'value', code: 'required' }] });
  const j = await load(id);
  if (j.status === 'done') throw new AppError(422, 'invalid_transition');
  if (!(await M('Checklist').exists({ _id: itemId, kind: 'qc' }))) throw notFound();
  await M('Cleaning').updateOne({ _id: id }, { $set: { [`qc.${itemId}`]: body.value, updatedAt: new Date() } });
  return get(id);
}

/** PATCH /cleaning/:id { partnerId, staffId, dueAt, cost, note, returnedAt } */
async function patch(auth, id, body) {
  const c = new Checker();
  const set = {};
  if (body?.partnerId !== undefined) set.partnerId = c.id(body, 'partnerId') || null;
  if (body?.staffId !== undefined) set.staffId = c.id(body, 'staffId') || null;
  if (body?.dueAt !== undefined) set.dueAt = c.datetime(body, 'dueAt') || null;
  if (body?.returnedAt !== undefined) set.returnedAt = c.datetime(body, 'returnedAt') || null;
  if (body?.cost !== undefined) set.cost = c.money(body, 'cost') ?? 0;
  if (body?.note !== undefined) set.note = c.str(body, 'note', { max: 500 }) || '';
  c.done();
  await load(id);
  await M('Cleaning').updateOne({ _id: id }, { $set: { ...set, updatedAt: new Date() } });
  return get(id);
}

module.exports = { get, list, start, move, setQc, patch, presentMany, FLOW, isObj };
