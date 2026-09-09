# P1 計畫 4a：補劑（主檔 + 固定清單 + 打卡）

規格：`docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md`
前置：計畫 1、2、3 皆已合併進 master。

起點：254 個測試、28 個端點、覆蓋率 97.64%。

原本的「計畫 4」拆成兩份：**4a 補劑**（本文件）、**4b 目標與統計**。
拆的理由是 4b 的統計需要 4a 實際落地的資料來驗證，而不是邊寫邊猜；
另外一份 26～30 個 task 的計畫，前面 task 的錯要很久才會在後面被發現。

---

## 這份計畫從前三個計畫繼承的規矩

1. **權限失敗一律回 404，不回 403**，連 body 都要逐字相同。角色不足（非管理員）
   才是 403 —— 那不是在隱藏誰的資料，是在說「你沒有這個角色」。
2. **路徑參數一律用 `ResourceId`**（超過 int64 會讓 asyncpg 拋 `DataError` 變 500）。
3. **捕捉 `commit()` / `flush()` 例外前必須 `await db.rollback()`**；
   而 `rollback()` 會讓 identity map 裡所有物件過期，包含測試抓著的那些。
4. **索引與約束全部宣告在 model 的 `__table_args__` 裡。** model 是唯一事實來源。
5. **`CheckConstraint(name=)` 給的是命名慣例的輸入**，不是最終名稱。
6. **`Enum(..., native_enum=False)` 一律搭配 `create_constraint=False`，
   然後在 `__table_args__` 自己宣告一個普通的 `CheckConstraint`。**
   `create_constraint=True` 會讓 `alembic check` **永久報漂移**（計畫 3 Task 5 實測）。

   > **這條規矩有兩半，而漏掉第二半不會有任何徵狀 —— Task 1 實測踩到了。**
   > 只寫 `create_constraint=False` 而忘了自己宣告 `CheckConstraint`，
   > 結果不是「約束變弱」，是**完全沒有約束**：欄位變成一個誰都塞得進去的
   > `varchar(N)`。`alembic check` 乾淨、測試全綠、mypy 與 ruff 都過 ——
   > 沒有任何一個關卡會提醒你。
   >
   > **寫成一句話記：關掉自動產生的那一刻，就欠了一個手寫的約束。**
   > 驗證方式只有一個：migration 套用後真的去查 `pg_constraint`。
7. **主鍵用 `Identity(always=True)`**，不用 `serial`。
8. **綠燈在被觀察到失敗之前不算證據。** 計畫 3 累積了六種不同的「綠燈說謊」機制，
   本計畫每一個守衛都要突變過才能宣稱有覆蓋。

---

## 執行前提

**本計畫不需要新增依賴。** `btree_gist` 在計畫 1 的 migration 0001 就已建立
（當時就註明「`user_targets` 的 EXCLUDE 期間不重疊約束（計畫 4 會用到）」），
實測確認 `citext` / `btree_gist` / `pg_trgm` 三個 extension 都在。

其餘執行限制與前三個計畫相同。

---

## 檔案結構

```
app/
  models/supplement.py            ← 新增
  schemas/supplement.py           ← 新增
  api/routes/supplements.py       ← 新增
  api/routes/supplement_plans.py  ← 新增
  supplement_visibility.py        ← 新增（比照 food_visibility.py）
migrations/versions/
  0005_*.py                       ← supplements / supplement_plans / supplement_intakes
tests/
  test_supplements.py             ← 新增
  test_supplement_plans.py        ← 新增
  test_supplement_intakes.py      ← 新增
  test_supplements_today.py       ← 新增
  test_cross_user_isolation.py    ← 改
  factories.py                    ← 改
```

---

## 本計畫確立的三個決定

### 決定 1：`dose` 是「幾份」，不是「幾公克」

規格的 DDL 有 `serving_unit`（'capsule' / 'g' / 'ml' / 'IU'）、`serving_size`，
以及四個營養素欄位，但**沒有說 `dose` 的單位是什麼**。這是會造成靜默數值錯誤的
那種歧義，必須先釘死。

**營養素是「每一份」的量；`dose` 是份數的倍數。**

```
kcal_total = supplement.kcal * dose
```

`serving_size` 與 `serving_unit` **純粹用於顯示**（「1 份 = 30 g」），
不參與任何計算。這對應補劑罐子上的標示方式：
「Serving size: 1 scoop (30 g)，每份 120 kcal」，吃兩匙就是 `dose = 2`。

> 這跟計畫 3 的 `quantity_g` 是**相反**的取捨，而且是刻意的。
> 食物的份量（「1 碗」）需要正規化成克數，因為同一個食物有很多種份量單位、
> 而營養素是以每 100g 為基準。補劑的「份」本身就是標籤上的基準單位，
> 沒有第二種單位需要換算，多做一次正規化只會多一個出錯的地方。

### 決定 2：`supplement_plans` 也要 EXCLUDE 不重疊約束（規格的缺口）

規格第 6.5 節替 `user_targets` 加了 EXCLUDE 約束，第 6.4 節的
`supplement_plans` **沒有**，儘管決策 6 明說它「同樣採用有效期間制
（決策 5 的第二次應用）」。

**這是規格的疏漏，不是刻意的差別。** 少了它，同一個補劑、同一個時段可以有
兩筆期間重疊的計畫，於是：

- 「今日待打卡」清單會出現兩筆一模一樣的項目
- **4b 的依從率會把「應該吃的次數」算成兩倍** —— 而且分母變大只會讓
  依從率變低，數字仍然「看起來合理」，不會有任何東西報錯

所以本計畫補上：

```sql
ALTER TABLE supplement_plans ADD CONSTRAINT no_overlapping_plans
  EXCLUDE USING gist (
    user_id WITH =,
    supplement_id WITH =,
    time_of_day WITH =,
    daterange(effective_from, effective_to, '[)') WITH &&
  );
```

鍵是 `(user_id, supplement_id, time_of_day)` 三欄 —— 同一個補劑在早上和睡前
各吃一次是完全合理的，那是兩筆不同的計畫，不該被擋。

> 這是決策 4 的觀念第三次應用：**能讓資料庫擋的就別靠程式檢查。**
> 程式檢查會漏（忘記寫、只寫在一個 handler 裡、併發下失效），
> 約束不會。

### 決定 3：補劑不做版本化，用快照 —— 而且快照存「這次吃的總量」

規格決策 6 已經決定補劑用快照而非版本化，理由是補劑數值印在罐子標籤上、
是固定事實，不需要協作修正。本計畫要補的是**快照存什麼**：

`supplement_intakes` 的四個營養素欄位存的是**這一次攝取的總量**
（已經乘過 `dose`），不是每份的量。

理由是 4b 的統計因此變成單純的 `SUM`，不需要在統計查詢裡再乘一次 ——
而「統計時忘記乘」正是那種算出來的數字看起來合理、不會報錯的錯誤。

---

## 三個必須在動手前講清楚的陷阱

### 陷阱 1：這是「凍結歷史」第三次出現，形狀一樣、機制不同

| 出處 | 會變動的東西 | 凍結手段 |
|---|---|---|
| 計畫 2 | 全域食物被協作編輯 | `food_revisions` + `current_revision_id` 指標 |
| 計畫 3 | 份量「1 碗 = 200g」被改 | 寫入當下算好 `meal_items.quantity_g` |
| **本計畫** | 補劑主檔的營養素被改 | 寫入當下算好 `supplement_intakes` 的四個欄位 |

**認出「這又是同一類問題」比記住個別解法更重要**（規格決策 5 的原話）。
每一次的凍結測試也是同一個形狀：**寫入 → 改來源 → 重讀 → 數值必須不動。**

P1 目前沒有編輯補劑的端點（規格第 7.5 節只有 GET 與 POST），
所以這個測試要**直接改資料庫的補劑列**，不是走 API —— 跟計畫 3 測份量那個一樣。

### 陷阱 2：「今天」有兩種比較方式，必須一致

`GET /api/supplements/today` 要把「計畫」與「實際」對起來，但兩者的時間型別不同：

| | 型別 | 怎麼判斷「今天」 |
|---|---|---|
| `supplement_plans.effective_from/to` | `date` | 跟使用者當地的今天比 |
| `supplement_intakes.taken_at` | `timestamptz` | 落在 `day_bounds()` 的半開區間內 |

**兩邊都必須用同一個「使用者當地的今天」。** 用 UTC 日期判斷計畫、
用當地區間判斷打卡的話，台灣時間早上 8 點以前（UTC 還在前一天）
兩者會對到不同的日子 —— 清單顯示的是昨天的計畫、今天的打卡。

計畫 3 已經有 `app/days.py` 的 `day_bounds()` 與 `today_in_timezone()`，
**兩個都用它們，不要自己算。**

> 測試要挑對時區與時刻才有鑑別力（計畫 3 Task 9 的教訓）：
> **UTC 以東的時區只有清晨有鑑別力，以西的只有深夜有鑑別力。**

### 陷阱 3：修改計畫是「關舊期間、開新期間」，順序反了會撞到約束

規格第 7.5 節寫 `PATCH /api/supplement-plans/{id}` 是「修改（關閉舊期間、開新期間）」
—— 它**不修改那一列的數值**。這正是有效期間制的意義：歷史不動。

```
1. UPDATE 舊列 SET effective_to = <生效日>
2. INSERT 新列 FROM <生效日> 起
```

**這兩步的順序不能換。** EXCLUDE 約束預設是逐列立即檢查的，
先 INSERT 的話新舊兩列會重疊，直接違反約束。同一個交易裡先 UPDATE，
後面 INSERT 的檢查就看得到已經關閉的舊期間。

> 這又是一個「順序即需求」的地方。計畫 3 Task 16 的教訓：
> **端狀態測試在定義上抓不到順序錯誤** —— 兩種順序成功時的最終狀態一樣。
> 這裡不同的是順序錯了會直接失敗（約束擋下），所以一個「PATCH 要成功」的
> 測試就夠了。但要在計畫裡寫明**為什麼**它會成功，否則日後有人「整理」
> 成先 INSERT 會很困惑。

---

## Task 1: `supplements` / `supplement_plans` / `supplement_intakes` 的 model

**Files:** `app/models/supplement.py`、`app/models/__init__.py`（改）

- [ ] **Step 1: 寫 model**

三張表，欄位照規格第 6.4 節。要特別注意的：

```python
class TimeOfDay(enum.StrEnum):
    MORNING = "morning"
    NOON = "noon"
    EVENING = "evening"
    BEDTIME = "bedtime"
    PREWORKOUT = "preworkout"
    POSTWORKOUT = "postworkout"
```

`time_of_day` 用 `Enum(TimeOfDay, native_enum=False, create_constraint=False)`
**加上自己宣告的 `CheckConstraint`** —— 見繼承規矩第 6 條。

`supplements` 的唯一約束比照 `foods`：

```python
UniqueConstraint("owner_id", "name", "brand",
                 name="uq_supplements_owner_id_name_brand",
                 postgresql_nulls_not_distinct=True)
```

`supplement_plans` 的 EXCLUDE 約束（決定 2）：

**以下這段寫法已經實測過**（DDL 編譯 + 真的建表 + 六種情境的語意驗證），
照抄即可：

```python
from sqlalchemy import text
from sqlalchemy.dialects.postgresql import ExcludeConstraint

ExcludeConstraint(
    ("user_id", "="),
    ("supplement_id", "="),
    ("time_of_day", "="),
    (text("daterange(effective_from, effective_to, '[)')"), "&&"),
    name="ex_supplement_plans_no_overlap",
    using="gist",
)
```

三個實測要點：

**(a) 欄位用字串名、運算式用 `text()`。** 這個組合產出的 DDL 完全正確：

```sql
CONSTRAINT ex_supplement_plans_no_overlap EXCLUDE USING gist (
  user_id WITH =, supplement_id WITH =, time_of_day WITH =,
  daterange(effective_from, effective_to, '[)') WITH &&)
```

**(b) 命名慣例不會替 `ExcludeConstraint` 加前綴。** 實測 `name=` 給什麼、
最終名稱就是什麼（不像 `CheckConstraint` 會被包成 `ck_<表>_<名>`）。
所以**前綴要自己寫進名字裡** —— 用 `ex_supplement_plans_no_overlap`，
不要只寫 `no_overlapping_plans`，否則完成驗收的命名檢查會抓到它。

**(c) 語意實測 6/6 符合預期**（對 `wallet_test` 建表、逐筆用 savepoint 隔離、
最後 rollback）：

| 情境 | 結果 |
|---|---|
| 基準：早上，01-01 ~ 06-01 | 插入成功 |
| 同補劑**同時段**、期間重疊 | **被擋（sqlstate 23P01）** |
| 同補劑**不同時段**、期間重疊 | 插入成功 ← 不能誤擋 |
| 同補劑同時段、**相鄰不重疊**（06-01 接 06-01） | 插入成功 ← `[)` 半開區間正確 |
| 不同補劑、同時段、期間重疊 | 插入成功 |
| 不同使用者、其餘全同 | 插入成功 |

> **實測時我自己踩到的兩個坑，記下來免得重蹈：**
>
> 1. 第一版實驗沒用 savepoint，第 2 筆違反約束之後整個交易進入 aborted，
>    第 3 筆撞到的是 `InFailedSQLTransactionError` 而不是約束 ——
>    看起來像「不同時段也被誤擋」，其實是實驗寫錯。
>    **測「哪些會被擋」時，每一筆都要用自己的 savepoint 隔離。**
> 2. asyncpg 的參數編碼在 client 端就依推斷型別做掉了，
>    日期要傳真的 `datetime.date` 物件，寫 `$4::date` 搭配字串**沒有用**
>    （`DataError: 'str' object has no attribute 'toordinal'`）。
>
> **仍待你驗證的一件事：** 上面只證明了「約束建得起來、語意正確」，
> **沒有**證明 `alembic check` 能對它乾淨比對。
> 那正是計畫 3 `create_constraint=True` 踩到的形狀（建得起來，但 autogenerate
> 永遠說它漂移）。Task 2 的連續三次 `alembic check` 就是在驗這件事 ——
> **若它報漂移，停下來回報，不要硬湊。**

索引（規格第 6.6 節）：

```python
Index("ix_supplement_intakes_user_id_taken_at", "user_id", "taken_at")
Index("ix_supplement_plans_user_id_effective", "user_id", "effective_from", "effective_to")
```

> 索引用 ASC 不用 DESC，理由同計畫 3 Task 4：`user_id` 是等值條件、
> 時間是唯一的排序欄位，PostgreSQL 反向掃描 ASC 索引效果相同，
> 而且避開 autogenerate 對帶方向索引的比對不確定性。

- [ ] **Step 2: 驗收**

此時沒有 migration，`alembic check` **會報漂移，這是預期的紅燈**，
conftest 會因此讓所有測試 error。**只跑 `ruff` 與 `mypy app`**，然後 commit。

Commit: `feat: 新增補劑相關的三個 model`

---

## Task 2: migration 0005

**Files:** `migrations/versions/0005_*.py`

- [ ] **Step 1: autogenerate、逐行審查**

要確認：三張表都用 `Identity(always=True)`；所有 CHECK 都在且名稱是
`ck_<表名>_<你給的名字>`；EXCLUDE 約束在且形式正確；兩個索引在。

- [ ] **Step 2: 對 `wallet_test` 往返**

```
export DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test"
alembic upgrade head && alembic downgrade 0004 && alembic upgrade head && alembic check
```

**絕對不要對 dev 資料庫 `wallet` 跑這些**（它現在有真實的示範資料，
含 4 個使用者、3 個食物、2 餐與一張照片）。

- [ ] **Step 3: 實測 EXCLUDE 約束真的會擋**

用原始 SQL（asyncpg，交易最後 rollback）直接插入兩筆
「同使用者、同補劑、同時段、期間重疊」的計畫，**確認第二筆被 PostgreSQL 擋下**，
並回報實際的錯誤訊息與 sqlstate。

再插一組「同補劑但不同時段」的重疊計畫，**確認可以成功** ——
早上一顆、睡前一顆是合理的，不能被誤擋。

> 這一步是決定 2 的實證。跟計畫 2 驗 `ck_food_revisions_rejected_needs_reason`
> 一樣：Pydantic 與資料庫約束守的是不同的東西，
> 前者只擋 API 這條路，後者擋所有寫入者。

- [ ] **Step 4: 回報約束名稱與型別**

查 `pg_constraint` 與 `information_schema.columns`，
回報三張表所有約束是否符合命名慣例，以及 `time_of_day` 的真實型別。

> 查 `pg_constraint.contype` 記得加 `::text` —— asyncpg 回傳的是 bytes
> （`b'c'` 而非 `'c'`），比對會全部落空。計畫 2 的驗收腳本就是這樣
> 把 20 個完全正確的名稱誤判成全部違規。

- [ ] **Step 5: 驗收 + commit**

`pytest -W error` 恢復 254 全綠。Commit: `feat: 新增補劑相關的 migration`

#### Task 1 / 2 實測發現

**1. `alembic check` 對 `ExcludeConstraint` 比對乾淨（連續三次）。**
這是本批唯一的真未知數，結論是好的：計畫 3 那個
`Enum(create_constraint=True)` 的永久漂移沒有重演。
EXCLUDE 可以正常宣告在 model 的 `__table_args__` 裡，
不需要 `op.execute()` 也不需要 `include_object` 例外。

**2. EXCLUDE 的名稱原封不動，`ex_` 前綴確認是手寫的。**
實際名稱 `ex_supplement_plans_no_overlap`，`contype = 'x'`。
`app/models/base.py` 的 `NAMING_CONVENTION` 沒有 `"ex"` 這個 key，
所以慣例完全不介入 —— 跟 `CheckConstraint` 會被包成 `ck_<表>_<名>` 相反。

**3. `time_of_day` 有兩個守衛，錯誤碼不同（實測 5/5）。**

| 輸入 | 被誰擋 | sqlstate |
|---|---|---|
| `'morning'` / `'postworkout'` | 通過 | — |
| `'brunch'`（無效，6 字元） | **CHECK 約束** | `23514` |
| `''`（空字串） | **CHECK 約束** | `23514` |
| `'midnight_snack'`（無效，14 字元） | **varchar(11) 長度限制** | `22001` |

`native_enum=False` 產生的是 `varchar(N)`，N 等於最長標籤的長度
（這裡是 11 = `postworkout`）。**比最長標籤還長的無效值會先撞上長度限制，
根本走不到 CHECK。**

> 這對測試設計有實際影響：**想驗證 CHECK 有效，就要挑一個「無效但夠短」的值。**
> 我第一次驗的時候用了 `midnight_snack`，看到它被擋就以為 CHECK 在運作 ——
> 其實擋它的是長度限制，CHECK 有沒有寫都一樣。
> 這又是「測試通過了，但驗證到的是別的東西」的一個實例。
>
> 對應用程式也有影響：若 handler 只接 `CheckViolationError` 想轉成 422，
> 過長的值會以 `StringDataRightTruncationError` 逃逸。
> 實務上 Pydantic 會先擋掉，但這是第二層防護的已知缺口。

**4. `postgresql_nulls_not_distinct=True` 這次直接寫在 `op.create_table` 裡就成功了**，
不需要 migration 0002 對 `foods` 用的那個原始 SQL 迂迴。
0002 那個 workaround 可能已經不必要（或是版本差異）——
**記下來，下次動到 0002 時順手確認**，現在不動它。

---

## Task 3: 測試資料產生器

**Files:** `tests/factories.py`（改）

加入 `create_supplement`、`create_plan`、`create_intake`，
沿用既有的 `itertools.count` 風格。

`taken_at` / `effective_from` 一律用**固定值**，不要用 `datetime.now()` 或
`date.today()` —— 依賴日界線的測試會因此在某些時段隨機失敗，
而且失敗看起來像 flaky 不像 bug，很難查（計畫 3 Task 6 的教訓）。

Commit: `test: 新增補劑的測試資料產生器`

---

## Task 4: `GET /api/supplements` 與 `POST /api/supplements`

**Files:** `app/schemas/supplement.py`、`app/supplement_visibility.py`、
`app/api/routes/supplements.py`、`tests/test_supplements.py`

分層可見性與食物完全相同：`owner_id IS NULL` 是全域，否則是私人。
**把可見性邏輯寫成 `app/supplement_visibility.py`**，比照 `app/food_visibility.py` ——
不要塞在路由檔裡，第二個呼叫者（Task 5、8）馬上就會出現。

- [ ] **Step 1: 測試（約 10 個）**

建立私人補劑；搜尋看得到全域與自己的；**看不到別人的私人補劑**；
`scope=global` / `scope=mine` 過濾；同名同品牌重複建立 → 409；
`serving_size <= 0` → 422；營養素為負 → 422；未認證 → 401；
營養素預設為 0（魚油那種只記錄「吃了沒」的情況）。

- [ ] **Step 2: 實作 + 驗收 + commit**

Commit: `feat: 新增補劑主檔的 API`

---

## Task 5: `GET` / `POST /api/supplement-plans`

**Files:** `app/api/routes/supplement_plans.py`、`tests/test_supplement_plans.py`

- [ ] **Step 1: 測試（約 8 個）**

建立計畫；列出自己的計畫；**列不到別人的**；引用看不到的補劑 → 404；
`effective_to <= effective_from` → 422；
**同補劑同時段期間重疊 → 409**（不是 500，要接 `IntegrityError`）；
同補劑不同時段重疊 → 201（合理，不能誤擋）；未認證 → 401。

> 重疊那兩個測試是決定 2 的 API 層實證。**接 `IntegrityError` 之前
> 必須先 `await db.rollback()`**（繼承規矩第 3 條）。

- [ ] **Step 2: 實作 + 驗收 + commit**

Commit: `feat: 新增補劑固定清單的建立與查詢 API`

#### Task 5 實測發現

**1. 繼承規矩第 3 條（`rollback()`）從計畫 1 帶到現在，一直沒有被任何測試驗證過。**

只拿掉 `await db.rollback()` 那一行（保留 `except IntegrityError` 與 409），
**274 個測試全部照樣通過**。

原因不是覆蓋不足，是**測試形狀的盲點**：驗證錯誤路徑的測試在拿到 409 之後就
結束了，沒有人在**同一個 session** 上再做一次資料庫操作 ——
而那正是缺少 rollback 唯一會顯現的地方（`PendingRollbackError`）。

補法是在那個測試的 409 之後再打一次 `GET /api/supplement-plans`，
斷言 200 且確實只有 1 筆。實測確認：拿掉 rollback → 恰好 1 個測試失敗。

> **這是第七種「綠燈說謊」的機制，形狀跟前六種都不同：**
> 前六種是「斷言本身沒有鑑別力」，這一種是**斷言正確、但停在錯誤發生的那一刻**。
> 清理動作（rollback、關檔、釋放鎖）的缺失，**在定義上只會在「之後」顯現**。
>
> 通則：**測試一個清理動作，就必須在它之後再做一件需要乾淨狀態的事。**
> 只斷言「錯誤有被正確回報」，證明不了「錯誤之後系統還能用」。
>
> 這一條值得回頭套用到既有的每一個 `except IntegrityError`（計畫 2 的
> `propose_revision`、計畫 3 的相關路徑）—— 它們今天可能也是未驗證的。
> 記在這裡，Task 11 的隔離掃描時一併處理。

**2. EXCLUDE 少一欄的突變，正好被那個「不該誤擋」的測試抓到。**
把 `time_of_day` 從 EXCLUDE 的鍵拿掉（model 與 migration 同步改，
維持 `alembic check` 乾淨以確保訊號來自資料庫層），
**恰好** `test_create_plan_allows_overlapping_plan_for_a_different_time_of_day` 失敗。

「同時段重疊要擋」那個測試**維持綠燈** —— 因為三欄鍵仍然擋得住同時段重疊，
它只是變得過度寬泛。**只寫「該擋的有擋」那一半，抓不到鍵取太少的錯。**

**3. `dose` 是「份數」這件事，今天只存在於註解裡。**
`CheckConstraint("dose > 0")` 與 Pydantic 的 `Field(gt=0)` 只保證正數，
沒有任何東西表達「這是份數的倍數，不是公克」。
真正的 `kcal * dose` 計算在 Task 8 才出現 —— **決定 1 要到那時才會被程式碼落實。**

**4. `serving_size <= 0` 與負營養素是被 Pydantic 擋的，不是資料庫 CHECK。**
422 發生在碰到資料庫之前。CHECK 約束仍然存在且已在 Task 2 用原始 SQL 驗過，
但**這些 API 層的測試沒有碰到它** —— 兩層守不同的東西，測試也要分開講清楚
（同計畫 2 `ck_food_revisions_rejected_needs_reason` 的結論）。

---

## Task 6: `PATCH /api/supplement-plans/{id}` —— 關舊期間、開新期間

**Files:** 同上

見陷阱 3。這個端點**不修改舊列的數值**。

- [ ] **Step 1: 測試（約 7 個）**

改劑量 → 201/200，**舊列的 `dose` 沒變**且 `effective_to` 被設成生效日；
新列存在且 `effective_from` 等於生效日；
改別人的 → 404；生效日早於舊列的 `effective_from` → 422；
生效日不帶（預設今天，用**使用者時區**的今天）；
明確送 null → 422（計畫 3 Task 3 那個哨兵陷阱）；未認證 → 401。

> **最重要的斷言是「舊列的 dose 沒變」。** 一個「直接改舊列數值」的實作
> 會讓「改了之後查得到新劑量」這種測試通過 —— 但它摧毀了歷史，
> 而 4b 的依從率要靠歷史才算得出「三月該吃幾次」。

- [ ] **Step 2: 實作 + 驗收 + commit**

Commit: `feat: 修改補劑計畫改為關閉舊期間並開新期間`

---

## Task 7: `DELETE /api/supplement-plans/{id}`

- [ ] **Step 1: 測試（約 4 個）**

刪自己的 → 204；刪別人的 → 404 **且那一筆必須還在**（要真的重查確認，
不能只看狀態碼 —— 計畫 3 Task 11 實測過「先刪除、再檢查擁有權」
的實作狀態碼一樣是 404）；刪不存在的 → 404；未認證 → 401。

**已經打卡過的計畫被刪掉時，`supplement_intakes.plan_id` 要怎麼辦？**
用 `ON DELETE SET NULL` —— 打卡紀錄是歷史，不能因為計畫被刪而消失，
但它不再屬於任何計畫（等同臨時吃的）。這跟計畫 3 的
`meal_items.portion_id` 是同一個處理。**要有測試釘住這件事。**

Commit: `feat: 新增刪除補劑計畫的 API`

---

## Task 8: `POST /api/supplement-intakes` —— 快照

**Files:** `tests/test_supplement_intakes.py`

- [ ] **Step 1: 測試（約 9 個）**

打卡一筆計畫內的（帶 `plan_id`）；臨時記錄一筆（不帶 `plan_id`）；
快照四個欄位 = 補劑每份的量 × `dose`；引用看不到的補劑 → 404；
引用別人的計畫 → 404；`plan_id` 指向的計畫不是這個補劑的 → 422；
`dose <= 0` → 422；未認證 → 401；

**凍結測試（最重要的一個）**：打卡 → **直接改資料庫**把補劑的 `kcal` 改掉 →
重讀那筆打卡，四個快照欄位必須**完全不動**。

- [ ] **Step 2: 實作 + 驗收 + commit**

Commit: `feat: 新增補劑打卡的 API`

---

## Task 9: `DELETE /api/supplement-intakes/{id}`

約 4 個測試，形狀同 Task 7（含「刪別人的之後那一筆還在」）。

Commit: `feat: 新增刪除補劑打卡的 API`

---

## Task 10: `GET /api/supplements/today` —— 計畫 vs 實際

**Files:** `tests/test_supplements_today.py`

見陷阱 2。這是本計畫最容易寫錯的端點。

回傳形狀：今天生效的每一筆計畫，各自標示「今天打卡了沒」，
外加今天有打卡但不屬於任何計畫的臨時記錄。

- [ ] **Step 1: 測試（約 9 個）**

今天生效的計畫出現在清單裡；已經過期的計畫（`effective_to` 是昨天）**不出現**；
還沒生效的（`effective_from` 是明天）**不出現**；
打卡過的標記為已完成；沒打卡的標記為未完成；
臨時記錄（`plan_id` 是 NULL）也出現在清單裡；
**看不到別人的計畫與打卡**；未認證 → 401；

**時區測試**：使用者時區設成 `America/New_York`，
在當地晚上 11:30 打卡（UTC 已經是隔天），
確認那筆打卡算在**當地的今天**而不是隔天。

> 這個時區測試要用 UTC 以西的時區才有鑑別力。
> 用台北時間的深夜寫，寫死 UTC 的實作會照樣通過（計畫 3 Task 9 實測）。

- [ ] **Step 2: 實作 + 驗收 + commit**

Commit: `feat: 新增今日補劑待打卡清單的 API`

#### Task 8 / 10 實測發現

**1.「UTC 以東只有清晨有鑑別力」這條規則成立 —— 但差點被一個似是而非的推翻改掉。**

Task 10 回報說：這條規則只適用於「日期相等」比較，不適用於「視窗」比較，
因為實測時**台北的測試也抓到了突變**。聽起來合理，但算過之後是錯的。

以台北 2026-09-08、突變版本是「local today 但用 UTC 算區間」為例：

```
正確視窗 (Taipei) : 09-07 16:00Z .. 09-08 16:00Z
突變視窗 (UTC)    : 09-08 00:00Z .. 09-09 00:00Z
重疊             : 09-08 00:00Z .. 09-08 16:00Z
                   = 台北當地 08:00 .. 24:00
```

落在重疊區間裡的時刻，兩種實作的判斷完全相同 —— **零鑑別力**：

| 台北當地 | 有鑑別力 |
|---|---|
| 00:00 / 04:00 / 07:00 | **是** |
| 08:00 / 12:00 / 18:00 / 23:00 | 否 |

那為什麼實測時台北測試失敗了？因為那兩個測試的 `taken_at` 寫的是
`start + timedelta(hours=1)` 和 `+2`，而 `start` 是**當地午夜** ——
所以它們其實是台北 01:00 與 02:00，**正好落在清晨那個有鑑別力的帶裡**。

**規則沒有變，是 fixture 剛好選對了時刻。**

> 這個區別很要緊：照那個推翻改寫規則的話，日後有人寫一個台北 12:00 的測試，
> 會得到一個**永遠不會失敗**的測試，而規則書上還寫著「視窗比較不受此限」。
> 一條被錯誤放寬的規則，比沒有規則更危險 —— 它會主動背書錯的做法。
>
> **精確版本：** 兩個視窗的重疊區間就是零鑑別力的區間。
> 東 +N 小時的時區，重疊區間是當地 `N:00` 到午夜，
> **所以只有當地 `00:00` 到 `N:00` 之間的時刻測得出東西**。
> 西 −N 小時則相反，只有當地 `(24−N):00` 到午夜有鑑別力。
> **判斷方法不是背規則，是把兩個視窗畫出來取重疊。**

**2. 凍結測試（第三次）確認有鑑別力。**
把回應改成從即時的補劑資料重算 → **恰好 1 個測試失敗**，而且是失敗在
「重讀資料庫那一列」的斷言，不是 POST 當下的回應斷言 ——
因為 POST 當下補劑還沒被改，回應仍然是對的。
**凍結測試要斷言的是「持久化的那個值」，不是回應的形狀。**

**3. 決定 1（`dose` 是份數）到這裡才真正變成程式碼。**
`app/nutrition.py` 的 `scale_supplement(supplement, dose)` 是唯一表達
`kcal_total = kcal * dose` 的地方。把 `dose` 從計算中拿掉 → 3 個測試失敗，
其中一個用非整數倍數（1.5×），排除「整數乘法巧合」。

**4. 半開區間與 `user_id` 過濾都有專屬測試抓到**（各 1 個），
而 `user_id` 那個刻意用**全域補劑**佈置資料，避開計畫 3 Task 17
「兩個過濾器互相掩護」的陷阱。

**5. 一個因沙箱限制未執行的驗收項目（誠實記錄）：**
`alembic downgrade 0004` 被自動模式的分類器擋下（即使指向 `wallet_test`）。
本批三個 task 沒有更動任何 migration，`alembic check` 連續三次乾淨，
所以影響為零 —— 但**完成驗收的往返項目要由主 session 補跑**。

---

## Task 11: 跨使用者隔離掃描 + 突變測試

**Files:** `tests/test_cross_user_isolation.py`（改）

九個新端點各加一行。突變點：

| # | 目標 |
|---|---|
| M1 | 補劑可見性（`supplement_visibility` 的 `owner_id` 條件） |
| M2 | `supplement_plans` 查詢的 `user_id` 過濾 |
| M3 | `supplement_intakes` 查詢的 `user_id` 過濾 |
| M4 | `PATCH` / `DELETE` 計畫的擁有權檢查 |
| M5 | `DELETE` 打卡的擁有權檢查 |
| M6 | `today` 的 `user_id` 過濾 |
| M7 | `today` 的日期範圍條件（改成不限日期） |

**選測試資料時避開「兩個過濾器互相掩護」**（計畫 3 Task 17 實測踩到）：
要測「計畫的 `user_id` 過濾」，就必須用**全域補劑** ——
用私人補劑的話，補劑可見性過濾會先擋住，`user_id` 過濾拿掉也不會有測試變紅。

**任何突變存活都要大聲回報，不要事後補一個測試把矩陣填滿就當沒事。**

Commit: `test: 補劑端點加入跨使用者隔離掃描`

#### Task 11 實測發現

**1. rollback 稽核：六個呼叫點裡有三個從來沒被驗證過。**

把 Task 5 的發現回頭套用到 `app/` 裡每一個 `except IntegrityError` →
`db.rollback()`，逐一拿掉 rollback 跑全套：

| 呼叫點 | 拿掉 rollback | 處置 |
|---|---|---|
| `foods.py` `create_food` | **存活** | 見下方第 2 點 —— 是真缺陷，不是測試問題 |
| `foods.py` `propose_revision` | 被抓到 | 既有測試就夠 |
| `foods.py` `create_portion` | **存活** | 補上後續同 session 請求 |
| `supplements.py` `create_supplement` | **存活** | 補上後續同 session 請求 |
| `supplement_plans.py` `create_plan` | 被抓到 | Task 5 建立的測試 |
| `supplement_plans.py` `update_plan` | 被抓到 | Task 6 建立的測試 |

**一條寫在計畫裡三次、被遵守了四個計畫的規矩，實際覆蓋率是 50%。**
規矩被遵守不等於規矩被驗證。

**2. 稽核逼出一個既有的真缺陷：`create_food` 併發下會回 500 不是 409。**

`create_food` 跟它的兩個 sibling（`create_supplement`、`create_portion`）
形狀不同：後兩者是 `db.add()` 直接接 `try: commit()`，中間沒有 flush，
所以 INSERT 發生在 commit 裡、`except` 接得到。

但 `create_food` 需要中間的 flush（拿 `food.id` 去建 revision、再回填指標），
而**唯一約束就是在那個 flush 檢查的** —— INSERT 在那一刻就送進資料庫了。
`try/except IntegrityError` 包的是好幾行之後的 `commit()`，
所以它註解裡宣稱要接的併發情境，對它**結構上不可達**。

實測（monkeypatch 讓前置 SELECT 謊報一次「沒有重複」，重現併發狀態）：
`IntegrityError` 未經處理逃逸。已修 —— 把第一個 flush 也包進 try，
並補上一個測試釘住。突變確認：拿掉保護 → 恰好那個測試失敗。

> **這個缺陷之所以能活這麼久，是因為它有一個「看起來有在保護」的 handler。**
> 程式碼審查會看到 `except IntegrityError` 就打勾，
> 測試會因為前置 SELECT 先擋下而永遠走不到那條路。
> **註解宣稱的意圖與程式碼實際涵蓋的範圍，是兩件要分開驗證的事。**
>
> 一般化：**`try` 區塊的邊界要對齊「例外實際會從哪裡拋出」，
> 而不是對齊「概念上哪一步在做這件事」。** ORM 特別容易搞混這兩者，
> 因為 `flush()` 與 `commit()` 在心智模型裡都是「寫入資料庫」，
> 實際送出 SQL 的時機卻不同。

**3. Task 11 自己也差點交出一個不會失敗的測試（自行抓到）。**
第一版把「別人的計畫」與「別人的臨時打卡」合成一個 `/today` 測試，
結果 M6（打卡的 `user_id` 過濾）突變**存活**，原因有兩層：
沒有 pin 住「今天」，以及那筆打卡綁著計畫 —— 而綁計畫的打卡只有在對應計畫
也出現在回應裡才會被列出，M5 完整時 Bob 的計畫清單是空的，
於是那筆洩漏的打卡根本到不了回應。
拆成兩個測試、並改用**臨時打卡**（`plan_id=None`）之後，M5 與 M6 各自獨立被抓到。

---

## 完成驗收

- [x] `alembic downgrade 0004` 後再 `alembic upgrade head`（對 `wallet_test`，
      dev 的 `wallet` 全程留在 0004 沒被動）
- [x] `alembic check` → `No new upgrade operations detected.`，**連續三次**
- [x] `pytest -v -W error` → **320 passed**（門檻 310）
- [x] `ruff check .`、`mypy app` 無錯誤
- [x] `pytest --cov=app --cov-fail-under=80` → **98.20%**
- [x] OpenAPI 列出 **37 個操作**（28 + 9），與預估一致
- [x] `pg_constraint` 裡三張新表共 **21 個約束、0 個違規**
      —— EXCLUDE 的名稱是 `ex_supplement_plans_no_overlap`，
      `contype = 'x'`，前綴確認是手寫的
- [x] **EXCLUDE 約束實測 6/6**：同時段重疊被擋（23P01）；
      不同時段重疊、相鄰不重疊、不同補劑、不同使用者都正常通過
- [x] Task 11 的七個突變全部被抓到，無一存活

**額外完成（不在原本的驗收清單裡）：**

- [x] **稽核了 `app/` 裡全部六個 `except IntegrityError` → `rollback()` 呼叫點**，
      發現三個從未被驗證，其中兩個補上測試、一個是真缺陷
- [x] **修好 `create_food` 併發下回 500 的缺陷**，並用突變確認測試抓得到

---

## 這份計畫刻意不做的事

- **目標與統計**（計畫 4b）。
- **編輯 / 刪除補劑主檔**。規格第 7.5 節只有 GET 與 POST。
  快照機制已經讓日後補上編輯功能不會破壞歷史。
- **`supplement_revisions`（補劑的協作編輯與審核）**。規格決策 6 明說
  這是刻意的不一致，日後真要做，比照 `food_revisions` 約一天成本。
- **補劑的份量換算表**（比照 `food_portions`）。補劑的「份」就是標籤單位，
  沒有第二種單位需要換算（見決定 1）。
- **提醒 / 推播**。P4 之後的事。

---

## 下一步

計畫 4b：`user_targets`（含 EXCLUDE 不重疊約束）、`GET /api/targets`、
`POST /api/targets`、`PATCH /api/targets/{id}`、
`GET /api/stats/daily`、`GET /api/stats/range`。

**4b 最關鍵的一致性要求：** `GET /api/stats/daily?date=` 的日界線切法
必須跟 `GET /api/meals?date=` 與 `GET /api/supplements/today` **完全一致**，
否則同一天的餐點數、打卡數與統計數會對不起來。
三者都要用 `app/days.py` 的同一組函式，而且要有一個測試同時打三個端點、
斷言它們對同一筆邊界資料的判斷相同。

統計只回數字、不判斷達成與否（本次確立的決定）：
熱量在減脂期要「不超過」、蛋白質在增肌期要「至少達到」——
同一個 110% 在兩邊意義相反，把這個判斷寫進 API 等於把產品邏輯凍在資料層。
