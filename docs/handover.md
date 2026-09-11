# 交接文件

**專案：** nutrition-tracker —— 飲食紀錄系統
**Repo：** https://github.com/kennywang1001/nutrition-tracker（公開）
**狀態：** 後端完成並可部署；**尚無前端**
**文件產出日：** 2026-09-11

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
| 端點 | **43** |
| 測試 | **463**（`pytest -W error` 全綠） |
| 覆蓋率 | 96.5% |
| 資料表 | 10（+ `alembic_version`） |
| Migration | `0001` ~ `0006` |
| Commit | 180+ |
| PR | 5 個，全部經 CI 驗證後合併 |

### 階段進度

| 階段 | 內容 | 狀態 |
|---|---|---|
| P0 骨架 | Docker Compose + CI + repo 結構 | ✅ 隨 P1 長出來 |
| P1 核心 | 資料模型 + CRUD API + 測試框架 | ✅ |
| P2 AI 分析 | 拍照 → 辨識 → 估算 → **驗證** → 落庫 | ⬜ |
| **P3 介面** | **PWA（TypeScript + React）** | ⬜ **下一步** |
| P4 上線 | NAS 部署 + Tailscale | ✅ |

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
  cli.py               create-admin / cleanup-photos
  storage/photos.py    照片的所有檔案讀寫（規格第 8 節：集中在單一模組）
  models/              SQLAlchemy models（唯一的 schema 事實來源）
  schemas/             Pydantic 請求/回應
  api/routes/          端點
docs/
  superpowers/specs/   規格（P1 設計文件）
  superpowers/plans/   六份實作計畫（含所有實測發現）
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

## 6. 這個專案最有價值的產出：十種「綠燈說謊」

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

### 由此長出的幾條規矩

1. **綠燈在被觀察到失敗之前不算證據。** 每個守衛都要突變過。
2. **要測 A 過濾器，測試資料必須讓 B 過濾器無效。**
3. **測試清理動作，就必須在它之後再做一件需要乾淨狀態的事。**
4. **順序要求需要「觀察順序」的測試** —— 端狀態測試在定義上抓不到。
5. **突變存活時先問「這一行真的是唯一實現該保證的地方嗎」**，再問「測試夠不夠力」。
6. **兩個視窗的重疊區間就是零鑑別力的區間。** 判斷方法不是背規則，是畫出來取重疊。
7. **文件擋不住重蹈覆轍，程式碼可以。** 與其寫第三次警告，不如把檢查寫進 helper，
   讓錯誤的選擇在執行時就爆掉。

> **第 7 條是最貴的一課。** 「零鑑別力區間」這條規則是我自己寫下來的，
> 又在下一個計畫的說明裡重述了一次 —— 然後還是踩了。
> **知道一條規則，跟在具體情境裡認出它適用，是兩種不同的能力。**

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
| PG `AT TIME ZONE` vs Python `zoneinfo` | 兩套獨立實作。實測 90 個時刻 0 不一致，但有測試釘住漂移 |
| asyncpg `contype` | `"char"` 回傳成 **bytes**（`b'c'`），比對要加 `::text` |
| asyncpg 日期參數 | 要傳真的 `date` 物件，`$1::date` 配字串會拋 `DataError` |
| `docker ps` 顯示 `Up` | **不代表活著**。uvicorn reloader 父行程在子行程崩潰時仍活著 |
| 改環境變數後 `restart` | **不夠**，要 `up -d`（會重建容器） |
| 改依賴後 | **必須重建映像**，`--reload` 只換程式碼不換依賴 |

---

## 8. 已知缺口與延後項目

### 8.1 需要優先處理

**session 撤銷（安全性）。** `/api/auth/refresh` 每次換發都發一張新的 14 天票，
**而舊的仍然有效**（實測確認）。所以那不是 14 天上限，是一個
**只要裝置持續使用就永遠不會關上的滑動視窗**。手機掉了唯一的止血是
換 `JWT_SECRET`，那會把所有人一起登出。

計畫 1 明寫「不要拖到 P4，要自己一個 task」—— 目前仍未做。

### 8.2 其他延後項目

- **孤兒照片的背景清理排程**：指令已有（`python -m app.cli cleanup-photos`），
  cron 設定寫在部署手冊，但**必須在容器內執行**（照片在 Docker volume，
  在 host 跑會看錯目錄）。
- **`meal_items` 的修改端點**：目前改數量 = 刪掉再加。
- **照片縮圖**：清單頁載入多張 1280px 圖會慢，等前端量到再說。
- **速率限制的計數器不持久**：單容器記憶體，重啟歸零。這個規模可接受。
- **`GET /api/foods/frequent` 的可見性過濾今天是空轉的** ——
  `POST /api/meals` 已經擋住記錄看不到的食物。保留它是為了日後的
  「刪除食物 / 取消分享」，**但今天抓不到任何突變**（已在計畫裡誠實記錄）。

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
**注意舊 refresh token 不會失效**（見 §8.1）。

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
