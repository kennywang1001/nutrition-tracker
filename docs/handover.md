# 交接文件

**專案：** nutrition-tracker —— 飲食紀錄系統
**Repo：** https://github.com/kennywang1001/nutrition-tracker（公開）
**狀態：** 後端完成並可部署、session 撤銷已完成；介面改版第一階段、食物的一份、修改與刪除已記錄的餐點已上線；AI 估算的前端已實作於 `feat/ai-estimate`
**文件產出日：** 2026-09-11（session 撤銷完成後更新於 2026-09-12）

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
| 端點 | **45** |
| 測試 | **503**（`pytest -W error` 全綠） |
| 覆蓋率 | 96% |
| 資料表 | 11（+ `alembic_version`） |
| Migration | `0001` ~ `0007` |
| Commit | 180+ |
| PR | 5 個，全部經 CI 驗證後合併 |

### 階段進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 骨架 | Docker Compose + CI + repo 結構 | ✅ 隨 P1 長出來 |
| P1 核心 | 資料模型 + CRUD API + 測試框架 | ✅ |
| P2 AI 分析 | 拍照 → 辨識 → 估算 → **驗證** → 落庫。後端（Anthropic 與 Gemini 擇一，`AI_PROVIDER`）與前端（記一餐、新增食物的估算面板；規格 `docs/superpowers/specs/2026-10-05-ai-estimate-frontend-design.md`、計畫 `docs/superpowers/plans/2026-10-05-ai-estimate-frontend.md`） | ✅ 已實作於 `feat/ai-estimate` |
| **P3 介面** | **PWA（TypeScript + React）** | 🟡 **P3-A ✅、P3-B 計畫一 ✅、計畫二待 PR** |
| P4 上線 | NAS 部署 + Tailscale | ✅ |
| **UI 改版 第一階段** | tab bar 總覽｜報表｜＋｜飲食｜我的；MOZE 風格外觀（設計變數 + 深色模式，跟隨系統）；自訂數字鍵盤記帳；記一餐可選填照片；總覽時間線（規格 `docs/superpowers/specs/2026-10-02-ui-redesign-phase1-design.md`、計畫 `docs/superpowers/plans/2026-10-02-ui-redesign-phase1.md`） | ✅ 已實作於 `feat/ui-redesign-phase1`，待合併 |
| 修改與刪除已記錄的餐點 | 編輯畫面 `/meals/:id/edit`：改份量或數量、加刪項目、改餐別、改金額（改、補、拿掉）、換或刪照片、刪整餐（連餐費）。入口：飲食頁卡片的「編輯」、總覽時間線的餐點列（規格 `docs/superpowers/specs/2026-10-04-edit-meals-design.md`、計畫 `docs/superpowers/plans/2026-10-04-edit-meals.md`） | ✅ 已實作於 `feat/edit-meals` |
| UI 改版 第二階段 | 圖表與其餘畫面換新外觀 | ⬜ |
| UI 改版 第三階段 | 社群（P7），草稿在分支 `docs/p7-social-decisions` | ⬜ |

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
  ratelimit.py         登入速率限制（記憶體，單容器）
  food_visibility.py   食物/份量的分層可見性（共用）
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

## 6. 這個專案最有價值的產出：五十二種「綠燈說謊」

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
| TanStack v5 mutation 的 callback | `useMutation({ onSuccess })` 在元件卸載之後**仍然會跑**；`mutate(vars, { onSuccess })` 不會。會導頁或改父層狀態的事放在後者（編輯餐點 Task 6、AI 估算 Task 4） |
| `docker ps` 顯示 `Up` | **不代表活著**。uvicorn reloader 父行程在子行程崩潰時仍活著 |
| 改環境變數後 `restart` | **不夠**，要 `up -d`（會重建容器） |
| 在本機起 prod 疊加設定 | 會**接管同名的 dev 容器**（專案名稱相同），dev 的 `db` 會失去 `5433` 的埠發佈。驗證完要 `down` 再 `docker compose up -d` 把 dev 收回來，否則 host 上的 pytest 連不到資料庫 |
| 改依賴後 | **必須重建映像**，`--reload` 只換程式碼不換依賴 |
| **新增 migration 後** | 也**必須重建映像**。`Dockerfile` 是 `COPY . .`，migration 檔案是烤進映像的，不是掛載的 —— dev 的原始碼掛載只有 `./app`。症狀是 `relation "xxx" does not exist`，而檔案明明在 repo 裡 |
| `ruff format` | **CI 只跑 `ruff check .`，沒有跑 `ruff format --check`**。這個 repo 有既有的格式差異，跑 `ruff format` 會把一堆跟你這次改動無關的行重排進 diff 裡。不要在不相干的改動裡順手跑它 |
| vitest 的 `Test Files` / `Tests` | **都是實際數量的兩倍**。`vite.config.ts` 的 `typecheck.include` 跟一般 include 蓋到同一組檔案，每個檔案被跑兩次（一次執行、一次交給 tsc）。算數字時要除以二 |
| 只 grep `Tests ` 那一行 | **會漏掉整個檔案沒編譯成功**。一個 transform parse error 讓 vitest 同時印出 `FAIL tests/x.test.tsx (0 test)` 與 `Tests 8 passed (8)`。驗證要一起 grep `FAIL` 與 `Unhandled` |
| render 期例外的錯誤訊息 | `Failed Tests` 第一層顯示的是 `TestingLibraryElementError`（找不到元素），**真正的 `TypeError` 在要往下翻的 `Unhandled Errors` 區塊** —— 元件樹整個沒畫出來，沒有 error boundary 接住 |
| `// biome-ignore` 在 JSX children 位置 | **會被當成文字**，裡面的 `<rect>` 之類會被解析成開始標籤 → parse error。那個位置要用 `{/* biome-ignore … */}`；`return (` 之後屬於運算式位置，`//` 形式合法 |
| Windows Python 改 markdown | 文字模式寫入會把**整份檔案**轉成 CRLF，跟 `.gitattributes`（`* text=auto eol=lf`）衝突，整個 diff 變成雜訊。用 `newline="
"` |
| `tsBuildInfoFile` | 要放在**被 gitignore 蓋到的目錄**（這個 repo 是 `./node_modules/.tmp/`）。`tsconfig.e2e.json` 原本指向 `./e2e_modules/.tmp/`，於是那個 build cache 一直被 git 追蹤，每跑一次 typecheck 就多一個 modified |
| 改了後端的 request/response schema | **一定要 `npm run gen:api` 重新產生 `frontend/src/api/schema.d.ts`**，而**本機沒有任何東西會提醒你**。唯一的守衛是 CI 的 `contract` job（它起後端、重新產生、`git diff --exit-code`）。P3-B 計畫二 Task 8 加了 `FoodCreateRequest.is_global` 卻沒重新產生，backend / frontend / e2e 三個 job 全過，只有 contract 紅 |
| react-router 的路由順序 | **依片段具體程度排名，不依宣告順序** —— 跟 FastAPI 完全不是同一種機制。`/foods/:id` 排在 `/foods/new` 前面，`/foods/new` 仍然命中靜態路徑（用 `matchRoutes` 實測過） |

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
`revoke_all_for_user` 三條路徑都要取那把鎖。

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

### 8.1b 仍需優先處理

**`/api/auth/refresh` 與 `/api/auth/logout` 都沒有限速。** 兩者都是未認證、
可無限重放的寫入路徑，而且都會取每使用者的 advisory lock。實測：12 條並行
連線拿同一張**早就死掉的** refresh token 重放 `/logout`，可維持 302 次/秒，
把同一個使用者的合法換發從中位數 7.2ms 拉到 34.2ms。

是劣化不是阻斷，而且 `/refresh` 從 P1 就是這樣了，不是 session 撤銷引入的。
但要做就兩個一起做，鍵用 token 解出來的 `sub`。

### 8.2 其他延後項目

- **AI 估算的已知限制與後續**（AI 估算前端規格、計畫 `docs/superpowers/plans/2026-10-05-ai-estimate-frontend.md`）：
  - 一次一樣食物（P2 規格 §9）；「編輯這一餐」的加一項沒有 AI（`FoodPicker` 的
    `renderBelowSearch` 沒給，要加只是多傳一個 prop）。
  - 估算用的照片不存（記一餐的拍照估算會把那張照片當這一餐的照片，那是另一件事）。
  - `ai_raw_response` 存的是前端送來的估算回應（不是後端自己留的 LLM 原文）——它是
    你自己的資料，偽造它只會騙到你自己。
  - 供應商的 SDK 丟錯（金鑰或 `AI_MODEL` 錯）時端點回 500、畫面說「AI 估算失敗」，
    而且**算一次額度**（失敗的呼叫也記一列）。之後可以把 SDK 的錯誤分類成 502／503。
  - `remaining_today` 在同時多個請求時可能多報（各自以為只有自己用了一次）；額度檢查
    本身也有同樣的競爭（P2 就存在）。單人使用可接受。
  - `analyzeImage` 與 `uploadMealPhoto` 重複「擋大小＋縮到 1280」，可抽成 `preparePhoto`。
  - 面板在「結果卡片 ↔ 修改表單」切換時沒有移動焦點（交回食物之後由記一餐把焦點
    移到「已選擇」）。
- **孤兒照片的背景清理排程**：指令已有（`python -m app.cli cleanup-photos`），
  cron 設定寫在部署手冊，但**必須在容器內執行**（照片在 Docker volume，
  在 host 跑會看錯目錄）。
- **修改與刪除已記錄的餐點：已完成**（見階段進度）。已知的缺口：
  - 不能改時間（規格 §1.3）。後端的 `PATCH /api/meals/{id}` 可以改 `eaten_at`，
    但**既有餐費的 `spent_at` 不跟著動**。
  - 兩個請求同時替同一餐補金額（原本沒有餐費），可能建出兩筆支出——
    `expenses.meal_id` 沒有唯一約束。可加 partial unique index
    `expenses(meal_id) WHERE meal_id IS NOT NULL`。
  - 份量重量（≤10000）× 數量（≤10000）可能超過 `meal_items.quantity_g` 的
    `Numeric(8,2)`（999,999.99），asyncpg `DataError` 變成 500——POST 與 PATCH
    項目都有（P1 就存在）。
  - 編輯畫面：`useMeal`／`useFood` 遇到 404 仍然重試 3 次（約 7 秒才顯示
    「找不到這一餐」）；確認框沒有移動焦點（跟報表頁一樣）；從清單點進來仍會先
    看到「載入中」（可用清單快取當 `placeholderData`）；改項目後要等五個 query
    重抓完編輯器才收起。
- **照片縮圖**：清單頁載入多張 1280px 圖會慢，等前端量到再說。
- **速率限制的計數器不持久**：單容器記憶體，重啟歸零。這個規模可接受。
- **`GET /api/foods/frequent` 的可見性過濾今天是空轉的** ——
  `POST /api/meals` 已經擋住記錄看不到的食物。保留它是為了日後的
  「刪除食物 / 取消分享」，**但今天抓不到任何突變**（已在計畫裡誠實記錄）。
- **建立全域食物只有 API，沒有 UI**（P3-B 計畫二 Task 8 加了
  `POST /api/foods` 的 `is_global`，管理員限定）。`/foods/new` 仍然只建
  私人食物。共用食物庫的建立介面留給之後。
- **份量管理：新增與選用已完成，刪除與修改還沒有**（規格
  `docs/superpowers/specs/2026-10-03-food-portions-design.md`，計畫
  `docs/superpowers/plans/2026-10-03-food-portions.md`）。新增食物可以設一份，
  也可以照包裝「每一份」輸入營養素（前端換算成每 100）；食物詳情頁可以替任何
  食物加自己的份量；記一餐自動選上預設份量（自己的優先於公開的）。同一個人、
  同一個食物只會有一個預設份量（新增預設時後端會取消舊的）；記一餐的餐點清單
  對液體仍顯示 g（既有問題）。仍缺：刪除與修改份量（後端沒有端點）。
- **趨勢圖是刻意的最小版**：七天、只有熱量、實際對目標。指標切換、期間
  切換、自由日期選取都沒做 —— 理由是「要看什麼」在真的每天用過兩週之前
  就是猜（P3-B 規格 §1.1、§12）。而**那兩週還沒發生**，見下。
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

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

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

介面改版第一階段（見上方階段進度）已實作於 `feat/ui-redesign-phase1`。

**下一步：**

- **第二階段**：圖表（支出圓餅圖、營養趨勢）；其餘畫面（食物庫、補劑、
  管理員、趨勢）換新外觀，包括把 `index.css` 裡寫死的舊顏色換成設計變數
  （例如 `.food-no-nutrition` 的 `#b33`，在深色表面上對比只有約 3:1），
  以及舊按鈕補到 44px 點擊範圍
- **第三階段**：社群（P7），從分支 `docs/p7-social-decisions` 的草稿開始

**已知待辦：**

- (a) TanStack v5 的 `defaultShouldDehydrateQuery` 只持久化 `success`
  狀態的查詢——一個「持有快取資料但重新抓取失敗」的查詢，可能在下一次寫入
  localStorage 時被丟掉，於是第二次離線重新載入可能什麼都不顯示（既有問題，
  Today 也受影響；修法在 `frontend/src/api/persist.ts`）。**未驗證，審查推論。**
- (b) 矮螢幕手機（例如 iPhone SE）上，記帳數字鍵盤的最下面幾列在捲動前
  會被 tab bar 蓋住。可選方案：在 `/expenses/new` 與 `/meals/new` 隱藏
  tab bar（待使用者決定）。
- (c) 桌機實體鍵盤打字不會輸入到記帳數字鍵盤。

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
