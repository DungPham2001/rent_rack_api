/**
 * Public privacy policy page (Google Play requirement): GET /privacy (?lang=en).
 * The text describes what this API actually stores; keep it in sync when data handling changes.
 * Owner and contact come from PRIVACY_OWNER / PRIVACY_EMAIL (defaults below).
 */
const express = require('express');
const config = require('../config');
const { langOf } = require('../i18n');

const OWNER = process.env.PRIVACY_OWNER || 'TMSC Developer';
const EMAIL = process.env.PRIVACY_EMAIL || 'support@tmsc-vn.com';
const UPDATED = '2026-11-19';

const esc = (s) => String(s).replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));

const base = () => config.publicBaseUrl || '';
const mail = `<a href="mailto:${esc(EMAIL)}">${esc(EMAIL)}</a>`;

/** [heading, [paragraph | list items array]] */
const content = {
  vi: {
    title: 'Chính sách quyền riêng tư RentRack',
    updated: `Cập nhật lần cuối: ${UPDATED.split('-').reverse().join('/')}`,
    other: '<a href="?lang=en">English</a>',
    sections: [
      ['Chúng tôi là ai', [
        `RentRack là ứng dụng quản lý tiệm cho thuê trang phục dành cho chủ tiệm và nhân viên, do <strong>${esc(OWNER)}</strong> phát triển và chịu trách nhiệm về dữ liệu. Liên hệ: ${mail}.`,
      ]],
      ['Dữ liệu chúng tôi lưu', [[
        '<strong>Tài khoản quản trị:</strong> email, họ tên, số điện thoại, ngôn ngữ, mật khẩu (chỉ lưu dạng đã băm), tên thiết bị và thời điểm đăng nhập gần nhất.',
        '<strong>Dữ liệu của tiệm:</strong> hồ sơ tiệm, danh mục trang phục, bảng giá, nhân viên, đơn thuê, thu chi, giặt ủi, chi phí.',
        '<strong>Dữ liệu khách thuê do tiệm nhập:</strong> tên, số điện thoại, ghi chú, số đo và tên người mặc, địa chỉ giao nhận. Khách thuê không có tài khoản và không dùng ứng dụng.',
        '<strong>Dữ liệu kỹ thuật:</strong> địa chỉ IP lưu tạm để chống truy cập dồn dập, tự xóa sau tối đa khoảng 2 ngày; nhật ký máy chủ chỉ ghi loại yêu cầu, đường dẫn, mã kết quả và thời gian xử lý, không ghi nội dung, mật khẩu hay mã truy cập.',
      ]]],
      ['Dữ liệu chúng tôi không thu thập', [
        'Không vị trí, danh bạ, micro, camera hay thư viện ảnh; không quảng cáo; không bán hay cho thuê dữ liệu. Ứng dụng không xử lý thanh toán trực tuyến: tiền mặt và chuyển khoản chỉ được tiệm ghi nhận thủ công. Thông báo nhắc việc được tạo ngay trên máy, không đẩy từ máy chủ.',
      ]],
      ['Mục đích sử dụng', [[
        'Đăng nhập, giữ phiên làm việc và quản lý nhiều quản trị viên của một tiệm.',
        'Quản lý đơn thuê, lịch, tiền cọc, giặt ủi, báo cáo của tiệm.',
        'Gửi email cần thiết: mã đặt lại mật khẩu và thông báo đổi mật khẩu. Không gửi email quảng cáo.',
      ]]],
      ['Ai xem được dữ liệu', [[
        'Chỉ các quản trị viên của cùng một tiệm. Dữ liệu của mỗi tiệm được tách riêng; tiệm này không thấy dữ liệu của tiệm khác.',
        'Nhà cung cấp hạ tầng xử lý dữ liệu thay chúng tôi: MongoDB Atlas (cơ sở dữ liệu), Vercel (máy chủ API), dịch vụ gửi email. Họ không được dùng dữ liệu cho mục đích riêng.',
        'Cơ quan nhà nước khi pháp luật yêu cầu.',
      ]]],
      ['Bảo mật', [
        'Mọi kết nối dùng HTTPS. Mật khẩu chỉ lưu dạng băm. Mã truy cập hết hạn sau 2 giờ và thu hồi được; máy chủ kiểm tra phiên và tài khoản ở mọi yêu cầu. Mã ghi nhớ đăng nhập chỉ lưu dạng băm và hết hạn sau 30 ngày không dùng.',
      ]],
      ['Thời gian lưu và xóa dữ liệu', [[
        'Dữ liệu được giữ trong thời gian tiệm còn tồn tại. Mã đặt lại mật khẩu hết hạn sau 30 phút.',
        `Bạn xóa tài khoản ngay trong ứng dụng (Tài khoản &gt; Hồ sơ &gt; Xóa tài khoản) hoặc tại <a href="${base()}/account/delete">trang xóa tài khoản</a>. Nếu bạn là quản trị viên cuối cùng của tiệm, toàn bộ dữ liệu của tiệm cũng bị xóa thật, không khôi phục được; bản sao lưu được xóa theo chu kỳ lưu trữ của nhà cung cấp hạ tầng.`,
      ]]],
      ['Quyền của bạn', [
        `Bạn có quyền xem, sửa, xuất (CSV trong ứng dụng) và xóa dữ liệu theo quy định pháp luật về bảo vệ dữ liệu cá nhân. Khách thuê có thể yêu cầu tiệm xóa thông tin của mình, hoặc gửi yêu cầu về ${mail}.`,
      ]],
    ],
  },
  en: {
    title: 'RentRack privacy policy',
    updated: `Last updated: ${UPDATED}`,
    other: '<a href="?lang=vi">Tiếng Việt</a>',
    sections: [
      ['Who we are', [
        `RentRack is a management app for costume-rental shops (owners and staff), developed by <strong>${esc(OWNER)}</strong>, who is responsible for the data. Contact: ${mail}.`,
      ]],
      ['Data we store', [[
        '<strong>Admin account:</strong> email, name, phone, language, password (stored only as a hash), device name and last sign-in time.',
        '<strong>Shop data:</strong> shop profile, costume catalog, prices, staff, rental orders, payments, laundry, expenses.',
        '<strong>Renter data typed in by the shop:</strong> name, phone, notes, measurements and names of the people wearing the costumes, delivery addresses. Renters have no account and do not use the app.',
        '<strong>Technical data:</strong> IP addresses kept briefly to stop request floods (deleted after about 2 days); server logs record only method, path, status and timing, never bodies, passwords or tokens.',
      ]]],
      ['Data we do not collect', [
        'No location, contacts, microphone, camera or photo library; no ads; no selling or renting of data. The app does not process online payments: cash and bank transfers are recorded manually by the shop. Reminders are created on the device, not pushed by the server.',
      ]],
      ['How we use it', [[
        'Sign-in, session handling and managing several admins of one shop.',
        'Managing rental orders, the schedule, deposits, laundry and the shop\'s reports.',
        'Necessary email only: password reset code and password-changed notice. No marketing email.',
      ]]],
      ['Who can see the data', [[
        'Only the admins of the same shop. Each shop\'s data is kept separate; one shop cannot see another\'s.',
        'Infrastructure providers process data on our behalf: MongoDB Atlas (database), Vercel (API servers), an email service. They may not use the data for their own purposes.',
        'Public authorities when the law requires it.',
      ]]],
      ['Security', [
        'All connections use HTTPS. Passwords are stored only as hashes. Access tokens expire after 2 hours and can be revoked; the server checks the session and the account on every request. The "remember me" token is stored only as a hash and expires after 30 days of non-use.',
      ]],
      ['Retention and deletion', [[
        'Data is kept while the shop exists. Password reset codes expire after 30 minutes.',
        `You can delete your account in the app (Account &gt; Profile &gt; Delete account) or on the <a href="${base()}/account/delete">account deletion page</a>. If you are the last admin of the shop, all of the shop's data is permanently deleted too and cannot be recovered; backups are removed on the infrastructure provider's retention cycle.`,
      ]]],
      ['Your rights', [
        `You may view, correct, export (CSV in the app) and delete data as provided by personal-data protection law. Renters can ask the shop to delete their details, or write to ${mail}.`,
      ]],
    ],
  },
};

function render(lang) {
  const t = content[lang];
  const body = t.sections.map(([h, parts]) => `<h2>${h}</h2>${parts.map((p) => (Array.isArray(p) ? `<ul>${p.map((li) => `<li>${li}</li>`).join('')}</ul>` : `<p>${p}</p>`)).join('')}`).join('\n');
  return `<!doctype html><html lang="${lang}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${t.title}</title>
<style>
:root{--bg:#f7f7f5;--fg:#1d1d1b;--muted:#5d5d58;--card:#fff;--line:#d9d9d4;--accent:#8e3b5c}
@media (prefers-color-scheme:dark){:root{--bg:#161615;--fg:#ecece8;--muted:#a5a59f;--card:#20201e;--line:#3a3a37;--accent:#e7a8c0}}
body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.6 system-ui,sans-serif}
main{max-width:720px;margin:0 auto;padding:32px 16px 48px}
.card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:24px}
h1{font-size:24px;margin:0 0 4px;color:var(--accent)}h2{font-size:18px;margin:28px 0 8px}
.meta{color:var(--muted);font-size:14px;margin:0 0 8px}p,li{margin:0 0 10px}ul{padding-left:20px;margin:0}
a{color:var(--accent)}nav{margin-top:16px;font-size:14px}
</style></head><body><main><div class="card">
<h1>${t.title}</h1><p class="meta">${t.updated}</p>
${body}
</div><nav>${t.other}</nav></main></body></html>`;
}

const pickLang = (req) => (req.query.lang === 'en' || req.query.lang === 'vi' ? req.query.lang : langOf(req.get('accept-language')));

const router = express.Router();
router.get('/privacy', (req, res) => res.type('html').send(render(pickLang(req))));

module.exports = router;
