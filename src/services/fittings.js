/**
 * Fitting appointments (spec 5.11): same room / same staff / closed days checks, and the "fit memory" (a piece that fit
 * a person goes first in that customer's piece picker).
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const T = require('../lib/time');
const { AppError } = require('../lib/errors');
const { uuid } = require('../lib/util');

const M = (name) => mongoose.model(name);

/** `data` = cleaned fields being written, `existing` = the stored row on a patch. */
async function check(data, existing) {
  const f = { ...(existing || {}), ...data };
  if (!T.isDate(f.date)) throw new AppError(422, 'invalid', { fields: [{ field: 'date', code: 'invalid_format' }] });
  if (!(f.end > f.start)) throw new AppError(422, 'invalid', { fields: [{ field: 'end', code: 'before_start' }] });
  if (f.status === 'cancelled' || f.status === 'missed') return;
  const S = await settings.ctx();
  const day = S.hours.days.find((d) => d.day === T.weekday(f.date));
  if ((day && day.closed) || (await M('ClosedDate').exists({ date: f.date }))) throw new AppError(409, 'shop_closed');
  const overlap = { date: f.date, status: 'scheduled', start: { $lt: f.end }, end: { $gt: f.start }, ...(existing ? { _id: { $ne: existing._id } } : {}) };
  if (f.roomId && (await M('Fitting').exists({ ...overlap, roomId: f.roomId }))) throw new AppError(409, 'room_busy');
  if (f.staffId && (await M('Fitting').exists({ ...overlap, staffId: f.staffId }))) throw new AppError(409, 'staff_busy');
}

async function remember(doc, existing) {
  if (doc.result !== 'fit' || existing?.result === 'fit' || !doc.pieceId) return;
  let customerId = doc.customerId;
  if (!customerId && doc.orderId) customerId = (await M('Order').findById(doc.orderId).select('customerId').lean())?.customerId;
  if (!customerId) return;
  const piece = await M('Piece').findById(doc.pieceId).select('styleId').lean();
  const key = { customerId, person: doc.person || '', pieceId: doc.pieceId };
  await M('FitMemory').updateOne(key, { $setOnInsert: { _id: uuid(), styleId: piece?.styleId || null, createdAt: new Date(), updatedAt: new Date() } }, { upsert: true });
}

module.exports = { check, remember };
