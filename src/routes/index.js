/**
 * /v1 routes. Public: health, register-shop, login, resume, refresh, forgot, reset, cron. Everything else needs a
 * Bearer token and runs inside the token's shop (shopId never comes from the client).
 * Money-writing and order-creating commands are wrapped with `Idempotency-Key` (see lib/idempotency.js).
 */
const express = require('express');
const mongoose = require('mongoose');
const config = require('../config');
const { asyncHandler, AppError, notFound } = require('../lib/errors');
const { authenticate, resolve } = require('../middleware/auth');
const { idempotent } = require('../lib/idempotency');
const tenant = require('../lib/tenant');
const { iso, safeEqual } = require('../lib/util');
const { resources } = require('../resources/defs');
const accounts = require('../services/accounts');
const settings = require('../services/settings');
const audit = require('../services/audit');
const orders = require('../services/orders');
const flow = require('../services/orderFlow');
const schedule = require('../services/schedule');
const holds = require('../services/holds');
const cleaning = require('../services/cleaning');
const pieces = require('../services/pieces');
const customers = require('../services/customers');
const finance = require('../services/finance');
const reports = require('../services/reports');
const home = require('../services/home');
const search = require('../services/search');
const sync = require('../services/sync');
const imports = require('../services/imports');
const todos = require('../services/todos');
const waits = require('../services/waits');
const jobs = require('../services/jobs');

const r = express.Router();
const h = asyncHandler;
const noContent = (fn) => h(async (req, res) => { await fn(req, res); res.status(204).end(); });
/** Runs `fn(req)` -> { status, body } once per Idempotency-Key. */
const idem = (scope, fn) => h(async (req, res) => {
  const out = await idempotent(req, scope, () => fn(req));
  res.status(out.status).json(out.body);
});
const ok = (fn) => h(async (req, res) => res.json(await fn(req)));
const lazyExpire = () => holds.expireDue().catch(() => {}); // also expire due holds when the app asks (the cron is only daily)

// ---------- public ----------

r.get('/health', (_req, res) => {
  const up = mongoose.connection.readyState === 1;
  res.status(up ? 200 : 503).json({ status: up ? 'ok' : 'degraded', apiVersion: config.apiVersion, minAppVersion: config.minAppVersion, latestAppVersion: config.latestAppVersion, serverTime: iso(new Date()) });
});

r.post('/auth/register-shop', h(async (req, res) => {
  const out = await accounts.registerShop(req.body, { lang: req.lang, idempotencyKey: req.get('idempotency-key') });
  res.status(out.status).json(out.body);
}));
r.post('/auth/login', ok((req) => accounts.login(req.body)));
r.post('/auth/resume', ok((req) => accounts.resume(req.body)));
r.post('/auth/refresh', ok((req) => accounts.refresh(req.body)));
r.post('/auth/forgot', h(async (req, res) => res.status(202).json(await accounts.forgot(req.body, { lang: req.lang }))));
r.post('/auth/reset', noContent((req) => accounts.reset(req.body, { lang: req.lang })));
// Bearer is optional on logout: an expired access token must not prevent signing out with the refresh token.
r.post('/auth/logout', noContent(async (req) => {
  let auth = null;
  if (req.get('authorization')) auth = await resolve(req).catch(() => null);
  await accounts.logout(req.body, auth);
}));

r.get('/jobs/run', h(async (req, res) => {
  if (config.cronSecret) {
    const m = /^Bearer\s+(\S+)$/i.exec(req.get('authorization') || '');
    if (!m || !safeEqual(m[1], config.cronSecret)) throw new AppError(401, 'session_expired');
  }
  res.json(await tenant.unscoped(() => jobs.run()));
}));

// ---------- signed in ----------

r.use(authenticate);

// account
r.post('/auth/change-password', ok((req) => accounts.changePassword(req.auth, req.body, { lang: req.lang })));
r.get('/me', h(async (req, res) => res.json({ me: accounts.presentMe(req.auth.account), shop: { id: req.auth.shopId, name: (await settings.get('shop')).name } })));
r.patch('/me', h(async (req, res) => res.json({ me: await accounts.updateMe(req.auth, req.body) })));
r.delete('/me', h(async (req, res) => { await accounts.deleteAccount(req.auth.account, req.body?.password); res.status(204).end(); }));
r.get('/me/sessions', ok((req) => accounts.listSessions(req.auth)));
r.delete('/me/sessions/:id', noContent((req) => accounts.removeSession(req.auth, req.params.id)));
r.get('/admins', ok((req) => accounts.listAdmins(req.auth)));
r.post('/admins', h(async (req, res) => res.status(201).json(await accounts.createAdmin(req.auth, req.body))));
r.post('/admins/:id/revoke', ok((req) => accounts.revokeAdmin(req.auth, req.params.id)));
r.post('/admins/:id/reset-password', noContent((req) => accounts.resetAdminPassword(req.auth, req.params.id, req.body)));
r.get('/admin-log', ok((req) => audit.list(req.query)));

// dashboard, reports, search, sync
r.get('/home', h(async (req, res) => { await lazyExpire(); res.json(await home.home(req.query)); }));
r.get('/reminders/source', ok(() => home.remindersSource()));
r.get('/reports/:name', ok((req) => reports.run(req.params.name, req.query)));
r.get('/search', ok((req) => search.search(req.query.q)));
r.get('/sync', ok((req) => sync.sync(req.query)));
r.post('/import/:type/preview', ok((req) => imports.run(req.auth, req.params.type, req.body, { commit: false })));
r.post('/import/:type/commit', ok((req) => imports.run(req.auth, req.params.type, req.body, { commit: true })));

// settings
r.get('/settings/:key', ok((req) => settings.get(req.params.key)));
r.put('/settings/:key', ok((req) => settings.put(req.params.key, req.body, req.auth)));

// ---------- catalog with extra actions (before the generic CRUD routers) ----------

r.get('/pieces/alerts', ok(() => pieces.alerts()));
r.get('/pieces/:id/bookings', ok((req) => schedule.bookingsApi(req.params.id)));
r.get('/pieces/:id/calendar', ok((req) => schedule.calendar(req.params.id, req.query.month)));
r.get('/pieces/:id/logs', ok((req) => pieces.logs(req.params.id)));
r.get('/pieces/:id/summary', ok((req) => pieces.summary(req.params.id)));
r.post('/pieces/:id/status', ok((req) => pieces.setStatus(req.auth, req.params.id, req.body)));
r.post('/pieces/:id/dispose', ok((req) => pieces.dispose(req.auth, req.params.id, req.body)));
r.post('/pieces/:id/care', ok((req) => pieces.care(req.auth, req.params.id, req.body)));
r.post('/purchases', h(async (req, res) => res.status(201).json(await pieces.purchase(req.auth, req.body))));

r.get('/customers/:id/loyalty', ok((req) => customers.loyalty(req.params.id)));
r.get('/customers/:id/orders', ok((req) => orders.list({ ...req.query, customerId: req.params.id })));
r.post('/customers/:id/merge', ok((req) => customers.merge(req.auth, req.params.id, req.body)));

r.post('/supplies/:id/move', ok((req) => pieces.moveSupply(req.auth, req.params.id, req.body)));
r.get('/supplies/:id/moves', ok((req) => pieces.supplyMoves(req.params.id)));
r.post('/todos/:id/complete', ok((req) => todos.complete(req.params.id)));
r.get('/waits', ok((req) => waits.list(req.query)));

r.get('/availability', h(async (req, res) => { await lazyExpire(); res.json(await schedule.availability(req.query)); }));
r.post('/availability/fit', ok((req) => schedule.fitHints(req.body)));

// fit-memory is written by the server (when a fitting result is "fit"): read only
r.use('/fit-memory', (req, _res, next) => (req.method === 'GET' ? next() : next(notFound())));

for (const res of resources) r.use(`/${res.def.path}`, res.router());

// ---------- orders ----------

r.post('/orders/quote', ok((req) => orders.quote(req.body)));
r.get('/orders/call-list', ok(() => orders.specialList('call-list')));
r.get('/orders/outside', ok(() => orders.specialList('outside')));
r.get('/orders', ok((req) => orders.list(req.query)));
r.post('/orders', idem('order.create', (req) => orders.create(req.auth, req.body)));
r.get('/orders/:id', ok((req) => orders.get(req.params.id)));
r.patch('/orders/:id', ok((req) => flow.patch(req.auth, req.params.id, req.body).then((x) => x.body)));
r.get('/orders/:id/payments', ok((req) => flow.payments(req.params.id)));
r.post('/orders/:id/payments', idem('order.pay', (req) => flow.addPayment(req.auth, req.params.id, req.body)));
r.post('/orders/:id/deliver', idem('order.deliver', (req) => flow.deliver(req.auth, req.params.id, req.body)));
r.post('/orders/:id/return', idem('order.return', (req) => flow.receiveReturn(req.auth, req.params.id, req.body)));
r.post('/orders/:id/settle', idem('order.settle', (req) => flow.settle(req.auth, req.params.id, req.body)));
r.post('/orders/:id/cancel', idem('order.cancel', (req) => flow.cancel(req.auth, req.params.id, req.body)));
r.post('/orders/:id/change-dates', idem('order.dates', (req) => flow.changeDates(req.auth, req.params.id, req.body)));
r.post('/orders/:id/lines', idem('order.addline', (req) => flow.addLine(req.auth, req.params.id, req.body)));
r.post('/orders/:id/lines/:lineId/swap', idem('order.swap', (req) => flow.swapLine(req.auth, req.params.id, req.params.lineId, req.body)));
r.put('/orders/:id/internal-note', ok((req) => flow.internalNote(req.params.id, req.body)));
r.put('/orders/:id/contacted', ok((req) => flow.contacted(req.params.id, req.body)));
r.get('/orders/:id/slip', ok((req) => flow.slip(req.params.id, req.query.kind, req.query.lang === 'en' ? 'en' : req.lang)));
r.get('/orders/:id/history', ok((req) => flow.history(req.params.id)));

// ---------- holds, laundry, cash ----------

r.get('/holds', h(async (req, res) => { await lazyExpire(); res.json(await holds.list(req.query)); }));
r.post('/holds', idem('hold.create', (req) => holds.create(req.auth, req.body)));
r.get('/holds/:id', ok((req) => holds.get(req.params.id)));
r.post('/holds/:id/extend', ok((req) => holds.extend(req.auth, req.params.id, req.body)));
r.post('/holds/:id/release', ok((req) => holds.release(req.auth, req.params.id, req.body)));

r.get('/cleaning', ok((req) => cleaning.list(req.query)));
r.post('/cleaning', h(async (req, res) => { const out = await cleaning.start(req.auth, req.body); res.status(out.status).json(out.body); }));
r.get('/cleaning/:id', ok((req) => cleaning.get(req.params.id)));
r.patch('/cleaning/:id', ok((req) => cleaning.patch(req.auth, req.params.id, req.body)));
r.post('/cleaning/:id/move', ok((req) => cleaning.move(req.auth, req.params.id, req.body)));
r.put('/cleaning/:id/qc', ok((req) => cleaning.setQc(req.auth, req.params.id, req.body)));

r.get('/shifts', ok((req) => finance.list(req.query)));
r.get('/shifts/current', ok(() => finance.current()));
r.post('/shifts/open', h(async (req, res) => res.status(201).json(await finance.open(req.auth, req.body))));
r.post('/shifts/close', ok((req) => finance.close(req.auth, req.body)));
r.get('/cash', ok((req) => finance.listCash(req.query)));
r.post('/cash', h(async (req, res) => res.status(201).json(await finance.addCash(req.auth, req.body))));
r.delete('/cash/:id', noContent((req) => finance.deleteCash(req.auth, req.params.id)));
r.get('/day-close', ok((req) => finance.dayClose(req.query.date)));

module.exports = r;
