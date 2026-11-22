/**
 * MongoDB collections of the `rentrack` database. Multi-shop: every shop-owned document carries `shopId`
 * (added by lib/tenantPlugin.js from the request's shop). Primary keys are strings (UUID, or an id sent by the
 * client on create), money is whole dong (integers), instants are UTC Dates, local dates are "yyyy-MM-dd" strings in
 * the shop's timezone. Simple catalog tables are declared in `src/resources/defs.js` and merged into the exports.
 */
const mongoose = require('mongoose');

const { Schema } = mongoose;
const Mixed = Schema.Types.Mixed;

/** Collections shared by every shop: logins, sessions, idempotency keys, counters. */
const SHARED = new Set(['accounts', 'sessions', 'password_resets', 'receipts', 'rate_hits', 'counters']);

const make = (name, collection, def, indexes = []) => {
  const s = new Schema(def, { collection, versionKey: false, minimize: false });
  for (const [spec, opts] of indexes) s.index(spec, opts);
  if (!SHARED.has(collection)) s.plugin(require('../lib/tenantPlugin'));
  return mongoose.model(name, s);
};
const stamps = { createdAt: { type: Date, default: Date.now }, updatedAt: { type: Date, default: Date.now } };

// ---------- accounts & sessions (shared) ----------

/** One admin login. Every admin of a shop has the same rights; `shopId` = id of the shop's first admin. */
const Account = make('Account', 'accounts', {
  _id: String,
  email: { type: String, required: true },
  passwordHash: { type: String, required: true },
  name: { type: String, required: true },
  phone: { type: String, default: '' },
  language: { type: String, enum: ['vi', 'en'], default: 'vi' },
  shopId: { type: String, required: true },
  status: { type: String, enum: ['active', 'revoked'], default: 'active' },
  search: { type: String, default: '' },
  passwordChangedAt: Date,
  lastLoginAt: Date,
  ...stamps,
}, [
  [{ email: 1 }, { unique: true }],
  [{ shopId: 1, createdAt: 1 }, {}],
]);

/**
 * A signed-in device. `refreshHash` rotates on every refresh (reuse revokes the session). With "Ghi nhớ" the session
 * also has a `resumeHash` (random token kept by the app, only its hash is stored) valid 30 days sliding.
 */
const Session = make('Session', 'sessions', {
  _id: String,
  accountId: { type: String, required: true },
  name: { type: String, default: '' },
  clientDeviceId: { type: String, default: null },
  remember: { type: Boolean, default: false },
  refreshHash: { type: String, required: true },
  prevRefreshHash: { type: String, default: null },
  refreshExpiresAt: { type: Date, required: true },
  absoluteExpiresAt: { type: Date, required: true },
  resumeHash: { type: String, default: null },
  resumeExpiresAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
  lastSeenAt: { type: Date, default: Date.now },
  revokedAt: { type: Date, default: null },
  revokeReason: { type: String, default: null },
  expireAt: { type: Date, required: true },
}, [
  [{ accountId: 1, revokedAt: 1 }, {}],
  [{ expireAt: 1 }, { expireAfterSeconds: 0 }],
]);

const PasswordReset = make('PasswordReset', 'password_resets', {
  _id: String,
  accountId: { type: String, required: true },
  codeHash: { type: String, required: true },
  expiresAt: { type: Date, required: true },
  usedAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
}, [
  [{ codeHash: 1 }, { unique: true }],
  [{ accountId: 1 }, {}],
  [{ expiresAt: 1 }, { expireAfterSeconds: 86400 }],
]);

/** Idempotency receipts: `idem|<shopId>|<sha256(key)>` = { state: 'pending'|'done', status, body }. */
const Receipt = make('Receipt', 'receipts', {
  _id: String,
  state: { type: String, default: 'done' },
  status: Number,
  result: Mixed,
  expireAt: { type: Date, required: true },
}, [[{ expireAt: 1 }, { expireAfterSeconds: 0 }]]);

const RateHit = make('RateHit', 'rate_hits', {
  _id: String,
  count: { type: Number, default: 0 },
  expireAt: Date,
}, [[{ expireAt: 1 }, { expireAfterSeconds: 0 }]]);

/** Monthly order-code counter: `_id` = `<shopId>|<yymm>`. */
const Counter = make('Counter', 'counters', { _id: String, seq: { type: Number, default: 0 } });

// ---------- shop-owned ----------

/** One row per (shop, key): shop, rules, policy, loyalty, hours. */
const Setting = make('Setting', 'settings', {
  _id: String,
  key: { type: String, required: true },
  value: { type: Mixed, default: {} },
  updatedBy: { type: String, default: null },
  updatedAt: { type: Date, default: Date.now },
}, [[{ shopId: 1, key: 1 }, { unique: true }]]);

/** Sensitive actions (spec 10). Only the server writes here. */
const AdminAction = make('AdminAction', 'admin_actions', {
  _id: String,
  by: { type: String, default: null }, // account id or "system"
  byName: { type: String, default: '' },
  target: String,
  targetId: { type: String, default: null },
  action: String,
  note: { type: String, default: '' },
  at: { type: Date, default: Date.now },
}, [[{ shopId: 1, at: -1 }, {}]]);

/** Deleted rows, for `GET /v1/sync?since=`. */
const Tombstone = make('Tombstone', 'tombstones', {
  _id: String,
  resource: String,
  rid: String,
  at: { type: Date, default: Date.now },
}, [[{ shopId: 1, at: 1 }, {}], [{ at: 1 }, { expireAfterSeconds: 90 * 86400 }]]);

/** Rental order with embedded lines and accessories (spec 5.1). */
const Order = make('Order', 'orders', {
  _id: String,
  code: { type: String, required: true },
  customerId: { type: String, required: true },
  source: { type: String, default: 'other' },
  status: { type: String, default: 'reserved' },
  receiveDate: String,
  dueDate: String,
  receiveMinute: { type: Number, default: null },
  returnedAt: { type: Date, default: null },
  deliveredAt: { type: Date, default: null },
  receiveMode: { type: String, default: 'store' },
  returnMode: { type: String, default: 'store' },
  receiveAddr: { type: String, default: '' },
  returnAddr: { type: String, default: '' },
  receiveFee: { type: Number, default: 0 },
  returnFee: { type: Number, default: 0 },
  zoneId: { type: String, default: null },
  rent: { type: Number, default: 0 },
  normalRent: { type: Number, default: 0 },
  surcharge: { type: Number, default: 0 },
  discount: { type: Number, default: 0 },
  discountNote: { type: String, default: '' },
  deposit: { type: Number, default: 0 },
  holdAmount: { type: Number, default: 0 },
  payOnReceive: { type: Number, default: 0 },
  compReason: { type: String, default: '' },
  specialRent: { type: Number, default: null },
  bundleId: { type: String, default: null },
  promoCode: { type: String, default: '' },
  redeemPoints: { type: Number, default: 0 },
  note: { type: String, default: '' },
  internalNote: { type: String, default: '' },
  policySnap: { type: Mixed, default: null },
  feeSnap: { type: Mixed, default: null },
  lines: { type: [Mixed], default: [] },
  acc: { type: [Mixed], default: [] },
  settlement: { type: Mixed, default: null },
  changes: { type: [Mixed], default: [] },
  contacted: { type: Boolean, default: false },
  contactedAt: { type: Date, default: null },
  cancelInfo: { type: Mixed, default: null },
  search: { type: String, default: '' },
  createdBy: { type: String, default: null },
  ...stamps,
}, [
  [{ shopId: 1, code: 1 }, { unique: true }],
  [{ shopId: 1, status: 1, dueDate: 1 }, {}],
  [{ shopId: 1, createdAt: -1 }, {}],
  [{ shopId: 1, customerId: 1 }, {}],
  [{ 'lines.pieceId': 1 }, {}],
]);

/** Money movement. kind: hold|rent|deposit|deposit_refund|fee|refund; method: cash|transfer|comp|deposit. */
const Payment = make('Payment', 'payments', {
  _id: String,
  orderId: { type: String, default: null },
  holdId: { type: String, default: null },
  kind: String,
  method: String,
  amount: Number,
  at: { type: Date, default: Date.now },
  by: { type: String, default: null },
  byName: { type: String, default: '' },
  note: { type: String, default: '' },
}, [[{ shopId: 1, at: -1 }, {}], [{ orderId: 1 }, {}], [{ holdId: 1 }, {}]]);

const Hold = make('Hold', 'holds', {
  _id: String,
  customerId: String,
  pieceId: String,
  from: String,
  to: String,
  until: Date,
  amount: Number,
  method: String,
  status: { type: String, default: 'active' },
  orderId: { type: String, default: null },
  note: { type: String, default: '' },
  createdBy: { type: String, default: null },
  ...stamps,
}, [[{ shopId: 1, status: 1, until: 1 }, {}], [{ pieceId: 1, status: 1 }, {}]]);

/** Delivery slips (kind out) and return slips (kind in). */
const Delivery = make('Delivery', 'deliveries', {
  _id: String,
  orderId: String,
  kind: String,
  receiver: { type: String, default: '' },
  mode: { type: String, default: 'store' },
  address: { type: String, default: '' },
  fee: { type: Number, default: 0 },
  staffId: { type: String, default: null },
  condition: { type: Mixed, default: {} },
  note: { type: String, default: '' },
  at: { type: Date, default: Date.now },
  by: { type: String, default: null },
}, [[{ orderId: 1 }, {}]]);

const Return = make('Return', 'returns', {
  _id: String,
  orderId: String,
  lines: { type: [Mixed], default: [] },
  lateDays: { type: Number, default: 0 },
  staffId: { type: String, default: null },
  at: { type: Date, default: Date.now },
  by: { type: String, default: null },
}, [[{ orderId: 1 }, {}], [{ shopId: 1, at: -1 }, {}]]);

/** Laundry / repair queue (spec 6). */
const Cleaning = make('Cleaning', 'cleaning', {
  _id: String,
  pieceId: String,
  kind: { type: String, default: 'dry' },
  status: { type: String, default: 'waiting' },
  partnerId: { type: String, default: null },
  staffId: { type: String, default: null },
  startedAt: { type: Date, default: Date.now },
  dueAt: { type: Date, default: null },
  doneAt: { type: Date, default: null },
  cost: { type: Number, default: 0 },
  qc: { type: Mixed, default: {} },
  orderId: { type: String, default: null },
  returnedAt: { type: Date, default: null },
  note: { type: String, default: '' },
  ...stamps,
}, [[{ shopId: 1, pieceId: 1, status: 1 }, {}], [{ shopId: 1, status: 1, dueAt: 1 }, {}]]);

const PieceLog = make('PieceLog', 'piece_logs', {
  _id: String,
  pieceId: String,
  orderId: { type: String, default: null },
  kind: String, // damage|dirty|missing|lost|care|dispose|status
  note: { type: String, default: '' },
  at: { type: Date, default: Date.now },
  by: { type: String, default: null },
}, [[{ pieceId: 1, at: -1 }, {}]]);

/** Points ledger: balance = sum(points). */
const Loyalty = make('Loyalty', 'loyalty', {
  _id: String,
  customerId: String,
  points: Number,
  reason: String, // order|redeem|cancel
  refId: { type: String, default: null },
  at: { type: Date, default: Date.now },
}, [[{ customerId: 1, at: -1 }, {}], [{ refId: 1 }, {}]]);

const Shift = make('Shift', 'shifts', {
  _id: String,
  openedBy: { type: String, default: null },
  openedByName: { type: String, default: '' },
  startAt: { type: Date, default: Date.now },
  startCash: { type: Number, default: 0 },
  endAt: { type: Date, default: null },
  counted: { type: Number, default: null },
  expected: { type: Number, default: null },
  diff: { type: Number, default: null },
  note: { type: String, default: '' },
  status: { type: String, default: 'open' },
}, [[{ shopId: 1, status: 1 }, { unique: true, partialFilterExpression: { status: 'open' } }], [{ shopId: 1, startAt: -1 }, {}]]);

const CashEntry = make('CashEntry', 'cash', {
  _id: String,
  type: String, // in|out
  amount: Number,
  reason: { type: String, default: '' },
  date: String,
  at: { type: Date, default: Date.now },
  by: { type: String, default: null },
}, [[{ shopId: 1, at: -1 }, {}]]);

const Disposal = make('Disposal', 'disposals', {
  _id: String, pieceId: String, kind: String, price: { type: Number, default: 0 }, reason: { type: String, default: '' }, at: { type: Date, default: Date.now }, by: { type: String, default: null },
}, [[{ shopId: 1, at: -1 }, {}]]);

const Purchase = make('Purchase', 'purchases', {
  _id: String, supplierId: { type: String, default: null }, pieceId: String, cost: Number, date: String, at: { type: Date, default: Date.now }, by: { type: String, default: null },
}, [[{ shopId: 1, at: -1 }, {}]]);

const SupplyMove = make('SupplyMove', 'supply_moves', {
  _id: String, supplyId: String, type: String, qty: Number, note: { type: String, default: '' }, at: { type: Date, default: Date.now }, by: { type: String, default: null },
}, [[{ supplyId: 1, at: -1 }, {}]]);

module.exports = {
  mongoose, SHARED, Account, Session, PasswordReset, Receipt, RateHit, Counter, Setting, AdminAction, Tombstone,
  Order, Payment, Hold, Delivery, Return, Cleaning, PieceLog, Loyalty, Shift, CashEntry, Disposal, Purchase, SupplyMove,
};

// Catalog tables declared in resources/defs.js (Category, Style, Piece, ...) are added to the exports.
Object.assign(module.exports, require('../resources/defs').models);
