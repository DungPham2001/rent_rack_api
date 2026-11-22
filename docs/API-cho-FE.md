# RentRack API — tài liệu ghép cho FE (Flutter)

Hiện thực của hợp đồng trong [RentRack-API-cho-BE.md](RentRack-API-cho-BE.md). Mọi đường dẫn có tiền tố `/v1`, body JSON UTF-8, chỉ HTTPS khi lên production. Mục này chỉ nói **cái BE đã làm và những chỗ khác/thêm so với đề xuất**; quy tắc nghiệp vụ chi tiết vẫn theo tài liệu BE (mục 5–9).

## 1. Quy ước

| | |
|---|---|
| Xác thực | `Authorization: Bearer <accessToken>` mọi nơi trừ `health`, `auth/register-shop`, `login`, `resume`, `refresh`, `forgot`, `reset`, `logout` (Bearer tùy chọn), `jobs/run` (cron) |
| Đa tiệm | `shopId` lấy từ token. Id của tiệm khác luôn trả `404 not_found` |
| Header | `Accept-Language: vi\|en`, `Idempotency-Key` (UUID), `If-Match: <updatedAt>`, `X-App-Version` (nhỏ hơn bản tối thiểu → `426 upgrade_required`) |
| Kiểu | tiền: số nguyên VND; ngày `yyyy-MM-dd`; thời điểm ISO-8601 **UTC, có mili giây, hậu tố `Z`**; giờ trong ngày: số phút từ 0h |
| Id | BE tự sinh; `POST` chấp nhận `id` do client gửi (`[\w.:-]{1,64}`); gửi lại cùng `id` → `200` trả bản đã có (thử lại an toàn) |
| Mỗi bản ghi | `id, createdAt, updatedAt` |
| Danh sách | `{ "items": [...], "nextCursor": "..."\|null, "total": n }`, `?limit=&cursor=`. Danh mục nhỏ trả hết (mặc định 500); danh sách lớn (đơn, món, khách, chi phí, giữ chỗ, giặt ủi…) mặc định 50, tối đa 200 |
| Lọc chung | `?q=` (tìm không dấu), `?updatedSince=<ISO>`, `?from=&to=` trên bảng có trường ngày, và các trường lọc riêng (vd `pieces?status=ready&styleId=`) |
| Đồng thời | `PATCH`/`DELETE` bảng danh mục nhận `If-Match: <updatedAt>`; lệch → `409 conflict` kèm `current` (bản mới nhất). Đơn thuê không dùng `If-Match`: mọi bước đổi trạng thái đã được chặn theo trạng thái hiện tại |
| Lỗi | `{ "code", "message", "data"?, "fields"?, "requestId" }`. App dịch theo `code` |

### Lỗi
- Các endpoint `auth/*`, `admins` dùng đúng mã của tài liệu BE với HTTP 422: `required_missing`, `invalid_email`, `weak_password`, `wrong_password`, `same_password`.
- Chỗ khác sai dữ liệu → `400 validation_failed` với `fields: [{ field, code }]` (`required`, `invalid_type`, `invalid_format`, `invalid_enum`, `out_of_range`, `too_short`, `too_long`).
- Sai quy tắc nghiệp vụ cụ thể → `422 invalid` kèm `fields` (vd `dueDate: before_receive`, `amount: exceeds_paid`).
- Mã **thêm** ngoài bảng mục 12 của tài liệu BE: `price_missing` (422, món chưa có bảng giá và đơn không có gói/giá đặc biệt), `payment_incomplete` (422, giao khi chưa thu đủ; `data: { rentDue, depositDue }`), `shift_required` (422), `cleaning_open` (409, món đã có việc giặt/sửa chưa xong), `conflict` (409, `If-Match` lệch), `idempotency_mismatch` (422), `request_in_progress` (409), `rate_limited` (429), `reset_invalid` (400), `upgrade_required` (426).
- `in_use` trả `data: { blockedBy: [{ resource, count }] }`; `booking_conflict` / `piece_not_ready`: `data` = id món.

## 2. Phiên đăng nhập

`POST /auth/register-shop` và `POST /auth/login` trả:
```json
{ "tokenType": "Bearer", "accessToken": "...", "expiresIn": 7200, "sessionId": "...",
  "refreshToken": "<sessionId>.<random>", "refreshTokenExpiresAt": "...", "resumeToken": "(chỉ khi remember=true)",
  "me": { "id", "email", "name", "phone", "language", "shopId", "status" }, "shop": { "id", "name" } }
```
Body đăng nhập: `{ email, password, device: { name, id }, remember }` (`device` có thể là chuỗi tên máy).

- **Không tick "Ghi nhớ":** chỉ giữ token trong bộ nhớ. Access token 2 giờ; `POST /auth/refresh { refreshToken }` đổi cặp mới (xoay vòng; dùng lại token cũ → thu hồi phiên → `401 session_expired`). Phiên tối đa 12 giờ, nghỉ quá 3 giờ thì mất.
- **Tick "Ghi nhớ":** app cất `sessionId` + `resumeToken` (Keystore). Mở lại app: `POST /auth/resume { sessionId, resumeToken }` → cặp token mới + `me` + `shop` (không trả lại `resumeToken`, vẫn dùng token cũ). Hết hạn sau **30 ngày không dùng** (trượt). Mất hiệu lực khi: đăng xuất, xóa thiết bị, admin khác đặt lại mật khẩu/thu hồi, xóa tài khoản.
- Mọi request đều kiểm tra lại phiên + tài khoản: phiên hỏng → `401 session_expired`; tài khoản bị thu hồi → `403 account_revoked`.
- Sai mật khẩu 5 lần liên tiếp → khóa email 5 phút (`429 too_many_attempts`, header `Retry-After`).
- `POST /auth/forgot { email }` luôn `202 { status: "accepted" }`. BE gửi email mã 8 ký tự (SMTP). Khi chưa cấu hình SMTP và không phải production, mã trả luôn trong `devToken`. `POST /auth/reset { token, password }` → `204`, đăng xuất mọi máy.
- `POST /auth/change-password { current, next }`; `GET/PATCH /me` (`name, phone, language`; email chỉ đọc) trả `{ me, shop }`; `GET /me/sessions`, `DELETE /me/sessions/{id}`; `DELETE /me { password }` → `204` (admin cuối xóa luôn cả tiệm, xóa thật).
- `GET/POST /admins`, `POST /admins/{id}/revoke`, `POST /admins/{id}/reset-password { password }` → `204`. Tự thu hồi mình: `409 last_admin` nếu là admin duy nhất còn hoạt động, ngược lại `403 forbidden` (dùng "Xóa tài khoản").

## 3. Danh mục (CRUD)

Mỗi tài nguyên: `GET /{res}`, `POST /{res}`, `GET|PATCH|DELETE /{res}/{id}`. Trường theo bảng mục 4 tài liệu BE; điểm cần biết:

- Tài nguyên: `categories styles pieces accessories bundles prices deposit-rules fees zones peaks closed-dates rooms promos discounts customers staff schedules tasks feedback complaints faq supplies partners suppliers expenses targets checklists care-notes counts todos notes waits missed alterations fittings` và `fit-memory` (chỉ đọc).
- `pieces.status`, `washCount`, `lastCareAt`, `supplies.qty`, `promos.used`, `alterations.revertDue` **chỉ server ghi** (client gửi sẽ bị bỏ qua). Đổi trạng thái món: `POST /pieces/{id}/status`.
- `prices` / `deposit-rules`: bắt buộc đúng một trong `styleId`, `pieceId` (`422 required_missing`). `promos.code` lưu chữ hoa.
- `customers` trả thêm `points, tier, totalSpent, orderCount`; `phone` dùng để tìm khách (chỉ lấy chữ số, từ 6 số).
- `waits` trả thêm `matches[]`: món đang trống hợp với mẫu/size/ngày.
- `fittings`: kiểm tra `room_busy`, `staff_busy`, `shop_closed` (ngày nghỉ hoặc `hours` đóng cửa); `result = "fit"` ghi `fit-memory` (món khách từng thử vừa lên đầu `availability?customerId=`).
- `todos`: `POST /todos/{id}/complete` (việc lặp thì dời `due`).
- Cấu hình một dòng: `GET|PUT /settings/{shop|rules|policy|loyalty|hours}`. `PUT` thay toàn bộ (giá trị thiếu lấy mặc định). `hours` dạng `{ "days": [{ day (0=CN), open, close, closed }] }`. Mặc định `loyalty`: `per 10000`, `value 100`.
- Xóa bị chặn: `409 in_use`. Mã trùng (`styles, pieces, promos, closed-dates, targets…`): `409 duplicate_code`.
- Hành động riêng: `GET /pieces/alerts` (bảo quản/ế/hết vòng đời), `GET /pieces/{id}/summary|bookings|calendar?month=yyyy-MM|logs`, `POST /pieces/{id}/status|dispose|care`, `POST /purchases`, `POST /supplies/{id}/move`, `GET /supplies/{id}/moves`, `GET /customers/{id}/orders|loyalty`, `POST /customers/{id}/merge`.

## 4. Đơn thuê

Mô hình, trạng thái, công thức: tài liệu BE mục 5. Mọi lệnh ghi bên dưới chạy trong **một giao dịch** và chặn theo trạng thái hiện tại (bấm hai lần/hai admin cùng bấm không áp dụng hai lần). Lệnh có `Idempotency-Key` gửi lại cùng key + cùng body → trả đúng kết quả cũ; cùng key khác body → `422 idempotency_mismatch`; lệnh lỗi không để lại dấu vết (thử lại cùng key được).

| Việc | Endpoint |
|---|---|
| Báo giá | `POST /orders/quote` (không ghi) |
| Tạo đơn | `POST /orders` 🔑 → `201` đơn đầy đủ |
| Danh sách | `GET /orders?status=a,b&q=&from=&to=&dateField=receive\|due\|created&customerId=&source=&overdue=true&sort=` |
| Cần gọi / ở ngoài | `GET /orders/call-list`, `GET /orders/outside` (không phân trang, tối đa 500) |
| Chi tiết / lịch sử | `GET /orders/{id}`, `GET /orders/{id}/history` |
| Sửa thông tin | `PATCH /orders/{id}` (`note, source, receiveMinute, receiveMode, returnMode, receiveAddr, returnAddr, receiveFee, returnFee, reason`) — mỗi trường đổi ghi vào `changes[]` |
| Thanh toán | `GET|POST /orders/{id}/payments` 🔑 `{ kind, method, amount, note }` → `201 { payment, order }` |
| Giao | `POST /orders/{id}/deliver` 🔑 |
| Nhận trả | `POST /orders/{id}/return` 🔑 (trả một phần được) |
| Quyết toán | `POST /orders/{id}/settle` 🔑 → `{ refund, extra, order }` |
| Hủy | `POST /orders/{id}/cancel` 🔑 `{ refund, method, reason, refundTo }` |
| Đổi ngày / gia hạn | `POST /orders/{id}/change-dates` 🔑 `{ from, to, reason }` → đơn + `diff` |
| Đổi món / thêm món | `POST /orders/{id}/lines/{lineId}/swap` 🔑, `POST /orders/{id}/lines` 🔑 → đơn + `diff` (`diff > 0` thu thêm, `< 0` hoàn) |
| Ghi chú nội bộ, đã liên hệ | `PUT /orders/{id}/internal-note`, `PUT /orders/{id}/contacted` |
| Phiếu | `GET /orders/{id}/slip?kind=rent\|deliver\|return` → `{ text }` |
| Món trống / gợi ý size | `GET /availability?from=&to=&q=&size=&color=&occasion=&categoryId=&styleId=&maxPrice=&exceptOrder=&customerId=`, `POST /availability/fit { person: {bust,waist,hip,shoulder,length}, pieceIds\|styleId }` (gợi ý size) |

🔑 = nên gửi `Idempotency-Key` (app sinh UUID mỗi lần bấm "Xác nhận", gửi lại **cùng key** khi thử lại).

Bản đơn trả về có thêm các trường tính sẵn: `grand, balance, paidRent, depositHeld, lateDays, overdue, lateFee` (phí trễ gợi ý) và `customer { id, name, phone, attention }`.

### Khác/diễn giải so với tài liệu BE
- **Giao đồ bắt buộc thu đủ:** `deliver` chỉ thành công khi tiền thuê và cọc đã thu đủ (cộng `collectRent` / `collectDeposit` trong lệnh), nếu không `422 payment_incomplete`. Giao cũng cần món đang `ready`/`held` (trừ khi `rules.allowNotReady`).
- **Hủy** chỉ từ `reserved`/`paid` (đã chặn cả `returned`). `refund` không vượt số tiền thật đã thu (không tính `comp`); cọc đã thu hoàn toàn bộ.
- **Gói (`bundleId`):** tiền gói chia theo tỉ lệ giá lẻ từng dòng, phần dư dồn dòng cuối.
- **Cao điểm:** nhiều mùa trùng → lấy mức phụ thu lớn nhất. `rules.surchargeHolidayPct` **chưa áp dụng** (tài liệu BE chưa nói áp theo ngày nào); báo lại nếu cần.
- **Sau khi giao,** đổi ngày không đổi tiền cọc; không đổi được ngày nhận. `swap`/thêm món chỉ khi `reserved`/`paid`.
- **Tạo đơn:** nếu `receiveFee/returnFee` không gửi mà chọn giao tận nơi, lấy phí của `zoneId`. Đơn có món chưa có bảng giá → `422 price_missing`.
- Trả đồ: `decision` mặc định `wash`; việc giặt/sửa tạo ngay với hạn = hôm nay + `max(1, bufferDays)`; phụ kiện thiếu ghi nhật ký vào món đầu tiên của đơn.
- Hai người cùng đặt một món cùng lúc: đúng một người thành công, người kia `409 booking_conflict` (khóa theo món trong giao dịch).

## 5. Tổng quan, báo cáo, đồng bộ

- `GET /home?range=today|d7|d14|m1|m3|m6|y1|all|custom&from=&to=` — toàn bộ khối màn Tổng quan (mục 3 tài liệu BE). Nhớ khoảng thời gian ở app; có ETag, kéo-để-làm-mới gọi lại.
- `GET /reminders/source` — dữ liệu thô cho nhắc việc cục bộ (đơn mở và giữ chỗ trong 14 ngày tới / 7 ngày qua, lịch thử đồ, việc giặt, việc cần làm, vật tư thấp, ca đang mở, mùa cao điểm).
- `GET /reports/{revenue|occupancy|styles|economics|expenses|vs-target|forecast|missed|seasonal|turnaround}` cùng tham số khoảng thời gian (`vs-target?month=yyyy-MM`). `forecast` trả `{ forecast: null }` khi chưa đủ 1 năm dữ liệu.
- `GET /day-close?date=`, `GET /shifts`, `GET /shifts/current`, `POST /shifts/open|close`, `GET|POST /cash`, `DELETE /cash/{id}`.
- `GET /search?q=` (≥ 2 ký tự, tối đa 60 kết quả), `GET /admin-log` (chỉ đọc).
- **Đồng bộ (mục 13.2):** hỗ trợ cả hai hướng. (b) từng màn gọi danh sách có phân trang + `?updatedSince=`. (a) `GET /sync?since=<ISO>&limit=500&resources=a,b` trả `{ serverTime, hasMore, nextSince, changes: { resource: [...] }, deleted: [{ resource, id }] }`; lặp với `since = nextSince` tới khi `hasMore=false`; `since` tính cả mốc đó nên app upsert theo `id`. Lần đầu bỏ `since`.
- **Nhập CSV:** app đọc file, gửi `rows` (JSON) tới `POST /import/{type}/preview` rồi `/commit`; `type` ∈ `categories styles pieces accessories staff customers partners suppliers supplies promos faq`. `pieces` có thể gửi `styleCode` thay `styleId`, `styles` gửi `categoryName`. Dòng lỗi bị bỏ qua và báo theo số dòng. Tối đa 1000 dòng.
- **Xuất:** dùng chính các danh sách có phân trang.

## 6. Trả lời "Câu hỏi cần BE chốt" (mục 14)

1. **Đồng bộ:** làm cả `sync?since=` (có `deleted`) và danh sách phân trang + `updatedSince`; FE chọn.
2. **`/home`, `/reminders/source`:** đã làm.
3. **Tìm món trống và gợi ý size:** làm ở BE (`/availability`, `/availability/fit`).
4. **Đăng ký công khai:** giới hạn 5 lần/giờ/IP + 10 lần/phút cho nhóm auth. **Chưa** xác minh email (cần chốt nếu muốn).
5. **Quên mật khẩu:** BE gửi email (SMTP); admin khác đặt lại được qua `admins/{id}/reset-password`.
6. **Đồng thời:** có `If-Match` cho danh mục (xem mục 1).
7. **Thời điểm:** UTC, `Z`, có mili giây.
8. **Xóa dữ liệu:** xóa thật toàn bộ dữ liệu tiệm khi admin cuối xóa tài khoản. Bản sao lưu của nhà cung cấp hạ tầng (MongoDB Atlas) xóa theo chu kỳ lưu giữ riêng của họ, cần nêu trong chính sách quyền riêng tư (đã có ở `/privacy`).

## 7. Việc nền

`GET /jobs/run` (Vercel Cron, 1 lần/ngày; có `CRON_SECRET` thì cần `Authorization: Bearer`): hết hạn giữ chỗ quá `until`, dọn phiên đã thu hồi. Vì cron chỉ chạy ngày một lần, giữ chỗ quá hạn còn được hết hạn **ngay khi app gọi** `GET /home`, `GET /holds`, `GET /availability`.
