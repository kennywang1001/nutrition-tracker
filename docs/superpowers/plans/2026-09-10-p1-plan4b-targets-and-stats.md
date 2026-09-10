# P1 計畫 4b：目標與統計

規格：`docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md`
前置：計畫 1、2、3、4a 皆已合併進 master。

起點：320 個測試、37 個端點、覆蓋率 98.20%。

**這是 P1 的最後一個計畫。** 做完之後，「記錄 → 比對目標 → 看趨勢」這條線完整。

---

## 這份計畫從前四個計畫繼承的規矩

1. **權限失敗一律回 404，不回 403**，連 body 都要逐字相同。角色不足才是 403。
2. **路徑參數一律用 `ResourceId`**。
3. **捕捉 `commit()` / `flush()` 例外前必須 `await db.rollback()`** ——
   而且 **`try` 的邊界要對齊「例外實際會從哪裡拋出」**：
   唯一約束是在 `flush()` 檢查的，不是在 `commit()`。
   計畫 4a 就是在這裡找到 `create_food` 一個活了兩個計畫的缺陷。
4. **測試一個清理動作，就必須在它之後再做一件需要乾淨狀態的事。**
   只斷言「錯誤有被正確回報」，證明不了「錯誤之後系統還能用」。
   計畫 4a 稽核發現六個 rollback 呼叫點裡有三個從未被驗證過。
5. **索引與約束全部宣告在 model 的 `__table_args__` 裡。**
6. **`CheckConstraint(name=)` 是命名慣例的輸入**；
   **`ExcludeConstraint(name=)` 不是** —— 慣例完全不介入，`ex_` 前綴要自己寫。
7. **`Enum(native_enum=False)` 一律搭 `create_constraint=False` +
   自己宣告的 `CheckConstraint`。這條規矩有兩半，漏掉第二半完全沒有徵狀** ——
   結果不是約束變弱，是完全沒有約束，而所有靜態檢查與測試都會是綠的。
8. **綠燈在被觀察到失敗之前不算證據。** 本專案已累積七種不同的「綠燈說謊」機制。

---

## 執行前提

不需要新增依賴。`btree_gist` 已在 migration 0001 建立，
計畫 4a 已實測 `ExcludeConstraint` 可以正常宣告在 model 裡且 `alembic check` 比對乾淨。

---

## 檔案結構

```
app/
  models/target.py            ← 新增
  schemas/target.py           ← 新增
  schemas/stats.py            ← 新增
  api/routes/targets.py       ← 新增
  api/routes/stats.py         ← 新增
  stats.py                    ← 新增：彙總的核心邏輯
migrations/versions/
  0006_*.py                   ← user_targets
tests/
  test_targets.py             ← 新增
  test_stats_daily.py         ← 新增
  test_stats_range.py         ← 新增
  test_day_boundary_consistency.py  ← 新增（跨端點的一致性）
  test_cross_user_isolation.py      ← 改
  factories.py                ← 改
```

---

## 本計畫確立的四個決定

### 決定 1：`PATCH /api/targets/{id}` 也是「關舊期間、開新期間」

跟計畫 4a 的 `supplement_plans` 完全同構，理由也一樣（規格決策 5）：
三月減脂期的蛋白質目標是 150g，六月轉增肌改成 180g ——
**三月的達成率不能用六月的標準重算。**

`POST` 開一個新期間（與既有期間重疊 → 409）。
`PATCH` 關閉指定的期間並開一個新的。**舊列的數值永遠不動。**

`user_targets` 的 EXCLUDE 鍵只有 `(user_id, daterange)` 兩項 ——
同一個人在同一天只能有一組目標，不像補劑計畫可以早晚各一。

### 決定 2：統計只回數字，不判斷達成與否

`GET /api/stats/daily` 回「實際攝取」、「目標」、「比例」與「食物/補劑的分項」，
**不回「達標了沒」的布林值。**

因為方向是相反的：減脂期熱量要「不超過」，增肌期蛋白質要「至少達到」——
**同一個 110% 在兩邊意義相反。** 把這個判斷寫進 API，等於把產品邏輯凍在資料層，
而且會逼使用者在設定目標時多回答四次「這是上限還是下限」。

沒設目標時 `target` 與 `ratio` 都是 `null`，不是 0，也不是省略欄位 ——
「沒設目標」與「目標是 0」是不同的事。

### 決定 3：依從率以「(計畫, 日) 配對」計算，且每對最多算一次

「這個月該吃 30 次魚油，實際吃了 23 次」要有精確定義：

```
應吃 = 期間內每一天 × 當天生效的每一筆計畫  → (plan, day) 配對數
實吃 = 上述配對中「當天至少有一筆對應打卡」的數量
依從率 = 實吃 / 應吃
```

**每對最多算一次是關鍵。** 不設上限的話，某天多吃一顆會讓依從率超過 100%，
而且可以用連吃三天補回漏掉的兩天 —— 那衡量的就不是「有沒有按計畫吃」了。

沒有任何計畫時（分母為 0）回 `null`，不是 0 也不是 1。

臨時打卡（`plan_id IS NULL`）**不計入依從率的分子**（它不對應任何計畫），
但**要計入營養素總攝取** —— 兩者是不同的問題。

### 決定 4：`/stats/range` 有天數上限

`from` 與 `to` 相距超過 **366 天 → 422**。

沒有上限的話，一個請求可以要求彙總十年的資料。這不是效能潔癖：
P1 沒有分頁、沒有快取，而回應體積與天數成正比。

---

## 四個必須在動手前講清楚的陷阱

### 陷阱 1：三個端點對「同一天」的判斷必須完全一致

這是整個計畫最重要的正確性要求，也是最容易悄悄壞掉的地方。

| 端點 | 誰決定「這一天」 |
|---|---|
| `GET /api/meals?date=` | 計畫 3 的 `day_bounds()` |
| `GET /api/supplements/today` | 計畫 4a 的 `day_bounds()` + `today_in_timezone()` |
| **`GET /api/stats/daily?date=`** | 本計畫 |

三者不一致的話，**同一天的餐點數、打卡數與統計數會對不起來**，
而且每一個端點各自看起來都是對的。使用者會看到「今天吃了 3 餐」
但統計只算了 2 餐的熱量 —— 沒有任何東西會報錯。

**Task 9 專門處理這件事**：一個測試，把一筆恰好落在日界線上的餐點與打卡
同時餵給三個端點，斷言三者的歸屬判斷相同。

### 陷阱 2：PostgreSQL 的 `AT TIME ZONE` 與 Python 的 `zoneinfo` 是兩套獨立實作

趨勢統計要把資料按「使用者當地日期」分桶。**不要在 Python 迴圈裡呼叫 365 次
`day_bounds()` 再發 365 次查詢** —— 那是跨日期的 N+1。

正確做法是在 SQL 裡一次分桶：

```sql
(m.eaten_at AT TIME ZONE :tz)::date AS local_day
```

**但這引入一個一致性風險：** `AT TIME ZONE` 用的是 PostgreSQL 自己的時區資料庫，
`day_bounds()` 用的是 Python 的 —— 在 Windows 上那是 PyPI 的 `tzdata` 套件，
在 Docker 裡是 `/usr/share/zoneinfo`。**三個可能的來源，各自獨立更新。**

**寫計畫時已實測**（PostgreSQL 16.15 對 Python zoneinfo + tzdata 2026.3）：
三個時區（`Asia/Taipei`、`America/New_York`、`America/Havana`）
的 DST 切換日各取 10 個時刻，共 90 個，**不一致 0 個**。

所以今天可以放心用。但這是「今天一致」，不是「必然一致」——
某國改了日光節約規則、而兩邊資料庫更新時間不同步的話就會漂移。
**Task 6 要有一個測試把這件事釘住**：對一組跨 DST 的時刻，
斷言 SQL 分出來的 `local_day` 與 Python `day_bounds()` 的歸屬相同。
它今天必然是綠的 —— 它的價值在於**那一天**會變紅。

### 陷阱 3：目標的四個營養素欄位都可以是 NULL

規格第 6.5 節：「允許使用者只設熱量目標、不設三大營養素。」

所以 `ratio` 必須**逐欄位**處理 NULL：熱量有目標就算比例，蛋白質沒設就回 `null`。
不能因為某一欄沒設就整組回 null，也不能把 NULL 當成 0 —— 除以 0 會炸，
而「目標是 0 公克蛋白質」跟「沒設蛋白質目標」是不同的事。

### 陷阱 4：食物與補劑的營養素來源不同，加總前的處理也不同

| 來源 | 資料在哪 | 加總前要做什麼 |
|---|---|---|
| 食物 | `meal_items.quantity_g` + 釘住的 `food_revisions` | **要換算**：`kcal × quantity_g / 100` |
| 補劑 | `supplement_intakes` 的四個快照欄位 | **不用換算**，快照已經是這次吃的總量（計畫 4a 決定 3） |

**兩邊的處理不對稱，這是刻意的。** 忘記換算食物那邊，或多乘一次補劑那邊，
算出來的數字都會「看起來合理」而不會報錯。

那個 `100` 只能出現在 `app/nutrition.py` 一處（計畫 3 已建立），
統計要用 `app/nutrition.py` 既有的函式，**不要重寫一份**。

---

## Task 1: `user_targets` 的 model

**Files:** `app/models/target.py`、`app/models/__init__.py`（改）

欄位照規格第 6.5 節：四個營養素**皆可為 NULL**，`label`、`effective_from`、
`effective_to`（可為 NULL = 持續至今）。

約束：

```python
CheckConstraint("kcal IS NULL OR kcal >= 0", name="kcal_non_negative"),
# protein_g / fat_g / carb_g 同樣三條
CheckConstraint(
    "effective_to IS NULL OR effective_to > effective_from",
    name="effective_range",
),
ExcludeConstraint(
    ("user_id", "="),
    (text("daterange(effective_from, effective_to, '[)')"), "&&"),
    name="ex_user_targets_no_overlap",
    using="gist",
),
Index("ix_user_targets_user_id_effective", "user_id", "effective_from", "effective_to"),
```

> `ExcludeConstraint` 的寫法在計畫 4a 已實測：欄位用字串名、運算式用 `text()`，
> `alembic check` 連續三次比對乾淨。**`ex_` 前綴要自己寫在 `name=` 裡**，
> 命名慣例不會替它加。

此時 `alembic check` 會報漂移、所有測試 error，**這是預期的紅燈**。
只跑 `ruff` 與 `mypy app`。

Commit: `feat: 新增 user_targets 的 model`

---

## Task 2: migration 0006

對 `wallet_test` 做 `upgrade → downgrade 0005 → upgrade`，然後 `alembic check` 連續三次。

**實測回報：** 用原始 SQL（asyncpg、逐筆 savepoint、最後 rollback）驗證
EXCLUDE 真的擋得住重疊、且不誤擋相鄰期間與不同使用者。
查 `pg_constraint`（記得 `contype::text`）回報所有約束名稱。

> 計畫 4a 的兩個實驗坑：**每一筆插入要自己的 savepoint**
> （否則第一次違反約束就讓交易 aborted，後面全部誤判成「被擋」）；
> **日期要傳真的 `datetime.date` 物件**（`$4::date` 配字串會拋 `DataError`）。

Commit: `feat: 新增 user_targets 的 migration`

#### Task 1 / 2 實測發現

**1. `CHECK` 約束對 NULL 完全放行 —— `IS NULL OR` 前綴是裝飾性的。**

```
SELECT NULL::numeric >= 0   ->  NULL   （不是 FALSE）
SELECT   5::numeric >= 0    ->  TRUE
SELECT (-5)::numeric >= 0   ->  FALSE
```

**CHECK 只在求值為 `FALSE` 時才擋**，求值為 `NULL` 時放行。實測建了兩個欄位
（一個寫 `CHECK (bare >= 0)`、一個寫 `CHECK (guarded IS NULL OR guarded >= 0)`），
兩者對 NULL 都插得進去、對 `-5` 都擋得住 —— **行為完全相同**。

我們仍然保留 `IS NULL OR`，因為它把意圖寫給讀的人看，成本是零。
但要知道它沒有在做事。

> **這一點兩面都會咬人：**
>
> - **想擋掉 NULL 的人**：CHECK 幫不了你，要用 `NOT NULL`。
>   寫 `CHECK (x > 0)` 以為順便擋掉了 NULL 的話，那是個安靜的洞。
> - **讀程式碼的人**：看到 `CHECK (kcal >= 0)` 很容易推論「這欄不可為空」——
>   推論是錯的。欄位可不可為空只由 `NOT NULL` 決定，CHECK 一個字都沒說。
>
> 一般化：**三值邏輯下，「沒有回報錯誤」不等於「條件成立」。**
> 這跟本專案反覆遇到的「綠燈不等於正確」是同一個形狀，只是換到了 SQL 層。

**2. EXCLUDE 實測（含兩個 bonus 情境）：**
同使用者期間重疊 → 被擋（23P01）；相鄰期間（前一段結束日 = 後一段開始日）→ 通過，
證明 `[)` 正確；不同使用者同期間 → 通過；
開放式期間（`effective_to = NULL`）不重疊 → 通過、重疊 → 被擋。

**3. `alembic check` 連續三次乾淨**，`ex_user_targets_no_overlap` 名稱原封不動
（`contype = 'x'`），再次確認命名慣例不介入 `ExcludeConstraint`。

---

## Task 3: 測試資料產生器

`tests/factories.py` 加入 `create_target`。日期用**固定值**，不要用 `date.today()`。

Commit: `test: 新增目標的測試資料產生器`

---

## Task 4: `GET` / `POST /api/targets`

`GET /api/targets` 列出我所有的期間；`GET /api/targets?date=` 回**那一天生效的**
那一筆，沒有則回 `null`（200 + `null`，不是 404 ——「沒設目標」是正常狀態）。

- [ ] **測試（約 10 個）**

建立目標；只設熱量、三大營養素留空 → 201；列出所有期間；
`?date=` 落在期間內 → 回那一筆；`?date=` 落在期間外 → `null`；
`?date=` 用**使用者時區**的日期解讀；期間重疊 → **409**（接 `IntegrityError`，
先 `rollback()`，**而且測試要在 409 之後再打一次 GET 確認 session 還能用**）；
`effective_to <= effective_from` → 422；負值 → 422；未認證 → 401。

Commit: `feat: 新增目標的建立與查詢 API`

---

## Task 5: `PATCH /api/targets/{id}`

同計畫 4a 的 `supplement_plans`：關舊期間、開新期間，**順序不能換**
（EXCLUDE 逐列立即檢查，先 INSERT 會撞到自己）。

- [ ] **測試（約 7 個）**

改目標 → 舊列數值**完全沒變**且 `effective_to` 被設；新列存在；
改別人的 → 404；生效日早於舊列的 `effective_from` → 422；
明確送 null 的處理（`label` 可為 null，四個營養素也可為 null ——
**這裡跟計畫 3 的 `PATCH /api/me` 不同，要想清楚哪些欄位「送 null」是合法的**）；
未認證 → 401。

> **最重要的斷言是「舊列的數值沒變」。** 直接改舊列的實作會通過
> 「改完之後查得到新值」這種測試，但它摧毀了 `/stats/range` 賴以計算
> 歷史達成率的基礎。

Commit: `feat: 修改目標改為關閉舊期間並開新期間`

---

## Task 6: `app/stats.py` —— 彙總的核心

**Files:** `app/stats.py`、`tests/test_stats_core.py`

把「一段期間內、按使用者當地日期分桶的食物與補劑攝取」抽成可獨立測試的函式，
路由層只負責組裝回應。

- [ ] **測試（約 10 個）**

食物的換算正確（`kcal × quantity_g / 100`，重用 `app/nutrition.py`）；
補劑**不再乘一次**（快照已是總量）；兩者相加；
空區間回空；跨日的資料正確分到各自的當地日期；
**`AT TIME ZONE` 與 `day_bounds()` 一致性測試**（見陷阱 2）；
只算自己的資料。

- [ ] **實作**

一次查詢分桶，不要每天一次查詢：

```sql
SELECT (m.eaten_at AT TIME ZONE :tz)::date AS local_day, ...
```

> **一致性測試怎麼寫：** 取一組跨 DST 的 UTC 時刻，對每一個，
> 比較「SQL 算出的 `local_day`」與「Python `day_bounds()` 判定它落在哪一天」。
> 寫計畫時已實測 90 個時刻 0 個不一致，所以這個測試今天必然綠 ——
> **它的價值在於兩套時區資料庫哪天漂移時會變紅。**
> 在測試的 docstring 裡把這件事寫清楚，免得日後有人覺得它沒用而刪掉。

Commit: `feat: 新增統計彙總的核心邏輯`

---

## Task 7: `GET /api/stats/daily?date=`

回應形狀（決定 2）：

```json
{
  "date": "2026-09-08",
  "actual":    {"kcal": "1850.00", "protein_g": "142.00", "fat_g": "60.00", "carb_g": "180.00"},
  "target":    {"kcal": "2000.00", "protein_g": "150.00", "fat_g": null, "carb_g": null},
  "ratio":     {"kcal": "0.93",    "protein_g": "0.95",   "fat_g": null, "carb_g": null},
  "breakdown": {
    "food":       {"kcal": "1700.00", "protein_g": "110.00", "fat_g": "58.00", "carb_g": "178.00"},
    "supplement": {"kcal": "150.00",  "protein_g": "32.00",  "fat_g": "2.00",  "carb_g": "2.00"}
  }
}
```

- [ ] **測試（約 10 個）**

只有食物；只有補劑；兩者都有 → `actual` = 兩者相加，且 `breakdown` 分項相加等於 `actual`；
沒設目標 → `target` 與 `ratio` 都是 `null`；
只設熱量目標 → `ratio.kcal` 有值、其餘三個是 `null`（陷阱 3）；
目標某欄是 0 → **不能除以 0**，要有明確行為（建議該欄 `ratio` 回 `null`，並在測試裡釘住）；
不給 `date` → 預設使用者時區的今天；別人的資料不算進來；未認證 → 401。

Commit: `feat: 新增每日統計的 API`

---

## Task 8: `GET /api/stats/range?from=&to=`

回「每日趨勢 + 期間達成情況 + 補劑依從率」。

- [ ] **測試（約 12 個）**

每日趨勢含**沒有資料的日子**（回 0，不是略過 —— 畫圖要連續）；
天數上限 366，超過 → 422（決定 4）；`to < from` → 422；
依從率的分子分母正確（決定 3）；
**同一天同一計畫吃兩次，依從率不會超過 100%**；
臨時打卡不計入依從率分子，但計入營養素總攝取；
沒有任何計畫時依從率回 `null`；
期間跨越目標變更時，每一天各自對應**當天生效的**目標
（這是決定 1 與規格決策 5 的實證 —— 拿掉有效期間制的話這個測試會壞）；
只算自己的資料；未認證 → 401。

> **「期間跨越目標變更」是本 task 最重要的測試。** 它證明的是
> 「三月的達成率用三月的標準算」，而那正是整個有效期間制存在的理由。
> 沒有它，一個「永遠用最新目標」的實作會通過其他所有測試。

Commit: `feat: 新增期間統計的 API`

#### Task 8 實測發現

**1. 兩個核心突變都被抓到，各自恰好一個承重測試：**

| 突變 | 失敗的測試 |
|---|---|
| 每天都用最新的目標（拿掉有效期間對應） | `test_each_day_uses_the_target_in_effect_on_that_day` + 一個 |
| 分子改數「打卡筆數」而非「配對數」 | `test_taking_a_dose_twice_in_one_day_does_not_exceed_full_adherence` |

**2. 一個存活的突變，但它揭露的是「那一行不承重」而不是「規則沒被釘住」。**

拿掉查詢裡的 `SupplementIntake.plan_id.is_not(None)` —— **16 個測試全過**。

原因：配對比對是拿**真實的 plan id** 去查 `taken_pairs`，
而臨時打卡的 `plan_id` 是 `NULL`，永遠對不上任何計畫。
**規則是由配對結構本身保證的，那行 SQL 過濾只是少撈幾列 + 表達意圖。**

改成真的會破壞規則的突變（讓 `(None, day)` 可以充當任何計畫的打卡）之後，
`test_an_ad_hoc_intake_does_not_count_toward_adherence` **恰好失敗** ——
所以規則確實有被釘住。

> **這是一個值得分清楚的區別：**
> 一個測試可以正確地釘住某個**行為**，而看起來在實作該行為的某**一行程式碼**
> 其實是冗餘的。突變那一行不會變紅，但那不代表測試沒用 ——
> 它代表**你挑錯了突變點**。
>
> 判斷方法：突變存活時，先問「這一行真的是唯一實現該保證的地方嗎」，
> 再問「測試是不是不夠力」。本專案先前的經驗多半是後者
> （計畫 3 Task 17 的兩個過濾器互相掩護），這次是前者。
> 兩者的修法完全不同：前者要改測試，後者只要記錄下來。

**3. 依從率的分子結構上就 `<= 分母`。**
分子只計入「計畫當天真的生效」的配對，所以對著一筆當天沒生效的計畫打卡
（資料上做得到）不會讓分子超過分母 —— 這是結構保證，不是事後夾住。

---

## Task 9: 跨端點的日界線一致性

**Files:** `tests/test_day_boundary_consistency.py`

見陷阱 1。這個 task 不新增任何程式碼，只新增測試。

- [ ] **測試（約 5 個）**

佈置一筆**恰好落在當地午夜**的餐點與一筆恰好落在當地午夜的打卡，然後：

- `GET /api/meals?date=D` 與 `GET /api/stats/daily?date=D` 對那筆餐點的歸屬相同
- `GET /api/supplements/today` 與 `GET /api/stats/daily?date=<今天>` 對那筆打卡的歸屬相同
- 三者對隔天 `D+1` 的判斷也相同
- 換一個 DST 切換日的時區重跑一次（`America/New_York` 2026-03-08）
- 換一個當地午夜不存在的時區（`America/Havana` 2026-03-08，計畫 3 實測確認）

> **突變要求：** 把 `/stats/daily` 改成用 UTC 日期而非使用者時區，
> 確認這組測試變紅。若沒有變紅，代表測試資料的時刻選錯了 ——
> **重疊區間就是零鑑別力的區間**（計畫 4a Task 10 的結論）：
> 東 +N 的時區只有當地 `00:00` 到 `N:00` 有鑑別力。

Commit: `test: 釘住三個端點對日界線的判斷一致`

#### Task 9 實測發現：我自己踩了自己記錄的規則

第一版對三個時區**一律用「當地午夜」**當測試資料。跑「/stats/daily 改用 UTC」
的突變時，**只有台北那個案例變紅**，New York 與 Havana 完全沒反應：

```
台北 2026-09-08 當地 00:00 = 前一天 16:00 UTC   <- 不同 UTC 日，有鑑別力
NY   2026-03-08 當地 00:00 = 同一天 05:00 UTC   <- 同一個 UTC 日，零鑑別力
```

兩者都是 UTC **以西**的時區，當地午夜換算成 UTC 是同一天早上 ——
**正好落在計畫 4a Task 10 記錄的那個零鑑別力重疊區間裡。**

根因是把兩件不同的事壓在同一組資料上：

| 要測什麼 | 需要的時刻 |
|---|---|
| 半開區間的邊界歸屬 | 當地午夜（任何時區都適用） |
| 用誰的時區 | 落在鑑別帶裡的時刻（東西方向相反） |

拆開之後加了 `discriminating_instant(day, tz_name)`：東邊取當地午夜後 30 分、
西邊取隔天午夜前 30 分，**並在 helper 內部直接斷言挑出來的時刻換算 UTC 後
確實是不同日期** —— 讓「挑錯時刻」下次會當場失敗，而不是靜默通過。
修正後兩個突變都讓三個時區全部變紅。

> **這件事的意義：** 這條規則是我自己在計畫 4a 寫下來的，
> 而且在本計畫的 Task 9 說明裡又重述了一次 —— 然後我還是踩了。
> **知道一條規則，跟在具體情境裡認出它適用，是兩種不同的能力。**
> 唯一真正抓到它的東西是突變測試，不是規則本身。
>
> 補救方式也值得記：與其在文件裡再寫一次警告，不如**把檢查寫進 helper**，
> 讓錯誤的資料選擇在執行時就爆掉。文件擋不住重蹈覆轍，程式碼可以。

---

## Task 10: 跨使用者隔離掃描 + 突變測試

六個新端點各加一行。突變點：

| # | 目標 |
|---|---|
| M1 | `GET /api/targets` 的 `user_id` 過濾 |
| M2 | `PATCH /api/targets/{id}` 的擁有權檢查 |
| M3 | `/stats/daily` 食物查詢的 `user_id` 過濾 |
| M4 | `/stats/daily` 補劑查詢的 `user_id` 過濾 |
| M5 | `/stats/range` 的 `user_id` 過濾 |
| M6 | 依從率查詢的 `user_id` 過濾 |
| M7 | `?date=` 生效目標查詢的 `user_id` 過濾 |

**選測試資料時避開「兩個過濾器互相掩護」**（計畫 3 Task 17、計畫 4a Task 11
都踩到過）：要測「統計的 `user_id` 過濾」，就必須用**全域食物與全域補劑** ——
用私人的話可見性過濾會先擋住，`user_id` 過濾拿掉也不會有測試變紅。

**任何突變存活都要大聲回報。** 事後補測試填矩陣的話，要明講那是看到存活之後補的。

Commit: `test: 目標與統計端點加入跨使用者隔離掃描`

---

## 完成驗收

- [x] `alembic downgrade 0005` 後再 `alembic upgrade head`（對 `wallet_test`）
- [x] `alembic check` **連續三次**乾淨
- [x] `pytest -v -W error` → **424 passed**（門檻 375）
- [x] `ruff check .`、`mypy app` 無錯誤
- [x] `pytest --cov=app --cov-fail-under=80` → **98.40%**
- [x] OpenAPI 列出 **42 個操作**（37 + 5）

      > 計畫原本估 43（37 + 6），把 `GET /api/targets?date=` 當成獨立端點算了。
      > 它跟 `GET /api/targets` 是**同一個路徑**、差在有沒有帶查詢參數，
      > OpenAPI 算一個操作。規格第 7.6 節分兩行寫是為了描述兩種用法，
      > 不是兩個端點。

- [x] `pg_constraint` 裡 `user_targets` 共 **8 個約束、0 個違規**，
      EXCLUDE 名稱是 `ex_user_targets_no_overlap`（`contype = 'x'`），
      前綴確認是手寫的
- [x] **EXCLUDE 實測**：重疊期間被擋（23P01）；相鄰期間、不同使用者、
      開放式期間不重疊都正常通過
- [x] Task 9 的一致性測試在「改用 UTC 日期」的突變下變紅 ——
      而且**三個時區全部變紅**（第一版只有台北會紅，見 Task 9 的實測發現）
- [x] Task 10 的六個突變全部被抓到，**無一存活**

      > 計畫列了七個突變點，實際上 M3（`/stats/daily` 的食物過濾）與
      > M5（`/stats/range` 的過濾）是**同一段程式碼**（`bucket_daily_macros`），
      > 所以是六個獨立的突變點，不是七個。兩個端點各自有測試抓到它。
- [ ] **手動走一次**：對 dev 資料庫的示範帳號設一個目標，
      查 `/stats/daily`，確認食物與補劑都算進去且與 `/api/meals?date=` 對得起來

---

## 這份計畫刻意不做的事

- **達標與否的布林判斷**（決定 2）。
- **週／月彙總端點。** `/stats/range` 回每日趨勢，前端自己聚合。
  真的需要伺服器端聚合，等量到慢再說。
- **快取表或物化檢視**（規格第 6.6 節：P1 用查詢 + 索引解決）。
- **目標範本**（「減脂期」「增肌期」預設值）。`label` 欄位已經留著。
- **匯出 CSV / 報表**。P3 之後的事。

---

## 下一步

**P1 到此結束。** 接著依規格第 2 節進入：

- **P2**：AI 分析（照片 → 辨識 → 查庫 → 估算 → **驗證層** → 落庫）。
  規格第 11 節說驗證層「是這個作品集最有價值的部分」——
  展示「我知道 LLM 會胡說，所以我設計了驗證層」。
  `food_revisions` 的 `source` / `ai_confidence` / `ai_raw_response`
  三個欄位在計畫 2 就已建好，資料模型相容。
- **P3**：前端。
- **P4**：部署到 NAS。計畫 1 與計畫 3 已累積數條部署議題，
  包含密鑰不能有預設值（否則 production 會靜默跑在開發密鑰上）、
  `extra="ignore"` 會吞掉拼錯的環境變數、缺 `restart:` 政策、
  缺 healthcheck（容器會在應用程式崩潰迴圈時仍顯示 `Up`）、
  以及**依賴變更必須重建映像**（計畫 3 收尾時真的發生過）。
