# 按讚、留言、通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 好友的餐可以按讚、留言；每一餐有自己的頁面（`/meals/:id`）；有人對你的餐按讚或留言、送好友邀請或接受邀請時，「我的」的分頁上有未讀數字、`/notifications` 看得到是誰。

**Architecture:** 三張新表（`meal_likes`、`meal_comments`、`notifications`，migration `0018`）。「看不看得到一餐」「一則讚或留言還算不算數」全部寫在新的 `app/social_visibility.py`——解除好友不刪資料，讀的時候用 `EXISTS friendships` 過濾。端點全部是新的（`/api/social/...`、`/api/notifications...`），`/api/meals` 仍然只回自己的餐，只多兩個數字。主人與好友看同一餐走同一個白名單序列化（`FriendMeal`，搬到 `app/friend_meals.py`）。讚用 `INSERT … ON CONFLICT DO NOTHING`，通知跟讚／留言在同一個交易寫。前端的社群 query 都在 `["social", …]` 底下、不進 localStorage；讚是樂觀更新＋一次一個請求；未讀數由 `LoggedInShell` 輪詢後當 prop 傳給 `TabBar`／`SideNav`。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · React 19 · TypeScript strict · TanStack Query v5 · react-router · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-10-social-interactions-design.md`（以下稱「規格」；D1…D22 指它的 §2）

---

## 執行環境

- 分支 `feat/social-interactions`（已建立，**不要 push**）。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（整套約 2 分 50 秒，timeout 給 10 分鐘；**同一時間只跑一個 pytest**——測試資料庫每次砍掉重建）。需要 dev 的 Postgres：`docker compose up -d`（專案 `wallet`，`localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`。**不要跑 `ruff format`**（handover §7）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式用 `npx biome check --write <檔案>`）。驗證時一起 grep `FAIL` 與 `Unhandled`。**typecheck 在每次 commit 之前單獨跑一次，跟 `git commit` 用 `&&` 串，不要用 `;`。**
- e2e：先 `docker compose up -d --build api`（migration 烤在映像裡，handover §7），再在 `frontend/` 跑 `npx playwright test …`。
- 基準線（`8cb9122`，handover §2）：後端 **1227**；前端 `Test Files 142`、`Tests 1817`（vitest 印出來的數字）；e2e **47**；端點 **79**；資料表 16。開工前自己再量一次，對不上照實記下來。
- **`schema.d.ts` 重新產生**——動到 `app/api/routes` 或 `app/schemas` 的每一個 commit（docstring 也算）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  產生之後跑 `cd frontend && npm run -s typecheck`：新的**必填**回應欄位會讓有型別標註的測試資料變紅（各 task 寫了是哪幾處）。
- **突變**：改一行、看到指定的測試紅、改回、重跑看到綠。`.py` 改回之後 `touch` 那個檔案（`.pyc` 的 mtime）。**還沒 commit 的新檔案 `git checkout --` 救不回來**：突變前先複製一份到 scratchpad（`cp app/x.py "$S/social-plan-x.py.bak"`），改回之後 `diff` 確認。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/social-plan-<task>-msg.txt`（每次用不同的檔名），最後一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`git add .`）。不要 amend。
- **看不見的字元**：Write／Edit 工具會把「反斜線 u＋四位十六進位」解成真的字元（handover §7）。這份計畫的測試一律寫 `chr(0x202E)`（Python）或 `String.fromCodePoint(0x202e)`（TS），不寫跳脫字元。每個 task commit 前跑一次：

  ```bash
  git diff --cached --name-only | ./.venv/Scripts/python.exe -c "import sys,unicodedata as u; [print(p.strip(), i+1, hex(ord(c))) for p in sys.stdin for i,l in enumerate(open(p.strip(),encoding='utf-8')) for c in l if u.category(c) in ('Cf','Zl','Zp') and ord(c)!=0x200D]"
  ```

  Expected：沒有輸出。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。新模組還不存在時紅的是 import，不是斷言——斷言有沒有咬合力由每個 task 的突變步驟證明（handover §6 規矩 1、8）。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. **要測 A 過濾器，測試資料必須讓 B 過濾器無效**（規矩 2）。這個功能有三道會互相遮住的過濾：「看不看得到餐」「作者還算不算數」「是不是私人」。每條測試的 docstring 寫明它讓哪兩道無效。
4. **「看不到」的測試一律先在同一條測試裡看得到一次**（先 200、解除、再 404）。只斷言 404 的測試，路徑打錯也會綠。
5. **不外流的測試用真的有餐費、備註的餐**；斷言「回應裡沒有這個字串」之前，先斷言同一個回應裡有描述（第 5 種：兩個都要有）。
6. `client` 夾具跟測試共用一個 session（handover §6 第 14 種）：看不見兩個交易互相等。並行按讚那一條用獨立的 session（照抄 `tests/test_invites_concurrency.py` 的 `independent_sessions`），資料真的 commit、`finally` 自己清。
7. 共用 session 裡 `rollback()` 之後 ORM 物件會過期（`MissingGreenlet`）。要測「資料庫擋下來」用 `async with db_session.begin_nested():` 包住 raw SQL，id 先存成整數。
8. `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對：`/api/social/meals/5` 不會被 `/api/meals` 吃掉（這是 D6 的理由之一），但 `/api/social/meals/5/like` 會被 `/api/social/meals/5` 吃掉——越具體的排越前面。沒準備的路徑會 `throw`（query 變成 error，不會讓測試直接紅）——所以**斷言「沒有發出某個請求」要看 `spy.mock.calls`，不能靠它 throw**。
9. `TabBar`／`SideNav` 的既有測試**沒有 `QueryClientProvider`**：這兩個元件不准呼叫任何 query hook（未讀數是 prop，預設 0）。
10. Playwright 的名稱預設是子字串比對：一律 `exact: true`。可及名稱帶時間的元素不要用時間去對（Chromium 是 en-US）。登入之後**只用點擊換頁**，不要 `page.goto`。一個使用者一個 context。
11. 離線快取裡的舊餐沒有新欄位（`undefined`，不是 `null`）：畫面一律 `?? 0`（handover §7）。
12. `app/schemas/*.py`、`app/models/*.py`、`routes/meals.py` 的**註解**不要出現 `social_visibility`、`load_visible_meal`、`meal_visible_to`、`build_friend_meals`、`friend_meals` 這幾個字——Task 2 的掃描測試是掃文字的。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**在 worktree 裡整份跑過。「Expected: PASS」的條數是照測試清單數的，不是量的；對不上照實回報。只有下面三件不確定的事做了小實驗：

| 實驗 | 結果 |
|---|---|
| Task 1 的三個模型＋Task 2 的 `social_visibility.py` 整份，對 `wallet_test` 在一個 rollback 掉的交易裡建表、塞五個人（主人、兩個好友、陌生人、邀請中）跑過 | 可見性表格、`FOR SHARE OF meals`、`ON CONFLICT DO NOTHING … RETURNING`（衝突時回 `None`）、部分唯一索引擋第二則讚的通知、解除後數字與通知立刻少掉、刪餐 cascade、三條 CHECK——全部如預期。**`ON CONFLICT` 也會吃掉一個 identity 值**（id 會跳號，不要斷言 id 連續） |
| `type` 的 CHECK | 寫了 `type IN (…)` 也永遠看不到它：四種以外的值先被 `shape_matches_type` 擋。所以只留一條（規格 §3.3） |
| jsdom 裡 `aria-hidden` 的標記不進連結名稱；`aria-describedby` 指到連結外面的元素；按鈕 `aria-pressed`＋`aria-describedby` 指到自己裡面的元素 | `getByRole("link", { name: "我的" })`、`toHaveAccessibleDescription("12 則新通知")`、`getByRole("button", { name: "讚，鮑伯的午餐", pressed: true })` 都對 |

## 與規格的差異

（執行時發現的寫在這裡。）

## 執行中發現的差異

（哪個 task、原本寫什麼、實際是什麼、為什麼。Task 1～8 已填；後面的 task 接著寫。）

**基準線與數字**

- 開工前量到的跟計畫寫的一樣：後端 1227、前端 `Test Files 142`／`Tests 1817`。
- 後端條數：1227 → Task 1 **1249**（＋22）→ Task 2 **1282**（＋33）→ Task 3 **1304**（＋22）。前端三個 task 之後仍然是 142／1817。
- 計畫預測的條數每一個都少算——不是數錯，是補了測試（下面各 task 的表）。
- dev 資料庫（`wallet`）**沒有升版**，還在 `0017`；`0018` 只對 `wallet_test` 跑過 upgrade → `alembic check` → downgrade → upgrade → `alembic check`。Task 11 的 `docker compose up -d --build api` 會把 dev 升上去。

**工具（Task 1～3 都適用）**

- 在 Bash heredoc 裡跑的 Python 腳本，內容的反斜線會少一層：要寫進測試檔的 regex 單字邊界（反斜線＋b）變成了**真的退格字元（0x08）**，「反斜線＋n」變成真的換行。這一次是 `SyntaxError` 當場擋下來的；退格字元是 `Cc` 類，**「執行環境」那一段的掃描（只看 `Cf`／`Zl`／`Zp`）掃不到它**。之後帶反斜線的內容一律用 Write／Edit 工具寫；Task 3 commit 之後另外對這三個 commit 動到的 23 個檔案掃了一次 `Cc`（Tab 與換行除外）與 CR，乾淨。
- 突變用一支小腳本做（改 → 跑 → 還原 bytes → 刪掉對應的 `.pyc`）。刪 `.pyc` 比 `touch` 可靠：pyc 用「秒」比對 mtime，同一秒內同樣大小的改動會被當成沒變。

**Task 1（`f62026c`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `test_social_model.py` **18** 條 | **22** 條：多一條 `test_the_four_right_shapes_are_accepted`（四種對的形狀各寫一次） | 計畫說「對的形狀由後面的 task 經過端點寫進去」，但 `friend_request`／`friend_accepted` 要到 Task 6 才有人寫。只測「錯的被擋」的話，把 `shape_matches_type` 的好友分支整個拿掉（好友通知一則都寫不進去）是**全綠**——突變確認過，補了之後紅 2 條 |
| 突變「`uq_notifications_like` 拿掉 `postgresql_where`」紅 `test_only_one_like_notification…` 的後半 | 紅 4 條：那一條，加上三條 cascade 測試 | `_fill` 對同一個（收件人、動作者、餐）寫一則讚的通知與一則留言的通知，索引變成全表唯一之後第二則就撞到 |
| 突變表其餘 7 個 | 全部如預測：唯一約束、`BETWEEN` 兩個邊界、`not_self`、`like` 分支、`unique=True`、`SET NULL`（紅的樣子是 `CheckViolationError … ck_notifications_shape_matches_type`）、只改模型（22 條全部 ERROR 在 `alembic check`） | — |
| — | 多跑兩個突變：`shape` 拿掉好友分支（見上）；`meal_likes.meal_id` 的 FK 不 cascade → `test_deleting_a_meal…` 紅在 `ForeignKeyViolationError` | 模型與 migration 兩邊一起改，`alembic check` 不會先擋 |
| migration 的 `shape` 那一條沒有註解 | 加了一行註解（它同時是 `type` 的手寫約束）與「述詞必須跟模型一字不差」 | 照 `0016` 的慣例；純註解 |

**Task 2（`87db687`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `test_social_meal.py` **20** 條 | **32** 條 | 見下面「補的測試」 |
| 重新產生 `schema.d.ts`「多四個 schema」 | 三個：`LikerResponse`、`CommentResponse`、`SocialMealResponse` | 計畫多數了一個（`LikeState` 是 Task 3 的） |
| `build_friend_meals` 的 `user=` 沿用 `_person` | 直接組 `PersonResponse(id=…, display_name=…)`；`_person` 留在 `routes/friends.py`（別的端點還在用） | 新模組不該反過來 import 路由檔 |
| `social_helpers.make_cast` | 多一行 `assert revision is not None` | `db_session.get` 的回傳可能是 `None`；跟 `test_friend_meals.py` 的 `pals` 同一個寫法 |
| `test_a_friend_sees_the_whitelisted_meal…` 只斷言 `meal` 裡的幾個欄位 | 多斷言 `set(body["meal"])` 等於完整的白名單（14 個鍵）與 `items[0]` 的鍵 | 這是 D7 的重點：主人與好友同一個白名單。只用「回應裡沒有這幾個字串」的話，多帶一個新欄位看不出來 |
| 突變表 14 個 | 全部紅，紅的測試都包含預測的那幾條 | 補的測試讓好幾個突變多紅幾條（例如拿掉 `status == ACCEPTED` 多紅 `…[pending]` 與「主人送出的邀請」） |

補的測試（**每一條都有一個只有它抓得到的突變**，除非另外註明）：

1. `test_a_friend_of_a_friend_is_still_a_stranger`——小卡是愛麗絲的好友、不是鮑伯的，鮑伯的餐她看不到。**計畫的那組人分不出這件事**：阿丁與伊芙一個已接受的好友都沒有，所以把 `meal_visible_to` 寫成「viewer 有任何一個好友」也是全綠。突變確認：只有這一條紅。
2. `test_someone_elses_friend_does_not_count_on_this_meal`——同一件事在「作者算不算數」那一邊：`author_counts` 寫成「作者有任何一個好友」時，只有這一條紅（`like_counts` 的同一個突變另外被 `test_a_self_like_row_never_counts` 抓到）。
3. `test_the_one_who_liked_is_marked_as_me`——名單的 `is_me`。計畫的測試裡名單上的人從來不是看的人，`is_me=False` 寫死是全綠。
4. `test_every_way_of_not_seeing_is_the_same_404[stranger|pending|private|unfriended]`——四種看不到各自跟「id 不存在」**逐字相同**（計畫只比了陌生人那一種）；每一種先確認主人打同一個網址是 200。
5. `test_an_invitation_the_owner_sent_opens_nothing_until_it_is_accepted`——阿丁是「別人邀主人」；這是另一個方向，而且接受之後同一個網址變成 200。
6. `test_each_meal_in_the_feed_carries_its_own_numbers`——兩餐、數字不一樣。（沒有專屬的突變：把 `comment_count` 寫死已經被別的測試抓到；它守的是 `GROUP BY` 對錯餐。）
7. `test_an_id_that_cannot_be_a_meal_is_422_not_500[0|-1|2**63]`——規格 §5「超出 bigint → 422」。

另外多跑 8 個計畫沒列的突變，全部紅：可見性改成「viewer 有任何好友」、作者過濾改成「作者有任何好友」、名單 `is_me` 寫死、`is_mine` 寫死、名單順序反過來、`read_social_meal` 不過可見性（直接 `db.get`）、`liked_by_me` 的 `bool_or` 恆真、`FriendMeal.comment_count` 寫死。

**Task 3（`69e76c5`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `test_social_likes.py` **14** 條、並行 **1** 條 | **20** 條、並行 **2** 條 | 見下面 |
| `like_meal`／`unlike_meal` 在 commit 之後用 `meal.id`、`user.id` | 開頭先存 `user_id = user.id`，之後一律用 `user_id` 與路徑參數 `meal_id`；`unlike_meal` 沒有留住 `meal`（`await load_visible_meal(…)` 不接回傳值） | commit 之後不碰 ORM 物件（「開工前必讀」第 7 點的同一個坑）。**Task 5 要注意**：`unlike_meal` 要改回 `meal = await load_visible_meal(…)` 才拿得到 `meal.user_id`（通知的收件人），而且要在 commit **之前**讀 |
| import `CommentResponse, LikeState, LikerResponse, …` | `CommentResponse, LikerResponse, LikeState, …` | ruff 的 I001（排序分大小寫） |
| `_own_views` 走四條路徑；改項目、上傳照片「補不上就照實寫」 | 補上了，六條都走；另外斷言每一條回的是同一餐（`body["id"]`） | 突變確認：`update_meal_item`、`upload_meal_photo` 各自改傳 `SocialCounts()` 都紅 |
| 突變「拿掉 `on_conflict_do_nothing`」紅並行那一條與 `test_both_directions_are_idempotent` | 那兩條，加上 `test_after_unfriending…`（加回好友之後再按一次）。共用 session 裡紅的樣子是 `IntegrityError` 直接從 `client.put` 丟出來，不是 500 的回應 | 測試的 ASGI transport 預設把 app 的例外往外丟 |
| 突變「`conftest.py` 拿掉 `like_rate_limiter.reset()`」預期存活 | 存活（46 passed） | 如預測 |
| 突變表其餘 | 全部如預測 | — |
| Step 7：`typecheck` 紅一處（`tests/timeline.test.ts`） | 紅一處，就是那一處；補兩個欄位之後 typecheck、test（142／1817）、lint 都綠 | — |

補的測試：

1. **`test_a_like_racing_the_owner_closing_the_meal_waits_and_is_then_refused`（兩條真的連線）**——規格 §4.4。主人的交易 `FOR UPDATE` 載入這一餐、改成私人、還沒 commit；好友同時按讚：讚等主人 commit，然後是 `NotFoundError(MEAL_NOT_FOUND)`，`meal_likes` 一列都沒有。**計畫沒有任何測試看得到 `lock=True`**：把 `like_meal` 改成 `lock=False`，計畫的測試全綠，只有這一條紅（按讚不等、直接寫進去）。
2. `test_a_like_lands_on_that_meal_only`——同一個人在另一餐也有讚。`unlike_meal` 的 `DELETE` 拿掉 `meal_id` 條件（收回我所有的讚）時只有這一條紅。
3. `test_a_friend_of_a_friend_cannot_like`、私人與解除之後的 404 跟不存在逐字相同（加在既有的兩條裡）、`test_an_id_that_cannot_be_a_meal_is_422_not_500[put|delete]`。
4. `test_my_list_gives_each_meal_its_own_numbers`——同一天兩餐。`list_meals` 每一餐都拿第一餐的數字時只有這一條紅。
5. `test_my_own_endpoints_still_refuse_a_friends_meal`——`/api/meals` 多了兩個數字，沒有多讀得到任何人的餐：鮑伯在社群的端點看得到的那一餐，`/api/meals/{id}` 照舊 404、清單照舊是空的。（回歸用：實作之前就是綠的。）

**沒有測試守住的事（已知，照實記）**

- `unlike_meal` 的 `lock=True`：拿掉它沒有測試會紅。收回一個讚落在正在關起來的餐上沒有壞處（讚少一個），鎖是照規格 §4.4「讚、留言寫入時」加的。
- `read_social_meal` 的 `if owner is None`（主人的帳號剛好被刪）：現在沒有刪帳號的路，走不到。

**Task 4～6 的數字與工具**

- 後端條數：1304 → Task 4 **1344**（＋40）→ Task 5 **1371**（＋27）→ Task 6 **1384**（＋13）。前端仍然是 142／1817（三個 task 之後 typecheck、test、lint 都綠；沒有任何測試資料要補欄位）。
- 端點：`grep -c "@router\." app/api/routes/*.py` 的加總是 **87**（79＋8），跟預測一樣。
- dev 資料庫仍然在 `0017`。
- **突變跑到一半被砍，檔案會停在突變的狀態。** Task 5 的那一批第一次是用背景執行、時間上限給得太短（35 個突變要十幾分鐘），手動停掉之後 `routes/social.py` 留著 `if True:`。小腳本的 `finally` 在行程被強制結束時不會跑。救法：scratchpad 的 `social-be1-bak-<路徑>` 是每個突變動手前寫的原始 bytes，`diff` 確認只差那一行之後複製回去、刪掉 `.pyc`。之後長的批次一律：`python -u`（輸出不緩衝）、背景執行、時間上限給足；跑完用 `git status` 與 `grep` 確認每個被動過的檔案都回來了。
- 「執行環境」的看不見字元掃描換成一支小腳本（`Cc`、`Cf`／`Zl`／`Zp`、CR、BOM；ZWJ 也列出來看是不是故意的），三個 commit 之前各跑一次，都乾淨。

**Task 4（`6d36d8a`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `test_social_comments.py` **25** 條 | **39** 條，另外 `test_social_likes_concurrency.py` 多 **1** 條 | 見下面「補的測試」 |
| `add_comment` 在 commit 之後用 `user.display_name`、`user.id`、`meal.user_id` | 開頭先存 `user_id`、`display_name`，載入之後存 `owner_id`；之後不碰 ORM 物件 | 同 Task 3 |
| 測試檔第一條的那一行 `assert (…) == ("鮑伯", True, True)` | 拆成多行 | ruff E501（101 欄） |
| `test_the_author_deletes…` 沒有比對錯誤的內容 | 多斷言 `code`／`message`；錯誤的 body 是 `{code, message, details}`，不能用 `==` 比整個 dict | — |
| 突變「不清理（`value.strip()`）」紅 `…one_safe_line`、`[200-padded]`、`[control]` | 紅 `…one_safe_line` 與 `[control]`，**`[200-padded]` 不紅** | 補在後面的都是空白與換行，`strip()` 也去得掉。`[control]` 紅的樣子是資料庫的錯誤（NUL 進不了 `text`），不是「422 變成 201」 |
| 突變「`Field(max_length=1000)` 拿掉」**預期存活** | **紅**（`[raw-1001-padded]`） | 補了兩格：一個字＋999 個空白是 201、＋1000 個空白是 422——清完只剩一個字，200 那一道管不到它，擋下來的只有清理之前的上限。`max_length=1001` 也紅 |
| 突變「`COMMENT_LIMIT = 21`」紅 `test_comments_are_limited_per_person` | 原本的測試**存活**（測試用的是同一個常數）；補一行 `assert COMMENT_LIMIT == 20` 之後紅 | 規格 D20 的數字要釘在測試裡 |
| 突變「`COMMENT_MAX_LENGTH = 201`」「拿掉 `if not cleaned`」是資料庫的 CHECK 擋的 | 如預測：`CheckViolationError … ck_meal_comments_body_length` 從 `client.post` 冒出來 | — |
| 突變表其餘 | 全部如預測 | — |

補的測試：

1. **`test_a_comment_racing_the_owner_closing_the_meal_waits_and_is_then_refused`（兩條真的連線，放在 `test_social_likes_concurrency.py`）**——`add_comment` 的 `lock=True`。計畫的測試沒有一條看得到它：改成 `lock=False` 全綠，只有這一條紅。
2. **`test_both_writes_are_committed`**——端點回來之後 `db_session.rollback()` 一次再讀。共用 session 的夾具看得到沒 commit 的寫入：`delete_comment` 拿掉 `await db.commit()`、`add_comment` 把 commit 換成 flush，計畫的測試都是全綠，只有這一條紅。
3. `test_a_friend_of_a_friend_cannot_comment`、`…cannot_delete`——伊芙是鮑伯的好友、不是愛麗絲的（Task 2 發現的那一格：`make_cast` 的阿丁與伊芙分不出「主人的好友」與「有任何一個好友」）。
4. `test_a_comment_is_only_deletable_under_its_own_meal`——同一個主人的兩餐，留言在第一餐、網址寫第二餐；主人與作者都試一次。跟計畫的 IDOR 那一條一起守 `meal_id` 的條件。
5. `test_going_private_the_author_cannot_delete_but_the_owner_can`（D5）、`test_the_owner_commenting_on_their_own_meal_is_marked_as_theirs`、`test_a_comment_lands_on_that_meal_only`。
6. `test_the_limit_counts_attempts_on_meals_you_cannot_see`——限速在可見性之前（規格 §5.3 的順序）。把 `hit` 移到 `load_visible_meal` 後面時只有這一條紅。
7. `test_an_id_that_cannot_be_a_meal_is_422_not_500[0|-1|2**63]`——兩個端點、留言 id 也試。
8. 既有的幾條加了「先看得到一次」與「跟不存在逐字相同」：私人、解除之後、阿丁與伊芙的留言與刪除。`test_a_third_person…` 多一則主人自己的留言（小卡也刪不到）並先確認她看到的 `can_delete` 是 `False`。

多跑的突變（計畫沒列，全部紅）：限速移到可見性之後、`add_comment` 的 `viewer_id` 寫錯、作者寫成主人、刪除的作者條件換成「不是主人寫的」、兩個端點各自不 commit、`add_comment` 的 `lock=False`。

**Task 5（`62d3b47`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `test_notifications.py` **20** 條 | **27** 條 | 見下面 |
| `eaten_at` 可能是 `+00:00` 結尾 | 是 `Z`，測試照計畫寫的不用改 | — |
| `like_meal`／`add_comment`／`read_all` 在 commit 之後用 `user.id`、`meal.id` | 一律用開頭存好的整數與路徑參數；`unlike_meal` 改回 `meal = await load_visible_meal(…)`，`meal.user_id` 在 commit **之前**讀 | 同 Task 3 的提醒 |
| `test_unliking_only_removes_my_like_notification` | 改名加 `_for_that_meal`，多一餐（鮑伯在另一餐也有讚） | `forget_like` 的四個條件各有一則「只差那一個」的通知；拿掉 `meal_id` 時只有這一條紅 |
| `test_unfriending_hides_their_notifications…` | 鮑伯另外有一個好友（伊芙）；中間多一段「鮑伯重新送邀請、還在等」 | 過濾寫成「動作者有任何一個好友」、或第一個分支拿掉 `is_request`（等著的邀請讓讚與留言也顯示）時，計畫的版本是全綠 |
| 突變「`notify_like` 的 `on_conflict_do_nothing` 拿掉」「`notify_like` 拿掉自己的 return」預期存活 | 存活 | 如預測 |
| 突變「兩個一起拿掉」紅 `test_liking_twice…` | 紅 4 條：那一條、並行那一條、`test_social_likes.py` 的 `test_both_directions_are_idempotent` 與 `test_after_unfriending…`（`UniqueViolationError … uq_notifications_like`） | 每一個重複的 PUT 都撞到 |
| 突變「`notify_comment` 拿掉自己的 return」是 CHECK 擋的 | 如預測：`ck_notifications_not_self` | — |
| 突變「`lt=2**63` 拿掉」 | 如預測：asyncpg 的 `DataError`（`value out of int64 range`） | — |
| 突變表其餘 | 全部如預測 | — |

補的測試：

1. `test_read_all_also_marks_what_is_hidden_right_now`——規格 §4.3「`read-all` 不套可見性」。`read_all` 多套一個 `notification_visible()` 時只有這一條紅。
2. `test_read_all_is_committed`——rollback 之後再問未讀數。`read_all` 不 commit 時只有這一條紅。
3. `test_every_comment_gets_its_own_notification`（留言不像讚，一則一個；刪一則只帶走它自己的）、`test_the_owner_trying_to_like_their_own_meal_writes_nothing`（回歸用，實作之前就是綠的）、`test_read_all_accepts_the_largest_id_and_an_id_that_is_not_there`（`2**63 - 1` 是 200）。
4. 參數多兩格：預覽 `[1]`、`read-all` 的 `{"up_to": null}`。既有的幾條多斷言資料列的總數（`_rows`）、未讀數、`meal` 的形狀；私人那一條多一則留言與它的預覽。

多跑的突變（全部紅，除非另外註明）：`forget_like` 拿掉 `meal_id`；`notification_visible` 改成「動作者有任何一個好友」、第一個分支拿掉 `is_request`；清單拿掉 `notification_visible()`；`_unread` 拿掉 `user_id`；`read_all` 套上可見性、不 commit、`<=` 改 `<`；`add_comment` 不寫通知；`meal` 寫死 `None`；`is_read` 寫死 `False`。

存活的（照實記）：

- `forget_like` 拿掉 `user_id == owner_id`：**等價**。讚的通知只寫給那一餐的主人，（動作者、餐、種類）已經決定了收件人。條件留著是讓它跟 `uq_notifications_like` 的三個欄位對齊。
- `notification_visible` 第二個分支拿掉 `~is_request`：Task 5 的時候存活（還沒有人寫好友通知），Task 6 之後紅（`test_accepting_tells_the_sender_and_retires_the_request_notice`）。

**Task 6（`4e0f383`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `test_notifications.py` **28** 條（20＋8） | **40** 條（27＋13） | 見下面 |
| `_insert_request` 的註解一行 | 拆成兩行 | ruff E501 |
| 重新產生 `schema.d.ts` 是空的 | 是空的 | `_insert_request` 的 docstring 多一句，它不是路由 |
| `test_friend_requests.py` 一條都不能紅 | 全綠（含三條 monkeypatch 的競態） | — |
| 突變「`to=` 寫反」紅 `test_a_friend_request_tells_the_receiver` | 紅 14 條，包含 `test_friend_requests.py` 的 4 條以上（`ck_notifications_not_self` 從 `client.post` 冒出來） | 每一個送邀請的測試都撞到 |
| 突變「拿掉 `await db.flush()`」可能仍然綠 | 存活 | 如預測：autoflush 的例外也落在 try 裡 |
| 突變「`still_pending` 拿掉 `requested_by == actor_id`」**預期存活**（「方向不對的通知寫不出來」） | **紅**，而且那是一個真的會發生的畫面 | 伊芙邀愛麗絲、愛麗絲拒絕（通知留著、藏起來）；後來愛麗絲邀伊芙——這一對又有一列「在等」，但那是愛麗絲送的。沒有這個條件，愛麗絲那則舊的「伊芙想加你為好友」會冒出來。補了 `test_an_old_request_notice_does_not_resurface_when_i_ask_them` |
| 突變表其餘 | 全部如預測 | — |

補的測試：

1. `test_an_old_request_notice_does_not_resurface_when_i_ask_them`（見上）。
2. `test_a_request_to_someone_else_does_not_revive_my_notice`——`still_pending` 拿掉 `*_pair(…)`（動作者有任何一個送出去的邀請在等）時只有這一條紅。
3. `test_each_direction_keeps_its_own_notice`——「只留最新一則」的 DELETE 拿掉 `user_id == to` 或 `actor_id == actor` 時只有這一條紅（後者會把同一個收件人收到的**所有人**的好友通知一起刪掉；計畫的測試全綠）。
4. `test_the_friend_notices_are_committed_with_the_request`——rollback 之後再讀。通知移到 `commit` 之後才寫（不在邀請的那個交易裡）時只有這一條紅。
5. `test_a_request_that_is_refused_writes_nothing`（409 與 404 都不寫；回歸用）；`test_unfriending_hides_the_accepted_notice` 的伊芙另外有一個好友；`test_becoming_friends_again…` 多一則留言，並在「邀請還在等」的時候先看一次（只有邀請那一則）。

**沒有測試守住的事（Task 4～6，已知）**

- `notify_like` 的 `on_conflict_do_nothing` 與它自己的 `owner_id == actor_id`：經過端點走不到（重複的 PUT 先被 `if inserted is not None` 擋、主人按讚先 422）。第二道防線。
- `_insert_request` 的 `await db.flush()`：讓順序明確，不是唯一的保證。
- `delete_comment` 沒有鎖那一餐（計畫就是這樣寫的）：刪除不會讓一則留言落在關起來的餐上，不需要。

**給 Task 7～12 的提醒（照實作寫的）**

- 路徑、形狀、錯誤碼跟規格 §5 一樣，沒有差異。錯誤的 body 是 `{"error": {"code", "message", "details"}}`。
- `POST /api/social/meals/{id}/comments`：body `{ "body": string }`；`201` 回 `CommentResponse`；`422`（清完是空的、超過 200 字、清理之前超過 1000 字、不是字串）是 FastAPI 的驗證錯誤；`429 TOO_MANY_COMMENTS` 帶 `Retry-After`；`404 MEAL_NOT_FOUND`。
- `DELETE /api/social/meals/{id}/comments/{comment_id}`：`204` 沒有 body；`404 MEAL_NOT_FOUND`（看不到那一餐）或 `404 COMMENT_NOT_FOUND`「找不到這則留言」。
- `GET /api/notifications` → `{ items: NotificationItem[] }`；`type` 是 `"like" | "comment" | "friend_request" | "friend_accepted"`；`meal` 與 `comment_preview` 在好友的兩種是 `null`；`meal.eaten_at` 與 `created_at` 是 `Z` 結尾。
- `GET /api/notifications/unread-count` → `{ count }`；`POST /api/notifications/read-all` body `{ up_to: number }`（1 到 2^63−1，必填）→ `{ count }`（剩下的未讀數）。
- 前端的 `mockApi` 用 `url.includes` 依序比對：`/api/notifications/unread-count` 與 `/read-all` 要排在 `/api/notifications` **前面**。
- 接受邀請之後，收件人那一則 `friend_request` 會從清單與未讀數消失（不是變成已讀）——Task 10 接受邀請之後要讓通知與未讀數的 query 失效，Task 11 的 e2e 不要去找那一則。
- 好友通知沒有 `meal`：Task 10 的連結是 `/me`。

**Task 7～8 的數字與工具**

- 前端（vitest 印出來的數字）：142／1817 → Task 7 **144／1843** → Task 8 **146／1907** → 看過截圖之後的調整 **146／1909**。後端沒有動（1384）。`schema.d.ts` 開工前重新產生一次，`git diff` 是空的。
- e2e：`friends.spec.ts` 以外的 46 條跑過一次，全綠（那一條會動示範帳號的好友關係，這一輪沒有跑；它的選擇器逐行看過，沒有一個會被新的名稱搶走）。
- **dev 資料庫現在在 `0018`。** 上面寫的「Task 11 的 `docker compose up -d --build api` 會把 dev 升上去」是錯的：dev 的 api 容器啟動時不跑 migration，重建之後 `alembic current` 還是 `0017`（社群的路由在、表不在）。要另外跑 `docker compose exec -T api python -m alembic upgrade head`。Task 8 的視覺檢查前跑過了；**Task 11 在別的機器上要自己跑一次**。
- 突變用一支小腳本（scratchpad 的 `social-fe1-mutate.py`）：改 bytes → 跑指定的測試（240 秒上限，逾時用 `taskkill /T`）→ 寫回原本的 bytes → 比對。批次用背景執行；跑的時候 Vite 的 dev server 會熱更新到突變的程式，**截圖要等批次跑完**。
- **Bash heredoc 不只是吃反斜線**：有兩次整個指令直接是 `unexpected EOF while looking for matching`（heredoc 的內容是帶中文註解、樣板字串的 Python 與 TS；沒有追是哪個字元）。超過幾行的腳本一律用 Write 工具寫成檔案再跑。
- 視覺檢查開了四組一次性的帳號（`shot.alice.*`／`shot.bob.*@example.com`，腳本前三次各跑到一半），都留在 dev 資料庫裡；沒有動任何示範帳號。

**Task 7（`7b0dd2b`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| `tests/social-api.test.tsx` 5 條 | **12 條**（Task 8 再加 2 條） | 計畫的 5 條之外：`postComment`、`deleteComment`（方法、網址、body）、`useSocialMeal`（404 只打一次）、`afterCommentChange`（四個鍵標成過期、別的餐與別的資料不動）、`useNotifications`（回的是 `items`）、未讀數抓不到時只打一次、下面那一條 |
| 「沒有那個快取時不會憑空生一個」守三個 updater 的 `data &&` | 只守得到餐點頁那一個 | 空的 client 上 `setQueriesData` 找不到任何 query，動態與某一天的 updater **根本沒被呼叫**——那兩個的 `data &&` 拿掉是全綠。補了「query 在但還沒有資料」（三個 `prefetch…` 掛著不回來）：動態第一次載入失敗時，人可以在好友的某一天按讚，那時動態的 query 存在而 `data` 是 `undefined`。突變確認：三個各自紅 |
| `patchLikes` 第 1 條 | 多一份 `friendDay(2, null)`（讓後端決定今天的那一份）、多一份 `socialMeal(9)`（別的餐不動） | `friendDays` 的前綴改成只對到某一個日期時，只有 `null` 那一份紅 |
| 離線的那一條「原始字串裡沒有留言的文字」 | 多比名單上的名字、通知的預覽 | 三個鍵各自換到別的命名空間時各自紅（`["notifications"]`、`["unread"]`、`["meals", "social", id]`） |
| `required` 加 `export` | 加了一段說明 | — |
| 突變表（7 列、9 個） | 全部紅 | 另外多跑 17 個，全部紅：`notifications`、`unreadCount` 的鍵各自換命名空間、`friendDays` 的前綴、動態與某一天的 `data &&`、`markAllRead` 的鍵、`useSocialMeal` 照預設重試（紅的樣子是 1 秒內沒有變成 error）、未讀數照預設重試、`afterCommentChange` 的三個清單失效各拿掉一個與「每一餐的餐點頁都失效」、`useNotifications` 回整個 body、`deleteComment` 不帶方法、`postComment` 的鍵、`staleTime: 0`（餐點頁一個、通知的兩個一起） |

**Task 8（`3beb0e2`，看過截圖之後的調整 `6bc3d60`）**

| 原本寫的 | 實際 | 為什麼 |
|---|---|---|
| 成功之後 `setOptimistic(null)`，畫面改看 props | **留著伺服器的回應，蓋到 props 變了為止**（`Held.over`） | 計畫的寫法會閃：`patchLikes` 寫進快取之後，TanStack 的通知是 `setTimeout(0)` 才送，React 先用**舊的 props** 畫一次（退回「沒讚、2」）、下一拍才變成「讚、5」。jsdom 裡用 `MutationObserver` 看得到（`['false／2 個讚', 'true／5 個讚']`）；瀏覽器裡兩拍之間可能剛好畫一格。現在：這一輪還在送時樂觀的狀態一律蓋過 props；送完換成伺服器的回應，props 還是送完那一刻的樣子就繼續蓋，props 一變就照 props |
| 連按三下送 `["PUT", "PUT"]` | **`["PUT"]`** | 規格 D19 寫的是「送完再看最後的意圖，**不一樣**就再送一次」。第一個回應已經是「讚」，最後的意圖也是「讚」——不用再送（也不白吃限速的額度） |
| 成功之後 `patchLikes`＋`invalidateQueries(socialMeal)` 寫在按鈕裡 | 搬到 `api/social.ts` 的 **`afterLikeChange`**，多一步：**那一刻還在路上的清單重抓，重來一次**（`invalidateQueries({ fetchStatus: "fetching", refetchType: "all" })`） | 回到分頁（動態開始重抓）馬上按讚：動態的 GET 可能在讚寫進資料庫之前就讀完、卻比讚的回應晚到。測試實際量到：不重來的話，舊的「沒讚」蓋掉剛寫的數字（`[false, false]`），畫面停在錯的狀態直到下一次重抓。平常沒有東西在抓，一個請求都不會多——「在動態上按讚不會重抓動態」那一條照樣成立 |
| 失敗一律「沒有送出，請再試一次」 | **404 寫「這一餐已經看不到了」** | 剛被解除好友、那一餐被關起來：再按幾次都一樣，不該叫人再試 |
| `<span className={styles.wrap}>` 包著按鈕與錯誤訊息 | 不包（Fragment）；`.error` 是 `flex-basis: 100%; order: 1` | 包起來的話錯誤訊息把那一塊撐寬，手機上「留言 N」被擠到下一列。現在錯誤訊息落在「讚」與「留言 N」的下面一整列（截圖 `phone-friend-card-error.png`） |
| `catch` 裡 `wanted.current = null`、`failure = caught ?? new Error("unknown")` | 那一行拿掉；`failure` 包成 `{ caught }` | 下一次按下去第一件事就是蓋掉 `wanted`，沒有任何路徑讀得到留下來的值（拿掉之後「失敗之後還有沒送的意圖不會自己再送」照樣綠）。`{ caught }`：有人 `throw undefined` 時不用另外造一個 Error |
| `FriendMealCard` 的 `?? 0`「離線快取裡的舊餐」 | `?? 0` 留著，註解寫的理由是**後端退版** | 好友的資料不進離線快取（`NOT_PERSISTED`），不會有舊的形狀；會沒有這三個欄位的情況是 `0018` 退版（規格 §3.5 說可以退）之後的回應。測試：「回應裡沒有讚與留言的欄位：畫 0，不是 undefined」 |
| 自己的卡片：合計下面另外一列 | **跟合計同一列**（左邊讚與留言、右邊合計；原始碼裡合計在前，`row-reverse`） | 看截圖：另外一列要 44px 高，卡片底下空一大塊。愛心改成實心（空心的像一顆還沒按的按鈕，而這裡不能按） |
| `.social` 沒有下緣的調整 | 兩種卡片的那一列 `margin-bottom: calc(-1 * var(--space-2))` | 44px 的觸控目標比裡面的字高，不退的話卡片底下比上面空 |
| `like-button.test.tsx` 10 條 | **23 條** | 見下面 |
| 突變表 | 全部紅（「迴圈裡的 `wanted.current = null`」照計畫說的**沒有跑**：現在多了一個 `continue`，拿掉它是同步的無限迴圈） | 共 43 個，42 紅、1 存活（見下面） |

補的測試（`like-button.test.tsx`）：

1. **「回應回來的那一刻，畫面不會閃回按之前的樣子」**——`MutationObserver` 記下按鈕顯示過的每一個樣子。計畫的寫法紅。
2. 「props 不是從那幾份快取來的」（成功之後顯示伺服器的數字，props 自己變了才照 props）、「送出中 props 變了」（清單剛好重抓回來，不把剛按的讚蓋掉）——`Held.over` 的兩個分支；`over` 永遠是 `null`、`same(…)` 拿掉、`latestProps` 不更新，各有一條紅。
3. 連按：「連按兩下收回再按」（另一個方向）、「第二個請求還在路上時又按一下」（三個請求 `PUT`、`DELETE`、`PUT`）、「失敗之後還有沒送的意圖：丟掉」。連按兩下那一條多斷言**中間的回應不寫進快取**、從第二下之後畫面一直是「沒讚、2」。
4. 錯誤：斷線（`fetch` reject）、429 沒有 `Retry-After`（不寫「0 秒」）、404。「失敗之後再按一下」斷言的是**回應回來之前**錯誤就不在了。
5. 「按了就離開畫面：回應回來照樣寫進快取」、「收回送 DELETE」、「樂觀的數字不會變成負的」、已經按過的初始狀態。

`social-api.test.tsx` 多 2 條（`afterLikeChange`）：掛著的動態、某一天不重抓而餐點頁重抓一次；在路上的重抓（掛著的動態、沒有人掛著的某一天）各重來一次、舊的回應不會蓋掉、沒有在抓的那一份不動。`friend-feed` 多 3 條、`friend-day` 多 2 條、`meal-list` 多 3 條（計畫的那幾條，加上「在某一天按讚」）。「在動態上按讚」伺服器回的數字（4）刻意跟樂觀的（1）不一樣——一樣的話看不出回應有沒有寫回動態的快取。

存活的（照實記）：

- `MealList` 的 `const likeCount = meal.like_count ?? 0` 拿掉 `?? 0`：**等價**（`undefined > 0` 也是 `false`，愛心照樣不畫）。留著是讓它跟旁邊的 `commentCount` 同一個寫法；`commentCount` 的那一個拿掉會紅。

**沒有測試守住的事（Task 7～8，已知）**

- 44px 的觸控目標、錯誤訊息落在哪一列、兩種卡片的排版：jsdom 不做版面計算。截圖時量過（讚 49×44、兩種「留言 N」44×44）；Task 11 的 e2e 用 `expectTouchTargets` 釘住。
- 「閃一下」的測試靠的是 jsdom 裡 React 與 TanStack 各自排程的先後（React 先畫）。兩邊的排程方式換了，那一條可能變成怎麼寫都綠——「props 不是從那幾份快取來的」那一條不靠時序，守同一段程式。
- 按讚時動態正在重抓的那個競態只在 `QueryClient` 的層級測（`social-api.test.tsx`），沒有經過畫面。

**給 Task 9～12 的提醒（照實作寫的）**

- **`/meals/:id` 還沒有路由**：兩種卡片上的「留言 N」現在點下去沒有頁面，Task 9 接上。
- `LikeButton` **回傳兩個並排的元素**（按鈕、失敗時的 `<p role="alert">`），沒有包一層。餐點頁放它的地方要嘛是會換行的 flex 列（錯誤訊息自己佔一整列），要嘛是一般的區塊（錯誤訊息是按鈕下面的一段字）。按鈕左邊有 `margin-left: -8px`（愛心對齊文字）。
- 讚成功之後呼叫的是 `afterLikeChange(queryClient, mealId, state)`：它會讓 `socialMeal(mealId)` 失效——餐點頁的名單自己會重抓，Task 9 不用另外處理。`patchLikes` 還是 export 的。
- `LikeButton` 的 props 一定要從快取來（`useSocialMeal` 的 `data.meal`）；不是的話它會一直顯示伺服器回的數字，直到 props 變了。
- `FriendPhoto` 已經 export；`ui.srOnly` 在 `ui.module.css` 檔尾；`queryKeys.friendDays` 是所有好友的所有「某一天」。
- 讚回 404 時卡片還留在動態上（只顯示「這一餐已經看不到了」）。Task 9 的 `forgetFriend` 是自己解除的那一邊；**被**解除的那一邊要等動態下一次重抓。
- **自己的餐點清單上的數字最多舊 60 秒**：`["meals"]` 用 app 預設的 `staleTime`，同一次載入裡換頁不重抓——別人剛按的讚要等到重新整理、或有東西讓 `meals` 失效。視覺檢查就踩到（愛麗絲的卡片停在「留言 0」）。Task 10 可以在未讀數變多時讓 `meals` 失效；Task 11 的 e2e 要看主人卡片上的數字時先重新整理。
- 可及名稱：讚的按鈕是「讚，{名字}的{餐別}」——**同一個好友同一天兩餐同一個餐別時名稱一樣**（規格 D18 的名稱就是這樣），e2e 先用卡片（`getByRole("listitem").filter({ hasText })`）縮小範圍。好友卡片的連結是「{名字}的{餐別}，留言 N 則」，自己卡片的是「{時間} {餐別}，留言 N 則」（時間跟瀏覽器語系走，用 `/留言 \d+ 則$/`）。兩個名稱都**包含**好友的名字與餐別：`getByRole("link", { name: 名字 })` 要 `exact: true`。
- Task 10 的 `useUnreadCount` 掛到 `LoggedInShell` 之後，`tests/app.test.tsx` 那一類整頁的測試會多一個 `/api/notifications/unread-count` 的請求：`mockApi` 沒準備的路徑是 throw（query 變成 error），不會讓測試紅，但「請求清單」逐字比對的斷言會。

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `app/models/social.py`（新）、`app/models/__init__.py` | 1 | `MealLike`、`MealComment`、`Notification`、`NotificationType` |
| `migrations/versions/0018_create_social_tables.py`（新） | 1 | 三張表 |
| `tests/factories.py`、`tests/test_social_model.py`（新） | 1 | `create_like`、`create_comment`；約束與 cascade |
| `app/social_visibility.py`（新） | 2、5 | 可見性、作者過濾、數字、通知的過濾 |
| `app/friend_meals.py`（新） | 2 | `build_friend_meals`（從 `routes/friends.py` 搬來，多三個數字） |
| `app/schemas/social.py`（新）、`app/schemas/friend.py` | 2–5 | 回應與請求的形狀；`FriendMeal` 多三個欄位 |
| `app/api/routes/social.py`（新）、`app/main.py` | 2–4 | `/api/social/meals/...` 五個端點 |
| `app/api/routes/friends.py` | 2、6 | 改用 `build_friend_meals`；邀請與接受寫通知 |
| `app/ratelimit.py`、`tests/conftest.py` | 3、4 | `like_rate_limiter`、`comment_rate_limiter` 與重置 |
| `app/api/routes/meals.py`、`app/schemas/meal.py` | 3 | `MealResponse` 多兩個數字 |
| `app/notifications.py`（新） | 5、6 | 寫通知的三個函式 |
| `app/api/routes/notifications.py`（新） | 5 | `/api/notifications` 三個端點 |
| `tests/social_helpers.py`、`test_social_meal.py`、`test_social_likes.py`、`test_social_likes_concurrency.py`、`test_social_comments.py`、`test_notifications.py`（新）、`tests/test_friend_meals.py`、`tests/test_friend_requests.py` | 2–6 | |
| `frontend/src/api/schema.d.ts` | 2–6 | 每個後端 task 重新產生 |
| `frontend/src/api/{social,notifications}.ts`（新）、`queries.ts`、`persist.ts` | 7 | API 層 |
| `frontend/src/components/LikeButton.tsx`（新）、`FriendMealCard.tsx`、`screens/MealList.tsx`、`ui.module.css` | 8 | |
| `frontend/src/screens/MealDetail.tsx`、`components/{CommentForm,CommentList}.tsx`（新）、`App.tsx` | 9 | |
| `frontend/src/screens/Notifications.tsx`、`components/NotificationsCard.tsx`（新）、`TabBar.tsx`、`SideNav.tsx`、`Me.tsx`、`App.tsx` | 10 | |
| `frontend/e2e/social.spec.ts`（新） | 11 | |
| `docs/handover.md`、`docs/deployment.md`、規格的狀態 | 12 | |

---

## Task 1：後端——migration `0018` 與模型

**Files:**
- Create: `app/models/social.py`、`migrations/versions/0018_create_social_tables.py`、`tests/test_social_model.py`
- Modify: `app/models/__init__.py`、`tests/factories.py`

- [x] **Step 1：模型。** `app/models/social.py`：

```python
"""按讚、留言、通知（社群規格 §3）。三張表都只被社群的模組讀寫；
「誰看得到」不在這裡——在讀取的那一層。"""

import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MealLike(Base):
    """一個人對一餐的讚。唯一約束同時是「這一餐的讚」的索引。

    「主人不能讚自己」不在這裡擋（要跨表）：端點擋，而且計數只算主人現在的好友。"""

    __tablename__ = "meal_likes"
    __table_args__ = (UniqueConstraint("meal_id", "user_id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MealComment(Base):
    __tablename__ = "meal_comments"
    __table_args__ = (
        # 長度在 schema 擋一次、這裡再擋一次：繞過 API 寫進來的也不會超過。
        CheckConstraint("char_length(body) BETWEEN 1 AND 200", name="body_length"),
        Index("ix_meal_comments_meal_id_id", "meal_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class NotificationType(enum.StrEnum):
    LIKE = "like"
    COMMENT = "comment"
    FRIEND_REQUEST = "friend_request"
    FRIEND_ACCEPTED = "friend_accepted"


class Notification(Base):
    """`id` 也是排序的依據：`created_at` 是交易開始的時間，同一個交易裡會相同。"""

    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint("user_id <> actor_id", name="not_self"),
        # 這一條同時是 `type` 的手寫約束（handover §7：create_constraint=False 的另一半）：
        # 四種以外的值三個分支都不成立。
        CheckConstraint(
            "(type = 'like' AND meal_id IS NOT NULL AND comment_id IS NULL)"
            " OR (type = 'comment' AND meal_id IS NOT NULL AND comment_id IS NOT NULL)"
            " OR (type IN ('friend_request', 'friend_accepted')"
            " AND meal_id IS NULL AND comment_id IS NULL)",
            name="shape_matches_type",
        ),
        # 同一個人對同一餐的讚只通知一次（規格 D12）。
        Index(
            "uq_notifications_like",
            "user_id",
            "actor_id",
            "meal_id",
            unique=True,
            postgresql_where=text("type = 'like'"),
        ),
        Index("ix_notifications_user_id_id", "user_id", "id"),
        Index("ix_notifications_unread", "user_id", postgresql_where=text("read_at IS NULL")),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[NotificationType] = mapped_column(
        Enum(
            NotificationType,
            name="notification_type",
            native_enum=False,
            create_constraint=False,
            length=16,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    meal_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=True
    )
    comment_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meal_comments.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

`app/models/__init__.py`：加 `from app.models.social import MealComment, MealLike, Notification, NotificationType`，四個名字照字母順序放進 `__all__`。

- [x] **Step 2：migration。** `migrations/versions/0018_create_social_tables.py`（格式照 `0013`、`0016`）：

```python
"""create social tables

Revision ID: 0018
Revises: 0017
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _id() -> sa.Column:
    return sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False)


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )


def _fk(table: str, column: str, target: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=f"fk_{table}_{column}_{target}", ondelete="CASCADE"
    )


def upgrade() -> None:
    # 只有新表：舊版程式不讀不寫它們，所以這一版可以退版，
    # 不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.create_table(
        "meal_likes",
        _id(),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_meal_likes"),
        sa.UniqueConstraint("meal_id", "user_id", name="uq_meal_likes_meal_id_user_id"),
        _fk("meal_likes", "meal_id", "meals"),
        _fk("meal_likes", "user_id", "users"),
    )
    op.create_table(
        "meal_comments",
        _id(),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_meal_comments"),
        _fk("meal_comments", "meal_id", "meals"),
        _fk("meal_comments", "user_id", "users"),
        # name= 是命名慣例的輸入（同 0013）。
        sa.CheckConstraint("char_length(body) BETWEEN 1 AND 200", name="body_length"),
    )
    op.create_index("ix_meal_comments_meal_id_id", "meal_comments", ["meal_id", "id"])
    op.create_table(
        "notifications",
        _id(),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("actor_id", sa.BigInteger, nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "like",
                "comment",
                "friend_request",
                "friend_accepted",
                name="notification_type",
                native_enum=False,
                create_constraint=False,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column("meal_id", sa.BigInteger, nullable=True),
        sa.Column("comment_id", sa.BigInteger, nullable=True),
        _created_at(),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_notifications"),
        _fk("notifications", "user_id", "users"),
        _fk("notifications", "actor_id", "users"),
        _fk("notifications", "meal_id", "meals"),
        _fk("notifications", "comment_id", "meal_comments"),
        sa.CheckConstraint("user_id <> actor_id", name="not_self"),
        sa.CheckConstraint(
            "(type = 'like' AND meal_id IS NOT NULL AND comment_id IS NULL)"
            " OR (type = 'comment' AND meal_id IS NOT NULL AND comment_id IS NOT NULL)"
            " OR (type IN ('friend_request', 'friend_accepted')"
            " AND meal_id IS NULL AND comment_id IS NULL)",
            name="shape_matches_type",
        ),
    )
    op.create_index(
        "uq_notifications_like",
        "notifications",
        ["user_id", "actor_id", "meal_id"],
        unique=True,
        postgresql_where=sa.text("type = 'like'"),
    )
    op.create_index("ix_notifications_user_id_id", "notifications", ["user_id", "id"])
    op.create_index(
        "ix_notifications_unread",
        "notifications",
        ["user_id"],
        postgresql_where=sa.text("read_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("notifications")
    op.drop_table("meal_comments")
    op.drop_table("meal_likes")
```

- [x] **Step 3：工廠。** `tests/factories.py` 最後加（import `MealComment`、`MealLike`）：

```python
async def create_like(db_session: AsyncSession, *, meal: Meal, user: User) -> MealLike:
    """直接寫一列讚——不經過端點的可見性與「不能讚自己」。"""
    like = MealLike(meal_id=meal.id, user_id=user.id)
    db_session.add(like)
    await db_session.commit()
    await db_session.refresh(like)
    return like


async def create_comment(
    db_session: AsyncSession, *, meal: Meal, user: User, body: str = "看起來好好吃"
) -> MealComment:
    comment = MealComment(meal_id=meal.id, user_id=user.id, body=body)
    db_session.add(comment)
    await db_session.commit()
    await db_session.refresh(comment)
    return comment
```

- [x] **Step 4：測試。** `tests/test_social_model.py`：

```python
"""社群三張表的資料庫保證（社群規格 §3）。這裡全部直接寫資料庫——端點的規則在別的檔案。"""

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.models.meal import Meal
from app.models.social import MealComment, MealLike, Notification, NotificationType
from app.models.user import User
from tests.factories import create_comment, create_like, create_meal, create_user


@pytest.fixture
async def scene(db_session):
    owner = await create_user(db_session, display_name="主人")
    fan = await create_user(db_session, display_name="粉絲")
    meal = await create_meal(db_session, user=owner)
    return owner, fan, meal


async def _refused(db_session, sql: str, **params) -> str:
    """這個 INSERT 被資料庫擋下來 → 回錯誤訊息（裡面有約束的名字）。
    用 savepoint 包住：共用 session 整個 rollback 的話，之後的物件都會過期。"""
    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(text(sql), params)
    return str(caught.value.orig)


async def _counts(db_session) -> tuple[int, int, int]:
    likes, comments, notes = [
        await db_session.scalar(select(func.count()).select_from(model))
        for model in (MealLike, MealComment, Notification)
    ]
    return likes, comments, notes


_LIKE = "INSERT INTO meal_likes (meal_id, user_id) VALUES (:meal, :user)"
_COMMENT = "INSERT INTO meal_comments (meal_id, user_id, body) VALUES (:meal, :user, :body)"
_NOTE = (
    "INSERT INTO notifications (user_id, actor_id, type, meal_id, comment_id)"
    " VALUES (:to, :by, :type, :meal, :comment)"
)


async def test_one_like_per_person_per_meal(db_session, scene):
    owner, fan, meal = scene
    await create_like(db_session, meal=meal, user=fan)
    other_meal = await create_meal(db_session, user=owner)

    error = await _refused(db_session, _LIKE, meal=meal.id, user=fan.id)

    assert "uq_meal_likes_meal_id_user_id" in error
    # 同一個人對另一餐、另一個人對同一餐都可以：擋的是那一對，不是其中一欄。
    await create_like(db_session, meal=other_meal, user=fan)
    await create_like(db_session, meal=meal, user=owner)


@pytest.mark.parametrize(("length", "ok"), [(0, False), (1, True), (200, True), (201, False)])
async def test_the_database_bounds_a_comments_length(db_session, scene, length, ok):
    owner, fan, meal = scene
    params = {"meal": meal.id, "user": fan.id, "body": "字" * length}
    if ok:
        await db_session.execute(text(_COMMENT), params)
    else:
        assert "ck_meal_comments_body_length" in await _refused(db_session, _COMMENT, **params)


async def test_a_notification_cannot_be_to_yourself(db_session, scene):
    owner, _, _ = scene
    error = await _refused(
        db_session, _NOTE, to=owner.id, by=owner.id, type="friend_accepted", meal=None, comment=None
    )
    assert "ck_notifications_not_self" in error


@pytest.mark.parametrize(
    ("kind", "with_meal", "with_comment"),
    [
        ("like", False, False),
        ("like", True, True),
        ("comment", True, False),
        ("comment", False, True),
        ("friend_request", True, False),
        ("friend_accepted", True, True),
        ("poke", False, False),
        ("poke", True, False),
    ],
)
async def test_a_notifications_shape_must_match_its_type(
    db_session, scene, kind, with_meal, with_comment
):
    owner, fan, meal = scene
    comment = await create_comment(db_session, meal=meal, user=fan)
    error = await _refused(
        db_session,
        _NOTE,
        to=owner.id,
        by=fan.id,
        type=kind,
        meal=meal.id if with_meal else None,
        comment=comment.id if with_comment else None,
    )
    assert "ck_notifications_shape_matches_type" in error


async def test_only_one_like_notification_per_actor_and_meal(db_session, scene):
    owner, fan, meal = scene
    first = await create_comment(db_session, meal=meal, user=fan, body="一")
    second = await create_comment(db_session, meal=meal, user=fan, body="二")
    like = {"to": owner.id, "by": fan.id, "type": "like", "meal": meal.id, "comment": None}
    await db_session.execute(text(_NOTE), like)

    assert "uq_notifications_like" in await _refused(db_session, _NOTE, **like)
    # 部分索引只管讚：同一個人在同一餐的兩則留言各有一則通知。
    for comment in (first, second):
        await db_session.execute(text(_NOTE), {**like, "type": "comment", "comment": comment.id})


async def _fill(db_session, owner, fan, meal) -> MealComment:
    await create_like(db_session, meal=meal, user=fan)
    comment = await create_comment(db_session, meal=meal, user=fan)
    db_session.add_all(
        [
            Notification(
                user_id=owner.id, actor_id=fan.id, type=NotificationType.LIKE, meal_id=meal.id
            ),
            Notification(
                user_id=owner.id,
                actor_id=fan.id,
                type=NotificationType.COMMENT,
                meal_id=meal.id,
                comment_id=comment.id,
            ),
        ]
    )
    await db_session.commit()
    return comment


async def test_deleting_a_meal_takes_everything_on_it_and_nothing_else(db_session, scene):
    owner, fan, meal = scene
    await _fill(db_session, owner, fan, meal)
    kept = await create_meal(db_session, user=owner)
    await _fill(db_session, owner, fan, kept)
    assert await _counts(db_session) == (2, 2, 4)

    await db_session.execute(delete(Meal).where(Meal.id == meal.id))
    await db_session.commit()

    # 另一餐的那一份還在：刪的是「這一餐的」，不是整張表（規矩 3）。
    assert await _counts(db_session) == (1, 1, 2)


async def test_deleting_a_comment_takes_only_its_notification(db_session, scene):
    owner, fan, meal = scene
    comment = await _fill(db_session, owner, fan, meal)

    await db_session.execute(delete(MealComment).where(MealComment.id == comment.id))
    await db_session.commit()

    assert await _counts(db_session) == (1, 0, 1)  # 讚與讚的通知還在


async def test_deleting_a_user_takes_what_they_did(db_session, scene):
    """現在沒有刪帳號的路（規格 §3.5）——這條守的是哪天有了，不會被 FK 擋成 500。"""
    owner, fan, meal = scene
    await _fill(db_session, owner, fan, meal)
    bystander = await create_user(db_session)
    await create_like(db_session, meal=meal, user=bystander)

    await db_session.execute(delete(User).where(User.id == fan.id))
    await db_session.commit()

    assert await _counts(db_session) == (1, 0, 0)
```

- [x] **Step 5：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_model.py
```

Expected：**18 passed**（1＋4＋1＋8＋1＋3；對的形狀由後面的 task 經過端點寫進去，這裡不重複；`conftest.py` 的 `alembic upgrade head`＋`alembic check` 在這一步就會跑——`check` 報漂移就是模型與 migration 對不上，先修那個）。

- [x] **Step 6：突變（每一個改完跑 Step 5，看到指定的紅，再改回）。** migration 與模型要**一起**改（只改一邊紅的是 `alembic check`，那是另一道防線——規矩 8）。

| 突變（模型＋migration 兩邊） | 該紅的 |
|---|---|
| 拿掉 `meal_likes` 的唯一約束 | `test_one_like_per_person_per_meal` |
| `BETWEEN 1 AND 200` → `BETWEEN 0 AND 200`；→ `BETWEEN 1 AND 201` | `…bounds_a_comments_length[0-False]`；`[201-False]` |
| 拿掉 `not_self` | `test_a_notification_cannot_be_to_yourself` |
| `shape` 的 `like` 分支拿掉 `AND comment_id IS NULL` | `…shape…[like-True-True]` |
| `uq_notifications_like` 拿掉 `unique=True`；拿掉 `postgresql_where` | `test_only_one_like_notification…` 的前半；後半 |
| `notifications.comment_id` 的 `ondelete` 改成 `SET NULL` | `test_deleting_a_comment…`（而且是 `shape` 的 CHECK 把它擋成 IntegrityError——照實記下紅的樣子） |
| 只改模型不改 migration（任一個索引改名） | 整個 session 在 `alembic check` 就停 |

- [x] **Step 7：整套＋靜態檢查＋commit。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
```

Expected：`1227 + 新的條數 passed`；ruff、mypy 乾淨。這個 task 沒有動 `routes`／`schemas`，不用重新產生 `schema.d.ts`。

```bash
git add app/models/social.py app/models/__init__.py migrations/versions/0018_create_social_tables.py tests/factories.py tests/test_social_model.py
git commit -F "$S/social-plan-task1-msg.txt"   # feat(backend): 讚、留言、通知的三張表（migration 0018）
```

---

## Task 2：後端——可見性模組、`FriendMeal` 的組法搬家、單一餐點的讀取

**Files:**
- Create: `app/social_visibility.py`、`app/friend_meals.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`tests/social_helpers.py`、`tests/test_social_meal.py`
- Modify: `app/schemas/friend.py`、`app/api/routes/friends.py`、`app/main.py`、`tests/test_friend_meals.py`、`frontend/src/api/schema.d.ts`

- [x] **Step 1：`app/social_visibility.py`**（整份；寫計畫時對真的資料庫跑過）：

```python
"""讚、留言、通知的可見性（社群規格 §4）。

**兩件事都在這裡，而且只在這裡：**

1. 看不看得到一餐（`load_visible_meal`）：主人，或主人現在的好友而且不是「只有我看得到」。
2. 一則讚或留言還算不算數（`like_counts`／`author_counts`）：作者是主人，或作者**現在**
   是主人的好友。解除好友不刪資料——讀的時候過濾，重新加好友就回來（規格 D4）。

`app/friend_visibility.py` 管「好友的餐點清單」；這裡管「一餐上面的東西」。兩個模組與
`routes/friends.py` 是後端唯三碰 `Friendship` 的地方（`tests/test_friend_meals.py` 的掃描測試）。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal
from app.models.social import MealComment, MealLike
from app.models.user import User


def _pair(one: Any, other: Any) -> tuple[ColumnElement[bool], ColumnElement[bool]]:
    """`friendships` 的那一列（`user_a < user_b`）。`one`／`other` 可以是欄位也可以是整數；
    `least`／`greatest` 讓它對得上 `uq_friendships_user_a_user_b`，不用 OR 兩個方向。"""
    return (
        Friendship.user_a == func.least(one, other),
        Friendship.user_b == func.greatest(one, other),
    )


def _are_friends(one: Any, other: Any) -> ColumnElement[bool]:
    return exists().where(Friendship.status == FriendshipStatus.ACCEPTED, *_pair(one, other))


def meal_visible_to(viewer_id: int) -> ColumnElement[bool]:
    return or_(
        Meal.user_id == viewer_id,
        and_(Meal.is_private.is_(False), _are_friends(Meal.user_id, viewer_id)),
    )


async def load_visible_meal(
    db: AsyncSession, viewer: User, meal_id: int, *, lock: bool = False
) -> Meal:
    """看得到 → 那一餐；否則 404，跟 `/api/meals/{id}` 的「不存在」逐字相同（handover §4.7）。
    條件全部在一個查詢的 WHERE 裡：不存在、不是好友、私人走同一條路。

    `lock=True`（要寫讚或留言時）：`FOR SHARE OF meals` 鎖到交易結束——跟「改成只有我
    看得到」的 PATCH（`FOR UPDATE`）互斥，不會有一則讚落在已經關起來的餐上。"""
    query = select(Meal).where(Meal.id == meal_id, meal_visible_to(viewer.id))
    if lock:
        query = query.with_for_update(read=True, of=Meal)
    meal: Meal | None = await db.scalar(query)
    if meal is None:
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    return meal


def like_counts(liker: Any, owner: Any) -> ColumnElement[bool]:
    """這個讚算不算：按的人現在是主人的好友。主人自己的不算（本來就不該有那一列）。"""
    return _are_friends(liker, owner)


def author_counts(author: Any, owner: Any) -> ColumnElement[bool]:
    """這則留言顯不顯示：作者是主人，或作者現在是主人的好友。"""
    return or_(author == owner, _are_friends(author, owner))


@dataclass(frozen=True)
class SocialCounts:
    like_count: int = 0
    comment_count: int = 0
    liked_by_me: bool = False


async def social_counts(
    db: AsyncSession, viewer_id: int, meal_ids: Sequence[int]
) -> dict[int, SocialCounts]:
    """這幾餐各有幾個讚、幾則留言、我按了沒。**兩次查詢，跟餐數無關。**

    **不檢查 viewer 看不看得到這幾餐**——呼叫端傳進來的 id 必須是已經過了自己那一關的
    （自己的餐、`shared_meals`、`load_visible_meal`）。每一個傳進來的 id 都有一筆結果。"""
    if not meal_ids:
        return {}
    likes = (
        await db.execute(
            select(MealLike.meal_id, func.count(), func.bool_or(MealLike.user_id == viewer_id))
            .join(Meal, Meal.id == MealLike.meal_id)
            .where(MealLike.meal_id.in_(meal_ids), like_counts(MealLike.user_id, Meal.user_id))
            .group_by(MealLike.meal_id)
        )
    ).all()
    comments = (
        await db.execute(
            select(MealComment.meal_id, func.count())
            .join(Meal, Meal.id == MealComment.meal_id)
            .where(
                MealComment.meal_id.in_(meal_ids),
                author_counts(MealComment.user_id, Meal.user_id),
            )
            .group_by(MealComment.meal_id)
        )
    ).all()
    liked = {meal_id: (count, bool(mine)) for meal_id, count, mine in likes}
    commented = {meal_id: count for meal_id, count in comments}
    return {
        meal_id: SocialCounts(
            like_count=liked.get(meal_id, (0, False))[0],
            comment_count=commented.get(meal_id, 0),
            liked_by_me=liked.get(meal_id, (0, False))[1],
        )
        for meal_id in meal_ids
    }
```

- [x] **Step 2：`FriendMeal` 多三個欄位、組法搬家。**

`app/schemas/friend.py` 的 `FriendMeal` 最後加（**沒有預設值**——漏帶是當場的驗證錯誤，同 `MealResponse.description` 的註解）：

```python
    # 社群規格 §5.6：過濾後的數字——只算主人現在的好友（留言另外算主人自己的）。
    like_count: int
    comment_count: int
    liked_by_me: bool
```

`app/friend_meals.py`（新）：把 `routes/friends.py` 的 `_friend_meals` **整個搬過來**，改名、多一個參數、多三個欄位；其餘一個字不動：

```python
"""組 `FriendMeal`——好友動態、好友的某一天、單一餐點（社群規格 D7）共用的白名單序列化。"""

# import：defaultdict、Sequence、AsyncSession、item_join_query、Food、FoodRevision、Meal、MealItem、
# User、Macros、scale、total、FriendMeal、FriendMealItem、PersonResponse、social_counts


async def build_friend_meals(
    db: AsyncSession, viewer_id: int, meals: Sequence[Meal], people: dict[int, User]
) -> list[FriendMeal]:
    """（原本的 docstring）＋ 數字再兩次查詢（`social_counts`），一樣跟餐數無關。
    **呼叫端要自己確認 viewer 看得到這幾餐。**"""
    if not meals:
        return []
    counts = await social_counts(db, viewer_id, [meal.id for meal in meals])
    # … 原本的項目查詢與迴圈 …
            FriendMeal(
                # … 原本的欄位；user=PersonResponse(id=…, display_name=…) …
                like_count=counts[meal.id].like_count,
                comment_count=counts[meal.id].comment_count,
                liked_by_me=counts[meal.id].liked_by_me,
            )
```

`app/api/routes/friends.py`：刪掉 `_friend_meals`，兩個呼叫點改成 `await build_friend_meals(db, user.id, page, people)`、`await build_friend_meals(db, user.id, meals, {friend.id: friend})`；清掉用不到的 import（`defaultdict`、`item_join_query`、`Food`、`FoodRevision`、`MealItem`、`Macros`、`scale`、`total`、`FriendMeal`、`FriendMealItem`——ruff 會指出來）。

- [x] **Step 3：`app/schemas/social.py`**（這個 task 只用到讀取的三個；其餘 Task 3、4 才加）：

```python
"""讚與留言的回應（社群規格 §5）。**沒有 email、沒有作者的 user id**（D9）：
「是不是我」「能不能刪」由伺服器算好。"""

from datetime import datetime

from pydantic import BaseModel

from app.schemas.friend import FriendMeal


class LikerResponse(BaseModel):
    display_name: str
    is_me: bool


class CommentResponse(BaseModel):
    id: int
    display_name: str
    is_me: bool
    # 我是作者，或我是這一餐的主人。
    can_delete: bool
    body: str
    created_at: datetime


class SocialMealResponse(BaseModel):
    """一餐與它上面的讚、留言。`meal` 是好友看的那個白名單——主人看自己的餐也是
    （沒有餐費與備註；要看那些去編輯畫面）。"""

    meal: FriendMeal
    is_mine: bool
    likes: list[LikerResponse]
    comments: list[CommentResponse]
    comments_truncated: bool
```

- [x] **Step 4：`app/api/routes/social.py`**，並在 `app/main.py` 註冊（`app.include_router(social.router, prefix="/api")`，放在 `friends` 後面；`app/api/routes/__init__.py` 如果有列名字就照加）：

```python
"""一餐上面的讚與留言（社群規格 §5）。

**每個端點的第一件事都是 `load_visible_meal`**——看不到與不存在是同一個 404。
這裡不直接碰好友關係的表：規則都在可見性模組。"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.db import get_db
from app.errors import NotFoundError
from app.friend_meals import build_friend_meals
from app.models.social import MealComment, MealLike
from app.models.user import User
from app.schemas.social import CommentResponse, LikerResponse, SocialMealResponse
from app.social_visibility import author_counts, like_counts, load_visible_meal

router = APIRouter(prefix="/social", tags=["social"])

# 一次最多回幾則留言（規格 D10）：最近的這麼多則，由舊到新。
COMMENTS_SHOWN = 100


def _comment_response(
    comment: MealComment, display_name: str, *, viewer_id: int, owner_id: int
) -> CommentResponse:
    is_me = comment.user_id == viewer_id
    return CommentResponse(
        id=comment.id,
        display_name=display_name,
        is_me=is_me,
        can_delete=is_me or owner_id == viewer_id,
        body=comment.body,
        created_at=comment.created_at,
    )


@router.get("/meals/{meal_id}", response_model=SocialMealResponse)
async def read_social_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SocialMealResponse:
    """一餐、誰按了讚、最近的留言。自己的餐與看得到的好友的餐都走這裡。"""
    meal = await load_visible_meal(db, user, meal_id)
    owner = user if meal.user_id == user.id else await db.get(User, meal.user_id)
    if owner is None:
        # 主人的帳號剛好被刪：餐也跟著 cascade 了。
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    [card] = await build_friend_meals(db, user.id, [meal], {owner.id: owner})

    likers = (
        await db.execute(
            select(User.display_name, MealLike.user_id)
            .join(User, User.id == MealLike.user_id)
            .where(MealLike.meal_id == meal.id, like_counts(MealLike.user_id, meal.user_id))
            .order_by(MealLike.id)
        )
    ).all()
    # 多拿一則：知道有沒有被截掉，不用另外數（數字在 card.comment_count）。
    rows = (
        await db.execute(
            select(MealComment, User.display_name)
            .join(User, User.id == MealComment.user_id)
            .where(MealComment.meal_id == meal.id, author_counts(MealComment.user_id, meal.user_id))
            .order_by(MealComment.id.desc())
            .limit(COMMENTS_SHOWN + 1)
        )
    ).all()
    shown = rows[:COMMENTS_SHOWN][::-1]
    return SocialMealResponse(
        meal=card,
        is_mine=meal.user_id == user.id,
        likes=[
            LikerResponse(display_name=name, is_me=liker_id == user.id) for name, liker_id in likers
        ],
        comments=[
            _comment_response(comment, name, viewer_id=user.id, owner_id=meal.user_id)
            for comment, name in shown
        ],
        comments_truncated=len(rows) > COMMENTS_SHOWN,
    )
```

- [x] **Step 5：掃描測試。** `tests/test_friend_meals.py`：

1. `test_only_the_friend_modules_touch_the_friendship_table` 的 `friend_modules` 加一行 `root / "social_visibility.py",`（docstring 補一句「社群的可見性模組是第三個」）。
2. 白名單那條（`test_a_friends_shared_meal_shows_in_the_feed_with_only_the_whitelisted_fields`）的 `set(shared) == {…}` 加 `"like_count", "comment_count", "liked_by_me"`——**刻意的改變**，並加一行 `assert (shared["like_count"], shared["comment_count"], shared["liked_by_me"]) == (0, 0, False)`。
3. 檔尾新增：

```python
def test_only_the_social_modules_widen_who_can_read_a_meal():
    """社群規格 D6：「看得到別人的一餐」只有社群的模組做得到。`/api/meals` 仍然只回自己的——
    它從可見性模組只准拿「這幾餐各有幾個讚」（`social_counts` 不放寬任何讀取）。

    掃的是文字：這幾個名字連註解都不准出現在別的模組。"""
    root = Path(__file__).resolve().parent.parent / "app"
    routes = root / "api" / "routes"
    social_modules = {
        root / "social_visibility.py",
        root / "friend_meals.py",
        routes / "friends.py",
        routes / "social.py",
        routes / "notifications.py",
    }
    words = re.compile(
        r"\bsocial_visibility\b|\bload_visible_meal\b|\bmeal_visible_to\b"
        r"|\bbuild_friend_meals\b|\bfriend_meals\b|\blike_counts\b|\bauthor_counts\b"
    )
    allowed_in_meals = "from app.social_visibility import SocialCounts, social_counts\n"
    offenders = []
    for path in root.rglob("*.py"):
        if path in social_modules:
            continue
        source = path.read_text(encoding="utf-8")
        if path == routes / "meals.py":
            source = source.replace(allowed_in_meals, "", 1)
        if words.search(source):
            offenders.append(str(path.relative_to(root)))
    assert offenders == []
```

- [x] **Step 6：`tests/social_helpers.py` 與 `tests/test_social_meal.py`。** 這一組人之後四個測試檔都要用，所以放在一個普通的模組裡（不是 `conftest.py`：只有社群的測試需要）。

`tests/social_helpers.py`：

```python
"""社群測試共用的一組人與小工具。"""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import delete

from app.models.food import FoodRevision
from app.models.friendship import Friendship, FriendshipStatus
from app.security.tokens import create_access_token
from tests.factories import (
    create_expense,
    create_food,
    create_friendship,
    create_meal,
    create_user,
)

MISSING = 2**62  # 一定不存在的 id


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def make_cast(db_session) -> SimpleNamespace:
    """愛麗絲是主人。鮑伯與小卡是她的好友、**彼此不是**；阿丁的邀請還在等；伊芙是陌生人。
    那一餐真的有餐費、備註、私人食物——「沒有外流」才不是空轉。
    餐費刻意是 4321.75：短的數字（180）會剛好出現在 id 或熱量裡。"""
    alice, bob, carol, dan, eve = [
        await create_user(db_session, display_name=name)
        for name in ("愛麗絲", "鮑伯", "小卡", "阿丁", "伊芙")
    ]
    await create_friendship(db_session, alice, bob)
    await create_friendship(db_session, carol, alice)
    await create_friendship(db_session, dan, alice, status=FriendshipStatus.PENDING)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的私房菜")
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    meal = await create_meal(
        db_session,
        user=alice,
        eaten_at=datetime.fromisoformat("2026-10-06T04:00:00+00:00"),
        items=[(revision, 150)],
        note="今天心情很差",
        description="滷肉飯配燙青菜",
    )
    await create_expense(db_session, user=alice, amount=Decimal("4321.75"), meal=meal)
    return SimpleNamespace(
        alice=alice, bob=bob, carol=carol, dan=dan, eve=eve, meal=meal, food=food, revision=revision
    )


async def unfriend(db_session, one, other) -> None:
    user_a, user_b = sorted((one.id, other.id))
    deleted = await db_session.scalar(
        delete(Friendship)
        .where(Friendship.user_a == user_a, Friendship.user_b == user_b)
        .returning(Friendship.id)
    )
    assert deleted is not None  # 真的有東西可以解除
    await db_session.commit()
```

`tests/test_social_meal.py`：

```python
"""`GET /api/social/meals/{id}`：誰看得到一餐、看到什麼（社群規格 §4.1、§4.2、§5.1）。"""

from datetime import datetime

import pytest
from sqlalchemy import event

from tests.factories import create_comment, create_friendship, create_like, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


async def _read(client, viewer, meal_id):
    return await client.get(f"/api/social/meals/{meal_id}", headers=auth(viewer))


# ---------- §4.1：看不看得到 ----------


@pytest.mark.parametrize(
    ("who", "public", "private"),
    [
        ("alice", 200, 200),
        ("bob", 200, 404),
        ("carol", 200, 404),
        ("dan", 404, 404),
        ("eve", 404, 404),
    ],
)
async def test_who_can_open_a_meal(client, db_session, cast, who, public, private):
    viewer = getattr(cast, who)

    assert (await _read(client, viewer, cast.meal.id)).status_code == public

    cast.meal.is_private = True
    await db_session.commit()
    assert (await _read(client, viewer, cast.meal.id)).status_code == private


async def test_cannot_see_and_does_not_exist_are_the_same_response(client, cast):
    hidden = await _read(client, cast.eve, cast.meal.id)
    missing = await _read(client, cast.eve, MISSING)
    own_endpoint = await client.get(f"/api/meals/{MISSING}", headers=auth(cast.eve))

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content == own_endpoint.content


async def test_it_needs_a_login(client, cast):
    assert (await client.get(f"/api/social/meals/{cast.meal.id}")).status_code == 401


async def test_unfriending_closes_the_door(client, db_session, cast):
    assert (await _read(client, cast.bob, cast.meal.id)).status_code == 200
    await unfriend(db_session, cast.alice, cast.bob)
    assert (await _read(client, cast.bob, cast.meal.id)).status_code == 404
    # 小卡不受影響：關的是鮑伯那一扇，不是整個端點。
    assert (await _read(client, cast.carol, cast.meal.id)).status_code == 200


# ---------- 看到什麼 ----------


async def test_a_friend_sees_the_whitelisted_meal_and_nothing_private(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="好香")

    response = await _read(client, cast.bob, cast.meal.id)

    body = response.json()
    assert set(body) == {"meal", "is_mine", "likes", "comments", "comments_truncated"}
    assert body["is_mine"] is False
    assert body["meal"]["user"] == {"id": cast.alice.id, "display_name": "愛麗絲"}
    assert body["meal"]["description"] == "滷肉飯配燙青菜"
    assert [item["food_name"] for item in body["meal"]["items"]] == ["愛麗絲的私房菜"]
    assert body["likes"] == [{"display_name": "小卡", "is_me": False}]
    assert set(body["comments"][0]) == {
        "id", "display_name", "is_me", "can_delete", "body", "created_at",
    }
    # 描述在（上面斷言過），備註、餐費、email、食物 id 不在——同一個回應裡兩種都有才算數。
    secrets = ("今天心情很差", "4321.75", "food_id", "note", "cost", "photo_path", "@example.com")
    for secret in secrets:
        assert secret not in response.text


async def test_the_owner_gets_the_same_whitelist(client, cast):
    response = await _read(client, cast.alice, cast.meal.id)

    assert response.json()["is_mine"] is True
    assert "今天心情很差" not in response.text and "4321.75" not in response.text


async def test_mutual_friends_of_the_owner_see_each_other(client, db_session, cast):
    """規格 D3：鮑伯與小卡不是好友，但在愛麗絲的餐上看得到彼此。"""
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="好香")
    await create_comment(db_session, meal=cast.meal, user=cast.alice, body="謝謝")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我也要")

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    rows = [(c["display_name"], c["body"], c["is_me"], c["can_delete"]) for c in body["comments"]]
    assert rows == [
        ("小卡", "好香", False, False),
        ("愛麗絲", "謝謝", False, False),
        ("鮑伯", "我也要", True, True),
    ]
    assert (body["meal"]["like_count"], body["meal"]["comment_count"]) == (1, 3)
    assert body["meal"]["liked_by_me"] is False


async def test_the_owner_can_delete_every_comment(client, db_session, cast):
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.alice)

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    rows = [(c["is_me"], c["can_delete"]) for c in body["comments"]]
    assert rows == [(False, True), (True, True)]


# ---------- §4.2：解除之後 ----------


async def test_an_unfriended_persons_likes_and_comments_vanish_for_everyone_then_return(
    client, db_session, cast
):
    """過濾看的是「作者與主人」的關係：看的人是小卡（她一直看得到這一餐），被解除的是鮑伯。"""
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯說")
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="小卡說")

    async def seen():
        body = (await _read(client, cast.carol, cast.meal.id)).json()
        return (
            [like["display_name"] for like in body["likes"]],
            [c["body"] for c in body["comments"]],
            body["meal"]["like_count"],
            body["meal"]["comment_count"],
        )

    assert await seen() == (["鮑伯", "小卡"], ["鮑伯說", "小卡說"], 2, 2)

    await unfriend(db_session, cast.alice, cast.bob)
    assert await seen() == (["小卡"], ["小卡說"], 1, 1)
    # 主人看到的也一樣。
    owner_view = (await _read(client, cast.alice, cast.meal.id)).json()
    assert owner_view["meal"]["like_count"] == 1 and len(owner_view["comments"]) == 1

    await create_friendship(db_session, cast.alice, cast.bob)
    assert await seen() == (["鮑伯", "小卡"], ["鮑伯說", "小卡說"], 2, 2)


async def test_a_pending_request_does_not_count_as_a_friend(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.dan)
    await create_comment(db_session, meal=cast.meal, user=cast.dan)

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    assert (body["likes"], body["comments"], body["meal"]["like_count"]) == ([], [], 0)


async def test_a_self_like_row_never_counts(client, db_session, cast):
    """端點會擋（Task 3）；這條守的是就算有那樣一列，數字也不算它。"""
    await create_like(db_session, meal=cast.meal, user=cast.alice)

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    meal = body["meal"]
    assert (body["likes"], meal["like_count"], meal["liked_by_me"]) == ([], 0, False)


async def test_going_private_keeps_what_was_written_for_the_owner(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="留著")
    cast.meal.is_private = True
    await db_session.commit()

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    assert [c["body"] for c in body["comments"]] == ["留著"]
    assert body["meal"]["like_count"] == 1


# ---------- 上限、liked_by_me、卡片上的數字 ----------


async def test_only_the_latest_hundred_comments_oldest_first(client, db_session, cast):
    for index in range(101):
        await create_comment(db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則")

    body = (await _read(client, cast.carol, cast.meal.id)).json()

    assert body["comments_truncated"] is True
    assert [c["body"] for c in body["comments"]] == [f"第{index}則" for index in range(1, 101)]
    assert body["meal"]["comment_count"] == 101  # 數字是全部，不是顯示出來的


async def test_exactly_a_hundred_is_not_truncated(client, db_session, cast):
    for index in range(100):
        await create_comment(db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則")

    body = (await _read(client, cast.carol, cast.meal.id)).json()

    assert body["comments_truncated"] is False and len(body["comments"]) == 100


async def test_the_feed_and_the_day_carry_the_same_numbers(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.eve)  # 陌生人的列：不算
    await create_comment(db_session, meal=cast.meal, user=cast.carol)

    feed = (await client.get("/api/friends/feed", headers=auth(cast.bob))).json()
    day = (
        await client.get(
            f"/api/friends/{cast.alice.id}/meals?date=2026-10-06", headers=auth(cast.bob)
        )
    ).json()
    as_carol = (await client.get("/api/friends/feed", headers=auth(cast.carol))).json()

    def numbers(meal):
        return (meal["like_count"], meal["comment_count"], meal["liked_by_me"])

    assert numbers(feed["meals"][0]) == numbers(day["meals"][0]) == (1, 1, True)
    assert numbers(as_carol["meals"][0]) == (1, 1, False)


async def test_the_feed_does_not_query_per_meal(client, db_session, db_connection, cast):
    """1 餐與 6 餐的 SELECT 次數一樣（每一餐都有讚與留言——沒有的話少查也看不出來）。"""
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    async def selects() -> int:
        seen.clear()
        event.listen(db_connection.sync_connection, "before_cursor_execute", record)
        try:
            response = await client.get("/api/friends/feed", headers=auth(cast.bob))
        finally:
            event.remove(db_connection.sync_connection, "before_cursor_execute", record)
        assert response.status_code == 200
        return len(seen)

    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    one = await selects()
    for hour in range(5):
        meal = await create_meal(
            db_session,
            user=cast.alice,
            eaten_at=datetime.fromisoformat(f"2026-10-07T0{hour}:00:00+00:00"),
            items=[(cast.revision, 100)],
        )
        await create_like(db_session, meal=meal, user=cast.carol)
        await create_comment(db_session, meal=meal, user=cast.carol)

    assert await selects() == one
```

- [x] **Step 7：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_meal.py tests/test_friend_meals.py tests/test_friend_requests.py
```

Expected：全部 PASS（`test_social_meal.py` 是 **20** 條：8＋4＋4＋4）。`test_friend_meals.py` 既有的條數不變、多 1 條掃描。

- [x] **Step 8：突變。** `social_visibility.py`、`friend_meals.py`、`routes/social.py` 都是新檔案——先各 `cp` 一份到 `$S`。

| 突變 | 該紅的 |
|---|---|
| `meal_visible_to` 拿掉 `Meal.is_private.is_(False)` | `test_who_can_open_a_meal[bob…]`、`[carol…]` |
| `_are_friends` 拿掉 `status == ACCEPTED` | `test_who_can_open_a_meal[dan…]`、`test_a_pending_request_does_not_count…` |
| `meal_visible_to` 整個換成 `true()` | `[dan]`、`[eve]`、`…same_response`、`test_unfriending_closes_the_door` |
| `_pair` 的 `least`／`greatest` 對調 | 幾乎全部（好友都看不到了）——確認紅的是 200 那一半 |
| `like_counts` 改成 `author_counts`（主人的讚也算） | `test_a_self_like_row_never_counts` |
| `author_counts` 拿掉 `author == owner` | `test_mutual_friends…`、`test_the_owner_can_delete_every_comment` |
| `social_counts` 兩個查詢各拿掉過濾（`like_counts(...)`／`author_counts(...)` 那一個條件） | `…vanish_for_everyone…`、`…feed_and_the_day…`（陌生人的讚被算進去） |
| `read_social_meal` 的名單查詢拿掉 `like_counts(...)`；留言查詢拿掉 `author_counts(...)` | `…vanish_for_everyone…`、`test_a_pending_request…` |
| `.order_by(MealComment.id.desc())` 改成 `.asc()` | `test_only_the_latest_hundred…`（回的是最舊的 100 則） |
| `COMMENTS_SHOWN + 1` 改成 `COMMENTS_SHOWN` | `test_only_the_latest_hundred…`（`truncated` 是 False） |
| `> COMMENTS_SHOWN` 改成 `>=` | `test_exactly_a_hundred_is_not_truncated` |
| `can_delete=is_me or …` 改成 `can_delete=is_me` | `test_the_owner_can_delete_every_comment` |
| `build_friend_meals` 的 `social_counts` 搬進迴圈（每餐查一次） | `test_the_feed_does_not_query_per_meal` |
| `social.py` 加一行註解提到 `Friendship`；`routes/meals.py` 加 `from app.social_visibility import load_visible_meal` | 兩條掃描測試各一條 |

- [x] **Step 9：`schema.d.ts`、整套、commit。** 重新產生 `schema.d.ts`（多一條路徑、四個 schema、`FriendMeal` 多三個欄位）→ `cd frontend && npm run -s typecheck && npm run -s test`（Expected：都綠——`FriendMeal` 的測試資料沒有型別標註，不會紅）。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/social_visibility.py app/friend_meals.py app/schemas/social.py app/schemas/friend.py app/api/routes/social.py app/api/routes/friends.py app/main.py tests/social_helpers.py tests/test_social_meal.py tests/test_friend_meals.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task2-msg.txt"   # feat(backend): 單一餐點的讀取——主人與好友同一個白名單、解除好友用讀取時過濾
```

---

## Task 3：後端——讚的端點、自己的餐點清單上的數字

**Files:**
- Create: `tests/test_social_likes.py`、`tests/test_social_likes_concurrency.py`
- Modify: `app/ratelimit.py`、`tests/conftest.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`app/schemas/meal.py`、`app/api/routes/meals.py`、`frontend/src/api/schema.d.ts`、`frontend/tests/timeline.test.ts`

- [x] **Step 1：限速器。** `app/ratelimit.py` 檔尾（兩個一起加，Task 4 用第二個）：

```python
LIKE_LIMIT = 60
COMMENT_LIMIT = 20
SOCIAL_WINDOW_SECONDS = 60.0

# 按讚與收回**共用**（社群規格 D20），鍵是使用者 id（`str(user.id)`）。分開算的話額度實際上
# 是兩倍。60：連按、反悔、一口氣滑過一頁動態都在額度內——擋的是寫壞的迴圈與拿 id 亂試的人
# （限速在可見性檢查之前）。
like_rate_limiter = KeyedRateLimiter(
    limit=LIKE_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_LIKES",
    message="按得太快了，請稍後再試",
)

# 留言：每一則都會通知餐的主人，所以比讚緊。刪留言不算。
comment_rate_limiter = KeyedRateLimiter(
    limit=COMMENT_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_COMMENTS",
    message="留言太頻繁，請稍後再試",
)
```

`tests/conftest.py`：import 這兩個，`_reset_login_rate_limiter` 裡加 `like_rate_limiter.reset()`、`comment_rate_limiter.reset()`（docstring 補一句）。

- [x] **Step 2：測試（先寫，看它紅）。** `tests/test_social_likes.py`：

```python
"""`PUT`／`DELETE /api/social/meals/{id}/like`（社群規格 §5.2）與卡片上的數字（§5.6）。"""

import pytest
from sqlalchemy import select

from app.models.social import MealLike
from app.ratelimit import LIKE_LIMIT
from tests.factories import create_comment, create_friendship, create_like
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


def _url(meal_id) -> str:
    return f"/api/social/meals/{meal_id}/like"


async def _likers(db_session, meal) -> list[int]:
    rows = await db_session.scalars(
        select(MealLike.user_id).where(MealLike.meal_id == meal.id).order_by(MealLike.id)
    )
    return list(rows)


async def test_like_then_take_it_back(client, db_session, cast):
    first = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    second = await client.put(_url(cast.meal.id), headers=auth(cast.carol))

    assert first.status_code == 200
    assert first.json() == {"like_count": 1, "liked_by_me": True}
    assert second.json() == {"like_count": 2, "liked_by_me": True}

    gone = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))

    assert gone.status_code == 200
    assert gone.json() == {"like_count": 1, "liked_by_me": False}
    # 刪的是「我的」那一列，不是這一餐全部的讚。
    assert await _likers(db_session, cast.meal) == [cast.carol.id]


async def test_both_directions_are_idempotent(client, db_session, cast):
    for _ in range(2):
        liked = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
        assert (liked.status_code, liked.json()["like_count"]) == (200, 1)
    assert await _likers(db_session, cast.meal) == [cast.bob.id]

    for _ in range(2):
        gone = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))
        assert (gone.status_code, gone.json()) == (200, {"like_count": 0, "liked_by_me": False})
    never = await client.delete(_url(cast.meal.id), headers=auth(cast.carol))
    assert never.status_code == 200


async def test_the_owner_cannot_like_their_own_meal(client, db_session, cast):
    response = await client.put(_url(cast.meal.id), headers=auth(cast.alice))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CANNOT_LIKE_OWN_MEAL"
    assert await _likers(db_session, cast.meal) == []
    # 收回沒有東西可以收，照樣是 200（冪等）。
    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.alice))).status_code == 200


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_touch_its_likes(
    client, db_session, cast, method, who
):
    viewer = getattr(cast, who)
    await create_like(db_session, meal=cast.meal, user=viewer)  # DELETE 有東西可以刪才算數

    hidden = await client.request(method, _url(cast.meal.id), headers=auth(viewer))
    missing = await client.request(method, _url(MISSING), headers=auth(viewer))

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _likers(db_session, cast.meal) == [viewer.id]  # 沒有多一列、也沒有被刪


async def test_a_meal_gone_private_can_be_neither_liked_nor_unliked(client, db_session, cast):
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 200
    cast.meal.is_private = True
    await db_session.commit()

    assert (await client.put(_url(cast.meal.id), headers=auth(cast.carol))).status_code == 404
    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 404
    assert await _likers(db_session, cast.meal) == [cast.bob.id]


async def test_after_unfriending_the_like_stays_hidden_until_they_are_friends_again(
    client, db_session, cast
):
    await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    await unfriend(db_session, cast.alice, cast.bob)

    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 404
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 404
    # 小卡按讚拿到的數字不含鮑伯那一個。
    as_carol = await client.put(_url(cast.meal.id), headers=auth(cast.carol))
    assert as_carol.json() == {"like_count": 1, "liked_by_me": True}

    await create_friendship(db_session, cast.alice, cast.bob)
    again = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    assert again.json() == {"like_count": 2, "liked_by_me": True}
    assert len(await _likers(db_session, cast.meal)) == 2  # 鮑伯原本那一列一直都在，沒有多一列


async def test_it_needs_a_login(client, cast):
    assert (await client.put(_url(cast.meal.id))).status_code == 401
    assert (await client.delete(_url(cast.meal.id))).status_code == 401


async def test_likes_and_unlikes_share_one_budget_per_person(client, cast):
    for index in range(LIKE_LIMIT):
        method = "put" if index % 2 == 0 else "delete"
        ok = await client.request(method, _url(cast.meal.id), headers=auth(cast.bob))
        assert ok.status_code == 200

    for method in ("put", "delete"):
        blocked = await client.request(method, _url(cast.meal.id), headers=auth(cast.bob))
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "TOO_MANY_LIKES"
        assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    # 額度是每個人的。
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.carol))).status_code == 200


async def test_guessing_ids_runs_into_the_limit_before_the_lookup(client, cast):
    for _ in range(LIKE_LIMIT):
        assert (await client.put(_url(MISSING), headers=auth(cast.eve))).status_code == 404
    assert (await client.put(_url(MISSING), headers=auth(cast.eve))).status_code == 429


# ---------- 自己的餐點清單（`MealResponse`） ----------


async def _own_views(client, cast) -> dict[str, tuple[int, int]]:
    """每一條回 `MealResponse` 的路徑看到的 (讚, 留言)。"""
    me = auth(cast.alice)
    meal_id = cast.meal.id
    responses = {
        "read": await client.get(f"/api/meals/{meal_id}", headers=me),
        "list": await client.get("/api/meals?date=2026-10-06", headers=me),
        "patch": await client.patch(f"/api/meals/{meal_id}", headers=me, json={"note": "改"}),
        "add_item": await client.post(
            f"/api/meals/{meal_id}/items",
            headers=me,
            json={"food_id": cast.food.id, "quantity": "50"},
        ),
    }
    views = {}
    for name, response in responses.items():
        assert response.status_code in (200, 201), (name, response.text)
        body = response.json()[0] if name == "list" else response.json()
        assert "liked_by_me" not in body  # 規格「與原始決定的差異」第 3 點
        views[name] = (body["like_count"], body["comment_count"])
    return views


async def test_every_path_that_returns_my_meal_carries_the_numbers(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.eve)  # 陌生人的列：不算
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.alice)

    assert set((await _own_views(client, cast)).values()) == {(1, 2)}

    await unfriend(db_session, cast.alice, cast.bob)
    await unfriend(db_session, cast.alice, cast.carol)
    assert set((await _own_views(client, cast)).values()) == {(0, 1)}


async def test_a_new_meal_starts_at_zero(client, cast):
    response = await client.post(
        "/api/meals",
        headers=auth(cast.alice),
        json={"eaten_at": "2026-10-06T05:00:00+00:00", "meal_type": "snack", "items": []},
    )

    assert response.status_code == 201
    assert (response.json()["like_count"], response.json()["comment_count"]) == (0, 0)
```

`tests/test_social_likes_concurrency.py`（兩條真的連線；照 `tests/test_invites_concurrency.py` 的骨架）：

```python
"""兩個同時到的 PUT（連按兩下、兩台裝置）——都成功，只有一列（社群規格 D8）。

不用 `db_session`：共用一個交易的夾具看不見「第二個 INSERT 卡在唯一索引上等第一個」
（handover §6 第 14 種）。資料真的 commit，`finally` 自己清。"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.social import like_meal
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal, MealType
from app.models.social import MealLike
from app.models.user import User
from tests.conftest import TEST_DATABASE_URL
from tests.test_sessions_concurrency import _wait_until_someone_else_is_lock_waiting


@pytest_asyncio.fixture
async def independent_sessions(
    migrated_database: None,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def _user(label: str) -> User:
    return User(
        email=f"like-race-{label}-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name=label,
    )


async def test_the_second_of_two_simultaneous_likes_waits_then_does_nothing(independent_sessions):
    alice, bob = _user("alice"), _user("bob")
    async with independent_sessions() as setup:
        setup.add_all([alice, bob])
        await setup.flush()
        user_a, user_b = sorted((alice.id, bob.id))
        setup.add(
            Friendship(
                user_a=user_a,
                user_b=user_b,
                requested_by=alice.id,
                status=FriendshipStatus.ACCEPTED,
                accepted_at=datetime.now(UTC),
            )
        )
        meal = Meal(user_id=alice.id, eaten_at=datetime.now(UTC), meal_type=MealType.LUNCH)
        setup.add(meal)
        await setup.commit()

    try:
        async with independent_sessions() as first, independent_sessions() as second:
            # 第一個 PUT 做到一半：那一列寫了、還沒 commit。
            first.add(MealLike(meal_id=meal.id, user_id=bob.id))
            await first.flush()
            first_pid = await first.scalar(select(func.pg_backend_pid()))

            bob_again = await second.get(User, bob.id)
            assert bob_again is not None
            attempt = asyncio.create_task(like_meal(meal.id, user=bob_again, db=second))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()

            state = await attempt
            assert (state.like_count, state.liked_by_me) == (1, True)

        async with independent_sessions() as check:
            rows = await check.scalar(
                select(func.count()).select_from(MealLike).where(MealLike.meal_id == meal.id)
            )
            assert rows == 1
    finally:
        async with independent_sessions() as cleanup:
            # 餐、讚、好友關係都跟著使用者 cascade。
            await cleanup.execute(delete(User).where(User.id.in_([alice.id, bob.id])))
            await cleanup.commit()
```

Run：`./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_likes.py tests/test_social_likes_concurrency.py`
Expected：FAIL——端點不存在是 405／404，`like_meal` 的 import 是 collection error。

- [x] **Step 3：端點。** `app/schemas/social.py` 加：

```python
class LikeState(BaseModel):
    """按讚與收回都回這個：過濾後的數字，前端拿它對帳（規格 D19）。"""

    like_count: int
    liked_by_me: bool
```

`app/api/routes/social.py` 加（import `delete`、`from sqlalchemy.dialects.postgresql import insert as pg_insert`、`UnprocessableEntityError`、`like_rate_limiter`、`LikeState`、`social_counts`）：

```python
async def _like_state(db: AsyncSession, user_id: int, meal_id: int) -> LikeState:
    counts = (await social_counts(db, user_id, [meal_id]))[meal_id]
    return LikeState(like_count=counts.like_count, liked_by_me=counts.liked_by_me)


@router.put("/meals/{meal_id}/like", response_model=LikeState)
async def like_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LikeState:
    """按讚。冪等：已經按過就什麼都不做，照樣回 200 與目前的數字。

    限速在最前面（查不查得到都算一次）。`ON CONFLICT DO NOTHING`：兩個同時到的 PUT，
    第二個等第一個 commit 之後什麼都不寫——不是 IntegrityError。"""
    like_rate_limiter.hit(str(user.id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    if meal.user_id == user.id:
        raise UnprocessableEntityError("CANNOT_LIKE_OWN_MEAL", "不能對自己的餐點按讚")
    await db.execute(
        pg_insert(MealLike).values(meal_id=meal.id, user_id=user.id).on_conflict_do_nothing()
    )
    await db.commit()
    return await _like_state(db, user.id, meal.id)


@router.delete("/meals/{meal_id}/like", response_model=LikeState)
async def unlike_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LikeState:
    """收回讚。冪等。回 200 與目前的數字（不是 204）：跟按讚同一個形狀。
    看不到這一餐（包含已經解除好友）就是 404——那個讚本來就被藏起來了。"""
    like_rate_limiter.hit(str(user.id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    await db.execute(
        delete(MealLike).where(MealLike.meal_id == meal.id, MealLike.user_id == user.id)
    )
    await db.commit()
    return await _like_state(db, user.id, meal.id)
```

- [x] **Step 4：`MealResponse` 的兩個數字。**

`app/schemas/meal.py` 的 `MealResponse` 最後加：

```python
    # 這一餐有幾個讚、幾則留言（社群規格 §5.6；只算現在的好友）。沒有預設值，理由同
    # description：每一條回 MealResponse 的路徑都要帶真的數字。主人不能讚自己，所以沒有
    # 「我按了沒」。
    like_count: int
    comment_count: int
```

`app/api/routes/meals.py`：

1. import **一字不差**（掃描測試比對這一行）：`from app.social_visibility import SocialCounts, social_counts`（放在 `app.schemas.meal` 與 `app.storage.photos` 之間）。
2. `_build_meal_response(meal, item_rows, cost, counts: SocialCounts)`：多一個**必填**參數，`MealResponse(…, like_count=counts.like_count, comment_count=counts.comment_count)`。
3. 六個呼叫點。單一餐的五個（`read_meal`、`update_meal`、`add_meal_item`、`update_meal_item`、`upload_meal_photo`）：

   ```python
       costs = await _costs_by_meal(db, [meal.id])
       counts = await social_counts(db, user.id, [meal.id])
       return _build_meal_response(meal, rows, costs.get(meal.id), counts[meal.id])
   ```

   `list_meals`：`counts = await social_counts(db, user.id, meal_ids)`，迴圈裡傳 `counts[meal.id]`。
4. `create_meal` 直接組 `MealResponse` 的那一處：`like_count=0, comment_count=0,`，上面一行註解「剛建立的餐不會有讚與留言」。
5. `read_meal`、`list_meals` 的 docstring 把查詢次數改對（3 → 5：多了讚與留言各一次，一樣跟餐數無關）。

- [x] **Step 5：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_likes.py tests/test_social_likes_concurrency.py tests/test_friend_meals.py
```

Expected：`test_social_likes.py` **14 passed**（1＋1＋1＋4＋1＋1＋1＋1＋1＋1＋1）、並行 1 條、掃描測試仍然綠（`meals.py` 那一行 import 被允許）。

- [x] **Step 6：突變。**

| 突變 | 該紅的 |
|---|---|
| `like_meal` 的 `.on_conflict_do_nothing()` 拿掉 | 並行那一條（`IntegrityError`）；`test_both_directions_are_idempotent`（共用 session 裡是 500／例外） |
| `like_meal` 拿掉「主人」的檢查 | `test_the_owner_cannot_like_their_own_meal` |
| 兩個端點的 `load_visible_meal` 換成 `db.get(Meal, meal_id)` | `test_who_cannot_see…` 四條、`…gone_private…`、`…after_unfriending…` |
| `unlike_meal` 的 `delete` 拿掉 `MealLike.user_id == user.id` | `test_like_then_take_it_back`（小卡的也被刪） |
| `like_rate_limiter.hit` 搬到 `load_visible_meal` 後面 | `test_guessing_ids_runs_into_the_limit…` |
| `unlike_meal` 改用另一個新的限速器 | `test_likes_and_unlikes_share_one_budget…` |
| `LIKE_LIMIT = 61` | 同上（第 61 次是 200） |
| `conftest.py` 拿掉 `like_rate_limiter.reset()` | 這個檔案單獨跑不一定紅（每條測試的使用者 id 都不同）——**預期存活**，理由同 `export_rate_limiter`（`conftest.py` 的 docstring）。照實記下 |
| `read_meal`／`list_meals`／`update_meal`／`add_meal_item` 各自改傳 `SocialCounts()` | `test_every_path…`（`_own_views` 的那一個名字） |
| `update_meal_item`、`upload_meal_photo` 改傳 `SocialCounts()` | **沒有測試會紅**（`_own_views` 沒有走這兩條）。在 `_own_views` 補上這兩條路徑之後再突變一次——需要一個項目 id 與一張 JPEG（照 `tests/test_friend_meals.py` 的 `_jpeg()`）；補不上就照實寫進「與規格的差異」 |
| `meals.py` 的 import 改成 `from app.social_visibility import SocialCounts, load_visible_meal, social_counts` | `test_only_the_social_modules_widen…` |

- [x] **Step 7：`schema.d.ts` 與前端的型別。** 重新產生 → `cd frontend && npm run -s typecheck`。
Expected：**紅一處**——`tests/timeline.test.ts` 的 `meal()`（唯一有型別標註的 `Meal` 測試資料）少了兩個欄位。加上 `like_count: 0, comment_count: 0,`，再跑 `npm run -s typecheck && npm run -s test`，全綠、數字跟基準線一樣。

- [x] **Step 8：整套、commit。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/ratelimit.py tests/conftest.py app/schemas/social.py app/api/routes/social.py app/schemas/meal.py app/api/routes/meals.py tests/test_social_likes.py tests/test_social_likes_concurrency.py frontend/src/api/schema.d.ts frontend/tests/timeline.test.ts
git commit -F "$S/social-plan-task3-msg.txt"   # feat(backend): 按讚與收回（冪等、並行不會 500）；自己的餐點清單帶讚與留言數
```

---

## Task 4：後端——留言

**Files:**
- Create: `tests/test_social_comments.py`
- Modify: `app/schemas/social.py`、`app/api/routes/social.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：測試。** `tests/test_social_comments.py`（`cast` 夾具、`auth` 等照 Task 3 的檔頭）：

```python
"""留言的新增與刪除（社群規格 §5.3、§5.4）。"""

import pytest
from sqlalchemy import select

from app.models.social import MealComment
from app.ratelimit import COMMENT_LIMIT
from tests.factories import create_comment, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


def _url(meal_id, comment_id=None) -> str:
    base = f"/api/social/meals/{meal_id}/comments"
    return base if comment_id is None else f"{base}/{comment_id}"


async def _post(client, user, meal_id, body="看起來好好吃"):
    return await client.post(_url(meal_id), headers=auth(user), json={"body": body})


async def _bodies(db_session, meal) -> list[str]:
    rows = await db_session.scalars(
        select(MealComment.body).where(MealComment.meal_id == meal.id).order_by(MealComment.id)
    )
    return list(rows)


# ---------- 新增 ----------


async def test_a_friend_comments_and_everyone_who_can_see_the_meal_reads_it(client, cast):
    response = await _post(client, cast.bob, cast.meal.id, "好吃嗎")

    assert response.status_code == 201
    created = response.json()
    assert set(created) == {"id", "display_name", "is_me", "can_delete", "body", "created_at"}
    assert (created["display_name"], created["is_me"], created["can_delete"]) == ("鮑伯", True, True)
    assert created["created_at"].endswith(("Z", "+00:00"))

    seen = await client.get(f"/api/social/meals/{cast.meal.id}", headers=auth(cast.carol))
    assert [(c["id"], c["body"], c["is_me"]) for c in seen.json()["comments"]] == [
        (created["id"], "好吃嗎", False)
    ]


async def test_the_owner_can_comment_even_on_a_private_meal(client, db_session, cast):
    cast.meal.is_private = True
    await db_session.commit()

    assert (await _post(client, cast.alice, cast.meal.id, "自己的筆記")).status_code == 201
    assert (await _post(client, cast.bob, cast.meal.id)).status_code == 404
    assert await _bodies(db_session, cast.meal) == ["自己的筆記"]


async def test_the_body_is_cleaned_into_one_safe_line(client, db_session, cast):
    """換行、Tab、NUL、雙向控制字元都變成空白並壓成一個；ZWJ 的表情符號留著。"""
    family = "".join(chr(code) for code in (0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467))
    raw = "  好吃\n\t嗎" + chr(0x202E) + "真的" + chr(0) + " " + family + "  "

    response = await _post(client, cast.bob, cast.meal.id, raw)

    assert response.status_code == 201
    assert response.json()["body"] == f"好吃 嗎 真的 {family}"
    assert await _bodies(db_session, cast.meal) == [f"好吃 嗎 真的 {family}"]


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ("字" * 200, 201),
        ("字" * 201, 422),
        # 上限算的是清理之後：200 個字＋一堆會被清掉的空白仍然是 200。
        ("字" * 200 + " \n" * 100, 201),
        (chr(0x1F600) * 200, 201),  # 一個表情符號算一個字（code point），不是兩個
        (chr(0x1F600) * 201, 422),
        ("", 422),
        ("   \n\t ", 422),
        (chr(0x202E) + chr(0), 422),  # 清完是空的
        ("字" * 1001, 422),  # 清理之前的上限
    ],
    # 明寫 id：參數裡有控制字元與一千個字，不要讓 pytest 自己拿去當測試名稱。
    ids=["200", "201", "200-padded", "emoji-200", "emoji-201", "empty", "blank", "control", "raw"],
)
async def test_the_length_limit_applies_after_cleaning(client, db_session, cast, body, status):
    response = await _post(client, cast.bob, cast.meal.id, body)

    assert response.status_code == status
    assert len(await _bodies(db_session, cast.meal)) == (1 if status == 201 else 0)


async def test_the_body_must_be_a_string(client, cast):
    for payload in ({}, {"body": None}, {"body": 5}, {"body": ["a"]}):
        response = await client.post(_url(cast.meal.id), headers=auth(cast.bob), json=payload)
        assert response.status_code == 422, payload


@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_comment(client, db_session, cast, who):
    viewer = getattr(cast, who)

    hidden = await _post(client, viewer, cast.meal.id)
    missing = await _post(client, viewer, MISSING)

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _bodies(db_session, cast.meal) == []


async def test_after_unfriending_no_more_comments(client, db_session, cast):
    assert (await _post(client, cast.bob, cast.meal.id, "之前")).status_code == 201
    await unfriend(db_session, cast.alice, cast.bob)

    assert (await _post(client, cast.bob, cast.meal.id, "之後")).status_code == 404
    assert await _bodies(db_session, cast.meal) == ["之前"]


async def test_comments_are_limited_per_person(client, cast):
    for index in range(COMMENT_LIMIT):
        assert (await _post(client, cast.bob, cast.meal.id, f"第{index}則")).status_code == 201

    blocked = await _post(client, cast.bob, cast.meal.id, "太多了")

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_COMMENTS"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    assert (await _post(client, cast.carol, cast.meal.id)).status_code == 201


# ---------- 刪除 ----------


async def _delete(client, user, meal_id, comment_id):
    return await client.delete(_url(meal_id, comment_id), headers=auth(user))


async def test_the_author_deletes_their_own_and_only_that_one(client, db_session, cast):
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我的")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="也是我的")

    response = await _delete(client, cast.bob, cast.meal.id, mine.id)

    assert response.status_code == 204 and response.content == b""
    assert await _bodies(db_session, cast.meal) == ["也是我的"]
    # 再刪一次：已經不在了。
    assert (await _delete(client, cast.bob, cast.meal.id, mine.id)).status_code == 404


async def test_the_owner_deletes_anyones_comment_on_their_meal(client, db_session, cast):
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.carol)

    assert (await _delete(client, cast.alice, cast.meal.id, theirs.id)).status_code == 204
    assert await _bodies(db_session, cast.meal) == []


async def test_a_third_person_cannot_delete_someone_elses_comment(client, db_session, cast):
    """小卡看得到鮑伯的留言（所以「看不到這一餐」那道過濾無效），但那不是她的、餐也不是她的。"""
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")

    refused = await _delete(client, cast.carol, cast.meal.id, theirs.id)
    missing = await _delete(client, cast.carol, cast.meal.id, MISSING)

    assert refused.status_code == missing.status_code == 404
    assert refused.content == missing.content
    assert refused.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


async def test_owning_another_meal_does_not_let_you_delete_through_it(client, db_session, cast):
    """IDOR：小卡是**她自己那一餐**的主人；把別的餐的留言 id 掛在自己的餐底下刪。"""
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")
    carols_meal = await create_meal(db_session, user=cast.carol)

    response = await _delete(client, cast.carol, carols_meal.id, theirs.id)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_delete(client, db_session, cast, who):
    viewer = getattr(cast, who)
    own = await create_comment(db_session, meal=cast.meal, user=viewer, body="混進來的")

    response = await _delete(client, viewer, cast.meal.id, own.id)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["混進來的"]


async def test_an_unfriended_author_can_no_longer_delete(client, db_session, cast):
    """規格 §9.1 第 2 點（已知限制）：看不到那一餐了，留言被藏起來、也收不回來。"""
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob)
    await unfriend(db_session, cast.alice, cast.bob)

    assert (await _delete(client, cast.bob, cast.meal.id, mine.id)).status_code == 404
    # 主人還是刪得掉——就算它現在不顯示。
    assert (await _delete(client, cast.alice, cast.meal.id, mine.id)).status_code == 204


async def test_comments_need_a_login(client, cast):
    assert (await client.post(_url(cast.meal.id), json={"body": "嗨"})).status_code == 401
    assert (await client.delete(_url(cast.meal.id, 1))).status_code == 401
```

Run → Expected：FAIL（405／404）。

- [ ] **Step 2：schema。** `app/schemas/social.py` 加（import `Annotated`、`AfterValidator`、`Field`、`single_line`）：

```python
COMMENT_MAX_LENGTH = 200


def _clean_comment(value: str) -> str:
    """留言是不可信的文字、會顯示給別人：先清成一行，**清完之後**才量長度。"""
    cleaned = single_line(value)
    if not cleaned:
        raise ValueError("留言不能是空的")
    if len(cleaned) > COMMENT_MAX_LENGTH:
        raise ValueError(f"留言最多 {COMMENT_MAX_LENGTH} 個字")
    return cleaned


class CommentCreate(BaseModel):
    # 1000 是清理**之前**的長度（同 MealCreateRequest.description 的寫法）：擋掉超大的 body，
    # 又不會因為貼上的文字多了幾個換行就 422。
    body: Annotated[str, AfterValidator(_clean_comment)] = Field(max_length=1000)
```

- [ ] **Step 3：端點。** `app/api/routes/social.py` 加（import `status`、`comment_rate_limiter`、`CommentCreate`）：

```python
@router.post(
    "/meals/{meal_id}/comments",
    status_code=status.HTTP_201_CREATED,
    response_model=CommentResponse,
)
async def add_comment(
    meal_id: ResourceId,
    payload: CommentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CommentResponse:
    """留言。看得到這一餐的人都可以，包含主人自己。不能改，只能刪掉重寫。"""
    comment_rate_limiter.hit(str(user.id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    comment = MealComment(meal_id=meal.id, user_id=user.id, body=payload.body)
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return _comment_response(
        comment, user.display_name, viewer_id=user.id, owner_id=meal.user_id
    )


@router.delete(
    "/meals/{meal_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_comment(
    meal_id: ResourceId,
    comment_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪留言：作者刪自己的，餐的主人刪這一餐底下任何一則。

    條件全部在一個 DELETE 的 WHERE 裡——留言 id、**它屬於路徑上的這一餐**、我有權刪。
    不存在、屬於另一餐、看得到但不是我的，都是同一個 404。"""
    meal = await load_visible_meal(db, user, meal_id)
    conditions = [MealComment.id == comment_id, MealComment.meal_id == meal.id]
    if meal.user_id != user.id:
        # 不是主人：只能刪自己寫的。
        conditions.append(MealComment.user_id == user.id)
    deleted = await db.scalar(delete(MealComment).where(*conditions).returning(MealComment.id))
    if deleted is None:
        raise NotFoundError("COMMENT_NOT_FOUND", "找不到這則留言")
    await db.commit()
```

- [ ] **Step 4：跑。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_comments.py`
Expected：**25 passed**（新增 1＋1＋1＋9＋1＋2＋1＋1＝17；刪除 1＋1＋1＋1＋2＋1＋1＝8）。

- [ ] **Step 5：突變。**

| 突變 | 該紅的 |
|---|---|
| `_clean_comment` 不清理（`cleaned = value.strip()`） | `…cleaned_into_one_safe_line`、`…after_cleaning[200-padded]`、`[control]` |
| 長度改量清理之前（`len(value)`） | `…after_cleaning[200-padded]` |
| `COMMENT_MAX_LENGTH = 201` | `[201]`——而且是**資料庫的 CHECK** 把它擋成 500（`IntegrityError` 從 `client.post` 冒出來）。那是另一道防線：照實記下紅的樣子（規矩 8） |
| 拿掉 `if not cleaned` | `[empty]`、`[blank]`、`[control]`（同上，是 CHECK 擋的） |
| `Field(max_length=1000)` 拿掉 | `[raw]`？**不會**——清理之後的 200 上限先擋。這個上限守的是「不要把 10 MB 的字串送進正規表示式」，沒有測試看得到；**預期存活**，照實記下 |
| `add_comment`、`delete_comment` 的 `load_visible_meal` 換成 `db.get(Meal, meal_id)` | `…cannot_comment` 兩條、`…no_more_comments`、`…cannot_delete` 兩條、`…unfriended_author…` |
| `delete_comment` 拿掉 `MealComment.meal_id == meal.id` | `test_owning_another_meal…` |
| 拿掉「不是主人只能刪自己的」那個 `if` | `test_a_third_person…` |
| `if meal.user_id != user.id` 反過來 | `test_the_owner_deletes_anyones…`、`test_a_third_person…` |
| `comment_rate_limiter.hit` 拿掉；`COMMENT_LIMIT = 21` | `test_comments_are_limited_per_person` |
| `_comment_response` 的 `display_name` 傳成 `user.email` | `test_a_friend_comments…` |

- [ ] **Step 6：`schema.d.ts`、整套、commit。** 重新產生（多兩個 operation、一個 schema）→ `cd frontend && npm run -s typecheck`（綠）。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/schemas/social.py app/api/routes/social.py tests/test_social_comments.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task4-msg.txt"   # feat(backend): 留言——清成一行、1 到 200 字；作者與餐的主人可以刪
```

---

## Task 5：後端——讚與留言的通知、通知的三個端點

**Files:**
- Create: `app/notifications.py`、`app/api/routes/notifications.py`、`tests/test_notifications.py`
- Modify: `app/social_visibility.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`app/main.py`、`tests/test_social_likes_concurrency.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：測試。** `tests/test_notifications.py`（檔頭的 `cast` 夾具同 Task 3；這裡的通知**都經過端點產生**，不直接寫表——要測的就是端點有沒有寫）：

```python
"""通知：誰收到、什麼時候消失、已讀（社群規格 §4.3、§5.5、D11–D15）。"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select, update

from app.models.social import Notification, NotificationType
from tests.factories import create_comment, create_friendship
from tests.social_helpers import auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


async def _like(client, user, meal):
    response = await client.put(f"/api/social/meals/{meal.id}/like", headers=auth(user))
    assert response.status_code == 200


async def _unlike(client, user, meal):
    response = await client.delete(f"/api/social/meals/{meal.id}/like", headers=auth(user))
    assert response.status_code == 200


async def _comment(client, user, meal, body="好吃嗎") -> int:
    response = await client.post(
        f"/api/social/meals/{meal.id}/comments", headers=auth(user), json={"body": body}
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _inbox(client, user) -> list[dict]:
    response = await client.get("/api/notifications", headers=auth(user))
    assert response.status_code == 200
    assert set(response.json()) == {"items"}
    return response.json()["items"]


async def _unread(client, user) -> int:
    response = await client.get("/api/notifications/unread-count", headers=auth(user))
    assert response.status_code == 200
    return response.json()["count"]


def _who_did_what(items) -> list[tuple[str, str]]:
    return [(item["actor_name"], item["type"]) for item in items]


# ---------- 寫入 ----------


async def test_a_like_tells_the_owner_and_nobody_else(client, cast):
    await _like(client, cast.bob, cast.meal)

    [item] = await _inbox(client, cast.alice)
    assert set(item) == {
        "id", "type", "actor_name", "meal", "comment_preview", "created_at", "is_read",
    }
    assert (item["type"], item["actor_name"], item["is_read"]) == ("like", "鮑伯", False)
    assert item["meal"] == {
        "id": cast.meal.id,
        "meal_type": "lunch",
        "eaten_at": "2026-10-06T04:00:00Z",
    }
    assert item["comment_preview"] is None
    assert await _unread(client, cast.alice) == 1
    # 按的人自己、同一餐上的另一個好友：都沒有通知。
    assert await _inbox(client, cast.bob) == [] and await _inbox(client, cast.carol) == []


async def test_liking_twice_or_unliking_and_reliking_never_piles_up(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.bob, cast.meal)
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]

    await _unlike(client, cast.bob, cast.meal)
    assert await _inbox(client, cast.alice) == []
    assert await db_session.scalar(select(func.count()).select_from(Notification)) == 0

    await _like(client, cast.bob, cast.meal)
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]


async def test_unliking_only_removes_my_like_notification(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)
    await _comment(client, cast.bob, cast.meal)

    await _unlike(client, cast.bob, cast.meal)

    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "comment"), ("小卡", "like")]


async def test_a_comment_tells_only_the_owner(client, cast):
    """不做「跟著這串留言」（D11）：小卡先留過言，鮑伯再留，小卡不會收到。
    主人在自己的餐留言：沒有人收到。"""
    await _comment(client, cast.carol, cast.meal, "先留的")
    await _comment(client, cast.bob, cast.meal, "後留的")
    await _comment(client, cast.alice, cast.meal, "主人回覆")

    items = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["type"], i["comment_preview"]) for i in items] == [
        ("鮑伯", "comment", "後留的"),
        ("小卡", "comment", "先留的"),
    ]
    assert await _inbox(client, cast.carol) == [] and await _inbox(client, cast.bob) == []


@pytest.mark.parametrize(("length", "preview"), [(40, "字" * 40), (41, "字" * 40 + "…")])
async def test_the_preview_is_the_first_forty_characters(client, cast, length, preview):
    await _comment(client, cast.bob, cast.meal, "字" * length)

    [item] = await _inbox(client, cast.alice)
    assert item["comment_preview"] == preview


async def test_nothing_private_rides_along(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "看得到的預覽")

    response = await client.get("/api/notifications", headers=auth(cast.alice))

    assert "看得到的預覽" in response.text  # 預覽在（下面那些才不是空轉）
    for secret in ("@example.com", "actor_id", "user_id", "今天心情很差", "4321.75"):
        assert secret not in response.text


# ---------- 什麼時候消失（§4.3） ----------


async def test_deleting_the_comment_or_the_meal_takes_the_notifications(client, cast):
    comment_id = await _comment(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)

    deleted = await client.delete(
        f"/api/social/meals/{cast.meal.id}/comments/{comment_id}", headers=auth(cast.bob)
    )
    assert deleted.status_code == 204
    assert _who_did_what(await _inbox(client, cast.alice)) == [("小卡", "like")]

    assert (
        await client.delete(f"/api/meals/{cast.meal.id}", headers=auth(cast.alice))
    ).status_code == 204
    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0


async def test_unfriending_hides_their_notifications_until_they_are_back(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "不該留在通知裡的預覽")
    await _like(client, cast.carol, cast.meal)
    assert await _unread(client, cast.alice) == 3

    await unfriend(db_session, cast.alice, cast.bob)

    response = await client.get("/api/notifications", headers=auth(cast.alice))
    assert _who_did_what(response.json()["items"]) == [("小卡", "like")]
    assert "不該留在通知裡的預覽" not in response.text
    assert await _unread(client, cast.alice) == 1

    await create_friendship(db_session, cast.alice, cast.bob)
    assert len(await _inbox(client, cast.alice)) == 3


async def test_going_private_keeps_the_owners_notifications(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    cast.meal.is_private = True
    await db_session.commit()

    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]


# ---------- 清單的上限與順序 ----------


async def test_the_latest_fifty_newest_first(client, db_session, cast):
    for index in range(51):
        comment = await create_comment(
            db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則"
        )
        db_session.add(
            Notification(
                user_id=cast.alice.id,
                actor_id=cast.bob.id,
                type=NotificationType.COMMENT,
                meal_id=cast.meal.id,
                comment_id=comment.id,
            )
        )
    await db_session.commit()

    items = await _inbox(client, cast.alice)

    assert [item["comment_preview"] for item in items] == [
        f"第{index}則" for index in range(50, 0, -1)
    ]
    assert await _unread(client, cast.alice) == 51  # 未讀數不受 50 則的上限影響


# ---------- 已讀 ----------


async def _read_all(client, user, up_to):
    return await client.post(
        "/api/notifications/read-all", headers=auth(user), json={"up_to": up_to}
    )


async def test_read_all_marks_up_to_what_was_seen_and_no_further(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal)
    seen = await _inbox(client, cast.alice)
    await _like(client, cast.carol, cast.meal)  # 清單載入之後才到的

    response = await _read_all(client, cast.alice, seen[0]["id"])

    assert response.status_code == 200
    assert response.json() == {"count": 1}
    after = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["is_read"]) for i in after] == [
        ("小卡", False),
        ("鮑伯", True),
        ("鮑伯", True),
    ]
    assert await _unread(client, cast.alice) == 1


async def test_read_all_cannot_touch_someone_elses(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)

    response = await _read_all(client, cast.bob, item["id"] + 1000)

    assert response.json() == {"count": 0}
    assert await _unread(client, cast.alice) == 1


async def test_reading_again_does_not_restamp_what_was_already_read(client, db_session, cast):
    """共用交易裡 `now()` 不會動（整條測試是同一個外層交易）——比兩次的時間看不出差別。
    所以直接把已讀時間改成很久以前，看它有沒有被蓋掉。"""
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)
    long_ago = datetime(2020, 1, 1, tzinfo=UTC)
    await db_session.execute(update(Notification).values(read_at=long_ago))
    await db_session.commit()

    await _read_all(client, cast.alice, item["id"])

    assert await db_session.scalar(select(Notification.read_at)) == long_ago


@pytest.mark.parametrize(
    "payload",
    [{}, {"up_to": 0}, {"up_to": -1}, {"up_to": 2**63}, {"up_to": "x"}],
    ids=["missing", "zero", "negative", "too-big", "not-a-number"],
)
async def test_read_all_validates_its_body(client, cast, payload):
    response = await client.post(
        "/api/notifications/read-all", headers=auth(cast.alice), json=payload
    )
    assert response.status_code == 422


async def test_all_three_need_a_login(client):
    assert (await client.get("/api/notifications")).status_code == 401
    assert (await client.get("/api/notifications/unread-count")).status_code == 401
    assert (await client.post("/api/notifications/read-all", json={"up_to": 1})).status_code == 401
```

`tests/test_social_likes_concurrency.py`：`check` 那一段多數一次通知（import `Notification`）：

```python
            notes = await check.scalar(
                select(func.count())
                .select_from(Notification)
                .where(Notification.meal_id == meal.id)
            )
            # 第一個「PUT」是測試自己寫的列（沒寫通知）；第二個什麼都沒新增，所以也不該寫。
            assert notes == 0
```

Run → Expected：FAIL（`/api/notifications` 404；寫入那幾條是「清單是空的」）。

- [ ] **Step 2：寫通知。** `app/notifications.py`：

```python
"""寫通知（社群規格 D11、D12、§5.7）。

**這裡的函式都不 commit**：通知跟著呼叫端的那個交易一起成立、一起消失——讚寫進去了
通知就一定在，讚被 rollback 了通知也不會留下。「誰看得到通知」不在這裡，在讀的那一層。
"""

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social import Notification, NotificationType


async def notify_like(db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int) -> None:
    """同一個人對同一餐只有一則（`uq_notifications_like`）；已經有就什麼都不做。"""
    if owner_id == actor_id:
        return
    await db.execute(
        pg_insert(Notification)
        .values(user_id=owner_id, actor_id=actor_id, type=NotificationType.LIKE, meal_id=meal_id)
        .on_conflict_do_nothing()
    )


async def forget_like(db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int) -> None:
    """收回讚：那一則通知跟著消失——不然「按了又收回」會留下一則指向不存在的讚的通知。"""
    await db.execute(
        delete(Notification).where(
            Notification.user_id == owner_id,
            Notification.actor_id == actor_id,
            Notification.meal_id == meal_id,
            Notification.type == NotificationType.LIKE,
        )
    )


def notify_comment(
    db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int, comment_id: int
) -> None:
    """只通知餐的主人；主人自己留言不通知自己。留言被刪時由 FK cascade 帶走。"""
    if owner_id == actor_id:
        return
    db.add(
        Notification(
            user_id=owner_id,
            actor_id=actor_id,
            type=NotificationType.COMMENT,
            meal_id=meal_id,
            comment_id=comment_id,
        )
    )
```

`app/api/routes/social.py` 接上去：

```python
    # like_meal：原本的 execute 換成這一段
    inserted = await db.scalar(
        pg_insert(MealLike)
        .values(meal_id=meal.id, user_id=user.id)
        .on_conflict_do_nothing()
        .returning(MealLike.id)
    )
    if inserted is not None:
        # 真的新增了才通知。重複的 PUT 不會走到這裡（衝突時 RETURNING 沒有列）。
        await notify_like(db, owner_id=meal.user_id, actor_id=user.id, meal_id=meal.id)
    await db.commit()

    # unlike_meal：delete 之後、commit 之前
    await forget_like(db, owner_id=meal.user_id, actor_id=user.id, meal_id=meal.id)

    # add_comment：db.add(comment) 之後
    await db.flush()  # 要先拿到留言的 id
    notify_comment(
        db, owner_id=meal.user_id, actor_id=user.id, meal_id=meal.id, comment_id=comment.id
    )
    await db.commit()
```

- [ ] **Step 3：讀通知的過濾。** `app/social_visibility.py` 檔尾加（import `Notification`、`NotificationType`；寫計畫時跑過）：

```python
def notification_visible() -> ColumnElement[bool]:
    """這則通知現在還看不看得到（規格 §4.3）。跟 `Notification` 一起用在 WHERE 裡。

    - 好友邀請：那個邀請**還在等**（接受、拒絕、收回之後就不顯示）。
    - 其他三種：做這件事的人現在是我的好友——解除之後，他留言的預覽不會留在我的通知裡。

    餐或留言被刪的情況不用管：FK cascade 已經把那一列帶走了。"""
    pair = (Notification.user_id, Notification.actor_id)
    still_pending = exists().where(
        Friendship.status == FriendshipStatus.PENDING,
        Friendship.requested_by == Notification.actor_id,
        *_pair(*pair),
    )
    is_request = Notification.type == NotificationType.FRIEND_REQUEST
    return or_(and_(is_request, still_pending), and_(~is_request, _are_friends(*pair)))
```

- [ ] **Step 4：schema 與端點。** `app/schemas/social.py` 加（import `MealType`、`NotificationType`）：

```python
class NotificationMeal(BaseModel):
    """畫「你的午餐」與連結所需要的最少欄位。"""

    id: int
    meal_type: MealType
    eaten_at: datetime


class NotificationItem(BaseModel):
    id: int
    type: NotificationType
    # 只有名字（D9）。
    actor_name: str
    # 讚與留言才有；好友的兩種是 None。
    meal: NotificationMeal | None
    comment_preview: str | None
    created_at: datetime
    is_read: bool


class NotificationsResponse(BaseModel):
    items: list[NotificationItem]


class UnreadCount(BaseModel):
    count: int


class ReadAllRequest(BaseModel):
    # 清單裡最新那一則的 id：之後才到的通知不會沒被看過就變成已讀（D15）。
    up_to: int = Field(gt=0, lt=2**63)
```

`app/api/routes/notifications.py`（`app/main.py` 註冊在 `social` 後面）：

```python
"""通知（社群規格 §5.5）。三個端點都只碰「收件人是我」的列。"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.models.meal import Meal
from app.models.social import MealComment, Notification
from app.models.user import User
from app.schemas.social import (
    NotificationItem,
    NotificationMeal,
    NotificationsResponse,
    ReadAllRequest,
    UnreadCount,
)
from app.social_visibility import notification_visible

router = APIRouter(prefix="/notifications", tags=["notifications"])

# 清單只回最近這麼多則（規格 D22）；這一版不自動刪舊的。
NOTIFICATIONS_SHOWN = 50
PREVIEW_LENGTH = 40


def _preview(body: str | None) -> str | None:
    if body is None or len(body) <= PREVIEW_LENGTH:
        return body
    return body[:PREVIEW_LENGTH] + "…"


@router.get("", response_model=NotificationsResponse)
async def list_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationsResponse:
    """最近 50 則，新的在前。一次查詢：動作者的名字、餐、留言都 join 回來。"""
    rows = (
        await db.execute(
            select(Notification, User.display_name, Meal.meal_type, Meal.eaten_at, MealComment.body)
            .join(User, User.id == Notification.actor_id)
            .outerjoin(Meal, Meal.id == Notification.meal_id)
            .outerjoin(MealComment, MealComment.id == Notification.comment_id)
            .where(Notification.user_id == user.id, notification_visible())
            .order_by(Notification.id.desc())
            .limit(NOTIFICATIONS_SHOWN)
        )
    ).all()
    return NotificationsResponse(
        items=[
            NotificationItem(
                id=note.id,
                type=note.type,
                actor_name=actor_name,
                meal=(
                    None
                    if note.meal_id is None or meal_type is None or eaten_at is None
                    else NotificationMeal(id=note.meal_id, meal_type=meal_type, eaten_at=eaten_at)
                ),
                comment_preview=_preview(body),
                created_at=note.created_at,
                is_read=note.read_at is not None,
            )
            for note, actor_name, meal_type, eaten_at, body in rows
        ]
    )


async def _unread(db: AsyncSession, user_id: int) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.read_at.is_(None),
            notification_visible(),
        )
    )
    return count or 0


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCount:
    """分頁上的數字。跟清單同一個過濾，但不受 50 則的上限影響。"""
    return UnreadCount(count=await _unread(db, user.id))


@router.post("/read-all", response_model=UnreadCount)
async def read_all(
    payload: ReadAllRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCount:
    """把我的、`id <= up_to`、還沒讀的標成已讀；回剩下的未讀數。

    不套可見性的過濾：現在看不到的（對方已經解除好友）一起標掉沒有壞處。"""
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == user.id,
            Notification.id <= payload.up_to,
            Notification.read_at.is_(None),
        )
        .values(read_at=func.now())
    )
    await db.commit()
    return UnreadCount(count=await _unread(db, user.id))
```

- [ ] **Step 5：跑。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_notifications.py tests/test_social_likes.py tests/test_social_comments.py tests/test_social_likes_concurrency.py tests/test_friend_meals.py`
Expected：`test_notifications.py` **20 passed**（寫入 1＋1＋1＋1＋2＋1；消失 1＋1＋1；上限 1；已讀 1＋1＋1＋5＋1）；其餘照舊。`eaten_at` 的字串如果是 `+00:00` 結尾而不是 `Z`，照實改測試裡的那一個字串。

- [ ] **Step 6：突變。**

| 突變 | 該紅的 |
|---|---|
| `like_meal` 拿掉 `if inserted is not None`（沒新增也通知） | 並行那一條（`notes == 1`） |
| `notify_like` 的 `.on_conflict_do_nothing()` 拿掉 | **預期存活**：有上面那個 `if`，經過端點寫不出「讚是新的、通知已經在」的狀態。它是第二道防線（哪天有別的路徑寫通知），照實記 |
| 兩個一起拿掉 | `test_liking_twice…`（`uq_notifications_like` 擋成例外） |
| `unlike_meal` 不呼叫 `forget_like` | `test_liking_twice…`（收回之後還在） |
| `forget_like` 拿掉 `type == LIKE`；拿掉 `actor_id == …` | `test_unliking_only_removes_my_like_notification`（留言的通知、小卡的讚也被刪） |
| `notify_comment`／`notify_like` 拿掉 `owner_id == actor_id` 的 return | `test_a_comment_tells_only_the_owner`（CHECK `not_self` 擋成例外——照實記）；讚那一個沒有路徑走得到（主人按讚先 422），**預期存活** |
| `notify_comment` 的 `user_id=owner_id` 改成通知所有留過言的人 | 不用做——`test_a_comment_tells_only_the_owner` 的小卡那一半守著 |
| `notification_visible` 的 `_are_friends(*pair)` 換成 `true()` | `test_unfriending_hides_their_notifications…` |
| `list_notifications` 拿掉 `Notification.user_id == user.id` | `test_a_like_tells_the_owner_and_nobody_else`（鮑伯也看到） |
| `.order_by(Notification.id.desc())` 改 `.asc()`；`NOTIFICATIONS_SHOWN = 51` | `test_the_latest_fifty_newest_first` |
| `_unread` 拿掉 `read_at.is_(None)`；拿掉 `notification_visible()` | `test_read_all_marks…`；`test_unfriending_hides…` |
| `PREVIEW_LENGTH = 41`；`<=` 改 `<` | `test_the_preview…[41]`；`[40]` |
| `read_all` 拿掉 `id <= payload.up_to`；拿掉 `user_id == user.id`；拿掉 `read_at.is_(None)` | `test_read_all_marks…`；`…cannot_touch_someone_elses`；`test_reading_again_does_not_restamp…` |
| `ReadAllRequest` 的 `gt=0` 拿掉；`lt=2**63` 拿掉 | `test_read_all_validates_its_body[zero]`、`[negative]`；`[too-big]`（asyncpg 的 `DataError` 冒出來） |

- [ ] **Step 7：`schema.d.ts`、整套、commit。** 重新產生（三條路徑、五個 schema）→ `cd frontend && npm run -s typecheck`。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/notifications.py app/api/routes/notifications.py app/social_visibility.py app/schemas/social.py app/api/routes/social.py app/main.py tests/test_notifications.py tests/test_social_likes_concurrency.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task5-msg.txt"   # feat(backend): 通知——讚與留言寫給餐的主人；清單、未讀數、已讀
```

---

## Task 6：後端——好友邀請與接受的通知

這個 task 可以整個不做（規格 D14 是「便宜才做」）：不做的話前端 Task 10 的四種文字少兩種，其餘不受影響。做的話只動 `friends.py` 的兩個函式。

**Files:**
- Modify: `app/notifications.py`、`app/api/routes/friends.py`、`tests/test_notifications.py`

- [ ] **Step 1：測試。** `tests/test_notifications.py` 檔尾加（import `format_friend_code`）：

```python
# ---------- 好友的通知（規格 D14、§5.7） ----------


async def _send_request(client, sender, target):
    response = await client.post(
        "/api/friends/requests",
        headers=auth(sender),
        json={"code": format_friend_code(target.friend_code)},
    )
    assert response.status_code in (200, 201), response.text
    return response


async def _pending_id(client, user, box: str, other) -> int:
    """`user` 的收件匣（incoming）或寄件匣（outgoing）裡，跟 `other` 的那一個邀請。
    用人去找：`make_cast` 裡阿丁給愛麗絲的邀請一直都在。"""
    requests = (await client.get("/api/friends/requests", headers=auth(user))).json()
    [request] = [r for r in requests[box] if r["person"]["id"] == other.id]
    return request["id"]


async def test_a_friend_request_tells_the_receiver(client, cast):
    await _send_request(client, cast.eve, cast.alice)

    [item] = await _inbox(client, cast.alice)
    assert (item["type"], item["actor_name"], item["meal"], item["comment_preview"]) == (
        "friend_request", "伊芙", None, None,
    )
    assert await _inbox(client, cast.eve) == []


async def test_accepting_tells_the_sender_and_retires_the_request_notice(client, cast):
    await _send_request(client, cast.eve, cast.alice)
    request_id = await _pending_id(client, cast.alice, "incoming", cast.eve)

    accepted = await client.post(
        f"/api/friends/requests/{request_id}/accept", headers=auth(cast.alice)
    )

    assert accepted.status_code == 200
    assert _who_did_what(await _inbox(client, cast.eve)) == [("愛麗絲", "friend_accepted")]
    # 邀請不在等了：收件人那一則不再顯示，未讀數也不算它。
    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0


@pytest.mark.parametrize(
    ("who_deletes", "box", "other"),
    [("alice", "incoming", "eve"), ("eve", "outgoing", "alice")],
)
async def test_rejecting_or_withdrawing_hides_the_request_notice(
    client, cast, who_deletes, box, other
):
    await _send_request(client, cast.eve, cast.alice)
    assert len(await _inbox(client, cast.alice)) == 1
    actor = getattr(cast, who_deletes)
    request_id = await _pending_id(client, actor, box, getattr(cast, other))

    deleted = await client.delete(f"/api/friends/requests/{request_id}", headers=auth(actor))

    assert deleted.status_code == 204
    assert await _inbox(client, cast.alice) == []


async def test_sending_to_someone_who_already_asked_makes_friends_and_tells_them(client, cast):
    """阿丁的邀請還在等（`make_cast`）；愛麗絲用他的好友碼送邀請 → 直接成立。"""
    response = await _send_request(client, cast.alice, cast.dan)

    assert response.json()["status"] == "accepted"
    assert _who_did_what(await _inbox(client, cast.dan)) == [("愛麗絲", "friend_accepted")]
    assert await _inbox(client, cast.alice) == []


async def test_asking_again_after_a_rejection_leaves_one_fresh_notice(client, db_session, cast):
    await _send_request(client, cast.eve, cast.alice)
    [first] = await _inbox(client, cast.alice)
    await client.post(
        "/api/notifications/read-all", headers=auth(cast.alice), json={"up_to": first["id"]}
    )
    request_id = await _pending_id(client, cast.alice, "incoming", cast.eve)
    await client.delete(f"/api/friends/requests/{request_id}", headers=auth(cast.alice))

    await _send_request(client, cast.eve, cast.alice)

    [again] = await _inbox(client, cast.alice)  # 一則，不是兩則
    assert again["id"] != first["id"] and again["is_read"] is False
    total = await db_session.scalar(select(func.count()).select_from(Notification))
    assert total == 1


async def test_unfriending_hides_the_accepted_notice(client, db_session, cast):
    await _send_request(client, cast.eve, cast.alice)
    request_id = await _pending_id(client, cast.alice, "incoming", cast.eve)
    await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(cast.alice))
    assert len(await _inbox(client, cast.eve)) == 1

    await unfriend(db_session, cast.alice, cast.eve)

    assert await _inbox(client, cast.eve) == []


async def test_becoming_friends_again_keeps_their_older_notifications(client, db_session, cast):
    """好友通知「只留最新一則」的那個 DELETE 不能掃到讚與留言的通知。"""
    await _like(client, cast.bob, cast.meal)
    await unfriend(db_session, cast.alice, cast.bob)
    await _send_request(client, cast.bob, cast.alice)
    request_id = await _pending_id(client, cast.alice, "incoming", cast.bob)
    await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(cast.alice))

    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]
```

Run → Expected：FAIL（清單是空的）。

- [ ] **Step 2：實作。** `app/notifications.py` 加：

```python
_FRIEND_TYPES = (NotificationType.FRIEND_REQUEST, NotificationType.FRIEND_ACCEPTED)


async def notify_friend(
    db: AsyncSession, *, to: int, actor: int, kind: NotificationType
) -> None:
    """好友邀請（`to` 收到 `actor` 的邀請）或接受（`actor` 接受了 `to` 的邀請）。

    先刪掉同一個方向的舊好友通知：拒絕之後再邀請、解除之後再加回來，都只有最新的一則。"""
    await db.execute(
        delete(Notification).where(
            Notification.user_id == to,
            Notification.actor_id == actor,
            Notification.type.in_(_FRIEND_TYPES),
        )
    )
    db.add(Notification(user_id=to, actor_id=actor, type=kind))
```

`app/api/routes/friends.py`（import `notify_friend`、`NotificationType`）：

```python
# _insert_request：try 區塊改成
    try:
        # 先 flush 讓唯一約束說話：下面的 DELETE 會觸發 autoflush，IntegrityError 要落在這個 try 裡。
        await db.flush()
        await notify_friend(
            db,
            to=user_b if requested_by == user_a else user_a,
            actor=requested_by,
            kind=NotificationType.FRIEND_REQUEST,
        )
        await db.commit()
    except IntegrityError:
        # （原本的處理不動）

# _accept：`accepted_at, user_a, user_b = row` 之後、return 之前
    other_id = user_b if user_a == receiver_id else user_a
    # 跟接受在同一個交易：呼叫端 commit 才成立，接受落空（rollback）就不會留下通知。
    await notify_friend(
        db, to=other_id, actor=receiver_id, kind=NotificationType.FRIEND_ACCEPTED
    )
    return _Accepted(since=accepted_at, other_id=other_id)
```

- [ ] **Step 3：跑。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_notifications.py tests/test_friend_requests.py tests/test_friend_meals.py`
Expected：`test_notifications.py` **28 passed**（20＋8）；`test_friend_requests.py` **一條都不能紅**——它有三條用 monkeypatch 建構競態的測試（`_load_pair` 第一次看不到、`_accept` 落空），`_insert_request` 的 `IntegrityError` 路徑變了就會在那裡現形。掃描測試照舊綠（`friends.py` 本來就在兩份名單裡）。

- [ ] **Step 4：突變。**

| 突變 | 該紅的 |
|---|---|
| `_insert_request` 的 `to=` 寫反（通知寄給送邀請的人） | `test_a_friend_request_tells_the_receiver`（CHECK `not_self` 擋成例外——照實記） |
| `_insert_request` 拿掉 `await db.flush()` | `test_friend_requests.py` 的並行互送那一條**可能仍然綠**（autoflush 的例外也落在 try 裡）——那行是讓順序明確，不是唯一的保證；照實記 |
| `notify_friend` 拿掉前面的 `delete` | `test_asking_again_after_a_rejection…` |
| `delete` 拿掉 `type.in_(…)` | `test_becoming_friends_again_keeps_their_older_notifications` |
| `_accept` 不寫通知 | `test_accepting_tells_the_sender…`、`test_sending_to_someone_who_already_asked…` |
| `notification_visible` 的 `still_pending` 拿掉 `requested_by == actor_id` | **預期存活**（一對人只有一列 pending，方向不對的通知寫不出來）；照實記 |
| `still_pending` 的 `PENDING` 改成 `ACCEPTED` | `test_a_friend_request_tells_the_receiver`、`test_accepting_tells_the_sender…` |

- [ ] **Step 5：整套、commit。** 這個 task 動了 `routes/friends.py`（沒有改 docstring 的話 `schema.d.ts` 不會變——**照樣重新產生一次**確認 `git diff --stat frontend/src/api/schema.d.ts` 是空的）。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/notifications.py app/api/routes/friends.py tests/test_notifications.py
git commit -F "$S/social-plan-task6-msg.txt"   # feat(backend): 好友邀請與接受也有通知
```

後端到這裡做完。量一次：`./.venv/Scripts/python.exe -m pytest -q -W error` 的條數、`grep -c "@router\." app/api/routes/*.py` 的加總（Expected：79＋8＝**87**），記下來給 Task 12。

---

## Task 7：前端——API 層、query 鍵、不進離線快取

`schema.d.ts` 在 Task 2–6 已經跟著每個後端 commit 重新產生；這裡先確認一次是最新的（照「執行環境」的指令再跑一次，`git diff --stat` 應該是空的）。

**Files:**
- Create: `frontend/src/api/social.ts`、`frontend/src/api/notifications.ts`、`frontend/tests/social-api.test.tsx`
- Modify: `frontend/src/api/queries.ts`、`frontend/src/api/persist.ts`、`frontend/src/api/friends.ts`（`required` 加 `export`）、`frontend/tests/offline.test.tsx`

- [x] **Step 1：鍵與離線快取。** `queries.ts` 的 `queryKeys` 加：

```ts
	// 社群（讚、留言、通知）一律在 "social" 底下：`persist.ts` 靠第一個字不把它們存進
	// localStorage——別人的名字與留言不留在這台裝置上（社群規格 D21）。
	socialMeal: (mealId: number) => ["social", "meal", mealId] as const,
	notifications: ["social", "notifications"] as const,
	unreadCount: ["social", "unread"] as const,
	// 所有好友的所有「某一天」（寫回讚的數字時用）。
	friendDays: ["friends", "day"] as const,
```

`persist.ts` 的 `NOT_PERSISTED` 加 `"social",`（上面的註解補一句理由）。

- [x] **Step 2：`src/api/social.ts`。**

```ts
import {
	type InfiniteData,
	type QueryClient,
	useQuery,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import { retryUnlessNotFound } from "./errors";
import { type FriendDay, type FriendFeedPage, required } from "./friends";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type SocialMeal = components["schemas"]["SocialMealResponse"];
export type MealComment = components["schemas"]["CommentResponse"];
export type LikeState = components["schemas"]["LikeState"];

/** 留言的上限（code point；後端在清理之後量，見 `app/schemas/social.py`）。 */
export const COMMENT_MAX_LENGTH = 200;

/** 一餐與它的讚、留言。自己的餐與看得到的好友的餐都用這個；看不到是 404（不重試）。
 *  `staleTime: 0`：別人隨時會按讚、留言，每次打開都重抓。 */
export function useSocialMeal(mealId: number) {
	return useQuery({
		queryKey: queryKeys.socialMeal(mealId),
		queryFn: () =>
			required(apiFetch<SocialMeal>(`/api/social/meals/${mealId}`), "餐點"),
		enabled: Number.isFinite(mealId),
		staleTime: 0,
		retry: retryUnlessNotFound,
	});
}

/** 按讚（`true`）或收回（`false`）。兩個方向都冪等，回伺服器現在的數字。 */
export function setLike(mealId: number, liked: boolean) {
	return required(
		apiFetch<LikeState>(`/api/social/meals/${mealId}/like`, {
			method: liked ? "PUT" : "DELETE",
		}),
		"讚",
	);
}

export function postComment(mealId: number, body: string) {
	return required(
		apiFetch<MealComment>(`/api/social/meals/${mealId}/comments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body }),
		}),
		"留言",
	);
}

export async function deleteComment(
	mealId: number,
	commentId: number,
): Promise<void> {
	await apiFetch(`/api/social/meals/${mealId}/comments/${commentId}`, {
		method: "DELETE",
	});
}

/** 把伺服器回來的讚寫回每一份快取裡的這一餐（好友動態的每一頁、好友的某一天、餐點頁）。
 *
 *  **不用 `invalidateQueries`**：好友動態是 infinite query，失效＝每按一次讚就把載入過的
 *  每一頁重抓一遍。自己的餐點清單（`["meals"]`）不用管：主人不能讚自己的餐。 */
export function patchLikes(
	queryClient: QueryClient,
	mealId: number,
	state: LikeState,
): void {
	const apply = <T extends { id: number }>(meal: T): T =>
		meal.id === mealId ? { ...meal, ...state } : meal;
	queryClient.setQueriesData<InfiniteData<FriendFeedPage>>(
		{ queryKey: queryKeys.friendFeed },
		(data) =>
			data && {
				...data,
				pages: data.pages.map((page) => ({
					...page,
					meals: page.meals.map(apply),
				})),
			},
	);
	queryClient.setQueriesData<FriendDay>(
		{ queryKey: queryKeys.friendDays },
		(data) => data && { ...data, meals: data.meals.map(apply) },
	);
	queryClient.setQueryData<SocialMeal>(
		queryKeys.socialMeal(mealId),
		(data) => data && { ...data, meal: apply(data.meal) },
	);
}

/** 留言新增或刪除之後：這一餐重抓；各個清單上的「留言 N」標成過期（掛著的才會重抓——
 *  在餐點頁上時清單沒掛著，回去的時候才抓）。 */
export function afterCommentChange(
	queryClient: QueryClient,
	mealId: number,
): Promise<void> {
	void queryClient.invalidateQueries({ queryKey: queryKeys.friendFeed });
	void queryClient.invalidateQueries({ queryKey: queryKeys.friendDays });
	void queryClient.invalidateQueries({ queryKey: queryKeys.meals });
	return queryClient.invalidateQueries({
		queryKey: queryKeys.socialMeal(mealId),
	});
}
```

- [x] **Step 3：`src/api/notifications.ts`。**

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { required } from "./friends";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type NotificationItem = components["schemas"]["NotificationItem"];

/** 未讀數多久重抓一次（規格 D16）。沒有推播：這就是「最慢多久看到新通知」。 */
export const UNREAD_POLL_MS = 60_000;

export function useNotifications() {
	return useQuery({
		queryKey: queryKeys.notifications,
		queryFn: async () =>
			(
				await required(
					apiFetch<{ items: NotificationItem[] }>("/api/notifications"),
					"通知",
				)
			).items,
		staleTime: 0,
	});
}

/** 分頁上的數字。`staleTime: 0`＋預設的 `refetchOnWindowFocus`：回到這個視窗就重抓；
 *  `refetchInterval`：畫面看得到時每分鐘一次（`refetchIntervalInBackground` 預設 false，
 *  分頁在背景時不抓）。`retry: false`：下一輪自己會再試，不用疊重試。 */
export function useUnreadCount() {
	return useQuery({
		queryKey: queryKeys.unreadCount,
		queryFn: async () =>
			(
				await required(
					apiFetch<{ count: number }>("/api/notifications/unread-count"),
					"未讀數",
				)
			).count,
		staleTime: 0,
		refetchInterval: UNREAD_POLL_MS,
		retry: false,
	});
}

/** 把 `upTo` 以前的標成已讀，回剩下的未讀數。 */
export async function markAllRead(upTo: number): Promise<number> {
	const body = await required(
		apiFetch<{ count: number }>("/api/notifications/read-all", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ up_to: upTo }),
		}),
		"已讀",
	);
	return body.count;
}
```

- [x] **Step 4：測試。** `tests/social-api.test.tsx`（`QueryClient` 直接操作，不用畫面；`beforeEach` 照 `tests/friend-feed.test.tsx`——沒有 `setTokens` 的話 `mockApi` 一律回 401）：

1. **`patchLikes` 三種形狀**：`setQueryData` 塞一個兩頁的好友動態（`{ pages: [{ meals: [m(7), m(8)], next_cursor: "x" }, { meals: [m(9)], next_cursor: null }], pageParams: [null, "x"] }`）、一個 `friendDay(2, "2026-10-06")`、一個 `socialMeal(8)`，每一餐 `like_count: 0, liked_by_me: false`。`patchLikes(client, 8, { like_count: 3, liked_by_me: true })` 之後：三處的第 8 餐都是 `(3, true)`；**第 7、9 餐沒變**；`pageParams` 與 `next_cursor` 原封不動；`socialMeal(8)` 的 `likes`／`comments` 沒被動到。
2. **沒有那個快取時不會憑空生一個**：空的 client 上呼叫 `patchLikes` → `getQueryData(queryKeys.socialMeal(8))` 是 `undefined`。
3. **`setLike` 的方法**：`mockApi` 記下 `init.method`——`true` 是 `PUT`、`false` 是 `DELETE`，路徑 `/api/social/meals/8/like`。
4. **`markAllRead`**：送出的 body 是 `{"up_to":41}`，回 `count`。
5. **`useUnreadCount` 的設定**（釘住設定，不用假時鐘去等一分鐘）：

```tsx
it("未讀數：每 60 秒、只在前景、不重試", async () => {
	mockApi([
		{ path: "/api/notifications/unread-count", handler: () => json({ count: 3 }) },
	]);
	const client = new QueryClient();
	const { result } = renderHook(() => useUnreadCount(), {
		wrapper: ({ children }) => (
			<QueryClientProvider client={client}>{children}</QueryClientProvider>
		),
	});
	await waitFor(() => expect(result.current.data).toBe(3));

	const options = client.getQueryCache().find({ queryKey: queryKeys.unreadCount })
		?.observers[0]?.options;
	expect(options?.refetchInterval).toBe(60_000);
	expect(options?.refetchIntervalInBackground ?? false).toBe(false);
	expect(options?.staleTime).toBe(0);
	expect(options?.retry).toBe(false);
});
```

`tests/offline.test.tsx`：照 798 行「好友的資料與照片都不會被寫進 localStorage」**複製一條**「讚、留言、通知都不會被寫進 localStorage」——`setQueryData` 三個鍵（`socialMeal(1)` 放一個帶留言的物件、`notifications` 放一則、`unreadCount` 放 `3`），等到 `stats` 出現在 localStorage 裡，斷言三個鍵都不在，**而且 `localStorage` 的原始字串裡沒有那則留言的文字**。

Run：`npx vitest run tests/social-api.test.tsx tests/offline.test.tsx 2>&1 | grep -E "FAIL|Unhandled|Tests|Test Files"`
Expected：全綠。

- [x] **Step 5：突變。**

| 突變 | 該紅的 |
|---|---|
| `NOT_PERSISTED` 拿掉 `"social"` | 新的離線測試 |
| `socialMeal` 的鍵改成 `["meals", "social", id]` | 新的離線測試（它會被存進去） |
| `patchLikes` 的 `apply` 拿掉 `meal.id === mealId`（每一餐都改） | 第 1 條（第 7、9 餐） |
| `patchLikes` 拿掉好友動態那一段；拿掉某一天那一段；拿掉餐點頁那一段 | 第 1 條的各一半 |
| `setQueryData` 的 updater 拿掉 `data &&` | 第 2 條（`TypeError`） |
| `setLike` 兩個方法對調 | 第 3 條 |
| `refetchInterval` 拿掉 | 第 5 條 |

- [x] **Step 6：commit。** `npm run -s lint && npm run -s test 2>&1 | grep -E "FAIL|Unhandled|Tests |Test Files"`，再單獨跑 `npm run -s typecheck`。

```bash
git add frontend/src/api/social.ts frontend/src/api/notifications.ts frontend/src/api/queries.ts frontend/src/api/persist.ts frontend/src/api/friends.ts frontend/tests/social-api.test.tsx frontend/tests/offline.test.tsx
git commit -F "$S/social-plan-task7-msg.txt"   # feat(frontend): 社群的 API 層——query 都在 social 底下、不進離線快取
```

---

## Task 8：前端——讚的按鈕與卡片上的數字

**Files:**
- Create: `frontend/src/components/LikeButton.tsx`、`LikeButton.module.css`、`frontend/tests/like-button.test.tsx`
- Modify: `frontend/src/components/ui.module.css`、`FriendMealCard.tsx`、`FriendMealCard.module.css`、`frontend/src/screens/MealList.tsx`、`MealList.module.css`、`frontend/tests/friend-feed.test.tsx`、`friend-day.test.tsx`、`meal-list.test.tsx`

- [x] **Step 1：`ui.srOnly`。** `ui.module.css` 檔尾（一般的 class，不放在 `:where()` 裡）：

```css
/* 只給螢幕閱讀器的文字（未讀數、讚的數量的完整講法）。不能用 display: none——
   那樣 aria-describedby 指過來也唸不到。 */
.srOnly {
	position: absolute;
	width: 1px;
	height: 1px;
	margin: -1px;
	padding: 0;
	overflow: hidden;
	clip-path: inset(50%);
	white-space: nowrap;
	border: 0;
}
```

- [x] **Step 2：測試（先寫）。** `tests/like-button.test.tsx`。包一層 `QueryClientProvider`；回應用**可以手動放行的 Promise**（`let release!: (r: Response) => void; handler: () => new Promise<Response>((resolve) => { release = resolve; })`），這樣「第一個請求還在路上時再按一下」是確定性的，不靠時間：

| # | 情境 | 斷言 |
|---|---|---|
| 1 | 初始 `count=2, liked=false` | `getByRole("button", { name: "讚，鮑伯的午餐", pressed: false })`；`toHaveAccessibleDescription("2 個讚")` |
| 2 | 按一下，回應還沒放行 | 立刻 `pressed: true`、描述「3 個讚」；`spy` 只有一個 `PUT …/meals/7/like` |
| 3 | 放行 `{ like_count: 5, liked_by_me: true }`（伺服器的數字跟樂觀的不一樣） | 事先 `setQueryData(queryKeys.socialMeal(7), …)`；放行後那份快取的 `meal.like_count` 是 **5**（`waitFor`）——證明寫回的是伺服器的數字，不是自己加一 |
| 4 | **連按兩下**：按 → 不放行 → 再按 → 放行第一個 → 放行第二個 | 第二下之後畫面是 `pressed: false`、「2 個讚」；第一個放行**之前**只有一個請求；放行後第二個請求是 `DELETE`；最後 `mock.calls` 的方法依序是 `["PUT", "DELETE"]`，快取是第二個回應 |
| 5 | **連按三下**（按、按、按，第一個還沒回來） | 最後的請求依序 `["PUT", "PUT"]`（最後的意圖是「讚」，中間那個「收回」沒有送）；畫面 `pressed: true` |
| 6 | 失敗（500） | 先等 `role="alert"`「沒有送出，請再試一次」出現，再斷言 `pressed: false`、「2 個讚」 |
| 7 | 429 帶 `retry-after: 12` | alert 是「按得太快了，請稍後再試（12 秒後可再試）」 |
| 8 | 第二個請求失敗（連按兩下，PUT 成功、DELETE 500） | 快取被寫成 **PUT 的回應**（伺服器現在是「讚」），不是退回一開始的「沒讚」；alert 出現 |
| 9 | 失敗之後再按一下成功 | alert 消失 |
| 10 | 按鈕一直是可以按的 | 任何時候都沒有 `disabled`、沒有 `aria-disabled` |

第 3、4、8 條的元件要從快取拿 props 才看得到寫回——測試裡包一個小元件：`const meal = useQuery({ queryKey: queryKeys.socialMeal(7), queryFn: … , staleTime: Infinity }).data.meal`，把 `like_count`／`liked_by_me` 傳給 `LikeButton`。`invalidateQueries` 會讓它重抓：`/api/social/meals/7`（GET）的路由排在 `…/7/like` **後面**（第 8 點），回跟最後一個讚的回應一致的資料。

Run → Expected：FAIL（transform error：`LikeButton` 不存在）。

- [x] **Step 3：`LikeButton.tsx`。**

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import { queryKeys } from "../api/queries";
import { type LikeState, patchLikes, setLike } from "../api/social";
import styles from "./LikeButton.module.css";
import ui from "./ui.module.css";

type Props = {
	mealId: number;
	/** 這是誰的哪一餐（「鮑伯的午餐」）：一頁有好幾顆，螢幕閱讀器要分得出來。 */
	label: string;
	count: number;
	liked: boolean;
};

function describeError(caught: unknown): string {
	if (caught instanceof ApiError && caught.status === 429) {
		return caught.retryAfterSeconds !== null
			? `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`
			: caught.message;
	}
	return "沒有送出，請再試一次";
}

/** 讚（社群規格 D18、D19）。
 *
 *  **名稱固定、狀態用 `aria-pressed`**：名稱跟著狀態換（「按讚」／「收回讚」）再加
 *  `aria-pressed`，會唸成「收回讚，已按下」。數字用 `aria-describedby`。
 *
 *  **連按**：畫面立刻照最後一次按的意圖變；請求一次一個，送完再看 `wanted`——
 *  還有沒送的意圖就再送。所以請求不會亂序，最後的狀態一定等於最後一次按的。
 *  按鈕從來不會變成不能按。 */
export function LikeButton({ mealId, label, count, liked }: Props) {
	const queryClient = useQueryClient();
	const countId = useId();
	// 樂觀的狀態：有值就蓋過 props。伺服器的回應寫進快取（props 跟著變）之後清掉。
	const [optimistic, setOptimistic] = useState<LikeState | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 最後一次按下去想要的狀態；null＝沒有還沒送的意圖。
	const wanted = useRef<boolean | null>(null);
	const sending = useRef(false);
	const shown = optimistic ?? { like_count: count, liked_by_me: liked };

	async function toggle() {
		const next = !shown.liked_by_me;
		setError(null);
		setOptimistic({
			liked_by_me: next,
			like_count: Math.max(0, shown.like_count + (next ? 1 : -1)),
		});
		wanted.current = next;
		// 已經有一輪在送：它送完會看到上面這個 wanted。
		if (sending.current) return;
		sending.current = true;

		// 這一輪裡最後一次**成功**的回應＝伺服器現在的狀態。
		let server: LikeState | null = null;
		let failure: unknown;
		try {
			while (wanted.current !== null) {
				const target: boolean = wanted.current;
				wanted.current = null;
				server = await setLike(mealId, target);
			}
		} catch (caught) {
			failure = caught ?? new Error("unknown");
			wanted.current = null;
		}
		sending.current = false;
		// 從這裡到函式結束沒有 await：不會有另一次按下插在「寫快取」與「清掉樂觀狀態」中間。
		if (server !== null) {
			patchLikes(queryClient, mealId, server);
			// 餐點頁的名單（誰按了讚）要重抓；數字已經在上面寫好了。
			void queryClient.invalidateQueries({
				queryKey: queryKeys.socialMeal(mealId),
			});
		}
		// 失敗：退回伺服器的狀態——props（一個都沒成功），或上面寫進快取的那一個。
		setOptimistic(null);
		if (failure !== undefined) setError(describeError(failure));
	}

	return (
		<span className={styles.wrap}>
			<button
				type="button"
				className={styles.like}
				aria-pressed={shown.liked_by_me}
				aria-label={`讚，${label}`}
				aria-describedby={countId}
				onClick={() => void toggle()}
			>
				<Heart
					aria-hidden="true"
					size={20}
					className={shown.liked_by_me ? styles.on : undefined}
				/>
				<span id={countId}>
					<span aria-hidden="true">{shown.like_count}</span>
					<span className={ui.srOnly}>{shown.like_count} 個讚</span>
				</span>
			</button>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</span>
	);
}
```

`LikeButton.module.css`：`.wrap { position: relative; display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }`；`.like { display: inline-flex; align-items: center; gap: var(--space-1); min-width: 44px; min-height: 44px; padding: 0 var(--space-2); border: 0; background: none; color: var(--color-text-muted); font: inherit; cursor: pointer; }`；`.on { color: var(--color-danger); fill: currentColor; }`；`.error { margin: 0; color: var(--color-danger); font-size: 13px; }`。間距變數用 `index.css` 裡真的有的（`--space-1` 沒有就用 `--space-2`）；**只用變數，不寫色碼**（`tests/css-tokens.test.ts`）。

- [x] **Step 4：卡片。**

`FriendMealCard.tsx`——`<p className={styles.macros}>` 後面加一列（`Link`、`LikeButton` 的 import；把檔案裡的 `FriendPhoto` 改成 `export`，Task 9 要用）：

```tsx
			<div className={styles.social}>
				<LikeButton
					mealId={meal.id}
					label={`${meal.user.display_name}的${MEAL_TYPE_LABELS[meal.meal_type]}`}
					count={meal.like_count ?? 0}
					liked={meal.liked_by_me ?? false}
				/>
				<Link
					to={`/meals/${meal.id}`}
					className={styles.comments}
					aria-label={`${meal.user.display_name}的${MEAL_TYPE_LABELS[meal.meal_type]}，留言 ${meal.comment_count ?? 0} 則`}
				>
					留言 {meal.comment_count ?? 0}
				</Link>
			</div>
```

`MealList.tsx` 的 `MealCard`——`<p className={styles.total}>` 後面：

```tsx
			<div className={styles.social}>
				{/* 自己的餐不能按讚（後端 422）：只顯示數字，0 就不畫。 */}
				{(meal.like_count ?? 0) > 0 && (
					<span className={styles.likes}>
						<Heart aria-hidden="true" size={16} />
						<span aria-hidden="true">{meal.like_count}</span>
						<span className={ui.srOnly}>{meal.like_count} 個讚</span>
					</span>
				)}
				{/* 名稱帶時間與餐別，理由同上面的「編輯」。 */}
				<Link
					to={`/meals/${meal.id}`}
					className={styles.comments}
					aria-label={`${formatTime(meal.eaten_at)} ${MEAL_TYPE_LABELS[meal.meal_type]}，留言 ${meal.comment_count ?? 0} 則`}
				>
					留言 {meal.comment_count ?? 0}
				</Link>
			</div>
```

`?? 0` 不是多餘的：離線快取裡的舊餐、沒有型別標註的測試資料都沒有這幾個欄位（第 11 點）。biome 如果抱怨「型別上不可能是 undefined」就照 `meal.description ?` 那一段的註解寫法留一句理由。兩個 CSS 檔各加 `.social`（`display: flex; align-items: center; gap: var(--space-3); margin-top: var(--space-2);`）、`.comments`（`display: inline-flex; align-items: center; min-height: 44px; color: var(--color-action); text-decoration: none;`）、`MealList` 另加 `.likes`（`position: relative; display: inline-flex; align-items: center; gap: 4px; color: var(--color-text-muted);`）。

- [x] **Step 5：卡片的測試。**

- `friend-feed.test.tsx`：`friendMeal()` 加 `like_count: 2, comment_count: 3, liked_by_me: true`。新增：卡片上有 `button { name: "讚，鮑伯的午餐", pressed: true }`、`link { name: "鮑伯的午餐，留言 3 則" }` 的 `href` 是 `/meals/7`。新增一條「在動態上按讚不會重抓動態」：按一下（`DELETE` 回 `{ like_count: 1, liked_by_me: false }`）→ 等描述變成「1 個讚」→ `spy.mock.calls` 裡 `/api/friends/feed` **仍然只有一次**（先等到數字變了才斷言，第 41 種）。
- `friend-day.test.tsx`：同樣補欄位；一條斷言按鈕與連結都在。
- `meal-list.test.tsx`：`like_count: 2, comment_count: 1` → 有「2 個讚」的文字、**沒有**任何 `讚` 的按鈕、連結 `href="/meals/<id>"`；`like_count: 0` → 沒有「個讚」；**完全沒有這兩個欄位的舊資料** → 連結文字是「留言 0」、畫面沒有 `undefined`／`NaN`。

Run：`npx vitest run tests/like-button.test.tsx tests/friend-feed.test.tsx tests/friend-day.test.tsx tests/meal-list.test.tsx tests/css-tokens.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Test Files"`

- [x] **Step 6：突變。**

| 突變 | 該紅的 |
|---|---|
| `if (sending.current) return;` 拿掉 | #4（第一個放行之前就有兩個請求） |
| `wanted.current = null;`（迴圈裡那一行）拿掉 | #2 之後的每一條都跑不完——**不要跑這個突變**（無限迴圈，handover §7） |
| 迴圈改成只送一次（`if` 取代 `while`） | #4（沒有 `DELETE`） |
| `patchLikes(queryClient, mealId, server)` 拿掉 | #3、#8 |
| 成功之後不 `setOptimistic(null)` | #3（畫面停在樂觀的 3，不是伺服器的 5） |
| 失敗時不 `setOptimistic(null)` | #6 |
| `setError(null)` 拿掉 | #9 |
| `aria-pressed` 拿掉；`aria-describedby` 拿掉 | #1 |
| `FriendMealCard` 的 `?? 0` 拿掉 | 型別上不會紅；`friend-day`／`friend-feed` 裡**沒有帶欄位**的那些既有測試會出現「讚，…」描述是 `undefined 個讚`——補一條斷言「舊資料畫出 0 個讚」讓它紅 |
| `MealList` 的 `> 0` 改成 `>= 0` | `like_count: 0` 那一條 |

- [x] **Step 7：commit。** `npm run -s lint && npm run -s test 2>&1 | grep -E "FAIL|Unhandled|Tests |Test Files"`；單獨 `npm run -s typecheck`；掃看不見的字元。

```bash
git add frontend/src/components/LikeButton.tsx frontend/src/components/LikeButton.module.css frontend/src/components/ui.module.css frontend/src/components/FriendMealCard.tsx frontend/src/components/FriendMealCard.module.css frontend/src/screens/MealList.tsx frontend/src/screens/MealList.module.css frontend/tests/like-button.test.tsx frontend/tests/friend-feed.test.tsx frontend/tests/friend-day.test.tsx frontend/tests/meal-list.test.tsx
git commit -F "$S/social-plan-task8-msg.txt"   # feat(frontend): 讚的按鈕（樂觀更新、連按照最後的意圖）；卡片上的讚與留言數
```

---

## Task 9：前端——餐點頁 `/meals/:id` 與留言

**Files:**
- Create: `frontend/src/screens/MealDetail.tsx`、`MealDetail.module.css`、`frontend/src/components/CommentForm.tsx`、`CommentList.tsx`、`Comments.module.css`、`frontend/tests/meal-detail.test.tsx`、`comment-form.test.tsx`
- Modify: `frontend/src/App.tsx`、`frontend/src/api/friends.ts`（`forgetFriend`）、`frontend/src/api/queries.ts`、`frontend/tests/layout.test.ts`、`frontend/tests/friends-card.test.tsx`

- [ ] **Step 1：`CommentForm.tsx`**（整份——焦點與 `aria-disabled` 是這個 task 最容易錯的地方）：

```tsx
import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import {
	afterCommentChange,
	COMMENT_MAX_LENGTH,
	postComment,
} from "../api/social";
import styles from "./Comments.module.css";
import ui from "./ui.module.css";

/** 剩這麼多字以內才顯示「還可以輸入 N 個字」。 */
const HINT_WITHIN = 20;

function describeError(caught: unknown): string {
	if (caught instanceof ApiError && caught.status === 429) {
		return caught.retryAfterSeconds !== null
			? `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`
			: caught.message;
	}
	if (caught instanceof ApiError && caught.status === 404) {
		return "看不到這一餐了，沒有送出";
	}
	return "沒有送出，請再試一次";
}

export function CommentForm({ mealId }: { mealId: number }) {
	const queryClient = useQueryClient();
	const inputId = useId();
	const hintId = useId();
	const inputRef = useRef<HTMLInputElement>(null);
	const [text, setText] = useState("");
	const [pending, setPending] = useState(false);
	const busy = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);

	// code point，不是 UTF-16 的長度：一個表情符號算一個字，跟後端一致。
	// 後端量的是清理（去頭尾、壓空白）之後的長度，只會比這裡短，不會比這裡長。
	const length = Array.from(text.trim()).length;
	const left = COMMENT_MAX_LENGTH - length;
	const blocked = length === 0 || left < 0 || pending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		// aria-disabled 的按鈕照樣收得到點擊與 Enter：在這裡擋，並把焦點放回輸入框。
		if (blocked || busy.current) {
			inputRef.current?.focus();
			return;
		}
		busy.current = true;
		setPending(true);
		setError(null);
		setSent(false);
		try {
			await postComment(mealId, text);
			setText("");
			setSent(true);
			// 等這一餐重抓完：新留言出現在清單裡之後才放開送出鍵。
			await afterCommentChange(queryClient, mealId);
		} catch (caught) {
			setError(describeError(caught));
		} finally {
			busy.current = false;
			setPending(false);
			// 按的是送出鍵的話焦點在按鈕上：放回輸入框，可以接著打下一則。
			inputRef.current?.focus();
		}
	}

	return (
		<form className={styles.form} onSubmit={(event) => void submit(event)}>
			<label htmlFor={inputId}>留言</label>
			<div className={styles.row}>
				<input
					id={inputId}
					ref={inputRef}
					type="text"
					value={text}
					autoComplete="off"
					enterKeyHint="send"
					aria-describedby={hintId}
					aria-invalid={left < 0}
					onChange={(event) => setText(event.target.value)}
				/>
				{/* aria-disabled，不是 disabled：送出中按鈕變成不能用時焦點不會被瀏覽器丟掉
				    （ExportCard 的慣例；handover §7「jsdom 與 disabled 的焦點」）。 */}
				<button type="submit" className={ui.primary} aria-disabled={blocked}>
					{pending ? "送出中…" : "送出"}
				</button>
			</div>
			<p id={hintId} className={styles.hint}>
				{left < 0
					? `超過 ${-left} 個字`
					: left <= HINT_WITHIN
						? `還可以輸入 ${left} 個字`
						: ""}
			</p>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{/* 區塊一直都在、先是空的（同 ExportCard）。 */}
			<div role="status">{sent && <p className={styles.hint}>已送出</p>}</div>
		</form>
	);
}
```

輸入框的字級 ≥ 16px（iOS 會放大，`e2e/mobile-form-zoom.spec.ts`）。

- [ ] **Step 2：`CommentList.tsx`。** `CommentList({ mealId, comments, truncated, onDeleted })`：

- `truncated` → 清單上面 `<p>只顯示最近 100 則</p>`。沒有留言 → `<p>還沒有留言</p>`。
- `<ol>`，每一列一個 `CommentRow`：`<span>{display_name}</span>`（`is_me` 時後面加「（我）」）、`<time dateTime={created_at}>{formatDateTime(created_at)}</time>`、`<p>{body}</p>`（文字節點；`overflow-wrap: anywhere`）。
- `can_delete` 的列：照 `Expenses.tsx` 的 `ExpenseRow` 做行內確認——`useState(confirming)`、`useConfirmFocus(confirming)`；「刪除」按鈕 `ref={confirmFocus.triggerRef}`、`aria-label={`刪除 ${display_name} 的留言`}`；確認框 `role="alertdialog" aria-label="確認刪除留言"`，裡面「確定刪除」（`ui.danger`，`aria-disabled={remove.isPending}`）與「取消」（`ref={confirmFocus.cancelRef}`，按下去先 `confirmFocus.cancelled()` 再關）。
- 刪除：`useMutation({ mutationFn })`，`COMMENT_NOT_FOUND` 當成功（別的裝置已經刪了，同 `EditMealItems`）。**收尾放在 `mutate(undefined, { onSuccess })`**（handover §7：會動到父層的事不放在 `useMutation` 的 `onSuccess`）：`await afterCommentChange(queryClient, mealId)` 之後呼叫 `onDeleted()`。失敗 → 列內 `role="alert"`「刪除失敗，請再試一次」，確認框留著。

- [ ] **Step 3：`MealDetail.tsx`。**

```tsx
export function MealDetail() {
	const mealId = Number(useParams().id);
	const query = useSocialMeal(mealId);
	const commentsHeading = useRef<HTMLHeadingElement>(null);

	// 404＝看不到（或剛被解除好友、改成私人）：就算快取裡還有舊資料也不顯示。
	const gone = query.error instanceof ApiError && query.error.status === 404;
	if (gone || !Number.isFinite(mealId)) {
		return (
			<section>
				<h1>餐點</h1>
				<p role="alert">看不到這一餐</p>
				<Link to="/diet" className={styles.back}>回飲食</Link>
			</section>
		);
	}
	if (query.data === undefined) {
		return query.isError ? <p role="alert">無法載入這一餐</p> : <p>載入中…</p>;
	}
	const { meal, is_mine, likes, comments, comments_truncated } = query.data;
	const label = `${is_mine ? "我" : meal.user.display_name}的${MEAL_TYPE_LABELS[meal.meal_type]}`;
	// …
}
```

版面由上到下（外層 `<section className={ui.screen}>`，卡片用 `Card`）：

1. `<h1>{label}</h1>`、`<p>{formatDateTime(meal.eaten_at)}</p>`；`is_mine` → `<Link to={`/meals/${meal.id}/edit`}>編輯</Link>`；不是自己的 → 名字連到 `/friends/${meal.user.id}`。
2. `meal.description ? <p>…</p> : null`。
3. 照片（`meal.has_photo`）：`is_mine ? <OwnPhoto mealId={meal.id} alt={label} /> : <FriendPhoto meal={meal} />`。**兩個元件分開**（hook 不能放在條件裡）：`FriendPhoto` 是 Task 8 從 `FriendMealCard.tsx` export 的；`OwnPhoto` 寫在這個檔案裡，照 `MealList.tsx` 的 `MealPhoto`（`useMealPhoto(mealId, "thumb")`＋`ZoomablePhoto`，`useFull={() => useMealPhoto(mealId)}`）。
4. 項目清單、合計（照 `FriendMealCard` 的寫法：`formatMacro`、`base_unit`）。
5. 讚：`is_mine` → `meal.like_count > 0` 時「♥ N」（同 `MealList` 的寫法）；否則 `<LikeButton mealId label count={meal.like_count} liked={meal.liked_by_me} />`。`likes.length > 0` → `<p>{likes.map((l) => (l.is_me ? "我" : l.display_name)).join("、")} 說讚</p>`。
6. `<h2 ref={commentsHeading} tabIndex={-1}>留言（{meal.comment_count}）</h2>`、`<CommentList … onDeleted={() => commentsHeading.current?.focus()} />`、`<CommentForm mealId={meal.id} />`。

`App.tsx`：`<Route path="/meals/:id" element={<MealDetail />} />`（放在 `/meals/:id/edit` 旁邊；react-router 依具體程度排名，`/meals/new` 仍然命中靜態那一條）。

`queries.ts` 加 `socialMeals: ["social", "meal"] as const`。`friends.ts` 的 `forgetFriend` 加三行——解除之後這個人寫的東西不該還留在記憶體的快取裡，自己餐點上的數字也變了：

```ts
	queryClient.removeQueries({ queryKey: queryKeys.socialMeals });
	void queryClient.invalidateQueries({ queryKey: queryKeys.notifications });
	void queryClient.invalidateQueries({ queryKey: queryKeys.unreadCount });
	void queryClient.invalidateQueries({ queryKey: queryKeys.meals });
```

- [ ] **Step 4：測試。**

`tests/comment-form.test.tsx`（`QueryClientProvider`；路由 `POST /api/social/meals/7/comments` 排在 `GET /api/social/meals/7` 前面）：

| # | 情境 | 斷言 |
|---|---|---|
| 1 | 空的 | 送出鍵 `aria-disabled="true"`、**不是** `disabled`；按下去沒有 POST（`spy.mock.calls` 裡沒有 `POST`），焦點在輸入框 |
| 2 | 只有空白 | 同上 |
| 3 | 打 180 個字 | 提示是空的；181 個字 →「還可以輸入 19 個字」；200 →「還可以輸入 0 個字」，可以送 |
| 4 | 201 個字 | 「超過 1 個字」、`aria-invalid="true"`、送出鍵 `aria-disabled`、按下去沒有 POST |
| 5 | 200 個表情符號（`String.fromCodePoint(0x1f600).repeat(200)`） | 可以送（`.length` 是 400——守的是用 code point 算） |
| 6 | 送出成功 | body 是 `{"body":"好吃嗎"}`；輸入框清空；`document.activeElement` 是輸入框；`role="status"` 裡有「已送出」；`GET /api/social/meals/7` 被重抓一次 |
| 7 | 送出中（回應不放行） | 送出鍵 `aria-disabled`、文字「送出中…」；再按一次沒有第二個 POST |
| 8 | 429 `retry-after: 30` | alert「留言太頻繁，請稍後再試（30 秒後可再試）」；**輸入框的字還在**；焦點在輸入框 |
| 9 | 500 | alert「沒有送出，請再試一次」；字還在 |
| 10 | 按 Enter 送出 | 跟按送出鍵一樣（`userEvent.type(input, "嗨{Enter}")`） |

`tests/meal-detail.test.tsx`（`MemoryRouter initialEntries={["/meals/7"]}`＋`Routes`；資料用一個 `socialMeal(overrides)` 工廠）：

| # | 情境 | 斷言 |
|---|---|---|
| 1 | 好友的餐 | `heading 鮑伯的午餐`；有讚的按鈕（`讚，鮑伯的午餐`）；**沒有**「編輯」；項目、合計、描述都在；「小卡、我 說讚」 |
| 2 | 自己的餐（`is_mine`） | `heading 我的午餐`；「編輯」連到 `/meals/7/edit`；**沒有**讚的按鈕；`like_count: 2` → 有「2 個讚」 |
| 3 | 照片用對的端點 | 好友：請求了 `/api/friends/2/meals/7/photo?size=thumb`、沒有 `/api/meals/7/photo`；自己的：反過來（先等圖片出現再斷言另一個沒被請求） |
| 4 | 留言 | 依序三則；時間在 `<time>`；`is_me` 的有「（我）」；只有 `can_delete` 的有刪除鈕 |
| 5 | 留言的內容是文字 | body 是 `<img src=x onerror=alert(1)>` → `getByText` 找得到原字串、`document.querySelector("img[src='x']")` 是 null |
| 6 | 截斷 | `comments_truncated: true` →「只顯示最近 100 則」；`false` → 沒有 |
| 7 | 刪除：取消 | 按「刪除 鮑伯 的留言」→ `alertdialog`、焦點在「取消」→ 取消 → 沒有 `DELETE`、焦點回到刪除鈕 |
| 8 | 刪除：確定 | `DELETE /api/social/meals/7/comments/31`；重抓後那一則不見；**焦點在「留言（N）」的標題** |
| 9 | 刪除失敗 | alert「刪除失敗，請再試一次」；那一則還在 |
| 10 | 刪除時已經不在（404 `COMMENT_NOT_FOUND`） | 沒有 alert，照樣重抓 |
| 11 | 404 `MEAL_NOT_FOUND` | 「看不到這一餐」＋「回飲食」連到 `/diet`；`GET` 只打一次（不重試） |
| 12 | 500 而且沒有快取 | 「無法載入這一餐」（重試會讓這條慢——測試的 `QueryClient` 設 `retry: false` 蓋不掉 hook 自己的 `retry` 函式；改用 `retryDelay: 0`） |

`tests/layout.test.ts`：表格加 `["/meals/5", "narrow"]`。`tests/friends-card.test.tsx`：334 行那一條「解除後好友的快取被移除」——事先多塞 `queryKeys.socialMeal(7)`，解除後是 `undefined`。

Run：`npx vitest run tests/comment-form.test.tsx tests/meal-detail.test.tsx tests/layout.test.ts tests/friends-card.test.tsx 2>&1 | grep -E "FAIL|Unhandled|Tests |Test Files"`

- [ ] **Step 5：突變。**

| 突變 | 該紅的 |
|---|---|
| `Array.from(text.trim()).length` 改成 `text.trim().length` | 表單 #5 |
| `aria-disabled={blocked}` 改成 `disabled={blocked}` | 表單 #1（「不是 `disabled`」） |
| `submit` 拿掉 `if (blocked …)` | 表單 #1、#2、#4、#7 |
| `setText("")` 搬到 `try` 外面（失敗也清） | 表單 #8、#9 |
| `finally` 拿掉 `inputRef.current?.focus()` | 表單 #6、#8（用**點擊**送出鍵的那幾條；Enter 送出的焦點本來就在輸入框） |
| `left <= HINT_WITHIN` 改成 `<` | 表單 #3（180 個字那一格） |
| `MealDetail` 的照片一律用 `FriendPhoto` | 詳情 #3 |
| `is_mine` 時也畫 `LikeButton` | 詳情 #2 |
| `onDeleted` 不接 | 詳情 #8 |
| `gone` 的判斷拿掉 | 詳情 #11 |
| `forgetFriend` 拿掉 `removeQueries(socialMeals)` | `friends-card` 那一條 |

- [ ] **Step 6：commit。** lint、整套測試、單獨 typecheck、掃看不見的字元。

```bash
git add frontend/src/screens/MealDetail.tsx frontend/src/screens/MealDetail.module.css frontend/src/components/CommentForm.tsx frontend/src/components/CommentList.tsx frontend/src/components/Comments.module.css frontend/src/App.tsx frontend/src/api/friends.ts frontend/src/api/queries.ts frontend/tests/meal-detail.test.tsx frontend/tests/comment-form.test.tsx frontend/tests/layout.test.ts frontend/tests/friends-card.test.tsx
git commit -F "$S/social-plan-task9-msg.txt"   # feat(frontend): 餐點頁 /meals/:id——讚、留言、刪留言
```

---

## Task 10：前端——通知頁、分頁上的未讀標記、「我的」的通知卡片

**Files:**
- Create: `frontend/src/screens/Notifications.tsx`、`Notifications.module.css`、`frontend/src/components/NotificationsCard.tsx`、`frontend/tests/notifications.test.tsx`
- Modify: `frontend/src/components/TabBar.tsx`、`TabBar.module.css`、`SideNav.tsx`、`SideNav.module.css`、`frontend/src/screens/Me.tsx`、`frontend/src/App.tsx`、`frontend/tests/tab-bar.test.tsx`、`side-nav.test.tsx`、`me.test.tsx`、`app.test.tsx`、`layout.test.ts`

- [ ] **Step 1：標記。** `TabBar` 與 `SideNav` 都多一個 prop **`unread?: number`（預設 0）**——**不在這兩個元件裡呼叫 `useUnreadCount`**（第 9 點）。`TabBar.tsx` 的 `TabLink`：

```tsx
function TabLink({ tab, unread }: { tab: NavTab; unread: number }) {
	const badgeId = useId();
	const Icon = tab.icon;
	return (
		<>
			<NavLink
				to={tab.to}
				end={tab.end}
				aria-describedby={unread > 0 ? badgeId : undefined}
				className={({ isActive }) =>
					isActive ? `${styles.tab} ${styles.active}` : styles.tab
				}
			>
				<Icon aria-hidden="true" size={22} />
				<span>{tab.label}</span>
				{/* aria-hidden：數字不進連結的名稱——名稱永遠是「我的」（社群規格 D17；
				    20 多處測試與 e2e 用這個名稱找它）。 */}
				{unread > 0 && (
					<span aria-hidden="true" className={styles.badge}>
						{unread > 9 ? "9+" : unread}
					</span>
				)}
			</NavLink>
			{/* 在連結**外面**：放裡面會併進名稱。position: absolute，不佔分頁列的位置。 */}
			{unread > 0 && (
				<span id={badgeId} className={ui.srOnly}>
					{unread} 則新通知
				</span>
			)}
		</>
	);
}
```

呼叫端：`<TabLink key={tab.to} tab={tab} unread={tab.to === "/me" ? unread : 0} />`。`SideNav.tsx` 的 `<li>` 裡做同樣的三件事（`aria-describedby`、`aria-hidden` 的標記、連結外面的隱藏文字）。CSS：`.tab`／`.link` 加 `position: relative`；`.badge { position: absolute; top: 4px; left: 50%; margin-left: 6px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 9px; background: var(--color-danger); color: var(--color-on-badge); font-size: 11px; line-height: 18px; text-align: center; }`（`SideNav` 的放在文字右邊：`position: static; margin-left: auto;`）。

- [ ] **Step 2：`App.tsx`。** `LoggedInShell` 裡：

```tsx
	const queryClient = useQueryClient();
	const unread = useUnreadCount().data ?? 0;
	// 換頁時也重抓一次未讀數：手機上的 PWA 很少有「視窗取得焦點」，最常發生的事是換頁。
	// 第一次掛載不抓——`useUnreadCount` 自己正在抓。
	const firstPath = useRef(true);
	// biome-ignore lint/correctness/useExhaustiveDependencies: pathname 是觸發條件，不是用到的值
	useEffect(() => {
		if (firstPath.current) {
			firstPath.current = false;
			return;
		}
		void queryClient.invalidateQueries({ queryKey: queryKeys.unreadCount });
	}, [pathname, queryClient]);
```

`<SideNav unread={unread} />`、`<TabBar unread={unread} />`；新路由 `<Route path="/notifications" element={<Notifications />} />`。（`useQueryClient` 在 `PersistQueryClientProvider` 底下拿得到；biome 不需要那個 ignore 的話會報「沒有作用的 suppression」，那就拿掉。）

- [ ] **Step 3：`Notifications.tsx`。**

```tsx
function describe(item: NotificationItem): { text: string; to: string } {
	const who = item.actor_name;
	const meal = item.meal ? MEAL_TYPE_LABELS[item.meal.meal_type] : "餐點";
	const mealPath = item.meal ? `/meals/${item.meal.id}` : "/diet";
	switch (item.type) {
		case "like":
			return { text: `${who} 對你的${meal}按了讚`, to: mealPath };
		case "comment":
			return {
				text: `${who} 在你的${meal}留言：${item.comment_preview ?? ""}`,
				to: mealPath,
			};
		case "friend_request":
			return { text: `${who} 想加你為好友`, to: "/me" };
		case "friend_accepted":
			return { text: `${who} 接受了你的好友邀請`, to: "/me" };
	}
}

export function Notifications() {
	const queryClient = useQueryClient();
	const query = useNotifications();
	const newest = query.data?.[0]?.id;
	const hasUnread = query.data?.some((item) => !item.is_read) ?? false;
	// 這一份清單已經送過已讀了（StrictMode 的 effect 會跑兩次；重抓回來同一份也不再送）。
	const marked = useRef<number | null>(null);

	useEffect(() => {
		if (newest === undefined || !hasUnread || marked.current === newest) return;
		marked.current = newest;
		// 帶清單裡最新那一則的 id：載入之後才到的通知不會沒被看過就變成已讀（D15）。
		// 只更新未讀數；**不重抓清單**——這一次的畫面上，剛看到的還標著未讀。
		markAllRead(newest).then(
			(count) => queryClient.setQueryData(queryKeys.unreadCount, count),
			() => {
				marked.current = null; // 失敗：下一次清單回來時再試
			},
		);
	}, [newest, hasUnread, queryClient]);
	// …
}
```

畫面：`<h1>通知</h1>`；`isPending` →「載入中…」；`isError` 而且沒有資料 → `role="alert"`「無法載入通知」；空的 →「還沒有通知」；否則 `<ul>`，每一列一個 `<Link to={to}>`（整列可以按，`min-height: 44px`）：未讀的列加 `styles.unread`（左邊一個 `--color-action` 的點）與 `<span className={ui.srOnly}>未讀</span>`，文字、`<time dateTime>`（`formatDateTime`）。`comment_preview` 是文字節點。

- [ ] **Step 4：`NotificationsCard.tsx`，放在 `Me.tsx` 的 `<AccountCard />` 前面。**

```tsx
export function NotificationsCard() {
	const unread = useUnreadCount().data ?? 0;
	return (
		<Card testId="notifications-card">
			<h2 className={ui.sectionTitle}>通知</h2>
			<p>{unread > 0 ? `${unread} 則新通知` : "沒有新通知"}</p>
			{/* 數字不放進連結的名稱：名稱固定，e2e 與螢幕閱讀器都好找。 */}
			<Link to="/notifications" className={styles.link}>
				看通知
			</Link>
		</Card>
	);
}
```

- [ ] **Step 5：測試。**

`tests/tab-bar.test.tsx`、`tests/side-nav.test.tsx`（**既有的測試一條都不改**——不傳 `unread` 就是 0）各加：

| # | 情境 | 斷言 |
|---|---|---|
| 1 | `unread={3}` | `getByRole("link", { name: "我的" })`（名稱沒變）`toHaveAccessibleDescription("3 則新通知")`；連結裡看得到「3」 |
| 2 | `unread={10}` | 連結裡是「9+」；描述是「10 則新通知」（唸出來的是真的數字） |
| 3 | `unread={0}`、不傳 | 連結沒有 `aria-describedby`；`textContent` 是「我的」；畫面上沒有「則新通知」 |
| 4 | 其他三個分頁 | `unread={3}` 時「總覽」「報表」「飲食」都沒有 `aria-describedby` |

`tests/notifications.test.tsx`：

| # | 情境 | 斷言 |
|---|---|---|
| 1 | 四種通知 | 四個連結的文字與 `href`：`/meals/7`、`/meals/7`、`/me`、`/me`；留言的預覽在文字裡 |
| 2 | 未讀的標記 | `is_read: false` 的列有「未讀」；`true` 的沒有 |
| 3 | 載入後送已讀 | `POST /api/notifications/read-all` **一次**、body `{"up_to":<第一則的 id>}`；`client.getQueryData(queryKeys.unreadCount)` 變成回應的 `count`；送完之後**沒有第二次** `GET /api/notifications`；未讀的列仍然標著「未讀」 |
| 4 | 全部都讀過了 | 先等清單出現，再斷言沒有 `POST` |
| 5 | 空的 | 「還沒有通知」；沒有 `POST` |
| 6 | 載入失敗 | alert「無法載入通知」；沒有 `POST` |
| 7 | `<React.StrictMode>` 包著 render | `POST` 仍然只有一次 |
| 8 | `read-all` 失敗 | 沒有未處理的 rejection（`Unhandled`）；未讀數的快取沒被改 |

`tests/me.test.tsx`：`unread-count` 回 3 → `within(getByTestId("notifications-card"))` 有「3 則新通知」、連結「看通知」到 `/notifications`；回 0 →「沒有新通知」；卡片是「我的」裡**第一張**（在帳號卡片之前——比 DOM 順序）。這個檔案其他測試沒有準備 `unread-count` 的路由：`mockApi` 會 throw、query 變成 error、卡片顯示「沒有新通知」——**預期仍然全綠**；有哪一條因此紅了，替它補上路由，不要改元件。

`tests/app.test.tsx`：`mockBackend` 的預設路由加 `/api/notifications/unread-count` → `{ count: 0 }`。新增：(a) 回 `{ count: 2 }` → 分頁列的「我的」描述是「2 則新通知」；(b) 點「報表」之後 `unread-count` 被請求了**第二次**（換頁重抓）；剛載入時只有**一次**（第一次掛載不重抓）。`tests/layout.test.ts`：加 `["/notifications", "narrow"]`。

Run：`npx vitest run tests/tab-bar.test.tsx tests/side-nav.test.tsx tests/notifications.test.tsx tests/me.test.tsx tests/app.test.tsx tests/layout.test.ts 2>&1 | grep -E "FAIL|Unhandled|Tests |Test Files"`

- [ ] **Step 6：突變。**

| 突變 | 該紅的 |
|---|---|
| 標記的 `aria-hidden="true"` 拿掉 | 導覽 #1（名稱變成「我的3」——`{ name: "我的" }` 是完整比對）。**這是整個 D17 的釘子**：看到它紅才算數 |
| 隱藏文字搬進 `<NavLink>` 裡面 | 導覽 #1 |
| `unread > 9 ? "9+"` 改成 `>= 9` | 導覽：補一格 `unread={9}` 顯示「9」 |
| `tab.to === "/me" ? unread : 0` 改成一律 `unread` | 導覽 #4 |
| `marked.current === newest` 的判斷拿掉 | 通知 #7 |
| `!hasUnread` 的判斷拿掉 | 通知 #4 |
| `markAllRead(newest)` 改成 `markAllRead(Number.MAX_SAFE_INTEGER)` | 通知 #3（body） |
| 成功之後多一個 `invalidateQueries(notifications)` | 通知 #3（第二次 GET） |
| `App` 的 effect 拿掉 `firstPath` 的判斷；整個 effect 拿掉 | app (b) 的後半；前半 |
| `Me` 把 `NotificationsCard` 放到最後 | me 的順序那一條 |

- [ ] **Step 7：既有測試確認、commit。** `npm run -s lint && npm run -s test 2>&1 | grep -E "FAIL|Unhandled|Tests |Test Files"`；單獨 `npm run -s typecheck`。規格 §6.5 列的單元測試（`app.test.tsx` 153、320 行，`tab-bar`、`side-nav`）**原本的斷言一個字都沒改**——`git diff` 裡這幾個檔案只有新增的行。

```bash
git add frontend/src/screens/Notifications.tsx frontend/src/screens/Notifications.module.css frontend/src/components/NotificationsCard.tsx frontend/src/components/TabBar.tsx frontend/src/components/TabBar.module.css frontend/src/components/SideNav.tsx frontend/src/components/SideNav.module.css frontend/src/screens/Me.tsx frontend/src/App.tsx frontend/tests/notifications.test.tsx frontend/tests/tab-bar.test.tsx frontend/tests/side-nav.test.tsx frontend/tests/me.test.tsx frontend/tests/app.test.tsx frontend/tests/layout.test.ts
git commit -F "$S/social-plan-task10-msg.txt"   # feat(frontend): 通知頁、「我的」分頁上的未讀數字、通知卡片
```

---

## Task 11：e2e

**Files:**
- Create: `frontend/e2e/social.spec.ts`
- Modify: `frontend/e2e/touch-targets.spec.ts`（有現成的清單就加兩個新畫面；沒有就在新 spec 裡量）

先 `docker compose up -d --build api`（**一定要 `--build`**：migration `0018` 烤在映像裡），確認 `docker compose exec api alembic current` 是 `0018`。

- [ ] **Step 1：`e2e/social.spec.ts`。** 兩個新帳號（`newAccount`）、**各一個 context**、登入後**只用點擊換頁**。A 的那一餐用 API 建（這條測試要測的不是記一餐）。

```ts
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { loginAs, type NewAccount, newAccount } from "./new-account.ts";

const PHONE = { width: 390, height: 844 };

async function seedMeal(request: APIRequestContext, owner: NewAccount, food: string) {
	const login = await request.post("/api/auth/login", {
		data: { email: owner.email, password: owner.password },
	});
	expect(login.ok()).toBe(true);
	const headers = { authorization: `Bearer ${(await login.json()).access_token}` };
	const created = await request.post("/api/foods", {
		headers,
		data: {
			name: food,
			nutrition: { base_unit: "g", kcal: "123.00", protein_g: "10.00", fat_g: "5.00", carb_g: "5.00" },
		},
	});
	expect(created.ok()).toBe(true);
	const meal = await request.post("/api/meals", {
		headers,
		data: {
			eaten_at: new Date().toISOString(),
			meal_type: "snack",
			items: [{ food_id: (await created.json()).id, quantity: "1" }],
		},
	});
	expect(meal.ok()).toBe(true);
}

/** 點分頁換頁，等那一頁自己的 h1 出現（換頁後第一個斷言選新頁面才有的東西）。
 *  分頁的連結是 `/diet`（不帶 `?view=`），所以點「飲食」一定回到「我的」那個檢視。 */
async function go(page: Page, tab: "總覽" | "飲食" | "我的") {
	await page.getByRole("link", { name: tab, exact: true }).click();
	await expect(page.getByRole("heading", { name: tab, exact: true, level: 1 })).toBeVisible();
}

async function openFriendFeed(page: Page) {
	await go(page, "飲食");
	// 切換的單選鈕是藏起來的 input：點它的文字（同 e2e/friends.spec.ts）。
	await page.getByText("好友", { exact: true }).click();
	await expect(page.getByRole("region", { name: "好友動態", exact: true })).toBeVisible();
}

test("社群：按讚、留言、通知、刪留言、解除好友之後讚不見", async ({ browser, request }) => {
	test.setTimeout(120_000);
	const stamp = Date.now();
	const a = await newAccount(request, "social-a");
	const b = await newAccount(request, "social-b");
	const food = `E2E 社群點心 ${stamp}`;
	const comment = `看起來好好吃 ${stamp}`;
	await seedMeal(request, a, food);

	const contextA = await browser.newContext({ viewport: PHONE });
	const contextB = await browser.newContext({ viewport: PHONE });
	const pageA = await contextA.newPage();
	const pageB = await contextB.newPage();
	await loginAs(pageA, a);
	await loginAs(pageB, b);

	// ── 加好友：A 用 B 的好友碼送邀請，B 接受 ─────────────────────────────
	await go(pageB, "我的");
	const code = (await pageB.getByTestId("friend-code").textContent())?.trim() ?? "";
	expect(code).not.toBe("");
	await go(pageA, "我的");
	await pageA.getByLabel("朋友的好友碼").fill(code);
	await pageA.getByRole("button", { name: "送出邀請", exact: true }).click();
	await expect(pageA.getByText(`已送出邀請給${b.name}，等對方接受`)).toBeVisible();
	// B 換頁再回來：未讀數在換頁時重抓，「我的」上有 A 的邀請那一則。
	await go(pageB, "總覽");
	await expect(pageB.getByRole("link", { name: "我的", exact: true })).toHaveAccessibleDescription(
		"1 則新通知",
	);
	await go(pageB, "我的");
	await pageB.getByRole("button", { name: `接受${a.name}的邀請`, exact: true }).click();
	await expect(
		pageB.getByRole("button", { name: `解除和${a.name}的好友`, exact: true }),
	).toBeVisible();

	// ── B 在好友動態按讚、進餐點頁留言 ───────────────────────────────────
	await openFriendFeed(pageB);
	const like = pageB.getByRole("button", { name: `讚，${a.name}的點心`, exact: true });
	await expect(like).toHaveAttribute("aria-pressed", "false");
	await like.click();
	await expect(like).toHaveAttribute("aria-pressed", "true");
	await expect(like).toHaveAccessibleDescription("1 個讚");
	await pageB.getByRole("link", { name: `${a.name}的點心，留言 0 則`, exact: true }).click();
	await expect(pageB.getByRole("heading", { name: `${a.name}的點心`, exact: true })).toBeVisible();
	await pageB.getByLabel("留言", { exact: true }).fill(comment);
	await pageB.getByRole("button", { name: "送出", exact: true }).click();
	await expect(pageB.getByRole("listitem").filter({ hasText: comment })).toBeVisible();
	await expect(pageB.getByLabel("留言", { exact: true })).toBeFocused();
	await expect(pageB.getByLabel("留言", { exact: true })).toHaveValue("");

	// ── A：分頁上的數字 → 通知 → 餐點頁 → 刪掉 B 的留言 ───────────────────
	await go(pageA, "總覽");
	const mine = pageA.getByRole("link", { name: "我的", exact: true });
	// 三則：B 接受邀請、B 按讚、B 留言。
	await expect(mine).toHaveAccessibleDescription("3 則新通知");
	await go(pageA, "我的");
	await expect(pageA.getByTestId("notifications-card")).toContainText("3 則新通知");
	await pageA.getByRole("link", { name: "看通知", exact: true }).click();
	await expect(pageA.getByRole("heading", { name: "通知", exact: true })).toBeVisible();
	await expect(pageA.getByText(`${b.name} 對你的點心按了讚`, { exact: true })).toBeVisible();
	await expect(pageA.getByText(`${b.name} 接受了你的好友邀請`, { exact: true })).toBeVisible();
	// 打開就標成已讀：分頁上的數字不見了。
	await expect(mine).not.toHaveAttribute("aria-describedby", /.+/);
	await pageA.getByRole("link", { name: new RegExp(`^.*${b.name} 在你的點心留言：`) }).click();
	await expect(pageA.getByRole("heading", { name: "我的點心", exact: true })).toBeVisible();
	await expect(pageA.getByText(`${b.name} 說讚`, { exact: true })).toBeVisible();
	await expect(pageA.getByRole("listitem").filter({ hasText: comment })).toBeVisible();
	await pageA.getByRole("button", { name: `刪除 ${b.name} 的留言`, exact: true }).click();
	await pageA.getByRole("button", { name: "確定刪除", exact: true }).click();
	await expect(pageA.getByRole("heading", { name: "留言（0）", exact: true })).toBeFocused();
	await expect(pageA.getByText(comment)).toHaveCount(0);

	// ── B 回動態：留言數回到 0，進去也看不到 ─────────────────────────────
	await openFriendFeed(pageB);
	await pageB.getByRole("link", { name: `${a.name}的點心，留言 0 則`, exact: true }).click();
	await expect(pageB.getByRole("heading", { name: "留言（0）", exact: true })).toBeVisible();
	await expect(pageB.getByText(comment)).toHaveCount(0);

	// ── A 解除好友：B 的讚從 A 的餐上消失 ────────────────────────────────
	await go(pageA, "我的");
	await pageA.getByRole("button", { name: `解除和${b.name}的好友`, exact: true }).click();
	await pageA.getByRole("button", { name: "確定解除", exact: true }).click();
	await expect(
		pageA.getByRole("button", { name: `解除和${b.name}的好友`, exact: true }),
	).toHaveCount(0);
	await go(pageA, "飲食");
	await pageA.getByRole("link", { name: /^.+點心，留言 \d+ 則$/ }).click();
	// 解除時餐點頁的快取被拿掉了：標題出現＝這是剛抓回來的資料。
	await expect(pageA.getByRole("heading", { name: "我的點心", exact: true })).toBeVisible();
	await expect(pageA.getByText(`${b.name} 說讚`, { exact: true })).toHaveCount(0);
	await expect(pageA.getByText("1 個讚", { exact: true })).toHaveCount(0);

	// B 那一邊：動態是空的。
	await go(pageB, "飲食");
	await pageB.getByText("好友", { exact: true }).click();
	await expect(pageB.getByText("還沒有好友。到「我的」→「好友」用好友碼加朋友")).toBeVisible();

	await contextA.close();
	await contextB.close();
});
```

**這條 spec 沒有跑過**（寫計畫時功能還不存在）。既有畫面的選擇器對過原始碼：`friend-code`、`朋友的好友碼`、「已送出邀請給…，等對方接受」、`接受${name}的邀請`、`解除和${name}的好友`、「確定解除」（`FriendsCard.tsx`）；三個分頁的 `<h1>`；切到好友用 `getByText("好友", { exact: true })`（`friends.spec.ts`）。新畫面的選擇器照 Task 8–10 寫出來的實際名稱為準，對不上就改 spec 並記進「與規格的差異」。biome 會把長的行重排，照它的結果。

- [ ] **Step 2：觸控目標。** 在這條測試的適當位置（B 在餐點頁、A 在通知頁）用 `e2e/touch-targets.ts` 既有的量法量：讚的按鈕、「留言 N」連結、送出鍵、刪除鈕、通知的每一列 ≥ 44px。電腦版寬度（1280）另外開一個 context 看一次餐點頁與通知頁：內容寬度是 `narrow`、側邊導覽的「我的」有標記。

- [ ] **Step 3：跑。**

```bash
cd frontend && npx playwright test e2e/social.spec.ts            # Expected: 1 passed
npx playwright test                                               # Expected: 48 passed（47＋1），連跑兩次
npm run -s typecheck                                              # Playwright 不做型別檢查（handover §7）
```

整套一定要跑：規格 §6.5 列的 e2e（`account-settings`、`admin`、`ai-multi-food`、`auth`、`reports-export`、`desktop-layout`）都用名稱「我的」找連結——**一條都不該紅，也一個字都不用改**。

- [ ] **Step 4：突變（e2e 也要看它紅）。**

| 突變（改完要 `docker compose up -d --build api` 的標 ★） | 該紅的那一行 |
|---|---|
| ★ `social_counts` 的讚拿掉 `like_counts(...)` 過濾 | 最後的 `1 個讚` 的 `toHaveCount(0)`——**不會**（主人的餐點頁用的是名單查詢）；改成拿掉 `read_social_meal` 名單查詢的過濾 → `說讚` 的 `toHaveCount(0)` |
| ★ `notify_comment` 不寫 | 「3 則新通知」 |
| `Notifications.tsx` 不呼叫 `markAllRead` | `not.toHaveAttribute("aria-describedby", …)` |
| `App.tsx` 換頁不重抓未讀數 | B 的「1 則新通知」（要等 60 秒的輪詢才會出現，斷言先逾時） |
| `CommentForm` 的 `finally` 不把焦點放回去 | `toBeFocused()` |

- [ ] **Step 5：commit。**

```bash
cd frontend && npm run -s typecheck && cd .. && git add frontend/e2e/social.spec.ts && git commit -F "$S/social-plan-task11-msg.txt"   # test(e2e): 社群——按讚、留言、通知、刪留言、解除好友
```

---

## Task 12：文件

**Files:** `docs/handover.md`、`docs/deployment.md`、`docs/superpowers/specs/2026-10-10-social-interactions-design.md`、這份計畫的「與規格的差異」

- [ ] **Step 1：量。** 後端 `pytest -q -W error` 的條數與秒數；前端 `npm run -s test` 印出來的 `Test Files`／`Tests`；e2e 條數與檔案數；`grep -c "@router\." app/api/routes/*.py` 加總（預期 87）；資料表 19；migration `0001`～`0018`。**寫量到的，不寫這份計畫預期的。**
- [ ] **Step 2：`docs/handover.md`。**
  - §2 的數字表與「階段進度」：新增一列「按讚、留言、通知（社群第三步）」；「UI 改版 第三階段／社群」那一列改成：讚、留言、通知已完成；**封鎖、好友的趨勢仍然沒做**。
  - §4.10 補一段：`app/social_visibility.py` 是第二個可見性模組；「解除好友＝讀的時候過濾，不刪資料」；`/api/meals` 從它只拿 `social_counts`（掃描測試的第二條）。
  - §6 加一小節「按讚、留言、通知」：執行時真的踩到的假綠燈（至少這三個寫計畫時就看到的：共用交易裡 `now()` 不動，比兩次已讀時間看不出差別；`type` 的 CHECK 永遠被形狀那一條先擋；短的餐費數字會剛好出現在 id 裡）。
  - §7 的表格：`ON CONFLICT DO NOTHING` 也會吃掉 identity 值；`aria-hidden` 的子元素不進可及名稱、`aria-describedby` 要指到連結外面；TanStack 的 `refetchInterval` 預設背景不抓。
  - §8.2 已知限制：規格 §9.1 的五點，加上「留言的預覽照 code point 切，可能切在表情符號的組合序列中間」「自己的餐點清單上的數字最多慢 60 秒（全域 `staleTime`）」。
  - §10 新增「按讚、留言、通知」一節：端點表、可見性的兩張表、通知的寫入點、前端的鍵與「不進離線快取」、分頁標記為什麼不改名稱。
- [ ] **Step 3：`docs/deployment.md`。** 照 `0017` 那一段的寫法加 `0018_create_social_tables`：三張新表、`deploy.sh` 自己跑、**可以退版**（不在 `ROLLBACK_UNSAFE_REVISIONS`）、退版後表留著；沒有新的環境變數；限速在記憶體裡（重啟歸零）。
- [ ] **Step 4：規格。** 狀態改成「已實作」；「與原始決定的差異」後面加「執行中發現的差異」，把這份計畫「與規格的差異」累積的每一條搬過去（預期存活的突變、改過的選擇器、對不上的條數）。
- [ ] **Step 5：commit。** Markdown 用 Edit 工具改（不要用 Windows 的 Python 文字模式重寫整份——CRLF，handover §7）。

```bash
git add docs/handover.md docs/deployment.md docs/superpowers/specs/2026-10-10-social-interactions-design.md docs/superpowers/plans/2026-10-10-social-interactions.md
git commit -F "$S/social-plan-task12-msg.txt"   # docs: 按讚、留言、通知——handover、部署手冊、規格的狀態
```

---

## 完成條件

- [ ] 後端 `pytest -q -W error` 全綠（含 `alembic check`）；`ruff check .`、`mypy app` 乾淨。
- [ ] 前端 `npm run -s test` 沒有 `FAIL`／`Unhandled`；`typecheck`、`lint` 乾淨；`schema.d.ts` 重新產生後 `git diff` 是空的。
- [ ] e2e 整套連跑兩次都綠；規格 §6.5 列的每一處「我的」都沒有改。
- [ ] 每個 task 的突變表都跑過：紅的寫了是哪一條，存活的寫了理由。
- [ ] `git status` 只剩 `lunch.jpg`；沒有 push。
