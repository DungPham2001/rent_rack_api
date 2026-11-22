/** Status of a piece follows the orders, holds and laundry around it (spec 6). All writes accept a transaction session. */
const mongoose = require('mongoose');

const M = (name) => mongoose.model(name);
const opt = (session) => (session ? { session } : {});

/** Serializes concurrent bookings of the same pieces: two transactions touching a piece cannot both commit. */
const lock = (ids, session) => M('Piece').updateMany({ _id: { $in: ids } }, { $set: { lockAt: new Date() } }, opt(session));

const setStatus = (ids, status, { from, session } = {}) =>
  M('Piece').updateMany({ _id: { $in: [].concat(ids) }, ...(from ? { status: { $in: from } } : {}) }, { $set: { status, updatedAt: new Date() } }, opt(session));

/** Is somebody waiting for this piece (an order reserved / paid, or an active hold)? */
async function hasReservation(pieceId, { exceptOrder, exceptHold, session } = {}) {
  const [o, h] = await Promise.all([
    M('Order').exists({ 'lines.pieceId': pieceId, status: { $in: ['reserved', 'paid'] }, ...(exceptOrder ? { _id: { $ne: exceptOrder } } : {}) }).session(session || null),
    M('Hold').exists({ pieceId, status: 'active', ...(exceptHold ? { _id: { $ne: exceptHold } } : {}) }).session(session || null),
  ]);
  return !!(o || h);
}

/** A piece that is no longer needed by a cancelled order / released hold: `held` goes back to `ready` unless another reservation exists. */
async function releaseIfFree(pieceId, ex = {}) {
  const piece = await M('Piece').findById(pieceId).session(ex.session || null).lean();
  if (piece?.status === 'held' && !(await hasReservation(pieceId, ex))) await setStatus(pieceId, 'ready', { from: ['held'], session: ex.session });
}

/** Status for a piece that is back on the shelf (laundry done, or a plain return). */
async function backOnShelf(pieceId, ex = {}) {
  const status = (await hasReservation(pieceId, ex)) ? 'held' : 'ready';
  await setStatus(pieceId, status, { session: ex.session });
  return status;
}

const log = (pieceId, kind, note, { orderId = null, by = null, session } = {}) =>
  M('PieceLog').create([{ _id: require('../lib/util').uuid(), pieceId, orderId, kind, note: String(note || '').slice(0, 500), at: new Date(), by }], opt(session));

module.exports = { lock, setStatus, hasReservation, releaseIfFree, backOnShelf, log };
