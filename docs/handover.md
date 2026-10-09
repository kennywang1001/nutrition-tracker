# 交接文件

**專案：** nutrition-tracker —— 飲食紀錄系統
**Repo：** https://github.com/kennywang1001/nutrition-tracker（公開）
**狀態：** 後端完成並可部署、session 撤銷已完成；介面改版第一階段、食物的一份、修改與刪除已記錄的餐點、AI 估算的前端已合併；介面改版第二階段已實作於 `feat/ui-phase2`；帳號與目標設定已實作於 `feat/account-settings`；報表看其他月份與匯出資料已實作於 `feat/reports-month-export`
**文件產出日：** 2026-09-11（session 撤銷完成後更新於 2026-09-12；§2 的數字更新於 2026-10-09）

---

## 1. 這是什麼、為什麼這樣做

一個記錄每日三大營養素與補劑的飲食紀錄系統，部署在家用 NAS、經 Tailscale
從手機存取。

專案有兩層意圖，讀這份文件時要分清楚：

| | |
|---|---|
| **產品目標** | 一個自己每天會用的飲食紀錄 app |
| **學習目標** | 資料庫設計深度、Docker 部署、API 測試框架、多 agent 協作、AI 協作 |

**很多設計決定是為了學習目標而刻意取的**（例如用版本化而非快照、把約束交給
資料庫而非程式碼）。如果只看產品需求會覺得過度設計 —— 那是刻意的。

---

## 2. 目前狀態

| 項目 | 數字 |
|---|---|
| 端點 | **78**（OpenAPI 的 operation 數，跟 `grep -c "@router\." app/api/routes/*.py` 的加總一樣；2026-10-09） |
| 測試 | 後端 **998**（`pytest -q -W error` 全綠，約 2 分 20 秒）；前端 `Test Files 138`、`Tests 1649`（**vitest 印出來的數字**，不是實際條數：每個檔案跑兩次，而且不是剛好兩倍——`it.each` 在執行那次展開、型別那次算一條，見 §7）；e2e **45** 條（Playwright）。2026-10-09 在 `feat/reports-month-export` 量的（審查修正之後） |
| 覆蓋率 | 96%（2026-09 量的，之後沒再量） |
| 資料表 | 16（+ `alembic_version`） |
| Migration | `0001` ~ `0016` |
| Commit | 600+ |
| PR | 5 個，全部經 CI 驗證後合併 |

### 階段進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 骨架 | Docker Compose + CI + repo 結構 | ✅ 隨 P1 長出來 |
| P1 核心 | 資料模型 + CRUD API + 測試框架 | ✅ |
| P2 AI 分析 | 拍照 → 辨識 → 估算 → **驗證** → 落庫。後端（Anthropic 與 Gemini 擇一，`AI_PROVIDER`）與前端（記一餐、新增食物的估算面板；規格 `docs/superpowers/specs/2026-10-05-ai-estimate-frontend-design.md`、計畫 `docs/superpowers/plans/2026-10-05-ai-estimate-frontend.md`） | ✅ |
| **P3 介面** | **PWA（TypeScript + React）** | 🟡 **P3-A ✅、P3-B 計畫一 ✅、計畫二待 PR** |
| P4 上線 | NAS 部署 + Tailscale | ✅ |
| **UI 改版 第一階段** | tab bar 總覽｜報表｜＋｜飲食｜我的；MOZE 風格外觀（設計變數 + 深色模式，跟隨系統）；自訂數字鍵盤記帳；記一餐可選填照片；總覽時間線（規格 `docs/superpowers/specs/2026-10-02-ui-redesign-phase1-design.md`、計畫 `docs/superpowers/plans/2026-10-02-ui-redesign-phase1.md`） | ✅ |
| 修改與刪除已記錄的餐點 | 編輯畫面 `/meals/:id/edit`：改份量或數量、加刪項目、改餐別、改金額（改、補、拿掉）、換或刪照片、刪整餐（連餐費）。入口：飲食頁卡片的「編輯」、總覽時間線的餐點列（規格 `docs/superpowers/specs/2026-10-04-edit-meals-design.md`、計畫 `docs/superpowers/plans/2026-10-04-edit-meals.md`） | ✅ |
| UI 改版 第二階段 | 六個舊畫面（食物庫、食物詳情、新增食物、補劑、趨勢、管理員審核）換新外觀；報表的分類甜甜圈圖；趨勢的營養素切換（規格 `docs/superpowers/specs/2026-10-06-ui-redesign-phase2-design.md`、計畫 `docs/superpowers/plans/2026-10-06-ui-redesign-phase2.md`） | ✅ |
| 小項目包 | 份量的修改與刪除（`PATCH`／`DELETE /api/foods/{id}/portions/{pid}`，已記的餐不受影響）；編輯歷史的日期改成好讀格式；趨勢圖日期軸；報表清單按鈕換新外觀（規格 `docs/superpowers/specs/2026-10-06-small-items-design.md`、計畫 `docs/superpowers/plans/2026-10-06-small-items.md`） | ✅ |
| 開帳號的路（社群第一步） | 管理員在「我的」產生一次性邀請連結（7 天、只能用一次、可撤銷，資料庫只存 SHA-256）；朋友打開 `/join#<碼>` 自己建帳號。**註冊一定要有邀請**（規格 `docs/superpowers/specs/2026-10-06-invites-design.md`、計畫 `docs/superpowers/plans/2026-10-06-invites.md`） | ✅ |
| 好友關係（社群第二步） | 好友碼（`XXXX-XXXX`，可重設）送邀請、對方接受；飲食頁「我的｜好友」看好友動態，點名字看他的某一天（照他的時區）；好友看得到吃了什麼、照片、熱量與營養素，**看不到餐費與備註**；每一餐可設「只有我看得到」（規格 `docs/superpowers/specs/2026-10-07-friends-design.md`、計畫 `docs/superpowers/plans/2026-10-07-friends.md`） | ✅ |
| 部署改成 CI 做映像 | CI 的 `publish` job 把兩個映像推到 GHCR（多架構）；NAS 上 `sudo ./scripts/deploy.sh` 拉映像、備份、migration、等 healthy、起不來自動退版（規格 `docs/superpowers/specs/2026-10-08-image-deploy-design.md`；部署手冊「二、更新」） | ✅（`publish` job 要等第一次 push 到 master 才驗得到） |
| 電腦版版面 | 寬度 ≥ 1024px 左側導覽＋總覽／報表／飲食兩欄；比較窄維持手機版、內容最寬 600px 置中。只改版面，不動後端（規格 `docs/superpowers/specs/2026-10-08-desktop-layout-design.md`、計畫 `docs/superpowers/plans/2026-10-08-desktop-layout.md`；見第 10 節「電腦版版面」） | ✅（`feat/desktop-layout`） |
| 帳號與目標設定 | 「我的」的每日目標卡片＋`/me/targets`（**從今天起**生效，過去的日子維持原本的目標）；帳號卡片的行內「修改名稱」；`/me/password` 改密碼（**其他裝置全部登出**，這台換一組新票繼續用）；管理員在「所有帳號」替一般使用者產生**重設密碼連結**（24 小時、只能用一次、不給管理員帳號），朋友打開 `/reset-password#<碼>` 設新密碼——取代 SSH 跑 `create-user`（規格 `docs/superpowers/specs/2026-10-08-account-settings-design.md`、計畫 `docs/superpowers/plans/2026-10-08-account-settings.md`；見第 10 節「帳號與目標設定」） | ✅（`feat/account-settings`） |
| 報表看其他月份、匯出資料 | 報表頂端的「‹ 上個月｜月份｜下個月 ›」（`?month=YYYY-MM`，沒有就是這個月；**這個月是哪個月由後端決定**）；「我的」的匯出資料：餐點／花費／補劑各下載一個 CSV（UTF-8＋BOM、帳號時區、分塊串流、每人每分鐘 6 次、同時一個）。沒有 migration（規格 `docs/superpowers/specs/2026-10-09-reports-month-export-design.md`、計畫 `docs/superpowers/plans/2026-10-09-reports-month-export.md`；見第 10 節「報表看其他月份與匯出資料」） | ✅（`feat/reports-month-export`） |
| UI 改版 第三階段 | 社群（P7）：第一步「開帳號的路」、第二步「好友關係」已完成。按讚、留言、通知刻意沒做——等真的用過再說 | 🟡 |

> **P4 早於 P2/P3 完成是刻意的，但當初的理由有瑕疵。**
> 我說「部署完手機就能用」—— 部署完能用的是 API，不是能在手機上按的東西。
> P4 的實際價值是「P3 一寫好就能立刻上線」。

---

## 3. 技術棧

**後端：** Python 3.12 · FastAPI · PostgreSQL 16.15 · SQLAlchemy 2.0（async）
· asyncpg · Alembic · Pydantic v2
**測試：** pytest · pytest-asyncio（`asyncio_mode=auto`）· httpx `ASGITransport`
**品質：** ruff · mypy（strict）· pytest-cov（門檻 80%）
**部署：** Docker Compose · GitHub Actions

### 目錄結構

```
app/
  main.py              FastAPI app 與 router 註冊
  config.py            Settings（密鑰沒有預設值，見 §5.1）
  db.py                async engine / SessionLocal / get_db
  errors.py            統一錯誤信封與 AppError 家族
  days.py              day_bounds() / today_in_timezone()  ← 時區的單一來源
  nutrition.py         營養素換算（每 100 單位的「100」只存在這裡）
  stats.py             統計彙總核心（SQL 分桶）
  ratelimit.py         登入速率限制、KeyedRateLimiter（換票／登出、匯出）、InFlightLimiter（匯出同時一個）——都在記憶體，單容器
  csv_export.py        CSV 的唯一寫法：BOM、RFC 4180 的引號、公式字元（儲存格的型別決定怎麼寫）
  export.py            匯出的三支分塊 async generator（餐點、花費、補劑；keyset 分塊）
  food_visibility.py   食物/份量的分層可見性（共用）
  password_resets.py   重設密碼連結的規則：產生、雜湊、還能用、兌換、撤銷某人的活連結（同 invites.py 的形狀）
  cli.py               create-admin / create-user / cleanup-photos / cleanup-sessions
  storage/photos.py    照片的所有檔案讀寫（規格第 8 節：集中在單一模組）
  security/tokens.py   JWT 編解碼（access / refresh 兩組，refresh 強制帶 jti）
  security/sessions.py refresh session 的生命週期：簽發 / 輪替 / 重用偵測 / 撤銷
  models/              SQLAlchemy models（唯一的 schema 事實來源）
  schemas/             Pydantic 請求/回應
  api/routes/          端點
docs/
  superpowers/specs/   規格（P1、session 撤銷、P3-A 前端）
  superpowers/plans/   七份實作計畫（含所有實測發現與突變結果）
  deployment.md        部署手冊
  handover.md          本文件
```

---

## 4. 核心設計決定（以及為什麼）

**這一節是這份文件最重要的部分。** 程式碼能自己說明「是什麼」，
說不了「為什麼不是別的樣子」。

### 4.1 食物用版本化，不用快照

```
foods          (id, name, owner_id, current_revision_id)
food_revisions (id, food_id, 營養素…, status, …)
meal_items     (…, food_revision_id)   ← 指向記錄當下那一版
```

**核心問題：** 全域的「茶葉蛋」熱量被人從 70 改成 700，上個月的紀錄要不要跟著變？

不能變。會變的話歷史統計就是浮動的，紀錄軟體失去意義。

選版本化而非快照，是因為維基模式本來就需要一張編輯歷史表，
`food_revisions` 同時就是那張表 —— 一張表解決兩個問題。

### 4.2 用 `current_revision_id` 指標，不用 `WHERE status='approved'`

**整個 codebase 沒有任何一處查詢需要記得加狀態過濾。** 忘記加就是未審核資料外洩，
而指標讓「忘記」在結構上不可能發生。

### 4.3 「凍結歷史」出現過三次，形狀相同、機制不同

| 出處 | 會變的東西 | 凍結手段 |
|---|---|---|
| 食物 | 全域食物被協作編輯 | `current_revision_id` 指標 |
| 份量 | 「1 碗 = 200g」被改 | 寫入當下算好 `meal_items.quantity_g` |
| 補劑 | 補劑主檔營養素被改 | 寫入當下算好 `supplement_intakes` 的四個欄位 |

**認出「這又是同一類問題」比記住個別解法更重要。** 每一次的測試也是同一個形狀：
**寫入 → 改來源 → 重讀 → 數值必須不動。**

### 4.4 有效期間制（effective dating）出現過兩次

`user_targets` 與 `supplement_plans` 都用 `(effective_from, effective_to)`，
期間不重疊由資料庫的 `EXCLUDE USING gist` 約束擋掉，不是靠程式檢查。

三月減脂的蛋白質目標 150g、六月改 180g —— **三月的達成率不能用六月的標準重算。**

修改一律是「關閉舊期間、開新期間」，**舊列的數值永遠不動**。
順序不能換：EXCLUDE 是逐列立即檢查的，先 INSERT 會跟自己重疊。

### 4.5 補劑用快照而非版本化（刻意的不一致）

補劑的數值印在罐子標籤上，是固定事實，不需要協作修正 ——
不值得為它建一整套審核流程。這個不一致是規格決策 6 明寫的。

### 4.6 「一天」由使用者時區決定

`users.timezone` 存 IANA 名稱。所有日界線一律走 `app/days.py` 的
`day_bounds()` / `today_in_timezone()`，**三個端點必須一致**
（`/meals?date=`、`/supplements/today`、`/stats/daily?date=`），
有專門的跨端點一致性測試守著。

半開區間 `[start, end)`，`<` 不是 `<=` —— 午夜那一餐只能屬於一天。

### 4.7 權限失敗一律 404，body 逐字相同

「不是你的」與「不存在」必須無法區分。角色不足（非管理員）才是 403 ——
那不是在隱藏誰的資料，是在說「你沒有這個角色」。

### 4.8 統計只回數字，不判斷達成與否

減脂期熱量要「不超過」、增肌期蛋白質要「至少達到」——
**同一個 110% 在兩邊意義相反。** 把判斷寫進 API 等於把產品邏輯凍在資料層。

`target` / `ratio` 沒設目標時是 `null`，不是 0。

### 4.9 照片存檔案系統，且不經靜態檔案服務

DB 只存相對路徑。不存進資料庫的真正理由不是效能，是**備份心理學**：
一年後 `pg_dump` 變成數 GB，備份變麻煩，然後就不備份了。

照片一律走 `GET /api/meals/{id}/photo`，先驗 JWT 與擁有權。
**不要為了方便掛 `StaticFiles`** —— 掛上去的那一刻所有檔案就對所有人公開了，
而且既有測試**不會變紅**（有一個路由表內省的測試專門守這件事）。

**EXIF（含 GPS）在重新編碼時去除**，有測試釘住。這是飲食紀錄 app，
照片在家裡和餐廳拍，原樣存下來等於附贈位置歷史。

### 4.10 好友的讀取是新規則，不是放寬舊規則

§4.7 的「只看得到自己的」被好友關係反轉了一部分。做法是**另外開一條路**，不是把
`user_id == me` 改成「我或我的好友」——後者只要套錯一個端點，好友就看得到生活花費
與目標，**而 `test_cross_user_isolation.py` 的 38 條照樣全綠**（它們測的是非好友）。

- **既有的讀取一個都沒放寬。**（`/api/meals` 只多了 `is_private` 的讀寫。）好友的讀取全部在
  `/api/friends/...`（`app/api/routes/friends.py`）。
- **唯一入口** `app/friend_visibility.py`：`friend_ids`（只有已接受的）、`load_visible_friend`、
  `shared_meals`（屬於好友、而且 `NOT is_private`）。動態、某一天、照片都從 `shared_meals` 開始。
- **白名單回應** `FriendMeal`：不是從 `MealResponse` 刪欄位——沒有餐費、備註、照片路徑、
  食物與份量的 id、份量名稱（可能是私人份量）。
- **守住它的測試**：「在兩人**是好友**的狀態下，既有的單筆端點照樣 404、**列表端點**（今天的餐、
  支出、月報、每日統計、今日補劑）照樣沒有對方的資料」；原始碼掃描「`Friendship` 與可見性函式
  （`friend_ids`、`shared_meals`…）只出現在好友模組」——最後審查抓到：原本的掃描只找
  `Friendship` 這個字，有人在 `list_meals` 直接 import `friend_ids` 就會漏掉；私人餐、邀請中、
  解除後、非好友、好友 id 與餐點 id 不配對都看不到。
- **好友資料不進 localStorage**（`["friends", …]` 與 `["friend-photo", …]` 都在 `NOT_PERSISTED`）：
  對方解除或把一餐改成私人之後，這台裝置離線時不該還看得到。
- 私人食物的**名稱**好友看得到（「吃了什麼」就是食物名）——刻意的取捨，對策是逐餐的「只有我看得到」。
- 一對朋友一列（`user_a < user_b`，CHECK 擋自己加自己）；拒絕、收回、解除都是刪列。

---

## 5. 上線前的安全補強（P4）

### 5.1 密鑰 fail closed

`app/config.py` 的 `jwt_secret` **沒有預設值**，而且會**拒絕**
`dev-secret-change-me-in-production`（那字串在公開 repo 裡，等於沒有密鑰，
而且比沒設更糟 —— 它會安靜地跑起來）。

缺少時在 `Settings()` 建立當下就拋 `ValidationError`，也就是 import 時就崩。

### 5.2 登入速率限制按 email，不按 IP

**容器看到的 client IP 全部是 `172.19.0.1`**（Docker bridge gateway，
userland proxy 對發佈的埠做 SNAT）。按 IP 限速會把 tailnet 上所有人算成同一個人。

兩層：每帳號（5 次/60 秒）+ 全域（20 次/60 秒）。

**計數的鍵是使用者送進來的 email 字串，帳號存不存在完全不影響行為** ——
否則送 11 次就能問出「這個 email 有沒有註冊」，等於把時序側通道
用另一種形式加回來。

**已知的代價：知道 email 的人可以拖住那個人的登入**（帳號設定審查 M8）。鍵只有 email 與
全域兩層、沒有「是誰送的」：任何連得到 API 的人，每分鐘對某個 email 送 5 次錯的密碼，那個
email 就一直停在 429——本人用對的密碼也進不來（被擋的請求不驗密碼）；每分鐘送 20 次（隨便
什麼 email）則是所有人都登不進來。**改密碼共用同一個限速器**（鍵是帳號的 email），所以同一招
也讓那個人改不了密碼。已經登入的裝置不受影響（換票走 `session_rate_limiter`，鍵是 `jti`）。
今天能打到 API 的只有 tailnet 上的幾個人，這是「只延遲、不鎖帳號」換來的、可以接受的代價；
**開放到網際網路之前要重新檢討**：加一層按來源 IP 的限速（要先讓容器看得到真的 client IP——
Caddy 的 `X-Forwarded-For` 加上只信任它，上面那段 SNAT 的問題還在），讓 email 這一層只擋
「同一個來源」的猜測。

### 5.3 Argon2 移出 event loop，並限制並發數

兩件事**必須一起做**：阻塞是一道意外的全域速率上限（並發完全不提升
攻擊者吞吐量），單獨修掉會在限速補上前先拿掉保護。

修完之後長出第三件事：Argon2 預設 `parallelism=4`、`memory_cost=64 MiB`，
20 次並發 = 80 路平行 + 1.2 GiB。NAS 只有 2–4 核、4–8 GB，會出事。
所以限制同時進行的雜湊數（`MAX_CONCURRENT_HASHES = 2`，不動雜湊參數）。

| `/api/health` 在並發雜湊下最高延遲 | |
|---|---|
| Argon2 阻塞 event loop | 1094.66ms |
| 移進執行緒池、無上限 | ~1000ms |
| 加上並發上限 | **153.30ms** |

### 5.4 liveness 與 readiness 分開

- `/api/health` —— liveness，**不碰資料庫**。Docker healthcheck 打這個。
- `/api/health/ready` —— readiness，做 `SELECT 1`，資料庫不通回 **503**。

刻意不把 readiness 接到 healthcheck：資料庫短暫抖動時重啟 API
並不能解決資料庫的問題，只會在恢復期間把 API 也弄掉。

---

## 6. 這個專案最有價值的產出：五十三種「綠燈說謊」

**每一種的機制都不同，而且都是實測踩到的，不是理論。**
新加的任何測試都應該對照這份清單檢查一次。

| # | 綠燈為何不算數 |
|---|---|
| 1 | **拿掉正確的修正，測試照樣通過**（`rollback()` 那次，兩個相反的改動都是綠的） |
| 2 | **選錯時區，測試在原理上不可能失敗**（台北宵夜對「寫死 UTC」零鑑別力） |
| 3 | **狀態碼對、最終狀態也對，錯的是中途**（delete-before-check 仍然回 404） |
| 4 | **pytest 的 `-W error` 把測試救活了**，正式環境毫無防護（解壓縮炸彈） |
| 5 | **兩個過濾器互相掩護**，突變任一個都不變紅（私人食物讓 `user_id` 過濾失去鑑別力） |
| 6 | **端點測試無法偵測「有沒有第二條無認證的路」**（StaticFiles） |
| 7 | **清理動作只在事後顯現**（斷言正確但停在錯誤發生那一刻） |
| 8 | **突變存活是因為挑錯突變點**，不是測試不夠力 |
| 9 | **測試量到的視窗跟缺陷沒有重疊**（`await` 讓出 loop，健康檢查在阻塞開始前就溜過去） |
| 10 | **自我指涉的斷言**（`peak <= MAX_CONCURRENT_HASHES` 讀的就是它要限制的常數） |
| 11 | **測試夾具讓 `commit` 在結構上不可觀察**（同一份計畫裡踩到三次） |
| 12 | **紅燈的原因跟被測的性質無關**（測試以崩潰而非斷言變紅） |
| 13 | **資料庫約束先於斷言擋住**（測試變紅了，但那一行斷言從沒執行過） |
| 14 | **測試所在的世界裡沒有那個維度**（共用一個交易，就看不見任何並行缺陷） |
| 15 | **靠自然時序的守衛，在某些機器上原理上不會變紅**（並行測試連跑 25 次全過） |
| 16 | **刻意的不可區分性，造成該層的測試盲區**（兩種失敗回同一個 401，端點層就分不出 family 範圍） |
| 17 | **離線持久化 + `staleTime` 讓 `page.reload()` 讀到 reload 之前的舊快照**，不是真的重打 API |
| 18 | **兩種行為的畫面結果完全一樣，只斷言文字測不出差異**（403 觸不觸發換票，看到的錯誤訊息一字不差） |

### 第 11～16 種是 session 撤銷那次長出來的，機制都不同

**第 11 種：夾具讓 `commit` 不可觀察。** `conftest.py` 的 `db_session` 用
`join_transaction_mode="create_savepoint"`，所以 `commit()` 只是
RELEASE SAVEPOINT —— 對同一個 session 而言，「已 flush 但沒 commit」與
「已 commit」**不可區分**。而 `client` fixture 把同一個 session 交給 app，
所以端點測試也看不見。

實測：把 `start_session` 的 `await db.commit()` 整行刪掉，476 個測試全綠 ——
但 production 的 `get_db` 是 per-request，`session.close()` 會把沒 commit 的
INSERT 丟掉，登入會發出一張沒有對應資料列的票。

**同一件事在那次踩到三次**（`start_session`、`revoke_session`、
`cleanup_expired_sessions`），三次都在補測試之前全綠。這已經不是個別疏漏，
是這套夾具的結構性盲點：**任何「這件事真的寫進資料庫了嗎」的斷言，
預設都是無效的。**

解法：斷言前自己 `await db_session.rollback()`。沒 commit 的資料還在
savepoint 裡會被抹掉，commit 過的不會。

**第 12 種：紅燈的原因跟被測性質無關。** 某個突變確實讓測試變紅了 ——
但形態是 `MissingGreenlet` 崩潰，不是斷言失敗。追下去發現：`rollback()` 會讓
session 裡所有 ORM 物件過期，之後第一次讀屬性（那個測試讀的是 `user.id`）
會觸發同步 refresh 查詢，在 async 下直接炸。那個崩潰跟「撤銷有沒有持久化」
完全無關。

**崩潰是偶然的守衛**：換個 SQLAlchemy 版本、或有人把測試稍微重寫，崩潰就
消失，而缺陷還在。**紅燈要問「它為什麼紅」，不能只看它紅了。**

**第 13 種：資料庫約束先於斷言擋住。** 突變「所有登入共用一個 family_id」
讓測試變紅了，但形態是 `IntegrityError`（撞上部分唯一索引），斷言那一行
根本沒跑到。斷言本身有鑑別力（索引若被拿掉，它會失敗），但**今天它跑不到**。
日後有人弱化那個索引時，會以為這條斷言還在守，結果兩道防線一起消失。

**第 14 種：測試所在的世界裡沒有那個維度。** 這是最貴的一個。

`_revoke_family` 是 bulk UPDATE，在 READ COMMITTED 下快照固定在 statement
開始那一刻 —— **並行交易新 INSERT 的列完全不在它的視野裡**。後果：攻擊者
同時送出「已用的 A」與「活著的 B」，重用偵測撤銷整個 family，但輪替那條
交易剛插入的 C 沒被撤銷到。**系統回報已撤銷、受害者被登出、攻擊者帶著一張
活票走人。** 實測 60 次並行試驗，59 次重現。

而這個缺陷能活下來，不是因為測試寫得不夠力 —— 是因為**所有測試共用一個
交易**，「兩個交易互相看不見對方」在那個世界裡**在結構上不存在**。
不是斷言挑錯了，是那個維度不在觀察範圍內。

解法也因此不同：不是加斷言，是**另外開一條真實連線**。

**第 15 種：靠自然時序的守衛在某些機器上原理上不會變紅。** 第一版的並行
測試用 `asyncio.gather` 讓兩條真實連線自然競速。把修正拿掉之後，它在
Windows + Docker Desktop 上**連跑 25 次一次都沒變紅** —— 那台機器上兩條
連線的自然交錯穩定落在安全的方向。

這跟第 2 種（選錯時區）是同一個家族：**測試在那個環境裡原理上不可能失敗。**
改成手動、確定性地建構那個交錯（用 `pg_stat_activity` 直接觀察對方真的被
鎖卡住了才放行，而不是 sleep 一段時間猜），才變成有鎖 10/10 綠、
沒鎖 10/10 紅。

**第 16 種：刻意的不可區分性造成測試盲區。** 登出後重放鏈上任一張票都回
401 —— 已撤銷的走 `TokenError`、未撤銷但已用的走 `ReuseDetectedError`，
而那兩者是**刻意**回同一個 401 的（不讓攻擊者分辨出「我被偵測到了」）。

結果：把「撤銷整個 family」改成「只撤銷被出示的那一列」，9 條登出端點測試
全綠。**那個刻意的安全設計，同時讓端點層測不到 family 範圍。**
修法只能是模組層測試 —— 這一層的盲區補不起來，要換一層看。

### 第 17、18 種是 P3-B 計畫二 Task 8（契約 E2E）長出來的

**第 17 種：`page.reload()` 讀到的可能是 reload 之前的舊快照，不是真的
重打 API。** 一條 E2E 要驗「MEMBER 送審的食物被 ADMIN 駁回之後，MEMBER
自己回去看得到駁回理由」——兩個獨立的 `browser.newContext()`（模擬兩個人），
ADMIN 駁回之後，讓還開著同一個食物詳情頁的 MEMBER `page.reload()`。
第一次寫，`reload()` 之後編輯歷史只看得到最原始那筆，駁回的那筆完全不見。

直接打 API 重現整個 propose → reject 流程（不經畫面）確認**後端沒問題**：
`GET /api/foods/{id}/revisions` 在 reject 之後確實回兩筆，帶著
`reject_reason`。問題在前端：`PersistQueryClientProvider` 把 MEMBER
**在送審之前**那次瀏覽（只有 1 筆）持久化到 `localStorage` 過；
`queryClient` 的 `staleTime` 是 60 秒，`reload()` restore 回來的那份快照
在 60 秒視窗內被當成「還新鮮」，不會自動重打 API——MEMBER 自己送審成功
後有 `invalidateQueries`，但那次的新狀態有沒有趕在 `reload()` 前被節流
寫回 `localStorage`，純粹是時間賽跑，不可靠。

這條的鑑別力一度是零：測試在「後端真的把駁回理由寫回去了」這件事上完全
沒有意見，紅綠只取決於一場跟被測邏輯無關的節流時間賽跑。修法是
`reload()` 之前先清掉那一個 localStorage key（不能整個 `clear()`——
refresh token 也放在 `localStorage`，一起清掉會讓 `reload()` 後掉回登入
畫面），保證 reload 之後沒有快照可以 restore，一定是一次真的打 API。
**任何一條 E2E 想用 `page.reload()` 觀察「另一個 session 剛寫入的狀態」，
只要那個頁面開著離線持久化又剛好瀏覽過同一份資料，都要檢查這件事。**

**第 18 種：兩種行為的畫面結果完全一樣，斷言文字測不出差異。** 規格
要求「非管理員打 admin 端點得到 403」，而 `client.ts` 只在
`status === 401` 換票，403 不該觸發換票。但如果有人把條件改寬成
`>= 401`：403 觸發換票 → 換票成功（refresh token 本身是好的，這個人只是
不是管理員）→ 重送 → 又是同一個 403、同一句訊息——**畫面上的結果一模
一樣**。一條只斷言「看到『需要管理員權限』」的測試，對這個突變是全綠的，
因為它從來沒有問過「這句話是打了一次還是兩次才看到的」。

跟第 16 種（刻意的不可區分性）是同一個家族，但成因不同：第 16 種是後端
刻意把兩種失敗回同一個狀態碼；這裡是前端的重試/換票邏輯把兩種**觸發路徑**
壓成同一個**可見結果**。抓得到的方式只有數請求——攔截
`page.on("request")`，斷言 `/api/auth/refresh` 的呼叫次數，而不是斷言
畫面上的文字。（另外實測發現：這條 query 的預設重試次數會讓多次換票的
數字比想像中大——不是 1 次而是 4 次，因為 TanStack Query 對 4xx 也重試
3 次，每次重試在 `>= 401` 下都各自觸發一次換票；但這不影響「數請求能不能
分辨兩種行為」這個結論，正確版本下這個數字永遠是 0。）

### 第 19～25 種是 P3-B 兩份計畫長出來的

（編號只是識別，不是時間順序 —— 第 19～23 種發生在第 17、18 種之前。）

**第 19 種：一個守衛所守的那條路徑，在所有使用它的測試裡從來沒被走過。**
前端六個畫面測試共用的 fetch mock，開頭一律檢查 `Authorization` 標頭，
沒帶就回 401 信封，docstring 寫著它在守「所有請求都要帶 token」。把那個
檢查改成 `if (false)`，**138 則測試全部照樣綠** —— 那六個檔案的
`beforeEach` 都是 `clearTokens()` 緊接著 `setTokens()`，沒有任何一則測試
在 render 之後清掉 token，所以那條分支從來沒被走過。

而它的 docstring 說「mock 不檢查 header 的話這個保證零鑑別力」也是誇大的：
`client.test.ts` 的「帶上 Authorization」與 `meal-photo.test.tsx` 的
「帶著 Authorization 取圖」一直在守那件事。那個 401 檢查是**後備防線**。
**一道沒有人走過的後備防線，會在下一個跑覆蓋率的人手上被當成死碼清掉。**

**第 20 種：原始碼掃描守衛分不出「程式碼在呼叫它」與「註解在解釋不要呼叫
它」；而剝掉註解之後，剝太多又會讓它什麼都沒看到而變綠。**
`lib/civil-date.ts` 禁止任何本地時間的 `Date` accessor，由一條掃描整個
檔案原始碼的測試守著。結果那個模組**寫不出自己禁止什麼** —— docstring
裡的 `getDate()` 例句會讓掃描紅。而同一個名字寫在測試檔的註解裡完全沒事
（掃描只讀 `src/`）：**能講的人不需要講，該講的人不能講。**

修法是掃描前先剝註解，而那開了新的失敗面：把 `stripComments` 改成
`return ""`，「沒有任何非 UTC 的 Date accessor」**依然綠** —— 它什麼都
沒看到。**守衛自己的前處理可以把它變成假綠燈**，所以那個前處理也要有
自己的守衛（斷言剝完之後真正的程式碼還在視野裡）。

**第 21 種：為了讓 lint 過而拿掉無障礙屬性，圖對螢幕閱讀器整個消失，
而所有測試照樣綠。** Biome 的 `a11y/noInteractiveElementToNoninteractiveRole`
把 SVG 的 `<rect role="img">` 判成錯（誤判，`<rect>` 不是互動元素）。
為了讓 `npm run lint` 過而拿掉 `role`，7 則測試全綠 —— 它們一律用
`getByTestId`。實測三種寫法：

```
<rect aria-label="…">             → getAllByRole("img") 找不到
<rect role="img" aria-label="…">  → 找到
<rect><title>…</title></rect>     → jsdom 裡 getByTitle 也找不到
```

`aria-label` 放在沒有語意角色的元素上，輔助技術多半忽略它。
**缺一條斷言 `role` 的測試不是「role 可以拿掉」的許可，缺那條測試才是
缺陷。** 跟 P3-A 的 `alt=""` 是同一課的推廣版。

**第 22 種：測試的 mock 日期剛好等於執行日，於是它在那一天鑑別力為零。**
趨勢畫面的核心保證是「日期錨點來自伺服器，不是前端算的今天」，測試把
mock 的「今天」寫死成 `2026-09-21` —— **而那份計畫就是 2026-09-21 寫的。**
在寫它的那一天，錯誤的實作（`new Date()` 自己算今天）會算出一模一樣的
`from` / `to`，斷言照樣綠。隔一天執行才碰巧有效。
**一條「只在某一天失效、而且沒有任何東西會提醒你」的測試是最糟的那種。**
修法是挑一個真實的今天永遠不可能等於的日期（`2019-07-04`）。

**第 23 種：突變同時打掉「被守的東西」與「斷言看得見它的能力」，兩者
互相抵銷成全綠。** 一條測試要驗「搜尋結果不會被寫進離線快取」，斷言寫成
`persisted.map(q => q.queryKey[0]).not.toContain("food-search")`。突變把
key 的命名空間從 `["food-search", …]` 改成 `["foods", "search", …]`：
排除**確實失效了**（搜尋結果真的被寫進 `localStorage`），但斷言用的字面值
同時也對不上了。兩件事被同一個突變一起打中，淨結果是綠。

修法是對 `queryKeys.foodSearch(…)` **實際產生的 key** 做深比對，不寫死
命名空間字面值；再加一條正向斷言（別的 query 確實有被持久化）證明這一輪
persist 真的跑過。**斷言不要跟突變的標的共用同一個字面值。**

**第 24 種：用 `session.refresh()` 驗「髒物件沒有外洩」，而 `refresh()`
刻意不 autoflush —— 這類測試永遠驗不到 autoflush 洩漏。** CLI 的
`create-user` 對既有管理員要「拒絕，而且什麼都不改」，那個 `raise` 因此
放在任何欄位賦值之前。測試用 `db_session.refresh(admin)` 讀回狀態，
於是把 `raise` 延後到賦值之後**依然全綠**。實測兩種讀法：

```
弄髒物件 → refresh() → 密碼有變 = False，名字回到資料庫裡的值
弄髒物件 → select()  → 密碼有變 = True，名字是被改掉的那個
```

`refresh()` 會先把物件標成過期（同時移出 dirty 集合）再發 SELECT，髒值
從頭到尾沒有機會被寫出去。換成 `select()`（會觸發 autoflush）之後，
同一個突變才紅。**「沒 commit」不等於「沒寫出去」，而驗證這件事必須用
會 autoflush 的讀法。**

**第 25 種：E2E 少一個同步點時，紅燈的訊息指向的正是它要守的那個東西。**
`trend.spec.ts` 在按下「記錄」之後**直接點「趨勢」連結**，中間沒有任何
等待。存檔還在飛的時候點走，`LogMeal` 就被卸載了。單獨跑永遠綠；整套
11 條用 4 個 worker 平行跑時約一半機率紅。

**而它紅的形式最惡劣：** 訊息是「柱子的 `aria-label` 沒變」，看起來像是
`invalidateQueries(rangeStatsAll)` 壞了 —— 那正是這條測試要守的東西 ——
實際上是那一餐根本沒存進去。**一個會把你指向錯誤地方的紅燈，比沒有紅燈
更貴。** `daily-loop.spec.ts` 沒有這個問題，因為它送出後直接斷言
`macro-kcal`，Playwright 的自動重試隱含地等到了導頁完成。

### 第 26、27 種是 app 第一次被真的用（2026-09-26）長出來的

**第 26 種：在測試環境裡永遠不會發生的症狀，不能拿來當斷言。**
使用者回報「手機版 UI 要往旁邊滑」。量測發現**橫向溢出根本不存在** ——
320 / 360 / 390px 三種寬度下每個畫面的 `scrollWidth` 都等於 `clientWidth`。

真正的原因是 **iOS Safari 在使用者點進 computed font-size < 16px 的輸入框時
會自動把整頁放大**（實測所有輸入框都是 13.3333px —— `index.css` 從來沒給
`input` / `select` / `textarea` 設過字級）。

**而 Chromium 不做那個自動放大。** 所以一條斷言「頁面有沒有變寬」的
Playwright 測試，在這裡**永遠是綠的** —— 它測的那個維度在測試環境裡不存在。

守衛因此要釘**造成症狀的規則**（字級 ≥ 16px），不是症狀本身。
這跟第 9 種（先問「這個缺陷所在的維度，在我的測試世界裡存在嗎」）是同一個
問題的另一面：那次是維度不存在所以測不到，這次是**維度不存在但看起來測得到** ——
你會寫出一條跑得動、看起來合理、而且永遠綠的測試。

**第 27 種：一個同步點的有效性，可能只是因為「當時沒有別的東西長那樣」。**
`admin.spec.ts` 有四處「點『食物庫』連結 → 立刻 `getByLabel("搜尋食物").fill(…)`」，
中間沒有任何等待。**那樣寫安全了很久**，因為當時的首頁（今日總覽）沒有同名
欄位，`getByLabel` 的自動等待別無選擇，只能等食物庫真的掛載完。

把首頁換成「記一餐」之後就不安全了 —— `LogMeal.tsx` 自己也有一個
`<label>搜尋食物</label>`。`.fill()` 可能在記一餐卸載完成之前抓到**它的**
搜尋框、把字填進去，然後記一餐卸載、食物庫掛出一個全新的空白搜尋框：
剛才填的字等於白填，後面永遠找不到那個食物。

**沒有任何東西會告訴你「這條測試的同步點是借來的」。** 它不是被這次改動
弄壞的，它一直都缺同步點 —— 只是環境剛好替它補上了。
跟 §25（`trend.spec.ts` 送出後沒等存檔就點走）同一類：**巧合地綠很久，
紅的時候指錯地方。**

### 第 28、29 種是 P2（AI 分析）長出來的

**第 28 種：測試在正確的程式碼下通過，卻在突變下以錯誤的方式失敗 ——
突變驗證本身被廢掉了。** P2 有一條測試要驗「LLM 失敗時 `ai_analyses`
仍然留下紀錄」。第一版在 `rollback()` **之後**才用 `user.id`（一個 ORM
屬性）當查詢條件。

- **正確的程式碼下它通過** —— helper 內部的 `commit()` 讓 session 回到
  乾淨狀態，讀 `user.id` 不需要 refresh。
- **套用突變（拿掉那個 commit）之後**，同一行觸發同步 refresh，
  直接炸 `MissingGreenlet` —— **而不是乾淨地 assert 失敗**。

也就是說：那個突變產生的是一個看不懂的例外，而不是一個指向問題的紅燈。
一個不夠小心的人會以為「測試環境壞了」，去修 fixture。

修法是這個 codebase 自己在 `tests/test_sessions.py` 早就寫下的教訓
（先把 id 取出來），只是第一版沒照做。

**這一類特別難察覺，因為問題只在突變時才顯現** —— 而突變正是你用來
檢查測試有沒有用的工具。**工具本身壞了。**

**第 29 種：`op.drop_constraint` 也會套用命名慣例樣板。**
handover §7 第一條記著「`CheckConstraint(name=)` 給的是樣板輸入，
不是最終名稱」。P2 Task 6 發現 **`op.drop_constraint` 也是**：

```python
op.drop_constraint("ck_food_revisions_source_valid", ...)   # ❌
# UndefinedObjectError: constraint
#   "ck_food_revisions_ck_food_revisions_source_valid" does not exist
op.drop_constraint("source_valid", ...)                      # ✅
```

**而它只在 `downgrade()` 被執行時才炸。** 只跑 `alembic upgrade head`
（CI 與部署都只跑這個）永遠不會發現 —— 那個 migration 會以「看起來
完全正常」的狀態進到 repo 裡，直到某天真的需要回滾。

抓到它的方法是 `alembic downgrade -1` → `upgrade head` 的來回測試。
**寫了 `downgrade()` 就要真的跑一次，不然那段程式碼從來沒有被執行過。**

### 由此長出的幾條規矩

1. **綠燈在被觀察到失敗之前不算證據。** 每個守衛都要突變過。
2. **要測 A 過濾器，測試資料必須讓 B 過濾器無效。**
3. **測試清理動作，就必須在它之後再做一件需要乾淨狀態的事。**
4. **順序要求需要「觀察順序」的測試** —— 端狀態測試在定義上抓不到。
5. **突變存活時先問「這一行真的是唯一實現該保證的地方嗎」**，再問「測試夠不夠力」。
6. **兩個視窗的重疊區間就是零鑑別力的區間。** 判斷方法不是背規則，是畫出來取重疊。
7. **文件擋不住重蹈覆轍，程式碼可以。** 與其寫第三次警告，不如把檢查寫進 helper，
   讓錯誤的選擇在執行時就爆掉。

8. **紅燈要問「它為什麼紅」。** 崩潰、被上游約束擋住、被另一道防線接走 ——
   都會讓儀表板變紅，但守住的不是你以為的那個東西。
9. **先問「這個缺陷所在的維度，在我的測試世界裡存在嗎」**，再問測試夠不夠力。
   共用交易的夾具看不見並行，共用 session 看不見 commit。
10. **靠時序自然發生的守衛不是守衛。** 要嘛確定性地建構那個情境，要嘛承認
    它沒有被守住。
11. **突變測試要用 git 還原；但 `git checkout -- <file>` 對還沒追蹤的新檔案
    沒有作用。** 新檔案的突變要手動改回並重跑測試確認（這一輪有人因此以為
    還原了、其實沒有，靠最後的全綠才確認沒有殘留）。

> **第 7 條是最貴的一課。** 「零鑑別力區間」這條規則是我自己寫下來的，
> 又在下一個計畫的說明裡重述了一次 —— 然後還是踩了。
> **知道一條規則，跟在具體情境裡認出它適用，是兩種不同的能力。**

### 第 30～34 種是 P5（記帳模組）長出來的

**第 30 種：`expire_on_commit=False` 讓 identity map 蓋住資料庫層的變化，
而且兩個方向都會說謊。** 測試 session 設了 `expire_on_commit=False`
（`tests/conftest.py`），所以 `select()` 命中 identity map 時**不會**用
資料庫的新值覆蓋已載入的屬性。`ON DELETE SET NULL` 把欄位改成 NULL 之後，
Python 物件仍是舊值：

- **假紅**：實作完全正確，測試卻失敗（P5 Task 2 實際遇到，浪費一輪除錯）
- **假綠**：斷言「某欄位沒變」時會被舊值騙過

斷言資料庫層副作用之前一定要 `await db_session.refresh(obj)`。
這個 codebase 在 `tests/test_supplement_plans.py` 早就寫過同一條教訓。

**第 31 種：未處理的例外不會變成「500 的 response」，所以
`assert response.status_code != 500` 這種斷言永遠跑不到。** httpx 的
`ASGITransport` 預設 `raise_app_exceptions=True`，而 Starlette 的
`ServerErrorMiddleware` 送出 500 之後**一定會重新 raise** 原始例外。
測試看到的是 `ValueError` 直接從 `client.get()` 冒出來，不是一個
`status_code == 500` 的物件。要守「這個輸入不會 500」，只能正面斷言
它回 422，並用突變證明那條斷言有咬合力。

**第 32 種：只斷言 404 的測試，在端點根本不存在時也是綠的。**
P5 Task 4 實測：計畫預測「8 條測試在實作前都會紅」，實際只紅 5 條——
另外 3 條斷言跨使用者存取回 404，而**路徑不匹配任何路由時 Starlette
也回 404**。那 3 條分不出「擁有權檢查擋下了你」與「這個路由沒被註冊」，
有人整個刪掉端點它們照樣綠。

修法：連 `error.code` 一起斷言。我們的 `NotFoundError` 是 `"NOT_FOUND"`，
路由不存在走 `handle_http_exception` 是 `"HTTP_ERROR"`。補上之後實測
突變（把路由路徑改成不匹配），三條全部由綠轉紅。

**第 33 種：`extra="ignore"` 提供的安全，沒有任何測試釘得住。**
規格說 `PATCH /api/expenses/{id}` 不能改 `meal_id`（搬到別人的餐點是個
攻擊面）。執行期確實安全——`meal_id` 不是那個 model 的欄位，Pydantic
預設 `extra="ignore"` 直接丟掉它。

**但那是「碰巧沒開洞」，不是「有東西擋著」。** 只要有人順手把
`meal_id: int | None = None` 加進去，洞就開了，而 595 條測試沒有一條會紅。
**結構性的安全一樣需要一根釘子。**

**第 34 種：100% 覆蓋率擋不住「所有測試都送同一種輸入」。**
P5 的 `spent_at` 宣告成 `datetime`，Pydantic 對沒有 offset 的 ISO 字串
一律放行成 naive，而 asyncpg 存進 `timestamptz` 時走 `dt.astimezone()`，
對 naive 值**假設執行程序的本機時區**。同一個輸入
`"2026-11-30T23:30:00"`：

- 開發機（Asia/Taipei）→ `2026-11-30T15:30Z` → 月報表算 11 月 ✅
- 容器（compose 與 Dockerfile 都沒設 `TZ`，等於 UTC）→ `23:30Z` → 算 12 月 ❌

`app/api/routes/expenses.py`、`app/days.py`、`app/models/expense.py`
三個檔案都是 **100% 覆蓋率**，595 條測試全綠——因為**每一條測試都送
帶 offset 的字串**。覆蓋率量的是「哪幾行被執行過」，不是「哪幾種輸入被試過」。

而 `<input type="datetime-local">` 產出的正好就是沒有 offset 的格式。

**這一種最危險的地方在於它只在 production 錯**：台北使用者在每個月最後
一天 16:00 之後記的每一筆都會跑到下個月，而開發機上永遠重現不出來。
修法是 `AwareDatetime`（naive 一律 422），而且那條測試必須自己被突變驗證過。

### 第 35～39 種是 P5 計畫二（記帳前端）長出來的

**第 35 種：測 `NaN` 的正規表示式在 zh-TW 環境永遠不會紅。** Intl 在
zh-TW 的 ICU 下把 `NaN` 格式化成「非數值」，`screen.queryByText(/NaN/)`
在本機（zh-TW）根本找不到東西，斷言「找不到」永遠成立——不是因為
程式沒印出 `NaN`，而是因為這個 locale 不會印出英文的 "NaN" 四個字母。
CI 跑在 en-US，/NaN/ 在那裡抓得到，本機抓不到：**同一條斷言在兩個
環境的鑑別力不一樣**，本機綠燈不代表這條守門真的在守。真正不依賴
locale 的是旁邊那條 `queryByText(/%/)`——總額為 0 時佔比不顯示，連
百分比符號都不該出現，這個斷言在任何 locale 下都抓得到同一件事
（`frontend/tests/expenses.test.tsx`，commit 9e4396b 寫下、4b7cbdc
補上這條說明的註解）。

**第 36 種：計畫寫的「除以零」測試根本沒有走到除法。** 計畫原本的版本
是餵一個總額 0 的月份（`by_category: []`）進 `MonthSummary`，但月總額
0 時 `by_category` 本來就是空陣列——`CategoryBar` 一列都不會渲染，
`ratioOf()` 根本沒被呼叫，不管除法怎麼算（哪怕直接 `Number(a) / Number(b)`
不做零檢查）測試都是綠的。改成不經畫面、不經 `QueryClient`，直接渲染
`<CategoryBar row={{ total: "0.00", ... }} monthTotal="0.00" />`，
才真的讓除法跑到。而且後端 `amount` 有 `CheckConstraint("amount > 0")`
（`app/models/expense.py`），真實資料不可能出現總額 0 的分類列——這個
防線守的是元件自己的契約（傳進一個理論上不會發生的輸入時不能炸），
不是在守現有資料會不會踩到它。

**第 37 種：拿掉 `isError` 分支，錯誤狀態的測試照樣綠。**
`MonthSummary` 的判斷式是 `query.isError || summary == null`
（`frontend/src/screens/Expenses.tsx`）。TanStack Query 在查詢失敗時
`data` 是 `undefined`，所以單靠 `summary == null` 就已經接住了錯誤
狀態——把 `query.isError ||` 整段拿掉，「報表讀取失敗時顯示『無法載入
本月報表』」那條測試不會變紅。**這不代表那條測試沒用**：它守的是
使用者看得到的行為（失敗時不能卡在「載入中…」），不是 `isError` 這個
子句本身。突變測試綠燈時要先分清楚它在守哪一層，再判斷是「測試沒用」
還是「這段程式碼本來就有安全冗餘」。

**第 38 種：裸的 `getByText` 在「有表單又有清單」的畫面上預設就該懷疑。**
計畫寫的測試 `screen.getByText("飲食")` 在 `/expenses` 畫面會撞到同一
畫面上新增表單的 `<option>飲食</option>`，兩個都符合，Testing Library
丟 `Found multiple elements`——要改成 `within(screen.getByTestId(...))`
限定範圍才能過。同一類錯誤後來又在執行者自己補的「記一筆之後總額跟著
更新」測試裡重演一次：月份裡只有一筆交通費時，分類佔比是 100%，
「總計」那一段跟「交通」分類列剛好顯示同一個金額字串 `"250.50"`，
裸的 `findByText("250.50")` 一樣會撞成找到兩個元素
（`frontend/tests/expenses.test.tsx`，commit 4b7cbdc）。同一個坑在
同一份計畫裡連中兩次：有表單又有清單的畫面上，看到裸的 `getByText` /
`findByText` 就該先問「畫面上還有沒有別的地方會出現一樣的文字」。

**第 39 種：「金額留空不送 cost」在實作前就是綠的，這是預期的，但計畫
沒有明寫。** `LogMeal.tsx` 加「金額（選填）」欄位之前，`POST /api/meals`
的 request body 本來就不帶 `cost` 這個鍵——`expect(body).not.toHaveProperty
("cost")`（`frontend/tests/log-meal.test.tsx`，commit dd15d12）在那個
狀態下必然成立，不是因為行為被測到，純粹是因為那個欄位還不存在。這是
一條**迴歸防護**：它要守住的是「以後有人手滑把 `cost: undefined` 之類
的東西塞進去」，不是「這個功能現在是對的」。計畫如果沒寫清楚「這條在
動工前就是綠的，而且應該是綠的」，執行者在 TDD 的紅燈階段看到它沒紅，
容易誤以為測試本身壞了而去改測試，而不是繼續往下做。

### 第 40～45 種是介面改版第一階段長出來的

**第 40 種：一則註解把錯誤的理由當事實寫，而且活過了好幾個版本。**
`App.tsx` 舊的 `<Nav>` 與 `api/me.ts` 都寫著「別把重新整理改成
`useMe().refetch()`——在 staleTime 內它不會發請求，e2e 也不會紅」。
TanStack Query v5 的 `refetch()` 會忽略 staleTime，一律發請求。計畫照抄
了這個說法，還據此設計了一條突變測試；突變存活了（Task 5），才發現前提
是假的（更正見 6d9405b）。**突變「應該」變紅卻沒紅，可能是前提錯了，
不一定是測試太弱**——先驗證前提，再去怪測試。

**第 41 種：斷言「某件事沒發生」，在動作是非同步時會空轉通過。**
「金額是 0 時不能送出」的測試在按下送出後立刻斷言沒有 POST；拿掉守衛
之後照樣綠，因為 `mutate()` 是非同步送出的，斷言跑的時候請求還沒出去。
要等一下（等到若守衛壞了請求必定已送出）斷言才有鑑別力（Task 6，
ecc48dc）。跟第 32 種（只斷言 404）同一個家族：負向斷言必須先證明它
有機會看到正向結果。

**第 42 種：`enabled: false` 的查詢在 TanStack Query v5 是
`isPending: true`。** 總覽的「今天的支出」要等 stats/daily 給日期才查；
stats 失敗時，若沒有明確檢查，時間線會永遠顯示「載入中」，不顯示錯誤
（Task 7，033b9ab；補了一條測試守著）。「還在等」與「永遠不會來」在
這個狀態旗標上長得一樣。

**第 43 種：`url.includes("/api/me")` 也會比對到 `/api/meals`。**
`app.test` 用子字串判斷的 mock 必須把 meals 排在 me 前面；e2e
`auth.spec` 的 `waitForResponse` 述詞有同樣的缺陷，會等到錯的請求。
Task 10 改成比對 pathname 相等（2864c94）。路徑前綴比對在有共同前綴的
端點之間一律不安全。

**第 44 種：「每個深色變數都覆寫一個淺色變數」的測試，在解析器兩邊都
什麼也沒找到時會通過。** 兩個空集合相等（Task 2 的紅燈階段實際看到）。
守衛是補一條「解析器至少找到 N 個變數」的測試，外加逐項宣告數量的
檢查（2e8aa9a）。凡是「A 集合等於 B 集合」的斷言，都要先斷言集合不是空的。

**第 45 種：新首頁選了「錯誤優先於資料」，悄悄廢掉了離線的第二層快取。**
總覽在重試失敗後，把已快取的數字換成「無法載入」——在 Tailscale 上
很常見：網路是通的，後端連不到。測試全綠，因為沒有任何一條測試先塞快取
資料、再讓重新抓取失敗（Task 7 審查發現；修法與測試在 5a87243）。
行為優先順序（錯誤 vs. 資料）是一個設計決定，要有對應的測試狀態把它
釘住，不能只測「有資料」與「沒資料」兩端。


### 第 46～48 種是「食物的一份」長出來的

**第 46 種：「422 而且什麼都沒寫入」證明不了同一個交易。** 規格把它當作
「食物與份量同一個交易」的測試，但 Pydantic 在 handler 之前就擋下來——不管
實作是一次還是兩次 commit 都會綠。真正有鑑別力的是讓寫入「走到資料庫才失敗」：
monkeypatch 讓份量的 grams 變成 -1，在 commit 時被 CHECK 擋下，再確認食物沒
留下（e62e0b0；突變：份量另外 commit → 紅）。

**第 47 種：單向的自動切換把「每份」的數字當成「每 100」存進去，測試全綠。**
新增食物的重量一清空就把模式切回每 100，重打重量後不會切回去——210 kcal/份
會被存成每 100 的 210。數字在合理範圍內，沒有任何驗證擋得住；原本的測試只測
「清空會切回」，沒有人測「清空再重打」。修法：把「使用者的選擇」與「實際生效
的模式」分開（44ff563）。手機上改數字最常見的方式就是先刪成空白。

**第 48 種：Playwright 的 `getByLabel` 預設是子字串比對。** 新增食物多了
「份量名稱」，既有 e2e 的 `getByLabel("名稱")` 同時抓到兩個欄位（strict mode
失敗）。計畫寫「既有 e2e 不應該需要改」——錯的。testing-library 的
`getByLabelText` 預設是完整比對，所以單元測試完全看不出來（9714183 與 trend
那一筆 ce38e06）。

### 第 49、50 種是「修改與刪除已記錄的餐點」長出來的

**第 49 種：比的是算出來的數字，回應的精度從來沒人看。** `POST /api/meals/{id}/items`
從 P1 起就回 `quantity_g: "100"`，不是 `"100.00"`——session 是
`expire_on_commit=False`，新建的項目沒有 refresh，join 查詢從 identity map 拿回
記憶體裡使用者給的 `Decimal`。既有測試只斷言 kcal 與總計（那些是重新算的），
所以一直綠。新的 PATCH 一項端點寫計畫時就踩到同一個坑才回頭發現（96d136a）。

**第 50 種：斷言「呼叫了 `removeQueries`」，證明不了「沒有重抓」。** 刪照片的
測試 spy 到 `removeQueries(mealPhoto)` 有被呼叫，就綠了；但照片預覽還掛著，
下一次 render 把剛移除的 query 重建、又抓了一次已經刪掉的照片（404）——正好是
那一行註解說要避免的事。品質審查直接跑 query-core 才看到。有鑑別力的斷言是數
`GET .../photo` 的次數（9d51747）。斷言「做了某個動作」跟斷言「那個動作要達成
的效果」是兩件事。

### 第 51、52 種是「AI 估算的前端」長出來的

**第 51 種：`toHaveBeenCalledWith({ image: file })` 對任何一個 File 都成立。**
File 沒有自己的可列舉屬性，Vitest 的深比較把兩個內容、名稱都不同的 File 當成
相等——「交回的是原始照片，不是縮過的那張」這條規則（AI 估算規格 §5.1）
其實沒被驗到。而且縮圖的 mock 原樣回傳同一個物件，就算比對得出來也分不出差別。
有鑑別力的寫法：讓 mock 回另一個 File，再用 `toBe(photo)` 比同一性（05b2ac2）。

**第 52 種：測試只改了一個欄位，其他「要照使用者改的值」的保證沒被驗到。**
「改過才確認」的測試只改熱量，名稱與一份的重量維持 AI 的原值——於是把
`default_portion.grams` 寫成 AI 的重量、或把名稱寫成 AI 的名稱，測試照樣綠，
因為那兩個值本來就相等。規格寫「改過的一份重量」，而測試資料讓「改過的」與
「原本的」無法區分（c89bf5a）。跟第 2 種同一個家族：測試資料在原理上不可能讓錯的
實作失敗。

**附記：第 48 種又踩了一次，而且是反過來的。** 記一餐的搜尋框下面多了「用 AI 估算
『{食物名}』」按鈕——名稱**含有**食物名，所以既有 e2e 的
`getByRole("button", { name: foodName })` 點到了 AI 按鈕（4 個 spec 紅）。新元件的
可及名稱包含既有元件的名稱時，舊測試會被新元件「搶走」；點食物一律 `exact: true`
（d7e2c0e）。

### 第 53 種是「介面改版第二階段」長出來的

**第 53 種：斷言在換頁之前就對舊畫面成立了。** `supplements.spec.ts` 點了「新增補劑」
連結之後馬上 `expect(getByRole("heading", { name: "補劑" })).toBeVisible()`——
Playwright 的名稱是子字串比對，而**還沒換頁的飲食頁**剛好有一個「今日補劑」標題，
於是斷言對上一頁就成立了，驗的根本不是補劑頁。換頁比較快的時候，補劑頁有「補劑」
「新增補劑」「找補劑…」三個標題都含「補劑」，嚴格模式報錯——這正是那條 e2e
偶發紅燈的原因（一直被當成「不穩」略過）。`exact: true` 同時修掉兩件事。
**換頁之後的第一個斷言，要選一個只有新頁面才有的東西。**

### 小項目包：第 5 種又踩了一次，另外兩條假綠燈

**第 5 種（兩個過濾器互相掩護）換了個地方再出現。** 份量的修改、刪除有兩層檢查：
食物要看得到（`load_visible_food`），份量要是公開的或自己的。原本「看不到的食物上
的份量 → 404」的測試用的是 Alice 私人食物上的 **Alice 私人份量**——Bob 動它的時候，
份量的擁有者過濾本身就擋住了，拿掉食物那一層照樣 404。真正只有食物那一層擋得住的
情境是「私人食物上的**公開**份量」（管理員建得出來）：拿掉 `load_visible_food`，
一般使用者會拿到 403（等於透露那個私人食物存在），別的管理員甚至改得動（4713473）。
**要證明某一層有用，測試資料必須讓其他每一層都放行。**

**第 11 種（共用交易看不見沒 commit）也再出現一次。** 拿掉 `delete_portion` 的
`await db.commit()`，24 條份量測試全綠——client 跟測試共用 `db_session`，之後的
`GET` 自動 flush 了那個待處理的刪除。正式環境裡 `get_db` 關掉 session 不 commit，
端點回 204 卻什麼都沒刪。修法照第 11 種：DELETE 之後先 `rollback()` 再斷言（2bbeafe）。

**附記：只比狀態碼的 403 測試。** 把錯誤碼改名、測試照樣綠；補上錯誤碼與「份量
還在、沒被改」（第 3 種的形狀）。

### 開帳號的路：第 17 種在產品裡再出現一次

**第 17 種（持久化快取＋`staleTime` 讓 reload 讀到舊快照）這次不是測試的問題，是
產品的問題。** 邀請的 e2e 最後一步「重新整理『我的』，看到朋友用掉了邀請」紅了：
app 的 `queryClient` 預設 `staleTime` 60 秒、快取會持久化，reload 從 localStorage
還原出一分鐘內的舊清單、不重抓。單元測試全綠，因為測試的 `QueryClient` 是預設的
`staleTime: 0`——**測試環境的預設值跟 app 不一樣，那個差異正好就是 bug 所在。**
修法：`useInvites` 自己設 `staleTime: 0`；單元測試用 60 秒的 `staleTime` 加預先放好
的快取證明會重抓（df432e1）。實作的子代理一開始的作法是把 e2e 改成開新的瀏覽器
繞過去——**繞過測試抓到的行為，等於把 bug 留給使用者**。

### 好友關係：第 48、53 種又一次

好友卡片在「我的」頁加了一個「我的好友碼」標題，既有的 `auth.spec.ts` 用
`getByRole("heading", { name: "我的" })`——子字串比對同時對到「我的」與「我的好友碼」，
嚴格模式報錯。Task 5 的子代理只跑了單元測試，全部 e2e 到 Task 8 才發現（749d20e）。
**新增一個標題或按鈕，先 grep e2e 裡有沒有名稱是它子字串的選擇器。**

### 帳號與目標設定：第 18 種又一次

計畫寫的改密碼 e2e：A 改完密碼之後 `page.reload()`，「新票沒存好或被撤銷了，這裡會掉回登入畫面」，
所以斷言「修改密碼」標題還在。**那個前提不成立**：換票 401 時 `auth/refresh.ts` 清掉 token 與快取，但 `App` 的
`loggedIn` 只在開頁時讀一次 localStorage，畫面**不會**切回登入；靜態的標題照樣畫得出來，「我的」的資料又可能來自
離線快取、根本不發請求。實測兩個突變——後端把 `start_session` 搬到 `revoke_all_for_user` 之前（新票自己也被撤銷）、
前端 `changePassword()` 不 `setTokens`（localStorage 還是被撤銷的舊票）——只看畫面的版本**都是綠的**。
換票成功與失敗，畫面一模一樣（第 18 種）。改成看伺服器：reload 之前 `waitForResponse("/api/auth/refresh")`，點「我的」的
「重新整理」（直接打 `/api/me`，記憶體裡沒有 access token → 401 → 換票），斷言**換票的回應是 200**；兩個突變都在這一行紅。
**要證明「還登入著」，看換票或一個要認證的請求的回應，不要看畫面。**

**審查之後（I2）那個前提成立了**：換票 401 現在會切回登入畫面（見第 10 節「帳號與目標設定」）。
e2e 的 B 裝置因此多了畫面的斷言——讓 access token 過期、點「我的」，換票 401、落在登入畫面、
看到「已被登出，請重新登入」；A 那一段「換票是 200」留著，它仍然是最直接的證據。

**審查修正時又踩到的三種：**

- **第 30 種（identity map 蓋住資料庫）換了個方向。** 「登入驗完密碼之後重讀雜湊」的迴歸測試
  如果用共用的 `client`／`db_session`：登入手上的 `user` 跟改密碼那個請求改的是 identity map 裡的
  **同一個物件**，把重讀寫成 `user.password_hash`（正式環境永遠讀到舊值）也是綠的。那幾條測試
  每個請求開一條真的連線（`tests/test_login_password_race.py` 的 `real_client`）；突變實測，
  共用 session 的版本抓不到。
- **第 14、15 種。** 同一個修正的另外兩半——「取鎖要在重讀之前」「鎖要握到 session commit」——
  在共用交易裡不存在。用事件把登入停在指定的位置（取鎖之前、開 session 之前），另一側做完或
  從 `pg_stat_activity` 看到它卡在鎖上才放行。重設密碼的鎖順序（M3）同理，而且**不等死結真的
  發生**（那要賭 `deadlock_timeout`）：等重設卡在使用者列上，用 `FOR UPDATE NOWAIT` 直接問
  「連結列現在有人握著嗎」。
- **第 41 種。** 「表單出來之後，背景重抓失敗不會把表單換掉」：`await client.refetchQueries()`
  回來時 query 的狀態已經是 error，但 TanStack 是排程之後才通知畫面的——緊接著斷言「輸入框還在」
  看到的是重抓之前的畫面，把表單直接綁在 query 上的突變是綠的。等一下（`act(() => settle())`）
  才紅。

### 報表看其他月份與匯出資料：第 30／49、38 種又一次，另外兩條假綠燈

沒有編新的號碼：前兩條是既有的種類，後兩條是執行時量到的，機制都不新。

- **第 30、49 種（共用 session 讀到記憶體裡的舊值）只在有人握著那個物件時成立。** 匯出餐點項目的查詢原本加了
  `populate_existing`，理由是「工廠留在 identity map 的 `Decimal("150")` 會蓋住資料庫的 `150.00`」。突變（拿掉它）
  **存活**：identity map 是弱參照，工廠建的 `MealItem` 沒有人握著就被回收了，查詢拿到的本來就是資料庫的值。
  那一行沒有任何測試看得到它的效果，刪了。之後有測試握著物件再去比匯出的份量，要在測試裡 `refresh`。
- **第 38 種（同一段文字在畫面上出現兩次）。** 報表的摘要裡「999.00」出現兩次（總計、佔 100% 的那個分類），
  「2026年11月」也是兩次（月份標籤、清單的 `<h2>`）。總額比 `toHaveTextContent("總計 999.00")`，月份標籤用
  `within(group).getByRole("status")`。
- **只測了一個方向（突變存活才發現）。** 匯出卡片的規格是「再按一次先清掉上一次的訊息」，計畫的測試只有「成功把上一次的
  **錯誤**清掉」；「開頭不清掉上一次的『已下載』」這個突變全綠——先成功、再失敗時畫面上同時寫著「已下載 …」與
  「下載失敗」。補了一條反方向的測試（`tests/export-card.test.tsx`「先成功、再按一次失敗」）。
  **「清掉上一次的狀態」有幾種狀態，就要有幾個方向的測試。**
- **測試全綠，但那個工具本來就不看型別。** 計畫的 e2e spec 在 Playwright 底下三條全綠，卻過不了 `tsc -b`
  （8 個 `TS18048`，見 §7「Playwright 不做型別檢查」），而且就這樣進了一個 commit（`ac2372b`，下一個 `81f0df7` 修掉）。

**審查修正（I1）又長出兩條，都是「測試全綠、對真的伺服器跑才看到」：**

- **修一個洞，開了另一個洞。** 「每一塊之後把連線還回去」的測試全綠（每一次 `send` 的那一刻借出數是 0）。對真的 uvicorn
  跑斷線探針，結束時 `checkedout` 卻是 1：每一塊都重新借連線之後，斷線的取消有機會落在「借」（pre-ping）的中間，而
  SQLAlchemy 在被取消的 anyio scope 裡關不掉那條連線、也就沒有把它登記回去——要等垃圾回收。原本整個串流只借一次
  （在認證的時候，不在會被取消的範圍裡），所以這條路以前不存在。**把一個資源從「借一次」改成「借很多次」，
  每一次借都是一個新的可以被打斷的地方。**
- **有限的資料讓「取消沒有送達」看起來像「正常結束」。** 上一條的修法是把「借 → 查 → commit」擋住取消（shield）。
  測試全綠（連線是同一條、沒有 ERROR）。再跑探針：斷線之後串流**根本沒有停**——generator 在兩個 `yield` 之間做的事全在
  shield 裡，外面只剩 `yield`，而斷線後 uvicorn 的 `send` 馬上回來、不等任何東西，取消永遠沒有地方可以送達。測試裡
  只有三列資料：讀完就結束了，跟「被取消了」分不出來；探針的假 generator 是無限的，才看得出來。補的斷言是
  **「斷線之後一塊都沒有再送」**（`sent == ["start", "chunk"]`），不是「請求有結束」。
- 寫那幾條測試時量到的：**事件 hook 測不到「資料庫操作被打斷」**——`before_cursor_execute`、`commit` 的 hook 在
  SQLAlchemy 處理 DBAPI 例外的那一層外面，在 hook 裡被取消不會讓連線作廢（第一版的測試因此假綠）。要停在
  dialect 的方法裡（`_do_ping_w_event`、`do_execute`、`do_commit`）。
- **第 17 種又一次，而且是這個分支自己的 spec。** `reports-export.spec.ts` 的月份那一條 `page.reload()` 之前沒有清離線
  快取。驗證審查修正時完整跑一輪紅了一次：翻回這個月看到「總計 0.00／這個月還沒有支出」。那是**記帳之前**總覽存進
  localStorage 的那一份「這個月」——離線快取是節流寫入的（一秒一次），reload 還原回來的可以是記帳之前的快照，而它還在
  60 秒的 `staleTime` 裡、不會重抓。單獨重跑 12 次全綠（平常 reload 的那一刻快照裡根本還沒有這個 query：16 次裡 15 次）；
  把「之後的寫入都還沒發生」固定下來（擋掉 `setItem`）就**每次**都是那個畫面。修法照第 17 種：reload 前清掉那一個 key。
  **這不只是測試的事**：使用者記完一筆、一秒內重新整理，也可能看到舊的總額，最多 60 秒（或到下一次失效為止）——
  沒有修，記在這裡。

---

## 7. 踩過的技術坑（節錄，完整版在各計畫文件）

| 坑 | 結論 |
|---|---|
| `CheckConstraint(name=)` | 是命名慣例的**輸入**，不是最終名稱。只有 CheckConstraint 這樣 |
| `ExcludeConstraint(name=)` | 慣例**不介入**，`ex_` 前綴要自己寫 |
| `Enum(create_constraint=True)` | 會讓 `alembic check` **永久報漂移**，無法收斂。要用 `False` + 手寫 CheckConstraint |
| 同上，**規矩有兩半** | 只寫 `create_constraint=False` 而忘了手寫約束 = **完全沒有約束**，所有靜態檢查與測試都綠 |
| `CHECK (x >= 0)` 對 NULL | **放行**。CHECK 只在求值為 FALSE 時擋，`NULL >= 0` 是 NULL。擋 NULL 要用 `NOT NULL` |
| compose 變數代換 | **每個檔案各自解析**，不是先合併再代換。`${VAR:?}` 不能寫在共用 base |
| compose `volumes` / `ports` | **合併不取代**，override 拿不掉 —— 所以 dev-only 的東西要寫在 dev override |
| `tzdata` | Windows 沒有系統時區庫，Linux 有 → 不宣告會「CI 綠、本機紅」 |
| **CI 沒開 `-W error`** | 本機開、CI 沒開，而 CI 的 `JWT_SECRET` 短到會觸發 `InsecureKeyLengthWarning` —— **兩邊都不會因為警告變紅**（本機有嚴格模式沒觸發條件，CI 有觸發條件沒嚴格模式）。§6 第 5 種的 CI/本機版本 |
| PG `AT TIME ZONE` vs Python `zoneinfo` | 兩套獨立實作。實測 90 個時刻 0 不一致，但有測試釘住漂移 |
| asyncpg `contype` | `"char"` 回傳成 **bytes**（`b'c'`），比對要加 `::text` |
| asyncpg 日期參數 | 要傳真的 `date` 物件，`$1::date` 配字串會拋 `DataError` |
| testing-library 的文字正規化 | `getByText` 把 DOM 文字裡的空白（含全形空白 U+3000）壓成一個半形空白，但**傳進去的字串不會**——寫了全形空白的斷言永遠對不上（AI 估算 Task 4） |
| **零權重（`:where()`）樣式的順序** | 介面改版第二階段的 `.screen` 規則全部包在 `:where()` 裡（權重 0，讓元件自己的 class 一定贏）——代價是**它們之間誰贏完全看順序**：通用的 `fieldset`／`ul` 重設寫在「卡片」規則後面，就把卡片的內距蓋掉了（踩了兩次）。`ui.module.css` 檔頭寫明順序：通用重設 → 卡片 → 明確的覆寫。另外，`index.css` 裡權重 (0,1,0) 的全域 class 會贏過任何 `:where()` 規則 |
| e2e 量版面 | jsdom 不做版面計算，「按鈕 ≥ 44px」只能在 Playwright 量（`e2e/touch-targets.ts`）。但**量高度證明不了排列**：趨勢的切換鈕被排成直的一列時，44px 照樣過——是看截圖才發現的 |
| TanStack v5 mutation 的 callback | `useMutation({ onSuccess })` 在元件卸載之後**仍然會跑**；`mutate(vars, { onSuccess })` 不會。會導頁或改父層狀態的事放在後者（編輯餐點 Task 6、AI 估算 Task 4） |
| `docker ps` 顯示 `Up` | **不代表活著**。uvicorn reloader 父行程在子行程崩潰時仍活著 |
| 改環境變數後 `restart` | **不夠**，要 `up -d`（會重建容器） |
| 在本機起 prod 疊加設定 | 會**接管同名的 dev 容器**（專案名稱相同），dev 的 `db` 會失去 `5433` 的埠發佈。驗證完要 `down` 再 `docker compose up -d` 把 dev 收回來，否則 host 上的 pytest 連不到資料庫 |
| prod 疊加檔不帶 `docker-compose.release.yml` 就 `up -d` | 改用 CI 映像之後，`-f docker-compose.yml -f docker-compose.prod.yml up -d` 會**用 NAS 上的原始碼 build** 新映像、換掉 CI 的映像（`build:` 還在那兩個檔案裡）。改了 `.env.production` 要重建容器時，用同一個版本重跑 `deploy.sh` |
| `docker compose up` 等 `depends_on: service_healthy` | 依賴的容器**一直重啟**時 compose 會回「dependency failed to start: … is unhealthy」並非零結束，被依賴的那個（caddy）停在 `created`、**沒有人會再啟動它**。`deploy.sh` 看到 `up` 失敗就不再等、直接退版 |
| 改依賴後 | **必須重建映像**，`--reload` 只換程式碼不換依賴 |
| **新增 migration 後** | 也**必須重建映像**。`Dockerfile` 是 `COPY . .`，migration 檔案是烤進映像的，不是掛載的 —— dev 的原始碼掛載只有 `./app`。症狀是 `relation "xxx" does not exist`，而檔案明明在 repo 裡 |
| `ruff format` | **CI 只跑 `ruff check .`，沒有跑 `ruff format --check`**。這個 repo 有既有的格式差異，跑 `ruff format` 會把一堆跟你這次改動無關的行重排進 diff 裡。不要在不相干的改動裡順手跑它 |
| vitest 的 `Test Files` / `Tests` | **`Test Files` 是實際檔案數的兩倍；`Tests` 大約兩倍、但不是剛好兩倍。** `vite.config.ts` 的 `typecheck.include` 跟一般 include 蓋到同一組檔案，每個檔案被跑兩次（一次執行、一次交給 tsc）；`it.each` 在執行那次展開成好幾條、在型別那次算一條，所以 `Tests` 除以二不是整數也不是真的條數。**文件裡一律寫 vitest 印出來的數字**（§2），不要自己換算 |
| 只 grep `Tests ` 那一行 | **會漏掉整個檔案沒編譯成功**。一個 transform parse error 讓 vitest 同時印出 `FAIL tests/x.test.tsx (0 test)` 與 `Tests 8 passed (8)`。驗證要一起 grep `FAIL` 與 `Unhandled` |
| render 期例外的錯誤訊息 | `Failed Tests` 第一層顯示的是 `TestingLibraryElementError`（找不到元素），**真正的 `TypeError` 在要往下翻的 `Unhandled Errors` 區塊** —— 元件樹整個沒畫出來，沒有 error boundary 接住 |
| biome `noAriaHiddenOnFocusable` 對 SVG `<text>` | **誤判**。SVG 的 `<text>` 不能聚焦，但規則把它當成可聚焦元素；趨勢圖日期軸的文字是裝飾（柱子的 aria-label 已經有日期），用 `biome-ignore` 加理由（`TrendChart.tsx`） |
| 份量的「預設」沒有部分唯一索引 | 「同一個擁有者、同一個食物只有一個預設」靠的是同一個交易裡先取消其他預設，**兩個同時送出的請求可能各自成功**、留下兩個預設。單人使用不會發生；要擋就加 `WHERE is_default` 的部分唯一索引（要 migration） |
| 限速的上限只在單元測試裡驗 | **單元測試每個測試都重置計數器、各用一個新帳號，永遠碰不到「同一個帳號在真實使用裡一分鐘打幾次」**。換票限速一開始定 10 次，單元測試全綠，完整 e2e（同一個帳號一直開新頁，每次整頁載入都換票）才紅。定上限之前先量真實的頻率（`docker compose logs api` 數 `POST /api/auth/refresh`） |
| `// biome-ignore` 在 JSX children 位置 | **會被當成文字**，裡面的 `<rect>` 之類會被解析成開始標籤 → parse error。那個位置要用 `{/* biome-ignore … */}`；`return (` 之後屬於運算式位置，`//` 形式合法 |
| Windows Python 改 markdown | 文字模式寫入會把**整份檔案**轉成 CRLF，跟 `.gitattributes`（`* text=auto eol=lf`）衝突，整個 diff 變成雜訊。用 `newline="
"` |
| `tsBuildInfoFile` | 要放在**被 gitignore 蓋到的目錄**（這個 repo 是 `./node_modules/.tmp/`）。`tsconfig.e2e.json` 原本指向 `./e2e_modules/.tmp/`，於是那個 build cache 一直被 git 追蹤，每跑一次 typecheck 就多一個 modified |
| 改了後端的 request/response schema | **一定要 `npm run gen:api` 重新產生 `frontend/src/api/schema.d.ts`**，而**本機沒有任何東西會提醒你**。**連 docstring 也算**——端點的說明文字會進 OpenAPI 的 `description`。2026-10 連續三次漏（安全補強、改吃的時間各改了一段 docstring 沒重新產生，都是下一個分支才補上）：**任何動到 `app/api/routes/*.py` 或 `app/schemas/*.py` 的 commit 都重新產生一次**。唯一的守衛是 CI 的 `contract` job（它起後端、重新產生、`git diff --exit-code`）。P3-B 計畫二 Task 8 加了 `FoodCreateRequest.is_global` 卻沒重新產生，backend / frontend / e2e 三個 job 全過，只有 contract 紅 |
| react-router 的路由順序 | **依片段具體程度排名，不依宣告順序** —— 跟 FastAPI 完全不是同一種機制。`/foods/:id` 排在 `/foods/new` 前面，`/foods/new` 仍然命中靜態路徑（用 `matchRoutes` 實測過） |
| 換票失敗之後的畫面 | ~~不會切回登入畫面~~——**帳號設定審查 I2 之後會**：`clearTokens()` 真的清掉儲存時通知 `auth/store.ts` 的 `onLoggedOut` 訂閱者，`App` 切回登入畫面；不是自己按的登出（換票 401、另一個分頁登出）顯示「已被登出，請重新登入」。**登入的方向仍然不是 store 驅動的**（`Join` 要先換網址再 `onSuccess`）。e2e 要證明「還登入著」仍然先看 `/api/auth/refresh` 的回應——401、429、5xx、斷線裡只有 401 會登出 |
| Web Locks 不能重入 | 握著 `token-refresh` 的程式碼裡再呼叫 `refreshTokens()`（它會要同一把鎖）會永遠等不到自己放手。改密碼握著鎖送請求，access token 過期時會先 401、要換票——所以 `withTokenLock` 交給 task 一個「已經在鎖裡」的換票函式，`apiFetch` 的第三個參數收它（帳號設定審查 M6） |
| e2e 開一次性連結 | `/join#…`、`/reset-password#…` 的碼只在第一次 render 讀。同一個 page 再 `goto` 一條只有 `#` 後面不同的連結，瀏覽器不重新載入、畫面停在上一條的結果——**每條連結開新的 context**。登出之後的登入也不換網址：登出前在 `/me`，登入後就在「我的」，不是總覽 |
| **突變成無限迴圈** | keyset 分塊的 `(時間, id) > 游標` 改成 `>=`：generator 永遠查到同一塊，**測試不會紅，只會跑不完**（寫匯出的計畫時實際卡住過）。突變工具要有 timeout；被砍掉之後記得把檔案改回來、`.py` 還要 `touch` |
| `StreamingResponse` 與 `yield` 依賴 | **FastAPI ≥ 0.118** 才是「回應送完才收尾」；更早、或 `Depends(get_db, scope="function")`，session 在第一塊送出之前就關了（`pyproject.toml` 的下限、`tests/test_export.py` 的收尾順序測試）。另外 `httpx.ASGITransport` **把整個回應收完才交回來**：「一塊一塊吐」在端點層看不到，分塊要直接測 generator |
| 原始碼裡看不見的 BOM（U+FEFF） | 計畫的程式碼片段把 BOM 直接寫成字面值：複製、重打、經過工具轉手都可能**無聲地掉了**，而那幾條測試守的正是「BOM 還在」。一律寫成跳脫字元——Python `"\ufeff".encode()`、TypeScript `"\uFEFF"`；`grep -n $'\xef\xbb\xbf'` 找得到漏網的。**反方向也會**：寫這一列的時候，編輯工具把打進去的跳脫字元換成了真的 BOM——動到它的檔案，commit 前數一次位元組 |
| **Playwright 不做型別檢查** | spec 用 esbuild 轉譯就跑，型別錯了照樣綠；`npm run typecheck`（`tsc -b`，含 `tsconfig.e2e.json`）才看得到。`noUncheckedIndexedAccess` 底下從陣列解構出來的每一個都多一個 `undefined`，只擋 `null` 的 `if` 縮不掉（`reports-export.spec.ts` 第一版就這樣進了一個 commit）。**加了 spec 之後 typecheck 要重跑**，而且檢查與 `git commit` 之間用 `&&` 串，不要用 `;` |
| **串流 generator 的 `finally`** | **不保證會跑**。Starlette 不會 `aclose()` 交給 `StreamingResponse` 的 generator：用戶端斷線時它取消的是卡在 `send` 的那個 task，generator 停在 `yield` 上，`finally` 要等垃圾回收；標頭就送不出去時 generator **從來沒被迭代**，`finally` 永遠不跑。`background=` 只在送成功之後才跑。**要在回應結束時一定收尾的東西，放在 `yield` 的依賴裡**（FastAPI ≥ 0.118 在送完、失敗、被取消、沒開始之後都會收尾；`export_slot`） |
| anyio 的 shield | `with anyio.CancelScope(shield=True):` 擋的是 anyio cancel scope 的取消（Starlette 斷線時用的那種），**擋不住直接對 task 的 `cancel()`**。擋完之後取消在「下一個真的會等的 await」才送達——如果外面只剩 `yield` 與一個不等任何東西的 `send`，它永遠送不達：擋完自己 `await anyio.lowlevel.checkpoint_if_cancelled()`。`with` 裡面不能有 `yield`（cancel scope 不能跨 yield） |
| SQLAlchemy：取消落在資料庫操作中間 | 被取消打斷的 execute／commit，連線會被**作廢**；在 anyio 已取消的 scope 裡連終止都會再被取消一次，log 一個 `Exception terminating connection … CancelledError` 的 ERROR。落在**借連線**（pool checkout、pre-ping）的中間更糟：那條連線沒有人握著、也沒被登記回去，`pool.checkedout()` 多一條，直到垃圾回收（那時再 log 一個 `garbage collector is trying to clean up non-checked-in connection`）。2.0.52 實測 |
| `session.commit()`／`rollback()`／`close()` 結束一個只讀的交易 | 對資料庫都一樣，連線都回到池子。差別在 session 裡的物件：`rollback()` **一律**讓它們過期（`expire_on_commit=False` 管不到），之後碰屬性就是 `MissingGreenlet`；`close()` 把它們踢出 session。共用一個 session 的測試夾具會踩到——匯出用 `commit()` |
| `httpx.ASGITransport` 與斷線 | 它的 `receive()` 要等回應送完才回 `http.disconnect`，測不到「送到一半斷線」；而且 app 沒送結尾就回來時它自己 `assert response_complete`。要模擬斷線：在 `app` 外面包一層 ASGI，換掉 `receive`（事件 set 之後回 `http.disconnect`）、app 回來之後替它補一個結尾（`tests/test_export.py` 的 `_on_the_wire`）。同一層換掉 `send` 就能看到「每一次送的那一刻」——這是端點層唯一看得到分塊的地方 |
| jsdom 與 `inert`、`disabled` 的焦點 | jsdom **不實作 `inert`**（`userEvent.click` 照樣點得到），也**不會因為按鈕變成 `disabled` 把焦點移走**（Chromium 會）。單元測試只能守機制（屬性在不在、是不是原生 `disabled`）；行為要在 Playwright 守——用座標 `page.mouse.click`，因為 `locator.click()` 會等到元素點得到為止。另外 jest-dom 的 `toBeDisabled()` **不認** `aria-disabled`，Playwright 的 `toBeDisabled()` **認** |
| Playwright 抓下載 | `page.waitForEvent("download")` 抓得到 `<a download href="blob:…">` 的點擊；`suggestedFilename()` 就是 `download` 屬性——沒有它時檔名是一串 UUID。內容用 `download.path()` 讀成位元組再比（BOM 要比位元組，轉成字串就看不到了） |

---

## 8. 已知缺口與延後項目

### 8.1 已完成：session 撤銷

**refresh token 改為輪替制。** 換發時舊票當場失效；舊票被重複使用一律判定
外洩，撤銷整條 family（同一次登入衍生的所有票）。新增
`POST /api/auth/logout`（單一裝置）與 `/logout-all`（全部裝置）。

**刻意留著的缺口：** access token 不查資料庫，所以撤銷之後該裝置手上那張
**最多還能再用 15 分鐘**。有一條測試明確斷言這個缺口存在
（`test_an_access_token_still_works_after_logout_and_that_is_deliberate`），
避免日後有人「順手修好」它而沒發現效能代價。

**並行安全靠一把每使用者的 advisory lock。** 沒有它，重用偵測在並行下有
極高機率留下一張活票（見上面第 14 種）。`rotate_session`、`revoke_session`、
`revoke_all_for_user` 三條路徑都要取那把鎖。**`login` 是第四條**（帳號設定審查 I1）：
驗完密碼之後取鎖（`lock_user_sessions`）、重讀雜湊、才開 session——不然在改密碼之前就驗完
舊密碼的登入，會在撤銷之後才插入它的 session（見第 10 節「帳號與目標設定」）。

規格：[session 撤銷設計](superpowers/specs/2026-09-11-session-revocation-design.md)
計畫：[實作計畫](superpowers/plans/2026-09-11-session-revocation.md)（含 20 條突變的實測結果）

### 8.1a P3-B 是在一個沒有成立的前提下做完的

P3-A 規格說「趨勢圖要看什麼、食物庫要怎麼找，這些問題在累積了兩週真實
資料之後才有答案」。**那個前提到現在仍然沒有成立** —— 整個 P3 從來沒有
被部署到 NAS，也就沒有被真的每天用過。

底下這四件事**不得以 localhost 的結果代替標記完成**（`127.0.0.1` 是
secure context，所以本機上這些能力全部可用，那個綠燈證明不了手機上的情況）：

1. Plan 1 Task 1 的 HTTPS（`tailscale serve` 或 `tailscale cert` + caddy）
2. 真機的 `isSecureContext` / `serviceWorker` / `navigator.locks` 驗證
3. PWA 安裝、standalone、飛航模式檢查
4. 一次真的用手機登入

**做完這四件、真的用兩週之後，回頭看趨勢圖那一節。**

### 8.1b 已完成：`/refresh` 與 `/logout` 限速（安全補強，2026-10-07）

原本兩者都是未認證、可無限重放的寫入路徑，而且都會取每使用者的 advisory lock
（實測：12 條並行連線重放一張早就死掉的票，每秒 302 次，把合法換發的中位數從
7.2ms 拉到 34.2ms）。現在（規格 `docs/superpowers/specs/2026-10-07-hardening-design.md`）：

- `app/ratelimit.py` 的 `KeyedRateLimiter`（每一次都算，跟只算失敗的登入限速分開）；
  `session_rate_limiter` **每張票（鍵是 token 的 `jti`）每分鐘 60 次**，同一張票的兩個端點共用。
- 順序：**先驗簽取 `jti` → 計數 → 才碰資料庫與鎖**。簽章不對的票不計數（驗簽不碰資料庫）。
- **鍵是 `jti`，不是 `sub`**（審查後改的）：換過、登出過、撤銷過的舊票 14 天內仍驗得過簽章。
  鍵是 `sub` 的話，拿到某人任何一張舊票就能每分鐘打 60 次、讓那個人在所有裝置上一直 429
  （換不了票，access token 一過期就用不了）。鍵是 `jti` 時重放舊票只燒掉那張舊票的額度；
  正常輪替每次都是新的 `jti`，不會被擋；洪水仍壓在每張票每分鐘 60 次。
- **60 不是一開始的 10**：每次整頁載入都會換一次票（access token 只在記憶體），10 次時
  一次完整 e2e 同一個帳號換了 23 次、7 次被擋——連續重新整理、多個分頁的真實使用也會碰到。
  60 次仍把重放壓低 300 倍。
- **前端只有 401 才登出**（`auth/refresh.ts`）：429、5xx、網路斷線都保留登入。以前任何非成功
  都會清 token——NAS 部署重啟那幾秒，正在換票的人全被踢出去。
- **已知的誤報**：5xx 保留登入，在極少見的競態下會留住一張其實已經換掉的票——後端的輪替已經
  commit，但回應在路上變成 502（例如 Caddy 剛好在 api 容器重啟時回 502）。前端沒拿到新票、
  手上還是舊的那張，下一次換票就撞上重用偵測、整條 family 被撤銷而登出，日誌寫一筆
  「refresh token 重用偵測」的 WARNING，看起來像攻擊。部署重啟前後看到單獨一筆這種 WARNING，
  多半是這個，不是票被偷。

### 8.2 其他延後項目

- **AI 估算的已知限制與後續**（AI 估算前端規格、計畫 `docs/superpowers/plans/2026-10-05-ai-estimate-frontend.md`）：
  - 一次一樣食物（P2 規格 §9）。
  - ~~「編輯這一餐」的加一項沒有 AI~~——**已完成**（AI 與編輯畫面的收尾規格 §2 第 1 項）：
    加一項的 `FoodPicker` 給了 `renderBelowSearch`，同記一餐放 `AiEstimatePanel`；存好（或
    「用這個」「用食物庫的」）的食物走加一項選食物的同一條路，份量先 `reset` 成一份 × 1。
    估算用的照片不帶（這一餐的照片由照片區處理）。~~交回食物之後焦點沒有移到「已選擇」~~——
    **已完成**：加一項選好食物（清單或 AI 面板交回）之後焦點移到「已選擇」（`tabIndex=-1`，
    旗標只在選的那一次移，同記一餐的 `focusSelectedRef`）。
  - 估算用的照片不存（記一餐的拍照估算會把那張照片當這一餐的照片，那是另一件事）。
  - `ai_raw_response` 存的是前端送來的估算回應（不是後端自己留的 LLM 原文）——它是
    你自己的資料，偽造它只會騙到你自己。
  - 供應商的 SDK 丟錯由兩個 estimator 分類（AI 與編輯畫面的收尾規格 §2 第 2 項）：**設定錯誤**
    （認證、權限、找不到模型、模型名稱不合法的 400；Gemini 的金鑰錯是 400 `API_KEY_INVALID`）→
    `503 AI_MISCONFIGURED`，**不記一列、不算額度**（供應商直接拒絕、沒有計費；後端 log 記下
    供應商的原話）；**上游錯誤**（連線、逾時、5xx、429、其他 API 錯誤）→ `502 AI_UPSTREAM_ERROR`，
    照舊記一列失敗。沒分類的例外照舊記一列、回 500。400 是不是「模型名稱」靠訊息裡有沒有
    `model`（Gemini 另看 `api key`）——供應商改了措辭就會落到上游錯誤（多算一次額度，不會漏記）。
    Gemini 的連線錯誤是 `httpx.TransportError`；哪天裝了 aiohttp，SDK 會改走它，那種連線錯誤
    會變成沒分類的 500。**前端已經依 code 顯示這兩句後端的訊息**（不再是通用的「AI 估算失敗」）；
    `AI_MISCONFIGURED` 不像 `AI_NOT_CONFIGURED` 那樣停用拍照估算（只顯示訊息）。
    Gemini 的 `AI_MODEL` 含 `?`、`&` 或 `..` 時，SDK 在送出之前就丟
    `ValueError('invalid model parameter.')`（`_transformers.t_model`）——也算設定錯誤（503、
    不記一列）；只認這一句，其他的 `ValueError` 照舊往外拋。
  - Anthropic 的「credit balance too low」是 400、訊息裡沒有 `model`——落到上游錯誤：
    `502`「請稍後再試」（其實要儲值，等多久都不會好），而且**每按一次記一列**、吃一次額度。
  - `remaining_today` 在同時多個請求時可能多報（各自以為只有自己用了一次）；額度檢查
    本身也有同樣的競爭（P2 就存在）。單人使用可接受。
  - ~~`analyzeImage` 與 `uploadMealPhoto` 重複「擋大小＋縮到 1280」~~——**已完成**：
    `lib/photo.ts` 的 `preparePhoto(file)`，兩邊共用；`MAX_PHOTO_BYTES` 與 `PhotoTooLargeError`
    一起搬過去，`api/photos.ts` 原樣轉出（既有的匯入不用改，也不會循環匯入）。
  - ~~面板在「結果卡片 ↔ 修改表單」切換時沒有移動焦點~~——**已完成**：切到表單（「需要修改」
    或撞名後的「改名」）焦點到「食物名稱」；「放棄修改」回卡片，焦點到卡片標題（`tabIndex=-1`）。
    用旗標只在切換那一次移，剛估算完不搶焦點。
  - ~~AI 確認存出的私人食物可能跟公開食物同名~~——**已完成**（規格 §2 第 3 項）：面板存之前
    （「確認」與改過的「存成食物」都是）用要存的名稱打 `GET /api/foods?q=&scope=all&limit=200`，
    看得到的食物裡有**名稱完全相同**的（去頭尾空白、不分大小寫）就先問「食物庫裡已經有「X」」：
    「用食物庫的」直接交回那一筆、不 POST；「還是用 AI 的數字建一個」照舊 POST。檢查在面板裡，
    記一餐、新增食物（同一條存檔路徑，存好導到詳情頁）、加一項都有。取捨與已知限制：
    - 只是「包含」的不算（搜尋是子字串比對，`findSameNameFood` 再比一次）；沒有生效營養素的
      食物不算（記不了，問了只會進死路）。
    - 查詢失敗**照樣存**——這是提醒，不是守衛。撞到自己的食物仍有後端 `409 FOOD_EXISTS`。
      自己的同名食物現在通常會先被這一步攔下（看得到的包含自己的），409 的「用現有的／改名」
      變成後備。
    - `limit=200`：子字串命中超過 200 筆、而且完全同名的那一筆被排到 200 筆之後時會漏（後端
      依名稱排序，前面可能有「多幾個字」的名稱）。後端的 `ILIKE` 沒有跳脫 `%`／`_`，名稱含
      這兩個字元時命中的會多，不影響「完全相同」的判斷。
    - 在修改表單裡被問的時候，改任何欄位就收起提問（不然「還是建一個」會送出改之前的內容）。
      提問出現時焦點移到「用食物庫的」（「確認」那顆按鈕被換掉、「存成食物」停用過，焦點會掉到 body）。
    - 同名只比名稱、**不看品牌**：公開的「拿鐵（星巴克）」跟 AI 估算的「拿鐵」（品牌不同或沒有）
      也會被問。
    - 同名查詢或 `POST /api/foods` 卡住不回時面板整個鎖住（按鈕都停用）——`apiFetch` 沒有
      逾時，只能重新整理。
    - **e2e 走不到這條路**：要一個「不是食物庫命中」的估算結果，那一定要真的呼叫 AI（CI 沒有
      金鑰、e2e 也不該花錢）。只有元件測試守著（面板、記一餐、新增食物、加一項各一組）。
    - 一個測試上的提醒：同名檢查加進來之後，既有的面板與新增食物測試的 mock 沒有
      `GET /api/foods?` 這條路由——不補的話它們會悄悄走「查詢失敗照樣存」的後備路徑，照樣綠。
      這次都補了回空陣列的路由；之後新增會存食物的測試也要記得給。
- **孤兒照片的背景清理排程**：指令已有（`python -m app.cli cleanup-photos`），
  cron 設定寫在部署手冊，但**必須在容器內執行**（照片在 Docker volume，
  在 host 跑會看錯目錄）。
- **修改與刪除已記錄的餐點：已完成**（見階段進度）。已知的缺口：
  - ~~不能改時間~~——**已完成**（規格 `docs/superpowers/specs/2026-10-07-edit-meal-time-design.md`）：
    「這一餐」表單多日期與時間兩格（裝置時區、到分鐘比較、未來的時間擋在前端）；改了
    `eaten_at` 時餐費的 `spent_at` 同一個交易跟著改（跨月補記會搬到正確的月份）。
    順手修了編輯畫面輸入框不到 44px（e2e 現在量它）。`PATCH /api/meals/{id}` 用 `FOR UPDATE` 鎖這一餐
    的列（同時改時間與補金額不會讓餐費留在舊時間；副作用：兩台同時補金額時後到的改成更新金額，不再 409）。
    前端測試固定在台北時區跑（`vite.config.ts` 的 `test.env.TZ`）。
    已知沒修：夏令時間跳過／重複的那一段由 `Date` 默默決定（台北沒有夏令時間）；裝置時區≠帳號時區時沒有任何提示；
    「不能選未來的時間」看的是裝置的時鐘；`PATCH /api/expenses/{id}` 仍能單獨改餐費的 `spent_at`（只有 API 走得到）。
  - ~~兩個請求同時替同一餐補金額可能建出兩筆支出~~——**已修**（安全補強）：部分唯一索引
    `uq_expenses_meal_id`（migration `0015`，升級前查重複、有就失敗不自動刪）。改時間那一輪
    `update_meal` 加了 `FOR UPDATE` 之後，兩台同時補金額會**排隊**：後到的看到已經有餐費，
    改成更新金額——**後到的蓋掉先到的**（使用者確認接受，2026-10-08；兩台都是自己的裝置，
    跟改備註、餐別的行為一致）。`409 MEAL_COST_CONFLICT` 與前端的處理留著當後備（唯一約束
    仍是最後一道），但經過 `update_meal` 的正常路徑已經碰不到它。
  - ~~份量重量 × 數量可能超過 `quantity_g` 的 `Numeric(8,2)` 變成 500~~——**已修**（安全補強）：
    `_quantity_g` 換算後不在 0.01～999,999.99 → `422 QUANTITY_OUT_OF_RANGE`；也包含
    「四捨五入成 0」撞上 `CHECK (quantity_g > 0)` 的那一端。新增一餐、加一項、改一項都經過它。
  - 編輯畫面（AI 與編輯畫面的收尾規格 §2 第 6～8 項）：
    - ~~`useMeal`／`useFood` 遇到 404 仍然重試 3 次~~——**已完成**：共用的
      `retryUnlessNotFound`（`api/errors.ts`）：`ApiError` 404 不重試，其他照預設最多 3 次。
      **測試上的提醒：** hook 層的 `retry` 會蓋過測試 client 的 `retry: false`——會讓
      `useMeal`／`useFood` 失敗（非 404）的測試要給 `retryDelay` 短的 client，不然要等 7 秒
      （`edit-meal.test.tsx` 的「重試」那一組、`retry-not-found.test.tsx`）。
    - ~~從清單點進來仍會先看到「載入中」~~——**已完成**：`useMeal` 的 `placeholderData` 從
      今天的清單快取（`queryKeys.meals`）找同一個 id。placeholder 可能比伺服器舊，**儲存不停用**：
      表單只送動過、而且跟顯示的值不同的欄位，真的資料回來時沒動過的欄位跟著換、草稿留著
      （兩則測試守著：placeholder 上改備註再等真的資料回來、真的資料回來之前就存）。別天的餐
      不在今天的清單裡，照樣「載入中」。已知缺口：讀取失敗（非 404）重試完之後 placeholder 會
      變成「無法載入」——重試那幾秒在 placeholder 上打的草稿跟著表單一起不見。
    - ~~確認框沒有移動焦點~~——**已完成**：刪這一餐、刪照片、刪一項共用 `useConfirmFocus`
      （`lib/use-confirm-focus.ts`）：打開時焦點到「取消」，按取消收起之後回到打開它的按鈕；
      因為別的理由收起（刪成功、開了加一項、照片在別台刪了）不搶焦點。~~報表頁的確認框沒改~~——
      **已完成**（最後幾件規格 `docs/superpowers/specs/2026-10-08-last-items-design.md`）：
      報表頁每一筆的刪除確認框也用它，取消後焦點回到**那一筆**的「刪除」。
    - 改項目後要等五個 query 重抓完編輯器才收起（仍是已知缺口，不做）。
- **照片縮圖：已完成**（規格 `docs/superpowers/specs/2026-10-07-thumbnails-design.md`）。
  上傳時同時存長邊 640 的 `<uuid>_thumb.jpg`（`thumbnail_path` 是唯一規則）；舊照片第一次被要
  縮圖時補做（暫存檔＋`os.replace`，不用跑指令）；照片端點 `?size=thumb`、授權不變；刪照片
  一起刪縮圖；**清孤兒指令把被引用原圖的縮圖算進被引用**（不改的話縮圖會全被當孤兒刪掉）。
  補做不成（原圖壞了或被截斷、尺寸超過上限、縮圖寫不進磁碟）就回原圖的 bytes，不 500、不存縮圖；
  原圖不在照樣 404。
  前端：飲食頁與好友的卡片用縮圖，`ZoomablePhoto` 點了才抓原圖。
  - 坑：看大圖的遮罩一開始被底部的「＋」蓋住——卡片的祖先建立了疊放範圍，z-index 再大也
    出不去。改用 portal 掛到 `document.body`（單元測試只看得到 DOM，是截圖才發現的）。
- **速率限制的計數器不持久**（`login_rate_limiter` 與 `session_rate_limiter`）：單容器記憶體，
  重啟歸零。這個規模可接受。`session_rate_limiter` 的鍵是 `jti`，每換一次票就多一個鍵——
  `KeyedRateLimiter.hit` 在記著的鍵超過 1000 個時順手清掉過期的視窗，記憶體不會一直長。
- **`GET /api/foods/frequent` 的可見性過濾今天是空轉的** ——
  `POST /api/meals` 已經擋住記錄看不到的食物。保留它是為了日後的
  「刪除食物 / 取消分享」，**但今天抓不到任何突變**（已在計畫裡誠實記錄）。
- ~~**建立全域食物只有 API，沒有 UI**~~——**已完成**（最後幾件規格）：`/foods/new`
  對管理員（`useMe().data?.role === "admin"`）多一個「公開到共用食物庫（所有人都看得到）」
  勾選，預設不勾；勾了送 `is_global: true`，不勾**不送**這個欄位。一般使用者看不到、也不送
  （藏起來只是可用性，授權仍在後端）。AI 面板存出的食物照舊私人。新增食物頁因此會打
  `GET /api/me`——單元測試裡「擋下來、不送請求」改成看有沒有建立的 `POST`。
- **份量管理：新增、選用、修改、刪除都已完成**（規格
  `docs/superpowers/specs/2026-10-03-food-portions-design.md`，計畫
  `docs/superpowers/plans/2026-10-03-food-portions.md`）。新增食物可以設一份，
  也可以照包裝「每一份」輸入營養素（前端換算成每 100）；食物詳情頁可以替任何
  食物加自己的份量；記一餐自動選上預設份量（自己的優先於公開的）。同一個人、
  同一個食物只會有一個預設份量（新增預設時後端會取消舊的）；記一餐的餐點清單
  ~~對液體仍顯示 g~~——**已完成**（最後幾件規格）：`MealItemResponse` 與好友的
  `FriendMealItem` 多 `base_unit`，取**項目釘住的那一版**的（§4.3 的凍結規則：食物後來審核
  通過一版 g，舊紀錄仍是 ml；`quantity_g` 的欄位名不改）。飲食頁卡片、編輯畫面的項目、好友卡片
  顯示 `{數字} {base_unit}`；編輯畫面「改一項」直接輸入的單位也用項目釘住的那一版（PATCH 不換
  釘住的版本，輸入的數字照那一版的單位換算）。修改與刪除在小項目包做完（規格
  `docs/superpowers/specs/2026-10-06-small-items-design.md`）：已記的餐不受影響
  （改重量不重算 `quantity_g`；刪除時 `portion_id` 變 null、公克數照舊）；
  介面上只有私人份量能改、刪，公開份量的修改與刪除只開放 API 給管理員。
- **趨勢圖**：實際對目標；第二階段加了營養素切換（熱量／蛋白質／脂肪／
  碳水）、小項目包加了日期軸。**期間切換與摘要已做**（規格
  `docs/superpowers/specs/2026-10-08-trend-period-design.md`）：「7 天｜30 天」，
  預設 7 天、不記住；30 天的日期軸只標今天與每往回 7 天（最後一根的「今天」
  靠右對齊，置中會被圖的右緣切掉——看截圖才發現的）；圖下面一行
  「有記錄的 N 天，平均 X，目標平均 Y」——「有記錄」是那一項 > 0，目標平均
  只算有記錄而且有那一項目標的天，平均四捨五入到兩位小數（`lib/decimal.ts`
  的 `averageOf`）。**刻意不判斷「達標」**（§4.8：熱量是越低越好還是剛好就好、
  蛋白質是至少還是剛好，因人而異）。**自由日期選取還沒做。**
- **註冊不再開放**（邀請規格）：P1 規格 §12「維持開放註冊、邊界交給 Tailscale」的
  決定被取代——`POST /api/auth/register` 一定要帶有效的 `invite_token`。帳號仍然可以
  用 `create-admin`／`create-user` 從命令列開。`/register` 與 `/invite-status` 沒有
  速率限制，刻意的：無效的邀請在 Argon2 之前就被擋掉、256 位元的碼猜不到（規格
  §3.4）。已知的小缺口：同一個 email 的並行註冊靠 `IntegrityError` 收斂成 409；
  邀請沒有綁 email，連結被別人搶先用掉只能從「已經用掉的」清單發現。
- **e2e 會在 dev 資料庫留東西**：每跑一次邀請的 e2e 就多一個 `e2e.friend.*` 帳號
  與一張用掉的邀請（加上觸控測試產生的邀請）；好友的 e2e 多一個 `e2e.pal.*` 帳號、
  兩個 `E2E 好友…` 食物與幾餐（管理員 kenny.demo 的）。
- **好友關係的已知取捨**（好友規格）：
  - 好友碼由 ORM 的 `default=` 產生、**不重試**：31⁸ 種組合，碰撞機率可忽略；碰到就是一次 500。
  - migration `0012` 替既有使用者補碼的那段**沒有自動化測試**（測試資料庫從空的升級）；
    實作時對 dev 資料庫手動驗過：12 個使用者、12 個碼、沒有重複。
  - 解除好友之後，對方手機快取裡**已經看過的照片收不回來**——前端會移除自己這邊的快取，
    確認框也明講。
  - 好友動態的查詢（`EXPLAIN ANALYZE`，dev 資料庫 493 餐）：`meals` 全表掃描＋top-N heapsort，
    0.4ms。沒有加索引；資料量大很多之後再量。
  - 三個安全條件的突變（拿掉 `is_private` 過濾、拿掉「已接受」條件、照片不限好友）實作時
    被自動模式的安全檢查擋下，**沒有實際跑過**；對應的測試從寫法上看得出會紅
    （`test_a_private_meal_is_invisible_everywhere`、`test_a_pending_request_shows_nothing`、
    `test_the_photo_needs_the_friend_and_the_meal_to_match`；最後審查逐條讀過、確認各自會紅）。
    要補跑就手動改、跑、改回。
  - 極端的日期（`?date=9999-12-31`、`0001-01-01`）在 `day_bounds` 裡 `OverflowError` → 500——
    `/api/meals?date=` 本來就有（master 就存在），好友的某一天繼承了它。
- **編輯自己已送出的提案**：後端沒有這個端點，目前只能等審核結果。

---

## 9. 怎麼跑起來

### 本機開發

```bash
docker compose up -d              # 自動載入 docker-compose.override.yml（原始碼掛載 + --reload）
# API: http://localhost:8000/docs   DB: localhost:5433
```

測試需要 host 上的 venv（不在容器內跑）：

```bash
.venv/Scripts/python.exe -m pytest -W error
.venv/Scripts/ruff.exe check .
.venv/Scripts/python.exe -m mypy app
```

`alembic check` 要指向測試資料庫：

```bash
DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test" \
  .venv/Scripts/python.exe -m alembic check
```

### 部署

完整步驟見 [`docs/deployment.md`](deployment.md)。重點：

**NAS 不 build 映像。** master 的測試全過之後，CI 的 `publish` job 把 `nutrition-tracker-api`
與 `nutrition-tracker-web`（Caddy＋前端）推到 GHCR（amd64＋arm64，標籤＝commit 完整 SHA 與 `latest`）。
NAS 上：

```bash
sudo ./scripts/deploy.sh          # git pull --ff-only，部署 HEAD 的映像
sudo ./scripts/deploy.sh <sha>    # 部署指定版本（退版用；不動 git）
```

腳本：部署鎖＋檢查 compose 版本（≥ v2.20）＋擋開發環境 → 拉映像 → 目前的映像標成 `:rollback` →
備份（資料庫停著就先起來再備份；只有沒有資料庫容器也沒有資料 volume 才跳過）→ 用新映像跑 migration
（失敗就停在舊版）→ `up -d --no-build`、等 api 與 caddy `healthy`（等不到就自動退回 `:rollback`、非零結束）→
寫 `deployed-version`。用到的疊加檔是 `docker-compose.yml`＋`docker-compose.prod.yml`＋`docker-compose.release.yml`
（最後這個把 `image` 換成 GHCR 的 `${APP_VERSION}`；`build` **沒有**拿掉——`!reset` 在 v2.18 之前的 Compose
會被安靜忽略（實測 v2.15、v2.17）——不 build 靠的是 `deploy.sh` 每個指令都帶 `--no-build`）。
規格 `docs/superpowers/specs/2026-10-08-image-deploy-design.md`。

- **退版不倒回 migration**。退到舊版時資料庫比映像新，腳本會認出來、跳過 migration。退得回去的條件是
  「新版的 migration 不會讓舊程式壞掉」：加可為 null／有預設值的欄位、加表、加索引是安全的；
  **`0012` 不是**（`users.friend_code` NOT NULL 沒有 server default，0012 之前的程式建立使用者會失敗）。
  這種 revision 列在 `deploy.sh` 的 `ROLLBACK_UNSAFE_REVISIONS`，部署跨過時印警告、照樣繼續。
  **新增 NOT NULL 欄位的 migration 要給 server default**，不然就要把它加進那個清單。
- CI：push 到 master **一律全跑**測試（不看路徑過濾——paths-filter 比的是上一次 push，不是上一個綠的 commit），
  publish 才能放心用 `!failure()`；publish 有 `concurrency`，一次只推一組映像。
- **本機試 `deploy.sh` 一定要設 `COMPOSE_PROJECT_NAME`**（例如 `nt-deploy-test`），否則專案名稱是
  `wallet`、會接管 dev（§7）。腳本看到 dev 的容器（override 起的）會拒絕，但不要靠這個。
  本機實測的做法：`SKIP_PULL=1`、本機 build 並打上 GHCR 名稱的映像、`ENV_FILE`／`BACKUP_DIR`／
  `DEPLOYED_VERSION_FILE` 指到暫存目錄。
- 舊的「在 NAS 上 `up -d --build`」留在部署手冊當備案。

**看 `(healthy)` 不要看 `Up`。**

### 本機的示範資料

dev 資料庫已有：3 個帳號（`admin@example.com` 管理員 /
`demo@example.com` / `kenny.demo@example.com`，後者密碼 `demo-pass-12345`）、
7 個食物、3 個補劑、3 筆補劑計畫、2 段目標期間（中途變更）、
20+ 筆餐點橫跨 10 天、24 筆補劑打卡（**刻意有漏**，依從率 0.77）、
1 張含 GPS 但已去除 EXIF 的照片。

---

## 10. 下一步：P3（前端）

**已確定走完整的 PWA（TypeScript + React）**，不是先做最小介面。

### 前端需要知道的 API 事實

**認證**：`HTTPBearer`。`POST /api/auth/login` 回 access（15 分鐘）+
refresh（14 天）。`POST /api/auth/refresh` 換新的。
**舊的 refresh token 在換發時會立刻失效**，而且重複使用會撤銷整條鏈 ——
前端必須保證同一時間只有一個 refresh 在飛（P3-A 規格 §6.4 的 single-flight
鎖），否則兩個分頁同時換票會讓使用者莫名被登出。

登出走 `POST /api/auth/logout`（帶 refresh token，不需要 access token）或
`/logout-all`。注意**撤銷不是即時的**：access token 最多還有效 15 分鐘。

**所有數值都是字串，不是數字。** `"180.50"` 而非 `180.5` ——
`Decimal` 序列化成字串以避免浮點誤差。前端要用
`decimal.js` 之類的處理，不要 `parseFloat`。

**日期與時間**：
- `eaten_at` / `taken_at` 是 `timestamptz`，收發都用 ISO 8601 含時區
- `?date=` 參數是純日期，**伺服器用使用者的時區解讀**
- 前端不要自己算日界線，一律問伺服器

**錯誤信封**（所有錯誤都是這個形狀，包含路由 404 與未處理例外）：

```json
{"error": {"code": "MEAL_NOT_FOUND", "message": "找不到該餐點", "details": {}}}
```

- `HTTP_ERROR` = 路由層 404，**網址打錯**
- 帶語意的 code = handler 回的，資源不存在**或不是你的**（兩者刻意相同）
- `VALIDATION_ERROR` = Pydantic 驗證失敗，`details.errors` 有欄位層級的訊息

**速率限制**：登入失敗 5 次/60 秒回 429，帶 `Retry-After`。
前端要處理這個，而且**不要在 UI 上區分「帳號不存在」與「密碼錯誤」**。

**照片**：`POST /api/meals/{id}/photo`（multipart，上限 10MB，
伺服器會縮到長邊 1280 並去除 EXIF）、`GET /api/meals/{id}/photo`
（需認證，**不能當成靜態 URL 直接塞進 `<img src>`**，要帶 token 取回 blob）。

### 建議的第一批畫面

依「每天真的會用到的次數」排序，不是依實作難度：

1. **記一餐** —— 從「常吃 / 最近吃」快選（`/api/foods/frequent`、`/recent`），
   這是每天走最多次的路徑，規格第 11 節特別點名
2. **今日總覽** —— `/api/stats/daily` 的攝取 vs 目標 + `/api/supplements/today` 打卡
3. **拍照上傳**
4. 之後才是趨勢圖、食物庫管理、管理員審核佇列

### 完整的 API 清單

`http://localhost:8000/openapi.json`，或 `/docs` 的互動介面。

### 介面改版：下一步與已知待辦

介面改版第一、第二階段都已完成（見上方階段進度）。

**下一步：**

- **第二階段：已完成**（見階段進度）。當時順手發現的三件事（報表清單按鈕、
  編輯歷史日期、趨勢日期軸）已在小項目包做完。
- **第三階段**：社群（P7）。「開帳號的路」與「好友關係」都已完成（見階段進度）。
  按讚、留言、通知、封鎖、好友的趨勢都刻意沒做——等真的用過一陣子再決定要什麼。

**已知待辦（都已完成，見規格 `docs/superpowers/specs/2026-10-08-keypad-offline-design.md`）：**

- (a) **已完成，bug 實測證實**：有資料但重抓失敗的查詢（`status: "error"`）被下一次寫入從離線快取拿掉，第二次離線重新載入什麼都沒有；`persist.ts` 的 `shouldDehydrateQuery` 改成 success 或「error 而且有 data」（`offline.test.tsx` 三階段測試，修之前紅）。寫進去之前 persister 的 `serialize` 把它改寫成 success、清掉 error、保留 `isInvalidated: true`——restore 回來的失敗查詢不是 error，在線上重新載入時重抓還在路上也不會顯示離線標示或「無法載入」，重抓再失敗才變回 error。
- (b) **已完成**：只在 `/expenses/new` 隱藏分頁列（`App.tsx` 的 `LoggedInShell`，`.app-main-no-tab-bar` 拿掉底部留白）；記一餐沒有關閉鈕，不隱藏。
- (c) **已完成**：記帳數字鍵盤接受實體鍵盤（數字、`.`／`,`、Backspace、Enter 送出），焦點在備註欄、有 Ctrl／Meta／Alt、或輸入法組字中時不攔（`MoneyKeypad.tsx`）。Enter 的規則：焦點在任何按鈕或連結上（包括 Tab 走到的數字鍵）時屬於那個控制項；鍵盤上的按鍵滑鼠／觸控點了不拿焦點（mousedown 擋預設動作，焦點在備註時把備註 blur 掉），所以點過數字之後按 Enter 是送出；按住 Enter 的自動重複不算。已知限制：螢幕閱讀器的瀏覽模式會吃掉數字鍵，要切到焦點模式才打得進金額。
  - 審查提過、刻意不改：監聽器每次金額改變就重新掛一次（行得通、有測試）；Enter 分支裡 `!submitDisabled` 跟 ✓ 的 `disabled` 重複；(b) 的版面沒有 e2e。

### 電腦版版面

寬度 ≥ 1024px：左側導覽＋總覽／報表／飲食排兩欄；比較窄：原本的手機版，內容最寬 600px 置中
（規格 `docs/superpowers/specs/2026-10-08-desktop-layout-design.md`、計畫 `docs/superpowers/plans/2026-10-08-desktop-layout.md`）。

- **斷點只寫在一個地方**：`src/lib/layout.ts` 的 `DESKTOP_MEDIA_QUERY`。`useIsDesktop()`（`matchMedia`＋
  `useSyncExternalStore`）讀它，`App.tsx` 的 `LoggedInShell` 依結果畫 `SideNav` 或 `TabBar`，電腦版在最外層加
  `app-desktop` class。
- **頁面的電腦版 CSS 一律寫 `:global(.app-desktop) .x { … }`，不要寫 media query**——寫了 1024 就有兩份，遲早漂移；
  而且 jsdom 不跑 media query，class 至少測得到結構。共用的兩欄是 `components/layout.module.css` 的 `.columns`
  （總覽、報表）；飲食頁要保住 DOM 順序（營養素 → 餐點 → 補劑），用 `Today.module.css` 自己的 `grid-template-areas`。
- **內容寬度依路由**（`contentWidthFor`，外框決定）：`/`、`/reports`、`/diet` 1100px；`/expenses/new`、`/meals/new`
  480px；其他 640px。新增路由不用改這張表，預設就是 640。
- `SideNav` 與 `TabBar` 共用 `components/nav-tabs.ts`（四個目的地）與 `components/use-add-sheet.ts`（「新增」選單的開關，
  換頁自動關、返回不會再跳出來）。兩個導覽的可及名稱一模一樣（「主要導覽」「新增紀錄」、四個連結），既有測試兩種版面都找得到。
  「新增」在 `SideNav` 的最上面——DOM 順序就是 Tab 順序，所以不能共用一份 JSX 再用 CSS 換位置。
- **視窗拉寬拉窄跨過斷點會重新掛載整頁**（兩種外框的 `children` 在不同父元素底下），表單打到一半會不見、「新增」選單會關。
  刻意接受。
- **測試環境預設是手機版**：`src/test/setup.ts` 裝了 `src/test/media.ts` 的假 `matchMedia`；要測電腦版就
  `act(() => setDesktop(true))`。`useIsDesktop` 整個 app 共用一個 `MediaQueryList`（第一次用到才建，掛與拿監聽者一定是同一個物件），
  setup 每個測試前用 `resetDesktopQueryForTests()` 丟掉快取；假實作每個物件各自記監聽者，`listenerCount()` 量得到漏掉的監聽器。
  幾何（誰在誰右邊、寬度）jsdom 量不到，在 `e2e/desktop-layout.spec.ts`（1280×800、390×844、768×1024：電腦版內容區最寬 640
  並在導覽右邊的空間置中、手機版 `main` 最寬 600 並置中）。**那個檔案登入後只用點擊導覽換頁**——連續 `page.goto` 會在並行全跑時
  觸發 refresh token 重用、被登出（同 `money-loop.spec.ts`）。**Playwright 預設的 1280×720 是電腦版**：沒有 `test.use({ viewport })` 的既有 e2e 現在都跑在電腦版上，
  等於電腦版的回歸測試；`touch-targets`、`mobile-form-zoom`、`friends`、`invites` 固定手機尺寸，守手機版。
  新寫的 e2e 如果依賴「導覽在底部」之類的手機版假設，要自己釘手機尺寸。
- e2e 順便補上了 (b) 的一部分：手機尺寸的記帳頁沒有分頁列。

實作時量出來的兩件事：

- 計畫原本的「新增選單是置中對話框」只量了寬度與上下留白。拿掉 `.layer` 的 `align-items: center`（左右置中）照樣綠——
  `.layer` 是 `flex-direction: column`，上下置中靠的是 `justify-content`，左右才是 `align-items`。補了一條「水平中心 = 視窗中心」。
- 拿掉飲食頁補劑的 `grid-area: supplements` **不是**有效的突變：grid 的自動擺放剛好把它放進左欄第二列，跟寫了一樣。
  有效的是把第二列的 `1fr` 改成 `auto`（補劑跟營養素中間空一大截）——e2e 量「補劑緊貼在營養素卡片下面」。
  那個缺陷只在右欄比左欄長時看得到，右欄多長又看今天記了幾餐，所以 e2e 量之前自己把右欄的 `min-height` 撐到比整個 grid
  再高 3000px，不靠資料庫：把餐點全部藏起來（模擬乾淨的資料庫）時，`auto auto` 照樣紅（補劑往下掉約 1500px）。

同一個分支順手補了三個從來沒改版過的畫面（規格 §8，純樣式與標記，可及名稱、testid、主要區塊的 DOM 順序都沒動）：

- **登入**：跟建立帳號一樣包 `ui.module.css` 的 `.screen`（h1 在卡片外、表單是卡片、標籤在上的整列輸入框、主要按鈕、
  錯誤用危險色）。`.app-auth` 的上方內距是 `clamp(var(--space-6), 10vh, 120px)`——用 vh 不用 media query，斷點只寫在 `layout.ts`；
  標題上緣離視窗頂端還要再加 h1 自己的 `margin-top: var(--space-3)`（`ui.module.css` 的 `:where(.screen h1)`，`.screen` 是 flex
  不會跟內距合併），所以實際是 clamp＋12px。建立帳號頁（`/join`）也套用同一個留白。
- **飲食頁營養素**：`MacroBar` 一列＝名稱在左、`實際 / 目標`＋百分比在右（等寬數字），下面一條進度條。進度條是
  `components/RatioProgress`，跟總覽「今天熱量」同一個元件：吃 `ratioOf()` 的比例、`Math.min(ratio, 1)` 夾滿格、比例是 null
  （「未設定」或目標是 0）不畫，間距由呼叫端的 className 給。沒有目標時的 `<dl>` 也排成一列一項，列的排版直接用
  `MacroBar.module.css` 的 `.row`／`.line`／`.label`（MacroBar 自己的「第一列不留上內距」在 `.bar` 上，`<dl>` 上面有說明，第一列要留）。
- **今日餐點卡片**：上傳照片改成「加照片」那種虛線框標籤＋相機圖示，`<input type=file>` 視覺上藏起來但仍可用鍵盤對焦
  （名稱仍是「上傳照片」），上傳中停用並顯示「上傳中…」；項目沒有項目符號、份量灰色小字；合計靠右粗體；縮圖最寬 240px。
  「今日餐點」「今日補劑」改成總覽「今天」那種小字灰色的區塊標題，補劑的打卡／取消是 44px 的外框按鈕。

事後的審查把這次複製貼上的幾段收成共用的（畫面逐像素沒變）：

- **選照片的按鈕**：記一餐、編輯這一餐、今日餐點卡片、AI 估算面板都用 `components/PhotoPickerButton`（標籤＋相機圖示＋
  緊接在後的隱藏 input、對焦外框、停用時淡掉）。AI 面板是 `variant="accent"`；各處的 `id`／`accept`／`capture`／名稱照舊。
- **小字灰色的區塊標題**：`ui.module.css` 的 `:where(.screen h2), :where(.sectionTitle)` 一條規則；不在 `.screen` 裡的
  總覽「今天」、「今日餐點」「今日補劑」在 h2 上加 `ui.sectionTitle`，各自的模組只管 margin。字重統一 600（總覽原本吃 h2 預設的 bold）。
- **次要按鈕**：`ui.module.css` 的 `.secondary`，跟 `:where(.screen button)` 寫在同一條規則；補劑的打卡／取消用它。

### 帳號與目標設定

每日目標、改名稱、改密碼、管理員的重設密碼連結（規格 `docs/superpowers/specs/2026-10-08-account-settings-design.md`、
計畫 `docs/superpowers/plans/2026-10-08-account-settings.md`，計畫的「執行中發現的差異」記了實作跟計畫不一樣的地方）。

**機制摘要：**

- **`PUT /api/targets/today`**：「今天」由後端用 `today_in_timezone(user.timezone)` 算（前端不算今天）。今天生效的那一筆
  如果**今天才開始** → 原地改（同一個 id）；**更早開始** → 先把它的 `effective_to` 設成今天、flush，再插 `[今天, 原本的結束日)`
  （過去的日子維持舊的分母）；**沒有** → 插一筆，結束日是下一筆未來期間的開始日（沒有就開放式）。四個鍵都必填、`null`＝不設定、
  值 > 0。撞上 `ex_user_targets_no_overlap` → 整筆 rollback、`409 TARGET_CONFLICT`。前端讀目前的目標用 `stats/daily` 的
  `target`，存完失效 `dailyStats` 與 `rangeStatsAll`。
- **`POST /api/me/password`**：先比字串（新＝目前 → `422 PASSWORD_UNCHANGED`，不跑 Argon2），再查**登入的限速器**（鍵是這個帳號的
  email，跟登入共用每 email 5 次／60 秒），Argon2 在執行緒池。錯誤**一律 422 不用 401**——`client.ts` 對 401 會換票重送，錯的
  密碼會被驗兩次。成功：同一個交易改雜湊、撤銷還沒用的重設連結、`revoke_all_for_user`（它的 commit 就是這個交易的 commit），
  **撤銷之後**才 `start_session` 開新的一條（順序反過來，這一條也會被撤銷）；前端 `changePassword()` 用 `setTokens` 換上，
  **從送出到 `setTokens` 都握著換票的那把 Web Lock**（`auth/refresh.ts` 的 `withTokenLock`）——不然這段期間拿舊票去換的
  另一個請求或分頁，會把換到的（已被撤銷的）票蓋在新票上，或直接 401，把剛改完密碼的這台登出。
- **重設連結**的形狀跟邀請（`app/invites.py`）一樣：`app/password_resets.py`、`secrets.token_urlsafe(32)`、資料庫只存 SHA-256、
  24 小時、條件式 `UPDATE … RETURNING` 兌換、部分唯一索引保證一個人最多一條活連結（產生新的會撤銷舊的）。**只給一般使用者**：
  管理員帳號（含自己）→ `422 RESET_NOT_FOR_ADMINS`。公開的 `POST /api/auth/password-reset` 在 Argon2 之前先查碼，四種失效
  （不存在、用過、過期、撤銷，**加上「對象現在是管理員」**——產生之後才被提升的）同一個 `403 RESET_LINK_INVALID`；
  **改雜湊 → 兌換 → `revoke_all_for_user`**，**它的 commit 就是重設交易的 commit**，中間不要加 commit（有測試：兌換之後、
  撤銷之前失敗 → 密碼沒變、連結沒用掉）。贏家仍然由條件式兌換決定，落空就整筆 rollback。成功回 204、不自動登入，清掉那個
  email 的登入失敗計數。
- **鎖的順序（所有會換密碼的路徑都一樣）：`users` 列 → `password_reset_tokens` 列 → 每使用者的 advisory lock →
  `refresh_sessions` 列。** 改密碼、重設連結、管理員產生連結（`FOR UPDATE` 使用者列）、CLI 重設都照這個順序；重設原本是
  先兌換再改 `users`，跟同一個人的改密碼同時發生會死結（PostgreSQL 砍掉一個 → 500）。新增會碰這幾種列的路徑時照這個順序取
  （註解在 `auth.reset_password`；測試 `tests/test_password_reset_concurrency.py`）。
- **`login` 驗完密碼之後取鎖、重讀雜湊**：`login` 讀雜湊 → Argon2（幾十毫秒）→ 開 session，而撤銷只碰得到當下存在的列。
  現在驗證通過之後先取每使用者的 advisory lock（`lock_user_sessions`），再用一條新的欄位查詢重讀 `users.password_hash`
  （不是 identity map 裡的物件）；跟剛才驗的不一樣 → 跟密碼錯誤同一個 `401 INVALID_CREDENTIALS`、**算一次失敗**（不算的話
  「401 卻沒扣額度」本身就是訊號）。兩邊共用那把鎖，所以不是「換雜湊的那邊先 commit、登入重讀到新的」，就是「登入先拿到鎖、
  它的 session commit 之後才被排在後面的撤銷看見」。順序（取鎖 → 重讀 → 開 session，中間不能有 commit／rollback）寫在
  `login` 的註解裡，三種寫壞的方式各有一條測試（`tests/test_login_password_race.py`，每個請求一條真的連線）。
- **CLI 的 `create-user`／`create-admin` 對既有帳號就是重設密碼**：同一個交易裡撤銷那個人還沒用的重設連結、撤銷所有
  refresh session（`revoke_all_for_user` 的 commit 就是它的 commit）。**在 dev 重跑種子指令會把示範帳號在瀏覽器裡登出**
  （15 分鐘內），這是預期的。
- **被登出就回到登入畫面**（前端）：`auth/store.ts` 的 `clearTokens()` 真的清掉儲存時通知 `onLoggedOut` 的訂閱者，`App`
  據此切回登入畫面——**只有登出的方向**，登入仍由畫面的 `onSuccess` 通知（`Join` 是 `login()` → 把網址換成 `/` →
  `onSuccess()`，在 `setTokens` 就切過去會把路由掛在 `/join#碼` 上）。不是在這個分頁按的登出——換票 401、或另一個分頁
  登出了（`storage` 事件裡 refresh token 的鍵被拿掉，`auth/session.ts` 的 `followLogoutFromOtherTabs`）——登入畫面多一行
  「已被登出，請重新登入」；自己按的沒有；本來就沒登入的分頁不顯示。`Me` 不再收 `onLoggedOut`，登出只有這一條通知的路。
- **票已經失效的裝置打開邀請或重設連結，連結直接能用**（前端）：`App` 開頁時只看 localStorage 裡有沒有 refresh token，
  而忘記密碼的人手上的裝置常常還留著一張過期或被撤銷的——會先被帶到「你已經登入了」的說明頁。所以那兩個說明頁
  （`JoinWhileLoggedIn`、`ResetPasswordWhileLoggedIn`）**等確認登入還有效才把碼從網址列拿掉**：`auth/use-session-confirmed.ts`
  的 `useSessionConfirmed()`，掛載時真的打一次 `GET /api/me`，成功才算。票無效 → 那個請求 401、換票 401 → 被登出；
  `App` 在收到通知的當下看網址，**還是一條帶著碼的 `/join`／`/reset-password` 就歸到 `out`（不是 `forced-out`）**，
  照路徑顯示真的 `Join`／`ResetPassword`，沒有「已被登出」。碼已經拿掉的（登入確認過之後才被登出）照舊是登入畫面＋說明。
  連不上（或 429、5xx）確認不了：碼留著、說明頁照舊。**「確認」不讀 `useMe()` 的快取**——離線快取還原回來的那一份也是
  `isSuccess`，60 秒內還不重抓（跟 `/me/targets` 的 `isFetchedAfterMount` 是同一種錯：快取裡有，不等於剛問過後端）。
- **稽核紀錄**：產生連結、用連結重設、改密碼各寫一行 INFO（只有 id，不寫碼、密碼、email）。`app/main.py` 讓 `app.*` 的 INFO
  真的輸出（uvicorn 的預設設定只替 `uvicorn.*` 掛 handler）：`docker compose logs api | grep -E "修改了密碼|產生了使用者|用重設連結"`。

**新的東西在哪裡：**

- 後端：`app/password_resets.py`、`app/models/password_reset.py`、`migrations/versions/0016_create_password_reset_tokens.py`、
  `app/api/routes/admin_users.py`（`GET /api/admin/users`、`POST /api/admin/users/{id}/password-reset`）、`auth.py`
  （`password-reset-status`、`password-reset`）、`me.py`（`POST /api/me/password`）、`targets.py`（`PUT /api/targets/today`）；
  `MIN_PASSWORD_LENGTH`／`MAX_PASSWORD_LENGTH` 搬到 `app/security/password.py`（`app/cli.py` 從那裡 import）。
- 前端：「我的」的 `components/AccountCard`（名字、email、行內改名稱、「修改密碼」連結）、`TargetsCard`、`AccountsAdmin`（管理員）；
  畫面 `screens/Targets.tsx`（`/me/targets`）、`ChangePassword.tsx`（`/me/password`）、`ResetPassword.tsx`（沒登入的
  `/reset-password#<碼>`，已登入打開是說明頁）；API 層 `api/targets.ts`、`admin-users.ts`、`password-reset.ts`；
  `lib/link-token.ts`（`#` 後面的碼，`/join` 共用）、`lib/targets.ts`（四個欄位的標籤、單位、上限）、`lib/decimal.ts` 的 `checkTargetInput`。
  `/me/targets` 的表單用 `api/stats.ts` 的 `useFreshDailyStats()`（掛載時一定重抓）、等 `isFetchedAfterMount && isSuccess`
  才預填——存的是整組四個值，拿快取的舊值預填會把沒動的幾格悄悄改回去；重抓失敗或離線就是「無法載入目前的目標」。
  **`isFetchedAfterMount` 單獨不夠**：它比的是 `dataUpdateCount` 有沒有比 observer 建立時大，而整頁重新載入時
  `PersistQueryClientProvider` 還在還原，那時建立的 observer 記下的是 0，還原把 localStorage 裡那份狀態（≥ 1）蓋上去
  就算「抓過了」——請求還沒回來，舊值已經填進表單。所以 `Targets` 先看 `useIsRestoring()`，還原完才掛真的去抓的那一層
  （`TargetsLoader`）。**之後有別的畫面要「只用掛載後抓回來的那一份」，一樣要擋還原**；測試要用兩個 `QueryClient`
  透過 localStorage 交接才驗得到（`tests/targets.test.tsx`「整頁重新載入」），`setQueryData` 預先放資料走不到這條路。「所有帳號」產生連結後
  焦點移到連結那一區（連結在卡片最上面，按鈕可能在一長串帳號的最下面）。
- e2e：`e2e/account-settings.spec.ts`（目標、改密碼、重設連結三條）、`e2e/new-account.ts`（`newAccount()`：用 API 邀請＋註冊開一個
  新帳號；`loginAs()`）。**會改密碼或目標的 e2e 一律自己開帳號**，不要動 `kenny.demo@example.com`、`e2e.member@example.com`。

**已知限制：**

1. **改密碼與重設之後，其他裝置的 access token 最多還能用 15 分鐘**（§8.1 的既有缺口：access token 不查資料庫）。要的是
   「再也換不到新票」，不是「立刻斷線」。
2. **「其他裝置」指其他瀏覽器。** 同一個瀏覽器的其他分頁共用 localStorage，之後換票會直接用新的票；改密碼握著換票的
   Web Lock，其他分頁的換票會等它做完。**沒有 `navigator.locks` 的環境**（非 secure context）沒有鎖可握，原本的競態還在：
   另一個分頁剛好在改密碼的那一刻用舊票換票 → 401 → 這個瀏覽器的每個分頁都回到登入畫面，再登入一次就好。
3. 公開的兩個重設端點**不限速**（同 `invite-status`）：碼是 256 位元，無效的碼在 Argon2 之前就回 403。
4. **管理員帳號不能用重設連結**；管理員忘記密碼仍要 SSH 跑 `create-admin`（知道密碼的話用「修改密碼」）。連結產生之後
   對象才變成管理員的，那條連結跟著失效。**已登入的人打開重設連結**只看到說明：記得密碼去「修改密碼」，忘記了就先登出、
   再從收到連結的地方重新點一次（碼已經從網址列拿掉，重新整理沒有用）。這裡的「已登入」是**後端確認過的**：只是還留著
   一張失效的票的裝置，會先閃一下這頁說明（一個請求加一次換票的時間），接著直接變成重設密碼的表單。
5. 「所有帳號」看不到「這個人有沒有一條還沒用的連結」；再產生一次，舊的就失效。
6. 「所有帳號」**沒有分頁也沒有搜尋**。正式環境只有個位數帳號沒差；**dev 資料庫會一直長**——每次跑 e2e 都會開新帳號
   （邀請、好友、帳號設定的 spec），從來不刪（2026-10-08 已經一百多個）。管理員的「我的」因此很長，`account-settings.spec.ts`
   在那一頁量每一顆按鈕的觸控高度，帳號越多越慢；按鈕要用完整的可及名稱「產生重設密碼連結：{名字}（{email}）」找。
7. **`/reset-password`（與 `/join`）的同分頁限制**：碼只在第一次 render 讀。在同一個分頁把網址換成只有 `#` 後面不同的另一條連結，
   瀏覽器不重新載入，畫面停在上一條連結的結果；重新整理或開新分頁就好。
8. 目標只能「從今天起」：不能設未來的期間、不能編 `label`；新端點不收 0，舊的 `POST`／`PATCH /api/targets` 仍收 0。
9. 兩台裝置同時存目標 → 後到的 409「目標剛被另一台裝置改過，請重新整理再試」，重存一次就好（第二次走原地改）。
10. `app.*` 的 INFO 現在會輸出。之前沒有任何 `app.*` 的 `logger.info`，所以目前只多了上面三種稽核紀錄。
11. ~~「所有帳號」的清單會進離線快取~~——審查之後整個 `["admin", …]` 命名空間（所有帳號、邀請清單、待審提案）都**不進
    離線快取**（`api/persist.ts` 的 `NOT_PERSISTED`）：別人的 email 不該以明文留在 localStorage，這三個畫面也只在線上有用。
    代價：管理員離線時這三份清單是空的（「無法載入…」），不是上一次的內容。
12. **登入的限速可以被拿來拖住別人**（知道 email 就行），改密碼共用同一個限速器——見 §5.2 的說明；開放到網際網路之前要加
    按來源 IP 的一層。
13. **目標表單打開之後**別台裝置又改了目標：這台存下去仍然會蓋掉（後端沒有樂觀鎖）。表單只保證「打開的那一刻」是伺服器上的值。
14. 另一個分頁登出時，這個分頁也顯示「已被登出，請重新登入」——`storage` 事件不帶原因，分不出對面是自己按的還是換票被拒。
    例外：這個分頁正開著一條**碼還在網址列**的邀請或重設連結（登入還沒確認過，例如連不上）→ 直接變成那條連結的表單。
15. **已登入打開邀請或重設連結時連不上**：確認不了登入，碼會一直留在網址列（歷史紀錄、截圖），說明頁上「網址列上的
    已經拿掉了」那句話這時不準。恢復連線後重新整理就會確認並拿掉。寧可這樣，也不在不確定的時候把碼拿掉。

### 報表看其他月份與匯出資料

報表可以一個月一個月往回看；「我的」可以把自己全部的餐點、花費、補劑各下載成一個 CSV（規格
`docs/superpowers/specs/2026-10-09-reports-month-export-design.md`、計畫
`docs/superpowers/plans/2026-10-09-reports-month-export.md`，計畫的「執行中發現的差異」記了實作跟計畫不一樣的地方）。
**沒有 migration、沒有新的環境變數；後端的月份參數一行都沒改**（本來就收 `month`，只補了兩條測試）。

**機制摘要：**

- **看哪個月寫在網址上**：`/reports?month=YYYY-MM`，**沒有參數＝這個月**。重新整理、上一頁、書籤都免費得到；平常的網址不變，
  跨月之後自動是新的月份。
- **「這個月」是後端說的**：報表畫面永遠掛著不帶月份的 `useExpenseSummary(null)`，它回應裡的 `month` 就是
  `this_month_in_timezone(user.timezone)`。「下個月」到它為止、網址上的月份有沒有超過，都跟它比；**還不知道的時候不猜**
  （沒帶月份 → 兩顆都停用；帶了合法的月份 → 照樣顯示那個月、只有「上個月」能按）。
- **月份的加減是純字串運算**（`lib/months.ts`：`isYearMonth`、`shiftMonth`、`formatYearMonth`），**不用 `Date`**——同
  `lib/civil-date.ts`，有原始碼掃描測試守著。範圍是後端收的 `1900-01`～`2099-12`，推出去 `shiftMonth` 回 `null`、按鈕停用。
- **網址上的月份不能用就當成沒帶，並用 `replace` 清掉**：格式不對 → 馬上（不拿它問後端，會 422）；比這個月後面 → 等後端
  回了這個月才清。**剛好等於這個月不清**（「這個月」可能來自離線快取、是舊的）；**從過去翻回這個月時把參數拿掉**
  （不寫 `?month=這個月`，才會跟著後端走）。換月份是 push：上一頁回到剛才看的月份。
- **`keepPreviousData` 在 `useExpenses`／`useExpenseSummary` 裡**；換月份時摘要與清單的內容層各自 `aria-busy`＋`.stale`
  （同趨勢頁）**＋`inert`**，月份標籤與標題已經是新的月份。query key 沒動（`["expenses","list"｜"summary", month]`），改刪之後失效
  `expensesAll` 本來就打到每一個月；**離線持久化沒改**。
- **留著的上一個月只能看**（審查 M3）：那幾列的「修改」「刪除」是上一個月的，`inert` 讓整層點不到、Tab 不到。
  **離線而且沒看過那個月**（query 是 `paused`，不會自己結束）算「讀不到」，跟請求失敗顯示同樣的文字，不留上一個月的資料
  （`Expenses.tsx` 的 `isUnavailable`；同 `Targets.tsx` 對 `paused` 的處理）。**之後用 `keepPreviousData` 的畫面，
  留著的那一層有按鈕就要 `inert`，而且要想 `paused` 的時候畫什麼。**
- **停用而可能正在焦點上的按鈕用 `aria-disabled`**（審查 M5）：報表的「上個月」「下個月」、匯出的三顆。原生 `disabled`
  會讓那顆按鈕失去焦點（Chromium 實測：e2e 的 `toBeFocused`）。代價是瀏覽器不再擋 click，元件自己擋；長相在 `ui.module.css` 的
  `.secondary[aria-disabled="true"]`。**其他畫面的按鈕還是原生 `disabled`**（送出鍵 pending 時停用之類）——同樣會丟焦點，
  這次沒有動。
- **之後有別的畫面要「看某個月／某一天」，照這個形狀：網址放明確的值、沒有值就讓後端決定、界線問後端。**
- **CSV 的寫法只有一份**（`app/csv_export.py`）：`csv.writer`、CRLF、開頭一個 BOM。**儲存格的型別決定怎麼寫**——
  `str` 是文字（第一個字元是 `=` `+` `-` `@` Tab CR LF 的前面加 `'`，擋 CSV injection）、`Decimal` 是數字
  （`format(v, "f")`，不加）、`None` 是空的。呼叫端不用記哪幾欄要擋。**之後任何要輸出 CSV 的地方都走它。**
- **分塊是 keyset 查詢**（`app/export.py` 的三支 async generator）：`(時間, id) > 上一塊最後一列`＋`LIMIT`（一塊 500 列，
  餐點一塊 200 餐、項目用 `meal_id IN (…)` 一次拿），交給 `StreamingResponse`。**不用 OFFSET**：越後面越慢，而且匯出到一半
  有人新增一筆，後面每一列都會位移。**游標帶 `id`**：同一個時刻的列不會被跳過或重複。不是 server-side cursor——不握著一個
  跨整個下載的 cursor，在測試的 savepoint 夾具裡也照常運作。
- **串流用的就是 `Depends(get_db)` 那個 session，靠 FastAPI ≥ 0.118 活到串流結束**（`yield` 依賴在回應送完之後才收尾）。
  `Depends(get_db, scope="function")` 會在第一塊之前就把它關掉；`pyproject.toml` 的下限是 `fastapi>=0.118`
  （lock 是 0.141.1），`tests/test_export.py` 有一條測試守著「塊、塊、收尾」的順序（三個端點都守）。
- **session 活著，但送的時候不握連線**（審查 I1，`app/api/routes/export.py`）：讀的人不讀了，伺服器就卡在 `send` 上。
  `_csv_response` 回傳之前、`_release_between_chunks` 每一塊（與結尾）交出去之前都先 `commit()`，連線回到池子，下一塊再借。
  「借 → 查 → commit」整段用 anyio 的 shield 擋住斷線的取消，擋完 `checkpoint_if_cancelled()`（為什麼兩個都要：§6 的
  審查修正那一段）。**之後任何會串流的端點都要問同一個問題：卡在 `send` 的時候手上握著什麼。**
- **匯出的內容**：只有呼叫者自己的（`user_id` 一律來自 token，沒有任何「誰的資料」參數）；時間是帳號時區的當地時間；
  餐點的營養素用 `item_join_query()`＋`scale()`（跟 `GET /api/meals` 同一份實作）；`photo_path` 根本沒有被 SELECT；
  內部 id 只有「餐點編號」。分類、餐別是中文標籤（後端自己一份對照表，測試守「每個 enum 成員都有標籤」）。
- **限速**：`export_rate_limiter`（`KeyedRateLimiter`），**每人每分鐘 6 次、三個端點共用**，鍵是 `str(user.id)`；超過是
  `429 TOO_MANY_EXPORTS`＋`Retry-After`。**外加一個人同時一個**（審查 I1）：`export_in_flight`（`InFlightLimiter`），
  前一個還沒結束是 `429 EXPORT_IN_PROGRESS`、**不帶 `Retry-After`**（`TooManyRequestsError` 的秒數可以是 `None`）。
  兩個都在 router 上的 `export_slot` 依賴裡（先算次數、再看有沒有在跑），位子在 `yield` 之後的 `finally` 放掉——
  **不在串流 generator 的 `finally` 裡**（§7「串流 generator 的 `finally`」）。記憶體、單容器（同 §5.2）。
- **前端下載**：`<a href>` 帶不了 `Authorization`（同照片），所以 `api/client.ts` 的 `fetchDownload()`（跟 `apiFetch`、
  `fetchPhotoBlob` 共用 `fetchWithAuthRetry`）先拿成 `Blob`、檔名讀 `Content-Disposition`；`lib/save-file.ts` 的 `saveBlob()`
  用暫時的 object URL＋`<a download>` 存檔、40 秒後才 `revokeObjectURL`。**iOS 主畫面模式**（`navigator.standalone === true`
  而且 `canShare({ files })`）改用 `navigator.share`——桌面與 Android 也有 `canShare`，但那裡下載是好的，不分享。
  檔名的日期是後端算的（前端不算今天）。卡片不用 `useMutation`（離線時暫停、恢復連線才送的下載會在人離開之後自己冒出來），
  下載中三顆一起不能按（`aria-disabled`＋一個 ref 擋 click）；「已下載 …」的 `role="status"` 區塊一直都在、先是空的。

**新的東西在哪裡：**

- 後端：`app/csv_export.py`、`app/export.py`、`app/api/routes/export.py`（`GET /api/export/{meals,expenses,supplements}.csv`，
  在 `app/main.py` 註冊；`export_slot`、`_release_between_chunks` 也在這裡）、`app/ratelimit.py` 的 `export_rate_limiter`、
  `InFlightLimiter`／`export_in_flight`（`tests/conftest.py` 的 autouse fixture 每個測試重置）、`app/errors.py`
  （`TooManyRequestsError` 可以不帶秒數）、`pyproject.toml` 多一行 `anyio`（lock 沒變）；
  測試 `tests/test_csv_export.py`、`tests/test_export.py`、`tests/test_expenses_summary.py`（月界線的兩條釘子）。
- 前端：`lib/months.ts`；`screens/Expenses.tsx`／`Expenses.module.css`（月份切換，`role="group"`「切換月份」、月份是
  `role="status"`；內容層 `data-testid="month-summary"`、`month-list`）；`api/expenses.ts`（`keepPreviousData`）；
  `api/client.ts` 的 `fetchDownload`；`lib/save-file.ts`；`api/export.ts`（`EXPORT_KINDS`、`downloadExport`）；
  `components/ExportCard.tsx`（`data-testid="export-card"`，放在「好友」之後、管理員的卡片之前）。測試
  `tests/months.test.ts`、`expenses-month.test.tsx`、`offline.test.tsx`、`save-file.test.ts`、`export-card.test.tsx`、
  `client.test.ts`、`me.test.tsx`。
- e2e：`e2e/reports-export.spec.ts`（換月份、匯出花費、留著的上一個月點不到、手機尺寸四條）。**會記帳的三條各自開新帳號**
  ——總額與 CSV 的列數才是確定的（示範帳號同時有別的 worker 在記帳）。
- **審查的斷線探針**不在 repo 裡（它起一個真的 uvicorn、對開發資料庫只讀）：三種斷線的時間點＋一個不讀的用戶端，印
  `engine.pool.checkedout()`。修正前「不讀的用戶端」是 1，修正後是 0，卡住時第二個匯出是 429、斷線後下一個是 200。
  之後動 `app/api/routes/export.py` 的串流，單元測試之外**再對真的 uvicorn 跑一次**——§6 那兩條都是這樣才看到的。

**已知限制**（規格 §8 的 20 點，編號相同）：

1. **清單最多 100 筆**（既有落差）：報表的總額算整個月，清單被 `limit` 截斷時兩者對不起來，而且沒有訊號。看過去的月份一樣。
2. 一次只能翻一個月，沒有月份選擇器；翻到這個月為止。
3. 記帳永遠記在「現在」：過去的月份不能補記、不能改一筆的日期。
4. **還不知道這個月是哪個月時**（離線而且沒有快取、或那個請求失敗），沒帶月份的報表不能翻。
5. **跨月的那一刻**：快取裡的「這個月」還是上個月時（`staleTime` 60 秒內、或剛從離線快取還原），標籤與「下個月」的界線
   是舊的，重抓回來才更正。
6. 手打未來的月份：前端在知道這個月之前會先照它問一次後端（空的結果），然後退回這個月。
7. **離線時看得到的過去月份只有最近看過的**：5 分鐘沒有畫面在用的 query 會被 TanStack 回收（預設 `gcTime`），下一次寫入
   就從 localStorage 拿掉。照預設值推論的，沒有另外量。
8. 匯出是「全部歷史、一種一個檔」：沒有日期範圍；餐點的檔沒有餐費，花費的檔沒有餐點編號，兩個檔之間沒有可以對起來的鍵。
9. **後端的記憶體是平的，瀏覽器的不是**：整份 CSV 先變成一個 Blob 才存檔。
10. **卡住的下載不佔資料庫連線，但佔著那個人的位子**（審查 I1）：連線只在查一塊的那一下被借走。讀得很慢或不讀的用戶端
    還是佔著一個 task、uvicorn 的寫入緩衝、與「這個人正在匯出」的位子，直到連線斷掉——**伺服器不會主動踢掉卡住的下載**
    （uvicorn 沒有寫入逾時），那個人在那之前再按是 `429 EXPORT_IN_PROGRESS`。偷到 access token 的人可以這樣讓本人
    匯出不了，直到那條連線斷掉或容器重啟（`docker compose restart api` 清得掉）；票過期不會中斷已經開始的串流。
11. **不是同一個時間點的快照**：每一塊是分開的查詢，匯出途中新增、刪除、改時間的列可能有、可能沒有、可能出現兩次。
12. 串流開始之後才出錯（例如資料庫斷線）：狀態碼已經是 200，只能中斷連線。前端顯示「下載失敗」；用 curl 的人會拿到
    被截斷的檔案。**前端那一段沒有測試**；後端只測了「串流中途失敗之後位子有放掉」。
13. 食物、補劑的名稱與品牌是**現在的**（名稱不版本化）；營養素與份量是當時的。
14. 分類與餐別的中文標籤前後端各一份；加分類時兩邊都要改（後端有測試會紅，前端是編譯錯誤）。
15. 開頭是公式字元的文字，匯出之後前面多一個看得到的 `'`。全形的 `＝＋－＠` 不擋。
16. **iOS 主畫面模式沒有實機驗證，到交接時仍然沒有**：分享面板與退回的 `<a download>` 兩條路都只有單元測試
    （守的是「走哪一條路」）。**要請使用者在 iPhone 上從主畫面打開、實際按一次「花費」**，結果補在這裡。
17. 匯出的限速在記憶體裡，重啟歸零（同其他限速器）。「一個人同時一個」也是；多容器的話每個容器各算各的。
18. **用戶端斷線時，正在做的那一塊會做完才停**（最多多讀 500 列／200 餐）。擋的是 Starlette 斷線時用的 anyio cancel
    scope；**伺服器關機時直接取消 task 擋不住**——那時 log 裡可能有 `Exception terminating connection … CancelledError`
    的 traceback，是已知的雜訊（審查 M4；用戶端斷線的那條路已經不會出現）。
19. **換月份時留著的上一個月是 `inert`**，請求重試的期間（預設 3 次，約 7 秒）也是：看得到但不能操作。jsdom 不實作
    `inert`，單元測試守的是屬性；真的點不到由 e2e 守。
20. **「離線」是瀏覽器說的**（`fetchStatus === "paused"`）。連得上網路但連不到後端（tailnet 不通）不是 paused：請求照常
    失敗、重試，重試期間是調淡、不能操作的上一個月，全部失敗之後才顯示讀不到。

---

## 11. 這個專案的工作方式

值得延續，因為它產出了上面第 6 節那份清單：

1. **規格 → 實作計畫 → 執行**，每個階段都是獨立文件
2. **計畫寫得極細**（含測試清單、陷阱、預期紅燈），因為
   **缺陷幾乎都出在計畫文字本身**，不是實作
3. **實作交給 subagent**，主 session 負責審查與驗證
4. **每個守衛都要突變測試**，而且突變結果寫回計畫文件
5. **實測發現一律寫回計畫**，包含「我原本寫錯了」的更正 ——
   六份計畫文件裡有大量這種段落，那是這個專案最有價值的部分
