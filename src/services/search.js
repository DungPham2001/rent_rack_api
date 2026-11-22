/** Global search (spec 10): orders, customers, pieces, styles. Accent-free, case-insensitive, >= 2 characters, at most 60 results. */
const mongoose = require('mongoose');
const { noAccent, phoneKey } = require('../lib/util');
const { AppError } = require('../lib/errors');

const M = (name) => mongoose.model(name);
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const MAX = 60;

async function search(q) {
  const raw = String(q || '').trim();
  if (raw.length < 2) throw new AppError(400, 'validation_failed', { fields: [{ field: 'q', code: 'too_short' }] });
  const needle = noAccent(raw);
  const rx = { $regex: esc(needle) };
  const digits = phoneKey(raw);
  const per = 25;
  const [orders, custs, styles, pieceByCode] = await Promise.all([
    M('Order').find({ search: rx }).sort({ createdAt: -1 }).limit(per).lean(),
    M('Customer').find({ $or: [{ search: rx }, ...(digits.length >= 4 ? [{ phoneKey: { $regex: esc(digits) } }] : [])] }).limit(per).lean(),
    M('Style').find({ search: rx }).limit(per).lean(),
    M('Piece').find({ search: rx }).limit(per).lean(),
  ]);
  const styleIds = styles.map((s) => s._id);
  const byStyle = styleIds.length ? await M('Piece').find({ styleId: { $in: styleIds }, _id: { $nin: pieceByCode.map((p) => p._id) } }).limit(per).lean() : [];
  const pieces = [...pieceByCode, ...byStyle];
  const styleMap = new Map((await M('Style').find({ _id: { $in: pieces.map((p) => p.styleId) } }).select('name code color material').lean()).map((s) => [s._id, s]));
  const cm = new Map((await M('Customer').find({ _id: { $in: orders.map((o) => o.customerId) } }).select('name phone').lean()).map((c) => [c._id, c]));

  const items = [
    ...orders.map((o) => ({ kind: 'order', id: o._id, title: o.code, subtitle: `${cm.get(o.customerId)?.name || ''} · ${o.status} · ${o.receiveDate}` })),
    ...custs.map((c) => ({ kind: 'customer', id: c._id, title: c.name, subtitle: c.phone || '' })),
    ...pieces.map((p) => ({ kind: 'piece', id: p._id, title: p.code, subtitle: [styleMap.get(p.styleId)?.name, p.size, p.status].filter(Boolean).join(' · ') })),
    ...styles.map((s) => ({ kind: 'style', id: s._id, title: s.name, subtitle: [s.code, s.color, s.material].filter(Boolean).join(' · ') })),
  ];
  return { items: items.slice(0, MAX), total: items.length };
}

module.exports = { search };
