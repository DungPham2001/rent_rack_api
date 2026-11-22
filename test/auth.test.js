const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert');
const h = require('./helpers');

before(h.start);
after(h.stop);
beforeEach(h.reset);

test('register-shop creates shop + admin and signs in', async () => {
  const s = await h.shop();
  assert.equal(s.login.me.email, 'chu@tiem.test');
  assert.equal(s.login.shop.name, 'Tiệm Hoa');
  assert.equal(s.login.expiresIn, 7200);
  assert.ok(s.login.refreshToken);
  assert.equal(s.login.resumeToken, undefined);
  const shopCfg = h.expectOk(await h.api.get('settings/shop', s.token));
  assert.equal(shopCfg.name, 'Tiệm Hoa');
  assert.equal(shopCfg.owner, 'Chủ Tiệm');
});

test('validation uses the spec codes', async () => {
  const base = { shopName: 'A', ownerName: 'B', email: 'a@b.vn', password: h.PASSWORD };
  h.expectErr(await h.api.post('auth/register-shop', { ...base, shopName: '' }), 422, 'required_missing');
  h.expectErr(await h.api.post('auth/register-shop', { ...base, email: 'nope' }), 422, 'invalid_email');
  h.expectErr(await h.api.post('auth/register-shop', { ...base, password: 'abc' }), 422, 'weak_password');
  h.expectOk(await h.api.post('auth/register-shop', base), 201);
  h.expectErr(await h.api.post('auth/register-shop', { ...base, email: 'A@B.vn' }), 409, 'email_taken');
});

test('login, lockout after 5 failures, same code for unknown email', async () => {
  await h.shop();
  h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD }));
  h.expectErr(await h.api.post('auth/login', { email: 'nobody@tiem.test', password: h.PASSWORD }), 401, 'invalid_credentials');
  for (let i = 0; i < 5; i += 1) h.expectErr(await h.api.post('auth/login', { email: 'chu@tiem.test', password: 'Sai12345' }), 401, 'invalid_credentials');
  h.expectErr(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD }), 429, 'too_many_attempts');
});

test('remember: resume restores the session; without remember there is no resume token', async () => {
  await h.shop();
  const l = h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD, remember: true, device: { name: 'Pixel' } }));
  assert.ok(l.resumeToken);
  const r = h.expectOk(await h.api.post('auth/resume', { sessionId: l.sessionId, resumeToken: l.resumeToken }));
  assert.ok(r.accessToken);
  assert.equal(r.me.email, 'chu@tiem.test');
  h.expectOk(await h.api.get('home', r.accessToken));
  h.expectErr(await h.api.post('auth/resume', { sessionId: l.sessionId, resumeToken: 'wrong' }), 401, 'session_expired');
  const plain = h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD }));
  h.expectErr(await h.api.post('auth/resume', { sessionId: plain.sessionId, resumeToken: 'x' }), 401, 'session_expired');
});

test('logout kills the session and its resume token; refresh rotates and detects reuse', async () => {
  await h.shop();
  const l = h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD, remember: true }));
  const r1 = h.expectOk(await h.api.post('auth/refresh', { refreshToken: l.refreshToken }));
  h.expectErr(await h.api.post('auth/refresh', { refreshToken: l.refreshToken }), 401, 'session_expired'); // reuse -> session revoked
  h.expectErr(await h.api.get('home', r1.accessToken), 401, 'session_expired');
  h.expectErr(await h.api.post('auth/resume', { sessionId: l.sessionId, resumeToken: l.resumeToken }), 401, 'session_expired');
  const l2 = h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD, remember: true }));
  assert.equal((await h.api.post('auth/logout', { refreshToken: l2.refreshToken }, l2.accessToken)).status, 204);
  h.expectErr(await h.api.get('home', l2.accessToken), 401, 'session_expired');
  h.expectErr(await h.api.post('auth/resume', { sessionId: l2.sessionId, resumeToken: l2.resumeToken }), 401, 'session_expired');
});

test('change password: errors, other devices signed out; forgot always accepted; reset', async () => {
  const s = await h.shop();
  const other = h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: h.PASSWORD, device: { name: 'Tablet' } }));
  h.expectErr(await h.api.post('auth/change-password', { current: 'Sai12345', next: 'Matkhau456' }, s.token), 422, 'wrong_password');
  h.expectErr(await h.api.post('auth/change-password', { current: h.PASSWORD, next: h.PASSWORD }, s.token), 422, 'same_password');
  h.expectErr(await h.api.post('auth/change-password', { current: h.PASSWORD, next: 'abc' }, s.token), 422, 'weak_password');
  h.expectOk(await h.api.post('auth/change-password', { current: h.PASSWORD, next: 'Matkhau456' }, s.token));
  h.expectErr(await h.api.get('home', other.accessToken), 401, 'session_expired');
  h.expectOk(await h.api.get('home', s.token));

  const a = h.expectOk(await h.api.post('auth/forgot', { email: 'chu@tiem.test' }), 202);
  const b = h.expectOk(await h.api.post('auth/forgot', { email: 'ghost@tiem.test' }), 202);
  assert.equal(a.status, b.status);
  assert.ok(a.devToken);
  assert.equal(b.devToken, undefined);
  assert.equal((await h.api.post('auth/reset', { token: a.devToken, password: 'Matkhau789' })).status, 204);
  h.expectOk(await h.api.post('auth/login', { email: 'chu@tiem.test', password: 'Matkhau789' }));
  h.expectErr(await h.api.get('home', s.token), 401, 'session_expired');
});

test('admins: add, same rights, revoke (last_admin), reset password, shops are isolated', async () => {
  const s = await h.shop();
  const other = await h.shop('khac@tiem.test', 'Tiệm Khác');
  const added = h.expectOk(await h.api.post('admins', { email: 'nv@tiem.test', name: 'Nhân viên', password: h.PASSWORD }, s.token), 201);
  const nv = h.expectOk(await h.api.post('auth/login', { email: 'nv@tiem.test', password: h.PASSWORD }));
  assert.equal(nv.shop.id, s.shopId);
  assert.equal(h.expectOk(await h.api.get('admins', nv.accessToken)).items.length, 2);
  h.expectOk(await h.api.post('categories', { name: 'X' }, nv.accessToken), 201);
  assert.equal(h.expectOk(await h.api.get('categories', s.token)).items.length, 1); // shared by the shop
  assert.equal(h.expectOk(await h.api.get('categories', other.token)).items.length, 0); // not by another shop
  h.expectErr(await h.api.post('admins/' + added.id + '/revoke', {}, other.token), 404, 'not_found');

  h.expectOk(await h.api.post(`admins/${added.id}/reset-password`, { password: 'Doimoi123' }, s.token), 204);
  h.expectErr(await h.api.get('home', nv.accessToken), 401, 'session_expired');
  h.expectOk(await h.api.post(`admins/${added.id}/revoke`, {}, s.token));
  h.expectErr(await h.api.post('auth/login', { email: 'nv@tiem.test', password: 'Doimoi123' }), 403, 'account_revoked');
  const me = h.expectOk(await h.api.get('admins', s.token)).items.find((a) => a.email === 'chu@tiem.test');
  h.expectErr(await h.api.post(`admins/${me.id}/revoke`, {}, s.token), 409, 'last_admin');
});

test('delete account: wrong password, then non-last admin only itself, last admin takes the shop', async () => {
  const s = await h.shop();
  const w = await h.world(s.token);
  h.expectOk(await h.api.post('admins', { email: 'nv@tiem.test', name: 'NV', password: h.PASSWORD }, s.token), 201);
  const nv = h.expectOk(await h.api.post('auth/login', { email: 'nv@tiem.test', password: h.PASSWORD }));
  h.expectErr(await h.api.del('me', { password: 'Sai12345' }, nv.accessToken), 422, 'wrong_password');
  assert.equal((await h.api.del('me', { password: h.PASSWORD }, nv.accessToken)).status, 204);
  assert.equal(await h.models.Account.countDocuments({ shopId: s.shopId }), 1);
  assert.ok(await h.models.Piece.countDocuments({ shopId: s.shopId }));
  assert.equal((await h.api.del('me', { password: h.PASSWORD }, s.token)).status, 204);
  for (const M of [h.models.Account, h.models.Piece, h.models.Style, h.models.Customer, h.models.Setting, h.models.Session]) {
    assert.equal(await M.countDocuments({}), 0, M.modelName);
  }
  void w;
});

test('public pages', async () => {
  assert.equal((await h.request(h.app).get('/privacy')).status, 200);
  assert.equal((await h.request(h.app).get('/account/delete')).status, 200);
  assert.equal((await h.api.get('health')).body.status, 'ok');
});
