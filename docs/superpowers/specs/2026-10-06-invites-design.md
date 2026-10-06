# 開帳號的路：一次性邀請連結

**狀態：** 已實作
**日期：** 2026-10-06
**前置：** 小項目包已合併（master `fbe5e9d`）；社群草稿 `docs/p7-social-decisions` 分支的
`docs/superpowers/specs/2026-10-01-p7-social-decisions-draft.md` §3.1

---

## 1. 目標與範圍

### 1.1 為什麼要做

社群（P7）的第一個子專案。草稿 §3.1：「沒有第二個帳號，社交功能無法測試也無法使用」——
前端沒有註冊畫面，帳號只能從命令列開。

而後端**其實已經有開放註冊**（`POST /api/auth/register`）：P1 規格 §12 決定「維持開放註冊，
邊界交給 Tailscale」，並寫下兩個接受的殘留風險——tailnet 通常比這個 app 寬（為了 Plex 加進
來的家人也能註冊），以及 API 一旦跑到 tailnet 外面，「開放註冊＋沒有 email 驗證＋沒有速率
限制」就直接暴露在網際網路上。要讓朋友用，就得先決定**誰能開帳號**。

### 1.2 這份規格做的事

1. 管理員產生**一次性邀請連結**（7 天有效、只能用一次、可撤銷）。
2. 註冊**一定要有有效的邀請**——開放註冊關閉。
3. 前端：「我的」頁的「邀請朋友」（管理員限定）＋ `/join` 註冊畫面。

### 1.3 明確不做

- 好友關係、看朋友的餐（社群的下一個子專案）。
- 一般使用者邀請別人。
- 忘記密碼、改密碼、email 驗證、刪帳號。
- 綁定 email 的邀請——靠「只能用一次」＋「已用掉的看得到是誰」發現被搶用。
- 註冊的速率限制——無效的邀請在 Argon2 之前就被擋掉、256 位元的碼猜不到（§3.4）。

---

## 2. 已經做出的決定

| 決定 | 選項 | 理由 |
|---|---|---|
| 朋友怎麼拿到帳號 | **一次性邀請連結**（使用者選 A） | 每個連結對應一個人、用過即失效、看得到是誰用的；共用邀請碼外流就誰都能用 |
| 誰能產生邀請 | **只有管理員**（A） | 每個帳號都經過你；之後要開放只是放寬一條權限檢查 |
| 有效期限 | **7 天**，可撤銷（A） | 朋友有一週的時間；弄丟就撤銷重發 |
| 邀請碼怎麼存 | **只存 SHA-256**（A） | 同 refresh token 只存 `jti` 的理由：資料庫或備份外流拿不到能用的連結。代價：連結只在產生當下顯示一次 |

---

## 3. 後端

### 3.1 資料表 `invites`（migration `0011_create_invites`）

| 欄位 | 型別 | 說明 |
|---|---|---|
| `id` | `BigInteger` identity | |
| `token_hash` | `Text`，唯一 | 邀請碼的 SHA-256（hex）。明碼不進資料庫 |
| `note` | `Text`，可 null | 1–50 字（「給小明」）；同 `display_name` 的控制字元檢查 |
| `created_by` | FK `users.id` `ON DELETE CASCADE` | 產生它的管理員 |
| `created_at` | `timestamptz` | `server_default now()` |
| `expires_at` | `timestamptz` | `created_at + 7 天`（後端算，不收客戶端的值） |
| `used_at` | `timestamptz`，可 null | |
| `used_by` | FK `users.id` `ON DELETE SET NULL`，可 null | |
| `revoked_at` | `timestamptz`，可 null | |

約束（`CheckConstraint` 的 `name=` 是命名慣例的輸入，handover §7）：

- `expires_at > created_at`
- `used_at IS NULL OR revoked_at IS NULL`（不會同時用掉又撤銷）

邀請碼：`secrets.token_urlsafe(32)`（256 位元）。

### 3.2 管理員端點（`require_admin`；一般使用者 → `403 FORBIDDEN`）

**`POST /api/admin/invites`** `{ note? }` → `201 { id, token, note, expires_at }`。
**`token` 只在這個回應裡出現**，之後任何端點都不回。

**`GET /api/admin/invites`** → 兩種狀態的邀請，新的在前。每一項同一個形狀
`{ id, note, status, created_at, expires_at, used_at, used_by: { display_name, email } | null }`：

- `status: "pending"`（沒用、沒撤銷、沒過期）：`used_at`、`used_by` 是 null。
- `status: "used"`：`used_at` 有值；`used_by` 在那個帳號被刪掉時是 null。

過期、撤銷的不列。

**`DELETE /api/admin/invites/{id}`** → 撤銷，`204`。已使用 → `409 INVITE_USED`；
不存在、已撤銷 → `404 INVITE_NOT_FOUND`；已過期但沒用 → 照樣撤銷（`204`）。
`revoked_at` 用資料庫的 `now()`（跟「還能用」的判斷同一個時鐘）。撤銷與兌換搶同一列時，
撤銷端的 `FOR UPDATE` 讓結果是乾淨的 409；真正的最後一道是 CHECK（不會同時用掉又撤銷）。

> 單一管理員的系統，列出與撤銷不限「自己產生的」——任何管理員都能管所有邀請。

### 3.3 註冊一定要有邀請

**`POST /api/auth/register`** 多一個必填欄位 `invite_token: str`（1–100 字）。
少了它 → `422`——開放註冊就此關閉。

處理順序（每一步的理由都寫進程式碼註解）：

1. **先查邀請**：`token_hash = sha256(invite_token)`，找「沒用、沒撤銷、`expires_at > now()`」的那一列。
   找不到 → `403 INVITE_INVALID`「這個邀請連結已經失效，請跟邀請你的人要一個新的」。
   **四種失效（不存在、用過、過期、撤銷）同一個錯誤**——對方能做的事都一樣：要一個新的。
   **在 Argon2 之前**：無效的邀請不會花 70ms 的 CPU。
2. email 已存在 → `409 EMAIL_TAKEN`（既有行為）。**邀請不被用掉。**
3. `hash_password`（`run_in_threadpool`，既有）。
4. **同一個交易**：
   - 建立使用者，`flush` 拿到 `id`（email 撞名的競爭 → `IntegrityError` → rollback → `409 EMAIL_TAKEN`）；
   - 條件式 `UPDATE invites SET used_at = now(), used_by = :uid WHERE id = :id AND used_at IS NULL
     AND revoked_at IS NULL AND expires_at > now() RETURNING id`——沒有回傳列（同時被別人用掉、
     或剛好在步驟 1 之後被撤銷）→ rollback → `403 INVITE_INVALID`；
   - `commit`。

兩個請求同時用同一個邀請：第二個的條件式 `UPDATE` 等第一個的列鎖，第一個 commit 之後條件不成立、
回 0 列——**只有一個使用者被建立**。

回應不變（`201 UserResponse`）；註冊之後由前端呼叫 `/login`。

**`POST /api/auth/invite-status`** `{ token }` → `200 { valid: bool }`（同步驟 1 的條件；不認證）。
token 放在 body，不放網址（不進存取紀錄）。

### 3.4 為什麼不加註冊的速率限制

- 無效的邀請在 Argon2 之前就回 403——用亂碼打不出 CPU 成本。
- 有效的邀請只能成功一次；email 撞名的重試（步驟 2）也在 Argon2 之前。
- 256 位元的碼不能用猜的。

`invite-status` 同理（一次 SHA-256 加一次索引查詢）。交接文件記一筆。

### 3.5 不變的

- `app/cli.py` 的 `create-admin`、`create-user` 照舊（管理員自己的帳號從那裡開）。
- 登入、refresh、登出不變。

---

## 4. 前端

### 4.1 註冊畫面 `/join#<邀請碼>`

- 邀請碼放在 `#` 後面：**不會送到伺服器**，不進 Caddy 或 Tailscale 的存取紀錄。
- `App.tsx` 現在「未登入 → 一律 `<Login>`」。改成：未登入且 `location.pathname` 是 `/join` 或
  `/join/` → `<Join>`（包在 `.app-main` 裡，跟登入後的頁面一樣有左右留白）；其他照舊。
- 邀請碼取 `#` 之後連續的 `[A-Za-z0-9_-]`（`token_urlsafe` 的字元）：聊天軟體常把後面的
  「。」、空白或 `?openExternalBrowser=1` 一起併進連結。
- 打開時用 `invite-status` 查：
  - 查詢中：「確認邀請中…」。
  - **失效**（或 `#` 後面是空的，或 `invite-status` 回 422）：只顯示「這個邀請連結已經失效，
    請跟邀請你的人要一個新的」＋「去登入」（連到 `/` 的連結）。不顯示表單。
  - **連不上**（其他錯誤）：「無法確認邀請連結，請檢查網路後重新整理」——不說它失效。
  - **有效**：表單——email、名字、密碼（至少 8 字）、再輸入一次密碼。
- 時區：`Intl.DateTimeFormat().resolvedOptions().timeZone`，拿不到就 `Asia/Taipei`；
  後端拒絕這個時區（`422` 指到 `timezone`）時改用 `Asia/Taipei` 重送一次。
- 前端檢查：密碼至少 8 字（「密碼至少要 8 個字」）；兩次不一樣不送出（「兩次輸入的密碼不一樣」）。
- 「建立帳號」→ 註冊 → `/login`（同 `Login` 的存 token 流程）→ `history.replaceState(null, "", "/")`
  （邀請碼從網址列消失）→ 進總覽。
- 錯誤：`409 EMAIL_TAKEN` → 後端訊息（邀請還能用，改 email 再送）；`403 INVITE_INVALID` → 切到失效畫面；
  `422` → 欄位錯誤（`describeFieldErrors`）；其他 → 「建立失敗，請再試一次」。
  註冊成功但自動登入失敗 → 「帳號建好了，請用剛剛的 email 登入」＋「去登入」。
- 外觀用第二階段的 `.screen`（登入畫面沒有任何樣式，照抄會是不到 44px 的瀏覽器預設）。

**已登入的人打開邀請連結**：路由 `/join` → 「你已經登入了。這個連結是給新朋友開帳號用的。」＋
回總覽的連結。邀請不被用掉（不打任何邀請端點）；網址換成 `/join`，還能用的邀請碼不留在瀏覽紀錄裡。

### 4.2 「我的」頁：「邀請朋友」（管理員限定，`/api/me` 的 `role`）

- 備註（選填，「給誰？例如：小明」）＋「產生邀請連結」。
- 產生後顯示整條連結（`${location.origin}/join#${token}`）、「分享」（`navigator.share` 存在時）、
  「複製」（`navigator.clipboard.writeText`；成功寫「已複製」），以及
  「**這個連結只會顯示這一次**，7 天內有效、只能用一次」。再產生一個就換成新的。
- 清單：
  - **還沒用的**：備註（沒有就寫「邀請 #{id}」——撤銷按鈕的可及名稱才不會重複）、到期日
    （`formatDateTime`）、「撤銷」→ 確認（`role="alertdialog"`）→ `DELETE`。撤銷時已經被用掉
    或已經不在（`409`／`404`）→ 後端訊息顯示在**清單層**（重新載入之後那一列會消失，訊息不能跟著它走）。
    撤銷的正好是剛產生的那張 → 上面的連結一起收掉。
  - **已經用掉的**：備註、名字與 email、使用時間。
- 成功產生或撤銷 → 失效邀請清單的 query。清單**每次打開都重抓**（`staleTime: 0`）：app 預設 60 秒、
  快取又會持久化，朋友剛用掉邀請時重新整理會看到舊清單——而「誰用掉了」正是回來看的理由。

### 4.3 一般使用者

看不到「邀請朋友」；後端仍是授權的唯一依據。

---

## 5. 測試

### 5.1 後端

- 註冊：沒有 `invite_token` → 422；亂碼、過期、撤銷、已用過 → 403 `INVITE_INVALID`，
  **每一種都確認使用者沒有被建立**。
- **過期用時間驗**：直接把 `expires_at` 改成過去（不能只用撤銷代表所有失效——
  拿掉 `expires_at > now()` 的條件要變紅）。
- 成功：使用者建立、邀請的 `used_at`／`used_by` 寫入；**斷言前先 `rollback()`**（第 11 種）。
- email 撞名 → 409，**邀請沒被用掉**：同一個邀請換個 email 還能成功。
- 並行：兩條真的連線同時兌換同一個邀請（`redeem_invite`）→ 只有一條成功（同
  `test_sessions_concurrency.py` 的寫法）；端點層另外證明兌換落空時 rollback、回 403、沒有建使用者。
  email 撞名的競爭（`IntegrityError`）→ 409，邀請沒被用掉。
- 無效邀請不呼叫 `hash_password`（spy）。
- 資料庫裡沒有明碼：`token_hash != token`、等於 `sha256(token)`。
- `invite-status`：有效 → true；四種失效 → false。
- 管理員端點：一般使用者 → 403；產生的回應有 `token`、清單沒有；清單不含過期與撤銷的；
  撤銷已使用 → 409；撤銷不存在 → 404。
- 既有測試的**刻意改變**：`tests/test_auth_register.py`、`tests/test_rate_limit.py` 的註冊改成先建一張邀請。
- `alembic check` 沒有漂移；`schema.d.ts` 重新產生。

### 5.2 前端

- `/join`：失效的連結不顯示表單；`#` 後面空的也是失效；兩次密碼不一樣不送；
  成功 → 註冊、登入、網址換成 `/`；409 的訊息；403 切到失效畫面；時區被拒時以 `Asia/Taipei` 重送。
- 已登入打開 `/join` → 說明文字、沒有打邀請端點。
- 「我的」：一般使用者沒有「邀請朋友」；產生後顯示連結與「只會顯示這一次」；撤銷先確認、取消不送；
  已使用的顯示名字與 email。
- e2e：管理員產生連結 → 另一個沒登入的瀏覽器 context 打開 → 填表 → 進總覽 →
  同一個連結再開一次 → 失效畫面。

---

## 6. 交付

1. 後端：`invites` 表、migration、管理員端點
2. 後端：註冊要有邀請、`invite-status`；重新產生 `schema.d.ts`
3. 前端：「我的」的「邀請朋友」
4. 前端：`/join` 註冊畫面
5. e2e 完整一圈
6. 交接文件（含修正 §8.2「趨勢圖只有熱量」的過時描述）

**部署：這次有 migration。** NAS 上 `up -d --build` 之後要再跑
`sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml exec api python -m alembic upgrade head`
（部署手冊 §7）。本機 e2e 之前同樣要對 dev 資料庫 `alembic upgrade head` 並重建 api 容器。
