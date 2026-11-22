/**
 * Dashboard (`GET /v1/home`, spec 3) and the raw data behind the app's local reminders (`GET /v1/reminders/source`).
 * One call fills the whole Tổng quan screen; pull-to-refresh repeats it.
 */
const mongoose = require('mongoose');
const reports = require('./reports');
const ledger = require('./ledger');
const orders = require('./orders');
const pieces = require('./pieces');
const holds = require('./holds');
const settings = require('./settings');
const { iso } = require('../lib/util');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const OPEN = ['reserved', 'paid', 'delivered', 'returned'];

const brief = (o) => ({ id: o.id, code: o.code, customer: o.customer, status: o.status, receiveDate: o.receiveDate, dueDate: o.dueDate, receiveMinute: o.receiveMinute, grand: o.grand, balance: o.balance, lines: o.lines.length, overdue: o.overdue, lateDays: o.lateDays });

async function home(query) {
  const r = await reports.resolveRange(query);
  const { S } = r;
  const [rv, occ] = await Promise.all([reports.revenueSummary(r), reports.occupancy(r)]);
  const styleRanking = await reports.styleRanking(r, 10, rv.orders);

  const [deliverToday, returnToday, overdue, callList, openOrders, recent, rackRows, lowSup, expiring, peaks, staff, tasksToday, fitToday, cleanDue, insight] = await Promise.all([
    M('Order').find({ receiveDate: S.today, status: { $in: ['reserved', 'paid', 'delivered'] } }).sort({ receiveMinute: 1 }).lean(),
    M('Order').find({ dueDate: S.today, status: 'delivered' }).sort({ createdAt: 1 }).lean(),
    M('Order').countDocuments({ status: 'delivered', dueDate: { $lt: S.today } }),
    M('Order').countDocuments({ status: 'delivered', dueDate: { $lte: T.addDays(S.today, 2) } }),
    M('Order').find({ status: { $in: OPEN } }).select('_id').lean(),
    M('Order').find({}).sort({ createdAt: -1 }).limit(6).lean(),
    M('Piece').aggregate([{ $group: { _id: '$status', n: { $sum: 1 } } }]),
    M('Supply').find({ $expr: { $lte: ['$qty', '$min'] } }).select('name qty min unit').lean(),
    M('Hold').countDocuments({ status: 'active', until: { $lte: new Date(Date.now() + 24 * 3600 * 1000) } }),
    M('Peak').find({ to: { $gte: S.today } }).sort({ from: 1 }).limit(5).lean(),
    M('Staff').find({ status: 'active' }).sort({ name: 1 }).lean(),
    M('Task').find({ date: S.today }).lean(),
    M('Fitting').find({ date: S.today, status: 'scheduled' }).lean(),
    M('Cleaning').countDocuments({ status: { $ne: 'done' }, dueAt: { $lt: T.localToUtc(T.addDays(S.today, 1), '00:00', S.tz) } }),
    pieces.insights(),
  ]);
  const sums = await ledger.summaries(openOrders.map((o) => o._id));
  const rack = Object.fromEntries(['ready', 'held', 'rented', 'wait_wash', 'washing', 'repair'].map((k) => [k, 0]));
  for (const x of rackRows) if (x._id in rack) rack[x._id] = x.n;
  const off = new Set((await M('Schedule').find({ date: S.today, kind: 'off' }).lean()).map((x) => x.staffId));
  const presentToday = await orders.presentMany([...deliverToday, ...returnToday]);
  const pm = new Map(presentToday.map((o) => [o.id, o]));
  const workToday = deliverToday.length + returnToday.length + fitToday.length + cleanDue;

  return {
    range: { range: r.range, from: r.from, to: r.to, previous: r.previous },
    revenue: rv.summary, ordersCreated: rv.orders.length, avgPerDay: rv.avgPerDay, occupancy: occ.rate, buckets: rv.rows, styleRanking,
    today: { date: S.today, deliver: deliverToday.map((o) => brief(pm.get(o._id))), return: returnToday.map((o) => brief(pm.get(o._id))) },
    attention: { overdue, callList, holdsExpiring: expiring, lowSupplies: lowSup.length, careDue: insight.careDue.length, stale: insight.stale.length, endOfLife: insight.endOfLife.length },
    depositsHeld: [...sums.values()].reduce((t, x) => t + Math.max(0, x.depositHeld), 0),
    rack,
    peaks: peaks.map((p) => ({ id: p._id, name: p.name, from: p.from, to: p.to, kind: p.kind, value: p.value })),
    staff: staff.map((s) => ({ id: s._id, name: s.name, role: s.role, off: off.has(s._id), tasks: tasksToday.filter((t) => t.staffId === s._id).length, done: tasksToday.filter((t) => t.staffId === s._id && t.done).length, fittings: fitToday.filter((f) => f.staffId === s._id).length })),
    recentOrders: (await orders.presentMany(recent)).map(brief),
    dayLoad: { count: workToday, overloaded: workToday > S.rules.overloadPerDay, limit: S.rules.overloadPerDay },
    serverTime: iso(new Date()),
  };
}

/**
 * GET /v1/reminders/source — the app builds its local reminders from this: open orders and holds near today
 * (14 days ahead, 7 days back), fittings, open laundry jobs, to-dos, low supplies, the open shift, upcoming peaks.
 */
async function remindersSource() {
  const S = await settings.ctx();
  const from = T.addDays(S.today, -7);
  const to = T.addDays(S.today, 14);
  const [ord, hs, fit, cl, todos, sup, shift, peaks, ins] = await Promise.all([
    M('Order').find({ status: { $in: OPEN }, $or: [{ receiveDate: { $gte: from, $lte: to } }, { dueDate: { $gte: from, $lte: to } }, { status: 'delivered', dueDate: { $lt: from } }] }).sort({ dueDate: 1 }).limit(500).lean(),
    M('Hold').find({ status: 'active', until: { $lte: T.localToUtc(T.addDays(to, 1), '00:00', S.tz) } }).limit(500).lean(),
    M('Fitting').find({ date: { $gte: from, $lte: to }, status: 'scheduled' }).limit(500).lean(),
    M('Cleaning').find({ status: { $ne: 'done' } }).limit(500).lean(),
    M('Todo').find({ done: false, $or: [{ due: { $lte: to } }, { due: null }] }).limit(200).lean(),
    M('Supply').find({ $expr: { $lte: ['$qty', '$min'] } }).lean(),
    M('Shift').findOne({ status: 'open' }).lean(),
    M('Peak').find({ from: { $gte: S.today, $lte: T.addDays(S.today, 30) } }).lean(),
    pieces.insights(),
  ]);
  return {
    serverTime: iso(new Date()), today: S.today, timezone: S.tz, window: { from, to },
    orders: (await orders.presentMany(ord)).map((o) => ({ ...brief(o), deliveredAt: o.deliveredAt, source: o.source })),
    holds: await holds.presentMany(hs), fittings: fit.map((f) => ({ id: f._id, date: f.date, start: f.start, end: f.end, person: f.person, orderId: f.orderId, roomId: f.roomId, staffId: f.staffId })),
    cleaning: await require('./cleaning').presentMany(cl), todos: todos.map((t) => ({ id: t._id, title: t.title, due: t.due, repeat: t.repeat })),
    lowSupplies: sup.map((s) => ({ id: s._id, name: s.name, qty: s.qty, min: s.min, unit: s.unit })), openShift: shift ? { id: shift._id, startAt: iso(shift.startAt) } : null,
    peaks: peaks.map((p) => ({ id: p._id, name: p.name, from: p.from, to: p.to })), careDue: insight(ins.careDue), stale: insight(ins.stale), endOfLife: insight(ins.endOfLife),
  };
}
const insight = (ids) => ids.slice(0, 200);

module.exports = { home, remindersSource };
