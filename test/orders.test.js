const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

const { api, expectOk, expectErr, addDays } = h;
let s;
let w;

before(h.start);
after(h.stop);
beforeEach(async () => {
  await h.reset();
  s = await h.shop();
  w = await h.world(s.token);
});

const quote = (body) => api.post('orders/quote', { lines: [{ pieceId: w.p1.id }], ...body }, s.token);

test('quote: tiers, extra days, peak surcharge, deposit rules, missing price', async () => {
  const q3 = expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8) }));
  assert.equal(q3.days, 3);
  assert.equal(q3.rent, 800000);
  assert.equal(q3.deposit, 1000000); // 50% of the purchase price
  assert.equal(q3.hold, 240000); // 30%
  assert.equal(q3.grand, 800000);
  assert.equal(q3.payOnReceive, 800000 - 240000 + 1000000);

  assert.equal(expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(6) })).rent, 300000);
  assert.equal(expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(7) })).rent, 500000); // 300k + 1 extra day
  assert.equal(expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(13) })).rent, 1800000); // tier7 1.6M + 1 extra

  expectOk(await api.post('peaks', { name: 'Tết', from: addDays(4), to: addDays(6), kind: 'pct', value: 10 }, s.token), 201);
  const peak = expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8) }));
  assert.equal(peak.surcharge, 80000);
  assert.equal(peak.grand, 880000);

  expectOk(await api.post('deposit-rules', { pieceId: w.p1.id, kind: 'fixed', value: 500000 }, s.token), 201);
  assert.equal(expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8) })).deposit, 500000);

  const noPrice = expectOk(await api.post('styles', { code: 'X', name: 'Chưa giá' }, s.token), 201);
  const p = expectOk(await api.post('pieces', { code: 'X1', styleId: noPrice.id }, s.token), 201);
  const q = expectOk(await api.post('orders/quote', { receiveDate: addDays(5), dueDate: addDays(8), lines: [{ pieceId: p.id }] }, s.token));
  assert.equal(q.missingPrice, true);
  assert.equal(q.lines[0].priceMissing, true);
});

test('quote: bundle, special price (needs a reason), promo and automatic discount, tiers by price date', async () => {
  const b = expectOk(await api.post('bundles', { name: 'Combo', price: 700000 }, s.token), 201);
  const bq = expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8), bundleId: b.id }));
  assert.equal(bq.rent, 700000);
  assert.equal(bq.lines[0].unit, 700000);

  expectErr(await quote({ receiveDate: addDays(5), dueDate: addDays(8), specialRent: 100000 }), 422, 'comp_reason_required');
  const sp = expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8), specialRent: 100000, compReason: 'Bạn thân' }));
  assert.equal(sp.rent, 100000);
  assert.equal(sp.discount, 0);
  assert.equal(sp.normalRent, 800000);

  expectOk(await api.post('promos', { code: 'sale10', kind: 'pct', value: 10, minAmount: 500000 }, s.token), 201);
  expectOk(await api.post('discounts', { name: 'Từ 3 ngày', kind: 'amount', value: 50000, minDays: 3 }, s.token), 201);
  const d = expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8), promoCode: 'SALE10', customerId: w.cust.id }));
  assert.equal(d.discount, 80000 + 50000);
  assert.equal(d.grand, 800000 - 130000);
  const bad = expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(6), promoCode: 'SALE10' }));
  assert.equal(bad.promoError, 'min_amount');
  assert.equal(expectOk(await quote({ receiveDate: addDays(5), dueDate: addDays(8), promoCode: 'NOPE' })).promoError, 'not_found');
});

test('create: hold payment rule, status, piece held, conflicts with buffer day, force in warn mode', async () => {
  expectErr(await api.post('orders', h.orderBody(w, { paidNow: 0 }), s.token), 422, 'hold_payment_required');
  expectErr(await api.post('orders', { ...h.orderBody(w), lines: [] }, s.token), 422, 'no_lines');

  const o = expectOk(await api.post('orders', h.orderBody(w), s.token), 201);
  assert.match(o.code, /^RR\d{4}-001$/);
  assert.equal(o.status, 'reserved');
  assert.equal(o.grand, 800000);
  assert.equal(o.balance, 500000);
  assert.equal(o.lines[0].pieceCode, 'AD01-M');
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'held');
  assert.match(expectOk(await api.post('orders', h.orderBody(w, { lines: [{ pieceId: w.p2.id }] }), s.token), 201).code, /-002$/);

  // overlapping, and "buffer day" adjacent: receive on the day after the return still clashes (return +8, buffer 1 => +9)
  const clash = expectErr(await api.post('orders', h.orderBody(w, { receiveDate: addDays(9), dueDate: addDays(11) }), s.token), 409, 'booking_conflict');
  assert.equal(clash.data, w.p1.id);
  expectOk(await api.post('orders', h.orderBody(w, { receiveDate: addDays(10), dueDate: addDays(12) }), s.token), 201);
  // before it as well: due +4 + buffer = +5 clashes with receive +5
  expectErr(await api.post('orders', h.orderBody(w, { receiveDate: addDays(3), dueDate: addDays(4) }), s.token), 409, 'booking_conflict');

  expectErr(await api.post('orders', h.orderBody(w, { receiveDate: addDays(6), dueDate: addDays(7), forceConflict: true }), s.token), 409, 'booking_conflict');
  const rules = expectOk(await api.get('settings/rules', s.token));
  expectOk(await api.put('settings/rules', { ...rules, conflictMode: 'warn' }, s.token));
  expectOk(await api.post('orders', h.orderBody(w, { receiveDate: addDays(6), dueDate: addDays(7), forceConflict: true }), s.token), 201);
});

test('availability and piece calendar follow the bookings', async () => {
  expectOk(await api.post('orders', h.orderBody(w), s.token), 201);
  const free = expectOk(await api.get(`availability?from=${addDays(6)}&to=${addDays(7)}`, s.token));
  assert.deepEqual(free.items.map((i) => i.code), ['AD01-L']);
  assert.equal(free.items[0].price.day, 300000);
  const after = expectOk(await api.get(`availability?from=${addDays(10)}&to=${addDays(11)}&size=M`, s.token));
  assert.deepEqual(after.items.map((i) => i.code), ['AD01-M']);
  const exceptOwn = expectOk(await api.get(`availability?from=${addDays(6)}&to=${addDays(7)}&size=M`, s.token));
  assert.equal(exceptOwn.items.length, 0);

  const month = addDays(6).slice(0, 7);
  const cal = expectOk(await api.get(`pieces/${w.p1.id}/calendar?month=${month}`, s.token));
  const kinds = new Map(cal.items.map((x) => [x.date, x.kind]));
  assert.equal(kinds.get(addDays(6)), 'rent');
  const bookings = expectOk(await api.get(`pieces/${w.p1.id}/bookings`, s.token));
  assert.equal(bookings.items[0].kind, 'rent');
  assert.equal(bookings.items[0].end, addDays(9));
});

test('whole life of an order: pay, deliver, return, settle, laundry, revenue and points', async () => {
  const o = expectOk(await api.post('orders', h.orderBody(w), s.token), 201);
  const pay = (body, key) => api.post(`orders/${o.id}/payments`, body, s.token, key ? { 'Idempotency-Key': key } : undefined);

  // cannot hand over before everything is collected
  const short = expectErr(await api.post(`orders/${o.id}/deliver`, { collectRent: 0, collectDeposit: 0 }, s.token), 422, 'payment_incomplete');
  assert.deepEqual(short.data, { rentDue: 500000, depositDue: 1000000 });
  expectErr(await pay({ kind: 'rent', method: 'comp', amount: 1000 }), 422, 'comp_reason_required');
  expectErr(await pay({ kind: 'deposit', method: 'comp', amount: 1000, note: 'x' }), 400, 'validation_failed');
  const p1 = expectOk(await pay({ kind: 'rent', method: 'transfer', amount: 500000 }, 'k1'), 201);
  assert.equal(p1.order.status, 'paid');
  expectOk(await pay({ kind: 'rent', method: 'transfer', amount: 500000 }, 'k1'), 201); // replay
  assert.equal(expectOk(await api.get(`orders/${o.id}/payments`, s.token)).items.length, 2);
  expectErr(await pay({ kind: 'rent', method: 'cash', amount: 1 }, 'k1'), 422, 'idempotency_mismatch');

  const delivered = expectOk(await api.post(`orders/${o.id}/deliver`, { collectDeposit: 1000000, method: 'cash', receiver: 'An', conditionOut: { [o.lines[0].id]: 'Lành lặn' } }, s.token));
  assert.equal(delivered.status, 'delivered');
  assert.equal(delivered.lines[0].condOut, 'Lành lặn');
  assert.equal(delivered.depositHeld, 1000000);
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'rented');
  expectErr(await api.post(`orders/${o.id}/deliver`, { collectDeposit: 0 }, s.token), 422, 'invalid_transition');
  expectErr(await api.post(`orders/${o.id}/cancel`, {}, s.token), 422, 'invalid_transition');
  assert.equal(expectOk(await api.get('orders/outside', s.token)).items.length, 1);

  const returned = expectOk(await api.post(`orders/${o.id}/return`, { checks: { [o.lines[0].id]: { clean: false, damage: 'Rách nhẹ', decision: 'wash' } } }, s.token));
  assert.equal(returned.status, 'returned');
  assert.match(returned.lines[0].condIn, /Chưa sạch.*Rách nhẹ/);
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'wait_wash');
  const jobs = expectOk(await api.get('cleaning?open=true', s.token));
  assert.equal(jobs.items.length, 1);
  assert.equal(jobs.items[0].status, 'waiting');
  assert.equal(expectOk(await api.get(`pieces/${w.p1.id}/logs`, s.token)).items.length, 2);

  const settled = expectOk(await api.post(`orders/${o.id}/settle`, { fees: { damage: 300000 }, method: 'cash' }, s.token));
  assert.equal(settled.refund, 700000);
  assert.equal(settled.extra, 0);
  assert.equal(settled.order.status, 'completed');
  assert.equal(settled.order.settlement.total, 300000);
  assert.equal(settled.order.depositHeld, 0);
  expectErr(await api.post(`orders/${o.id}/settle`, { fees: {} }, s.token), 422, 'invalid_transition');

  // revenue = rent 800k + fee 300k (taken from the deposit); the deposit itself is never revenue
  const rev = expectOk(await api.get('reports/revenue?range=today', s.token));
  assert.equal(rev.revenue.current, 1100000);
  assert.equal(expectOk(await api.get('customers/' + w.cust.id, s.token)).points, 80);
  assert.equal(expectOk(await api.get('day-close', s.token)).deposits.receivedCash, 1000000);

  // laundry: the QC checklist gates "done"
  const item = expectOk(await api.post('checklists', { kind: 'qc', title: 'Đã ủi', sort: 1 }, s.token), 201);
  const job = jobs.items[0];
  expectOk(await api.post(`cleaning/${job.id}/move`, { status: 'washing' }, s.token));
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'washing');
  expectErr(await api.post(`cleaning/${job.id}/move`, { status: 'done' }, s.token), 422, 'qc_incomplete');
  expectOk(await api.put(`cleaning/${job.id}/qc`, { itemId: item.id, value: true }, s.token));
  expectOk(await api.post(`cleaning/${job.id}/move`, { status: 'done' }, s.token));
  const piece = expectOk(await api.get('pieces/' + w.p1.id, s.token));
  assert.equal(piece.status, 'ready');
  assert.equal(piece.washCount, 1);
  assert.ok(piece.lastCareAt);
  expectErr(await api.del('pieces/' + w.p1.id, undefined, s.token), 409, 'in_use');
});

test('partial return, lost piece, extra fee over the deposit', async () => {
  const o = expectOk(await api.post('orders', h.orderBody(w, { lines: [{ pieceId: w.p1.id }, { pieceId: w.p2.id }], paidNow: 1600000 }), s.token), 201);
  expectOk(await api.post(`orders/${o.id}/deliver`, { collectDeposit: 2000000 }, s.token));
  const [l1, l2] = o.lines;
  const first = expectOk(await api.post(`orders/${o.id}/return`, { checks: { [l1.id]: { decision: 'wash' } } }, s.token));
  assert.equal(first.status, 'delivered'); // one line is still out
  assert.equal(first.lines.find((l) => l.id === l2.id).status, 'out');
  expectErr(await api.post(`orders/${o.id}/return`, { checks: { [l1.id]: { decision: 'wash' } } }, s.token), 422, 'invalid_transition');
  const second = expectOk(await api.post(`orders/${o.id}/return`, { checks: { [l2.id]: { decision: 'lost' } } }, s.token));
  assert.equal(second.status, 'returned');
  assert.equal(second.lines.find((l) => l.id === l2.id).status, 'lost');
  assert.equal(expectOk(await api.get('pieces/' + w.p2.id, s.token)).status, 'retired');
  const done = expectOk(await api.post(`orders/${o.id}/settle`, { fees: { lostPiece: 2500000, wash: 100000 }, method: 'transfer' }, s.token));
  assert.equal(done.refund, 0);
  assert.equal(done.extra, 600000);
  const pays = expectOk(await api.get(`orders/${o.id}/payments`, s.token));
  assert.equal(pays.depositHeld, 0);
});

test('cancel: refund, deposit back, piece freed, points reversed; only before delivery', async () => {
  const o = expectOk(await api.post('orders', h.orderBody(w, { paidNow: 400000 }), s.token), 201);
  expectErr(await api.post(`orders/${o.id}/cancel`, { refund: 500000 }, s.token), 422, 'invalid');
  const c = expectOk(await api.post(`orders/${o.id}/cancel`, { refund: 300000, method: 'cash', reason: 'Khách đổi ý' }, s.token));
  assert.equal(c.status, 'cancelled');
  assert.equal(c.paidRent, 100000);
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'ready');
  expectErr(await api.post(`orders/${o.id}/cancel`, {}, s.token), 422, 'invalid_transition');
  // the piece is bookable again
  expectOk(await api.post('orders', h.orderBody(w), s.token), 201);
  const log = expectOk(await api.get('admin-log?action=cancel', s.token));
  assert.equal(log.items.length, 1);
});

test('counter rental: delivered at once, rent and deposit collected, comp keeps the deposit in cash', async () => {
  const o = expectOk(await api.post('orders', h.orderBody(w, { counter: true, paidNow: 0, receiveDate: addDays(0), dueDate: addDays(3) }), s.token), 201);
  assert.equal(o.status, 'delivered');
  assert.equal(o.source, 'counter');
  assert.equal(o.paidRent, 800000);
  assert.equal(o.depositHeld, 1000000);
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'rented');

  expectErr(await api.post('orders', h.orderBody(w, { counter: true, payMethod: 'comp', lines: [{ pieceId: w.p2.id }], receiveDate: addDays(0), dueDate: addDays(3) }), s.token), 422, 'comp_reason_required');
  const comp = expectOk(await api.post('orders', h.orderBody(w, { counter: true, payMethod: 'comp', compReason: 'Quà tặng', lines: [{ pieceId: w.p2.id }], receiveDate: addDays(0), dueDate: addDays(3) }), s.token), 201);
  const pays = expectOk(await api.get(`orders/${comp.id}/payments`, s.token)).items;
  assert.deepEqual(pays.map((p) => [p.kind, p.method]).sort(), [['deposit', 'cash'], ['rent', 'comp']]);
  const rev = expectOk(await api.get('reports/revenue?range=today', s.token));
  assert.equal(rev.revenue.current, 800000); // the comp order adds no revenue
  assert.equal(expectOk(await api.get('admin-log?action=comp_order', s.token)).items.length, 1);
});

test('idempotency: the same key creates one order', async () => {
  const key = { 'Idempotency-Key': 'create-1' };
  const a = expectOk(await api.post('orders', h.orderBody(w), s.token, key), 201);
  const b = expectOk(await api.post('orders', h.orderBody(w), s.token, key), 201);
  assert.equal(a.id, b.id);
  assert.equal(await h.models.Order.countDocuments({}), 1);
  expectErr(await api.post('orders', h.orderBody(w, { paidNow: 1 }), s.token, key), 422, 'idempotency_mismatch');
  // a failed call leaves no trace: the same key may be retried
  const k2 = { 'Idempotency-Key': 'create-2' };
  expectErr(await api.post('orders', h.orderBody(w, { paidNow: 0 }), s.token, k2), 422, 'hold_payment_required');
  expectErr(await api.post('orders', h.orderBody(w, { paidNow: 0 }), s.token, k2), 422, 'hold_payment_required');
});

test('change dates re-prices at the creation-day price list; swap and add line', async () => {
  const o = expectOk(await api.post('orders', h.orderBody(w, { paidNow: 800000 }), s.token), 201);
  assert.equal(o.status, 'paid');
  // a price rise after the order was made does not touch it
  expectOk(await api.post('prices', { styleId: w.style.id, day: 900000, from: addDays(1) }, s.token), 201);
  const ext = expectOk(await api.post(`orders/${o.id}/change-dates`, { from: addDays(5), to: addDays(13), reason: 'Gia hạn' }, s.token));
  assert.equal(ext.rent, 1800000);
  assert.equal(ext.diff, 1000000);
  assert.equal(ext.status, 'reserved'); // paid no longer covers the total
  assert.equal(ext.changes.length, 1);
  expectOk(await api.post('orders', h.orderBody(w, { lines: [{ pieceId: w.p2.id }], receiveDate: addDays(5), dueDate: addDays(8) }), s.token), 201);
  expectErr(await api.post(`orders/${o.id}/swap`.replace('/swap', '') + `/lines/${o.lines[0].id}/swap`, { newPieceId: w.p2.id }, s.token), 409, 'booking_conflict');
  expectErr(await api.post(`orders/${o.id}/change-dates`, { from: addDays(5), to: addDays(2) }, s.token), 422, 'invalid');

  const o2 = expectOk(await api.post('orders', h.orderBody(w, { receiveDate: addDays(30), dueDate: addDays(33) }), s.token), 201);
  const sw = expectOk(await api.post(`orders/${o2.id}/lines/${o2.lines[0].id}/swap`, { newPieceId: w.p2.id, reason: 'Khách đổi size' }, s.token));
  assert.equal(sw.lines[0].pieceCode, 'AD01-L');
  assert.equal(sw.diff, 0);
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'held'); // still held by the first order
  const add = expectOk(await api.post(`orders/${o2.id}/lines`, { pieceId: w.p1.id, person: 'Bình' }, s.token), 201);
  assert.equal(add.lines.length, 2);
  assert.equal(add.rent, 1600000);
  assert.equal(add.diff, 800000);
  const patched = expectOk(await api.patch(`orders/${o2.id}`, { note: 'Giao sớm', reason: 'Khách nhờ' }, s.token));
  assert.equal(patched.note, 'Giao sớm');
  assert.equal(patched.changes.at(-1).field, 'note');
});

test('holds: block the calendar, convert to an order, release with refund, expire', async () => {
  const hold = expectOk(await api.post('holds', { customerName: 'Chị Lan', phone: '0988777666', pieceId: w.p1.id, from: addDays(5), to: addDays(8), amount: 200000, method: 'cash' }, s.token), 201);
  assert.equal(hold.status, 'active');
  assert.equal(expectOk(await api.get('pieces/' + w.p1.id, s.token)).status, 'held');
  expectErr(await api.post('holds', { customerName: 'X', pieceId: w.p1.id, from: addDays(6), to: addDays(7), amount: 1000 }, s.token), 409, 'booking_conflict');
  expectErr(await api.post('holds', { customerName: 'X', pieceId: w.p2.id, from: addDays(6), to: addDays(7), amount: 0 }, s.token), 422, 'hold_payment_required');

  const conv = expectOk(await api.post('orders', h.orderBody(w, { customerId: undefined, customerName: 'Chị Lan', phone: '0988 777 666', paidNow: 0, holdId: hold.id }), s.token), 201);
  assert.equal(conv.holdAmount, 200000);
  assert.equal(conv.status, 'reserved');
  assert.equal(conv.customer.name, 'Chị Lan'); // found by phone, not duplicated
  assert.equal(await h.models.Customer.countDocuments({ name: 'Chị Lan' }), 1);
  assert.equal(expectOk(await api.get(`holds/${hold.id}`, s.token)).status, 'converted');
  assert.equal(expectOk(await api.get(`orders/${conv.id}/payments`, s.token)).paidRent, 200000);

  const h2 = expectOk(await api.post('holds', { customerName: 'Anh Bình', pieceId: w.p2.id, from: addDays(5), to: addDays(6), amount: 100000, method: 'transfer' }, s.token), 201);
  const rel = expectOk(await api.post(`holds/${h2.id}/release`, { refund: 50000, method: 'transfer' }, s.token));
  assert.equal(rel.status, 'released');
  assert.equal(expectOk(await api.get('pieces/' + w.p2.id, s.token)).status, 'ready');

  const h3 = expectOk(await api.post('holds', { customerName: 'Cô Mai', pieceId: w.p2.id, from: addDays(20), to: addDays(21), amount: 100000, until: new Date(Date.now() + 60000).toISOString() }, s.token), 201);
  await h.models.Hold.updateOne({ _id: h3.id }, { $set: { until: new Date(Date.now() - 1000) } });
  expectOk(await api.get('jobs/run'));
  assert.equal(expectOk(await api.get(`holds/${h3.id}`, s.token)).status, 'expired');
  assert.equal(expectOk(await api.get('pieces/' + w.p2.id, s.token)).status, 'ready');
  assert.equal(expectOk(await api.get('admin-log?action=auto_expire', s.token)).items[0].by, 'system');
});

test('shifts and cash book: expected cash, one open shift', async () => {
  expectErr(await api.post('shifts/close', { counted: 0 }, s.token), 422, 'shift_required');
  expectOk(await api.post('shifts/open', { startCash: 500000 }, s.token), 201);
  expectErr(await api.post('shifts/open', { startCash: 1 }, s.token), 409, 'shift_open');
  const o = expectOk(await api.post('orders', h.orderBody(w, { counter: true, paidNow: 0, receiveDate: addDays(0), dueDate: addDays(3) }), s.token), 201);
  expectOk(await api.post('cash', { type: 'out', amount: 50000, reason: 'Mua túi' }, s.token), 201);
  const cur = expectOk(await api.get('shifts/current', s.token)).shift;
  assert.equal(cur.expected, 500000 + 800000 + 1000000 - 50000);
  const closed = expectOk(await api.post('shifts/close', { counted: 2200000, note: 'Thiếu 50k' }, s.token));
  assert.equal(closed.expected, 2250000);
  assert.equal(closed.diff, -50000);
  assert.equal(closed.status, 'closed');
  void o;
});

test('home, reports, search', async () => {
  const o = expectOk(await api.post('orders', h.orderBody(w, { counter: true, paidNow: 0, receiveDate: addDays(0), dueDate: addDays(-1 + 1) }), s.token), 201);
  void o;
  const home = expectOk(await api.get('home', s.token));
  assert.equal(home.revenue.current, 300000);
  assert.equal(home.ordersCreated, 1);
  assert.equal(home.buckets.length, 7);
  assert.equal(home.styleRanking[0].count, 1);
  assert.equal(home.rack.rented, 1);
  assert.equal(home.depositsHeld, 1000000);
  assert.equal(home.dayLoad.overloaded, false);
  const day = expectOk(await api.get('home?range=today', s.token));
  assert.equal(day.buckets.length, 24);
  assert.equal(expectOk(await api.get('home?range=custom&from=2020-01-01&to=2020-01-10', s.token)).buckets.length, 10);
  expectErr(await api.get('home?range=zzz', s.token), 400, 'validation_failed');
  assert.ok(expectOk(await api.get('reports/occupancy?range=d7', s.token)).rate > 0);
  assert.ok(expectOk(await api.get('reports/economics', s.token)).items.length);
  assert.equal(expectOk(await api.get('reports/forecast', s.token)).forecast, null);

  const hits = (q) => api.get(`search?q=${encodeURIComponent(q)}`, s.token).then((r) => r.body.items.map((i) => i.kind).sort().join());
  assert.equal(await hits('nguyen van an'), 'customer,order');
  assert.equal(await hits('AD01'), 'piece,piece,style');
  assert.equal(await hits('0912 345'), 'customer');
  expectErr(await api.get('search?q=a', s.token), 400, 'validation_failed');
});

test('catalog: duplicate codes, in-use deletes, client ids, If-Match, tombstones and sync, CSV import', async () => {
  expectErr(await api.post('styles', { code: 'AD01', name: 'Trùng' }, s.token), 409, 'duplicate_code');
  expectErr(await api.del('styles/' + w.style.id, undefined, s.token), 409, 'in_use');
  expectErr(await api.del('categories/' + w.cat.id, undefined, s.token), 409, 'in_use');
  const mine = expectOk(await api.post('rooms', { id: 'room-1', name: 'Phòng 1' }, s.token), 201);
  assert.equal(mine.id, 'room-1');
  assert.equal((await api.post('rooms', { id: 'room-1', name: 'Phòng 1' }, s.token)).status, 200); // safe retry

  const fresh = expectOk(await api.get('rooms/room-1', s.token));
  expectOk(await api.patch('rooms/room-1', { name: 'Phòng A' }, s.token, { 'If-Match': fresh.updatedAt }));
  const stale = expectErr(await api.patch('rooms/room-1', { name: 'Phòng B' }, s.token, { 'If-Match': fresh.updatedAt }), 409, 'conflict');
  assert.equal(stale.current.name, 'Phòng A');

  const since = new Date().toISOString();
  assert.equal((await api.del('rooms/room-1', undefined, s.token)).status, 204);
  const sync = expectOk(await api.get(`sync?since=${encodeURIComponent(since)}`, s.token));
  assert.deepEqual(sync.deleted.map((d) => [d.resource, d.id]), [['rooms', 'room-1']]);
  assert.equal(expectOk(await api.get('sync', s.token)).changes.pieces.length, 2);

  const prev = expectOk(await api.post('import/pieces/preview', { rows: [{ code: 'N1', styleCode: 'AD01', size: 'S' }, { code: 'AD01-M', styleCode: 'AD01' }, { code: 'N3', styleCode: 'KHONGCO' }, { code: 'N1', styleCode: 'AD01' }] }, s.token));
  assert.deepEqual(prev.results.map((r) => r.ok), [true, false, false, false]);
  const commit = expectOk(await api.post('import/pieces/commit', { rows: [{ code: 'N1', styleCode: 'AD01', size: 'S' }] }, s.token));
  assert.equal(commit.created, 1);
  assert.equal(expectOk(await api.get('pieces?q=n1', s.token)).total, 1);
});

test('piece status rules, dispose, care, purchase, supplies, todos, fittings', async () => {
  expectOk(await api.post(`pieces/${w.p1.id}/status`, { status: 'repair' }, s.token));
  expectOk(await api.post(`pieces/${w.p1.id}/status`, { status: 'ready' }, s.token));
  await h.models.Piece.updateOne({ _id: w.p1.id }, { $set: { status: 'rented' } });
  expectErr(await api.post(`pieces/${w.p1.id}/status`, { status: 'ready' }, s.token), 422, 'invalid_transition');
  expectOk(await api.post(`pieces/${w.p2.id}/care`, { note: 'Hấp hơi' }, s.token));
  const d = expectOk(await api.post(`pieces/${w.p2.id}/dispose`, { kind: 'sold', price: 500000, reason: 'Cũ' }, s.token));
  assert.equal(d.status, 'disposed');
  expectErr(await api.post(`pieces/${w.p2.id}/status`, { status: 'ready' }, s.token), 422, 'invalid_transition');

  const sup = expectOk(await api.post('suppliers', { name: 'Xưởng may' }, s.token), 201);
  const bought = expectOk(await api.post('purchases', { supplierId: sup.id, cost: 1500000, date: addDays(0), piece: { code: 'NEW1', styleId: w.style.id, size: 'S' } }, s.token), 201);
  assert.equal(bought.piece.purchasePrice, 1500000);
  expectErr(await api.post('purchases', { cost: 1, date: addDays(0), piece: { code: 'NEW1', styleId: w.style.id } }, s.token), 409, 'duplicate_code');

  const item = expectOk(await api.post('supplies', { name: 'Túi', unit: 'cái', min: 10 }, s.token), 201);
  expectOk(await api.post(`supplies/${item.id}/move`, { type: 'in', qty: 25 }, s.token));
  assert.equal(expectOk(await api.post(`supplies/${item.id}/move`, { type: 'out', qty: 20 }, s.token)).low, true);
  expectErr(await api.post(`supplies/${item.id}/move`, { type: 'out', qty: 99 }, s.token), 422, 'invalid');
  assert.equal(expectOk(await api.get('home', s.token)).attention.lowSupplies, 1);

  const todo = expectOk(await api.post('todos', { title: 'Giặt rèm', due: '2026-01-31', repeat: 'monthly' }, s.token), 201);
  assert.equal(expectOk(await api.post(`todos/${todo.id}/complete`, {}, s.token)).due, '2026-02-28');
  const once = expectOk(await api.post('todos', { title: 'Một lần' }, s.token), 201);
  assert.equal(expectOk(await api.post(`todos/${once.id}/complete`, {}, s.token)).done, true);

  const room = expectOk(await api.post('rooms', { name: 'P1' }, s.token), 201);
  const day = addDays(3);
  const fit = (extra) => api.post('fittings', { date: day, start: 600, end: 630, roomId: room.id, person: 'An', ...extra }, s.token);
  expectOk(await fit({ pieceId: w.p1.id, customerId: w.cust.id }), 201);
  expectErr(await fit({ start: 620, end: 650 }), 409, 'room_busy');
  expectOk(await fit({ start: 630, end: 660 }), 201);
  expectOk(await api.post('closed-dates', { date: addDays(4) }, s.token), 201);
  expectErr(await api.post('fittings', { date: addDays(4), start: 600, end: 630 }, s.token), 409, 'shop_closed');
  const first = expectOk(await api.get(`fittings?date=${day}`, s.token)).items.find((f) => f.pieceId === w.p1.id);
  expectOk(await api.patch(`fittings/${first.id}`, { status: 'done', result: 'fit' }, s.token));
  const memory = expectOk(await api.get(`fit-memory?customerId=${w.cust.id}`, s.token));
  assert.equal(memory.items.length, 1);
  const avail = expectOk(await api.get(`availability?from=${addDays(20)}&to=${addDays(21)}&customerId=${w.cust.id}`, s.token));
  assert.equal(avail.items[0].fitted, true);
});

test('customers: merge duplicates; shops cannot see each other\'s orders', async () => {
  const dup = expectOk(await api.post('customers', { name: 'An (trùng)', phone: '0912345678', tags: ['regular'] }, s.token), 201);
  const o = expectOk(await api.post('orders', h.orderBody(w, { customerId: dup.id }), s.token), 201);
  const merged = expectOk(await api.post(`customers/${w.cust.id}/merge`, { otherIds: [dup.id] }, s.token));
  assert.ok(merged.tags.includes('regular'));
  assert.equal(expectOk(await api.get(`orders/${o.id}`, s.token)).customerId, w.cust.id);
  expectErr(await api.get(`customers/${dup.id}`, s.token), 404, 'not_found');
  assert.equal(expectOk(await api.get(`customers/${w.cust.id}/orders`, s.token)).items.length, 1);

  const other = await h.shop('khac@tiem.test', 'Tiệm Khác');
  expectErr(await api.get(`orders/${o.id}`, other.token), 404, 'not_found');
  expectErr(await api.post(`orders/${o.id}/cancel`, {}, other.token), 404, 'not_found');
  assert.equal(expectOk(await api.get('orders', other.token)).total, 0);
  expectErr(await api.get(`customers/${w.cust.id}`, other.token), 404, 'not_found');
});

test('concurrent bookings of the same piece: exactly one wins', async () => {
  const make = (n) => api.post('orders', h.orderBody(w, { note: `req ${n}` }), s.token);
  const results = await Promise.all([make(1), make(2), make(3), make(4)]);
  const codes = results.map((r) => r.status).sort();
  assert.deepEqual(codes, [201, 409, 409, 409], JSON.stringify(results.map((r) => r.body.code || 'ok')));
  assert.equal(await h.models.Order.countDocuments({}), 1);
  // order codes stay unique and gap-free per month under parallel creation of different pieces
  const two = await Promise.all([api.post('orders', h.orderBody(w, { lines: [{ pieceId: w.p2.id }] }), s.token), api.post('orders', h.orderBody(w, { receiveDate: addDays(40), dueDate: addDays(41) }), s.token)]);
  assert.deepEqual(two.map((r) => r.status), [201, 201]);
  assert.equal(new Set((await h.models.Order.find({}).lean()).map((o) => o.code)).size, 3);
});
