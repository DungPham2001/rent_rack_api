/**
 * Customers and loyalty points (spec 8). Renters have no account: the shop types them in. A customer is matched by
 * id, else by phone (digits only, >= 6 digits), else created on the spot when an order is made.
 * Points: balance = sum of the ledger; tier from `loyalty.tiers`; spending = sum of `grand` of completed non-comp orders.
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const { uuid, phoneKey, noAccent, iso } = require('../lib/util');
const { AppError, notFound } = require('../lib/errors');
const { withTx } = require('../lib/tx');

const M = (name) => mongoose.model(name);
const opt = (session) => (session ? { session } : {});

const isComp = (o) => !!(o.compReason || (o.specialRent !== null && o.specialRent !== undefined));

const tierOf = (tiers, points) => [...tiers].sort((a, b) => a.minPoints - b.minPoints).reduce((t, x) => (points >= x.minPoints ? x : t), tiers[0] || null);

/** Adds points, totalSpent, orderCount, tier to presented customers (one batch of queries). */
async function decorate(items) {
  if (!items.length) return;
  const ids = items.map((c) => c.id);
  const S = await settings.ctx();
  const [points, orders] = await Promise.all([
    M('Loyalty').aggregate([{ $match: { customerId: { $in: ids } } }, { $group: { _id: '$customerId', points: { $sum: '$points' } } }]),
    M('Order').find({ customerId: { $in: ids }, status: { $nin: ['cancelled', 'expired'] } }).select('customerId status rent surcharge discount receiveFee returnFee compReason specialRent').lean(),
  ]);
  const pts = new Map(points.map((p) => [p._id, p.points]));
  for (const c of items) {
    const mine = orders.filter((o) => o.customerId === c.id);
    const spent = mine.filter((o) => o.status === 'completed' && !isComp(o)).reduce((t, o) => t + Math.max(0, o.rent + o.surcharge + (o.receiveFee || 0) + (o.returnFee || 0) - o.discount), 0);
    c.points = pts.get(c.id) || 0;
    c.tier = tierOf(S.loyalty.tiers, c.points)?.name || null;
    c.totalSpent = spent;
    c.orderCount = mine.length;
  }
}

/** Finds or creates the customer of an order (spec 5.3 step 4) and remembers the wearers' names in `people`. */
async function resolve({ customerId, customerName, phone, persons = [] }, { session } = {}) {
  let customer = null;
  if (customerId) {
    customer = await M('Customer').findById(customerId).session(session || null).lean();
    if (!customer) throw notFound();
  } else {
    const key = phoneKey(phone);
    if (key.length >= 6) customer = await M('Customer').findOne({ phoneKey: key }).sort({ createdAt: 1 }).session(session || null).lean();
    if (!customer) {
      const name = String(customerName || '').trim();
      if (!name) throw new AppError(422, 'required_missing', { fields: [{ field: 'customerName', code: 'required' }] });
      const now = new Date();
      const doc = { _id: uuid(), name, phone: String(phone || '').trim(), phoneKey: key, attention: '', note: '', tags: [], people: [], search: noAccent(`${name} ${phone || ''}`), createdAt: now, updatedAt: now };
      await M('Customer').create([doc], opt(session));
      customer = doc;
    }
  }
  const have = new Set((customer.people || []).map((p) => noAccent(p.name)));
  const add = [...new Set(persons.map((p) => String(p || '').trim()).filter(Boolean))].filter((n) => !have.has(noAccent(n)) && noAccent(n) !== noAccent(customer.name));
  if (add.length) {
    const people = [...(customer.people || []), ...add.map((name, i) => ({ id: `p${Date.now().toString(36)}${i}`, name, relation: '', measures: null }))];
    await M('Customer').updateOne({ _id: customer._id }, { $set: { people, updatedAt: new Date() } }, opt(session));
    customer = { ...customer, people };
  }
  return customer;
}

const balance = async (customerId, session) => (await M('Loyalty').aggregate([{ $match: { customerId } }, { $group: { _id: null, p: { $sum: '$points' } } }]).session(session || null))[0]?.p || 0;

/** GET /customers/:id/loyalty */
async function loyalty(customerId) {
  if (!(await M('Customer').exists({ _id: customerId }))) throw notFound();
  const S = await settings.ctx();
  const rows = await M('Loyalty').find({ customerId }).sort({ at: -1 }).limit(100).lean();
  const points = rows.length ? await balance(customerId) : 0;
  return { points, tier: tierOf(S.loyalty.tiers, points)?.name || null, value: points * S.loyalty.value, items: rows.map((r) => ({ id: r._id, points: r.points, reason: r.reason, refId: r.refId, at: iso(r.at) })) };
}

/** Refreshes the search text of the customer's orders after a rename (orders are found by customer name). */
async function syncOrderSearch(customer) {
  const orders = await M('Order').find({ customerId: customer._id }).select('code').lean();
  if (!orders.length) return;
  await M('Order').bulkWrite(orders.map((o) => ({ updateOne: { filter: { _id: o._id }, update: { $set: { search: noAccent(`${o.code} ${customer.name} ${customer.phone || ''}`) } } } })));
}

/** POST /customers/:keepId/merge { otherIds[] }: moves everything to `keepId`, then removes the duplicates. */
async function merge(auth, keepId, body) {
  const otherIds = [...new Set((Array.isArray(body?.otherIds) ? body.otherIds : []).map(String))].filter((id) => id !== keepId);
  if (!otherIds.length) throw new AppError(400, 'validation_failed', { fields: [{ field: 'otherIds', code: 'required' }] });
  const keep = await M('Customer').findById(keepId).lean();
  if (!keep) throw notFound();
  const others = await M('Customer').find({ _id: { $in: otherIds } }).lean();
  if (others.length !== otherIds.length) throw notFound();

  const people = [...(keep.people || [])];
  const names = new Set(people.map((p) => noAccent(p.name)));
  const tags = new Set(keep.tags || []);
  const notes = [keep.note].filter(Boolean);
  for (const o of others) {
    for (const p of o.people || []) if (!names.has(noAccent(p.name))) { names.add(noAccent(p.name)); people.push(p); }
    (o.tags || []).forEach((t) => tags.add(t));
    if (o.note) notes.push(o.note);
    if (o.attention && !keep.attention) keep.attention = o.attention;
  }
  await withTx(async (session) => {
    const o = opt(session);
    for (const name of ['Order', 'Hold', 'Loyalty', 'Fitting', 'Wait']) await M(name).updateMany({ customerId: { $in: otherIds } }, { $set: { customerId: keepId } }, o);
    for (const f of await M('FitMemory').find({ customerId: { $in: otherIds } }).session(session || null).lean()) {
      const dup = await M('FitMemory').exists({ customerId: keepId, person: f.person, pieceId: f.pieceId }).session(session || null);
      if (dup) await M('FitMemory').deleteOne({ _id: f._id }, o);
      else await M('FitMemory').updateOne({ _id: f._id }, { $set: { customerId: keepId } }, o);
    }
    await M('Customer').updateOne({ _id: keepId }, { $set: { people, tags: [...tags], note: notes.join('\n').slice(0, 2000), attention: keep.attention || '', updatedAt: new Date() } }, o);
    await M('Customer').deleteMany({ _id: { $in: otherIds } }, o);
    await M('Tombstone').insertMany(otherIds.map((id) => ({ _id: uuid(), resource: 'customers', rid: id, at: new Date() })), o);
  });
  await syncOrderSearch(keep);
  await require('./audit').log(auth, 'customers', keepId, 'merge', `${otherIds.length} duplicate(s): ${others.map((c) => c.name).join(', ')}`);
  const [item] = [await M('Customer').findById(keepId).lean()].map((c) => ({ id: c._id, name: c.name, phone: c.phone, attention: c.attention, note: c.note, tags: c.tags, people: c.people }));
  await decorate([item]);
  return item;
}

module.exports = { decorate, resolve, balance, loyalty, merge, syncOrderSearch, tierOf, isComp };
