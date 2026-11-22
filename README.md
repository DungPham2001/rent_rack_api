# RentRack — API

Node.js (Express 4) + MongoDB (Mongoose 8) cho app Android **RentRack** (quản lý tiệm cho thuê trang phục, nhiều tiệm, mỗi tiệm nhiều admin).
Cùng kiến trúc với `seat_route_api` / `RoomKeepAPI`: entry Vercel ở `api/`, rate limit lưu trong Mongo, test trên MongoDB in-memory (replica set).

- Hợp đồng đề xuất cho BE: [docs/RentRack-API-cho-BE.md](docs/RentRack-API-cho-BE.md)
- Tài liệu ghép cho FE (đã làm gì, khác gì, trả lời các câu hỏi mở): [docs/API-cho-FE.md](docs/API-cho-FE.md)

```bash
cp .env.example .env     # MONGODB_URI (database: rentrack), JWT_SECRET, SMTP...
npm install
npm run db:init          # collection + index (không có tài khoản mặc định: tiệm tự đăng ký)
npm run dev              # http://localhost:4000/v1/health
npm run seed:demo        # dữ liệu mẫu (demo@rentrack.vn / Demo1234); thêm -- --reset để dựng lại. Chỉ dùng DB test
npm test                 # 26 test, dùng mongod local nếu có (/opt/homebrew/bin/mongod)
```

## Cấu trúc

| Thư mục | Nội dung |
|---|---|
| `src/models/index.js` | collection dùng chung (tài khoản, phiên, idempotency) và theo tiệm (đơn, thanh toán, giữ chỗ, giặt ủi, ca…) |
| `src/resources/` | `engine.js` + `defs.js`: ~35 bảng danh mục khai báo một lần → model + kiểm tra + CRUD + `If-Match` + tombstone |
| `src/lib/tenant*.js` | tách dữ liệu theo `shopId` (AsyncLocalStorage + plugin Mongoose): service không thể đọc/ghi dữ liệu tiệm khác |
| `src/services/pricing.js` | báo giá (bậc 1/3/7 ngày, cao điểm, cọc, gói, giá đặc biệt, mã/giảm tự động/điểm) |
| `src/services/schedule.js` | lịch và chống trùng (ngày đệm giặt ủi), món trống, lịch món, gợi ý size |
| `src/services/orders.js`, `orderFlow.js` | tạo đơn, thanh toán, giao, nhận trả, quyết toán, hủy, đổi ngày/món |
| `src/services/ledger.js` | cách tính tiền đã thu, cọc đang giữ, doanh thu |
| `src/services/holds.js`, `cleaning.js`, `finance.js` | giữ chỗ, giặt ủi/sửa + cổng QC, ca/sổ quỹ/chốt ngày |
| `src/services/home.js`, `reports.js` | màn Tổng quan, nguồn nhắc việc, báo cáo |
| `src/services/accounts.js`, `tokens.js` | đăng ký tiệm, đăng nhập, refresh xoay vòng, "Ghi nhớ" (resume), quên/đổi mật khẩu, admin, xóa tài khoản |

## Deploy (Vercel)

`vercel.json` chuyển mọi request vào `api/index.js` (region `sin1`; cron `/v1/jobs/run` mỗi ngày). Đặt `MONGODB_URI`, `JWT_SECRET` (≥ 32 ký tự), `CRON_SECRET`, `PUBLIC_BASE_URL`, SMTP; chạy `npm run db:init` một lần. Cần MongoDB **replica set** (Atlas) để các lệnh nhiều bước chạy trong giao dịch; trên mongod đơn lẻ vẫn chạy nhưng không có giao dịch và không chặn được hai người đặt cùng một món cùng lúc.
