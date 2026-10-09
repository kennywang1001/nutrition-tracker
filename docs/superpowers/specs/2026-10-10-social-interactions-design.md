# 按讚、留言、通知

**狀態：** 設計完成，尚未實作
**日期：** 2026-10-10
**分支：** `feat/social-interactions`
**前置：** 好友關係（`2026-10-07-friends-design.md`，可見性規則與「明確不做」）、AI 多樣估算與餐點描述
（`2026-10-09-ai-multi-food-design.md`，`meals.description` 好友看得到）、電腦版版面（`2026-10-08-desktop-layout-design.md`）
**計畫：** `docs/superpowers/plans/2026-10-10-social-interactions.md`

---

## 1. 範圍

### 1.1 為什麼要做

好友規格 §1.3 把按讚、留言、通知列為「明確不做——等真的用過再說」。現在好友動態有人在看了，但看完沒有任何回應的方式：
記的人不知道有人看過，看的人只能另外傳訊息。這一份補上最小的一圈互動。

### 1.2 這份規格做的事

- **餐點頁 `/meals/:id`**（新）：一餐的唯讀畫面——照片、時間與餐別、項目、合計、描述，底下是讚與留言。自己的餐與看得到的好友的餐都能開。
- **讚**：一人一餐一個，按一下加、再按一下收回。卡片上有愛心與數字，餐點頁列出誰按了。
- **留言**：純文字、一行、1–200 字；不能改，可以刪（作者刪自己的、餐的主人刪任何一則）。
- **通知**（只在 app 裡）：有人對你的餐按讚或留言、有人送好友邀請給你、對方接受了你的邀請。「我的」的分頁上有未讀數字，
  「我的」最上面一張「通知」卡片，`/notifications` 是清單。

### 1.3 明確不做

- 推播（Web Push）、email、桌面通知。
- 留言的修改、回覆串、@提及、表情回應；對留言按讚。
- 「跟著這串留言」：別人在同一餐留言**不**通知其他留言的人，只通知餐的主人。
- 封鎖、檢舉；好友的趨勢、統計、目標（好友規格 §1.3 剩下的項目）。
- 讚與留言進 CSV 匯出（§7 第 8 點）。
- 通知的自動清除（§3.4）；通知的個別已讀、個別刪除、關閉某一類通知的設定。
- 總覽時間線的餐點列改連到餐點頁（仍然連到編輯）；時間線上顯示讚與留言數。
- 使用者刪除帳號（現在沒有這條路，§3.5）。

---

## 2. 決定

| # | 決定 | 選項 | 理由 |
|---|---|---|---|
| D1 | 誰看得到一餐 | **主人；或主人現在的好友而且這一餐不是「只有我看得到」**。其餘一律 `404 MEAL_NOT_FOUND`，跟不存在逐字相同 | 跟好友動態同一條規則（好友規格 §4.3）；handover §4.7 |
| D2 | 誰能按讚、留言 | 看得到這一餐的人。**主人不能對自己的餐按讚**（`422`），可以留言 | 讚自己沒有意義；回覆朋友的留言要能留 |
| D3 | 誰看得到讚與留言 | 看得到這一餐的人看得到**全部**——像一個小群組 | B 與 C 都是 A 的好友、彼此不是：他們在 A 的餐上看得到對方的名字與留言。**接受**：那是 A 的場子，跟在 A 的貼文底下留言一樣 |
| D4 | 解除好友之後 | **讀的時候過濾**：讚與留言只算「作者是餐的主人，或作者現在是主人的好友」。資料列留著，重新加好友就回來 | 解除時不用掃表刪資料；「解除＝立刻看不到」跟好友規格 §2 一致 |
| D5 | 一餐改成「只有我看得到」 | 別人 `404`；主人仍然看得到既有的讚與留言 | 留言是別人寫給主人的，不因為主人關門就消失 |
| D6 | 端點放哪 | 新的 `/api/social/...` 與 `/api/notifications...`，**不是** `/api/meals/{id}/like` | 「`/api/meals` 只回自己的」是寫進 handover §4.10 與掃描測試的不變量；前端測試的 `mockApi` 用 `url.includes` 比對，`/api/meals/5/like` 會被 `/api/meals` 的路由吃掉 |
| D7 | 單一餐點的讀取 | 新端點 `GET /api/social/meals/{id}`，**主人與好友走同一個白名單序列化**（`FriendMeal`）——沒有餐費、備註 | 既有的 `GET /api/meals/{id}` 只給主人、帶餐費與備註；兩種身分共用一個序列化，就不存在「好友那條路多漏一個欄位」 |
| D8 | 並行的連按 | `INSERT … ON CONFLICT DO NOTHING`（`uq_meal_likes_meal_id_user_id`），不接 `IntegrityError` | 兩個同時到的 PUT 都是 200、只有一列；不用 savepoint、不會讓共用 session 的測試夾具壞掉 |
| D9 | 身分揭露 | 讚與留言只回 `display_name` 與伺服器算好的 `is_me`／`can_delete`；**不回 email、不回作者的 user id** | 「是不是我」「能不能刪」在伺服器判斷；前端不需要 id |
| D10 | 留言的順序與上限 | 最近 100 則、由舊到新；超過時 `comments_truncated: true`，畫面寫「只顯示最近 100 則」 | 一餐不會有幾百則；不做分頁 |
| D11 | 通知給誰 | 只給餐的主人（讚、留言）與好友關係的對方（邀請、接受）；自己的動作不通知自己 | 不做 thread-following |
| D12 | 讚的通知不洗版 | 每個（收件人、動作者、餐）最多一則：部分唯一索引＋`ON CONFLICT DO NOTHING`；**收回讚時刪掉那一則** | 按了又收回又按，只會有一則 |
| D13 | 通知的讀取規則 | 讚、留言、「接受」：動作者**現在**還是我的好友；「邀請」：那個邀請還在等。餐或留言被刪 → FK cascade 帶走通知 | 解除好友之後，對方留言的預覽不會留在通知裡 |
| D14 | 好友的通知 | **做**：`friend_request`（對方送邀請給我）、`friend_accepted`（對方接受了我的邀請，含「兩邊互送直接成立」） | 好友是「送邀請 → 對方接受」兩步；現在收到邀請要自己打開「我的」才知道。寫入點只有 `friends.py` 的兩個函式 |
| D15 | 已讀 | 打開 `/notifications`、清單載入之後呼叫 `POST /api/notifications/read-all`，**帶清單裡最新那一則的 id**（`up_to`） | 清單載入之後才到的通知不會沒被看過就變成已讀 |
| D16 | 未讀數的新鮮度 | 視窗取得焦點時重抓；畫面看得到時每 60 秒一次（`refetchInterval`，背景不抓） | 沒有推播；這個規模輪詢就夠 |
| D17 | 分頁上的未讀標記 | 連結的可及名稱**維持「我的」**；數字是 `aria-hidden` 的視覺標記，另用 `aria-describedby` 指到連結**外面**一段隱藏文字「N 則新通知」 | 既有的單元測試與 e2e 有 20 多處用名稱「我的」找連結（§6.5），一處都不用改；螢幕閱讀器唸「我的，連結，3 則新通知」 |
| D18 | 讚的按鈕 | 名稱固定（「讚，鮑伯的午餐」）＋`aria-pressed`；數字用 `aria-describedby`（「3 個讚」） | 名稱跟著狀態換（「按讚」／「收回讚」）再加 `aria-pressed`，會唸成「收回讚，已按下」——兩個訊號互相打架 |
| D19 | 連按兩下 | 樂觀更新；請求**一次一個**，送完再看最後的意圖，不一樣就再送一次；失敗就退回伺服器的狀態並顯示錯誤 | 最後的畫面一定等於最後一次按的意圖，請求不會亂序 |
| D20 | 限速 | 留言每人每分鐘 20 次；按讚與收回**合計**每分鐘 60 次；`429`＋`Retry-After` | 既有的 `KeyedRateLimiter`，鍵是使用者 id |
| D21 | 離線快取 | 社群的 query 都在 `["social", …]` 底下，加進 `NOT_PERSISTED` | 別人的名字與留言不留在這台裝置的 localStorage（同 `friends`） |
| D22 | 保留期限 | 這一版不自動刪通知；清單只回最近 50 則 | 量很小；以後加一個 CLI 清掉 N 天前已讀的（§3.4） |

### 與原始決定的差異

1. **端點路徑。** 原始決定舉的例子是 `PUT`／`DELETE /api/meals/{id}/like`。改成 `/api/social/meals/{id}/like`（D6）。語意不變（冪等的 PUT 與 DELETE）。
2. **`DELETE …/like` 回 `200` 與目前的狀態，不是 `204`。** 連按兩下時前端要拿伺服器的數字對帳（D19）；PUT 與 DELETE 回同一個形狀。
3. **自己的餐點清單（`MealResponse`）只加 `like_count`、`comment_count`，不加 `liked_by_me`。** 主人不能對自己的餐按讚（D2），那個欄位永遠是 `false`。
   好友的卡片（`FriendMeal`）三個都有。
4. **讚的按鈕名稱不是「按讚」／「收回讚」**（D18）。
5. **`read-all` 多一個必填的 `up_to`**（D15），而且回剩下的未讀數——分頁上的數字不用再抓一次。
6. **通知用 `id` 排序，不是 `created_at`。** `created_at` 是交易開始的時間，同一個交易裡會相同；identity 的 `id` 就是寫入順序。
   索引因此是 `(user_id, id)`。
7. **好友的通知是兩種，不是一種「X 加你為好友」**（D14）：加好友不是立刻成立，是邀請與接受。
8. **`meal_likes` 不另外加 `user_id` 的索引。** 唯一約束 `(meal_id, user_id)` 涵蓋「這一餐的讚」；「某個人按過的所有讚」沒有任何讀取用到
   （好友規格 §4.5：沒有實測證據不加索引）。
9. **讚與留言的作者不回 user id**（D9）——原始決定容許「判斷是不是我、能不能刪所需要的 id」，改成伺服器直接回布林值，一個 id 都不用給。

---

## 3. 資料模型與 migration

Migration **`0018_create_social_tables`**：三張新表，全部只有新增。模型在 `app/models/social.py`。

### 3.1 `meal_likes`

| 欄位 | 說明 |
|---|---|
| `id` | identity |
| `meal_id` | FK `meals.id` `ON DELETE CASCADE` |
| `user_id` | FK `users.id` `ON DELETE CASCADE`；按讚的人 |
| `created_at` | `server_default now()` |

`UNIQUE (meal_id, user_id)`（`uq_meal_likes_meal_id_user_id`）——同時是「這一餐的讚」的索引。
「主人不能讚自己」不在資料庫擋（要跨表）：端點擋，而且**計數的查詢只算主人現在的好友**，就算有那樣一列也不會被算進去。

### 3.2 `meal_comments`

| 欄位 | 說明 |
|---|---|
| `id` | identity |
| `meal_id` | FK `meals.id` `ON DELETE CASCADE` |
| `user_id` | FK `users.id` `ON DELETE CASCADE`；作者 |
| `body` | `Text NOT NULL`；`CHECK (char_length(body) BETWEEN 1 AND 200)`（`ck_meal_comments_body_length`） |
| `created_at` | `server_default now()` |

索引 `ix_meal_comments_meal_id_id (meal_id, id)`：「這一餐最近 100 則」。

### 3.3 `notifications`

| 欄位 | 說明 |
|---|---|
| `id` | identity；**也是排序的依據** |
| `user_id` | FK `users.id` `CASCADE`；收件人 |
| `actor_id` | FK `users.id` `CASCADE`；做這件事的人 |
| `type` | `like`／`comment`／`friend_request`／`friend_accepted`（`native_enum=False`＋手寫 CHECK，handover §7） |
| `meal_id` | FK `meals.id` `CASCADE`；可 null |
| `comment_id` | FK `meal_comments.id` `CASCADE`；可 null |
| `created_at` | `server_default now()` |
| `read_at` | 可 null |

約束：

- `ck_notifications_not_self`：`user_id <> actor_id`。
- `ck_notifications_shape_matches_type`：`like` 有餐沒有留言；`comment` 兩個都有；好友的兩種兩個都沒有。
  **它同時就是 `type` 的手寫約束**（四種以外的值三個分支都不成立）——不另外寫一條 `type IN (…)`：
  那一條永遠被這一條先擋下來，沒有測試看得到它（handover §6 規矩 2）。

索引：

- `uq_notifications_like`：`UNIQUE (user_id, actor_id, meal_id) WHERE type = 'like'`（D12）。
- `ix_notifications_user_id_id (user_id, id)`：清單。
- `ix_notifications_unread`：`(user_id) WHERE read_at IS NULL`：未讀數。

`meal_id`、`comment_id` 沒有自己的索引：刪一餐或一則留言時 cascade 會掃這張表。這個規模（幾個人）可以；量長大了再加。

### 3.4 保留

不自動刪。之後要清：`python -m app.cli cleanup-notifications --older-than-days 90`（刪已讀而且超過 N 天的），這一版不做。

### 3.5 Cascade 與退版

- 刪一餐（`DELETE /api/meals/{id}`）→ 讚、留言、通知跟著 cascade。刪一則留言 → 它的通知跟著走。
- **刪使用者：現在沒有這條路**（沒有端點、CLI 也沒有）。FK 都是 `CASCADE`，測試直接在資料庫刪一個使用者確認三張表都清乾淨。
- **可以退版**：只有新表，舊版程式不讀不寫；不進 `deploy.sh` 的 `ROLLBACK_UNSAFE_REVISIONS`。退版之後表留著，再升版資料還在。
- `alembic check` 要乾淨（`tests/conftest.py` 每次都跑）。

---

## 4. 可見性規則

全部在 **`app/social_visibility.py`**（新）。它是 `app/friend_visibility.py` 之外唯一碰 `Friendship` 的非路由模組；掃描測試跟著改（§8.1）。

```python
def _are_friends(one, other) -> ColumnElement[bool]        # EXISTS friendships accepted，(least, greatest) 對上唯一索引
def meal_visible_to(viewer_id) -> ColumnElement[bool]      # 主人，或（不是私人 且 主人與 viewer 是好友）
async def load_visible_meal(db, viewer, meal_id, *, lock=False) -> Meal   # 否則 404 MEAL_NOT_FOUND
def author_counts(author, owner) -> ColumnElement[bool]    # 作者是主人，或作者現在是主人的好友
async def social_counts(db, viewer_id, meal_ids) -> dict[int, SocialCounts]   # 兩次查詢，跟餐數無關
def notification_visible() -> ColumnElement[bool]          # D13
```

### 4.1 看不看得到一餐（viewer × 關係 × 私人）

| viewer | 公開的餐 | 「只有我看得到」的餐 |
|---|---|---|
| 主人 | ✅ 讀、留言、刪任何留言；❌ 按讚（`422`） | 同左 |
| 主人現在的好友 | ✅ 讀、按讚、留言、刪自己的留言 | `404` |
| 邀請還在等（pending） | `404` | `404` |
| 已經解除的前好友 | `404` | `404` |
| 陌生人 | `404` | `404` |
| 沒登入 | `401` | `401` |

`404` 的 body 一律是 `MEAL_NOT_FOUND`「找不到該餐點」——跟既有的 `_load_owned_meal` 同一個字串，跟餐不存在分不出來。
五個社群端點（讀、讚、收回、留言、刪留言）第一步都是 `load_visible_meal`。

### 4.2 一則讚或留言算不算數（作者 × 現在的關係）

| 作者 | 讚 | 留言 |
|---|---|---|
| 餐的主人 | 不算（本來就不該存在） | ✅ |
| 主人現在的好友 | ✅ | ✅ |
| 已經解除的前好友 | 不算、不顯示 | 不顯示 |
| 解除之後又加回來 | ✅（資料列一直都在） | ✅ |

數字（卡片上的、餐點頁的）、名單、留言清單、`liked_by_me`、`comments_truncated` 全部用同一個過濾。
**viewer 是誰不影響這張表**：B 看 A 的餐時，C 的留言算不算只看 C 與 A 的關係（D3）。

### 4.3 通知看不看得到（D13）

| 種類 | 條件 |
|---|---|
| `like`、`comment` | 動作者現在是我的好友（餐是我的，所以也就是「主人的好友」）。餐被刪、留言被刪 → 那一列已經不在 |
| `friend_request` | 動作者送給我的邀請還在等（`friendships` 有一列 `pending`、`requested_by = actor`）。接受、拒絕、收回之後就不顯示 |
| `friend_accepted` | 動作者現在是我的好友 |

未讀數用同一個條件。`read-all` **不**套這個條件（把看不到的也標成已讀沒有壞處，重新加好友之後它們是已讀的）。

### 4.4 寫入時的競態

- 讚、留言寫入時 `load_visible_meal(lock=True)`：`SELECT … FOR SHARE OF meals`。跟「改成只有我看得到」的 `PATCH`（`FOR UPDATE`）互斥——
  不會有一則讚落在已經關起來的餐上。
- 解除好友與按讚同時發生：可能留下一列前好友的讚。讀的過濾本來就會藏掉它（D4），不另外處理。

---

## 5. API

全部要登入（`401 NOT_AUTHENTICATED`）。路徑參數是 `ResourceId`（超出 bigint → `422`）。

### 5.1 `GET /api/social/meals/{meal_id}`

可見性：§4.1。錯誤：`404 MEAL_NOT_FOUND`。

```
{ meal: FriendMeal,            # 白名單；多了 like_count、comment_count、liked_by_me
  is_mine: bool,
  likes: [{ display_name, is_me }],          # 依按讚的先後
  comments: [{ id, display_name, is_me, can_delete, body, created_at }],   # 最近 100 則，由舊到新
  comments_truncated: bool }
```

`can_delete` = 我是作者，或我是這一餐的主人。照片不在這裡：自己的餐用既有的 `/api/meals/{id}/photo`，
好友的用 `/api/friends/{user_id}/meals/{id}/photo`（`meal.user.id` 與 `is_mine` 決定用哪一個）。

### 5.2 `PUT /api/social/meals/{meal_id}/like`、`DELETE /api/social/meals/{meal_id}/like`

- 順序：限速（`429 TOO_MANY_LIKES`「按得太快了，請稍後再試」，兩個端點共用額度）→ 可見性（`404`）→ PUT 才有：主人 → `422 CANNOT_LIKE_OWN_MEAL`「不能對自己的餐點按讚」。
- 都冪等：已經按過再 PUT、沒按過就 DELETE，都是 `200`。
- 回 `{ like_count, liked_by_me }`（過濾後的數字）。
- PUT 真的新增了一列才寫通知；DELETE 連通知一起刪。同一個交易。

### 5.3 `POST /api/social/meals/{meal_id}/comments`

- body `{ body: str }`：清理前最多 1000 字；`single_line` 清理後 1–200 字，否則 `422`（清完是空的也是）。
- 順序：限速（`429 TOO_MANY_COMMENTS`「留言太頻繁，請稍後再試」）→ 可見性（`404`）。
- `201`，回那一則留言（同 §5.1 的形狀）。作者不是主人 → 同一個交易寫一則通知。

### 5.4 `DELETE /api/social/meals/{meal_id}/comments/{comment_id}`

- 可見性（`404 MEAL_NOT_FOUND`）→ 一個 `DELETE … WHERE id = :comment AND meal_id = :meal AND (user_id = :me OR :me 是主人) RETURNING id`。
  0 列 → `404 COMMENT_NOT_FOUND`「找不到這則留言」——不存在、屬於另一餐、看得到但不是我能刪的，三種同一個回應。
- `204`。通知由 FK cascade 帶走。

### 5.5 通知

- **`GET /api/notifications`** → `{ items: [...] }`，最近 50 則、新的在前（`id DESC`）、套 §4.3。每一則：
  `{ id, type, actor_name, meal: { id, meal_type, eaten_at } | null, comment_preview: str | null, created_at, is_read }`。
  `comment_preview` 是留言的前 40 個字，超過加「…」。
- **`GET /api/notifications/unread-count`** → `{ count }`。
- **`POST /api/notifications/read-all`** body `{ up_to: int }` → 把我的、`id <= up_to`、還沒讀的標成已讀；回 `{ count }`（剩下的未讀數）。

### 5.6 既有回應多的欄位

- `FriendMeal`（好友動態、好友的某一天、§5.1）：`like_count`、`comment_count`、`liked_by_me`。
- `MealResponse`（`/api/meals` 的每一個回應）：`like_count`、`comment_count`。`/api/meals` **仍然只回自己的餐**——它只多問了「這幾餐各有幾個讚」。

### 5.7 好友端點的副作用

`POST /api/friends/requests`：新邀請 → 給對方一則 `friend_request`；直接成立 → 給原本送邀請的人一則 `friend_accepted`。
`POST /api/friends/requests/{id}/accept` → 給送邀請的人一則 `friend_accepted`。寫之前先刪同一對、同方向的舊好友通知（每個方向最多一則）。
回應的形狀不變。

---

## 6. 前端

### 6.1 檔案

| 檔案 | 內容 |
|---|---|
| `src/api/social.ts`（新） | `useSocialMeal`、`setLike`、`postComment`、`deleteComment`、`patchMealCounts` |
| `src/api/notifications.ts`（新） | `useNotifications`、`useUnreadCount`、`markAllRead` |
| `src/api/queries.ts`、`persist.ts` | `["social", …]` 的鍵；`NOT_PERSISTED` 加 `"social"` |
| `src/components/LikeButton.tsx`（新） | 讚的按鈕（D18、D19） |
| `src/components/CommentForm.tsx`、`CommentList.tsx`（新） | 留言的輸入與清單 |
| `src/components/NotificationsCard.tsx`（新） | 「我的」最上面的卡片 |
| `src/screens/MealDetail.tsx`、`Notifications.tsx`（新） | 兩個新畫面 |
| `FriendMealCard.tsx`、`MealList.tsx`、`TabBar.tsx`、`SideNav.tsx`、`Me.tsx`、`App.tsx` | 接上去 |

兩個新路由都落在 `contentWidthFor` 的預設值 `narrow`（640）——`lib/layout.ts` 不用改，補兩條測試釘住。

### 6.2 卡片

- **好友的卡片**（動態、某一天）：最下面一列——讚的按鈕（愛心＋數字）與連到 `/meals/:id` 的「留言 N」。
- **自己的卡片**（飲食頁）：「♥ N」是文字（不能按，N 是 0 就不畫）＋「留言 N」連到 `/meals/:id`。「編輯」不動。
- 離線快取裡的舊餐沒有這兩個欄位（`undefined`）：一律 `?? 0`。

### 6.3 餐點頁 `/meals/:id`

- 標題「{名字}的{餐別}」（自己的是「我的{餐別}」）、時間（`formatDateTime`，裝置時區）、描述、照片（縮圖，點開看大圖）、項目、合計。
- 主人看得到「編輯」連到 `/meals/:id/edit`。
- 讚：好友看到按鈕；主人看到數字。底下「{名字}、{名字} 說讚」。
- 留言清單（`<ol>`）：名字、時間、內容（React 的文字節點）。能刪的有「刪除」→ 行內確認（`role="alertdialog"`、`useConfirmFocus`）。
  刪完焦點移到留言區的標題。截斷時最上面寫「只顯示最近 100 則」。
- 留言框：有標籤的單行輸入；剩 20 個字以內顯示「還可以輸入 N 個字」，超過顯示「超過 N 個字」；空的或超過時送出鍵 `aria-disabled`；
  錯誤在 `role="alert"`（429 帶「N 秒後可再試」）；送出後清空、焦點留在輸入框、新留言出現在清單最後。字數用 code point 算（跟後端一致）。
- `404` →「看不到這一餐」＋回飲食頁。`staleTime: 0`。

### 6.4 通知

- **未讀數**：`useUnreadCount()`——`staleTime: 0`、`refetchInterval: 60_000`、`retry: false`。`App.tsx` 的 `LoggedInShell` 呼叫它，
  把數字當 prop 傳給 `TabBar`／`SideNav`（這兩個元件自己不碰 query——它們的測試不用 `QueryClientProvider`）。
- **「我的」的卡片**：連到 `/notifications`，「通知」＋「N 則新通知」或「沒有新通知」。
- **`/notifications`**：清單；讚與留言連到 `/meals/:id`，好友的兩種連到 `/me`。未讀的有標記（視覺＋隱藏文字「未讀」）。
  清單載入後呼叫一次 `read-all`（`up_to` = 第一則的 id），用回來的數字更新未讀數的快取；**這一次的畫面不重抓**（剛看到的還標著未讀）。
  空的：「還沒有通知」。
- 文字：「{X} 對你的{餐別}按了讚」「{X} 在你的{餐別}留言：{預覽}」「{X} 想加你為好友」「{X} 接受了你的好友邀請」。

### 6.5 分頁上的標記與既有測試（D17）

```tsx
<NavLink to="/me" aria-describedby={unread > 0 ? id : undefined}>
  <Icon aria-hidden /> <span>我的</span>
  {unread > 0 && <span aria-hidden="true" className={styles.badge}>{unread > 9 ? "9+" : unread}</span>}
</NavLink>
{unread > 0 && <span id={id} className={ui.srOnly}>{unread} 則新通知</span>}
```

連結的名稱仍然是「我的」。依賴這個名稱的地方（**都不用改**，計畫的最後一步跑過它們確認）：

- 單元測試：`tests/app.test.tsx`（153、320 行）、`tests/tab-bar.test.tsx`、`tests/side-nav.test.tsx`（後者還比對 `textContent`——未讀是 0 時不畫標記，所以不變）。
- e2e：`account-settings.spec.ts`（22、69、107、135、177 行）、`admin.spec.ts`（142、206）、`ai-multi-food.spec.ts`（134）、`auth.spec.ts`（29）、
  `reports-export.spec.ts`（124、285）、`desktop-layout.spec.ts`（49）。

### 6.6 可及性與版面

- 讚的按鈕、「留言 N」、刪除、通知的每一列：觸控目標 ≥ 44px（`e2e/touch-targets.ts`）。
- 會在聚焦時變成不能用的按鈕用 `aria-disabled`，不用 `disabled`（`ExportCard` 的慣例）。
- 樣式只用 `index.css` 的變數與 `ui.module.css`、`Card`；手機與電腦版都要看過。新增一個 `ui.srOnly`。

---

## 7. 安全與隱私

1. **每個端點都過 `load_visible_meal`**；看不到與不存在同一個 `404`。單一查詢，沒有「先查到再檢查」的兩條路。
2. **刪留言的 IDOR**：條件全部在一個 `DELETE … WHERE` 裡（留言 id、餐 id、我是作者或主人）。
3. **留言是不可信的文字**：`single_line` 清掉控制字元、換行、雙向控制字元；長度在 schema 與資料庫 CHECK 各擋一次；前端只當文字節點畫。
4. **不外流**：`note`、餐費、`photo_path`、食物與份量的 id——餐點頁用的是 `FriendMeal` 白名單。讚與留言不回 email 與 user id。
5. **通知的預覽**：解除好友之後整則通知不顯示（D13），預覽跟著不見。
6. **離線快取**：`["social", …]` 不存 localStorage。自己的餐點清單（`["meals"]`，會存）多了兩個數字，沒有名字與內容。
7. **列舉**：猜 id 的人拿到的都是同一個 404、走同一個查詢；按讚與留言的端點有限速。不另外做固定時間。
8. **CSV 匯出不含讚與留言**：匯出是「你自己的紀錄」；別人寫的留言不是你的資料。
9. **限速是每個容器的記憶體**（同既有的限速器）：重啟歸零、多容器時不共用。

---

## 8. 測試

### 8.1 後端

- **Migration**：`alembic check` 乾淨；三條 CHECK（留言長度、不通知自己、形狀）與兩個唯一真的擋得住（直接寫資料庫）；刪餐、刪留言、刪使用者的 cascade。
- **可見性（核心）**：§4.1 的每一格，五個端點各一次（表格化）；404 的 body 跟不存在的 id **逐字相同**。
  同一個測試裡「看得到 → 解除 → 404」「看得到 → 改成私人 → 404、主人仍然看得到留言」。
- **§4.2**：解除之後數字、名單、留言少掉那個人；加回來又出現。B 看得到 C 在 A 的餐上的留言（D3）。
- **讚**：冪等（PUT 兩次一列、DELETE 兩次 200）；主人 422；**兩條真的連線同時 PUT**（獨立 session，同 `test_invites_concurrency.py`）都是 200、一列、一則通知。
- **留言**：清理（換行、雙向控制字元）、邊界（200／201、清完是空的）、NUL；刪除的三種身分；第三人刪別人的留言 404。
  101 則 → 回 100 則、最舊的那一則不在、`comments_truncated`。
- **不外流**：用**真的有餐費與備註**的餐，回應的 JSON 裡沒有那些值、沒有 email。
- **數字不是 N+1**：好友動態 20 餐的查詢次數跟 1 餐一樣（數 `before_cursor_execute`）。
- **通知**：每一種的寫入與不寫入（自己的動作）；收回讚刪通知、再按只有一則；刪留言帶走通知；§4.3 的每一列；
  `read-all` 的 `up_to` 不會動到更新的；別人的通知讀不到也標不到；預覽 40 字的邊界。
- **限速**：第 21 則留言 429 帶 `Retry-After`；讚與收回共用額度；`conftest.py` 的重置加上新的兩個限速器。
- **掃描測試**（`test_friend_meals.py`）：`social_visibility.py` 加進可以碰 `Friendship` 的模組；新增一條——
  `load_visible_meal` 等名字只准出現在社群的模組，`routes/meals.py` 從 `social_visibility` **只能** import `social_counts`。
- **既有測試不改**：`test_cross_user_isolation.py`、`test_being_friends_does_not_open_any_existing_endpoint`。

### 8.2 前端

- 讚的按鈕：樂觀更新、失敗退回、429 的訊息、`aria-pressed`、**連按兩下只送到最後的意圖**（用可以手動放行的回應）。
- 留言框：字數提示、`aria-disabled`、送出後焦點與清空、錯誤；清單：刪除的確認與取消、焦點、截斷的提示。
- 餐點頁：主人與好友兩種樣子、404、照片用對的端點。
- 通知：清單的四種文字與連結；載入後 `read-all` 只送一次、帶對的 `up_to`；未讀數的快取被更新。
- 標記：0 不畫、3、10 →「9+」；連結名稱仍然是「我的」、描述是「N 則新通知」。
- 離線：`["social", …]` 不進 localStorage（`tests/offline.test.tsx`）。

### 8.3 e2e（`e2e/social.spec.ts`，兩個新帳號、各一個 context）

A 記一餐 → B 在好友動態看到、按讚、進餐點頁留言 → A 的「我的」有標記 → 開通知看到兩則 → 點進餐點頁看到 B 的讚與留言 →
刪掉 B 的留言 → B 重新整理後看不到。接著 A 解除好友 → A 的那一餐讚變成 0。

---

## 9. 交付

1. 後端：migration `0018` 與模型
2. 後端：可見性模組、`FriendMeal` 的組法搬家、單一餐點的讀取
3. 後端：讚的端點、三個序列化的數字
4. 後端：留言的端點
5. 後端：讚與留言的通知、通知的三個端點
6. 後端：好友邀請與接受的通知
7. 前端：`schema.d.ts`、API 層、query 鍵
8. 前端：讚的按鈕與卡片上的數字
9. 前端：餐點頁與留言
10. 前端：通知頁、分頁上的標記、「我的」的卡片
11. e2e
12. 文件（handover、部署手冊）

**部署：一支 migration（`0018`），可以退版。** `deploy.sh` 會自己跑。

### 9.1 已知限制（寫進 handover）

1. 共同好友看得到彼此在第三人餐上的名字與留言（D3）。
2. 解除好友之後自己留下的讚與留言收不回來（看不到那一餐了）；它們被藏起來，重新加好友會再出現。
3. 通知不會自己清；沒有推播，最慢 60 秒才看到新的數字。
4. 限速在記憶體裡；`notifications.meal_id`／`comment_id` 沒有索引。
5. 留言超過 100 則時看不到更早的。
