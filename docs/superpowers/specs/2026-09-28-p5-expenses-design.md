# P5 — 記帳模組：餐費與生活花費

**狀態：** 設計定稿，待寫實作計畫
**日期：** 2026-09-28
**前置：** P1（餐點、補劑、統計）已上線；P2 後端已完成、前端未做

---

## 1. 目標與範圍

### 1.1 這份規格回答的問題

只有一個：**「這個月花了多少、花在哪。」**

使用者原話是「我想導入記帳功能 可以計入吃進去的餐費 並結合其他生活花費整合在記帳APP」，
在設計問答裡被收斂成上面那一句。這個收斂很重要，因為它決定了**不做什麼**：

- 不做預算比較（「有沒有超支」是另一個形狀的問題，見 §8）
- 不做收入與結餘（那是「淨值」，不是「花費」）
- 不做趨勢分析（「這個月」是一個月，不是一條曲線）

如果將來這一句話變了，這份規格的大部分決定都要重新看一次。

### 1.2 這是「同一個 app 多一個模組」，不是第二個 app

設計問答裡考慮過三種架構：

| | 形狀 | 為什麼沒選 |
|---|---|---|
| A | 同一個 app 多一個模組 | **← 選這個** |
| B | 兩個 app 共用一個資料庫 | 見下方 |
| C | 兩個 app、各自資料庫、用 API 互通 | 為了一個人用的工具付出跨服務的代價 |

**B 特別值得寫下來為什麼不行。** 「共用資料庫」聽起來像是解耦（兩個 app 各自部署、
各自迭代），實際上它是**最緊的耦合**：沒有任何邊界。一邊改 schema，另一邊就壞，
而且是在執行期才發現——`alembic check` 只看得到自己那一半，
型別檢查看不到另一個 repo，測試也不會跑到另一邊。
它同時有「兩個系統」的營運成本跟「一個系統」的耦合度。

選 A 的實際結果：

- 共用 `users`、認證、`refresh_sessions`、部署、CI
- 共用 `app/days.py` 的時區處理（§5.4 會用到）
- 前端是 PWA 裡多一個路由，不是第二個 app（§6 有一個未解的問題）

### 1.3 範圍

- `expenses` 資料表（§2）
- 寫死的分類清單（§3）
- 記一餐時順手填金額（§4）
- CRUD 四個端點 + 一個月報表端點（§5）
- 前端：記帳頁 + 月報表 + 記一餐表單多一個欄位（§6）

### 1.4 範圍外

見 §8。

---

## 2. 資料模型

### 2.1 `expenses` 資料表

```sql
CREATE TABLE expenses (
  id         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  user_id    bigint NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  meal_id    bigint REFERENCES meals(id) ON DELETE SET NULL,
  category   text NOT NULL,
  amount     numeric(10,2) NOT NULL,
  spent_at   timestamptz NOT NULL,
  note       text,
  created_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT amount_positive CHECK (amount > 0),
  CONSTRAINT category_valid CHECK (category IN
    ('food','transport','daily','entertainment','medical','housing','other'))
);

CREATE INDEX ix_expenses_user_id_spent_at ON expenses (user_id, spent_at);
CREATE INDEX ix_expenses_meal_id ON expenses (meal_id);
```

`ix_expenses_user_id_spent_at` 是月報表唯一會用到的索引（`WHERE user_id = ? AND spent_at >= ? AND spent_at < ?`）。
`ix_expenses_meal_id` 是為了「這一餐花了多少」的反查，以及 `ON DELETE SET NULL` 本身——
沒有索引的話每刪一筆 meal 都要全表掃描。

### 2.2 為什麼餐費不是 `meals.cost`

`meals` 目前**沒有**任何金額欄位。加一個 `cost` 是最少的改動，但它表達不出三件真的會發生的事：

1. **買菜**——花了錢，沒有對應的一餐（一次買三天份）
2. **自己煮**——吃了一餐，沒有花錢（食材是前天買的）
3. **別人請客**——吃了一餐，錢不是你花的

而且「這個月花多少」會變成 `meals` 和 `expenses` 的 `UNION`，
每一個報表查詢都要記得把兩邊都算進去——**漏掉一邊不會報錯，只會少算**。

### 2.3 `ON DELETE SET NULL` 是這個設計的重點

`meal_id` 可為 NULL，而且 meal 被刪時**支出留下來**。

理由是一句話：**你刪掉一筆餐點紀錄（記錯了、重複記了），那筆錢還是花了。**

如果用 `ON DELETE CASCADE`，刪一筆記錯的餐點會連帶把當天的支出一起刪掉，
月結算就會少一筆，而且**不會有任何地方告訴你少了**。
這正是把兩者分開之後才表達得出來的事——用 `meals.cost` 的話，刪餐點必然等於刪錢。

代價是：`meal_id IS NULL` 有兩種意思（「本來就跟餐點無關」與「餐點被刪了」），
系統分不出來。**這個代價是接受的**，因為報表只關心金額，不關心來源。

### 2.4 金額型別

`numeric(10,2)`，Python 端是 `Decimal`，API 上是**字串**。

跟營養素完全同一條規則：**絕不用 float**。
`0.1 + 0.2 != 0.3` 在營養素上是四捨五入的小問題，在錢上是對不起來的帳。

`numeric(10,2)` 上限約一億——對個人記帳綽綽有餘，而且它是個會在插入時大聲失敗的上限，
不是安靜溢位。

`CHECK (amount > 0)`：**不收 0 也不收負數。** 負數等於退款/收入，那是範圍外（§8）。
這個約束是「範圍外」這件事在資料庫層的具體表現——
將來要做退款時，這個約束會擋住你，逼你回來重新想，而不是讓一筆負數安靜地混進月報表。

### 2.5 `spent_at` 是 `timestamptz` 不是 `date`

跟 `meals.eaten_at` 一致。

「這筆算哪個月」必須走使用者時區（`users.timezone`，預設 `Asia/Taipei`），
由後端決定，不是前端算——這是 P1 陷阱 1 的同一條規則。
存 `date` 的話時區資訊在寫入當下就永久遺失了。

---

## 3. 分類

### 3.1 清單

```python
class ExpenseCategory(enum.StrEnum):
    FOOD = "food"                    # 飲食 ← 記一餐自動填這個
    TRANSPORT = "transport"          # 交通
    DAILY = "daily"                  # 日用
    ENTERTAINMENT = "entertainment"  # 娛樂
    MEDICAL = "medical"              # 醫療
    HOUSING = "housing"              # 居住
    OTHER = "other"                  # 其他
```

DB 存英文值，中文標籤在前端。跟 `MealType` 同一種作法。

### 3.2 為什麼寫死而不是讓使用者自訂

**這個專案已經連續兩次踩到同一個坑：食物與補劑都是「後端蓋好了，但前端沒有任何地方可以新增」。**
（前者在 P3-B 規格 §2.1 記錄，後者是 P3-C 的起因。）

分類如果做成使用者自訂，那會是第三次——而且這次更糟，因為
「沒有分類可選」會讓記帳這個功能從第一天就不能用。

寫死的清單第一天就能用。代價是改清單要改程式碼——但改程式碼是一行加一個 migration，
而做一整套分類 CRUD（列表、新增、改名、刪除、刪除時既有支出怎麼辦）是一個獨立的子專案。

### 3.3 用哪一種 enum 寫法

**`native_enum=False` + 手寫 `CheckConstraint`**，跟 `meal.py`、`supplement.py`、
`ai_analyses` 同一套；**不是** `food.py` 的原生 PG ENUM。

兩個理由：

1. handover §7 記錄過：`create_constraint=True` 產生的是 type-bound CHECK，
   alembic 的比對器會把它排除在「model 這一側」之外，造成永遠消不掉的漂移。
2. **更直接的理由**：這張表**預期會改分類**（§3.4）。原生 PG ENUM 加值要
   `ALTER TYPE ... ADD VALUE`，而那個語句在 PostgreSQL 裡不能在交易區塊內執行——
   alembic 的 migration 預設就是跑在交易裡。

> **注意**：這個 repo 裡兩種 enum 寫法並存（`food.py` 是原生的）。
> P2 Task 2 因為「照 `food.py` 抄」而拿到錯的模式。**這裡明確指定是後者那一套。**

### 3.4 這份清單一定會錯

它是我猜使用者的生活寫出來的，沒有根據。

**規格明寫這件事，是為了不要讓人以為它不可動。**
用一兩個月之後最可能的結果是：「其他」佔比過高（代表缺分類），
或某幾類從來沒用過（代表太細）。那時候改它——一行 enum + 一個 migration
（只改 `CheckConstraint`，既有資料不動）。

---

## 4. 記一餐順手填金額

### 4.1 同一個交易

`MealCreateRequest` 加一個選填欄位：

```python
cost: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
```

有值時，`POST /api/meals` 在**同一個交易裡**多建一筆 `expenses`：

- `category = "food"`
- `amount = cost`
- `spent_at = meal.eaten_at`
- `meal_id = meal.id`
- `note = None`

**為什麼不是前端呼叫兩次端點？**

兩次呼叫看起來比較乾淨（兩個資源、兩個端點、互不相干），
但它有一個半成功狀態：**餐點記起來了、支出沒有，而使用者完全不會知道**。
在手機上、網路不穩的情況下，這不是理論上的風險。

一次原子操作換掉那個失敗模式。代價是 `POST /api/meals` 現在知道 `expenses` 的存在——
這個耦合是明講的、單向的（`expenses` 不知道 meals 端點），而且只有建立這一條路徑。

### 4.2 `PATCH /api/meals/{id}` 不碰金額

改金額走 `PATCH /api/expenses/{id}`。

理由是 `MealUpdateRequest` 已經有一套哨兵語意（`X | None = None` 代表「沒帶這個欄位」），
而金額需要的是三態：沒帶 / 改成某個值 / 刪掉這筆支出。
把第三態塞進同一個哨兵會很難表達，也很難測。

### 4.3 分類固定是 `food`，不可選

從記一餐建出來的支出一定是 `food`。想記成別的分類，就走 `POST /api/expenses` 自己記一筆。

（是的，商務餐可能該算別的。YAGNI——真的遇到了再說。）

---

## 5. 端點

### 5.1 五個端點

```
POST   /api/expenses                              手動記一筆
GET    /api/expenses?month=YYYY-MM&limit=         清單
PATCH  /api/expenses/{id}                         改（打錯金額很常見）
DELETE /api/expenses/{id}                         刪
GET    /api/expenses/summary?month=YYYY-MM        月報表
```

`GET /api/expenses` 的 `month` 跟 `summary` 同一條規則（§5.3）：選填，
預設使用者時區的這個月。**兩個端點對「這個月」的判斷必須是同一個函式**，
否則清單跟總額會對不起來——而且只在月初或月底那幾個小時對不起來，
是最難重現的那種。

`limit: int = Query(default=100, ge=1, le=500)`，按 `spent_at` 由新到舊。
**沒有 offset**——這跟 `foods.py` 的 `limit` 是同一種東西：一個上限，不是分頁。
一個月的個人支出撞到 500 筆的機率極低，真的撞到了再說。

全部走現有的 `get_current_user`，全部只能看到自己的資料——
`user_id` 一律從 token 取，**不從請求 body 取**（P1 既有規則）。

`PATCH` 可改的欄位：`amount`、`category`、`spent_at`、`note`。
**不能改 `meal_id`**——把一筆支出從一餐搬到另一餐沒有實際用途，而且是個好用的攻擊面
（改成別人的 meal_id）。

`DELETE` 是硬刪。這張表沒有稽核需求，而且錯記一筆要能乾淨刪掉。

### 5.2 `summary` 的回應形狀

```json
{
  "month": "2026-09",
  "total": "12345.00",
  "by_category": [
    { "category": "food", "total": "8200.00", "count": 42 },
    { "category": "transport", "total": "1500.00", "count": 12 }
  ]
}
```

`by_category` **只回有資料的分類**，金額由大到小排。
零元的分類不回——前端要顯示「這個月沒花在娛樂上」的話，它自己有完整的分類清單可以對。

一次 `GROUP BY` 查詢，`total` 由後端從同一批資料算（不是前端加總——
前端加總會在分頁或篩選時安靜地算錯）。

### 5.3 `month` 選填，預設「使用者時區的這個月」

**這裡刻意抄 `stats/daily` 的形狀，不是 `stats/range` 的形狀。**

- `stats/range` 的 `from`/`to` 必填
- `stats/daily` 的 `date` 選填，省略時是 `today_in_timezone(user.timezone)`

判準是：**預設值有沒有意義。**
「最近 N 天」的 N 是任意的，沒有一個自然的預設，所以 `stats/range` 必填。
而這個模組存在的唯一理由就是回答「**這個**月」——預設值不只有意義，它就是主要用途。

**這條判準值得記下來**：要抄哪一個既有模式，取決於預設值有沒有意義，
不是取決於哪一個端點看起來比較像。

### 5.4 需要一個 `month_bounds()`

`app/days.py` 現在只有 `day_bounds(day, tz_name)` 和 `today_in_timezone(tz_name)`。
月報表需要第三個：

```python
def month_bounds(year: int, month: int, tz_name: str) -> tuple[datetime, datetime]:
    """回傳該使用者當地某一個月的 UTC 起訖，半開區間 [start, end)。"""
```

**它必須放在 `app/days.py`，跟另外兩個在一起。**
散在路由裡寫 `datetime(year, month, 1)` 就是 P1 陷阱 1 的完整重演——
那樣算出來的是伺服器時區的月初，在 UTC 容器裡跑就是差 8 小時，
而「差 8 小時」的具體表現是**每個月的第一筆和最後一筆會跑到隔壁月**。

12 月要進位到隔年 1 月。這是最會寫錯的一行，而且只有 12 月會錯——
**測試必須包含 12 月**（見 §7.2）。

同樣要一個 `this_month_in_timezone(tz_name) -> tuple[int, int]`，理由跟
`today_in_timezone` 的 docstring 寫的一樣：留一個測試可以替換的接縫。

---

## 6. 前端

### 6.1 tab bar 塞不下第六格

這是一個**具體的、算得出來的**限制，不是感覺：

- `.tab-bar` 是 `display: flex`，`.tab` 是 `flex: 1` → 每格等寬
- 現有 4 格；管理員多一格「審核」= 5 格
- `font-size: 14px`，中文字約 1em → 四個字約 56px
- 最窄的目標裝置 320px：`320 / 5 = 64px`，`320 / 6 = 53.3px`
- **「今日總覽」是四個字（約 56px），塞不進 53.3px**

> **這是算術，不是在真機上量的。** 實際會不會截字、怎麼截，
> 取決於字型與 letter-spacing。**實作時要在 320px 寬度下真的看一次**，
> 不要拿這段算術當已驗證的結論。

### 6.2 三個方向，未定

1. **記帳放在「今日總覽」底下**，跟補劑入口同一個作法
2. **tab 改成圖示 + 短標籤**，擠得下六格
3. **拿掉一格**（例如「趨勢」移進今日總覽）

**傾向 1**，因為它不動現有的四格、改動最小。

**但這要用過才知道。** 如果記帳是每天要按好幾次的動作，藏在二層會很煩；
如果是幾天才記一次，二層完全沒問題。決定它需要的資訊（實際使用頻率）現在還不存在。

**所以這份規格給的是一個有預設值的決定，不是一個待填的空格：**
寫實作計畫時若沒有新資訊，就做方向 1，計畫不必再問。
改成方向 2 或 3 的條件是使用者明講「記帳按起來太麻煩」——
那時候換成方向 2 是純前端改動，`TabBar.tsx` 一個檔案。

### 6.3 兩個畫面 + 一個欄位

- **`/expenses`**：這個月的清單 + 新增按鈕 + 點進去改/刪
- **月報表**：總額 + 分類長條（可以重用 `MacroBar` 的視覺語言，但不是同一個元件——
  `MacroBar` 有「目標值」的概念，這裡沒有目標）
- **記一餐表單**多一個選填的「金額」欄位

金額輸入框跟所有輸入框一樣要 `font-size: 16px`（P3-C：iOS Safari 在 <16px 時會自動放大）。
`index.css` 的全域規則已經涵蓋，**但新元件不要自己覆寫成更小的字**。

前端金額一律用 `decimal.js`，跟營養素同一條規則——**不要用 `Number`**。

---

## 7. 測試

### 7.1 真正要測的東西

大部分的 CRUD 測試價值很低（測 FastAPI 有沒有照 Pydantic 做事）。真正值得寫的是：

1. **`month_bounds()` 的 12 月進位**（§5.4）
2. **`month_bounds()` 在 `Asia/Taipei` 與 UTC 下的邊界**——
   月初 00:00 台北時間 = 上個月最後一天 16:00 UTC
3. **刪除 meal 之後，支出還在且 `meal_id` 變成 NULL**（§2.3 的核心主張）
4. **`POST /api/meals` 帶 `cost` 時，餐點與支出要嘛都在、要嘛都不在**——
   用一個會讓支出插入失敗的輸入去測交易有沒有真的一起回滾
5. **`amount = 0` 與負數被擋下來**（§2.4）
6. **別人的 expense 不能讀、不能改、不能刪**（404 不是 403——不洩漏存在性，跟 P1 一致）

### 7.2 「綠燈說謊」候選

這一版新增的、要進 handover §6 的：

- **月份測試如果只用「當月」當測資，它在 12 月以外的每一天都沒有鑑別力。**
  這是 P3-B 踩過的坑的變形（當時的 mock 日期剛好是計畫撰寫日，那天測試零鑑別力）。
  **`month_bounds` 的測試必須寫死 12 月，不能用 `today()`。**
- **`ON DELETE SET NULL` 的測試，如果 meal 本來就沒有連著 expense，會永遠綠。**
  測試必須先斷言「刪之前 `meal_id` 是有值的」。
- **交易回滾的測試，如果那個「會失敗的輸入」其實在 Pydantic 就被擋掉了，
  根本沒進到交易，測試照樣綠。** 必須確認失敗發生在 DB 層。

---

## 8. 不做

| 不做 | 為什麼 |
|---|---|
| **預算 / 超支提醒** | 使用者選的是「花了多少、花在哪」，不是「有沒有超支」。而且現在設預算等於猜一個沒有根據的數字——記了一兩個月、知道自己的基準線之後再談 |
| **收入 / 結餘** | 那是「淨值」，另一個問題 |
| **固定支出**（房租、訂閱） | 需要一套排程與「這個月扣了沒」的狀態機 |
| **多幣別** | 需要匯率來源與「用哪天的匯率」的決定 |
| **分帳** | 需要「其他人」這個概念，而這個系統只有一個使用者 |
| **收據照片** | P2 已經決定圖片不存（規格 §6）。這裡沒有理由推翻那個決定 |
| **使用者自訂分類** | §3.2 |
| **匯入銀行/發票資料** | 需要外部整合，是獨立子專案 |

---

## 9. 這份規格大概會切成幾份計畫

1. **後端**：model + migration + `month_bounds()` + 五個端點 + `POST /api/meals` 的 `cost`
2. **前端**：`/expenses` 頁、月報表、記一餐表單的金額欄位、§6.1 的導覽問題

順序上，這份規格要跟 **P2 前端** 比大小再決定先做哪個（使用者原話：「兩個一起規劃再決定」）。
P2 後端已經完成但**沒有任何前端入口**——那正是 §3.2 說的那個坑的第三個候選。
