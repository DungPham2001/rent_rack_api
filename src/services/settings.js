/**
 * One row per (shop, key): shop, rules, policy, loyalty, hours (spec 4). Reads merge the stored values over the
 * defaults; a PUT replaces the stored value (merged over defaults, validated). Read once per request (tenant memo).
 */
const { Setting } = require('../models');
const tenant = require('../lib/tenant');
const { Checker, isObj } = require('../lib/validate');
const { notFound, invalid } = require('../lib/errors');
const config = require('../config');
const T = require('../lib/time');

const KEYS = ['shop', 'rules', 'policy', 'loyalty', 'hours'];

const DEFAULTS = {
  shop: { name: '', phone: '', address: '', owner: '', desc: '' },
  rules: {
    defaultDays: 3, bufferDays: 1, holdDays: 3, lateKind: 'amount', lateValue: 100000, depositPct: 50, holdPct: 30, staleDays: 60,
    overloadPerDay: 12, conflictMode: 'block', allowNotReady: false, fittingMinutes: 30, rushPct: 0, timezone: config.timezone,
    careDays: 90, lifecycleWarnPct: 85, surchargeHolidayPct: 0,
  },
  policy: { text: '' },
  loyalty: {
    per: 10000, value: 100,
    tiers: [{ name: 'Thành viên', minPoints: 0 }, { name: 'Bạc', minPoints: 100 }, { name: 'Vàng', minPoints: 300 }, { name: 'Kim cương', minPoints: 800 }],
  },
  hours: { days: [0, 1, 2, 3, 4, 5, 6].map((day) => ({ day, open: 480, close: 1260, closed: false })) },
};

const validTz = (tz) => {
  try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; }
};

const merge = (key, stored) => {
  const base = DEFAULTS[key];
  if (key === 'hours') return { days: Array.isArray(stored?.days) && stored.days.length ? stored.days : base.days };
  return { ...base, ...(isObj(stored) ? stored : {}) };
};

const loadAll = () => tenant.memo('settings', async () => {
  const rows = await Setting.find({}).lean();
  const stored = Object.fromEntries(rows.map((r) => [r.key, r.value]));
  return Object.fromEntries(KEYS.map((k) => [k, merge(k, stored[k])]));
});

const get = async (key) => {
  if (!KEYS.includes(key)) throw notFound();
  return (await loadAll())[key];
};

/** { rules, tz, today, loyalty, hours } for business logic: "today", overdue and buffer days follow `rules.timezone`. */
async function ctx() {
  const all = await loadAll();
  const tz = all.rules.timezone || config.timezone;
  return { ...all, tz, today: T.today(tz), localDate: (d) => T.dateOf(d, tz), minuteOf: (d) => T.minuteOf(d, tz) };
}

function validate(key, body) {
  const c = new Checker();
  const src = isObj(body) ? body : {};
  const out = {};
  if (key === 'shop') {
    for (const k of ['name', 'phone', 'address', 'owner', 'email', 'website']) out[k] = c.str(src, k, { max: 200 }) ?? '';
    out.desc = c.str(src, 'desc', { max: 2000 }) ?? '';
    if (!out.name) c.fail('name', 'required');
  } else if (key === 'policy') {
    out.text = c.str(src, 'text', { max: 10000 }) ?? '';
  } else if (key === 'rules') {
    const d = DEFAULTS.rules;
    const intf = (k, max = 100000000) => { out[k] = c.int(src, k, { min: 0, max }) ?? d[k]; };
    for (const k of ['defaultDays', 'bufferDays', 'holdDays', 'staleDays', 'overloadPerDay', 'careDays', 'fittingMinutes']) intf(k, 3650);
    for (const k of ['depositPct', 'holdPct', 'rushPct', 'lifecycleWarnPct', 'surchargeHolidayPct']) intf(k, 100);
    intf('lateValue');
    out.lateKind = c.oneOf(src, 'lateKind', ['amount', 'pct'], { def: d.lateKind });
    out.conflictMode = c.oneOf(src, 'conflictMode', ['block', 'warn'], { def: d.conflictMode });
    out.allowNotReady = c.bool(src, 'allowNotReady', { def: d.allowNotReady });
    out.timezone = c.str(src, 'timezone', { max: 60 }) || d.timezone;
    if (!validTz(out.timezone)) c.fail('timezone', 'invalid_format');
    if (out.defaultDays < 1) c.fail('defaultDays', 'out_of_range');
  } else if (key === 'loyalty') {
    out.per = c.int(src, 'per', { min: 0, max: 1e9 }) ?? DEFAULTS.loyalty.per;
    out.value = c.int(src, 'value', { min: 0, max: 1e9 }) ?? DEFAULTS.loyalty.value;
    const tiers = c.arr(src, 'tiers', { max: 20 }) || DEFAULTS.loyalty.tiers;
    out.tiers = tiers.map((t, i) => ({
      name: c.str(t, 'name', { field: `tiers[${i}].name`, required: true, max: 40 }),
      minPoints: c.int(t, 'minPoints', { field: `tiers[${i}].minPoints`, min: 0, max: 1e9 }) ?? 0,
    })).sort((a, b) => a.minPoints - b.minPoints);
  } else if (key === 'hours') {
    const days = Array.isArray(body) ? body : c.arr(src, 'days', { required: true, max: 7 });
    out.days = (days || []).map((d, i) => ({
      day: c.int(d, 'day', { field: `days[${i}].day`, required: true, max: 6 }),
      open: c.int(d, 'open', { field: `days[${i}].open`, max: 1439 }) ?? 480,
      close: c.int(d, 'close', { field: `days[${i}].close`, max: 1440 }) ?? 1260,
      closed: c.bool(d, 'closed', { field: `days[${i}].closed`, def: false }),
    }));
  }
  c.done();
  return out;
}

async function put(key, body, auth) {
  if (!KEYS.includes(key)) throw notFound();
  const value = validate(key, body);
  await Setting.updateOne(
    { key },
    { $set: { value, updatedBy: auth?.accountId || null, updatedAt: new Date() }, $setOnInsert: { _id: `${tenant.current()}:${key}` } },
    { upsert: true },
  );
  tenant.forget('settings');
  if (key === 'rules' || key === 'shop') require('./audit').log(auth, 'settings', key, 'update', key).catch(() => {});
  return get(key);
}

/** Seeds `shop` when the shop registers. */
const initShop = (shop) => Setting.create({ _id: `${tenant.current()}:shop`, key: 'shop', value: { ...DEFAULTS.shop, ...shop } });

module.exports = { KEYS, DEFAULTS, get, put, ctx, initShop, validate, invalid };
