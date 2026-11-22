/**
 * Demo data for one shop, built through the real API (so prices, deposits, points and piece statuses are consistent).
 * Dates are relative to today. Use a TEST database or a local one, never a production database:
 *   MONGODB_URI=mongodb://127.0.0.1:27017/rentrack_demo npm run seed:demo
 *   npm run seed:demo -- --reset      # delete the demo shop first, then seed again
 * Sign in with:  demo@rentrack.vn / Demo1234
 */
process.env.RATE_LIMIT = 'off'; // hundreds of calls from one IP: the per-IP limits would block the seed
const mongoose = require('mongoose');
const request = require('supertest');
const config = require('../src/config');
const models = require('../src/models');
const app = require('../src/app');
const T = require('../src/lib/time');
const { purgeShop } = require('../src/services/privacy');

const EMAIL = 'demo@rentrack.vn';
const PASSWORD = 'Demo1234';
const d = (n) => T.addDays(T.today(), n);
const DAY = 86400000;

let token;
const call = async (method, path, body, headers = {}) => {
  const res = await request(app)[method](`/v1/${path}`).set({ Authorization: `Bearer ${token}`, ...headers }).send(body);
  if (res.status >= 300) throw new Error(`${method.toUpperCase()} ${path} -> ${res.status} ${JSON.stringify(res.body)}`);
  return res.body;
};
const post = (p, b, h) => call('post', p, b, h);

async function main() {
  if (/mongodb\+srv|\.mongodb\.net/.test(config.mongoUri) && !process.argv.includes('--yes')) {
    throw new Error('MONGODB_URI looks like a remote cluster: add --yes only if this is a test database.');
  }
  await mongoose.connect(config.mongoUri);
  for (const name of mongoose.modelNames()) await mongoose.model(name).syncIndexes();
  const old = await models.Account.findOne({ email: EMAIL }).lean();
  if (old) {
    if (!process.argv.includes('--reset')) throw new Error(`${EMAIL} already exists: run with --reset to rebuild it.`);
    await purgeShop(old.shopId);
  }

  const reg = await request(app).post('/v1/auth/register-shop').send({
    shopName: 'Tiệm Váy Hoa Mai', shopPhone: '0901234567', address: '25 Hàng Gai, Hoàn Kiếm, Hà Nội', ownerName: 'Trần Thị Mai', email: EMAIL, password: PASSWORD, device: { name: 'Seed' },
  });
  if (reg.status !== 201) throw new Error(JSON.stringify(reg.body));
  token = reg.body.accessToken;

  // ---------- settings ----------
  await call('put', 'settings/shop', { name: 'Tiệm Váy Hoa Mai', phone: '0901234567', address: '25 Hàng Gai, Hoàn Kiếm, Hà Nội', owner: 'Trần Thị Mai', desc: 'Cho thuê áo dài, váy cưới, vest, đầm dạ hội' });
  await call('put', 'settings/policy', { text: 'Giữ chỗ 30% khi đặt. Trả đồ đúng hạn, trễ tính phí theo ngày. Làm hỏng/mất đền theo bảng phí. Cọc hoàn sau khi kiểm tra.' });
  const rules = await call('get', 'settings/rules');
  await call('put', 'settings/rules', { ...rules, lateValue: 100000, holdPct: 30, depositPct: 50 });

  // ---------- catalog ----------
  const cat = {};
  for (const [i, name] of ['Áo dài', 'Váy cưới', 'Vest', 'Đầm dạ hội'].entries()) cat[name] = (await post('categories', { name, sort: i })).id;
  const acc = {};
  for (const [name, kind, qtyTotal, lostFee] of [['Khăn đóng', 'Đầu', 12, 150000], ['Giày cao gót', 'Giày', 10, 400000], ['Cài áo ngọc trai', 'Trang sức', 15, 120000], ['Voan cô dâu', 'Phụ kiện', 6, 500000]]) {
    acc[name] = (await post('accessories', { name, kind, track: 'qty', qtyTotal, lostFee })).id;
  }
  const STYLES = [
    ['AD01', 'Áo dài lụa đỏ đô', 'Áo dài', 'Đỏ', 'Lụa', ['cưới', 'tết'], 350000, ['S', 'M', 'L'], 2200000],
    ['AD02', 'Áo dài gấm xanh ngọc', 'Áo dài', 'Xanh', 'Gấm', ['tết', 'lễ'], 300000, ['M', 'L'], 1800000],
    ['AD03', 'Áo dài trắng thêu hoa', 'Áo dài', 'Trắng', 'Voan', ['tốt nghiệp'], 250000, ['S', 'M'], 1500000],
    ['VC01', 'Váy cưới công chúa', 'Váy cưới', 'Trắng', 'Ren', ['cưới'], 1200000, ['S', 'M'], 9000000],
    ['VC02', 'Váy cưới đuôi cá', 'Váy cưới', 'Ngà', 'Satin', ['cưới'], 1500000, ['M', 'L'], 11000000],
    ['VS01', 'Vest nam xanh navy', 'Vest', 'Xanh navy', 'Wool', ['cưới', 'sự kiện'], 400000, ['M', 'L', 'XL'], 3000000],
    ['DH01', 'Đầm dạ hội đen', 'Đầm dạ hội', 'Đen', 'Nhung', ['sự kiện'], 600000, ['S', 'M'], 4000000],
    ['DH02', 'Đầm dạ hội hồng pastel', 'Đầm dạ hội', 'Hồng', 'Tơ', ['sự kiện', 'sinh nhật'], 500000, ['S', 'M', 'L'], 3200000],
  ];
  const style = {};
  const piece = {};
  const pieceList = [];
  for (const [code, name, c, color, material, occasions, day, sizes, buy] of STYLES) {
    const st = await post('styles', { code, name, categoryId: cat[c], color, material, occasions, featured: ['AD01', 'VC01'].includes(code), desc: `${name} - ${material}`, sizes: sizes.map((label) => ({ label, measures: {} })), defaultAcc: c === 'Áo dài' ? [{ accessoryId: acc['Khăn đóng'], qty: 1 }] : [] });
    style[code] = st.id;
    await post('prices', { styleId: st.id, day: Math.round(day * 0.9), tier3: Math.round(day * 2.4 * 0.9), tier7: Math.round(day * 4.5 * 0.9), extraDay: Math.round(day * 0.7 * 0.9), from: d(-120) }); // old price list
    await post('prices', { styleId: st.id, day, tier3: Math.round(day * 2.4), tier7: Math.round(day * 4.5), extraDay: Math.round(day * 0.7), from: d(-60) });
    for (const [i, size] of sizes.entries()) {
      const p = await post('pieces', { code: `${code}-${size}`, styleId: st.id, size, purchasePrice: buy, purchasedDate: d(-100 - i * 10), maxRentals: c === 'Váy cưới' ? 30 : 60, shelf: `${c[0]}${i + 1}`, measures: { bust: { mm: 860 + i * 40, adj: 30 }, waist: { mm: 680 + i * 40, adj: 30 }, hip: { mm: 920 + i * 40, adj: 30 } } });
      piece[p.code] = p.id;
      pieceList.push(p.code);
    }
  }
  await post('bundles', { name: 'Combo áo dài + khăn đóng', price: 450000, items: 'Áo dài, khăn đóng, giày', from: d(-60) });
  await post('deposit-rules', { styleId: style.VC01, kind: 'pct', value: 30 });
  await post('deposit-rules', { styleId: style.VC02, kind: 'fixed', value: 3000000 });
  for (const [kind, name, amount] of [['wash', 'Giặt khô', 80000], ['damage', 'Rách / hư hỏng', 300000], ['lostAcc', 'Mất phụ kiện', 150000], ['lostPiece', 'Mất trang phục', 2000000], ['late', 'Trễ hạn / ngày', 100000], ['other', 'Phí khác', 50000]]) await post('fees', { kind, name, amount });
  const zone = await post('zones', { name: 'Nội thành Hà Nội', fee: 50000 });
  await post('zones', { name: 'Ngoại thành', fee: 120000 });
  await post('peaks', { name: 'Tết Nguyên Đán', from: d(40), to: d(55), kind: 'pct', value: 20 });
  await post('peaks', { name: 'Mùa cưới', from: d(-10), to: d(20), kind: 'amount', value: 100000 });
  await post('promos', { code: 'CHAOBAN', kind: 'pct', value: 10, minAmount: 500000, start: d(-30), end: d(60), limit: 100 });
  await post('discounts', { name: 'Thuê từ 2 bộ', kind: 'pct', value: 8, minItems: 2 });
  await post('discounts', { name: 'Khách quen', kind: 'amount', value: 50000, regularOnly: true });
  await call('put', 'settings/loyalty', { per: 10000, value: 100, tiers: [{ name: 'Thân thiết', minPoints: 0 }, { name: 'Bạc', minPoints: 100 }, { name: 'Vàng', minPoints: 300 }] });
  const rooms = [await post('rooms', { name: 'Phòng thử 1' }), await post('rooms', { name: 'Phòng thử 2' })];
  const staff = {};
  for (const [name, phone, role, position] of [['Lê Thu Hà', '0912000001', 'sales', 'Thu ngân'], ['Phạm Văn Nam', '0912000002', 'delivery', 'Giao nhận'], ['Nguyễn Thị Lan', '0912000003', 'laundry', 'Giặt ủi'], ['Bùi Thanh Tâm', '0912000004', 'tailor', 'Thợ may']]) {
    staff[role] = (await post('staff', { name, phone, role, position, joined: d(-300), status: 'active' })).id;
  }
  const partner = await post('partners', { name: 'Giặt khô Sạch Sẽ', phone: '0243888999', priceNote: '60k/bộ áo dài, 150k/váy cưới' });
  const supplier = await post('suppliers', { name: 'Xưởng may Hoa Hồng', phone: '0243777666', priceNote: 'Nhận may theo mẫu' });
  for (const [name, unit, qty, min] of [['Túi đựng váy', 'cái', 40, 15], ['Móc treo', 'cái', 60, 20], ['Nước giặt chuyên dụng', 'lít', 3, 5]]) {
    const s = await post('supplies', { name, unit, min });
    await post(`supplies/${s.id}/move`, { type: 'in', qty, note: 'Nhập kho đầu kỳ' });
  }
  for (const [category, amount, recurring, note] of [['rent', 12000000, true, 'Thuê mặt bằng'], ['power', 1800000, true, 'Điện nước'], ['salary', 16000000, true, 'Lương nhân viên'], ['ads', 2500000, false, 'Quảng cáo Facebook'], ['wash', 900000, false, 'Giặt khô đối tác']]) {
    await post('expenses', { category, amount, date: d(-25), recurring, note });
  }
  await post('targets', { month: d(0).slice(0, 7), amount: 60000000 });
  for (const [kind, title] of [['qc', 'Đã giặt sạch'], ['qc', 'Đã ủi phẳng'], ['qc', 'Kiểm tra đường may'], ['out', 'Đủ phụ kiện đi kèm'], ['in', 'Kiểm tra hư hỏng, vết bẩn']]) await post('checklists', { kind, title });
  await post('care-notes', { material: 'Lụa', text: 'Giặt khô, không vắt, ủi nhiệt thấp.' });
  await post('care-notes', { material: 'Ren', text: 'Giặt tay nhẹ, phơi phẳng.' });
  await post('faq', { q: 'Đặt cọc bao nhiêu?', a: 'Giữ chỗ 30% tiền thuê, cọc theo giá trị trang phục, hoàn khi trả đồ.', sort: 1 });
  await post('todos', { title: 'Kiểm kê phụ kiện cuối tuần', due: d(2), repeat: 'weekly' });
  await post('todos', { title: 'Chụp ảnh mẫu mới', due: d(5) });
  await post('notes', { title: 'Khách VIP', text: 'Chị Hương hay thuê váy cưới, ưu tiên size S.' });

  const people = [['Nguyễn Văn An', '0912345678', ['regular']], ['Trần Thị Bình', '0923456789', []], ['Lê Hoàng Cường', '0934567890', ['regular']], ['Phạm Thu Dung', '0945678901', []], ['Vũ Minh Đức', '0956789012', []], ['Hoàng Thị Hương', '0967890123', ['regular']], ['Đỗ Quang Huy', '0978901234', []], ['Bùi Ngọc Lan', '0989012345', []]];
  const cust = [];
  for (const [name, phone, tags] of people) cust.push(await post('customers', { name, phone, tags, note: tags.length ? 'Khách quen' : '', people: [{ name: `${name.split(' ').pop()} (người nhà)`, relation: 'Người thân' }] }));
  await call('patch', `customers/${cust[3].id}`, { attention: 'Hay trả đồ muộn, nhắc trước 1 ngày' });

  // ---------- orders ----------
  const backdate = async (orderId, days) => {
    const shift = (t) => (t ? new Date(new Date(t).getTime() - days * DAY) : t);
    const o = await models.Order.findById(orderId).lean();
    await models.Order.updateOne({ _id: orderId }, { $set: { createdAt: shift(o.createdAt), updatedAt: shift(o.updatedAt), deliveredAt: shift(o.deliveredAt), returnedAt: shift(o.returnedAt), 'lines.$[].returnedAt': null } });
    await models.Order.updateOne({ _id: orderId }, { $set: Object.fromEntries(o.lines.map((l, i) => [`lines.${i}.returnedAt`, shift(l.returnedAt)])) });
    for (const p of await models.Payment.find({ orderId }).lean()) await models.Payment.updateOne({ _id: p._id }, { $set: { at: shift(p.at) } });
    for (const M of [models.Delivery, models.Return]) for (const x of await M.find({ orderId }).lean()) await M.updateOne({ _id: x._id }, { $set: { at: shift(x.at) } });
    for (const j of await models.Cleaning.find({ orderId }).lean()) await models.Cleaning.updateOne({ _id: j._id }, { $set: { startedAt: shift(j.startedAt), returnedAt: shift(j.returnedAt), dueAt: shift(j.dueAt) } });
    for (const l of await models.Loyalty.find({ refId: orderId }).lean()) await models.Loyalty.updateOne({ _id: l._id }, { $set: { at: shift(l.at) } });
  };
  const rent = async ({ c, pieces, from, to, source = 'phone', paid = 'hold', deliver = false, ret = null, fees = null, ago = 0, promo, method = 'cash', extra = {} }) => {
    const draft = { customerId: cust[c].id, source, receiveDate: d(from), dueDate: d(to), receiveMinute: 9 * 60 + 30, lines: pieces.map((p, i) => ({ pieceId: piece[p], person: i ? 'Người thân' : cust[c].name.split(' ').pop() })), promoCode: promo, payMethod: method, ...extra };
    const q = await post('orders/quote', draft);
    const o = await post('orders', { ...draft, paidNow: paid === 'full' ? q.grand : q.hold }, { 'Idempotency-Key': `seed-${Math.random()}` });
    let cur = o;
    if (deliver) {
      cur = await post(`orders/${o.id}/deliver`, { collectRent: Math.max(0, q.grand - (paid === 'full' ? q.grand : q.hold)), collectDeposit: q.deposit, method, receiver: cust[c].name, staffId: staff.delivery, conditionOut: Object.fromEntries(o.lines.map((l) => [l.id, 'Lành lặn, đủ phụ kiện'])) });
    }
    if (ret) {
      cur = await post(`orders/${o.id}/return`, { checks: Object.fromEntries(o.lines.map((l) => [l.id, { clean: ret !== 'dirty', damage: ret === 'damaged' ? 'Rách viền váy' : '', decision: ret === 'damaged' ? 'repair' : 'wash' }])), staffId: staff.laundry });
    }
    if (fees) cur = (await post(`orders/${o.id}/settle`, { fees, method: 'cash', note: 'Đã kiểm tra' })).order;
    if (ago) await backdate(o.id, ago);
    return cur;
  };

  await post('shifts/open', { startCash: 2000000 });
  // completed, spread over the last weeks (revenue history)
  await rent({ c: 0, pieces: ['AD01-M'], from: -45, to: -42, source: 'zalo', paid: 'full', deliver: true, ret: 'ok', fees: {}, ago: 45 });
  await rent({ c: 1, pieces: ['VC01-S'], from: -38, to: -35, paid: 'full', deliver: true, ret: 'ok', fees: { wash: 150000 }, ago: 38 });
  await rent({ c: 2, pieces: ['VS01-L', 'AD02-M'], from: -30, to: -27, source: 'counter', paid: 'full', deliver: true, ret: 'ok', fees: {}, ago: 30, promo: 'CHAOBAN' });
  await rent({ c: 5, pieces: ['VC02-M'], from: -24, to: -20, paid: 'full', deliver: true, ret: 'damaged', fees: { damage: 600000 }, ago: 24 });
  await rent({ c: 3, pieces: ['DH01-S'], from: -17, to: -14, source: 'family', paid: 'full', deliver: true, ret: 'ok', fees: { late: 200000 }, ago: 17 });
  await rent({ c: 6, pieces: ['AD03-S', 'AD01-L'], from: -12, to: -9, paid: 'full', deliver: true, ret: 'ok', fees: {}, ago: 12 });
  await rent({ c: 4, pieces: ['DH02-M'], from: -8, to: -5, source: 'zalo', paid: 'full', deliver: true, ret: 'dirty', fees: { wash: 80000 }, ago: 8, method: 'transfer' });
  // out right now: due soon, due today, overdue
  await rent({ c: 7, pieces: ['VS01-M'], from: -2, to: 1, paid: 'full', deliver: true });
  await rent({ c: 0, pieces: ['AD02-L'], from: -3, to: 0, paid: 'full', deliver: true, source: 'zalo' });
  await rent({ c: 3, pieces: ['VC01-M'], from: -7, to: -3, paid: 'full', deliver: true });
  // upcoming
  const paid1 = await rent({ c: 1, pieces: ['AD01-S'], from: 2, to: 5, paid: 'full' });
  await rent({ c: 5, pieces: ['VC02-L'], from: 6, to: 9, paid: 'hold', extra: { receiveMode: 'delivery', receiveAddr: '12 Lý Thường Kiệt, Hà Nội', zoneId: zone.id } });
  await rent({ c: 2, pieces: ['DH02-S', 'DH02-L'], from: 10, to: 12, paid: 'hold', source: 'zalo' });
  const cancelled = await rent({ c: 4, pieces: ['AD03-M'], from: 8, to: 10, paid: 'hold' });
  await post(`orders/${cancelled.id}/cancel`, { refund: 0, reason: 'Khách đổi lịch' });
  // counter rental today (comp for the owner's relative)
  await post('orders', { customerId: cust[6].id, counter: true, source: 'counter', receiveDate: d(0), dueDate: d(2), lines: [{ pieceId: piece['DH01-M'], person: 'Huy' }], payMethod: 'comp', compReason: 'Tặng người nhà', paidNow: 0 });
  // a hold, fittings, one laundry job in progress and one repair
  const hold = await post('holds', { customerName: 'Chị Ngân', phone: '0911222333', pieceId: piece['AD02-M'], from: d(14), to: d(17), amount: 300000, method: 'transfer', note: 'Chờ chốt ngày cưới' });
  void hold;
  for (const [i, f] of [[0, { start: 600, end: 630 }], [1, { start: 630, end: 660 }], [0, { start: 840, end: 870 }]]) {
    await post('fittings', { date: d(1), ...f, roomId: rooms[i % 2].id, staffId: staff.sales, orderId: paid1.id, customerId: cust[1].id, pieceId: piece['AD01-S'], person: 'Bình' });
  }
  await post('waits', { customerId: cust[4].id, styleId: style.VC01, size: 'S', from: d(6), to: d(8), note: 'Chờ váy size S cuối tuần' });
  await post('missed', { date: d(-3), styleId: style.VC02, size: 'S', name: 'Khách lẻ', note: 'Hết size S' });
  await post('tasks', { staffId: staff.delivery, date: d(0), kind: 'delivery', ref: '', pay: 50000, done: false });
  await post('schedules', { staffId: staff.laundry, date: d(1), kind: 'off' });
  const jobs = (await call('get', 'cleaning?open=true')).items;
  const items = (await call('get', 'checklists?kind=qc')).items;
  for (const [i, job] of jobs.entries()) {
    if (i === jobs.length - 1) { await call('patch', `cleaning/${job.id}`, { partnerId: partner.id, cost: 150000 }); continue; } // leave one waiting at the partner
    for (const it of items) await call('put', `cleaning/${job.id}/qc`, { itemId: it.id, value: true });
    await post(`cleaning/${job.id}/move`, { status: 'done' });
  }
  await post('purchases', { supplierId: supplier.id, cost: 2400000, date: d(-5), piece: { code: 'AD01-XL', styleId: style.AD01, size: 'XL', maxRentals: 60 } });

  const counts = {};
  for (const n of ['Style', 'Piece', 'Customer', 'Order', 'Payment', 'Hold', 'Cleaning']) counts[n] = await mongoose.model(n).countDocuments({ shopId: reg.body.shop.id });
  console.log(`Seeded shop "${reg.body.shop.name}"`, counts);
  console.log(`Sign in:  ${EMAIL} / ${PASSWORD}`);
  await mongoose.disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await mongoose.disconnect().catch(() => {});
  process.exit(1);
});
