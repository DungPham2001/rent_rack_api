/**
 * Catalog and small tables of a shop, declared once (see engine.js). `path` is where the CRUD router is mounted
 * under /v1 (spec section 4). Fields that only the server changes are `readOnly` (the client cannot send them) or
 * `internal` (stored but never presented).
 */
const { defineResource } = require('./engine');
const { AppError } = require('../lib/errors');
const { phoneKey } = require('../lib/util');

const s = (o = {}) => ({ type: 'string', ...o });
const text = (o = {}) => ({ type: 'text', ...o });
const money = (o = {}) => ({ type: 'money', def: 0, ...o });
const int = (o = {}) => ({ type: 'int', def: 0, ...o });
const bool = (def = false) => ({ type: 'bool', def });
const date = (o = {}) => ({ type: 'date', ...o });
const ref = (model, o = {}) => ({ type: 'ref', ref: model, ...o });
const en = (values, o = {}) => ({ type: 'enum', values, ...o });

const PIECE_STATUS = ['ready', 'held', 'rented', 'wait_wash', 'washing', 'repair', 'retired', 'disposed'];
const FEE_KINDS = ['wash', 'damage', 'lostAcc', 'lostPiece', 'late', 'other'];
const EXPENSE_CATEGORIES = ['rent', 'power', 'salary', 'wash', 'repair', 'ads', 'other'];

const required = (field) => new AppError(422, 'required_missing', { fields: [{ field, code: 'required' }] });

const DEFS = [
  {
    path: 'categories', model: 'Category', collection: 'categories',
    fields: { name: s({ required: true, max: 80 }), sort: int(), active: bool(true) },
    search: ['name'], sort: { sort: 1, name: 1 },
    dependents: [{ model: 'Style', field: 'categoryId', label: 'styles' }],
  },
  {
    path: 'styles', model: 'Style', collection: 'styles',
    fields: {
      code: s({ required: true, max: 40 }), name: s({ required: true, max: 120 }), categoryId: ref('Category'),
      color: s({ max: 60 }), material: s({ max: 60 }), silhouette: s({ max: 60 }), occasions: { type: 'strings' },
      visible: bool(true), featured: bool(false), desc: text({ max: 3000 }), albumUrl: s({ max: 500 }),
      sizes: { type: 'objects', maxItems: 30, of: { label: s({ required: true, max: 20 }), measures: { type: 'any' } } },
      defaultAcc: { type: 'objects', maxItems: 30, of: { accessoryId: ref('Accessory', { required: true }), qty: int({ def: 1, min: 1, max: 99 }) } },
    },
    unique: [['code']], search: ['code', 'name', 'color', 'material', 'silhouette', 'occasions'], sort: { code: 1 }, filters: ['categoryId', 'visible', 'featured'], audit: ['update', 'delete'],
    dependents: [
      { model: 'Piece', field: 'styleId', label: 'pieces' }, { model: 'Price', field: 'styleId', label: 'prices' },
      { model: 'DepositRule', field: 'styleId', label: 'deposit-rules' },
    ],
  },
  {
    path: 'pieces', model: 'Piece', collection: 'pieces', big: true,
    fields: {
      code: s({ required: true, max: 40 }), styleId: ref('Style', { required: true }), size: s({ max: 20 }),
      purchasePrice: money(), purchasedDate: date(), maxRentals: int({ max: 100000 }), shelf: s({ max: 40 }),
      status: en(PIECE_STATUS, { def: 'ready', readOnly: true }), measures: { type: 'any' },
      careDays: { type: 'int', max: 3650 }, lastCareAt: { type: 'datetime', readOnly: true }, washCount: int({ readOnly: true }),
      alter: { type: 'any' }, note: text({ max: 1000 }),
      lockAt: { type: 'datetime', internal: true }, // touched inside order transactions: serializes concurrent bookings of the same piece
    },
    unique: [['code']], search: ['code', 'size', 'shelf'], sort: { code: 1 }, filters: ['styleId', 'status', 'size', 'shelf'], audit: ['update', 'delete'],
    dependents: [
      { model: 'Order', field: 'lines.pieceId', label: 'orders' }, { model: 'Hold', field: 'pieceId', label: 'holds' },
      { model: 'Cleaning', field: 'pieceId', label: 'cleaning' }, { model: 'Price', field: 'pieceId', label: 'prices' },
      { model: 'DepositRule', field: 'pieceId', label: 'deposit-rules' },
    ],
    async beforeDelete(existing) {
      const mongoose = require('mongoose');
      await mongoose.model('PieceLog').deleteMany({ pieceId: existing._id });
    },
  },
  {
    path: 'accessories', model: 'Accessory', collection: 'accessories',
    fields: {
      name: s({ required: true, max: 80 }), kind: s({ max: 40 }), track: en(['qty', 'unit'], { def: 'qty' }), qtyTotal: int({ max: 100000 }),
      lostFee: money(), note: text({ max: 1000 }),
      accUnits: { type: 'objects', maxItems: 500, of: { id: s({ required: true, max: 64 }), code: s({ max: 40 }), status: en(['ok', 'lost', 'broken'], { def: 'ok' }) } },
    },
    search: ['name', 'kind'], sort: { name: 1 },
    dependents: [{ model: 'Order', field: 'acc.accessoryId', label: 'orders' }],
  },
  {
    path: 'bundles', model: 'Bundle', collection: 'bundles',
    fields: { name: s({ required: true, max: 120 }), price: money(), items: text({ max: 1000 }), from: date() },
    search: ['name'], sort: { name: 1 },
    dependents: [{ model: 'Order', field: 'bundleId', label: 'orders' }],
  },
  {
    path: 'prices', model: 'Price', collection: 'prices',
    fields: {
      styleId: ref('Style'), pieceId: ref('Piece'), day: money({ required: true }), tier3: { type: 'money', def: null }, tier7: { type: 'money', def: null },
      extraDay: { type: 'money', def: null }, from: date({ required: true }),
    },
    indexes: [[{ shopId: 1, styleId: 1, from: -1 }], [{ shopId: 1, pieceId: 1, from: -1 }]], filters: ['styleId', 'pieceId'], sort: { from: -1 }, audit: ['create', 'update', 'delete'],
    validate(data, { existing }) {
      const styleId = data.styleId !== undefined ? data.styleId : existing?.styleId;
      const pieceId = data.pieceId !== undefined ? data.pieceId : existing?.pieceId;
      if (!styleId === !pieceId) throw required('styleId');
    },
  },
  {
    path: 'deposit-rules', model: 'DepositRule', collection: 'deposit_rules',
    fields: { styleId: ref('Style'), pieceId: ref('Piece'), kind: en(['fixed', 'pct'], { required: true }), value: int({ required: true, max: 100000000 }) },
    filters: ['styleId', 'pieceId'], audit: ['create', 'update', 'delete'],
    validate(data, { existing }) {
      const styleId = data.styleId !== undefined ? data.styleId : existing?.styleId;
      const pieceId = data.pieceId !== undefined ? data.pieceId : existing?.pieceId;
      if (!styleId === !pieceId) throw required('styleId');
    },
  },
  {
    path: 'fees', model: 'Fee', collection: 'fees',
    fields: { kind: en(FEE_KINDS, { required: true }), name: s({ required: true, max: 80 }), amount: money() },
    filters: ['kind'], sort: { kind: 1, name: 1 }, audit: ['create', 'update', 'delete'],
  },
  { path: 'zones', model: 'Zone', collection: 'zones', fields: { name: s({ required: true, max: 80 }), fee: money() }, search: ['name'], sort: { name: 1 }, dependents: [{ model: 'Order', field: 'zoneId', label: 'orders' }] },
  {
    path: 'peaks', model: 'Peak', collection: 'peaks',
    fields: { name: s({ required: true, max: 80 }), from: date({ required: true }), to: date({ required: true }), kind: en(['pct', 'amount'], { required: true }), value: int({ max: 100000000 }) },
    sort: { from: 1 },
    validate(data, { existing }) {
      const from = data.from || existing?.from;
      const to = data.to || existing?.to;
      if (from && to && to < from) throw new AppError(422, 'invalid', { fields: [{ field: 'to', code: 'before_from' }] });
    },
  },
  { path: 'closed-dates', model: 'ClosedDate', collection: 'closed_dates', fields: { date: date({ required: true }), note: s({ max: 200 }) }, unique: [['date']], sort: { date: 1 }, dateField: 'date' },
  { path: 'rooms', model: 'Room', collection: 'rooms', fields: { name: s({ required: true, max: 80 }), active: bool(true) }, sort: { name: 1 }, dependents: [{ model: 'Fitting', field: 'roomId', label: 'fittings' }] },
  {
    path: 'promos', model: 'Promo', collection: 'promos',
    fields: {
      code: s({ required: true, max: 30, pattern: /^[\p{L}\p{N}_-]+$/u }), kind: en(['pct', 'amount'], { required: true }), value: int({ max: 100000000 }),
      minAmount: money(), start: date(), end: date(), limit: int(), used: int({ readOnly: true }),
    },
    unique: [['code']], search: ['code'], sort: { createdAt: -1 }, audit: ['create', 'update', 'delete'],
    dependents: [{ model: 'Order', field: 'promoCode', key: 'code', label: 'orders' }],
    validate(data) { if (data.code) data.code = data.code.toUpperCase(); },
  },
  {
    path: 'discounts', model: 'Discount', collection: 'discounts',
    fields: { name: s({ required: true, max: 80 }), kind: en(['pct', 'amount'], { required: true }), value: int({ max: 100000000 }), minItems: int(), minDays: int(), regularOnly: bool(false) },
    sort: { name: 1 }, audit: ['create', 'update', 'delete'],
  },
  {
    path: 'customers', model: 'Customer', collection: 'customers', big: true,
    fields: {
      name: s({ required: true, max: 100 }), phone: { type: 'phone' }, attention: text({ max: 500 }), note: text({ max: 2000 }), tags: { type: 'strings' },
      people: { type: 'objects', maxItems: 20, of: { id: s({ max: 64 }), name: s({ required: true, max: 100 }), relation: s({ max: 40 }), measures: { type: 'any' } } },
      phoneKey: { type: 'string', internal: true },
    },
    search: ['name', 'phone'], sort: { createdAt: -1 }, filters: [], audit: ['update', 'delete'], indexes: [[{ shopId: 1, phoneKey: 1 }]],
    dependents: [{ model: 'Order', field: 'customerId', label: 'orders' }, { model: 'Hold', field: 'customerId', label: 'holds' }],
    validate(data) {
      if (data.phone !== undefined) data.phoneKey = phoneKey(data.phone);
      data.people = (data.people || []).map((p, i) => ({ ...p, id: p.id || `p${Date.now().toString(36)}${i}` }));
    },
    async decorate(items) { await require('../services/customers').decorate(items); },
    async afterWrite(doc, existing) {
      if (existing && (existing.name !== doc.name || existing.phone !== doc.phone)) await require('../services/customers').syncOrderSearch(doc);
    },
    async beforeDelete(existing) {
      await require('mongoose').model('Loyalty').deleteMany({ customerId: existing._id });
    },
  },
  {
    path: 'staff', model: 'Staff', collection: 'staff',
    fields: { name: s({ required: true, max: 100 }), phone: { type: 'phone' }, role: en(['sales', 'laundry', 'tailor', 'delivery'], { required: true }), position: s({ max: 60 }), joined: date(), status: en(['active', 'left'], { def: 'active' }) },
    search: ['name', 'phone'], sort: { name: 1 }, filters: ['role', 'status'], audit: ['update', 'delete'],
    dependents: [{ model: 'Task', field: 'staffId', label: 'tasks' }, { model: 'Schedule', field: 'staffId', label: 'schedules' }, { model: 'Fitting', field: 'staffId', label: 'fittings' }],
  },
  {
    path: 'schedules', model: 'Schedule', collection: 'schedules',
    fields: { staffId: ref('Staff', { required: true }), date: date({ required: true }), kind: en(['work', 'off'], { required: true }), note: s({ max: 200 }) },
    unique: [['staffId', 'date']], filters: ['staffId', 'kind'], dateField: 'date', sort: { date: 1 },
  },
  {
    path: 'tasks', model: 'Task', collection: 'tasks',
    fields: { staffId: ref('Staff', { required: true }), date: date({ required: true }), kind: s({ required: true, max: 40 }), ref: s({ max: 64 }), pay: money(), done: bool(false), note: s({ max: 300 }) },
    filters: ['staffId', 'kind', 'done'], dateField: 'date', sort: { date: -1 },
  },
  {
    path: 'feedback', model: 'Feedback', collection: 'feedback',
    fields: { orderId: ref('Order', { required: true }), stars: { type: 'int', min: 1, max: 5, required: true }, text: text({ max: 2000 }) },
    filters: ['orderId'], sort: { createdAt: -1 },
  },
  {
    path: 'complaints', model: 'Complaint', collection: 'complaints',
    fields: { orderId: ref('Order'), text: text({ required: true, max: 3000 }), status: en(['open', 'resolved'], { def: 'open' }), resolution: text({ max: 2000 }) },
    filters: ['orderId', 'status'], sort: { createdAt: -1 },
  },
  { path: 'faq', model: 'Faq', collection: 'faq', fields: { q: s({ required: true, max: 300 }), a: text({ required: true, max: 3000 }), sort: int() }, sort: { sort: 1, createdAt: 1 } },
  {
    path: 'supplies', model: 'Supply', collection: 'supplies',
    fields: { name: s({ required: true, max: 80 }), unit: s({ max: 20 }), qty: { type: 'number', def: 0, max: 1e9, readOnly: true }, min: { type: 'number', def: 0, max: 1e9 } },
    search: ['name'], sort: { name: 1 },
    async beforeDelete(existing) { await require('mongoose').model('SupplyMove').deleteMany({ supplyId: existing._id }); },
  },
  { path: 'partners', model: 'Partner', collection: 'partners', fields: { name: s({ required: true, max: 100 }), phone: { type: 'phone' }, priceNote: text({ max: 500 }) }, search: ['name'], sort: { name: 1 }, dependents: [{ model: 'Cleaning', field: 'partnerId', label: 'cleaning' }] },
  { path: 'suppliers', model: 'Supplier', collection: 'suppliers', fields: { name: s({ required: true, max: 100 }), phone: { type: 'phone' }, priceNote: text({ max: 500 }) }, search: ['name'], sort: { name: 1 }, dependents: [{ model: 'Purchase', field: 'supplierId', label: 'purchases' }] },
  {
    path: 'expenses', model: 'Expense', collection: 'expenses', big: true,
    fields: { category: en(EXPENSE_CATEGORIES, { required: true }), amount: money({ required: true }), date: date({ required: true }), recurring: bool(false), note: s({ max: 300 }) },
    filters: ['category', 'recurring'], dateField: 'date', sort: { date: -1 }, audit: ['update', 'delete'],
  },
  {
    path: 'targets', model: 'Target', collection: 'targets',
    fields: { month: s({ required: true, pattern: /^\d{4}-(0[1-9]|1[0-2])$/, max: 7 }), amount: money({ required: true }) }, unique: [['month']], sort: { month: -1 },
  },
  { path: 'checklists', model: 'Checklist', collection: 'checklists', fields: { kind: en(['qc', 'out', 'in'], { required: true }), title: s({ required: true, max: 120 }), sort: int() }, filters: ['kind'], sort: { kind: 1, sort: 1 } },
  { path: 'care-notes', model: 'CareNote', collection: 'care_notes', fields: { material: s({ required: true, max: 60 }), text: text({ required: true, max: 2000 }) }, sort: { material: 1 }, search: ['material'] },
  { path: 'counts', model: 'Count', collection: 'counts', fields: { date: date({ required: true }), items: { type: 'any' }, note: text({ max: 1000 }) }, dateField: 'date', sort: { date: -1 } },
  {
    path: 'todos', model: 'Todo', collection: 'todos',
    fields: { title: s({ required: true, max: 200 }), due: date(), repeat: en(['none', 'daily', 'weekly', 'monthly'], { def: 'none' }), done: bool(false), note: text({ max: 1000 }) },
    filters: ['done'], sort: { done: 1, due: 1 },
  },
  { path: 'notes', model: 'Note', collection: 'notes', fields: { title: s({ max: 120 }), text: text({ required: true, max: 5000 }), pinned: bool(false) }, sort: { pinned: -1, createdAt: -1 }, search: ['title', 'text'] },
  {
    path: 'waits', model: 'Wait', collection: 'waits',
    fields: {
      customerId: ref('Customer'), name: s({ max: 100 }), phone: { type: 'phone' }, styleId: ref('Style', { required: true }), size: s({ max: 20 }),
      from: date({ required: true }), to: date({ required: true }), note: text({ max: 500 }), status: en(['open', 'done', 'cancelled'], { def: 'open' }),
    },
    filters: ['styleId', 'status', 'customerId'], sort: { from: 1 },
  },
  {
    path: 'missed', model: 'Missed', collection: 'missed',
    fields: { date: date({ required: true }), styleId: ref('Style'), size: s({ max: 20 }), name: s({ max: 100 }), phone: { type: 'phone' }, note: text({ max: 500 }) },
    filters: ['styleId'], dateField: 'date', sort: { date: -1 },
  },
  {
    path: 'alterations', model: 'Alteration', collection: 'alterations',
    fields: {
      orderId: ref('Order', { required: true }), pieceId: ref('Piece', { required: true }), status: en(['pending', 'doing', 'done'], { def: 'pending' }), due: date(),
      cost: money(), revertNeeded: bool(false), revertDone: bool(false), revertDue: { type: 'date', readOnly: true }, note: text({ max: 1000 }),
    },
    filters: ['orderId', 'pieceId', 'status'], sort: { createdAt: -1 },
  },
  {
    path: 'fittings', model: 'Fitting', collection: 'fittings',
    fields: {
      date: date({ required: true }), start: int({ required: true, max: 1439 }), end: int({ required: true, max: 1440 }), roomId: ref('Room'), staffId: ref('Staff'),
      orderId: ref('Order'), customerId: ref('Customer'), pieceId: ref('Piece'), person: s({ max: 100 }), note: s({ max: 300 }),
      status: en(['scheduled', 'done', 'missed', 'cancelled'], { def: 'scheduled' }), result: en(['fit', 'tight', 'loose', 'other']),
    },
    filters: ['roomId', 'staffId', 'orderId', 'status', 'customerId'], dateField: 'date', sort: { date: 1, start: 1 },
    async validate(data, { existing }) { await require('../services/fittings').check(data, existing); },
    async afterWrite(doc, existing) { await require('../services/fittings').remember(doc, existing); },
  },
  {
    path: 'fit-memory', model: 'FitMemory', collection: 'fit_memory', readOnlyApi: true,
    fields: { customerId: s({ required: true }), person: s({ max: 100 }), pieceId: s({ required: true }), styleId: s() },
    unique: [['customerId', 'person', 'pieceId']], filters: ['customerId', 'pieceId', 'styleId'],
  },
];

const resources = DEFS.map((d) => defineResource(d));
const models = Object.fromEntries(resources.map((r) => [r.def.model, r.model]));
const byPath = Object.fromEntries(resources.map((r) => [r.def.path, r]));

module.exports = { resources, models, byPath, PIECE_STATUS, FEE_KINDS, EXPENSE_CATEGORIES };
