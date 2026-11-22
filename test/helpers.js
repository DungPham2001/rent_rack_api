process.env.NODE_ENV = 'test';
const fs = require('fs');
// Tests never read the developer's .env (real SMTP, cron secret, Atlas URI): blank every key it defines.
try {
  for (const k of Object.keys(require('dotenv').parse(fs.readFileSync(require('path').join(__dirname, '..', '.env'))))) {
    if (!(k in process.env)) process.env[k] = '';
  }
} catch { /* no .env */ }
// Offline machines: reuse a locally installed mongod instead of downloading one.
if (!process.env.MONGOMS_SYSTEM_BINARY && fs.existsSync('/opt/homebrew/bin/mongod')) {
  process.env.MONGOMS_SYSTEM_BINARY = '/opt/homebrew/bin/mongod';
  process.env.MONGOMS_VERSION = process.env.MONGOMS_VERSION || '9.0.4';
}

const mongoose = require('mongoose');
const request = require('supertest');
const { MongoMemoryReplSet } = require('mongodb-memory-server');

const app = require('../src/app');
const models = require('../src/models');
const T = require('../src/lib/time');

let rs;

async function start() {
  rs = await MongoMemoryReplSet.create({ replSet: { count: 1, configSettings: { electionTimeoutMillis: 10000 } } });
  mongoose.set('strictQuery', true);
  await mongoose.connect(rs.getUri());
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
}
async function stop() {
  await mongoose.disconnect();
  await rs.stop();
}
async function reset() {
  for (const c of await mongoose.connection.db.collections()) await c.deleteMany({});
}

const bearer = (token) => (token ? { Authorization: `Bearer ${token}` } : {});
const withHeaders = (req, token, headers) => { const r = req.set(bearer(token)); return headers ? r.set(headers) : r; };
const api = {
  get: (p, token, headers) => withHeaders(request(app).get(`/v1/${p}`), token, headers),
  post: (p, body, token, headers) => withHeaders(request(app).post(`/v1/${p}`), token, headers).send(body || {}),
  put: (p, body, token, headers) => withHeaders(request(app).put(`/v1/${p}`), token, headers).send(body || {}),
  patch: (p, body, token, headers) => withHeaders(request(app).patch(`/v1/${p}`), token, headers).send(body || {}),
  del: (p, body, token, headers) => withHeaders(request(app).delete(`/v1/${p}`), token, headers).send(body || {}),
};

const PASSWORD = 'Matkhau123';

const expectOk = (res, status = 200) => {
  if (res.status !== status) throw new Error(`${res.req?.method} ${res.req?.path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const expectErr = (res, status, code) => {
  if (res.status !== status || res.body.code !== code) throw new Error(`${res.req?.method} ${res.req?.path} -> ${res.status} ${JSON.stringify(res.body)} (wanted ${status} ${code})`);
  return res.body;
};

/** Registers a new shop through the API: { token, login, shopId }. */
async function shop(email = 'chu@tiem.test', name = 'Tiệm Hoa') {
  const login = expectOk(await api.post('auth/register-shop', { shopName: name, shopPhone: '0901000111', address: 'Hà Nội', ownerName: 'Chủ Tiệm', email, password: PASSWORD, device: { name: 'Pixel' } }), 201);
  return { token: login.accessToken, login, shopId: login.shop.id };
}

const addDays = (n) => T.addDays(T.today(), n);

/**
 * A small catalog for one shop: category, style with a price list (day 300k, tier3 800k, tier7 1.6M, extra 200k),
 * two pieces of the same style, a customer.
 */
async function world(token, { days = 3 } = {}) {
  void days;
  const cat = expectOk(await api.post('categories', { name: 'Áo dài' }, token), 201);
  const style = expectOk(await api.post('styles', { code: 'AD01', name: 'Áo dài đỏ', categoryId: cat.id, color: 'Đỏ', material: 'Lụa', occasions: ['cưới'] }, token), 201);
  const p1 = expectOk(await api.post('pieces', { code: 'AD01-M', styleId: style.id, size: 'M', purchasePrice: 2000000, maxRentals: 20, shelf: 'A1' }, token), 201);
  const p2 = expectOk(await api.post('pieces', { code: 'AD01-L', styleId: style.id, size: 'L', purchasePrice: 2000000, maxRentals: 20 }, token), 201);
  expectOk(await api.post('prices', { styleId: style.id, day: 300000, tier3: 800000, tier7: 1600000, extraDay: 200000, from: addDays(-30) }, token), 201);
  const cust = expectOk(await api.post('customers', { name: 'Nguyễn Văn An', phone: '0912345678' }, token), 201);
  return { cat, style, p1, p2, cust };
}

const orderBody = (w, extra = {}) => ({
  customerId: w.cust.id, receiveDate: addDays(5), dueDate: addDays(8), lines: [{ pieceId: w.p1.id, person: 'An' }], paidNow: 300000, payMethod: 'cash', ...extra,
});

module.exports = { start, stop, reset, api, app, request, models, PASSWORD, expectOk, expectErr, shop, world, orderBody, addDays, T };
