/**
 * Multi-shop context. Every shop (tiệm) owns its own catalog, orders, money... The id of a shop is the id of its
 * first admin account (`account.shopId`). The request's shop travels in an AsyncLocalStorage; the Mongoose plugin in
 * `tenantPlugin.js` adds it to every query and every new document of the shop-owned collections, so a service can
 * never read or write another shop's data (`shopId` never comes from the client). The store also carries a small
 * per-request memo (settings are read many times per request).
 */
const { AsyncLocalStorage } = require('node:async_hooks');

const als = new AsyncLocalStorage();

/** Runs `fn` as shop `shopId` (null = no filter at all, for cross-shop jobs). */
const run = (shopId, fn) => als.run({ shopId: shopId || null, memo: new Map() }, fn);
const unscoped = (fn) => run(null, fn);
const current = () => als.getStore()?.shopId || null;

/** Per-request cache: `memo('settings', () => load())`. Cleared with `forget(key)` after a write. */
async function memo(key, fn) {
  const store = als.getStore();
  if (!store) return fn();
  if (!store.memo.has(key)) store.memo.set(key, Promise.resolve().then(fn));
  return store.memo.get(key);
}
const forget = (key) => als.getStore()?.memo.delete(key);

module.exports = { run, unscoped, current, memo, forget };
