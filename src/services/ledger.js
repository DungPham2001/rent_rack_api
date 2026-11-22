/**
 * Money rules (spec 5.5, 9).
 * - paidRent    = hold + rent payments - refunds (comp counts: it settles the balance but is not money)
 * - depositHeld = deposits - deposit refunds - fees taken from the deposit (method "deposit")
 * - revenue     = hold + rent + fee, excluding method "comp", minus refunds. Deposits are never revenue.
 * Revenue is dated by the payment's `at` (local date in the shop's timezone).
 */
const { Payment } = require('../models');
const { uuid, iso } = require('../lib/util');
const { AppError } = require('../lib/errors');

const KINDS = ['hold', 'rent', 'deposit', 'deposit_refund', 'fee', 'refund'];
const METHODS = ['cash', 'transfer', 'comp', 'deposit'];

const sum = (rows, f) => rows.reduce((t, p) => t + (f(p) ? p.amount : 0), 0);

const paidRent = (ps) => sum(ps, (p) => p.kind === 'hold' || p.kind === 'rent') - sum(ps, (p) => p.kind === 'refund');
/** Paid in real money (not comp): what can be refunded when an order is cancelled. */
const paidRentReal = (ps) => sum(ps, (p) => (p.kind === 'hold' || p.kind === 'rent') && p.method !== 'comp') - sum(ps, (p) => p.kind === 'refund' && p.method !== 'comp');
const depositHeld = (ps) => sum(ps, (p) => p.kind === 'deposit') - sum(ps, (p) => p.kind === 'deposit_refund') - sum(ps, (p) => p.kind === 'fee' && p.method === 'deposit');
const revenueOf = (ps) => sum(ps, (p) => ['hold', 'rent', 'fee'].includes(p.kind) && p.method !== 'comp') - sum(ps, (p) => p.kind === 'refund' && p.method !== 'comp');

/** Map orderId -> { paidRent, paidRentReal, depositHeld, revenue } for several orders in one query. */
async function summaries(orderIds) {
  const out = new Map(orderIds.map((id) => [id, { paidRent: 0, paidRentReal: 0, depositHeld: 0, revenue: 0 }]));
  if (!orderIds.length) return out;
  const rows = await Payment.find({ orderId: { $in: orderIds } }).lean();
  const by = new Map();
  for (const p of rows) {
    if (!by.has(p.orderId)) by.set(p.orderId, []);
    by.get(p.orderId).push(p);
  }
  for (const [id, ps] of by) out.set(id, { paidRent: paidRent(ps), paidRentReal: paidRentReal(ps), depositHeld: depositHeld(ps), revenue: revenueOf(ps) });
  return out;
}

const forOrder = async (orderId, session) => {
  const q = Payment.find({ orderId });
  if (session) q.session(session);
  const ps = await q.lean();
  return { payments: ps, paidRent: paidRent(ps), paidRentReal: paidRentReal(ps), depositHeld: depositHeld(ps) };
};

/** Builds a payment document (not saved). `who` = req.auth. */
function make({ orderId = null, holdId = null, kind, method, amount, note = '', at = new Date() }, who) {
  return {
    _id: uuid(), orderId, holdId, kind, method, amount, at, by: who?.accountId || null, byName: who?.account?.name || '', note: String(note || '').slice(0, 500),
  };
}

/** Rules every payment must satisfy (spec 5.5). Throws on a bad combination. */
function assertValid({ kind, method, amount, note }) {
  const bad = (field, code) => new AppError(400, 'validation_failed', { fields: [{ field, code }] });
  if (!KINDS.includes(kind)) throw bad('kind', 'invalid_enum');
  if (!METHODS.includes(method)) throw bad('method', 'invalid_enum');
  if (!Number.isInteger(amount) || amount <= 0 || amount > 10_000_000_000) throw bad('amount', 'out_of_range');
  if (method === 'deposit' && kind !== 'fee') throw bad('method', 'invalid_enum'); // only a fee can be taken from the deposit
  if (method === 'comp') {
    if (!['hold', 'rent', 'fee'].includes(kind)) throw bad('method', 'invalid_enum'); // deposits and refunds are always real money
    if (!String(note || '').trim()) throw new AppError(422, 'comp_reason_required');
  }
}

const present = (p) => ({ id: p._id, orderId: p.orderId, holdId: p.holdId, kind: p.kind, method: p.method, amount: p.amount, at: iso(p.at), by: p.by, byName: p.byName, note: p.note });

module.exports = { KINDS, METHODS, paidRent, paidRentReal, depositHeld, revenueOf, summaries, forOrder, make, assertValid, present };
