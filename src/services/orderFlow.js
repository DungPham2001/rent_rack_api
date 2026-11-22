/**
 * Rental orders, part 2: payments, delivery, return, settlement, cancel and edits (spec 5.5-5.9).
 *
 *   reserved --(paid in full)--> paid --deliver--> delivered --return--> returned --settle--> completed
 *       \_____________ cancel (only before delivery) _______________> cancelled
 *
 * Every command runs in one transaction and moves the order with a conditional update on its current status, so a
 * double tap or two admins cannot apply the same step twice.
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const pricing = require('./pricing');
const schedule = require('./schedule');
const ledger = require('./ledger');
const pieceState = require('./pieceState');
const orders = require('./orders');
const audit = require('./audit');
const { FEE_KINDS } = require('../resources/defs');
const { Checker, isObj } = require('../lib/validate');
const { withTx } = require('../lib/tx');
const { AppError, notFound } = require('../lib/errors');
const { uuid } = require('../lib/util');
const T = require('../lib/time');

const M = (name) => mongoose.model(name);
const { opt, grandOf } = orders;
const transition = () => new AppError(422, 'invalid_transition');

/** Moves `id` from one of `from` statuses with extra `$set`; 422 invalid_transition when the status is not as expected. */
async function advance(id, from, set, session, extra = {}) {
  const r = await M('Order').updateOne({ _id: id, status: { $in: [].concat(from) } }, { $set: { ...set, updatedAt: new Date() }, ...extra }, opt(session));
  if (!r.matchedCount) throw transition();
}

const addChange = (auth, change) => ({ at: new Date(), by: auth.accountId, byName: auth.account?.name || '', ...change });

// ---------- payments ----------

/** GET /orders/:id/payments */
async function payments(orderId) {
  await orders.load(orderId);
  const rows = await M('Payment').find({ orderId }).sort({ at: 1 }).lean();
  const led = ledger.paidRent(rows);
  return { items: rows.map(ledger.present), paidRent: led, depositHeld: ledger.depositHeld(rows) };
}

/** POST /orders/:id/payments { kind, method, amount, note } (Idempotency-Key) */
async function addPayment(auth, orderId, body) {
  const p = { kind: body?.kind, method: body?.method, amount: body?.amount, note: typeof body?.note === 'string' ? body.note : '' };
  ledger.assertValid(p);
  const out = await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (o.status === 'cancelled' || o.status === 'expired') throw transition();
    const led = await ledger.forOrder(orderId, session);
    if (p.kind === 'refund' && p.amount > led.paidRentReal) throw new AppError(422, 'invalid', { fields: [{ field: 'amount', code: 'exceeds_paid' }] });
    if ((p.kind === 'deposit_refund' || (p.kind === 'fee' && p.method === 'deposit')) && p.amount > led.depositHeld) throw new AppError(422, 'invalid', { fields: [{ field: 'amount', code: 'exceeds_deposit' }] });
    const doc = ledger.make({ orderId, ...p }, auth);
    await M('Payment').create([doc], opt(session));
    const paid = led.paidRent + (p.kind === 'hold' || p.kind === 'rent' ? p.amount : p.kind === 'refund' ? -p.amount : 0);
    const grand = grandOf(o);
    if (o.status === 'reserved' && paid >= grand) await advance(orderId, 'reserved', { status: 'paid' }, session);
    else if (o.status === 'paid' && paid < grand) await advance(orderId, 'paid', { status: 'reserved' }, session);
    return doc;
  });
  if (p.method === 'comp') await audit.log(auth, 'orders', orderId, 'comp_payment', `${p.kind} ${p.amount}: ${p.note}`);
  if (p.kind === 'refund') await audit.log(auth, 'orders', orderId, 'refund', `${p.amount} ${p.method}: ${p.note}`);
  return { status: 201, body: { payment: ledger.present(out), order: await orders.get(orderId) } };
}

// ---------- deliver ----------

/** POST /orders/:id/deliver (Idempotency-Key). Nothing is left owing: rent and deposit are collected first. */
async function deliver(auth, orderId, body) {
  const c = new Checker();
  const d = {
    receiver: c.str(body, 'receiver', { max: 100 }) || '', collectRent: c.money(body, 'collectRent') || 0, collectDeposit: c.money(body, 'collectDeposit') || 0,
    method: c.oneOf(body, 'method', ['cash', 'transfer', 'comp'], { def: 'cash' }), mode: c.oneOf(body, 'mode', ['store', 'delivery']), address: c.str(body, 'address', { max: 300 }),
    fee: c.money(body, 'fee'), staffId: c.id(body, 'staffId'), note: c.str(body, 'note', { max: 500 }) || '',
  };
  const cond = isObj(body?.conditionOut) ? body.conditionOut : {};
  c.done();
  const S = await settings.ctx();
  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (!['reserved', 'paid'].includes(o.status)) throw transition();
    if (d.method === 'comp' && d.collectRent > 0 && !d.note) throw new AppError(422, 'comp_reason_required');
    const set = {};
    if (d.mode) { set.receiveMode = d.mode; if (d.address !== undefined) set.receiveAddr = d.address; if (d.fee !== undefined) set.receiveFee = d.mode === 'delivery' ? d.fee : 0; }
    const grand = grandOf({ ...o, ...set });
    const led = await ledger.forOrder(orderId, session);
    if (led.paidRent + d.collectRent < grand || led.depositHeld + d.collectDeposit < o.deposit) {
      throw new AppError(422, 'payment_incomplete', { data: { rentDue: Math.max(0, grand - led.paidRent), depositDue: Math.max(0, o.deposit - led.depositHeld) } });
    }
    const pieces = await M('Piece').find({ _id: { $in: o.lines.map((l) => l.pieceId) } }).session(session || null).lean();
    if (!S.rules.allowNotReady) for (const p of pieces) if (!['ready', 'held'].includes(p.status)) throw new AppError(409, 'piece_not_ready', { data: p._id });
    const pays = [];
    if (d.collectRent > 0) pays.push(ledger.make({ orderId, kind: 'rent', method: d.method, amount: d.collectRent, note: d.note }, auth));
    if (d.collectDeposit > 0) pays.push(ledger.make({ orderId, kind: 'deposit', method: d.method === 'comp' ? 'cash' : d.method, amount: d.collectDeposit }, auth));
    if (pays.length) await M('Payment').insertMany(pays, opt(session));
    const now = new Date();
    const lines = o.lines.map((l) => ({ ...l, condOut: typeof cond[l.id] === 'string' ? cond[l.id].slice(0, 300) : l.condOut }));
    await advance(orderId, ['reserved', 'paid'], { ...set, status: 'delivered', deliveredAt: now, lines }, session);
    await M('Delivery').create([{ _id: uuid(), orderId, kind: 'out', receiver: d.receiver, mode: d.mode || o.receiveMode, address: d.address ?? o.receiveAddr, fee: d.fee ?? o.receiveFee, staffId: d.staffId || null, condition: cond, note: d.note, at: now, by: auth.accountId }], opt(session));
    await pieceState.setStatus(o.lines.map((l) => l.pieceId), 'rented', { session });
  });
  if (d.method === 'comp' && d.collectRent > 0) await audit.log(auth, 'orders', orderId, 'comp_payment', `rent ${d.collectRent}: ${d.note}`);
  return { status: 200, body: await orders.get(orderId) };
}

// ---------- return ----------

const DECISIONS = ['wash', 'repair', 'retire', 'lost'];

/** POST /orders/:id/return { checks: { lineId: { clean, damage, missing, decision } }, accReturns, staffId } (Idempotency-Key) */
async function receiveReturn(auth, orderId, body) {
  const checks = isObj(body?.checks) ? body.checks : null;
  if (!checks || !Object.keys(checks).length) throw new AppError(400, 'validation_failed', { fields: [{ field: 'checks', code: 'required' }] });
  const accReturns = isObj(body?.accReturns) ? body.accReturns : {};
  const staffId = typeof body?.staffId === 'string' ? body.staffId : null;
  const S = await settings.ctx();
  const dueAtOf = () => T.localToUtc(T.addDays(S.today, Math.max(1, S.rules.bufferDays)), '23:59', S.tz);

  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (o.status !== 'delivered') throw transition();
    const now = new Date();
    const lines = o.lines.map((l) => ({ ...l }));
    const done = [];
    for (const [lineId, ck] of Object.entries(checks)) {
      const l = lines.find((x) => x.id === lineId);
      if (!l || l.status !== 'out' || !isObj(ck)) throw new AppError(422, 'invalid_transition', { data: lineId });
      const decision = DECISIONS.includes(ck.decision) ? ck.decision : 'wash';
      const damage = typeof ck.damage === 'string' ? ck.damage.slice(0, 300) : '';
      const missing = typeof ck.missing === 'string' ? ck.missing.slice(0, 300) : '';
      const clean = ck.clean !== false;
      l.status = decision === 'lost' ? 'lost' : 'returned';
      l.returnedAt = now;
      l.condIn = [!clean && 'Chưa sạch', damage && `Hư hỏng: ${damage}`, missing && `Thiếu: ${missing}`].filter(Boolean).join('; ');
      done.push({ lineId, pieceId: l.pieceId, decision, clean, damage, missing });

      const pid = l.pieceId;
      if (decision === 'wash' || decision === 'repair') {
        const open = await M('Cleaning').exists({ pieceId: pid, status: { $ne: 'done' } }).session(session || null);
        if (!open) {
          await M('Cleaning').create([{
            _id: uuid(), pieceId: pid, kind: decision === 'repair' ? 'repair' : 'dry', status: decision === 'repair' ? 'repairing' : 'waiting', staffId, startedAt: now, dueAt: dueAtOf(),
            orderId, returnedAt: now, qc: {}, createdAt: now, updatedAt: now,
          }], opt(session));
        }
        await pieceState.setStatus(pid, decision === 'repair' ? 'repair' : 'wait_wash', { session });
      } else {
        await pieceState.setStatus(pid, 'retired', { session });
        if (decision === 'lost') await pieceState.log(pid, 'lost', `Mất khi thuê ${o.code}`, { orderId, by: auth.accountId, session });
      }
      if (!clean) await pieceState.log(pid, 'dirty', 'Trả về chưa sạch', { orderId, by: auth.accountId, session });
      if (damage) await pieceState.log(pid, 'damage', damage, { orderId, by: auth.accountId, session });
      if (missing) await pieceState.log(pid, 'missing', missing, { orderId, by: auth.accountId, session });
    }
    const acc = (o.acc || []).map((a) => ({ ...a }));
    for (const [accessoryId, r] of Object.entries(accReturns)) {
      const a = acc.find((x) => x.accessoryId === accessoryId);
      if (!a || !isObj(r)) throw new AppError(422, 'invalid', { fields: [{ field: `accReturns.${accessoryId}`, code: 'unknown_accessory' }] });
      const ret = Math.max(0, Math.floor(Number(r.returned) || 0));
      const lost = Math.max(0, Math.floor(Number(r.lost) || 0));
      if (a.returned + a.lost + ret + lost > a.qty) throw new AppError(422, 'invalid', { fields: [{ field: `accReturns.${accessoryId}`, code: 'exceeds_qty' }] });
      a.returned += ret;
      a.lost += lost;
      if (lost) await pieceState.log(o.lines[0].pieceId, 'lost', `Mất phụ kiện ${a.name} x${lost} (${o.code})`, { orderId, by: auth.accountId, session });
    }
    const allBack = lines.every((l) => l.status !== 'out');
    const lateDays = Math.max(0, T.diffDays(o.dueDate, S.today));
    await advance(orderId, 'delivered', { lines, acc, ...(allBack ? { status: 'returned', returnedAt: now } : {}) }, session);
    await M('Return').create([{ _id: uuid(), orderId, lines: done, lateDays, staffId, at: now, by: auth.accountId }], opt(session));
    await M('Delivery').create([{ _id: uuid(), orderId, kind: 'in', receiver: '', mode: o.returnMode, address: o.returnAddr, fee: o.returnFee, staffId, condition: Object.fromEntries(done.map((x) => [x.lineId, [x.damage, x.missing].filter(Boolean).join('; ')])), note: '', at: now, by: auth.accountId }], opt(session));
  });
  return { status: 200, body: await orders.get(orderId) };
}

// ---------- settle ----------

/** POST /orders/:id/settle { fees: { kind: amount }, method, note } (Idempotency-Key) -> { refund, extra, order } */
async function settle(auth, orderId, body) {
  const feesIn = isObj(body?.fees) ? body.fees : {};
  const fees = {};
  for (const [k, v] of Object.entries(feesIn)) {
    if (!FEE_KINDS.includes(k) || !Number.isInteger(v) || v < 0 || v > 1e10) throw new AppError(400, 'validation_failed', { fields: [{ field: `fees.${k}`, code: 'invalid_type' }] });
    if (v > 0) fees[k] = v;
  }
  const method = body?.method === 'transfer' ? 'transfer' : 'cash';
  const note = typeof body?.note === 'string' ? body.note.slice(0, 500) : '';
  const S = await settings.ctx();
  const result = await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (o.status !== 'returned') throw transition();
    const led = await ledger.forOrder(orderId, session);
    const total = Object.values(fees).reduce((a, b) => a + b, 0);
    const dep = Math.max(0, led.depositHeld);
    const fromDeposit = Math.min(total, dep);
    const refund = dep - fromDeposit;
    const extra = total - fromDeposit;
    const feeNote = Object.entries(fees).map(([k, v]) => `${k}: ${v}`).join(', ');
    const pays = [];
    if (fromDeposit > 0) pays.push(ledger.make({ orderId, kind: 'fee', method: 'deposit', amount: fromDeposit, note: feeNote }, auth));
    if (extra > 0) pays.push(ledger.make({ orderId, kind: 'fee', method, amount: extra, note: feeNote }, auth));
    if (refund > 0) pays.push(ledger.make({ orderId, kind: 'deposit_refund', method, amount: refund, note }, auth));
    if (pays.length) await M('Payment').insertMany(pays, opt(session));
    const now = new Date();
    await advance(orderId, 'returned', { status: 'completed', settlement: { fees, total, deposit: dep, fromDeposit, refund, extra, method, at: now, note } }, session);
    const grand = grandOf(o);
    if (S.loyalty.per > 0 && !require('./customers').isComp(o) && grand >= S.loyalty.per) {
      await M('Loyalty').create([{ _id: uuid(), customerId: o.customerId, points: Math.floor(grand / S.loyalty.per), reason: 'order', refId: orderId, at: now }], opt(session));
    }
    await M('Alteration').updateMany({ orderId, revertNeeded: true, revertDone: false }, { $set: { revertDue: S.today, updatedAt: now } }, opt(session));
    return { refund, extra };
  });
  return { status: 200, body: { ...result, order: await orders.get(orderId) } };
}

// ---------- cancel ----------

/** POST /orders/:id/cancel { refund, method, reason, refundTo } (Idempotency-Key): only before delivery. */
async function cancel(auth, orderId, body) {
  const refund = body?.refund === undefined ? 0 : body.refund;
  const method = body?.method === 'transfer' ? 'transfer' : 'cash';
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 500) : '';
  const refundTo = typeof body?.refundTo === 'string' ? body.refundTo.slice(0, 300) : '';
  if (!Number.isInteger(refund) || refund < 0) throw new AppError(400, 'validation_failed', { fields: [{ field: 'refund', code: 'out_of_range' }] });
  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (!['reserved', 'paid'].includes(o.status)) throw transition();
    const led = await ledger.forOrder(orderId, session);
    if (refund > led.paidRentReal) throw new AppError(422, 'invalid', { fields: [{ field: 'refund', code: 'exceeds_paid' }] });
    const now = new Date();
    const pays = [];
    if (refund > 0) pays.push(ledger.make({ orderId, kind: 'refund', method, amount: refund, note: [reason, refundTo].filter(Boolean).join(' | ') }, auth));
    if (led.depositHeld > 0) pays.push(ledger.make({ orderId, kind: 'deposit_refund', method, amount: led.depositHeld, note: refundTo }, auth));
    if (pays.length) await M('Payment').insertMany(pays, opt(session));
    await advance(orderId, ['reserved', 'paid'], { status: 'cancelled', cancelInfo: { at: now, by: auth.accountId, reason, refund, refundTo, method } }, session);
    for (const l of o.lines) await pieceState.releaseIfFree(l.pieceId, { exceptOrder: orderId, session });
    // reverse the points of this order (redeemed points come back)
    const rows = await M('Loyalty').find({ refId: orderId }).session(session || null).lean();
    const net = rows.reduce((t, r) => t + r.points, 0);
    if (net !== 0) await M('Loyalty').create([{ _id: uuid(), customerId: o.customerId, points: -net, reason: 'cancel', refId: orderId, at: now }], opt(session));
    if (o.promoCode) await M('Promo').updateOne({ code: o.promoCode, used: { $gt: 0 } }, { $inc: { used: -1 } }, opt(session));
  });
  await audit.log(auth, 'orders', orderId, 'cancel', `refund ${refund}${reason ? `: ${reason}` : ''}`);
  return { status: 200, body: await orders.get(orderId) };
}

// ---------- edits that re-price ----------

/**
 * Re-prices the order for a change of dates / pieces: prices as of the order's creation date, the discount stays as it
 * was (capped at rent + surcharge). Once delivered the deposit does not change. Returns the saved order and the money diff
 * (> 0: collect more, < 0: refund).
 */
async function reprice(auth, o, patch, change, session) {
  const S = await settings.ctx();
  const draftLines = patch.lines || o.lines.map((l) => ({ pieceId: l.pieceId, person: l.person }));
  const q = await pricing.quote({
    receiveDate: patch.receiveDate || o.receiveDate, dueDate: patch.dueDate || o.dueDate, lines: draftLines, bundleId: o.bundleId, specialRent: o.specialRent, compReason: o.compReason,
    receiveMode: patch.receiveMode ?? o.receiveMode, returnMode: patch.returnMode ?? o.returnMode, receiveFee: patch.receiveFee ?? o.receiveFee, returnFee: patch.returnFee ?? o.returnFee, zoneId: o.zoneId,
  }, { priceDate: S.localDate(o.createdAt), keepDiscount: o.discount });
  if (q.missingPrice && o.specialRent === null && !o.bundleId) throw new AppError(422, 'price_missing');
  const keepDeposit = ['delivered', 'returned'].includes(o.status);
  const byPiece = new Map(o.lines.map((l) => [l.pieceId, l]));
  const pieces = await M('Piece').find({ _id: { $in: draftLines.map((l) => l.pieceId) } }).session(session || null).lean();
  const styles = await M('Style').find({ _id: { $in: pieces.map((p) => p.styleId) } }).lean();
  const pm = new Map(pieces.map((p) => [p._id, p]));
  const sm = new Map(styles.map((s) => [s._id, s]));
  const from = patch.receiveDate || o.receiveDate;
  const to = patch.dueDate || o.dueDate;
  const lines = q.lines.map((l) => {
    const old = byPiece.get(l.pieceId);
    return {
      id: old?.id || uuid(), person: l.person, styleId: l.styleId, styleName: sm.get(l.styleId)?.name || '', pieceId: l.pieceId, pieceCode: pm.get(l.pieceId)?.code || '', size: l.size,
      from, to, unit: l.unit, surcharge: l.surcharge, deposit: keepDeposit && old ? old.deposit : l.deposit, condOut: old?.condOut || '', condIn: old?.condIn || '', status: old?.status || 'out', returnedAt: old?.returnedAt || null,
    };
  });
  const next = {
    ...o, receiveDate: from, dueDate: to, receiveMode: patch.receiveMode ?? o.receiveMode, returnMode: patch.returnMode ?? o.returnMode,
    rent: q.rent, normalRent: q.normalRent, surcharge: q.surcharge, discount: q.discount, receiveFee: q.receiveFee, returnFee: q.returnFee, deposit: keepDeposit ? o.deposit : q.deposit, lines,
  };
  const diff = grandOf(next) - grandOf(o);
  const led = await ledger.forOrder(o._id, session);
  const status = o.status === 'paid' && led.paidRent < grandOf(next) ? 'reserved' : o.status === 'reserved' && led.paidRent >= grandOf(next) ? 'paid' : o.status;
  const set = {
    receiveDate: from, dueDate: to, receiveMode: next.receiveMode, returnMode: next.returnMode, rent: q.rent, normalRent: q.normalRent, surcharge: q.surcharge, discount: q.discount,
    receiveFee: q.receiveFee, returnFee: q.returnFee, deposit: next.deposit, lines, status, payOnReceive: Math.max(0, grandOf(next) - o.holdAmount) + next.deposit,
  };
  await M('Order').updateOne({ _id: o._id }, { $set: { ...set, updatedAt: new Date() }, $push: { changes: addChange(auth, { ...change, diff }) } }, opt(session));
  return { diff, lines, set };
}

/** POST /orders/:id/change-dates { from, to, reason }: extend or move. A delivered order keeps its receive date. */
async function changeDates(auth, orderId, body) {
  const c = new Checker();
  const from = c.date(body, 'from', { required: true });
  const to = c.date(body, 'to', { required: true });
  const reason = c.str(body, 'reason', { max: 300 }) || '';
  c.done();
  if (to < from) throw new AppError(422, 'invalid', { fields: [{ field: 'to', code: 'before_from' }] });
  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (!['reserved', 'paid', 'delivered'].includes(o.status)) throw transition();
    if (o.status === 'delivered' && from !== o.receiveDate) throw transition();
    const pieces = await M('Piece').find({ _id: { $in: o.lines.map((l) => l.pieceId) } }).session(session || null).lean();
    await pieceState.lock(pieces.map((p) => p._id), session);
    await schedule.assertAvailable(pieces, from, to, { exceptOrder: orderId, session });
    const r = await reprice(auth, o, { receiveDate: from, dueDate: to }, { type: 'dates', from: `${o.receiveDate}..${o.dueDate}`, to: `${from}..${to}`, reason }, session);
    return r;
  });
  return { status: 200, body: await withDiff(orderId) };
}

/** The last `diff` recorded in changes[] is returned next to the order (spec 5.9). */
async function withDiff(orderId) {
  const order = await orders.get(orderId);
  const last = order.changes[order.changes.length - 1];
  return { ...order, diff: last?.diff ?? 0 };
}

/** POST /orders/:id/lines/:lineId/swap { newPieceId, reason } */
async function swapLine(auth, orderId, lineId, body) {
  const newPieceId = typeof body?.newPieceId === 'string' ? body.newPieceId : '';
  const reason = typeof body?.reason === 'string' ? body.reason.slice(0, 300) : '';
  if (!newPieceId) throw new AppError(400, 'validation_failed', { fields: [{ field: 'newPieceId', code: 'required' }] });
  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (!['reserved', 'paid'].includes(o.status)) throw transition();
    const line = o.lines.find((l) => l.id === lineId);
    if (!line) throw notFound();
    if (o.lines.some((l) => l.pieceId === newPieceId)) throw new AppError(422, 'invalid', { fields: [{ field: 'newPieceId', code: 'duplicate_piece' }] });
    const piece = await M('Piece').findById(newPieceId).session(session || null).lean();
    if (!piece) throw notFound();
    await pieceState.lock([piece._id], session);
    await schedule.assertAvailable([piece], o.receiveDate, o.dueDate, { exceptOrder: orderId, session });
    const lines = o.lines.map((l) => (l.id === lineId ? { pieceId: newPieceId, person: l.person } : { pieceId: l.pieceId, person: l.person }));
    await reprice(auth, o, { lines }, { type: 'swap', from: line.pieceCode, to: piece.code, reason }, session);
    await pieceState.setStatus(newPieceId, 'held', { from: ['ready'], session });
    await pieceState.releaseIfFree(line.pieceId, { exceptOrder: orderId, session });
  });
  return { status: 200, body: await withDiff(orderId) };
}

/** POST /orders/:id/lines { pieceId, person } */
async function addLine(auth, orderId, body) {
  const pieceId = typeof body?.pieceId === 'string' ? body.pieceId : '';
  const person = typeof body?.person === 'string' ? body.person.slice(0, 100) : '';
  if (!pieceId) throw new AppError(400, 'validation_failed', { fields: [{ field: 'pieceId', code: 'required' }] });
  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (!['reserved', 'paid'].includes(o.status)) throw transition();
    if (o.lines.some((l) => l.pieceId === pieceId)) throw new AppError(422, 'invalid', { fields: [{ field: 'pieceId', code: 'duplicate_piece' }] });
    const piece = await M('Piece').findById(pieceId).session(session || null).lean();
    if (!piece) throw notFound();
    await pieceState.lock([piece._id], session);
    await schedule.assertAvailable([piece], o.receiveDate, o.dueDate, { exceptOrder: orderId, session });
    const lines = [...o.lines.map((l) => ({ pieceId: l.pieceId, person: l.person })), { pieceId, person }];
    await reprice(auth, o, { lines }, { type: 'add', to: piece.code }, session);
    await pieceState.setStatus(pieceId, 'held', { from: ['ready'], session });
  });
  return { status: 201, body: await withDiff(orderId) };
}

// ---------- plain edits ----------

const EDITABLE = ['note', 'source', 'receiveMinute', 'receiveMode', 'returnMode', 'receiveAddr', 'returnAddr', 'receiveFee', 'returnFee'];

/** PATCH /orders/:id { fields..., reason }: every changed field is recorded in changes[]. */
async function patch(auth, orderId, body) {
  const c = new Checker();
  const set = {};
  if (body?.note !== undefined) set.note = c.str(body, 'note', { max: 1000 }) || '';
  if (body?.source !== undefined) set.source = c.oneOf(body, 'source', orders.SOURCES);
  if (body?.receiveMinute !== undefined) set.receiveMinute = c.int(body, 'receiveMinute', { max: 1439 }) ?? null;
  for (const k of ['receiveMode', 'returnMode']) if (body?.[k] !== undefined) set[k] = c.oneOf(body, k, ['store', 'delivery']);
  for (const k of ['receiveAddr', 'returnAddr']) if (body?.[k] !== undefined) set[k] = c.str(body, k, { max: 300 }) || '';
  for (const k of ['receiveFee', 'returnFee']) if (body?.[k] !== undefined) set[k] = c.money(body, k) ?? 0;
  const reason = c.str(body, 'reason', { max: 300 }) || '';
  c.done();
  await withTx(async (session) => {
    const o = await orders.load(orderId, session);
    if (['cancelled', 'expired', 'completed'].includes(o.status)) throw transition();
    const changed = Object.keys(set).filter((k) => EDITABLE.includes(k) && String(o[k] ?? '') !== String(set[k] ?? ''));
    if (!changed.length) return;
    const feeChanged = changed.some((k) => ['receiveMode', 'returnMode', 'receiveFee', 'returnFee'].includes(k));
    const plain = Object.fromEntries(changed.filter((k) => !feeChanged || !['receiveMode', 'returnMode', 'receiveFee', 'returnFee'].includes(k)).map((k) => [k, set[k]]));
    const log = changed.map((k) => addChange(auth, { type: 'edit', field: k, from: o[k] ?? '', to: set[k] ?? '', reason }));
    if (Object.keys(plain).length) await M('Order').updateOne({ _id: orderId }, { $set: { ...plain, updatedAt: new Date() }, $push: { changes: { $each: log } } }, opt(session));
    if (feeChanged) {
      const fee = Object.fromEntries(['receiveMode', 'returnMode', 'receiveFee', 'returnFee'].filter((k) => set[k] !== undefined).map((k) => [k, set[k]]));
      await reprice(auth, { ...o, ...plain }, fee, { type: 'edit', field: 'delivery', from: `${o.receiveFee}+${o.returnFee}`, to: `${fee.receiveFee ?? o.receiveFee}+${fee.returnFee ?? o.returnFee}`, reason }, session);
      await M('Order').updateOne({ _id: orderId }, { $set: Object.fromEntries(['receiveAddr', 'returnAddr'].filter((k) => set[k] !== undefined).map((k) => [k, set[k]])) }, opt(session));
    }
  });
  return { status: 200, body: await orders.get(orderId) };
}

const setField = async (orderId, set) => {
  const r = await M('Order').updateOne({ _id: orderId }, { $set: { ...set, updatedAt: new Date() } });
  if (!r.matchedCount) throw notFound();
  return orders.get(orderId);
};

const internalNote = (orderId, body) => setField(orderId, { internalNote: typeof body?.internalNote === 'string' ? body.internalNote.slice(0, 1000) : '' });
const contacted = (orderId, body) => setField(orderId, { contacted: body?.contacted !== false, contactedAt: new Date() });

// ---------- slip ----------

const money = (n) => `${Math.round(n).toLocaleString('vi-VN')}đ`;

/** GET /orders/:id/slip?kind=rent|deliver|return -> { text } to share. No bank details or QR. */
async function slip(orderId, kind, lang) {
  const order = await orders.get(orderId);
  const shop = await settings.get('shop');
  const en = lang === 'en';
  const head = { rent: en ? 'RENTAL SLIP' : 'PHIẾU THUÊ', deliver: en ? 'DELIVERY SLIP' : 'PHIẾU GIAO ĐỒ', return: en ? 'RETURN SLIP' : 'PHIẾU TRẢ ĐỒ' }[kind] || (en ? 'RENTAL SLIP' : 'PHIẾU THUÊ');
  const L = en
    ? { code: 'Order', cust: 'Customer', recv: 'Pick-up', due: 'Due', items: 'Items', rent: 'Rent', sur: 'Surcharge', del: 'Delivery', disc: 'Discount', total: 'Total', paid: 'Paid', dep: 'Deposit held', owe: 'Balance', late: 'Days late', policy: 'Policy' }
    : { code: 'Mã đơn', cust: 'Khách', recv: 'Ngày nhận', due: 'Hạn trả', items: 'Trang phục', rent: 'Tiền thuê', sur: 'Phụ thu', del: 'Giao nhận', disc: 'Giảm giá', total: 'Tổng', paid: 'Đã thu', dep: 'Cọc đang giữ', owe: 'Còn lại', late: 'Số ngày trễ', policy: 'Chính sách' };
  const out = [
    shop.name, [shop.address, shop.phone].filter(Boolean).join(' · '), '', head, `${L.code}: ${order.code}`,
    `${L.cust}: ${order.customer?.name || ''}${order.customer?.phone ? ` · ${order.customer.phone}` : ''}`, `${L.recv}: ${order.receiveDate}`, `${L.due}: ${order.dueDate}`, '', `${L.items}:`,
    ...order.lines.map((l) => `- ${l.pieceCode} ${l.styleName}${l.size ? ` (${l.size})` : ''}${l.person ? ` — ${l.person}` : ''}: ${money(l.unit + l.surcharge)}`),
    ...order.acc.map((a) => `- ${a.name} x${a.qty}`), '',
    `${L.rent}: ${money(order.rent)}`, ...(order.surcharge ? [`${L.sur}: ${money(order.surcharge)}`] : []), ...(order.receiveFee + order.returnFee ? [`${L.del}: ${money(order.receiveFee + order.returnFee)}`] : []),
    ...(order.discount ? [`${L.disc}: -${money(order.discount)}`] : []), `${L.total}: ${money(order.grand)}`, `${L.paid}: ${money(order.paidRent)}`, `${L.owe}: ${money(order.balance)}`, `${L.dep}: ${money(order.depositHeld)}`,
    ...(kind === 'return' ? [`${L.late}: ${order.lateDays}`] : []), ...(order.policySnap ? ['', `${L.policy}:`, order.policySnap] : []),
  ];
  return { text: out.join('\n') };
}

/** GET /orders/:id/history -> changes[] + deliveries + returns + payments in time order. */
async function history(orderId) {
  const o = await orders.load(orderId);
  const [pays, dels, rets] = await Promise.all([M('Payment').find({ orderId }).lean(), M('Delivery').find({ orderId }).lean(), M('Return').find({ orderId }).lean()]);
  const items = [
    { at: o.createdAt, type: 'created', by: o.createdBy },
    ...(o.changes || []).map((c) => ({ at: c.at, type: `change_${c.type}`, by: c.by, byName: c.byName, detail: c })),
    ...pays.map((p) => ({ at: p.at, type: `payment_${p.kind}`, by: p.by, byName: p.byName, detail: ledger.present(p) })),
    ...dels.map((d) => ({ at: d.at, type: d.kind === 'out' ? 'delivered' : 'received', by: d.by, detail: { receiver: d.receiver, address: d.address, note: d.note } })),
    ...rets.map((r) => ({ at: r.at, type: 'returned', by: r.by, detail: { lines: r.lines, lateDays: r.lateDays } })),
  ].sort((a, b) => new Date(a.at) - new Date(b.at)).map((x) => ({ ...x, at: new Date(x.at).toISOString() }));
  return { items };
}

module.exports = { payments, addPayment, deliver, receiveReturn, settle, cancel, changeDates, swapLine, addLine, patch, internalNote, contacted, slip, history, advance };
