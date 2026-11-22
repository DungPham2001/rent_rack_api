# RentRack — Tài liệu ghép API (dành cho Backend)

Ứng dụng quản lý tiệm cho thuê trang phục (Flutter, Android). **Hiện app chạy trên "máy chủ giả" lưu trong máy**; tài liệu này liệt kê những gì backend phải làm để thay máy chủ giả đó bằng API thật mà không phải sửa giao diện.

> Đây là **hợp đồng đề xuất** rút ra từ code đang chạy. Nếu BE đã có API sẵn, hãy đối chiếu rồi báo lại chỗ lệch; phần "Câu hỏi cần BE chốt" ở cuối liệt kê những điểm cần thống nhất.

## 0. Tóm tắt nhanh

| | |
|---|---|
| Vai trò | **Chỉ một: quản trị viên (admin)** của tiệm. Khách thuê đồ không có tài khoản, không dùng app. |
| Nhiều tiệm | **Có.** Chủ tiệm tự đăng ký tiệm. Mỗi tiệm có dữ liệu riêng, không thấy dữ liệu của tiệm khác. |
| Nhiều admin / tiệm | Có. Chủ tiệm (và admin khác) thêm người; mọi admin quyền ngang nhau. |
| Ngôn ngữ / giao diện | Tiếng Việt + English; sáng + tối. Chỉ cần `Accept-Language`. |
| Thông báo nhắc việc | **Cục bộ trên máy**, không có push từ máy chủ. Máy chủ chỉ cần cung cấp dữ liệu. |
| Ảnh, camera, QR, thanh toán online | **Không có.** Chuyển khoản chỉ là admin thấy tiền về thì ghi nhận. |
| Token | Chỉ giữ trong bộ nhớ app (mất khi thoát app), trừ khi người dùng tick **"Ghi nhớ"** (xem mục 2). |

**Điểm thay thế trong app:** [lib/data/local_server.dart](../lib/data/local_server.dart) (lưu trữ), [lib/data/store.dart](../lib/data/store.dart), [store_orders.dart](../lib/data/store_orders.dart), [store_ops.dart](../lib/data/store_ops.dart), [store_reports.dart](../lib/data/store_reports.dart) (toàn bộ quy tắc nghiệp vụ). Mọi quy tắc trong các file này **phải chạy ở máy chủ**; app giữ lại phần hiển thị và gọi API.

---

## 1. Quy ước chung

- **Chỉ HTTPS.** Tiền tố `/v1`. Body và response JSON UTF-8.
- **Xác thực:** `Authorization: Bearer <accessToken>` ở mọi endpoint trừ: `register-shop`, `login`, `resume`, `forgot`, `reset`, `health`.
- **Đa tiệm:** `shopId` lấy từ token, **không bao giờ nhận từ client**. Mọi truy vấn phải lọc theo `shopId`; truy cập id của tiệm khác trả `404`.
- **Header:** `Accept-Language: vi|en`; `Idempotency-Key` (UUID) ở các lệnh ghi tiền hoặc tạo đơn (danh sách ở mục 5.9).
- **Kiểu dữ liệu**
  - Tiền: **số nguyên VND**, không số lẻ. Phần trăm: số nguyên.
  - Ngày không giờ (`receiveDate`, `dueDate`, `from`, `to`, `date`): chuỗi `yyyy-MM-dd`.
  - Thời điểm (`createdAt`, `at`, `until`…): ISO-8601. **Đề nghị trả UTC có offset**; app tự đổi giờ hiển thị. (Hiện máy chủ giả đang lưu giờ máy.)
  - Giờ trong ngày: số phút từ 0h (`receiveMinute`, fitting `start`/`end`).
  - `id`: chuỗi. Hiện **client tự sinh id**; BE nên tự sinh, nhưng chấp nhận id do client gửi khi tạo (để thử lại an toàn).
  - Mỗi bản ghi có `id`, `createdAt`, `updatedAt`.
- **Múi giờ nghiệp vụ:** `rules.timezone` (mặc định `Asia/Ho_Chi_Minh`). "Hôm nay", "quá hạn", "ngày đệm" tính theo múi giờ này.
- **Lỗi:** `{ "code": "...", "message": "...", "data": ... }`. App dịch theo `code`, nên **`code` phải ổn định** (danh sách mục 12). HTTP: `400` dữ liệu sai, `401` hết phiên (`session_expired`), `403` bị thu hồi, `404`, `409` xung đột nghiệp vụ, `422` sai quy tắc, `429` quá nhiều lần thử.
- **Phân trang:** danh sách lớn dùng con trỏ (`?limit=&cursor=`). Danh sách nhỏ (danh mục, bảng giá, phụ kiện, nhân viên…) trả hết.
- **Đồng thời:** nhiều admin cùng sửa. Đề nghị `If-Match: <updatedAt>` cho `PATCH`/`PUT`, lệch thì `409 conflict`. (App hiện ghi đè, chưa gửi version.)

---

## 2. Đăng ký, đăng nhập, tài khoản

### 2.1 Màn hình và luồng

1. **Giới thiệu (onboarding)** chỉ lưu cờ trên máy, **không cần API**.
2. **Đăng ký tiệm** (màn riêng từ thẻ vàng ở màn đăng nhập): nhập tên tiệm\*, SĐT tiệm, địa chỉ, họ tên chủ\*, email\*, mật khẩu\* (+ nhập lại). Thành công thì **đăng nhập luôn** và vào app.
3. **Đăng nhập:** email + mật khẩu + ô **"Ghi nhớ"**. Khi bấm: nút chỉ còn vòng xoay → kiểm tra tài khoản → nếu đúng **tải sẵn dữ liệu màn Tổng quan** (mục 3) → mới chuyển màn. Sai thì hiện popup theo `code`.
4. **Không có màn đổi mật khẩu bắt buộc, không có tài khoản mặc định.** Đổi mật khẩu nằm trong **Hồ sơ**.
5. **Không còn "Việc khởi động"**: vào thẳng tab Tổng quan sau đăng nhập.

### 2.2 Endpoint

| Việc | Endpoint | Ghi chú |
|---|---|---|
| Đăng ký tiệm | `POST /v1/auth/register-shop` | body: `shopName, shopPhone, address, ownerName, email, password, device, remember` → như login. Tạo **shop + admin đầu tiên + phiên**. |
| Đăng nhập | `POST /v1/auth/login` | body: `email, password, device, remember` |
| Khôi phục phiên (ghi nhớ) | `POST /v1/auth/resume` | body: `sessionId, resumeToken` |
| Làm mới token | `POST /v1/auth/refresh` | app gọi ngầm khi access token hết hạn |
| Đăng xuất | `POST /v1/auth/logout` | thu hồi phiên và resume token |
| Quên / đặt lại mật khẩu | `POST /v1/auth/forgot`, `/auth/reset` | `forgot` luôn trả cùng một câu trả lời dù email có hay không |
| Đổi mật khẩu | `POST /v1/auth/change-password` | `current, next` |
| Hồ sơ | `GET/PATCH /v1/me` | `name, phone, language` (email chỉ đọc) |
| Thiết bị đã đăng nhập | `GET /v1/me/sessions`, `DELETE /v1/me/sessions/{id}` | xóa phiên của máy khác hoặc máy này |
| Xóa tài khoản | `DELETE /v1/me` | body: `password`. Xem quy tắc xóa bên dưới |
| Danh sách admin của tiệm | `GET /v1/admins` | chỉ admin cùng `shopId` |
| Thêm admin | `POST /v1/admins` | `email, name, password` (chủ tiệm đặt mật khẩu ban đầu, người đó đổi sau trong Hồ sơ) |
| Thu hồi admin | `POST /v1/admins/{id}/revoke` | |
| Đặt lại mật khẩu cho admin khác | `POST /v1/admins/{id}/reset-password` | `password`. Thu hồi hết phiên của người đó |

**Response đăng nhập / đăng ký:**
```json
{
  "accessToken": "...", "expiresIn": 7200,
  "sessionId": "...", "resumeToken": "... (chỉ khi remember=true)",
  "me": { "id": "", "email": "", "name": "", "phone": "", "language": "vi", "shopId": "", "status": "active" },
  "shop": { "id": "", "name": "" }
}
```

### 2.3 Quy tắc BE phải thực thi

- **Mật khẩu:** tối thiểu 8 ký tự, có chữ hoa, chữ thường, chữ số (`weak_password`). Băm Argon2 hoặc bcrypt. Không bao giờ trả hay log mật khẩu.
- **Email:** chuẩn hóa chữ thường, **duy nhất toàn hệ thống** (`email_taken`), đúng dạng (`invalid_email`). Thiếu tên tiệm hoặc họ tên: `required_missing`.
- **Chống dò mật khẩu:** sai **5 lần liên tiếp** thì khóa email đó **5 phút** (`too_many_attempts`). Email không tồn tại và mật khẩu sai trả **cùng** `invalid_credentials`. Nên thêm giới hạn theo IP.
- **Tài khoản bị thu hồi:** `account_revoked` (403).
- **Đăng ký tiệm là endpoint công khai:** cần chống spam (giới hạn theo IP/thiết bị, đề nghị xác minh email).
- **Phiên:**
  - Access token sống **2 giờ**, app tự làm mới khi đang dùng.
  - **Không tick "Ghi nhớ":** token chỉ trong bộ nhớ; thoát app là mất; ở nền quá **1 giờ** thì app tự bỏ phiên (quy tắc phía app).
  - **Tick "Ghi nhớ":** app giữ một `resumeToken` ngẫu nhiên; **máy chủ chỉ lưu bản băm** và gắn vào phiên. Hết hạn nếu **30 ngày không dùng** (trượt). Mở app lại thì app gọi `resume` và vào thẳng Tổng quan.
  - `resumeToken` mất hiệu lực khi: đăng xuất, xóa thiết bị trong "Thiết bị đã đăng nhập", admin khác đặt lại mật khẩu hoặc thu hồi, xóa tài khoản.
  - **Mọi endpoint** phải kiểm tra phiên còn hiệu lực và tài khoản chưa bị thu hồi; không thì `401 session_expired`.
- **Xóa tài khoản:** cần mật khẩu (`wrong_password`). Nếu người đó **không phải admin cuối** thì xóa riêng tài khoản và thu hồi phiên. Nếu là **admin cuối của tiệm thì xóa luôn cả tiệm và toàn bộ dữ liệu** (đơn, món, khách, thu chi…). App cảnh báo rõ trước khi gọi. Đây là yêu cầu xóa dữ liệu của Google Play, **xóa thật, không soft-delete**.
- **Không có** tài khoản mặc định, mật khẩu mặc định, cờ `mustChangePassword`. (Bản debug của app có tài khoản demo trong code, **không liên quan BE**, sẽ bị loại khỏi bản release.)
- **Ghi lịch sử thao tác nhạy cảm** (mục 11): thêm/thu hồi admin, đặt lại mật khẩu…

---

## 3. Màn Tổng quan (API tải khi đăng nhập)

App gọi sau khi đăng nhập đúng (hàm `loadHome()` trong [store.dart](../lib/data/store.dart)) và giữ vòng xoay ở nút đăng nhập cho tới khi xong. **Đề nghị một endpoint tổng hợp** để app mở màn Tổng quan là có đủ số liệu:

`GET /v1/home?range=today|d7|d14|m1|m3|m6|y1|all|custom&from=yyyy-MM-dd&to=yyyy-MM-dd`

App nhớ khoảng thời gian người dùng chọn lần trước; mặc định `d7` (7 ngày gần nhất).

**Khoảng thời gian** (tính theo hôm nay, gồm cả hôm nay): `today` = 1 ngày; `d7` = 7; `d14` = 14; `m1` = 30; `m3` = 90; `m6` = 182; `y1` = 365; `all` = từ ngày có đơn/khoản thu đầu tiên; `custom` = `from..to`. Kỳ trước = khoảng ngay trước đó, **dài bằng nhau**.

**Response gồm các khối đang hiển thị ở màn Tổng quan:**

| Khối | Nội dung |
|---|---|
| `range` | `from`, `to`, `previous{from,to}` |
| `revenue` | `current`, `previous` (số nguyên), và `deltaPct` (null nếu kỳ trước = 0) |
| `ordersCreated` | số đơn tạo trong kỳ (không tính đơn hủy) |
| `avgPerDay` | doanh thu trung bình ngày |
| `occupancy` | tỉ lệ lấp đầy 0..1 (cách tính ở mục 9) |
| `buckets[]` | cột biểu đồ: `label, start, end, revenue, prevRevenue, orders`. Quy tắc cột: 1 ngày → theo **giờ** (24 cột); ≤31 ngày → theo **ngày**; ≤190 ngày → theo **tuần**; dài hơn → theo **tháng**. `prevRevenue` = cùng cột của kỳ trước |
| `styleRanking[]` | mẫu thuê nhiều: `styleId, name, count, revenue` (đếm dòng món của đơn **tạo trong kỳ**, sắp theo `count` giảm dần) |
| `today` | đơn **giao hôm nay** và **hạn trả hôm nay** (danh sách đơn rút gọn, mục 5.1) |
| `attention` | các bộ đếm cần chú ý: `overdue` (đơn quá hạn trả), `callList` (khách cần gọi), `holdsExpiring`, `lowSupplies`, `careDue` (món đến hạn bảo quản), `stale` (món ế), `endOfLife` (món sắp hết vòng đời) |
| `depositsHeld` | tổng cọc đang giữ của các đơn còn mở |
| `rack` | số món theo trạng thái: `ready, held, rented, wait_wash, washing, repair` |
| `peaks` | mùa cao điểm sắp tới |
| `staff` | khối lượng việc theo nhân viên hôm nay |
| `recentOrders[]` | 6 đơn gần đây (mục 5.1) |
| `dayLoad` | số việc hôm nay và cờ `overloaded` (so với `rules.overloadPerDay`) |

Ngoài `GET /v1/home`, **pull-to-refresh** gọi lại endpoint này. Nên có cache ngắn và ETag.

> **Nhắc việc cục bộ:** app tự dựng danh sách nhắc từ dữ liệu (đơn, giữ chỗ, lịch thử đồ, giặt ủi, vật tư, ca, việc cần làm, bảo quản…) rồi đặt báo thức trên máy. Vì vậy BE cần cho app **lấy được dữ liệu thô của 14 ngày tới và 7 ngày qua** (đơn mở, giữ chỗ đang hoạt động, lịch thử đồ, công việc giặt đang mở, việc cần làm, vật tư dưới mức tối thiểu, ca đang mở). Đề nghị endpoint `GET /v1/reminders/source` trả gọn đúng phần này, hoặc để các danh sách ở mục 5 hỗ trợ lọc theo ngày.

---

## 4. Danh mục và cấu hình (CRUD)

App hiện ghi qua hàm chung `upsert(table, row)` và `remove(table, id)` (kèm `logAction` cho một số bảng). BE cung cấp CRUD theo REST: `GET /v1/{res}`, `POST /v1/{res}`, `GET|PATCH|DELETE /v1/{res}/{id}`. **Trường dữ liệu từng bảng nằm ở các định nghĩa `FSpec` trong code** (cột "Màn hình / nguồn").

| Tài nguyên `/v1/…` | Trường chính | Màn hình / nguồn |
|---|---|---|
| `categories` | `name, sort, active` | catalog_pages.dart |
| `styles` (mẫu) | `code, name, categoryId, color, material, silhouette, occasions, visible, featured, desc, albumUrl, sizes[{label, measures{bust,waist,hip,shoulder,length (đơn vị 0,1 cm)}}], defaultAcc[{accessoryId, qty}]` | catalog_pages.dart |
| `pieces` (từng món) | `code, styleId, size, purchasePrice, purchasedDate, maxRentals, shelf, status, measures{key:{mm, adj}}, careDays, lastCareAt, washCount, alter{}, note` | catalog_pages.dart |
| `accessories` | `name, kind, track (qty/unit), qtyTotal, lostFee, note` (+ `accUnits` khi `track=unit`) | catalog_pages.dart |
| `bundles` | `name, price, items (mô tả), from` | catalog_pages.dart |
| `prices` (bảng giá) | `styleId` **hoặc** `pieceId`, `day, tier3, tier7, extraDay, from`. (Trường `event` **đã bỏ**) | settings_pages.dart |
| `deposit-rules` | `styleId` hoặc `pieceId`, `kind` (`fixed`/`pct`), `value` | settings_pages.dart |
| `fees` (bảng phí) | `kind` (`wash, damage, lostAcc, lostPiece, late, other`), `name, amount` | settings_pages.dart |
| `zones` | `name, fee` | settings_pages.dart |
| `peaks` | `name, from, to, kind` (`pct`/`amount`), `value` | settings_pages.dart |
| `closed-dates`, `rooms` | ngày nghỉ, phòng thử đồ (`name, active`) | settings_pages.dart |
| `promos` | `code, kind, value, minAmount, start, end, limit, used` | people_pages.dart |
| `discounts` (giảm giá tự động) | `name, kind, value, minItems, minDays, regularOnly` | people_pages.dart |
| `customers` | `name, phone, attention, note, tags, people[{id,name,relation,measures[]}]` | people_pages.dart |
| `staff` | `name, phone, role (sales/laundry/tailor/delivery), position, joined, status (active/left)` | people_pages.dart |
| `schedules`, `tasks` | lịch làm/nghỉ (`staffId, date, kind`), phân việc & tiền công (`staffId, date, kind, ref, pay, done`) | people_pages.dart |
| `feedback`, `complaints` | `orderId, stars (1–5), text`, khiếu nại + trạng thái | people_pages.dart |
| `faq` | `q, a` | people_pages.dart |
| `supplies` + `supply-moves` | vật tư `name, unit, qty, min`; lịch sử nhập/xuất | money_pages.dart |
| `partners`, `suppliers` | `name, phone, priceNote` | money_pages.dart |
| `expenses` | `category (rent, power, salary, wash, repair, ads, other), amount, date, recurring, note` | finance_pages.dart |
| `targets` | `month (yyyy-MM), amount` | finance_pages.dart |
| `checklists` | `kind` (`qc`, `out`, `in`), `title, sort` | cleaning_pages.dart |
| `care-notes`, `counts` | cách giặt theo chất liệu, kiểm kê | cleaning_pages.dart |
| `todos`, `notes` | việc cần làm, ghi chú nhanh | account_tab.dart |

**Cấu hình một dòng cho mỗi tiệm** (`GET/PUT /v1/settings/{key}`):

| `key` | Nội dung |
|---|---|
| `shop` | hồ sơ tiệm: `name, phone, address, owner, desc`… (in trên phiếu). **Khởi tạo từ lúc đăng ký tiệm** |
| `rules` | quy tắc thuê, xem bảng dưới |
| `policy` | chính sách thuê (văn bản, **sao chép vào đơn lúc tạo**) |
| `loyalty` | `per` (bao nhiêu đ = 1 điểm), `value` (1 điểm = bao nhiêu đ), `tiers[]` |
| `hours` | giờ mở cửa 7 ngày `{day, open, close, closed}` |

**`rules` và giá trị mặc định:** `defaultDays 3`, `bufferDays 1` (ngày đệm giặt ủi sau khi trả), `holdDays 3`, `lateKind amount|pct`, `lateValue 100000`, `depositPct 50`, `holdPct 30` (tiền giữ chỗ = % tổng), `staleDays 60`, `overloadPerDay 12`, `conflictMode block|warn`, `allowNotReady false`, `fittingMinutes 30`, `rushPct 0`, `timezone`, `careDays 90`, `lifecycleWarnPct 85`, `surchargeHolidayPct 0`.

**Ràng buộc khi xóa:** không xóa được bản ghi đang được dùng (mẫu có món, món có đơn…) → `409 in_use`. Mã trùng (mẫu, món, mã giảm giá) → `409 duplicate_code`.

**Dữ liệu đã bỏ, BE không cần làm:** thông tin ngân hàng của tiệm (`bank-info`, `banks`), mã QR chuyển khoản, giá theo sự kiện (`prices.event`), "ngày dùng / dịp" trên đơn (`eventDate`, `eventLabel`, `event`), danh sách việc khởi động (`setup`), cờ `mustChange`. Đơn cũ nếu đã có các trường này thì chỉ cần giữ nguyên, app không còn ghi.

---

## 5. Đơn thuê (phần lớn nghiệp vụ)

### 5.1 Mô hình đơn

Đơn nhúng các dòng món (`lines[]`) và phụ kiện (`acc[]`). Trường chính:

```
id, code (RR{yy}{mm}-{nnn}, đếm theo tháng), customerId, source (phone|zalo|counter|family|other),
status, receiveDate, dueDate, receiveMinute, returnedAt, deliveredAt,
receiveMode / returnMode (store|delivery), receiveAddr, returnAddr, receiveFee, returnFee, zoneId,
rent, normalRent, surcharge, discount, discountNote, deposit, holdAmount, payOnReceive,
compReason, specialRent, bundleId, promoCode, redeemPoints,
note, internalNote, policySnap (bản sao chính sách), feeSnap (bản sao bảng phí),
lines[{id, person, styleId, pieceId, size, from, to, unit, surcharge, deposit, condOut, condIn, status: out|returned|lost}],
acc[{accessoryId, qty, returned, lost}],
settlement{fees, total, deposit, refund, extra, at, note}, changes[] (lịch sử đổi), contacted,
createdBy, createdAt
```

**Tổng tiền thuê** `grand = rent + surcharge + delivery(receiveFee+returnFee) − discount`. App hiển thị nên BE trả sẵn `grand` và `lateDays`, `overdue`.

**Trạng thái (`status`) và chuyển trạng thái hợp lệ:**

```
reserved ──thu đủ──▶ paid ──giao──▶ delivered ──nhận trả──▶ returned ──quyết toán──▶ completed
    └──────────── hủy (khi chưa giao) ────────────▶ cancelled
```
- `reserved` = đã giữ chỗ (đã thu tiền giữ chỗ); `paid` = đã thu đủ tiền thuê. Đơn thuê tại quầy vào thẳng `delivered`.
- Giao (`deliver`) chỉ từ `reserved`/`paid`; nhận trả chỉ từ `delivered`; quyết toán chỉ từ `returned`. Sai thì `422 invalid_transition`.
- **Hủy** chỉ nên cho khi đơn đang `reserved`/`paid`. (Code app hiện chỉ chặn "đang `delivered`" và "đã đóng"; BE nên chặn chặt hơn: đơn `returned` cũng không hủy được.)
- Giá trị `expired` có trong danh sách trạng thái nhưng **app hiện không đặt trạng thái này**; hết hạn giữ chỗ nằm ở bảng `holds` (mục 5.10).

### 5.2 Báo giá (`quote`)

`POST /v1/orders/quote` nhận **nháp đơn**, trả giá chi tiết (không ghi gì). App gọi liên tục khi sửa form nên cần nhanh. **Toàn bộ logic dưới đây hiện nằm trong `quote()` của [store_orders.dart](../lib/data/store_orders.dart); BE phải cài đúng:**

- **Số ngày thuê** = `max(1, dueDate − receiveDate)`.
- **Giá một món:** tìm bảng giá của **món** trước, không có thì của **mẫu**; lấy dòng có `from` mới nhất mà `≤` ngày tính giá (đơn mới: hôm nay; đổi ngày/đổi món: **ngày tạo đơn**).
  - `days ≥ 7` và có `tier7` → `tier7`, đã bao 7 ngày; `days ≥ 3` và có `tier3` → `tier3`, bao 3 ngày; còn lại → `day`, bao 1 ngày.
  - Tiền thuê = `base + max(0, days − ngàyĐãBao) × extraDay` (`extraDay` bằng 0 thì dùng `day`).
- **Phụ thu mỗi dòng:** mùa cao điểm trùng bất kỳ ngày nào trong kỳ thuê (chọn mùa có `value` lớn nhất; `pct` hoặc số tiền cố định) + phụ thu thuê gấp (`rushPct` % nếu ngày nhận cách hôm nay ≤ 1 ngày).
- **Tiền cọc mỗi dòng:** quy tắc cọc của **món** → của **mẫu** → mặc định `depositPct`% × (giá mua món, hoặc tiền thuê nếu chưa có giá mua). Quy tắc `pct` tính trên giá mua.
- **Bộ / gói (`bundleId`):** tiền thuê = `giá gói + Σ(extraDay × max(0, days − defaultDays))`; **chia lại cho các dòng**, phần dư làm tròn dồn vào **dòng cuối**.
- **Giá đặc biệt (`specialRent`):** thay toàn bộ tiền thuê, xóa phụ thu và mọi giảm giá; **bắt buộc `compReason`** (`comp_reason_required`).
- **Giảm giá** (không áp khi có `specialRent`): mã giảm giá (`promoCode`) + **một** giảm giá tự động tốt nhất + điểm tích lũy (`redeemPoints × loyalty.value`, tối đa số điểm đang có). Tổng giảm **không vượt** `rent + surcharge`.
  - Mã không dùng được (không tồn tại, ngoài hạn, hết lượt `limit`, dưới `minAmount`): `422 promo_invalid`.
  - Giảm tự động xét `minItems`, `minDays`, `regularOnly` (khách có nhãn `regular`).
- **Tiền giữ chỗ gợi ý** `hold = grand × holdPct%`.
- **Làm tròn:** tính một lần, đồng, không âm.

Response: `lines[{unit, surcharge, deposit, days, priceMissing}]`, `rent, surcharge, discount, discountNote, delivery, deposit, hold, days, grand, payOnReceive (= grand − hold + deposit), promoError, missingPrice`.

### 5.3 Tạo đơn

`POST /v1/orders` — body: nháp (`customerId` hoặc `customerName + phone`, `source`, `receiveDate`, `dueDate`, `receiveMinute`, `receiveMode/returnMode`, địa chỉ + phí, `lines[{pieceId, person}]`, `acc[{accessoryId, qty}]`, `bundleId`, `promoCode`, `redeemPoints`, `specialRent`, `compReason`, `note`, `internalNote`, `forceConflict`), cộng `payMethod`, `paidNow`, `counter` (bool), `holdId?`.

Máy chủ phải, **trong một giao dịch**:
1. Với mỗi dòng: kiểm tra món cho thuê được và **không trùng lịch** (5.4). Trùng thì `409 booking_conflict` (`data` = id món). Nếu `rules.conflictMode = warn` **và** client gửi `forceConflict = true` thì cho qua.
2. Báo giá lại phía máy chủ (**không tin giá do client gửi**).
3. Đơn thường (không `counter`) bắt buộc **đã thu tiền giữ chỗ** (`paidNow > 0`, hoặc có `holdId`, hoặc `payMethod = comp`); không thì `422 hold_payment_required`.
4. Tìm khách theo `customerId`, không có thì theo **số điện thoại** (đã chuẩn hóa chữ số, ≥6 số), không có thì **tạo khách mới**; thêm tên "người mặc" của từng dòng vào `customers.people`.
5. Lưu **bản sao** chính sách (`policySnap`) và bảng phí (`feeSnap`) vào đơn.
6. Trạng thái: `counter` → `delivered`; thu đủ (`paidNow + holdAmount ≥ grand`) → `paid`; còn lại `reserved`.
7. Ghi khoản thu:
   - **Thuê tại quầy (`counter`):** thu `grand` (loại `rent`) + thu cọc (loại `deposit`; nếu `comp` thì cọc vẫn thu **tiền mặt**), ghi phiếu giao (`deliveries`), món → `rented`.
   - **Đơn thường:** khoản `hold` = `paidNow` (hoặc `grand` nếu `comp`); món đang `ready` → `held`.
8. Cộng lượt dùng của mã giảm giá; nếu đổi điểm thì ghi `loyalty` âm; nếu đơn lấy từ giữ chỗ (`holdId`) thì chuyển giữ chỗ thành `converted` và **gắn các khoản thu của giữ chỗ vào đơn**.
9. `comp` thì ghi lịch sử thao tác nhạy cảm (lý do).
10. Sinh `code` duy nhất theo tháng. Trả đơn đầy đủ.

### 5.4 Lịch và chống trùng (quy tắc quan trọng nhất)

- Một **booking** của một món: `from` → `to` + **`bufferDays`** ngày đệm giặt ủi (`end = to + bufferDays`). Nguồn: dòng đơn **không** ở trạng thái `cancelled/expired`, và giữ chỗ đang `active`.
- **Mốc `to` thực tế:** nếu dòng đã trả (`returned/lost`) thì dùng **ngày trả thực** của đơn (cả khi sớm hơn lẫn muộn hơn dự kiến); nếu đang thuê mà quá hạn chưa trả thì `to = hôm nay` (**vẫn chiếm lịch**).
- **Trùng lịch** = khoảng `[from, to + bufferDays]` của đơn mới giao với `[from, end]` của booking khác (so **cả hai đầu, tính theo ngày**). Khi sửa đơn thì bỏ qua chính đơn đó (`exceptOrder`) hoặc chính giữ chỗ đó (`exceptHold`).
- **Món không cho thuê:** `retired`/`disposed` → `piece_not_ready`. Món đang `wait_wash/washing/repair` cũng `piece_not_ready` nếu ngày nhận **trước** ngày dự kiến xong (hạn của việc giặt đang mở, hoặc hôm nay + `bufferDays`), trừ khi `rules.allowNotReady = true`.
- API: `GET /v1/pieces/{id}/bookings`, `GET /v1/pieces/{id}/calendar?month=yyyy-MM` (từng ngày: `rent|hold|buffer|repair`), `GET /v1/availability?from=&to=&q=&size=&color=&occasion=&categoryId=&maxPrice=&styleId=&exceptOrder=` (món trống). **Khi thêm món vào đơn app cũng dùng `availability` để chọn món.**
- **Gợi ý size** theo số đo khách (`sizeHints`): so số đo của món (kèm mức chỉnh `adj` cho phép) với số đo người mặc; chỉ là **gợi ý**. Có thể làm phía BE (`POST /v1/availability/fit`) hoặc để app tính. **Món khách từng thử vừa** (`fitMemory`) ưu tiên lên đầu danh sách chọn món.

### 5.5 Thu tiền, hoàn tiền

`payments(id, orderId|holdId, kind, method, amount, at, by, byName, note)`

- `kind`: `hold` (giữ chỗ), `rent` (tiền thuê), `deposit` (cọc), `deposit_refund` (hoàn cọc), `fee` (phí phát sinh), `refund` (hoàn tiền thuê/giữ chỗ).
- `method`: `cash`, `transfer` (chuyển khoản: admin thấy tiền về rồi ghi nhận), `comp` (ưu đãi/miễn phí, **bắt buộc có lý do**), và `deposit` (chỉ cho khoản `fee` **trừ vào cọc**).
- **Doanh thu** = tổng `hold + rent + fee` **không tính `method = comp`**, trừ đi `refund`. **Cọc (`deposit`, `deposit_refund`) không phải doanh thu.**
- `POST /v1/orders/{id}/payments` (`kind, method, amount, note`) — có `Idempotency-Key`. Khi đơn đang `reserved` mà `paidRent ≥ grand` thì tự chuyển `paid`.
- Số cần tính phía máy chủ: `paidRent(order)` = tổng khoản thu tiền thuê/giữ chỗ trừ hoàn; `depositHeld(order)` = cọc đã thu − cọc đã hoàn − phí trừ cọc.

### 5.6 Giao đồ

`POST /v1/orders/{id}/deliver`: `receiver, conditionOut{lineId:text}, collectRent, collectDeposit, method, mode, address, fee, staffId, note`.
- Chỉ từ `reserved`/`paid`. Thu `collectRent` (loại `rent`) và `collectDeposit` (loại `deposit`, nếu `method=comp` thì cọc vẫn thu tiền mặt).
- Ghi `condOut` vào từng dòng, món → `rented`, ghi phiếu giao `deliveries{kind:'out'}`, đơn → `delivered`, `deliveredAt`.
- **Không ghi nợ:** thu đủ trước khi giao.

### 5.7 Nhận trả

`POST /v1/orders/{id}/return`: `checks{lineId:{clean, damage, missing, decision}}`, `accReturns{accessoryId:{returned, lost}}`, `staffId`.
- Chỉ từ `delivered`. Hỗ trợ **trả một phần**: dòng chưa có trong `checks` vẫn `out`; đơn chỉ sang `returned` khi mọi dòng đã `returned/lost`.
- `decision`: `wash` (→ vào hàng đợi giặt, món `wait_wash`), `repair` (→ hàng đợi sửa, món `repair`), `retire` (món `retired`), `lost` (dòng `lost`, món `retired`, ghi `lost`).
- Mỗi lần trả sinh bản ghi `returns` (kèm `lateDays`), phiếu `deliveries{kind:'in'}`, và nếu có hư hỏng/bẩn thì ghi nhật ký món (`pieceLogs`). Với `wash`/`repair` tạo việc `cleaning` có hạn = hôm nay + `max(1, bufferDays)`.
- Phụ kiện: cập nhật `returned`/`lost`; mất thì ghi `lost`.

### 5.8 Quyết toán cọc

`POST /v1/orders/{id}/settle`: `fees{kind:amount}`, `method`, `note`. Trả `{refund, extra}`.
- Chỉ từ `returned`. `total` = tổng phí (≥ 0). `dep = max(0, depositHeld)`. **`fromDeposit = min(total, dep)`**, **`refund = dep − fromDeposit`** (không âm), **`extra = total − fromDeposit`** (phần vượt cọc, thu thêm ngay).
- Ghi: khoản `fee` method `deposit` = `fromDeposit`; khoản `fee` method thật = `extra`; khoản `deposit_refund` = `refund`. Lưu `settlement`. Đơn → `completed`.
- **Điểm thưởng:** nếu `loyalty.per > 0`, đơn không phải `comp`: cộng `grand ÷ per` điểm (`loyalty{reason:'order'}`).
- Với chỉnh sửa tạm (`alterations.revertNeeded`) của đơn: đặt `revertDue = hôm nay` (nhắc hoàn nguyên).
- **Phí trễ gợi ý** (`lateFee`): `lateKind=pct` → `rent × lateValue% × số ngày trễ`; `amount` → `lateValue × số ngày trễ`.

### 5.9 Các thao tác khác trên đơn

| Việc | Endpoint | Quy tắc |
|---|---|---|
| Đổi ngày / gia hạn | `POST /v1/orders/{id}/change-dates` `{from,to,reason}` | Đã giao thì **không đổi ngày nhận**. Kiểm tra trùng lịch từng dòng (bỏ qua chính đơn). **Tính lại giá theo giá tại ngày tạo đơn**, giữ nguyên giảm giá. Trả `diff` (>0: thu thêm; <0: hoàn). Ghi `changes[]` |
| Đổi món một dòng | `POST /v1/orders/{id}/lines/{lineId}/swap` `{newPieceId, reason}` | kiểm tra trùng lịch món mới; tính lại giá; trả `diff` |
| Thêm món vào đơn | `POST /v1/orders/{id}/lines` `{pieceId, person}` | như trên |
| Sửa thông tin đơn | `PATCH /v1/orders/{id}` + `reason` | ghi từng trường đổi vào `changes[]` |
| Ghi chú nội bộ | `PUT /v1/orders/{id}/internal-note` | |
| Đã liên hệ khách | `PUT /v1/orders/{id}/contacted` | cho danh sách "cần gọi" |
| Hủy đơn | `POST /v1/orders/{id}/cancel` `{refund, method, reason, refundTo}` | Chỉ khi chưa giao: hoàn tiền thuê (`refund`) + hoàn cọc đã thu (`deposit_refund`); đơn → `cancelled`; món `held` → `ready` nếu không còn đơn giữ khác; **đảo điểm tích lũy** của đơn; ghi lịch sử nhạy cảm |
| Danh sách đơn | `GET /v1/orders?status=&q=&from=&to=&customerId=&sort=` | `q` tìm theo mã, tên, SĐT (không dấu) |
| Đơn quá hạn | `GET /v1/orders?overdue=true` | đang `delivered` và **hôm nay sau `dueDate`**; số ngày trễ = `hôm nay − dueDate` (tính theo ngày, không âm) |
| Cần gọi / đang ở ngoài | `GET /v1/orders/call-list`, `/outside` | `outside` = mọi đơn đang `delivered`; `call-list` = đang `delivered` mà `dueDate ≤ hôm nay + 2 ngày`; cả hai sắp theo `dueDate` tăng dần |
| Phiếu thuê | `GET /v1/orders/{id}/slip?kind=rent|deliver|return` | văn bản để chia sẻ; **không** có thông tin ngân hàng/QR |

**Cần `Idempotency-Key`:** tạo đơn, ghi thanh toán, giao, nhận trả, quyết toán, hủy, tạo giữ chỗ.

### 5.10 Giữ chỗ (holds)

`holds(customerId, pieceId, from, to, until, amount, method, status active|released|expired|converted, note)`.
- `POST /v1/holds` `{customerName, phone, pieceId, from, to, until, amount, method, note}`: bắt buộc `amount > 0` (`hold_payment_required`); kiểm tra trùng lịch; ghi khoản thu `hold` (gắn `holdId`, chưa có đơn); món `ready` → `held`.
- `POST /v1/holds/{id}/extend` `{until}`; `POST /v1/holds/{id}/release` `{refund, method}` (nhả món, tùy chọn hoàn tiền).
- **Công việc nền của máy chủ:** giữ chỗ quá `until` → `expired`, trả món về `ready` nếu không còn đơn/giữ chỗ khác, **ghi lịch sử "auto_expire"** (người thực hiện: hệ thống). App hiện chạy việc này lúc đăng nhập và khi kéo làm mới; BE nên chạy **định kỳ** (mỗi vài phút).
- Một giữ chỗ chuyển thành đơn qua `POST /v1/orders` với `holdId`.

### 5.11 Danh sách chờ, nhu cầu bỏ lỡ, thử đồ, sửa đồ

- `waits` (danh sách chờ): `GET /v1/waits` kèm `matches` = món đang trống phù hợp (mẫu, size, khoảng ngày). `missed` (nhu cầu bỏ lỡ): ghi khi khách hỏi mà không có món; dùng cho báo cáo.
- `fittings` (lịch thử đồ): `date, start, end (phút), roomId, staffId, orderId, person, status, result`. **Kiểm tra khi ghi:** trùng giờ cùng **phòng** → `room_busy`; trùng giờ cùng **nhân viên** → `staff_busy`; ngày tiệm nghỉ → `shop_closed`; ngày sai → `invalid`. Khi kết quả "vừa" ghi `fitMemory` (khách, người mặc, món).
- `alterations` (sửa đồ cho đơn): `orderId, pieceId, status, due, cost, revertNeeded, revertDone`.

---

## 6. Món, giặt ủi, bảo quản, vòng đời

- **Trạng thái món (`pieces.status`):** `ready, held, rented, wait_wash, washing, repair, retired, disposed`.
- **Đổi tay trạng thái** `POST /v1/pieces/{id}/status`: **không** được chuyển món đang `rented` thẳng sang `ready` (`invalid_transition`).
- **Thanh lý / bán / hủy** `POST /v1/pieces/{id}/dispose` `{kind, price, reason}` → món `disposed`, ghi `disposals`.
- **Hàng đợi giặt ủi** (`cleaning`: `pieceId, kind dry|repair, status, partnerId, staffId, startedAt, dueAt, doneAt, cost, qc{itemId:bool}, orderId, returnedAt`):
  - Thứ tự trạng thái: `waiting → washing → ironing → qc → done`; việc sửa dùng `repairing`.
  - `POST /v1/cleaning` bắt đầu việc (mỗi món chỉ **một** việc đang mở); `POST /v1/cleaning/{id}/move` `{status}`; `PUT /v1/cleaning/{id}/qc` `{itemId, value}`.
  - **Cổng kiểm tra chất lượng:** chuyển sang `done` chỉ khi **mọi** mục `checklists(kind='qc')` đã tick, không thì `422 qc_incomplete`.
  - Khi `done`: `doneAt`, `washCount += 1` (việc sửa thì không cộng), `lastCareAt = now`. Món trở về `ready`, **hoặc `held`** nếu đang có đơn `reserved/paid` hay giữ chỗ chờ món đó.
  - Quy ước trạng thái món theo việc: `waiting → wait_wash`; `repairing → repair`; `done → ready/held`; còn lại `washing`.
- **Bảo quản:** món đến hạn khi `lastCareAt + careDays` đã qua; `POST /v1/pieces/{id}/care` `{note}` ghi nhật ký và cập nhật `lastCareAt`.
- **Món ế:** chưa thuê quá `rules.staleDays` ngày (tính từ lần thuê cuối, hoặc ngày mua).
- **Vòng đời:** số lần thuê (đơn không hủy/hết hạn có món đó) ÷ `maxRentals`; cảnh báo khi ≥ `lifecycleWarnPct`%.
- **Mua món mới** `POST /v1/purchases` `{supplierId, piece, cost, date}`: mã món trùng thì `409 duplicate_code`; tạo món (`status=ready`, `purchasePrice=cost`, `purchasedDate=date`) và ghi bản ghi `purchases`.
- **Vật tư** `POST /v1/supplies/{id}/move` `{qty, type in|out, note}`; dưới `min` thì vào danh sách cảnh báo.

---

## 7. Tiền: ca, quỹ, chi phí

- **Ca** (`shifts`): `POST /v1/shifts/open` `{startCash}` (đã có ca mở → `shift_open`); `POST /v1/shifts/close` `{counted, note}`. Mỗi lúc **chỉ một ca mở** của tiệm.
- **Tiền mặt dự kiến trong két** = `startCash` + Σ khoản `payments` có `method=cash` trong khoảng thời gian của ca (**cộng** mọi loại, **trừ** `refund` và `deposit_refund`; cọc thu vào vẫn cộng) + sổ quỹ `cash`: `in` cộng, `out` trừ (xem `expectedCash` trong [store_ops.dart](../lib/data/store_ops.dart)). Khi đóng ca máy chủ lưu `end`, `counted` (tiền đếm), `expected` (tính lúc đóng), `note`; chênh lệch dùng để đối soát.
- **Sổ quỹ** `cash`: thu/chi tiền mặt ngoài đơn: `type in|out, amount, reason, date`.
- **Chốt cuối ngày** `GET /v1/day-close?date=` → các tổng: thu theo `cash`/`transfer`, cọc nhận/hoàn, phí phát sinh… để đối chiếu sao kê (chỉ đọc, tính từ `payments`).
- **Chi phí** `expenses` (có loại **lặp hằng tháng** `recurring`: tính một lần mỗi tháng kể từ ngày bắt đầu) và **mục tiêu** `targets` theo tháng.

---

## 8. Khách và tích điểm

- `GET /v1/customers?q=` (tìm không dấu, theo tên, SĐT), `GET /v1/customers/{id}` kèm **đơn của khách** (`/orders`), tổng đã chi, điểm, hạng.
- Tìm theo SĐT: chỉ lấy chữ số, từ 6 số trở lên mới khớp (dùng khi tạo đơn).
- **Điểm tích lũy** (`loyalty{customerId, points, reason order|redeem|cancel, refId, at}`): số dư = tổng `points`. Hạng theo `loyalty.tiers`. Chi tiêu của khách = tổng `grand` các đơn `completed` không phải `comp` (xem `spentBy`).
- **Gộp khách trùng** `POST /v1/customers/{keepId}/merge` `{otherIds[]}`: chuyển đơn, điểm, người mặc, thử đồ… về `keepId` rồi xóa các khách còn lại; ghi lịch sử nhạy cảm.
- **Cảnh báo khách** (`attention`): app hiện cảnh báo khi tạo đơn cho khách có ghi chú lưu ý.

---

## 9. Báo cáo

Tất cả chỉ đọc, tính từ dữ liệu; nhận `range`/`from`/`to` như mục 3. Có thể gom vào `/v1/reports/{name}`:

| Báo cáo | Cách tính |
|---|---|
| Doanh thu | như mục 5.5; theo cột (mục 3), theo **nguồn đơn** (`source`), theo **khách** |
| Tỉ lệ lấp đầy | `Σ ngày món được thuê ÷ Σ ngày món có thể cho thuê` trong kỳ. Mỗi món tính từ `max(ngày mua/tạo, đầu kỳ)`; chỉ tính món còn cho thuê; chỉ booking `rent`; trần 100% |
| Mẫu thuê nhiều | mục 3 |
| Lãi/lỗ từng món (`economics`) | doanh thu của món = Σ mỗi dòng của món `(unit + surcharge) × (rent + surcharge − discount) ÷ (rent + surcharge)` trên các đơn không `cancelled/expired`; chi phí = tiền giặt/sửa (`cleaning.cost` + `alterations.cost`); khấu hao mỗi lượt = `purchasePrice ÷ maxRentals`; số lượt thuê đếm theo dòng. Công thức đầy đủ ở `economics()` trong [store_reports.dart](../lib/data/store_reports.dart) |
| Chi phí | tổng `expenses` theo loại, gồm cả khoản lặp; `monthlyFixed` = tổng khoản lặp |
| So với mục tiêu | doanh thu tháng ÷ `targets[month]` |
| Dự báo | chỉ khi có **≥ 1 năm** dữ liệu (trả `null` nếu chưa đủ) |
| Nhu cầu bỏ lỡ, mẫu hot theo mùa | từ `missed` và đơn các mùa trước |
| Vòng quay giặt (`turnaroundHours`) | giờ trung bình từ lúc trả đến lúc xong giặt |

---

## 10. Công cụ trong tab Tài khoản

| Việc | Ghi chú |
|---|---|
| Tìm kiếm toàn cục | `GET /v1/search?q=` → `{kind, id, title, subtitle}`, `kind` ∈ `order` (khớp mã đơn, tên, SĐT khách), `customer` (tên, SĐT), `piece` (mã món, tên mẫu, màu, chất liệu), `style` (mã, tên, màu, chất liệu, dịp). Tìm **không dấu**, không phân biệt hoa thường; **từ khóa tối thiểu 2 ký tự**; tối đa **60** kết quả |
| Nhập CSV | app **đọc file và xem trước** bằng bộ chọn file (không cần quyền lưu trữ). Nếu BE muốn kiểm tra: `POST /v1/import/{type}/preview` rồi `/commit` (`type` = mẫu, món, nhân viên…). Hiện logic xem trước ở `previewCsv`/`importCsv` |
| Xuất dữ liệu | app tự tạo CSV (UTF-8 BOM) rồi chia sẻ. Cần API **lấy toàn bộ danh sách** theo loại (đơn, món, khách, thu chi…), có phân trang |
| Việc cần làm, ghi chú | CRUD `todos`, `notes`. `todos` có `repeat` (`none`/`daily`/`weekly`/`monthly`) và `due`: hoàn thành việc **lặp** thì **dời `due`** (+1 ngày/+7 ngày/+1 tháng) thay vì đánh dấu xong; việc không lặp thì `done = true` (`POST /v1/todos/{id}/complete`) |
| Lịch năm | từ `peaks` + `closed-dates` |
| Lịch sử thao tác nhạy cảm | `GET /v1/admin-log` (chỉ đọc) — mục dưới |

**Lịch sử thao tác nhạy cảm** (`adminActions`): ghi tự động `{by, byName, target, targetId, action, note, at}` cho: tạo đơn ưu đãi/miễn phí, hủy đơn, hoàn tiền, sửa/xóa dữ liệu quan trọng, thêm/thu hồi admin, đặt lại mật khẩu, thanh lý món, gộp khách, nhập CSV, tự hết hạn giữ chỗ (người thực hiện `system`). **Chỉ máy chủ được ghi.**

---

## 11. Công việc nền phía máy chủ

| Việc | Tần suất đề nghị |
|---|---|
| Hết hạn giữ chỗ (mục 5.10) | mỗi vài phút |
| Dọn phiên hết hạn, resume token quá 30 ngày | hằng ngày |
| Sao lưu dữ liệu từng tiệm | hằng ngày, theo chính sách bên bạn |
| Xóa vĩnh viễn dữ liệu của tiệm đã xóa | ngay khi xóa (không soft-delete) |

Thông báo nhắc việc **không** do máy chủ đẩy.

---

## 12. Bảng mã lỗi (`code`)

App dịch sang tiếng Việt/Anh theo `code` ([strings.dart](../lib/core/strings.dart)). Mã lạ sẽ hiện thông báo chung, nên **không đổi tên mã đã có**.

| `code` | Khi nào | HTTP |
|---|---|---|
| `invalid_credentials` | sai email hoặc mật khẩu | 401 |
| `too_many_attempts` | khóa đăng nhập tạm | 429 |
| `account_revoked` | tài khoản bị thu hồi | 403 |
| `session_expired` | token/phiên hết hiệu lực | 401 |
| `weak_password` | mật khẩu yếu | 422 |
| `wrong_password` | mật khẩu hiện tại sai (đổi mật khẩu, xóa tài khoản) | 422 |
| `same_password` | mật khẩu mới trùng cũ | 422 |
| `email_taken` | email đã có | 409 |
| `invalid_email` | email sai dạng | 422 |
| `required_missing` | thiếu trường bắt buộc | 422 |
| `last_admin` | không thu hồi admin cuối (xóa tài khoản admin cuối là xóa cả tiệm) | 409 |
| `booking_conflict` | món trùng lịch (`data` = pieceId) | 409 |
| `piece_not_ready` | món chưa/không cho thuê | 409 |
| `no_lines` | đơn chưa có món | 422 |
| `comp_reason_required` | ưu đãi/miễn phí/giá đặc biệt thiếu lý do | 422 |
| `hold_payment_required` | chưa thu tiền giữ chỗ | 422 |
| `invalid_transition` | chuyển trạng thái không hợp lệ | 422 |
| `promo_invalid` | mã giảm giá không dùng được | 422 |
| `in_use` | đang được dùng, không xóa được | 409 |
| `duplicate_code` | mã đã tồn tại | 409 |
| `qc_incomplete` | chưa tick đủ checklist QC | 422 |
| `shift_open` | đã có ca đang mở | 409 |
| `room_busy`, `staff_busy`, `shop_closed` | lịch thử đồ | 409 |
| `snooze_limit` | (cục bộ, không cần BE) | — |

---

## 13. Phía app khi ghép (để hai bên cùng nắm)

1. **Lớp cần thay:** `LocalServer` + các hàm trong `AppStore`/extension. Giao diện gọi `store.xxx()` rồi đọc `store.table('...')`; khi ghép API nên **giữ nguyên chữ ký hàm** và đổi bên trong thành gọi HTTP, để không phải sửa màn hình.
2. **Đọc dữ liệu:** app hiện đọc **đồng bộ** từ bộ nhớ (`store.orders`, `store.pieces`…). Phương án ghép: (a) tải toàn bộ vào bộ nhớ sau đăng nhập rồi đồng bộ lại theo từng thay đổi (đơn giản, cần `GET /v1/sync?since=` trả thay đổi từ thời điểm X); hoặc (b) chuyển từng màn sang gọi theo trang (sạch hơn, nhưng sửa nhiều màn). **Cần thống nhất hướng này sớm.**
3. **Trạng thái tải / lỗi mạng:** mọi lệnh ghi đã bọc `act()` hiện toast khi có lỗi; cần thêm: hiện lỗi mạng (`network`), thử lại, và **giữ bản nháp đơn khi hết phiên** (đã có `orderDraft` trong bộ nhớ).
4. **Khóa `Idempotency-Key`:** app sinh UUID mỗi lần bấm "Xác nhận", gửi lại **cùng key** khi thử lại.
5. **Múi giờ:** app hiện dùng giờ máy; khi ghép cần đổi thành giờ theo `rules.timezone` cho các phép "hôm nay", "quá hạn".
6. **Đồng hồ máy chủ là chuẩn** cho `createdAt`, `at`, `until`, hết hạn giữ chỗ; không dùng giờ máy khách.
7. **Cất `resumeToken`:** hiện lưu trong `SharedPreferences`; khi ghép nên chuyển sang kho an toàn của Android (Keystore).
8. **Gỡ trước khi lên Play:** tài khoản demo và dữ liệu mẫu chỉ có ở bản debug (`kDebugMode`); xác nhận bản release không còn.

---

## 14. Câu hỏi cần BE chốt

1. **Hướng đồng bộ dữ liệu** (mục 13.2): tải toàn bộ + `sync?since=`, hay theo trang từng màn?
2. **Endpoint tổng hợp** `GET /v1/home` và `GET /v1/reminders/source` có làm được không, hay để app gọi nhiều danh sách rồi tự tính?
3. **Gợi ý size** và **tìm món trống** làm ở BE hay để app tính? (Tìm món trống bắt buộc dựa trên lịch của BE.)
4. **Đăng ký tiệm công khai:** cần xác minh email, chống spam thế nào?
5. **Quên mật khẩu:** BE gửi email, hay chỉ cho admin khác đặt lại? (App hiện hỗ trợ cả hai: màn "Quên mật khẩu" gọi `forgot`, và admin khác đặt lại trong Quản trị viên.)
6. **Đồng thời:** có dùng `If-Match`/`updatedAt` chặn ghi đè khi hai admin cùng sửa không?
7. **Định dạng thời điểm:** UTC có offset (đề nghị) hay giờ địa phương của tiệm?
8. **Xóa dữ liệu:** xác nhận xóa thật cả tiệm khi admin cuối xóa tài khoản, và cách xử lý bản sao lưu.

---

## Phụ lục A. Trạng thái và mã hằng

| Nhóm | Giá trị |
|---|---|
| `orders.status` | `reserved, paid, delivered, returned, completed, cancelled, expired` |
| `pieces.status` | `ready, held, rented, wait_wash, washing, repair, retired, disposed` |
| `payments.kind` | `hold, rent, deposit, deposit_refund, fee, refund` |
| `payments.method` | `cash, transfer, comp, deposit` (`deposit` chỉ cho `fee` trừ cọc) |
| `cleaning.status` | `waiting, washing, ironing, repairing, qc, done` |
| `orders.source` | `phone, zalo, counter, family, other` |
| `holds.status` | `active, released, expired, converted` |
| Nhắc việc (`RKind`, cục bộ) | `deliver, return, overdue, fitting, hold, cleaning, supply, peak, todo, shift, care, summary` |

## Phụ lục B. Tệp nguồn để đối chiếu

| Chủ đề | Tệp |
|---|---|
| Phiên, đăng nhập, đăng ký, admin, `loadHome` | [lib/data/store.dart](../lib/data/store.dart) |
| Đơn, giá, lịch, giữ chỗ, thử đồ | [lib/data/store_orders.dart](../lib/data/store_orders.dart) |
| Giặt ủi, ca/quỹ, khách, CSV, tìm kiếm | [lib/data/store_ops.dart](../lib/data/store_ops.dart) |
| Báo cáo | [lib/data/store_reports.dart](../lib/data/store_reports.dart) |
| Kiểu dữ liệu, trạng thái | [lib/data/models.dart](../lib/data/models.dart) |
| Lưu trữ giả (thay bằng API) | [lib/data/local_server.dart](../lib/data/local_server.dart) |
| Mã lỗi hiển thị | [lib/core/strings.dart](../lib/core/strings.dart) |
| Mô tả sản phẩm (đã cập nhật phần QR/ngân hàng) | [docs/RentRack-mo-ta.md](RentRack-mo-ta.md) |

> **Lưu ý về độ chính xác:** các quy tắc ở mục 5–9 được rút từ code đang chạy và đã có test chạy qua toàn bộ luồng thuê (đặt → giao → trả → quyết toán → giặt). Một số bảng nhỏ (mục 4) mô tả theo màn hình nhập liệu; **khi cần chi tiết từng trường, đối chiếu định nghĩa `FSpec` trong tệp màn hình tương ứng** thay vì chỉ dựa vào bảng.
