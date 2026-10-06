# 好友關係：好友碼、好友動態、只有我看得到

**狀態：** 設計定稿，待寫實作計畫
**日期：** 2026-10-07
**前置：** 開帳號的路已合併（master `8091301`）；社群草稿（分支 `docs/p7-social-decisions` 的
`docs/superpowers/specs/2026-10-01-p7-social-decisions-draft.md`）

---

## 1. 目標與範圍

### 1.1 為什麼要做

社群（P7）的第二個子專案，也是使用者最初的目標：**「能看到其他成員吃了什麼。」**
第一步（邀請連結）讓第二個帳號存在；這一步讓兩個帳號之間「看得到」。

### 1.2 這會反轉系統最根本的假設（草稿 §2）

這個 app 建立在「你永遠只看得到自己的資料」上：每個查詢都有 `user_id == me`、權限失敗一律 404
（handover §4.7）、`tests/test_cross_user_isolation.py` 有 38 條測試守著。

**最危險的失敗模式**（草稿 §2）：把 `user_id == me` 改成「我或我的好友」，而且不小心套到所有端點——
好友就看得到生活花費、目標、補劑，**而那 38 條測試照樣全綠**（它們測的是「不是好友」的情境）。

所以這份規格的做法是**明確地新增一條規則，不是放寬舊規則**：

- **既有端點一行都不改**——它們照舊只回自己的資料。
- 好友的讀取全部是 `/api/friends/...` 底下的**新端點**，全部經過同一個可見性函式。
- 那 38 條測試維持不變；新增一組測試守「好友之間看得到什麼、**看不到**什麼」。
- 加一條原始碼掃描測試：除了好友的路由與可見性模組，任何地方都不准引用好友關係的表。

### 1.3 明確不做

- 按讚、留言、通知（推播、未讀紅點）。
- 封鎖（重設好友碼擋新邀請；已經是好友的就解除）。
- 好友看餐費或備註；逐層的可見設定。
- 從好友的餐「複製一份記成我的」。
- 好友的趨勢、統計、目標。

---

## 2. 已經做出的決定

| 決定 | 選項 | 理由 |
|---|---|---|
| 好友看得到什麼 | **吃了什麼（食物名、時間、餐別）、照片、熱量與三大營養素**；不含餐費（使用者選 A） | 「看朋友吃什麼」主要是食物和照片；錢是另一種隱私 |
| 永遠看不到 | 餐費、備註、生活花費、目標、補劑、私人食物 | 草稿 §1.3、§2；備註是自由文字，可能寫了私事 |
| 某一餐不給看 | **預設給好友看，每一餐可設「只有我看得到」**（A） | 加好友本來就是要分享；要藏的那一餐自己勾 |
| 怎麼加好友 | **好友碼**，對方接受才成立（C） | 不用知道對方的 email；碼可重設 |
| 怎麼看 | **好友動態＋某個好友的某一天**（C，兩個都做） | 動態看「大家最近」，點名字看某個人 |
| 看得到多久以前 | **全部歷史**（「只有我看得到」的除外）（B） | 使用者選擇 |
| 動態放哪 | **飲食頁最上面「我的｜好友」切換**（A） | 都是看餐點；分頁列不動 |
| 資料怎麼存 | **一對朋友一列**（`user_a < user_b`）（A） | 「是不是好友」一次查詢；沒有兩列不同步的問題 |
| 解除 | 雙方都可以；立刻看不到 | 照片已經在對方快取裡的收不回來——UI 誠實寫出來（草稿 §3.2） |
| 拒絕之後 | 可以再邀請；不做封鎖 | 重設好友碼就擋得掉 |
| 兩邊同時邀請 | 直接成為好友 | |
| 好友看到的身分 | **只有名字**，不顯示 email | |

---

## 3. 資料

### 3.1 好友碼 `users.friend_code`

- 8 個字元，字母表 `ABCDEFGHJKMNPQRSTUVWXYZ23456789`（去掉容易看錯的 0/O、1/I/L），`secrets.choice` 產生。
- `Text NOT NULL UNIQUE`。顯示成 `XXXX-XXXX`；輸入時**不分大小寫、去掉連字號與空白**再比對。
- migration（`0012`）：先加可為 null 的欄位、替既有使用者逐一產生、再設 NOT NULL 與唯一約束。
- 新帳號（`/register`、`app/cli.py` 的 `create-admin`／`create-user`、測試工廠）建立時產生。產生碰撞
  （唯一約束）→ 重試，最多 5 次。
- 重設：換一個新碼，舊碼立刻失效（`users` 只有一個欄位，沒有舊碼可查）。

### 3.2 `friendships`（migration `0012` 同一支）

| 欄位 | 說明 |
|---|---|
| `id` | identity |
| `user_a`、`user_b` | FK `users.id` `ON DELETE CASCADE`；**`user_a < user_b`** |
| `requested_by` | FK `users.id` `ON DELETE CASCADE`；送出邀請的人 |
| `status` | `pending`／`accepted`（`native_enum=False` + 手寫 CHECK，handover §7） |
| `created_at` | `server_default now()` |
| `accepted_at` | 可 null |

約束：

- `CHECK (user_a < user_b)`——同時擋掉「自己加自己」與「同一對存兩種順序」。
- `UNIQUE (user_a, user_b)`。
- `CHECK (requested_by IN (user_a, user_b))`。
- `CHECK ((status = 'accepted') = (accepted_at IS NOT NULL))`。

索引：`user_b`（`user_a` 由唯一約束的前導欄位涵蓋）——「我的好友」要查兩個方向。

拒絕、收回、解除 → **刪掉那一列**（不留 `rejected` 狀態：草稿 §3.2 的「拒絕之後可以再邀請」就是自然結果）。

### 3.3 `meals.is_private`（migration `0012` 同一支）

`Boolean NOT NULL server_default false`。既有的餐都是 false（預設給好友看）。

---

## 4. 後端

### 4.1 好友碼（`/api/friends/me/code`）

- `GET` → `{ code: "K7MX-Q2PD" }`（顯示格式）。
- `POST /reset` → 新的 `{ code }`。

### 4.2 邀請與名單（`/api/friends`）

**`POST /requests`** `{ code }`：

| 情況 | 回應 |
|---|---|
| 碼不存在、或是自己的碼 | `404 FRIEND_CODE_NOT_FOUND`「找不到這個好友碼」（兩者同一個錯誤） |
| 已經是好友 | `409 ALREADY_FRIENDS`「你們已經是好友了」 |
| 我已經送過、還在等 | `409 REQUEST_PENDING`「已經送出邀請，等對方回應」 |
| **對方已經送邀請給我** | 直接成為好友 → `200 { status: "accepted", friend: {…} }` |
| 新邀請 | `201 { status: "pending", request: {…} }` |

同一對同時互送：唯一約束擋住第二個 INSERT → `IntegrityError` → rollback → 重新讀那一列，依上表回應
（通常是「對方已經送給我」→ 接受）。

**`GET /requests`** → `{ incoming: [{ id, from: { id, display_name }, created_at }], outgoing: [{ id, to: { id, display_name }, created_at }] }`。

**`POST /requests/{id}/accept`** → 只有**收到**的那一方能接受；`status = accepted`、`accepted_at = now()`。
不是收到的人、不存在、已經是好友 → `404 FRIEND_REQUEST_NOT_FOUND`。

**`DELETE /requests/{id}`** → 收到的人＝拒絕、送出的人＝收回；刪掉那一列，`204`。
跟這個邀請無關的人、已經是好友（要用解除）→ `404`。

**`GET ""`** → 好友名單 `[{ id, display_name, since }]`（`since` = `accepted_at`），依名字排序。

**`DELETE /{user_id}`** → 解除；刪掉那一列，`204`。不是好友 → `404 FRIEND_NOT_FOUND`。

所有回應裡的人**只有 `id` 與 `display_name`**——沒有 email。

### 4.3 好友的餐（唯讀）

可見性集中在 `app/friend_visibility.py`：

```python
async def friend_ids(db, user) -> list[int]          # 雙方 accepted 的對方 id
async def load_visible_friend(db, user, friend_id) -> User   # 不是好友 → 404 FRIEND_NOT_FOUND
def visible_meals_of(friend_ids) -> Select           # Meal.user_id IN (...) AND NOT Meal.is_private
```

**`GET /api/friends/feed?before=<cursor>&limit=20`**：

- 所有好友的公開餐點，依 `(eaten_at DESC, id DESC)`。`limit` 1–50，預設 20。
- 游標：上一頁最後一筆的 `eaten_at` 與 `id`（不透明字串，base64 的 JSON）；`before` 之後的條件是
  `(eaten_at, id) < (cursor_eaten_at, cursor_id)`。
- 回 `{ meals: [FriendMeal], next_cursor: str | null }`。
- 沒有好友 → `{ meals: [], next_cursor: null }`。

**`GET /api/friends/{user_id}/meals?date=YYYY-MM-DD`**：

- 先 `load_visible_friend`（不是好友 → 404）。
- 「一天」用**那個好友的時區**：`day_bounds(date, friend.timezone)`；省略 `date` → `today_in_timezone(friend.timezone)`。
- 回 `{ friend: { id, display_name }, date, meals: [FriendMeal] }`，時間順序。

**`GET /api/friends/{user_id}/meals/{meal_id}/photo`**：

- 好友＋那一餐屬於他＋不是私人＋有照片 → `image/jpeg`；**任何一項不成立 → 404**（同一個
  `MEAL_NOT_FOUND`／`MEAL_PHOTO_NOT_FOUND`，不透露是哪一項）。

**`FriendMeal`**（**白名單**，不是從 `MealResponse` 刪欄位）：

```
{ id, user: { id, display_name }, eaten_at, meal_type,
  items: [{ food_name, quantity_g, kcal }],
  kcal, protein_g, fat_g, carb_g, has_photo }
```

不含：`cost`、`note`、`photo_path`、`is_private`、項目的 `food_id`／`portion_id`／`quantity`
（私人食物與私人份量的 id 不外流；「1 碗」的份量名稱可能是私人份量，所以只給公克數）。

營養素用跟 `MealResponse` 同一套計算（`app/nutrition.py`），項目與營養素的組法抽出來共用，不重寫。

### 4.4 `is_private` 的讀寫

- `MealCreateRequest` 加 `is_private: bool = False`；`MealUpdateRequest` 加 `is_private: bool | None`
  （顯式 null → 422，同其他 NOT NULL 欄位）。
- `MealResponse` 加 `is_private`（自己看自己的餐時要知道）。

### 4.5 效能

好友動態是「N 個使用者＋時間排序＋分頁」。實作時對種了資料的資料庫跑 `EXPLAIN ANALYZE`，結果寫進計畫；
現有的 `ix_meals_user_id_eaten_at` 夠用就不加索引。**沒有實測證據不加索引**（草稿 §3.4）。

---

## 5. 前端

### 5.1 飲食頁「我的｜好友」

- 頁首一組單選（同趨勢的營養素切換），預設「我的」——「我的」的內容完全不變。
- **好友**：好友動態。
  - 卡片：名字（連到 `/friends/:id`）、日期與時間、餐別、食物名、熱量與三大營養素、照片（有的話，
    用好友照片端點取 blob）。
  - 最下面「載入更多」（有 `next_cursor` 時）；不做捲到底自動載入。
  - `staleTime: 0`（同邀請清單的理由：「朋友剛吃了什麼」就是回來看的理由）。
  - 沒有好友：「還沒有好友。到「我的」→「好友」用好友碼加朋友」。
  - 有好友沒餐：「好友還沒有記錄餐點」。

### 5.2 `/friends/:id`

- 標題是好友的名字；「前一天／後一天」切換日期，預設他的今天（後端省略 `date` 決定）。
- 卡片同動態，不重複寫名字。
- 404（不是好友或剛被解除）→「看不到這個人的餐點」＋回飲食頁。

### 5.3 「我的」：「好友」卡片

- **我的好友碼**：大字 `K7MX-Q2PD`＋「分享」（`navigator.share` 存在時）＋「複製」＋「重設」
  （確認：「重設之後舊的好友碼就不能用了，已經是好友的不受影響」）。
- **加好友**：「好友碼」輸入＋「送出邀請」。結果訊息：送出 →「已送出邀請，等對方接受」；
  直接成為好友 →「你們已經是好友了」；錯誤 → 後端訊息。
- **收到的邀請**：名字＋「接受」「拒絕」。卡片標題「好友（N 個新邀請）」（N > 0 時）。
- **送出的邀請**：名字＋「收回」。
- **好友名單**：名字＋「解除」→ 確認（`alertdialog`）：「解除之後雙方都看不到對方的餐點。
  已經看過的照片可能還留在對方手機的快取裡。」
- 每次打開都重抓邀請與名單（`staleTime: 0`）。
- **解除、拒絕或收回之後**：`removeQueries` 這個人的所有好友快取（動態、某一天、照片）——
  不只是失效，是拿掉，不留在 localStorage。

### 5.4 記一餐、編輯這一餐

- 勾選「只有我看得到（好友看不到這一餐）」，預設不勾；送 `is_private`。編輯只在改過時送。
- 飲食頁「我的」的卡片：私人的餐多一個小標籤「只有我」。

### 5.5 快取與離線

- 好友的 query 都在 `["friends", …]` 底下；好友的照片在既有的不持久化命名空間（`meal-photo` 同類）。
- 登出時既有的清快取已經涵蓋。

---

## 6. 測試

### 6.1 後端

- **好友碼**：格式與字母表；不分大小寫、連字號與空白；重設之後舊碼 404；既有使用者在 migration 後都有碼且唯一。
- **邀請**：自己的碼與不存在的碼同一個 404；已是好友 409；重複送 409；對方先送 → 直接 accepted；
  只有收到的人能接受；拒絕、收回刪列；無關的第三人對別人的邀請 → 404；回應沒有 email。
- **並行互送**：兩條真的連線同時互送 → 最後一列 accepted、沒有 500（同 `test_invites_concurrency.py` 的寫法）。
- **可見性（核心）**：
  - 好友的公開餐 → 看得到（動態、某一天、照片）。
  - 私人餐 → 動態不出現、某一天不出現、照片 404。
  - `pending` 的邀請 → 看不到。
  - 解除之後 → 看不到（同一個測試裡先看得到、解除、再看不到）。
  - 非好友 → 某一天 404、照片 404、動態不出現。
  - **好友看自己**的餐：不在動態裡（`friend_ids` 不含自己）。
  - 照片端點：好友 id 與餐點 id 不配對（A 的 id＋B 的餐）→ 404。
  - 回應沒有 `cost`、`note`、`photo_path`、`food_id`——**用一餐真的有餐費與備註的資料**（不然「沒有」是空轉）。
- **分頁**：同一個 `eaten_at` 的兩餐跨頁不重複不漏（游標帶 `id`）；`limit` 邊界。
- **時區**：好友在 `America/New_York`、我在 `Asia/Taipei`，某一天照**他的**日界線切。
- **隔離不變**：`tests/test_cross_user_isolation.py` 一字不改；加好友之後，既有的 `/api/meals`、
  `/api/expenses`、`/api/targets`、`/api/supplements…`、`/api/foods`（私人食物）對好友仍然 404／看不到
  （新增測試，**在兩人是好友的狀態下**跑）。
- **掃描**：`Friendship` 只出現在 `app/models/`、`app/friend_visibility.py`、`app/api/routes/friends.py`、
  migration 與測試裡。
- **`is_private`**：建立、修改（顯式 null 422）、回應帶出。
- 既有測試的**刻意改變**：`MealResponse` 多一個欄位——斷言整個回應相等的測試要補上 `is_private`。

### 6.2 前端

- 飲食頁切換：預設我的；切到好友顯示動態；兩種空狀態；載入更多帶 `before`。
- `/friends/:id`：前一天／後一天換 `date`；404 的訊息。
- 好友卡片：碼的複製、重設要確認；送邀請的三種結果；接受、拒絕、收回；解除要確認、取消不送；
  解除後好友的快取被**移除**（`getQueryData` 是 undefined）。
- 記一餐與編輯：勾選後送 `is_private: true`；不勾不送或送 false；「只有我」標籤。

### 6.3 e2e

每次跑用**新帳號**（管理員用邀請 API 開一個），不依賴 dev 資料庫裡的既有關係：

1. 新帳號 B 在「我的」看自己的好友碼；管理員 A 輸入它送邀請；B 接受。
2. A 記兩餐：一餐公開（附照片）、一餐「只有我看得到」。
3. B 切到「好友」：只看到公開那一餐，有照片、沒有餐費。
4. A 解除好友；B 重新整理好友動態 → 空的。

---

## 7. 交付

1. 後端：好友碼（欄位、migration 補既有使用者、註冊與 CLI 產生）＋讀取與重設
2. 後端：`friendships`、邀請、接受、拒絕／收回、名單、解除（含並行互送）
3. 後端：`meals.is_private`（建立、修改、回應）
4. 後端：可見性模組、好友動態、某一天、照片、隔離與掃描測試、`EXPLAIN`
5. 前端：「我的」的好友卡片
6. 前端：「只有我看得到」與「只有我」標籤
7. 前端：飲食頁切換、好友動態、`/friends/:id`
8. e2e
9. 交接文件、部署手冊

**部署：又有 migration（`0012`）。** `up -d --build` 之後跑 `alembic upgrade head`。
