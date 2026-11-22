/**
 * The quote (spec 5.2). Pure business rules on top of the shop's price list; nothing is written. Used by the quote
 * endpoint, order creation (the server never trusts client prices), and re-pricing of an existing order.
 */
const mongoose = require('mongoose');
const settings = require('./settings');
const T = require('../lib/time');
const { AppError, notFound } = require('../lib/errors');
const { phoneKey } = require('../lib/util');

const M = (name) => mongoose.model(name);
const round = (n) => Math.max(0, Math.round(n));
const bad = (field, code = 'invalid') => new AppError(422, 'invalid', { fields: [{ field, code }] });

/** Price row valid on `date`: the piece's own list first, else the style's; the row with the latest `from` <= date. */
function pickPrice(prices, piece, date) {
  const valid = (list) => list.filter((p) => p.from <= date).sort((a, b) => (a.from < b.from ? 1 : -1))[0];
  return valid(prices.filter((p) => p.pieceId === piece._id)) || valid(prices.filter((p) => p.styleId === piece.styleId && !p.pieceId)) || null;
}

/** Rent of one piece for `days`: tier7 covers 7 days, tier3 covers 3, else the day price; extra days at `extraDay` (or `day`). */
function rentFor(row, days) {
  let base = row.day;
  let covered = 1;
  if (days >= 7 && row.tier7 > 0) { base = row.tier7; covered = 7; } else if (days >= 3 && row.tier3 > 0) { base = row.tier3; covered = 3; }
  return base + Math.max(0, days - covered) * (row.extraDay > 0 ? row.extraDay : row.day);
}

/** Splits `total` over `weights`, rounding each, with the remainder on the last line. */
function distribute(total, weights) {
  const sumW = weights.reduce((a, b) => a + b, 0);
  const out = weights.map((w) => Math.floor(sumW > 0 ? (total * w) / sumW : total / weights.length));
  out[out.length - 1] += total - out.reduce((a, b) => a + b, 0);
  return out;
}

async function loyaltyBalance(customerId, exceptOrderId) {
  if (!customerId) return 0;
  const rows = await M('Loyalty').find({ customerId, ...(exceptOrderId ? { refId: { $ne: exceptOrderId } } : {}) }).lean();
  return rows.reduce((t, r) => t + r.points, 0);
}

/**
 * draft: { receiveDate, dueDate, lines[{pieceId, person}], bundleId, promoCode, redeemPoints, specialRent, compReason, customerId,
 *          receiveMode, returnMode, receiveFee, returnFee, zoneId }
 * opts:  { priceDate, keepDiscount (number: re-pricing keeps the discount), exceptOrderId, forCreate }
 */
async function quote(draft, opts = {}) {
  const S = await settings.ctx();
  const { rules } = S;
  const { receiveDate, dueDate } = draft;
  if (!T.isDate(receiveDate)) throw bad('receiveDate');
  if (!T.isDate(dueDate) || dueDate < receiveDate) throw bad('dueDate');
  const days = Math.max(1, T.diffDays(receiveDate, dueDate));
  const priceDate = opts.priceDate || S.today;
  const draftLines = Array.isArray(draft.lines) ? draft.lines : [];

  const pieceIds = [...new Set(draftLines.map((l) => l.pieceId))];
  const pieces = await M('Piece').find({ _id: { $in: pieceIds } }).lean();
  const pieceMap = new Map(pieces.map((p) => [p._id, p]));
  for (const l of draftLines) if (!pieceMap.has(l.pieceId)) throw notFound();
  const styleIds = [...new Set(pieces.map((p) => p.styleId))];
  const [prices, rulesDep, peaks] = await Promise.all([
    M('Price').find({ $or: [{ pieceId: { $in: pieceIds } }, { styleId: { $in: styleIds } }] }).lean(),
    M('DepositRule').find({ $or: [{ pieceId: { $in: pieceIds } }, { styleId: { $in: styleIds } }] }).lean(),
    M('Peak').find({ from: { $lte: dueDate }, to: { $gte: receiveDate } }).lean(),
  ]);

  // natural rent per line
  const out = draftLines.map((l) => {
    const piece = pieceMap.get(l.pieceId);
    const row = pickPrice(prices, piece, priceDate);
    return { pieceId: piece._id, person: l.person || '', styleId: piece.styleId, size: piece.size || '', row, natural: row ? rentFor(row, days) : 0, priceMissing: !row, piece };
  });
  const normalRent = out.reduce((t, l) => t + l.natural, 0);

  let rentTotal = normalRent;
  let bundle = null;
  if (draft.bundleId) {
    bundle = await M('Bundle').findById(draft.bundleId).lean();
    if (!bundle) throw notFound();
    const extra = out.reduce((t, l) => t + (l.row ? (l.row.extraDay > 0 ? l.row.extraDay : l.row.day) : 0) * Math.max(0, days - rules.defaultDays), 0);
    rentTotal = bundle.price + extra;
    const parts = distribute(rentTotal, out.map((l) => l.natural));
    out.forEach((l, i) => { l.unit = parts[i]; });
  }
  const special = draft.specialRent !== undefined && draft.specialRent !== null && draft.specialRent !== '' ? Number(draft.specialRent) : null;
  if (special !== null) {
    if (!Number.isInteger(special) || special < 0) throw bad('specialRent');
    if (!String(draft.compReason || '').trim()) throw new AppError(422, 'comp_reason_required');
    rentTotal = special;
    const parts = distribute(rentTotal, out.map((l) => l.natural));
    out.forEach((l, i) => { l.unit = parts[i]; });
  }
  for (const l of out) if (l.unit === undefined) l.unit = l.natural;

  // surcharge per line (none with a special price)
  const rush = rules.rushPct > 0 && T.diffDays(S.today, receiveDate) <= 1;
  for (const l of out) {
    let s = 0;
    if (special === null) {
      for (const pk of peaks) s = Math.max(s, pk.kind === 'pct' ? round((l.unit * pk.value) / 100) : pk.value);
      if (rush) s += round((l.unit * rules.rushPct) / 100);
    }
    l.surcharge = s;
  }

  // deposit per line
  for (const l of out) {
    const rule = rulesDep.find((r) => r.pieceId === l.pieceId) || rulesDep.find((r) => r.styleId === l.styleId && !r.pieceId);
    const buy = l.piece.purchasePrice > 0 ? l.piece.purchasePrice : l.unit;
    if (rule) l.deposit = rule.kind === 'fixed' ? rule.value : round((buy * rule.value) / 100);
    else l.deposit = round((buy * rules.depositPct) / 100);
  }

  const rent = out.reduce((t, l) => t + l.unit, 0);
  const surcharge = out.reduce((t, l) => t + l.surcharge, 0);
  const deposit = out.reduce((t, l) => t + l.deposit, 0);
  const base = rent + surcharge;

  // delivery
  let zoneFee = null;
  if (draft.zoneId) zoneFee = (await M('Zone').findById(draft.zoneId).lean())?.fee ?? null;
  const feeOf = (mode, fee) => (mode === 'delivery' ? (fee !== undefined && fee !== null ? fee : zoneFee || 0) : 0);
  const receiveFee = feeOf(draft.receiveMode, draft.receiveFee);
  const returnFee = feeOf(draft.returnMode, draft.returnFee);
  const delivery = receiveFee + returnFee;

  // discounts (never with a special price)
  let discount = 0;
  let discountNote = '';
  let promoError = null;
  const detail = { promo: 0, auto: 0, autoName: '', points: 0, pointsUsed: 0, promoCode: '' };
  if (special === null) {
    if (opts.keepDiscount !== undefined) {
      discount = Math.min(opts.keepDiscount, base);
    } else {
      const customer = draft.customerId ? await M('Customer').findById(draft.customerId).lean() : null;
      const code = String(draft.promoCode || '').trim().toUpperCase();
      if (code) {
        const promo = await M('Promo').findOne({ code }).lean();
        if (!promo) promoError = 'not_found';
        else if ((promo.start && promo.start > S.today) || (promo.end && promo.end < S.today)) promoError = 'expired';
        else if (promo.limit > 0 && promo.used >= promo.limit) promoError = 'exhausted';
        else if (base < promo.minAmount) promoError = 'min_amount';
        else { detail.promo = promo.kind === 'pct' ? round((base * promo.value) / 100) : promo.value; detail.promoCode = promo.code; }
      }
      const isRegular = !!customer?.tags?.includes('regular');
      for (const d of await M('Discount').find({}).lean()) {
        if (out.length < d.minItems || days < d.minDays || (d.regularOnly && !isRegular)) continue;
        const v = d.kind === 'pct' ? round((base * d.value) / 100) : d.value;
        if (v > detail.auto) { detail.auto = v; detail.autoName = d.name; }
      }
      const want = Math.max(0, Math.floor(Number(draft.redeemPoints) || 0));
      if (want > 0 && customer && S.loyalty.value > 0) {
        detail.pointsUsed = Math.min(want, Math.max(0, await loyaltyBalance(customer._id, opts.exceptOrderId)));
        detail.points = detail.pointsUsed * S.loyalty.value;
      }
      // never discount more than rent + surcharge: trim points first, then the automatic discount, then the code
      let room = base;
      const promoV = Math.min(detail.promo, room); room -= promoV;
      const autoV = Math.min(detail.auto, room); room -= autoV;
      const ptsV = Math.min(detail.points, room);
      if (detail.points > ptsV && S.loyalty.value > 0) detail.pointsUsed = Math.ceil(ptsV / S.loyalty.value);
      detail.promo = promoV; detail.auto = autoV; detail.points = ptsV;
      discount = promoV + autoV + ptsV;
      discountNote = [promoV && `Mã ${detail.promoCode}`, autoV && detail.autoName, detail.pointsUsed && `${detail.pointsUsed} điểm`].filter(Boolean).join(' + ');
    }
  }

  const grand = Math.max(0, base + delivery - discount);
  const hold = round((grand * rules.holdPct) / 100);
  return {
    days,
    lines: out.map((l) => ({ pieceId: l.pieceId, person: l.person, styleId: l.styleId, size: l.size, unit: l.unit, surcharge: l.surcharge, deposit: l.deposit, days, priceMissing: l.priceMissing })),
    normalRent, rent, surcharge, discount, discountNote, discountDetail: detail, delivery, receiveFee, returnFee, deposit, hold, grand,
    payOnReceive: grand - hold + deposit,
    promoError, missingPrice: out.some((l) => l.priceMissing),
    bundleId: bundle?._id || null, specialRent: special,
  };
}

/** Quote of a body as sent by the app: validates shape, then prices it. */
async function quoteBody(body) {
  const lines = Array.isArray(body?.lines) ? body.lines : [];
  const draft = { ...body, lines: lines.map((l) => ({ pieceId: String(l?.pieceId || ''), person: String(l?.person || '').slice(0, 100) })) };
  if (!draft.lines.length) throw new AppError(422, 'no_lines');
  return quote(draft, {});
}

module.exports = { quote, quoteBody, pickPrice, rentFor, distribute, loyaltyBalance, phoneKey };
