# 帳號與目標設定：每日目標、顯示名稱、改密碼、管理員的重設密碼連結

**狀態：** 設計定稿，待實作
**日期：** 2026-10-08
**分支：** `feat/account-settings`
**前置：** 邀請（`2026-10-06-invites-design.md`）、session 撤銷（`2026-09-11-session-revocation-design.md`）、
安全補強（`2026-10-07-hardening-design.md`）、電腦版版面（`2026-10-08-desktop-layout-design.md`）

---

## 1. 範圍

### 1.1 為什麼要做

朋友要開始用了，而現在：

- **設不了每日目標**：後端 `/api/targets` 從 P1 就有，前端沒有任何畫面；總覽與飲食頁的分母永遠是「未設定」。
- **改不了顯示名稱**：`PATCH /api/me` 有，沒有畫面。
- **改不了、也忘不得密碼**：只有管理員 SSH 進 NAS 跑 `create-user` 才能重設。

### 1.2 這份規格做的事

1. 「我的」的「每日目標」卡片＋`/me/targets`：存了就**從今天起**生效，過去的日子維持原本的目標。
2. 「我的」的帳號卡片：顯示名稱＋email，行內「修改名稱」。
3. `/me/password` 改自己的密碼：成功後**其他裝置全部登出**，這台換一組新票繼續用。
4. 管理員在「我的」的「所有帳號」替一般使用者產生**一次性重設密碼連結**（24 小時、只能用一次）；
   使用者打開 `/reset-password#<碼>` 設新密碼，所有裝置登出，再自己登入。

### 1.3 明確不做

- 改 email、改時區、刪帳號、改角色。
- 使用者自己「忘記密碼」寄信（沒有 email 寄送，也不打算有）。
- 管理員帳號的重設連結（自己用「修改密碼」，其他管理員用 CLI——§2 決定 9）。
- 目標的 `label`（減脂期之類）、「從某天開始」的未來目標、目標的歷史清單畫面。
- 即時踢掉其他裝置：access token 不查資料庫，撤銷之後最多還能用 15 分鐘（handover §8.1，刻意的缺口）。

---

## 2. 決定

| # | 決定 | 理由 |
|---|---|---|
| 1 | 存目標走**新端點 `PUT /api/targets/today`**，「今天」由後端用 `today_in_timezone(user.timezone)` 算 | 既有的兩個端點都做不到：`PATCH /api/targets/{id}` 對「今天才開始的那一筆」回 `422 EFFECTIVE_DATE_TOO_EARLY`（同一天存第二次就壞）；`POST` 要前端送 `effective_from`，而**前端不能自己算今天**（handover §10）。一個端點涵蓋「沒有目標」「目標昨天以前開始」「目標今天開始」三種狀態 |
| 2 | 今天才開始的那一筆**原地改**；更早開始的**關閉＋開新**（沿用 `update_target` 的順序：先 flush 關閉，再 insert） | 期間是 `[from, to)`：今天才開始的列還沒有任何「過去的一天」，原地改不會改寫歷史——§4.4「舊列的數值永遠不動」保護的是過去的日子，這裡沒有 |
| 3 | 新期間的結束日：有目前的期間 → 沿用它的 `effective_to`；沒有 → 下一筆未來期間的開始日（沒有就開放式）；`label` 沿用目前那筆 | 畫面不會造出未來期間，但 API 造得出來；不這樣算，有未來期間的人存一次就 409 |
| 4 | 四個值都**必須送**（PUT＝整組取代），`null`＝不設定；值 **> 0**、≤ 20000 kcal／2000 g、最多兩位小數 | 「省略＝沿用」是 PATCH 的語意，表單送的是整組，混用會讓「清空一格」悄悄變成「沿用」。0 的目標算不出比例（stats 回 null），畫面上跟「未設定」分不出來 |
| 5 | 並行：不加鎖，靠既有的 `EXCLUDE` 約束；撞上 → rollback → `409 TARGET_CONFLICT` | 單人使用；資料庫已經保證不重疊，輸的那一方乾淨地失敗、整筆 rollback，重存一次就走「原地改」那條路 |
| 6 | 「目前生效的目標」從 `GET /api/stats/daily` 的 `target` 讀（`useDailyStats`），不加新的 GET | 那個 query 已經存在、已經用後端的今天、已經離線快取；存完失效它，總覽與飲食頁同時更新 |
| 7 | 修改名稱：「我的」帳號卡片裡的**行內表單**，不開新頁 | 一個欄位；FriendsCard 已經有行內表單的寫法 |
| 8 | 改密碼的錯誤**不用 401**：目前密碼錯 → `422 CURRENT_PASSWORD_INCORRECT` | `client.ts` 對 401 會換票並**重送一次**——錯的密碼會被驗兩次 Argon2、算兩次失敗 |
| 9 | 改密碼的限速：**共用 `login_rate_limiter`**，鍵是這個帳號的 email（小寫） | 偷到 access token 的人不該多一扇猜密碼的門：兩扇門共用每 email 5 次／60 秒的額度，總數不變。access token 15 分鐘就死、拿不到 refresh token 的話最多約 75 次。猜對（＝本人）就重置，跟登入一樣 |
| 10 | 「新密碼跟目前的一樣」用字串比對，在 Argon2 之前 → `422 PASSWORD_UNCHANGED` | 目前的密碼稍後會被驗證，「新＝目前」等價於兩個送進來的字串相同；不用多跑一次 Argon2，也不洩漏任何東西（兩個字串都是呼叫者自己送的） |
| 11 | 改密碼成功：同一個交易裡改雜湊、撤銷這個人還沒用的重設連結、撤銷**所有** refresh session；然後開一條新 session、回新的一組票 | 「其他裝置登出」要包含這台舊的 family（access token 不帶 family，分不出哪條是這台）；新開的必須在撤銷**之後**，否則自己也被撤銷 |
| 12 | 重設連結**只能給一般使用者**；管理員帳號（包括自己）→ `422 RESET_NOT_FOR_ADMINS` | 原本的決定是「不能給自己」。擴大的理由：偷到管理員 access token 的人，不能靠重設連結把管理員帳號（自己的或另一個管理員的）變成他的；管理員的復原路線本來就是 SSH＋CLI |
| 13 | 重設連結：`secrets.token_urlsafe(32)`、只存 SHA-256、24 小時、只能用一次；產生新的會撤銷這個人還沒用的舊連結 | 同邀請（邀請規格 §2）。24 小時：連結握在手上就等於帳號，比邀請的 7 天短 |
| 14 | 「同一個人最多一條活連結」：產生時 `SELECT … FOR UPDATE` 那個使用者列（讓並行的兩次排隊），**部分唯一索引**是最後一道 | 同 `refresh_sessions` 的 `uq_…_one_live_per_family`：程式碼保證，資料庫再保證一次 |
| 15 | 公開的兩個端點（狀態、重設）**不限速** | 邀請的 `invite-status` 也沒有限速器（邀請規格 §3.4，「與原始決定的差異」第 1 點）。無效的碼在 Argon2 之前就回 403（一次 SHA-256＋一次索引查詢）；256 位元猜不到 |
| 16 | 重設成功**不自動登入**，回 204；清掉那個 email 的登入失敗計數 | 讓使用者用新密碼親自登入一次，確認記得住；之前猜錯被限速的人不用再等一分鐘 |
| 17 | 稽核紀錄寫 INFO（使用者 id、管理員 id、連結 id；**不寫碼、不寫密碼、不寫 email**），並在 `app/main.py` 讓 `app.*` 的 INFO 真的輸出 | 實測：uvicorn 的預設設定只替 `uvicorn.*` 掛 handler，`app.*` 的 INFO 落到 Python 的 lastResort（只輸出 WARNING 以上）——不設定的話這些紀錄寫了等於沒寫 |
| 18 | 管理員介面是「我的」裡的「所有帳號」卡片，不是新頁 | 帳號只有個位數；跟「邀請朋友」放在一起，連結的顯示與複製照抄 |
| 19 | 新路由的寬度：`/me/targets`、`/me/password` 是 `form`（480px）；`/reset-password` 沒登入，走 `.app-auth` | 兩頁都是單欄表單，同記帳與記一餐 |
| 20 | `MIN_PASSWORD_LENGTH` 搬到 `app/security/password.py`；`app/cli.py` 從那裡 import（名字留在 cli 裡，既有的引用不變） | schema 要用它，而 schema 不該 import `app.cli`（會帶進資料庫連線與照片儲存）。註冊的 `min_length=8` 一起改用它 |

### 與原始決定的差異

1. **公開端點的限速。** 原始指示是「比照 invite-status 的 keyed limiter」——`invite-status` 其實**沒有**限速器
   （`app/api/routes/auth.py`；邀請規格 §3.4 寫明不加）。照邀請的做法不加，理由同決定 15。
2. **稽核紀錄的 INFO 原本看不到**（決定 17）。保留 INFO，另外加 logger 設定。
3. **目標的下限是 > 0**，不是既有 schema 的 `ge=0`（決定 4）。只限新端點；`POST`／`PATCH /api/targets` 不動。
4. **`MIN_PASSWORD_LENGTH` 換位置**（決定 20），值與 CLI 的行為不變。
5. **重設連結不能給任何管理員**，不只是自己（決定 12）。
6. **「改密碼、兌換連結、撤銷 session 在同一個交易」的寫法。** 撤銷用既有的 `revoke_all_for_user`，它取 advisory lock
   之後**自己 commit**。所以順序是：條件式 `UPDATE … RETURNING`（兌換）→ `UPDATE users`（新雜湊）→ `revoke_all_for_user`
   （它的 commit 就是這個交易的 commit）。之前兩個寫入都沒 commit，一起進去或一起不進去。規則寫進註解，並有測試
   證明（「兌換之後撤銷之前失敗 → 密碼沒變、連結沒用掉」）。
7. **目前的目標讀 `stats/daily`**，不新增讀取端點（決定 6）。

---

## 3. API

錯誤一律是既有的信封。`TokenResponse`、`UserResponse`、`TargetResponse` 沿用。

### 3.1 `PUT /api/targets/today`（需要登入）

請求 `TargetTodayRequest`：`{ kcal, protein_g, fat_g, carb_g }`，四個鍵都必填，值是 `Decimal | null`
（`gt=0`；kcal `le=20000`、三大營養素 `le=2000`；`max_digits=8, decimal_places=2`）。

`today = today_in_timezone(user.timezone)`，找 `effective_from <= today < coalesce(effective_to, ∞)` 的那一筆：

| 狀態 | 做什麼 | 回應 |
|---|---|---|
| 那一筆 `effective_from == today` | 原地改四個值（`label` 不動） | `200 TargetResponse`（同一個 id） |
| 那一筆 `effective_from < today` | `effective_to = today` → flush → 插 `[today, 原本的 effective_to)`，`label` 沿用 | `200`（新的 id） |
| 沒有 | 插 `[today, 下一筆未來期間的開始日或 null)`，`label` null | `200` |

- 插入撞上 `ex_user_targets_no_overlap` → rollback（連關閉一起復原）→ `409 TARGET_CONFLICT`「目標剛被另一台裝置改過，請重新整理再試」。
- 少一個鍵、0、負數、超過上限、三位小數 → `422 VALIDATION_ERROR`。

### 3.2 `POST /api/me/password`（需要登入）

請求 `ChangePasswordRequest`：`current_password`（1–1024：CLI 建的密碼沒有上限，驗證交給 Argon2）、`new_password`（`MIN_PASSWORD_LENGTH`–128）。

1. `new_password == current_password` → `422 PASSWORD_UNCHANGED`「新密碼不能跟目前的密碼一樣」。
2. `login_rate_limiter.check(email)` → 超過 → `429 TOO_MANY_LOGIN_ATTEMPTS`（帶 `Retry-After`）。
3. `run_in_threadpool(verify_password, …)` 失敗 → `record_failure(email)` → `422 CURRENT_PASSWORD_INCORRECT`「目前的密碼不正確」。
4. `record_success(email)`；`run_in_threadpool(hash_password, new)`。
5. 同一個交易：設 `password_hash`、撤銷這個人還沒用的重設連結、`revoke_all_for_user`（commit）。
6. `start_session` → `200 TokenResponse`。log INFO「使用者 {id} 修改了密碼」。

### 3.3 `GET /api/admin/users`（管理員）

`200 [{ id, email, display_name, role }]`，依 `id` 排序。一般使用者 → `403 FORBIDDEN`。

### 3.4 `POST /api/admin/users/{user_id}/password-reset`（管理員）

1. `SELECT … FROM users WHERE id = :id FOR UPDATE`；不存在 → `404 USER_NOT_FOUND`「找不到這個帳號」。
2. 對象是管理員（包括自己）→ `422 RESET_NOT_FOR_ADMINS`「管理員帳號不能用重設連結：自己的密碼請用「修改密碼」，其他管理員請用命令列」。
3. 把這個人 `used_at IS NULL AND revoked_at IS NULL` 的連結全部設 `revoked_at = now()`（含已過期的）。
4. 插新的一列（`created_by` = 管理員、`expires_at = created_at + 24h`），commit。
5. `201 { token, expires_at }`——**`token` 只在這個回應出現一次**。log INFO「管理員 {admin_id} 產生了使用者 {user_id} 的重設密碼連結（reset_id={id}）」。

### 3.5 `POST /api/auth/password-reset-status`（不需登入）

`{ token }`（1–100 字）→ `200 { valid: bool }`。條件同 3.6 步驟 1。token 在 body，不在網址。

### 3.6 `POST /api/auth/password-reset`（不需登入）

請求 `{ token（1–100）, new_password（MIN_PASSWORD_LENGTH–128）}`。

1. **先查連結，在 Argon2 之前**：`token_hash = sha256(token)`、沒用、沒撤銷、`expires_at > now()`。找不到 →
   `403 RESET_LINK_INVALID`「這個重設密碼連結已經失效，請跟管理員要一個新的」。四種失效（不存在、用過、過期、撤銷）同一個錯誤。
2. `run_in_threadpool(hash_password, new_password)`。
3. 同一個交易：條件式 `UPDATE password_reset_tokens SET used_at = now() WHERE id = :id AND <還能用> RETURNING user_id`
   （沒有列 → rollback → 同一個 403）→ `UPDATE users SET password_hash = … WHERE id = :uid RETURNING email`
   → `revoke_all_for_user`（commit）。
4. `login_rate_limiter.record_success(email)`；log INFO「使用者 {uid} 用重設連結重設了密碼（reset_id={id}）」；`204`。

兩個請求同時用同一條連結：第二個的條件式 UPDATE 等第一個的列鎖，第一個 commit 後條件不成立 → 0 列 → 403。

---

## 4. 資料模型與 migration

### 4.1 `password_reset_tokens`（`0016_create_password_reset_tokens`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `BigInteger` identity | `pk_password_reset_tokens` |
| `user_id` | FK `users.id` `ON DELETE CASCADE` | 要重設的帳號 |
| `token_hash` | `Text`，唯一（`uq_password_reset_tokens_token_hash`） | SHA-256 hex，明碼不進資料庫 |
| `created_by` | FK `users.id` `ON DELETE CASCADE` | 產生它的管理員（同 `invites.created_by`） |
| `created_at` | `timestamptz`，`server_default now()` | |
| `expires_at` | `timestamptz` | `created_at + 24h`，後端算 |
| `used_at` | `timestamptz`，可 null | |
| `revoked_at` | `timestamptz`，可 null | |

約束：

- `ck_password_reset_tokens_expires_after_created`：`expires_at > created_at`
- `ck_password_reset_tokens_not_both_used_and_revoked`：`used_at IS NULL OR revoked_at IS NULL`
- `uq_password_reset_tokens_one_live_per_user`：`UNIQUE (user_id) WHERE used_at IS NULL AND revoked_at IS NULL`
  （同時服務「撤銷這個人的活連結」與 `ON DELETE CASCADE` 的查找）

`alembic check` 乾淨（`tests/conftest.py` 每次都跑）；`downgrade` 真的跑一次（handover §6 第 29 種）。

**退版安全**：只加一張表，舊版程式不讀它（不進 `deploy.sh` 的 `ROLLBACK_UNSAFE_REVISIONS`）。

### 4.2 其他

- `app/security/password.py`：`MIN_PASSWORD_LENGTH = 8`、`MAX_PASSWORD_LENGTH = 128`。
- `app/main.py`：`logging.getLogger("app")` 設 INFO、沒有 handler 就掛一個 `StreamHandler`。

---

## 5. 前端

### 5.1 「我的」

順序：帳號卡片 → 每日目標卡片 → 好友 → 審核（管理員）→ 邀請朋友（管理員）→ **所有帳號（管理員）** → 重新整理 → 登出。

- **帳號卡片**：顯示名稱（粗體）＋email（灰）；「修改名稱」按鈕 → 行內表單（「顯示名稱」輸入框，預填目前的名字，
  `maxLength=50`）＋「儲存」「取消」。打開時焦點到輸入框；取消或儲存成功後焦點回到「修改名稱」。前端擋空白
  （「名稱不能是空白」）；`PATCH /api/me { display_name }`；成功 → `setQueryData(me)`＋失效 `me`；422 →
  `describeFieldErrors`；其他 → 「儲存失敗，請再試一次」。卡片底下一個連結「修改密碼」→ `/me/password`。
- **每日目標卡片**：`h2.sectionTitle`「每日目標」；`<dl>` 四列：熱量（kcal）、蛋白質（g）、脂肪（g）、碳水（g），
  值用 `formatMacro`，`null`（或整個 `target` 是 null）顯示「未設定」；連結「修改」（可及名稱「修改每日目標」）→
  `/me/targets`。`useDailyStats` 載入中「載入中…」，沒有資料「無法載入目前的目標」。

### 5.2 `/me/targets`

`ui.screen`；h1「每日目標」；說明「留空＝不設定。從今天開始生效，之前的日子維持原本的目標。」；四個
`inputMode="decimal"` 欄位（標籤同 5.1），預填目前的值。`stats/daily` 還沒載入 → 「載入中…」；沒有資料 →
「無法載入目前的目標」**不顯示表單**（空白表單存下去會把目標清掉）。

前端檢查（`lib/decimal.ts` 新增 `checkTargetInput(value, max)`；畫面不碰 `decimal.js`）：空白＝null；否則要是一般的
正小數（`isPlainPositiveDecimal` 同一條規則）、最多兩位小數、不超過上限。錯誤列在送出鈕上方的 `role="alert"`，
例：「熱量要大於 0、最多兩位小數」「熱量不能超過 20000」。

「儲存」→ `PUT /api/targets/today`（`mutate(vars, { onSuccess })`：會導頁的事放在呼叫端的 callback，handover §7）→
失效 `dailyStats` 與 `rangeStatsAll` → `navigate("/me")`。`409` → 後端訊息；`422` → `describeFieldErrors`；
其他 → 「儲存失敗，請再試一次」。

### 5.3 `/me/password`

`ui.screen`；h1「修改密碼」；「目前的密碼」（`current-password`）、「新密碼」、「再輸入一次新密碼」（`new-password`）。
前端檢查：新密碼至少 8 字（「新密碼至少要 8 個字」）、兩次一樣（「兩次輸入的新密碼不一樣」）、跟目前的不同
（「新密碼不能跟目前的密碼一樣」）。送出鈕「更新密碼」→ `auth/session.ts` 的 `changePassword()`（打端點、`setTokens(新的一組)`）。

- 成功：表單換成 `role="status"` 的「密碼已更新。其他裝置都已登出，這台不用重新登入。」（`tabIndex=-1`，焦點移過去）
  ＋連結「回我的」。
- `CURRENT_PASSWORD_INCORRECT`、`PASSWORD_UNCHANGED` → 後端訊息；`429` → 後端訊息＋「（N 秒後可再試）」；
  `422` 其他 → `describeFieldErrors`；其他 → 「修改失敗，請再試一次」。

### 5.4 「所有帳號」（管理員）

`components/AccountsAdmin.tsx`，`h2`「所有帳號」。清單每列：名字、email（**各自一個元素**，不拼成「名字（email）」）、
管理員加「管理員」標籤。一般使用者的列有按鈕「產生重設密碼連結」（可及名稱「產生重設密碼連結：{名字}（{email}）」）；
管理員的列寫「用命令列重設」。**不列自己**：自己的帳號在最上面的帳號卡片；而 `e2e/auth.spec.ts` 用
`getByText(ADMIN.email)` 等「我的」載入完，同一個 email 出現兩次會撞嚴格模式。名字與 email 分開放，理由相同：
`e2e/invites.spec.ts` 找的是 `E2E 朋友（{email}）` 這個字串，拼成同樣格式就會對到兩個元素。

產生後在卡片上方顯示「給 {名字} 的重設密碼連結」：唯讀輸入框（標籤「重設密碼連結」，`${origin}/reset-password#${token}`）、
「分享」（有 `navigator.share` 時）、「複製」、「這個連結只會顯示這一次，24 小時內有效、只能用一次。再產生一次，舊的就不能用了。」
再產生別人的就換掉。`404`／`422` → 後端訊息顯示在卡片層並失效清單；其他 → 「產生失敗，請再試一次」。
清單 `useAdminUsers`（`["admin", "users"]`，`staleTime: 0`，理由同 `useInvites`）。

### 5.5 `/reset-password#<碼>`

`App.tsx`：沒登入且 `pathname` 是 `/reset-password` 或 `/reset-password/` → `<main className="app-auth"><ResetPassword /></main>`；
登入後的 router 加 `<Route path="/reset-password" element={<ResetPasswordWhileLoggedIn />} />`。

碼的讀法同 `/join`（`#` 之後開頭連續的 `[A-Za-z0-9_-]`；抽成 `lib/link-token.ts` 的 `readLinkToken`，`Join` 的
`readInviteToken` 改成轉出它）。

- 碼是空的 → 失效畫面；否則先 `password-reset-status`：查詢中「確認連結中…」；`valid: false` 或 422 → 失效畫面
  （「這個重設密碼連結已經失效，請跟管理員要一個新的」＋「去登入」）；其他錯誤 → 「無法確認連結，請檢查網路後重新整理」。
- 有效 → 表單：「新密碼」「再輸入一次新密碼」，前端檢查同 5.3 前兩條；「重設密碼」。
- 成功（204）→ `history.replaceState(null, "", "/")`（碼從網址列消失）→ `role="status"`「密碼已重設，請登入」（焦點移過去）
  ＋「去登入」（`<a href="/">`）。**不自動登入。**
- `403 RESET_LINK_INVALID` → 失效畫面；`422` → `describeFieldErrors`；其他 → 「重設失敗，請再試一次」。
- **已登入的人打開**：「你已經登入了。這個連結是給忘記密碼的人用的；要改自己的密碼，請到「我的」→「修改密碼」。」
  ＋「回總覽」；不打任何重設端點；`navigate("/reset-password", { replace: true })` 把碼從網址列拿掉（同 `JoinWhileLoggedIn`）。

### 5.6 共通

- 只用 `ui.module.css`（`.screen`、`.primary`、`.secondary`、`.sectionTitle`）、`Card`、設計變數；按鈕與連結 ≥ 44px；
  輸入框字級 ≥ 16px（`index.css` 的全域規則已保證）。
- `lib/layout.ts` 的 `FORM` 加 `/me/targets`、`/me/password`；手機版與電腦版都能用。
- 標籤一律 `<label htmlFor>`；錯誤 `role="alert"`。

---

## 6. 安全

- **碼不落地**：資料庫只有 SHA-256；碼放在 `#` 後面（不送到伺服器、不進 Caddy／Tailscale 的存取紀錄、不進 Referer）；
  狀態與重設的 API 都把碼放在 body；後端任何 log 都不寫碼、密碼、email（只寫 id）——有測試掃 `caplog.text`。
- **沒有使用者列舉**：公開端點只收碼，不收 email；四種失效回同一個錯誤；回應裡沒有帳號資訊（狀態端點只回 `valid`）。
  管理員清單只給管理員。
- **Argon2 之前先過便宜的關**：重設先查碼；改密碼先比字串、再查限速。兩條 Argon2 都在執行緒池（受 `MAX_CONCURRENT_HASHES` 管）。
- **限速**：改密碼共用登入的每 email／全域額度（決定 9）。公開端點不限速（決定 15）。
- **一次性**：條件式 `UPDATE … RETURNING`；CHECK「不會同時用掉又撤銷」；部分唯一索引「一個人最多一條活連結」。
- **撤銷**：改密碼與重設都撤銷所有 refresh family；**已發出的 access token 最多再用 15 分鐘**（既有缺口，不在這裡修）。
- **管理員權限的邊界**：偷到管理員 access token 的人可以替一般使用者產生重設連結（＝接管那個帳號）——這是「管理員能
  重設密碼」本身的代價，跟今天 SSH 跑 `create-user` 等價；每次產生都有 INFO 稽核紀錄，而且不能拿來接管管理員帳號（決定 12）。
- **前端**：改密碼的新票走 `setTokens`（refresh token 在 localStorage，同分頁與同瀏覽器的其他分頁都用新的）；
  admin 帳號清單與邀請清單一樣會進離線快取（只在管理員自己的裝置上）。

---

## 7. 測試

### 7.1 後端

- **目標**：三種狀態各一條（原地改：同一個 id、值換掉、昨天的 `stats/daily` 不變；關閉＋開新：舊列 `effective_to = 今天`、
  數值沒動，昨天的分母是舊的、今天的是新的；沒有目標：開放式）；有未來期間時新期間在它開始前結束；`label` 沿用；
  `null` 清掉一格；少一個鍵、0、負數、上限＋0.01、三位小數 → 422；**時區**：`today_in_timezone` 收到的是使用者的時區
  （spy 記參數，使用者時區設成跟 UTC 不同）；並行的 409（接縫：讓「下一筆未來期間」的查詢回 None、插入撞上）→
  什麼都沒寫入（rollback 後讀）；每一條斷言寫入前先 `rollback()`（第 11 種）。
- **改密碼**：成功 → 回新的一組票；**兩台裝置的舊 refresh token 都 401、新的那張換得到票**；舊密碼登不進、新密碼登得進
  （rollback 之後）；還沒用的重設連結被撤銷；目前密碼錯 → 422、密碼沒變、session 沒被撤銷；字串相同 → 422 而且沒呼叫
  `verify_password`（spy）；**跟登入共用額度**（3 次登入失敗＋2 次改密碼失敗 → 第 6 次改密碼 429，而且沒有跑 Argon2）；
  猜對會重置；`verify_password` 與 `hash_password` 在執行緒池；新密碼 7 字 → 422；沒登入 → 401。
- **管理員**：一般使用者打兩個端點 → 403 `FORBIDDEN`；清單的欄位與順序；產生 → 201、`token` 只在回應、資料庫只有雜湊、
  24 小時；對管理員（自己、另一個）→ 422 `RESET_NOT_FOR_ADMINS` 而且沒有寫入；不存在 → 404 `USER_NOT_FOUND`（連 code 一起，
  第 32 種）；再產生一次 → 舊的被撤銷、新的能用；資料庫擋同一個人的兩條活連結（`IntegrityError` 指名索引）、擋「用掉又撤銷」。
- **重設**：成功 → 204、密碼換掉、連結 `used_at`、**所有 family 撤銷**（rollback 之後驗）；四種失效 → 403 而且**沒有呼叫
  `hash_password`**（spy；過期用時間造）；兌換落空（monkeypatch 讓兌換回 None）→ 403、密碼沒變；兌換之後撤銷之前失敗
  （monkeypatch `revoke_all_for_user` 丟例外）→ 密碼沒變、連結沒用掉；`password-reset-status` 有效 true（而且不會用掉）、
  四種失效 false；成功後該 email 的登入失敗計數清空。
- **並行**：兩條真的連線同時兌換同一條連結 → 只有一條成功（同 `tests/test_invites_concurrency.py`）。
- **稽核**：產生、重設、改密碼各留一筆 INFO，`caplog.text` 裡沒有碼、密碼、email；`app` logger 對 INFO 是開的而且有 handler。
- `MIN_PASSWORD_LENGTH` 只有一個定義（`app.cli.MIN_PASSWORD_LENGTH is app.security.password.MIN_PASSWORD_LENGTH`）。
- `alembic check` 沒有漂移；`downgrade -1` → `upgrade head` 來回一次。

### 7.2 前端（Vitest）

- `checkTargetInput`：空白、`0`、`-1`、`1e3`、`12.345`、上限、上限＋0.01、`.5`、`4.`。
- 「我的」：帳號卡片顯示名字與 email；修改名稱送出 `PATCH` 的 body 只有 `display_name`、成功後畫面換成新名字、取消不送；
  每日目標卡片顯示四個值、`null` 與「整個 target 是 null」都顯示「未設定」；一般使用者沒有「所有帳號」。
  **既有測試的刻意改變**：「重新整理」那條的第二次回應改成不同的名字（帳號卡片現在也顯示名字，同一個字串會撞成兩個元素，
  而且分不出是不是重新整理帶來的——第 38、52 種）。
- `/me/targets`：預填；PUT 的 body 四個鍵都在、空白是 `null`；成功後失效 `dailyStats` 與 `rangeStatsAll`（快取裡放舊值、
  `staleTime` 60 秒，證明會重抓）並導回 `/me`；載入失敗不顯示表單；錯誤訊息。
- `/me/password`：三條前端檢查都不送；成功後 `getRefreshToken()` 是新的那張、顯示確認、焦點在確認上；422／429 的訊息。
- 「所有帳號」：產生 → 顯示連結與「只會顯示這一次」；管理員的列沒有按鈕；不列自己；404／422 的訊息在卡片層。
- `/reset-password`：失效、空的碼、連不上、成功（網址換成 `/`、沒有存 token）、403 切到失效畫面、兩次不一樣不送；
  已登入打開 → 說明、沒有打重設端點、網址沒有碼。`App` 的路由（同 `/join` 的三條）。
- `contentWidthFor`：`/me/targets`、`/me/password` → `form`。

### 7.3 e2e（Playwright）

每一條都**自己開新帳號**（API：管理員登入 → 產生邀請 → 註冊），不碰共用的示範帳號。登入後只用點擊換頁。

1. **目標**（電腦版尺寸）：新帳號 → 總覽沒有分母 → 我的 → 修改每日目標 → 1800／120 → 存 → 我的顯示 → 總覽「/ 1800 kcal」→
   同一天再改成 1900 → 總覽「/ 1900 kcal」（走原地改那條）。
2. **改密碼**（手機尺寸）：新帳號在 A、B 兩個 context 登入 → A 改密碼 → 確認文字 → B 的 refresh token 換票 401 →
   A 還能換頁 → A 登出 → 舊密碼「email 或密碼不正確」→ 新密碼進總覽。觸控目標 ≥ 44px。
3. **重設連結**（手機尺寸）：新帳號先用 API 登入留一張 refresh token → 管理員在「所有帳號」產生連結 → 沒登入的 context 打開
   → 設新密碼 → 「密碼已重設，請登入」、網址沒有碼 → 去登入 → 新密碼進總覽；那張舊 refresh token 401；同一條連結再開 → 失效。

---

## 8. 交付

1. 後端：`password_reset_tokens` 表與模型、`app/password_resets.py`、`MIN_PASSWORD_LENGTH` 搬家
2. 後端：`PUT /api/targets/today`
3. 後端：`POST /api/me/password`、`app` logger 的 INFO
4. 後端：`GET /api/admin/users`、`POST /api/admin/users/{id}/password-reset`
5. 後端：`password-reset-status`、`password-reset`（含並行）
6. 前端：`schema.d.ts` 核對、API 層與 query key、`checkTargetInput`、路由寬度
7. 前端：「我的」的帳號卡片與每日目標卡片
8. 前端：`/me/targets`
9. 前端：`/me/password`
10. 前端：「所有帳號」
11. 前端：`/reset-password`
12. e2e
13. 交接文件、部署手冊

每個動到 `app/api/routes` 或 `app/schemas` 的 task 都在同一個 commit 重新產生 `frontend/src/api/schema.d.ts`（CI 的 `contract` job）。

**部署：有 migration（`0016`），`deploy.sh` 會自己跑；只加一張表，可以退版。** 部署手冊加一段：一般使用者忘記密碼，
用「所有帳號」產生重設連結取代 SSH 跑 `create-user`；管理員自己的帳號仍走 `create-admin`。
