# P1 計畫 3：餐點紀錄 + 照片

規格：`docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md`
前置：計畫 1（骨架 + 認證）、計畫 2（食物主檔 + 版本化 + 審核）皆已合併進 master。

起點：130 個測試、15 個端點、覆蓋率 97.30%。

本計畫做完，P1 的「記錄」這條主線就通了：使用者可以建立一餐、掛上多個食物項目、
拍照存檔、查某一天吃了什麼，以及從「常吃 / 最近吃」快速再記一筆。

---

## 這份計畫從計畫 1、2 繼承的規矩

這些是前兩個計畫用實測換來的，**不要重新發明，也不要以為可以繞過**：

1. **權限失敗一律回 404，不回 403。** 「不是你的」必須跟「不存在」逐字相同，
   連 response body 都一樣。計畫 2 的 `test_every_isolation_failure_looks_identical`
   就是在守這件事，本計畫的新端點要加進那份清單。
2. **路徑參數一律用 `app/api/params.py` 的 `ResourceId`。** 超過 int64 的整數會讓
   asyncpg 拋 `DataError` 變成未處理的 500。
3. **任何捕捉 `commit()` / `flush()` 例外的地方，必須先 `await db.rollback()`。**
   而且 `rollback()` 會讓 identity map 裡**所有**物件過期，包含測試自己抓著的那些 ——
   測試要先把 `id`、headers 這類值存進區域變數再發請求。
4. **索引全部宣告在 model 的 `__table_args__` 裡。** 只存在於資料庫的索引會被
   autogenerate 判定成 `remove_index`。model 是唯一事實來源。
5. **`CheckConstraint(name=)` 給的是 `%(constraint_name)s` 的輸入**，不是最終名稱。
   寫 `name="kcal_non_negative"`，得到 `ck_food_revisions_kcal_non_negative`。
   只有 `CheckConstraint` 是這樣。
6. **`sa.Enum` 不要放進 `op.create_table`**，會多發一次 `CREATE TYPE`。
   用 `postgresql.ENUM(..., create_type=False)`。
7. **主鍵用 `GENERATED ALWAYS AS IDENTITY`**（`Identity(always=True)`），不用 `serial`。
8. **測試通過不等於實作正確。** 計畫 2 的 Task 9 實測過：把正確的 `rollback()`
   拿掉，測試照樣全綠。**綠燈從不告訴你它為什麼綠。**
   本計畫凡是「寫完就是綠的」測試，一律要用突變證明它不是空轉的。

---

## 執行前提

**本計畫需要新增兩個依賴：Pillow（影像處理）與 tzdata（時區資料）。**

`tzdata` 這一項是寫計畫時實測發現的，**不是可有可無**：

```
>>> ZoneInfo("Asia/Taipei")
ZoneInfoNotFoundError: 'No time zone found with key Asia/Taipei'
```

Windows 沒有系統時區資料庫，Python 的 `zoneinfo` 在這個平台上**完全依賴
PyPI 的 `tzdata` 套件**。而 Linux 有 `/usr/share/zoneinfo`，所以：

| 環境 | 沒裝 tzdata 的結果 |
|---|---|
| 本機開發（Windows） | 每一個碰到時區的測試都爆 |
| CI（ubuntu） | **全部通過** |
| Docker 映像（Linux） | **正常運作** |

也就是說，不明確宣告這個依賴，會得到一個「CI 全綠、本機全紅」的分裂狀態 ——
而且方向跟直覺相反，很容易被誤判成本機環境壞掉。
**把它寫進 `dependencies` 而不是只裝在本機**，才能讓三個環境行為一致。

subagent 一律不准跑 `pip install`。所以這一步由主 session 在派工之前先做完：

```bash
# pyproject.toml 的 dependencies 加入 "pillow>=11,<12" 與 "tzdata"
.venv/Scripts/python.exe -m pip install "pillow>=11,<12" tzdata
.venv/Scripts/python.exe -m pip freeze > requirements-lock.txt   # 依現行流程重產
```

CI 會用 `requirements-lock.txt` 安裝，所以 lock 檔沒更新的話 CI 會紅。
**`tzdata` 要在 Task 2 之前裝好，`pillow` 要在 Task 13 之前裝好。**

其餘執行限制與前兩個計畫相同：不准 `git stash`、不准動 `docs/`、
不准碰 `edu-quiz-app-db-1`、不准對 dev 資料庫 `wallet` 跑 alembic 的
`upgrade`/`downgrade`/`revision`（`alembic check` 是唯讀，可以）。

---

## 檔案結構

```
app/
  days.py                     ← 新增：day_bounds() 純函式
  models/meal.py              ← 新增：Meal, MealItem
  models/user.py              ← 改：加 timezone 欄位
  schemas/meal.py             ← 新增
  schemas/auth.py             ← 改：註冊可選 timezone
  schemas/user.py             ← 新增：PATCH /api/me 的請求／回應
  storage/__init__.py         ← 新增
  storage/photos.py           ← 新增：所有檔案讀寫集中在這裡
  api/routes/meals.py         ← 新增
  api/routes/me.py            ← 改：加 PATCH
  api/routes/foods.py         ← 改：加 frequent / recent
migrations/versions/
  0003_*.py                   ← users.timezone
  0004_*.py                   ← meals / meal_items
tests/
  test_days.py                ← 新增
  test_meals_create.py        ← 新增
  test_meals_read.py          ← 新增
  test_meals_update.py        ← 新增
  test_meals_items.py         ← 新增
  test_meals_photo.py         ← 新增
  test_foods_frequent.py      ← 新增
  test_cross_user_isolation.py ← 改：新端點加進總掃描
  factories.py                ← 改：加 create_meal
```

---

## 本計畫確立的兩個決定

### 決定 1：「一天」由使用者的時區決定，時區存在 `users` 表

`meals.eaten_at` 是 `timestamptz`（UTC 存放），但 `GET /api/meals?date=` 給的是日期。
台灣早上 7 點的早餐在 UTC 是**前一天** 23:00 —— 用 UTC 日期過濾會把它算到昨天。

三個選項比較過：

| 作法 | 為什麼不選 |
|---|---|
| 伺服器寫死 `Asia/Taipei` | 「完整多使用者」這個決定在這裡破一個洞；日後要改得回填既有資料的解讀方式 |
| 前端每次帶 `?tz=` | 忘記帶就是**靜默的錯誤答案**（預設 UTC，早餐算到昨天），不會報錯。這跟我們一路在避免的「忘記加過濾條件」是同一類問題 |
| **存在 `users.timezone`** | 選這個 |

`users.timezone text NOT NULL DEFAULT 'Asia/Taipei'`，存 IANA 名稱。

**必須在寫入時驗證是合法 IANA 名稱。** PostgreSQL 沒辦法用 CHECK 擋這個，
所以擋在 Pydantic：不合法的時區存進去，之後每一次查詢都會 500，而且是
存進去很久以後才爆。驗證方式是實際 `ZoneInfo(name)` 試建，不是比對字串清單。

### 決定 2：`PATCH /api/meals/{id}` 只改餐點本身，項目另開端點

```
PATCH  /api/meals/{id}                  eaten_at / meal_type / note
POST   /api/meals/{id}/items            新增一個項目
DELETE /api/meals/{id}/items/{item_id}  刪除一個項目
```

不採「PATCH 帶完整項目清單、全量取代」的原因：兩個裝置同時編輯時，後送的那個
會把先送的項目整碗端走，而且**不會有任何錯誤**。另外全量取代會讓 `meal_items.id`
每次都變，P2 若要做「這個項目是 AI 辨識出來的」之類的關聯會很痛。

代價是多兩個端點，以及「改數量」要靠刪掉再加。可接受。

---

## 三個必須在動手前講清楚的陷阱

### 陷阱 1：`quantity_g` 是用來凍結歷史的，不是為了方便

`food_portions` **沒有版本化**。有人把「1 碗 = 200g」改成 250g，所有引用該份量的
歷史紀錄都會跟著變 —— 這正是決策 3（版本化）要避免的問題，只是換一個地方發生。

所以 `meal_items` 存兩份：

| 欄位 | 用途 |
|---|---|
| `quantity` + `portion_id` | **只用於顯示**（「你當時輸入的是 1.5 碗」） |
| `quantity_g` | **所有計算都用它**。寫入當下換算好，之後永不改變 |

**這件事要有一個專門的測試：** 建一餐引用某份量 → 把該份量的 `grams` 改掉 →
重讀那一餐，`quantity_g` 與算出來的熱量都必須不動。這是計畫 2 那個
「指標移動」測試的同構物。

### 陷阱 2：API 收 `food_id`，不收 `food_revision_id` —— 這是安全問題

`meal_items.food_revision_id` 指向版本，直覺會想讓 client 直接送版本 id。**不行。**

送得進去的話，使用者可以引用一筆 **pending 的版本**（別人還沒審過的提案，或自己
提的全域編輯），然後透過 `GET /api/meals/{id}` 把那筆未審核的營養素**讀回來**。
審核流程就這樣被繞過了 —— 而且繞過的路徑不在 `foods.py` 裡，在 `meals.py` 裡。

**正確作法：** client 送 `food_id`，伺服器自己解析 `foods.current_revision_id`。
這跟決策 4「用指標而非 `WHERE status = 'approved'`」是同一個原則的延伸：
**不給呼叫端指定版本的能力，未審核的資料就在結構上不可達。**

同理，`portion_id` 也必須驗證：(a) 屬於同一個 `food_id`，(b) 對這個使用者可見
（全域份量或自己的）。否則可以拿別人的私人份量 id 來換算，而且換算結果會回傳
給你 —— 那是一條資訊洩漏路徑。

### 陷阱 3：「每 100 單位」的分母，和 `grams` 這個誤導的欄位名

營養素一律以**每 100g / 100ml** 為基準儲存，沒有分母欄位，`100` 是約定。

```
factor     = quantity_g / 100
kcal_total = revision.kcal * factor
```

**這個 `100` 只能出現在一個地方。** 散在各處的話，P4 做統計時很容易漏改一處，
而且結果只是「數字有點怪」，不會炸。

另外記一筆已知的命名瑕疵：`food_portions.grams` 和 `meal_items.quantity_g` 都叫
grams，但對 `base_unit = 'ml'` 的食物（飲料）裝的其實是毫升。數學完全一樣所以
能正確運作，但**不要跨食物 `SUM(quantity_g)`** —— 那會把公克和毫升加在一起。
安全的前提是：分母（100）與單位由同一筆 revision 決定，逐項換算成營養素之後才加總。
加總的對象永遠是 kcal / 公克數的營養素，不是 `quantity_g`。

---

## Task 1: `users.timezone` 欄位 + migration 0003

**Files:** `app/models/user.py`、`migrations/versions/0003_*.py`、`tests/test_auth_register.py`（改）

- [ ] **Step 1: model 加欄位**

```python
timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default="Asia/Taipei")
```

用 `server_default` 而不是 `default`：既有的兩筆使用者資料要能就地補值，
而且日後任何直接 SQL 插入也拿得到預設值。

- [ ] **Step 2: 產生 migration**

```
.venv/Scripts/python.exe -m alembic revision --autogenerate -m "add users.timezone"
```

檢查產出的檔案：應該只有一個 `op.add_column`。**如果出現任何其他操作，停下來回報** ——
那代表 model 與資料庫之間有你沒預期的漂移。

- [ ] **Step 3: 註冊時可選帶時區**

`app/schemas/auth.py` 的註冊請求加 `timezone: str = "Asia/Taipei"`，加驗證器：

```python
@field_validator("timezone")
@classmethod
def _must_be_real_timezone(cls, value: str) -> str:
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("不是合法的 IANA 時區名稱") from exc
    return value
```

**兩種例外都要接**，但原因跟我原本寫的相反 —— 以下是 Task 1 實測後的更正：

```
ZoneInfoNotFoundError.__mro__ = (ZoneInfoNotFoundError, KeyError, LookupError, ...)
issubclass(ZoneInfoNotFoundError, ValueError) -> False
```

| 漏接的那一個 | `"Mars/Olympus"` | `"../../etc/passwd"` |
|---|---|---|
| 只接 `ZoneInfoNotFoundError` | 422 ✓ | **422，但洩漏內部訊息** |
| 只接 `ValueError` | **逃逸成 500** | 422 ✓ |

原本的計畫寫「只接前者會讓路徑穿越變成 500」，**這是錯的**。
500 的風險在普通的「查無此時區」那一側，因為 `ZoneInfoNotFoundError` 是
`LookupError` 不是 `ValueError`。

而路徑穿越那一側之所以不會 500，是因為 **Pydantic v2 會自動把任何逃出驗證器的
`ValueError` 轉成乾淨的 422** —— 不只是我們自己 `raise` 的那些。
漏接的實際後果因此是**回應裡出現 zoneinfo 的內部訊息**
（`"ZoneInfo keys must refer to subdirectories of TZPATH, got: ../../etc/passwd"`），
而不是狀態碼變了。

> **這個機制本身值得記住：** 驗證器裡漏接一個 `ValueError`，從狀態碼上完全看不出來，
> 只有訊息換人寫。**只斷言 422 的測試抓不到這種漏接。**
> 本計畫後續凡是驗證器的測試，都要順便斷言訊息是我們自己的那一句。

- [ ] **Step 4: 測試**

新增 4 個：預設是 `Asia/Taipei`；可以指定 `America/New_York`；
`"Mars/Olympus"` 回 422；`"../../etc/passwd"` 回 422（**不是 500**）。

- [ ] **Step 5: 驗收 + commit**

`pytest -W error`（134）、`ruff`、`mypy app`、`alembic check`。
Commit: `feat: 使用者可設定時區`

---

## Task 2: `day_bounds()` —— 一天的起訖，純函式

**Files:** `app/days.py`、`tests/test_days.py`

這是整個計畫裡最適合先寫測試的東西：純函式、無 I/O、有明確的邊界案例。

- [ ] **Step 1: 先寫測試（必須看到紅燈）**

```python
from datetime import UTC, date, datetime, timedelta

import pytest

from app.days import day_bounds


def test_taipei_day_starts_at_16_00_utc_the_day_before():
    start, end = day_bounds(date(2026, 9, 4), "Asia/Taipei")
    assert start == datetime(2026, 9, 3, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 9, 4, 16, 0, tzinfo=UTC)


def test_a_spring_forward_day_is_23_hours_long():
    # 美東 2026-03-08 進入日光節約時間，這一天只有 23 小時
    start, end = day_bounds(date(2026, 3, 8), "America/New_York")
    assert end - start == timedelta(hours=23)


def test_a_fall_back_day_is_25_hours_long():
    # 美東 2026-11-01 退出日光節約時間，這一天有 25 小時
    start, end = day_bounds(date(2026, 11, 1), "America/New_York")
    assert end - start == timedelta(hours=25)


@pytest.mark.parametrize(
    ("tz_name", "day"),
    [
        ("America/New_York", date(2026, 3, 7)),
        ("America/New_York", date(2026, 3, 8)),
        ("America/New_York", date(2026, 10, 31)),
        ("America/New_York", date(2026, 11, 1)),
        # 這兩個時區的日光節約切換點就在午夜，當地的 00:00 根本不存在
        ("America/Havana", date(2026, 3, 8)),
        ("America/Santiago", date(2026, 9, 6)),
    ],
)
def test_consecutive_days_tile_the_timeline_with_no_gap_or_overlap(tz_name, day):
    """今天的結束必須恰好等於明天的開始 —— 半開區間才不會漏算或重複算一餐。"""
    _, end = day_bounds(day, tz_name)
    next_start, _ = day_bounds(day + timedelta(days=1), tz_name)
    assert end == next_start


def test_a_day_whose_local_midnight_does_not_exist_still_works():
    """古巴 2026-03-08 當地沒有 00:00 這一刻，但這一天依然要有明確的起訖。"""
    start, end = day_bounds(date(2026, 3, 8), "America/Havana")
    assert end - start == timedelta(hours=23)


def test_an_unknown_timezone_raises():
    with pytest.raises(Exception):
        day_bounds(date(2026, 9, 4), "Mars/Olympus")


def test_the_timezone_database_is_actually_available():
    """守住「CI 綠、本機紅」的平台分裂：tzdata 沒裝時這個測試會第一個爆，
    而且訊息直接指向原因，不會讓人以為是日界線算錯。"""
    import importlib.util

    assert importlib.util.find_spec("tzdata") is not None, (
        "缺少 tzdata 套件；Windows 沒有系統時區資料庫，見計畫的「執行前提」"
    )
```

- [ ] **Step 2: 實作**

```python
from datetime import UTC, date, datetime, time, timedelta
from zoneinfo import ZoneInfo


def day_bounds(day: date, tz_name: str) -> tuple[datetime, datetime]:
    """回傳該使用者當地某一天的 UTC 起訖，半開區間 [start, end)。"""
    tz = ZoneInfo(tz_name)
    start = datetime.combine(day, time.min, tzinfo=tz)
    end = datetime.combine(day + timedelta(days=1), time.min, tzinfo=tz)
    return start.astimezone(UTC), end.astimezone(UTC)
```

> **`end` 要在轉成 UTC「之前」算完。**（Task 2 實測更正：這條原本寫成
> 「絕對不能寫成 `start + timedelta(days=1)`」，**指錯了突變點**。）
>
> 關鍵不是用不用 `timedelta`，而是**加法發生在哪一側**：
>
> | 寫法 | 2026-03-08（美東春分）的長度 |
> |---|---|
> | `combine(隔天, 00:00, tz)` → UTC | 23 小時 ✓ |
> | `當地 start + timedelta(days=1)` → UTC | 23 小時 ✓ **等價，不是 bug** |
> | 先 `.astimezone(UTC)`，**再** `+ timedelta(days=1)` | **24 小時 ✗** |
>
> 中間那個之所以也對，是因為 **aware datetime 的加法是掛鐘運算** ——
> 它只動年月日時分秒欄位，`tzinfo` 與 `fold` 原封不動、不重新正規化
> （PEP 495 的行為，與 `pytz` 的固定偏移物件不同）。在「當地時間」上加一天，
> 得到的就是隔天的當地午夜，與 `combine` **逐欄位完全相同**。
>
> 錯的是第三種：轉成 UTC 之後，時區資訊已經塌成一個固定偏移，一天就真的是
> 24 小時，DST 那一小時就永遠找不回來了。
>
> 台灣沒有日光節約，**用台灣時區寫的測試對三種寫法一律全綠**。
> 上面那兩個美東的測試就是為此存在的 —— 而且實測確認它們抓得到第三種。
>
> **這件事本身是個教材：** 「不要寫 `+ timedelta(days=1)`」這種以**語法**
> 描述的規則是靠不住的，同一段文字放在相鄰兩行、意義完全不同。
> 真正的規則要用**語意**描述：算日界線的運算必須發生在有時區語意的那一側。
>
> 「隔天的起點」這個寫法還附帶保證了平鋪性：只要每一天都用同一個函式算，
> 區間就必然首尾相接，不會有縫也不會重疊 —— 這一點不依賴任何時區的性質，
> 因為兩個邊界是同一個運算產生的。
>
> **當地午夜不存在的時區（已實測）：** 有些時區的日光節約切換點就在午夜，
> 那一天當地的 00:00 那一刻**根本不存在**。掃過 tzdata 全部時區後，
> 2026 年有這種日子的是 4 個（含別名）：
>
> | 時區 | 日期 |
> |---|---|
> | `America/Havana`（別名 `Cuba`） | 2026-03-08 |
> | `America/Santiago`（別名 `Chile/Continental`） | 2026-09-06 |
>
> `datetime.combine()` **不會拋例外**，它依 fold 規則把那個不存在的當地時刻
> 解析成一個確定的 UTC 時刻（實測：來回轉換後變成當地 01:00）。
> 而平鋪性**實測依然成立** —— 因為起訖是同一個運算產生的：
>
> ```
> 2026-03-07  len=24:00:00  end==next_start -> True
> 2026-03-08  len=23:00:00  end==next_start -> True
> 2026-03-09  len=24:00:00  end==next_start -> True
> ```

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（146）。Commit: `feat: 新增依使用者時區計算單日起訖的函式`

> **一個留給之後順手修的小問題：** `pytest.raises(Exception)` 會觸發 ruff 的
> `B017`（不要斷言裸的 Exception），Task 2 是用 `# noqa: B017` 壓掉的。
> 但 Task 1 已經實測出真實型別是 `ZoneInfoNotFoundError`，
> 所以改成 `pytest.raises(ZoneInfoNotFoundError)` 會**同時**移除這個 lint 抑制
> 並把真實行為釘住。下次動到這個檔案時順手改。

---

## Task 3: `PATCH /api/me` —— 讓時區改得動

**Files:** `app/schemas/user.py`、`app/api/routes/me.py`、`tests/test_me.py`

**這是超出規格第 7.1 節的一個新增，刻意為之。** 規格只列了 `GET /api/me`，
但一個設定進去就改不掉的時區是 bug 不是功能。範圍嚴格限制在
`timezone` 與 `display_name` 兩個欄位。

- [ ] **Step 1: 寫測試**

5 個：改時區成功；改顯示名稱成功；只帶一個欄位時另一個不動；
不合法時區回 422；未認證回 401。

`display_name` 沿用計畫 1 已有的控制字元驗證器（NUL byte 那個），**不要重寫**。

- [ ] **Step 2: 實作**

請求模型的兩個欄位都是 `X | None = None`，用
`payload.model_dump(exclude_unset=True)` 決定要更新哪些 ——
**不要用 `exclude_none`**，兩者在「使用者明確送 null」時行為不同，
這個區別以後加可為空的欄位時會咬人。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（144）。Commit: `feat: 可修改個人時區與顯示名稱`

---

## Task 4: `meals` / `meal_items` model

**Files:** `app/models/meal.py`、`app/models/__init__.py`（改）

- [ ] **Step 1: 寫 model**

```python
class MealType(enum.StrEnum):
    BREAKFAST = "breakfast"
    LUNCH = "lunch"
    DINNER = "dinner"
    SNACK = "snack"


class Meal(Base):
    __tablename__ = "meals"
    __table_args__ = (
        # 不靠 Enum(create_constraint=True) 自動產生，理由見 Task 5 的實測發現
        CheckConstraint(
            "meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')",
            name="meal_type_valid",
        ),
        Index("ix_meals_user_id_eaten_at", "user_id", "eaten_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    eaten_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    meal_type: Mapped[MealType] = mapped_column(
        # create_constraint=False —— 見下方 Task 5 的實測發現，這裡不能用 True
        Enum(MealType, name="meal_type", native_enum=False, create_constraint=False,
             values_callable=lambda e: [m.value for m in e]),
        nullable=False,
    )
    photo_path: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MealItem(Base):
    __tablename__ = "meal_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("quantity_g > 0", name="quantity_g_positive"),
        Index("ix_meal_items_meal_id", "meal_id"),
        Index("ix_meal_items_food_revision_id", "food_revision_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    food_revision_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("food_revisions.id"), nullable=False
    )
    # 份量被刪掉時只斷開顯示用的關聯，quantity_g 不受影響 —— 歷史數值不能因此改變
    portion_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("food_portions.id", ondelete="SET NULL")
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    quantity_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

> **`meal_type` 用 `native_enum=False`**，依規格決策 7：不是原生 PG enum，
> 而是帶 CHECK 的字串欄位。原生 enum 要加一個值就得跑 `ALTER TYPE`，
> 而餐別未來很可能要加（宵夜、加餐）。
>
> **實測結果（Task 5，其中一項推翻了我原本的寫法）：**
>
> 型別的部分我猜對了：`native_enum=False` 產生的是 **`VARCHAR(9)`**
> （9 = 最長的標籤 `"breakfast"`），不是規格 DDL 寫的 `text`。
>
> **但 `create_constraint=True` 是錯的，而且錯得很隱蔽：它會讓
> `alembic check` 永遠報漂移，沒有任何辦法收斂。**
>
> ```
> Detected removed check constraint 'ck_meals_meal_type'
> ```
>
> 每一次都報，重跑幾次都一樣。原因不是不穩定，是結構性的：
>
> - Alembic 的 CHECK 比對器（`alembic/util/sqla_compat.py` 的
>   `all_table_check_constraints`）**刻意把 type-bound 的約束從 model 側排除掉**，
>   那是 SQLAlchemy issue #3260 的 workaround。
> - 但從資料庫反射回來的約束，**沒有任何欄位能標記它是 type-bound** ——
>   在 PostgreSQL 眼中它就是一個普通的 CHECK。
> - 於是 model 側算出 0 個、DB 側算出 1 個 → 永遠判定成 `remove_constraint`。
>
> **為什麼這件事比看起來嚴重：** CI 的漂移閘門就是 `alembic check`。
> 用了 `create_constraint=True`，這個閘門會從第一天起就是紅的 ——
> 而它紅的原因跟任何真實的漂移無關。接下來只有兩條路：
> 把閘門關掉（於是真的漂移也不會被發現了），或是花很久找一個
> 「明明模型和資料庫一模一樣卻說不一樣」的鬼。
>
> **正解：`create_constraint=False`，然後在 `__table_args__` 裡自己宣告一個
> 普通的 `CheckConstraint`。** 那就跟 `quantity_positive`、`kcal_non_negative`
> 走同一條路徑，命名慣例照常套用，實測名稱是 `ck_meals_meal_type_valid`，
> `alembic check` 連續三次乾淨。
>
> **可以帶走的通則：** 「讓 ORM 幫你自動產生 schema 物件」和
> 「讓 autogenerate 比對 schema 物件」這兩個便利功能，
> 對**同一個**物件的認知可能不一致。宣告在 `__table_args__` 裡的東西是
> 兩邊都看得見的；作為型別副產品自動長出來的東西不是。
> 這也再一次印證了繼承規矩第 4 條：**model 要是唯一的事實來源。**

> **索引為什麼是 ASC 而不是規格寫的 `eaten_at DESC`：** 這個索引服務的是
> 「某使用者某段時間的餐點，時間新到舊」。`user_id` 是等值條件、`eaten_at` 是
> 唯一的排序欄位，這種形狀下 PostgreSQL 可以**反向掃描**同一個 ASC 索引，
> 效果與 DESC 索引相同。DESC 只在多欄位混合方向排序時才有差別。
> 用 ASC 同時避開了 alembic autogenerate 對帶方向索引的比對不確定性。

- [ ] **Step 2: 驗收 + commit**

此時還沒有 migration，`alembic check` **應該會報漂移，這是預期的紅燈**
（計畫 2 的 Task 2 曾因為我把這件事寫成「應該全綠」而自相矛盾過）。
conftest 會跑 `alembic check`，所以**這一步全部測試都會 error，這是對的**。
只跑 `ruff` 與 `mypy app`，然後 commit: `feat: 新增 meals / meal_items 的 model`

---

## Task 5: migration 0004

**Files:** `migrations/versions/0004_*.py`

- [ ] **Step 1: autogenerate**

```
.venv/Scripts/python.exe -m alembic revision --autogenerate -m "create meals and meal_items"
```

- [ ] **Step 2: 逐行審查產出**

要確認的四件事：
1. 兩張表都用 `sa.Identity(always=True)`，**不是** `sa.Integer` + autoincrement
2. 四個索引都在（`ix_meals_user_id_eaten_at`、`ix_meal_items_meal_id`、
   `ix_meal_items_food_revision_id`，加上兩張表的 PK）
3. 兩個 `CheckConstraint` 都在，名稱是 `ck_meal_items_` 開頭
4. `meal_type` 的 CHECK 約束存在

- [ ] **Step 3: 對 `wallet_test` 套用並往返驗證**

```
export DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test"
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m alembic downgrade 0003
.venv/Scripts/python.exe -m alembic upgrade head
.venv/Scripts/python.exe -m alembic check
```

**絕對不要對 dev 資料庫 `wallet` 跑這些。**

- [ ] **Step 4: 實測回報約束與型別**

依 Task 4 的要求，查 `pg_constraint` 與 `information_schema.columns`，
回報 `meal_type` 的真實型別、`meal_type` CHECK 的真實名稱、
以及新約束是否都符合 `ck_` / `fk_` / `pk_` / `uq_` 命名慣例。

> 查 `pg_constraint.contype` 時記得加 `::text` 轉型 —— asyncpg 會把
> `"char"` 型別回傳成 **bytes**（`b'c'` 而非 `'c'`），比對會全部落空。
> 計畫 2 的驗收腳本就是這樣把 20 個完全正確的名稱誤判成全部違規。

- [ ] **Step 5: 驗收 + commit**

`pytest -W error`（144，恢復全綠）。Commit: `feat: 新增 meals / meal_items 的 migration`

---

## Task 6: 測試資料產生器

**Files:** `tests/factories.py`（改）

- [ ] **Step 1: 加入 `create_meal`**

沿用既有的 `itertools.count` 計數器風格。簽名大致是：

```python
async def create_meal(db, *, user, eaten_at=None, meal_type=MealType.LUNCH,
                      items=None, note=None) -> Meal
```

`items` 收 `(food_revision, quantity_g)` 的序列，預設空清單。

`eaten_at` 預設用一個**固定的**時刻，不要用 `datetime.now()` ——
依賴日界線的測試會因此在某些時段隨機失敗，而且失敗看起來像 flaky
而不是像 bug，很難查。

- [ ] **Step 2: 驗收 + commit**

`pytest -W error`（144，產生器本身還沒被用到）。
Commit: `test: 新增餐點的測試資料產生器`

---

## Task 7: `POST /api/meals` —— 本計畫最重的一個

**Files:** `app/schemas/meal.py`、`app/api/routes/meals.py`、`app/nutrition.py`、
`tests/test_meals_create.py`

請求形狀：

```json
{
  "eaten_at": "2026-09-04T12:30:00+08:00",
  "meal_type": "lunch",
  "note": "公司附近的自助餐",
  "items": [
    {"food_id": 1, "quantity": "1.5", "portion_id": 3},
    {"food_id": 7, "quantity": "80"}
  ]
}
```

- [ ] **Step 1: 先寫測試（12 個）**

功能面：
1. 建立含一個項目的一餐 → 201，回傳項目與營養素總計
2. 建立含多個項目的一餐 → 總計是各項相加
3. 帶 `portion_id` 時 `quantity_g = portion.grams * quantity`
4. 不帶 `portion_id` 時 `quantity_g = quantity`（使用者直接輸入克數）
5. **項目清單可以是空的** → 201

安全面（每一個都必須是 404 / 422，不能是 500，也不能成功）：

6. 引用別人的私人食物 → 404
7. 引用別人的私人份量 → 404
8. 引用「屬於另一個食物」的份量 → 422
9. `quantity` 為 0 或負數 → 422
10. `meal_type` 不在四個值內 → 422
11. 未認證 → 401
12. **凍結歷史**：建一餐引用某份量 → 把該份量的 `grams` 從 200 改成 250 →
    重讀那一餐，`quantity_g` 與熱量都必須**完全不動**

> 第 5 項（允許空項目）是刻意的設計，不是漏檢查。P2 的流程是
> 「先拍照 → 之後才做 AI 分析 → 確認後才落項目」。**現在允許空的一餐，
> P2 就不需要動資料表**。若現在強制至少一個項目，P2 得改 schema 或發明一個
> 假項目來繞過，兩者都比現在放行糟。

> 第 12 項是整個計畫的核心測試，它是計畫 2 那個「指標移動」測試的同構物。
> 沒有它，`quantity_g` 這個欄位存在的理由就沒有被證明過。

- [ ] **Step 2: 實作**

處理每個項目的順序（**這個順序是安全性的一部分**）：

```
1. 用計畫 2 已有的可見性條件載入 food（不可見 → 404）
2. food.current_revision_id 是 NULL → 409（防禦性；正常流程不該發生）
3. 有 portion_id 的話：
     載入 portion，條件是 portion.food_id == food.id
                   且 (portion.owner_id IS NULL OR == user.id)
     載不到 → 404
     載到了但 food_id 不符 → 422（跟「看不到」是不同的錯誤，不要混為一談）
4. quantity_g = portion.grams * quantity  或  quantity
5. 寫入 meal_items.food_revision_id = food.current_revision_id
```

> **API 收 `food_id`，永遠不收 `food_revision_id`。** 理由見前面的陷阱 2 ——
> 讓呼叫端指定版本，等於開一條繞過審核流程去讀未審核營養素的路。
> 這條路不在 `foods.py` 裡，在這裡。

營養素換算集中在 `app/nutrition.py`，**那個 `100` 只能出現在這一個檔案**：

```python
BASE_AMOUNT = Decimal(100)

def scale(revision: FoodRevision, quantity_g: Decimal) -> Macros:
    factor = quantity_g / BASE_AMOUNT
    return Macros(
        kcal=(revision.kcal * factor).quantize(Decimal("0.01"), ROUND_HALF_UP),
        ...
    )
```

> **總計取「各項四捨五入後的和」，不是「精確和再四捨五入」。**
> 兩者可能差一分，但前者保證使用者看到的每一項加起來**等於**看到的總計。
> 對一個給人看的營養數字，自洽比小數點第三位的精確度重要。
> 這是刻意的取捨，測試要把它釘住（一個「各項相加等於總計」的斷言）。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（156）。Commit: `feat: 新增建立餐點的 API`

#### Task 7 實測發現

**1. 原子性靠設計，不靠記得寫 `rollback()`。**
實作是「先把所有項目解析完（純 `SELECT`，一個 `db.add()` 都沒有），
全部通過才建立 `Meal` 與 `MealItem` 並 commit 一次」。第 3 個項目失敗時，
session 裡根本還沒有任何東西，所以**沒有東西需要回滾**。

對照組值得記：如果寫成「逐項解析、逐項 `add()` + `flush()`」，
那麼在測試環境裡（`db_session` 是整個測試共用的，`override_get_db` 沒有清理），
前兩個項目的寫入**對同一個 session 的 count 查詢仍然可見** ——
即使 API 回的是錯誤。於是「回了 404」和「什麼都沒寫進去」會脫鉤，
而只斷言狀態碼的測試看不出來。這就是為什麼那個測試要真的下 `count()`。

**2. 可見性邏輯抽成 `app/food_visibility.py`。**
`foods.py` 和 `meals.py` 現在共用同一份。這不是整理癖 ——
兩份各自演化的可見性檢查，等於日後修一個安全性 bug 只會修到一邊。

**3. 一個誠實回報的突變存活（不是覆蓋缺口）。**
「把 `quantity_g` 改成讀取時重算」這個突變**無法在本 task 施加**，
因為 `GET /api/meals/{id}` 是 Task 8 才有的東西。退而求其次施加的近似突變
（寫入前再查一次份量）**存活了全部 165 個測試**，而且是**正確的存活** ——
那次重查發生在同一個請求裡，份量還沒被改，算出來必然一樣。

> **真正危險的那個形狀（GET handler 去 join 即時的份量資料而不是信任
> `quantity_g`）要等 Task 8 才測得到，屆時必須另外寫一個讀取端的凍結測試。**
> 這裡先記下來，免得看到「Task 7 有凍結測試了」就以為讀取端也被保護了。

**4. 兩處標記為「防禦性但今天沒有測試覆蓋」的程式碼**（誠實勝於假裝）：
- `schemas/meal.py` 裡 body 層級的 `food_id` / `portion_id` 加了 `le=2**63-1`，
  比照 `ResourceId` 的理由（超大整數會讓 asyncpg 拋 `DataError` 變 500）。
  12 個測試裡沒有一個涵蓋它。
- `_load_visible_portion` 目前留在 `meals.py` 裡，只有一個呼叫者。
  **Task 12 要重用它，屆時提升到共用模組，不要複製第二份。**

---

## Task 8: `GET /api/meals/{id}`

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_read.py`

- [ ] **Step 1: 測試（5 個）**

讀自己的一餐 → 200，含項目、食物名稱、營養素總計；
讀別人的一餐 → **404**；讀不存在的 → 404（且兩者 body 逐字相同）；
沒有項目的一餐 → 200，總計全為 `"0.00"`；未認證 → 401。

- [ ] **Step 2: 實作**

用 `selectinload` 或明確的 join 一次載入項目與其 revision、food，
**不要在迴圈裡逐筆查** —— 一餐十個項目就是十一次往返。

回傳的營養素**用項目當時釘住的 `food_revision_id`**，不是食物現在的版本。
這是版本化的重點：歷史紀錄看到的是當時的數值。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（161）。Commit: `feat: 新增讀取單一餐點的 API`

---

## Task 9: `GET /api/meals?date=` —— 時區在這裡發揮作用

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_read.py`（改）

- [ ] **Step 1: 測試（7 個）**

1. 查某天，回傳該天的餐，依 `eaten_at` 排序
2. **台北時間早上 7 點的早餐，要出現在「當天」而不是前一天**
   （這一餐的 UTC 時刻是前一天 23:00，是整個時區設計的關鍵測試）
3. ~~台北時間晚上 11 點的宵夜，要出現在當天而不是隔天~~
   **這一條是空測試，實作時發現並更正為「America/New_York 晚上 11:30」。**
4. 別人的餐不會出現
5. 換一個時區的使用者（`America/New_York`），同一個 UTC 時刻落在不同的日期
6. 不給 `date` → 預設今天（用使用者時區的今天）
7. `date` 格式不合法 → 422

> 這幾個測試是「時區存在 users 表」這個決定唯一的實證。
> 如果把它們拿掉，寫死 UTC 的實作會全部通過。
>
> **但要挑對時區與時刻，否則測試是空的（Task 9 實測發現，我原本寫錯了）：**
>
> | 時區 | 情境 | 當地 | UTC | 抓得到「寫死 UTC」嗎 |
> |---|---|---|---|---|
> | Taipei (+8) | 早餐 07:00 | 09-04 07:00 | **09-03** 23:00 | ✓ |
> | Taipei (+8) | 宵夜 23:00 | 09-04 23:00 | 09-04 15:00 | **✗ 空測試** |
> | NY (−4) | 宵夜 23:30 | 09-04 23:30 | **09-05** 03:30 | ✓ |
> | NY (−4) | 早餐 07:00 | 09-04 07:00 | 09-04 11:00 | **✗ 空測試** |
>
> 通則：**UTC 以東的時區只有清晨有鑑別力，以西的時區只有深夜有鑑別力。**
> 因為往東是把當地時刻換算成「更早的 UTC」（只可能退回前一天），
> 往西則是換成「更晚的 UTC」（只可能進到隔天）。要兩個方向都測到，
> 就必須兩種時區都用 —— 只用台灣時區寫的宵夜測試，
> 對寫死 UTC 的實作**永遠是綠的**。

**另外補上的一個測試（實作後發現邊界完全沒被釘住）：**

7. **恰好落在午夜零點的一餐，只能屬於一天。**
   `end` 那一刻同時是「這一天的結束」與「隔天的開始」，
   實測 `<` 改成 `<=` 時**沒有任何一個測試失敗** —— 這個邊界原本是空的。
   在計畫 3 它只造成清單多一筆，但到了計畫 4 的每日統計，
   那一餐的熱量會被**計入兩次**，而且兩天的數字各自看起來都合理，
   不會有任何東西報錯。

- [ ] **Step 2: 實作**

```python
start, end = day_bounds(day, current_user.timezone)
stmt = select(Meal).where(
    Meal.user_id == current_user.id,
    Meal.eaten_at >= start,
    Meal.eaten_at < end,          # 半開區間，不是 <=
).order_by(Meal.eaten_at)
```

> `<` 不是 `<=`。用 `<=` 的話，恰好在午夜零點的一餐會同時屬於兩天。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（168）。Commit: `feat: 新增依日期查詢餐點的 API`

---

## Task 10: `PATCH /api/meals/{id}`

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_update.py`

- [ ] **Step 1: 測試（6 個）**

改 `note`；改 `eaten_at`（且要能讓它換到另一天）；改 `meal_type`；
只帶一個欄位時其他不動；改別人的 → 404；不合法的 `meal_type` → 422。

- [ ] **Step 2: 實作**

同 Task 3，用 `model_dump(exclude_unset=True)`。
**項目不在這個端點的範圍內**（見決定 2）。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（174）。Commit: `feat: 新增修改餐點的 API`

---

## Task 11: `DELETE /api/meals/{id}`

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_update.py`（改）

- [ ] **Step 1: 測試（4 個）**

刪自己的 → 204，再讀回 404；刪別人的 → 404 且**那一餐必須還在**
（要真的重查一次確認，不能只看狀態碼）；刪不存在的 → 404；未認證 → 401。

> 「刪別人的回 404」和「刪別人的沒有真的刪掉」是**兩件事**。
> 只斷言狀態碼的話，一個「先刪除、再檢查權限」的實作會通過測試。

- [ ] **Step 2: 實作**

`meal_items` 靠 `ON DELETE CASCADE` 一起走，不要在程式裡逐筆刪。
照片檔案的處理留到 Task 16 一起做，**這一步先只處理資料列**
（規格第 8 節：先刪 DB、檔案容許落後）。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（178）。Commit: `feat: 新增刪除餐點的 API`

---

## Task 12: 項目的增刪

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_items.py`

`POST /api/meals/{id}/items`、`DELETE /api/meals/{id}/items/{item_id}`

- [ ] **Step 1: 測試（8 個）**

加一個項目 → 201，總計跟著變；加到別人的餐 → 404；
加別人的私人食物 → 404；刪一個項目 → 204，總計跟著變；
刪別人餐裡的項目 → 404；刪不存在的項目 → 404；
**刪「別人餐裡的項目」時，那個項目必須還在**；未認證 → 401。

- [ ] **Step 2: 實作**

食物解析與 `quantity_g` 換算**重用 Task 7 抽出來的函式**，不要複製一份。
複製的話，日後修一個安全性 bug 只會修到一邊。

`item_id` 的擁有權要沿著 `meal_items.meal_id → meals.user_id` 檢查，
**不能只檢查 `item_id` 存在**。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（186）。Commit: `feat: 新增餐點項目的增刪 API`

---

## Task 13: `app/storage/photos.py` —— 檔案讀寫全部集中在這裡

**Files:** `app/storage/__init__.py`、`app/storage/photos.py`、`tests/test_photo_storage.py`

**執行前提：Pillow 必須已經裝好、`requirements-lock.txt` 必須已經更新。**
見本文件開頭的「執行前提」。

規格第 8 節：不預先抽象 storage interface，但要求所有檔案讀寫集中在單一模組。
真要換 MinIO，改動範圍就是這個檔案。

- [ ] **Step 1: 先寫測試（8 個，全部是純函式層級，不經過 HTTP）**

1. 存一張正常 JPEG → 回傳相對路徑，檔案真的存在
2. 長邊超過 1280 的圖 → 存下來的長邊**恰好是 1280**，比例不變
3. 長邊小於 1280 的圖 → **不放大**（只縮不放）
4. PNG 送進去 → 存出來是 JPEG
5. **含 GPS EXIF 的 JPEG → 存出來的檔案讀不到任何 EXIF / GPS**
6. 內容不是圖片（純文字改副檔名）→ 拋 `InvalidImageError`
7. 宣告尺寸巨大的解壓縮炸彈 → 拋 `InvalidImageError`，不是把記憶體吃光
8. `delete_photo()` 對不存在的檔案 → 不拋例外（best-effort）

> **第 5 項不是可有可無的。** 這是飲食紀錄 app，照片是在家裡和餐廳拍的，
> 手機預設會把 **GPS 座標寫進 EXIF**。原樣存下來再透過 API 發出去，
> 等於附贈一份使用者的位置歷史。用 Pillow 重新編碼時 EXIF 預設就會掉，
> 但「預設會掉」和「我驗證過它掉了」是兩回事 —— 哪天有人為了保留拍攝時間
> 而加上 `exif=img.info["exif"]`，GPS 就跟著回來了，而且不會有任何測試變紅。
> 這個測試就是為那一天存在的。

> 第 7 項要設 `Image.MAX_IMAGE_PIXELS`。Pillow 預設會對超大圖發
> `DecompressionBombWarning`，但**只是警告**。我們的測試跑在 `-W error` 下，
> 警告會變成例外 —— 這剛好幫我們，但**不要依賴它**：正式環境沒有 `-W error`。
> 要明確設上限並自己擋。

- [ ] **Step 2: 實作**

```python
def save_photo(content: bytes, *, user_id: int) -> str:
    """存檔並回傳相對於 photo_dir 的路徑。"""
```

四個要點：

- **檔名由伺服器產生**（`uuid4().hex + ".jpg"`），**永遠不用使用者送的檔名**。
  路徑穿越、覆寫別人的檔案、Windows 保留字（`CON`、`NUL`）三類問題一次解決。
- **路徑分層 `<photo_dir>/<user_id>/<uuid>.jpg`**。規格第 8 節的理由之一是
  「照片就是資料夾裡的普通檔案，可用 Synology 內建工具瀏覽與備份」——
  依使用者分資料夾才真的好瀏覽。
- **資料庫只存相對路徑**，不存絕對路徑。volume 掛載點換了不會全毀。
- **寫檔前做一次 containment 檢查**：`(photo_dir / rel).resolve()` 必須真的在
  `photo_dir.resolve()` 底下。檔名是我們自己產的，這一步理論上永遠成立 ——
  留著是因為它的成本是兩行，而它擋的那類 bug 的代價是任意檔案覆寫。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（194）。Commit: `feat: 新增照片儲存模組`

---

## Task 14: `POST /api/meals/{id}/photo`

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_photo.py`

- [ ] **Step 1: 測試（8 個）**

上傳成功 → 200，`photo_path` 有值；上傳到別人的餐 → 404；
非圖片 → 422；超過大小上限 → 413；未認證 → 401；
**重複上傳會取代舊的，且舊檔案被刪掉**；
上傳後 `GET /api/meals/{id}` 看得到有照片；`multipart` 缺欄位 → 422。

- [ ] **Step 2: 實作**

**大小上限要在讀進記憶體之前擋。** `await file.read()` 沒有上限，
一個 2GB 的上傳會直接把容器吃掉。分塊讀、累計、超過就中止。

取代舊照片的順序（**順序不能換**）：

```
1. 寫入新檔案
2. 更新 DB 的 photo_path 並 commit
3. 盡力刪除舊檔案（失敗就算了）
```

規格第 8 節：兩種孤兒的嚴重性不對稱 —— 多一個沒人引用的檔案只是浪費磁碟，
少一個被引用的檔案是壞掉的功能。所以**先確保 DB 正確，容許檔案暫時落後**。
若在第 2 步之前就刪舊檔，而第 2 步失敗，使用者的照片就沒了。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（202）。Commit: `feat: 新增餐點照片上傳的 API`

#### Task 13 / 14 實測發現

**1. 測試套件的 `-W error` 會遮蔽正式環境缺少防護這件事。**（本計畫最重要的一個發現）

計畫裡預先警告過「不要依賴 `-W error` 幫你擋解壓縮炸彈」，實測把明確的
`width * height > MAX_IMAGE_PIXELS` 檢查拿掉之後，證實了這件事，而且比預期更尖銳：

| 突變：拿掉明確的像素上限檢查 | 結果 |
|---|---|
| `pytest -W error`（套件平常的跑法） | **8 passed，全綠** |
| `pytest -W "ignore::Warning"`（正式環境的真實條件） | **FAILED** |

Pillow 對超過 `MAX_IMAGE_PIXELS` 的圖只發 `DecompressionBombWarning`。
`-W error` 把它轉成例外，於是測試**因為錯誤的理由而通過** ——
它驗證到的是「pytest 的警告設定」，不是「應用程式的防護」。

**推論很嚴重：** 如果那個明確檢查從一開始就沒寫，而且沒有人在不帶 `-W error`
的情況下跑過，整個套件會一路全綠，而正式環境完全沒有防護。
**綠燈這次不只是沒告訴你為什麼綠 —— 它是被測試設定本身偽造出來的。**

> 可以帶走的通則：**當一個防護的失敗形式是「發出警告」時，
> `-W error` 就從測試工具變成了受測系統的一部分。**
> 這類防護的測試必須在關掉警告轉例外的條件下跑過一次，
> 否則你測的是 pytest 不是你的程式。

**2. EXIF / GPS 的測試是有鑑別力的（已驗證）。**
把 `image.save(...)` 改成帶 `exif=image.getexif().tobytes()`
（模擬未來有人為了保留拍攝時間而加上去），**恰好 1 個測試失敗**：
`test_gps_exif_does_not_survive_saving`。這正是這個測試存在的理由 ——
它守的不是今天的行為（Pillow 預設就會丟掉 EXIF），是**那一天**的行為。

**3. ruff 的 `extend-immutable-calls` 要補 `fastapi.File` 與 `fastapi.Form`。**
跟計畫 1 為 `Depends()` 加的是同一回事。這件事在派工時會卡住 ——
subagent 被禁止改 `pyproject.toml`，所以只能由主 session 處理。
**日後任何引入新 FastAPI 參數宣告方式的 task，都要預期這一步。**

---

## Task 15: `GET /api/meals/{id}/photo`

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_photo.py`（改）

- [ ] **Step 1: 測試（5 個）**

取自己的照片 → 200，`content-type: image/jpeg`，位元組與存進去的相同；
取別人的 → 404；那一餐沒有照片 → 404；未認證 → **401**；
DB 有 `photo_path` 但檔案不見了 → 404（不是 500）。

- [ ] **Step 2: 實作**

規格第 8 節：**照片不透過靜態檔案服務提供**，一律先驗 JWT 與擁有權。

> 「用不可猜的 UUID 檔名 + 公開資料夾」也是一種做法，但本質是
> 「靠對方猜不到」，網址一旦外流就永久有效。既然選了完整多使用者，
> 權限就該是真的。
>
> 具體地說：**不要為了省事而掛 `StaticFiles`**。掛上去的那一刻，
> `photo_dir` 底下的所有檔案就對所有人公開了，而且不會有任何測試變紅 ——
> 上面五個測試在掛了 StaticFiles 之後**依然全部通過**，因為它們測的是
> `/api/meals/{id}/photo` 這條路徑，不是「有沒有第二條路徑也能拿到檔案」。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（207）。Commit: `feat: 新增餐點照片讀取的 API`

---

## Task 16: `DELETE /api/meals/{id}/photo` + 刪餐時的孤兒檔案

**Files:** `app/api/routes/meals.py`（改）、`tests/test_meals_photo.py`（改）

- [ ] **Step 1: 測試（4 個）**

刪照片 → 204，`photo_path` 變 NULL，檔案不見了；
刪別人的 → 404；那一餐沒照片 → 404；
**刪整餐時照片檔案也要被清掉**。

- [ ] **Step 2: 實作**

一律「先 DB、後檔案」，檔案刪除失敗只記下來不讓請求失敗。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（211）。Commit: `feat: 新增照片刪除與餐點刪除時的檔案清理`

#### Task 15 / 16 實測發現

**1. 順序要求需要「觀察順序」的測試，端狀態測試在定義上抓不到。**

把 `DELETE .../photo` 改成「先刪檔、再 commit」（正是規格第 8 節禁止的順序），
四個功能測試**全部通過**。原因不是覆蓋不足：**在沒有任何一步失敗的情況下，
兩種順序的最終狀態完全相同** —— 檔案沒了、`photo_path` 是 NULL。
端狀態測試看不到差別，因為差別根本不在端狀態裡，在「中途失敗時會怎樣」。

抓到它的是一個 monkeypatch `commit` 與 `delete_photo`、記錄呼叫順序的測試：
`['delete', 'commit'] != ['commit', 'delete']`。

> 這跟 Task 11 的「delete-before-check」是同一族：狀態碼對、最終狀態也對，
> 錯的是**中間發生了什麼**。凡是規格寫成「先 A 後 B」的要求，
> 就要有一個測試真的去看 A 和 B 的先後，而不是看做完之後長什麼樣。

**2. 「有沒有第二條無認證的路徑」——端點測試在原理上測不到，但路由表可以。**

如果日後有人為了方便把 `StaticFiles` 掛在 `photo_dir` 上，
Task 15 的五個測試**全部照樣通過** —— 它們打的是 `/api/meals/{id}/photo`，
沒有任何一個會去問「是不是還有別條路也拿得到這個檔案」。
猜路徑去打是個假陰性陷阱：猜不中證明不了什麼，猜中了也只證明那一條。

可行的做法是**路由表內省**：走訪 `app.routes`，斷言沒有任何一個路由的
`.app` 是 `StaticFiles` 實例。這是針對「計畫描述的那個具體陷阱」的窄守衛，
不是「未來所有無認證端點」的通則保證 —— 後者是程式碼審查與 Task 18 的事。
測試的 docstring 要把這個界線寫清楚，不要讓它看起來保證了它沒保證的東西。

**3. 突變測試的還原紀律（同一個坑，兩種形狀，都踩過了）。**

- 形狀 A（Task 13/14）：從**手工副本**還原，而那份副本是在某個修正之前取的，
  於是還原時把修正靜默地蓋掉了。
- 形狀 B（Task 15）：用 `git checkout HEAD -- <file>` 還原，但 `HEAD` 早於
  本 task 的功能提交 —— **這不是還原突變，是把整個功能刪掉**。

**規則：`HEAD` 只有在受測功能「已經提交」之後才是安全的還原目標。**
還沒提交就要做突變測試時，先 `git add` 把已驗證的實作放進索引，
然後用 `git checkout -- <file>`（從索引還原）。
每次還原後都要 `git diff --stat app/` 確認乾淨。

---

## Task 17: `GET /api/foods/frequent` 與 `/api/foods/recent`

**Files:** `app/api/routes/foods.py`（改）、`tests/test_foods_frequent.py`

規格第 11 節：這是使用者每天走最多次的路徑。

- [ ] **Step 1: 測試（8 個）**

`frequent` 依次數多到少排序；`recent` 依最後一次吃的時間新到舊；
兩者都只看自己的餐；兩者都回傳食物**目前的版本**而不是當時釘住的版本；
同一個食物在多餐出現只回傳一次；沒有任何紀錄時回空陣列；
`limit` 參數生效；未認證 → 401。

> 「回傳目前的版本」是刻意的，跟 `GET /api/meals/{id}` 相反。
> 那裡看的是歷史（當時吃的是什麼），這裡是要**再記一筆**，
> 所以要用最新的營養素資料。兩個端點對同一個食物給不同數字是正確的，
> 測試要把這件事釘住，否則日後有人會「順手統一」而破壞其中一邊。

- [ ] **Step 2: 實作**

`frequent`：`meal_items` join `meals`（`user_id` 過濾）join `food_revisions`
取 `food_id`，`GROUP BY foods.id`、`ORDER BY count(*) DESC`、`LIMIT`。
`recent`：同樣的 join，改成 `GROUP BY foods.id`、`ORDER BY max(meals.eaten_at) DESC`。

規格第 6.6 節：**P1 用查詢 + 索引解決，不建快取表。** 等實際量到慢再優化。

> **實測更正（Task 17）：** 上面原本寫「`ix_meal_items_food_revision_id` 與
> `ix_meals_user_id_eaten_at` 就是為此存在的」。前者是錯的。
>
> `EXPLAIN` 在兩種資料規模下（10,500 與 610,500 筆 `meal_items`）都顯示：
>
> - `ix_meals_user_id_eaten_at`：**有用到**，兩種規模都是 Bitmap Index Scan。
>   選擇性完全來自 `meals.user_id`。
> - `ix_meal_items_food_revision_id`：**兩種規模都沒用到**。大資料量時
>   `meal_items` 確實改走索引，但走的是 `ix_meal_items_meal_id`
>   （原本為 `GET /api/meals/{id}` 建的）。
>
> 原因很單純：這個查詢對 `food_revision_id` **沒有任何過濾條件**，
> 它只是 join key。全 codebase 搜過，`food_revision_id` 一律只出現在
> `join(...)` 裡，沒有一處是 `WHERE`。
>
> **但這個索引不該刪。** 它真正的消費者是規格決策 3 提到的 P2 功能：
> 「你這筆紀錄引用的食物資料已更新，要套用新版本嗎？」——
> 那個功能要反查「哪些 `meal_items` 引用了這一版」，正是
> `WHERE food_revision_id = ?`。
>
> 所以結論是**理由要改，索引留著**：它不是為 frequent/recent 建的，
> 是為版本更新提示建的。留著一個沒有消費者的索引要付寫入成本，
> 留著一個「消費者還沒寫出來」的索引則是預留 —— 兩者差別只在你說得出理由。

執行時間：小資料 1.8ms、大資料 4.9ms，單一 SQL 語句。

> **一個要誠實記下來的事：** 這兩個查詢裡的可見性過濾（`owner_id IS NULL OR
> owner_id = :me`）**今天是空轉的** —— 因為 Task 7 已經擋住了「記錄看不到的食物」，
> 所以你的餐裡不可能有看不到的食物。它抓不到任何突變，Task 18 也證明不了它。
> 保留它的理由是：日後若加上「刪除食物」或「取消分享」，這裡是唯一會漏的地方。
> **把它標成防禦性、寫明今天測不到**，比假裝它有被驗證過誠實。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（219）。Commit: `feat: 新增常吃與最近吃的 API`

#### Task 17 實測發現

**1. 兩個過濾器會互相掩護，讓突變測試看起來是綠的。**

隔離測試原本用「Alice 的**私人**食物」來驗證「Bob 的 frequent 不含 Alice 吃過的東西」。
拿掉 `Meal.user_id == user.id` 這個過濾之後 —— **零個測試失敗**。

原因是防禦性的 `Food.owner_id` 過濾把它遮住了：私人食物 Bob 本來就看不到，
所以少了 `user_id` 過濾也沒差。**測試驗證到的是錯的那個過濾器。**

改用**全域食物**（Bob 看得到，但沒吃過）之後，同一個突變讓 2 個測試失敗。

> 通則：**要測 A 過濾器，測試資料就必須讓 B 過濾器無效。**
> 兩個過濾器同時能擋住同一筆資料時，突變任一個都不會變紅。
> 這比「測試寫錯」更隱蔽 —— 測試的名字、意圖、斷言全都是對的，
> 只有**測試資料的選擇**讓它失去鑑別力。

**2. 路由宣告順序：`/{food_id}` 在前會讓 `/foods/frequent` 回 422 不是 404。**

Starlette 依宣告順序比對，`ResourceId` 解析 `"frequent"` 失敗，
吐的是 FastAPI 的標準驗證錯誤（`int_parsing`），不是路由 404 也不是端點的 404。
**具名路徑一律宣告在 `/{參數}` 之前。**

**3. 防禦性過濾確認是空轉的（誠實記錄，不補假測試）。**
把 `Food.owner_id` 過濾整個拿掉，**全部 243 個測試通過**。
因為 `POST /api/meals` 已經擋住「記錄看不到的食物」，所以你的餐裡不可能有
看不到的食物。保留它是為了日後的「刪除食物 / 取消分享」，
但**今天它抓不到任何突變，Task 18 也證明不了它**。
不寫看起來有覆蓋的測試 —— 那會讓缺口變得不可見。

---

## Task 18: 跨使用者隔離總掃描 + 突變測試

**Files:** `tests/test_cross_user_isolation.py`（改）

計畫 2 建立的那份集中清單，**每一個會碰到使用者資料的端點都要有一筆**。
本計畫新增了 12 個端點，全部要進去。

- [ ] **Step 1: 為新端點各加一筆（10 個）**

`GET /api/meals/{id}`、`PATCH`、`DELETE`、`POST .../items`、
`DELETE .../items/{item_id}`、`POST .../photo`、`GET .../photo`、
`DELETE .../photo`，各一筆「Bob 拿 Alice 的 id 去打 → 404」。

再加兩筆結構性的：
- `GET /api/meals?date=` 回傳的清單裡不含 Alice 的餐
- `GET /api/foods/frequent` 不含 Alice 吃過但 Bob 沒吃過的食物

**還要補一筆 `/api/me` 的**（Task 3 實測發現的缺口）：
建立 Alice 與 Bob 兩個使用者，用 Bob 的 token 打 `PATCH /api/me`，
然後斷言 **Alice 那一列完全沒變**。

> 這個端點沒有路徑參數，使用者 id 只來自 token，直覺會覺得不可能寫錯。
> 但 Task 3 實測過：把 handler 改成寫 `user.id - 1` 那一列，
> **全部 153 個測試照樣通過**，Bob 的請求靜默地覆寫了 Alice 的資料、回 200。
> 沒有路徑參數消除的是**惡意輸入**這條路，不是**程式寫錯**那條。
> 隔離測試要守的是後者。

- [ ] **Step 2: 突變測試 —— 這是本 task 真正的交付物**

**這些測試寫完就是綠的，所以在被弄壞之前不算證據。**
計畫 2 的教訓：只突變一個執行點，會讓一半的測試從頭到尾沒被驗證過。
本計畫的可見性執行點至少有這些，**每一個都要單獨突變、單獨還原**：

| 突變 | 位置 |
|---|---|
| M1 | 載入餐點時的 `Meal.user_id == user.id` |
| M2 | 載入項目時沿著 `meal_items.meal_id → meals.user_id` 的檢查 |
| M3 | Task 7 建立項目時的食物可見性檢查 |
| M4 | Task 7 的份量可見性檢查 |
| M5 | 照片端點的擁有權檢查（若與 M1 是同一段程式，明說並合併） |
| M6 | `GET /api/meals?date=` 的 `user_id` 過濾 |
| M7 | `frequent` / `recent` 的 `user_id` 過濾 |

每次突變**跑全套**，交出「哪些測試抓到哪個突變」的矩陣。

**任何一個突變存活（零個測試失敗）都是最重要的發現，要大聲回報，
不要補一個測試把它蓋掉就當沒事。** 存活代表那條路徑今天沒有被覆蓋。

還原後用 `git diff --stat app/` 確認 `app/` 與 HEAD 逐位元組相同。

- [ ] **Step 3: 驗收 + commit**

`pytest -W error`（232）。Commit: `test: 餐點與照片端點加入跨使用者隔離掃描`

---

## 完成驗收

每一項都要親自跑過並看到預期結果：

- [x] `alembic downgrade 0002` 後再 `alembic upgrade head`，兩次都成功
      （對 `wallet_test`，dev 的 `wallet` 全程留在 0002 沒被動）
- [x] `alembic check` → `No new upgrade operations detected.`
- [x] `pytest -v -W error` → **254 passed**（門檻 220）
- [x] `ruff check .` → `All checks passed!`
- [x] `mypy app` → `Success: no issues found in 35 source files`
- [x] `pytest --cov=app --cov-fail-under=80` → **97.64%**
- [x] OpenAPI 列出 **28 個操作**（估 27，多的是超出規格的 `PATCH /api/me`）

      > 內省的坑：這個 FastAPI 版本把 `include_router` 的結果存成
      > `_IncludedRouter` 包裝物，**不攤平進 `app.routes`**。
      > 走訪 `app.routes` 只會看到 4 個 docs 路由，看起來像一個端點都沒註冊。
      > 要數端點就讀 `app.openapi()`，那才是權威來源。
      >
      > 這也讓 Task 15 那個「路由表裡沒有 StaticFiles」的守衛有個已知界線：
      > 它只看得到頂層路由。`app.mount()` 確實會加到頂層，所以那個具體陷阱
      > 仍然守得住，但掛在被 include 的 router 裡面的 mount 它看不到。

- [x] `pg_constraint` 裡 `meals` / `meal_items` 共 **9 個約束、0 個違規**
- [x] Task 18 的**八個**突變全部被抓到，**無一存活**
- [x] **端到端走一次含 GPS 的照片**（上傳與下載都走真實 API）：

      | | 上傳前 | 下載後 |
      |---|---|---|
      | 尺寸 | 3000×2000 | **1280×853** |
      | 位元組 | 94,810 | 17,909 |
      | EXIF 標籤 | 3 | **0** |
      | GPS 標籤 | 4（25°02'N, 121°33'E） | **0** |
      | 相機型號 | `'ACME Phone'` | `None` |

---

## 這份計畫刻意不做的事

- **AI 分析**（P2）。但 `food_revisions` 的 `source` / `ai_confidence` /
  `ai_raw_response` 三個欄位已經在計畫 2 建好了，資料模型是相容的。
- **補劑、目標、統計**（計畫 4）。
- **照片縮圖**。清單頁載入 30 張 1280px 的圖會慢，但那是 P3 前端量到再說的事，
  現在做就是猜。
- **背景孤兒檔案清理工作**（規格第 8 節提到）。P4 部署時一起做，
  因為它牽涉排程與容器生命週期。
- **`meal_items` 的修改端點**。改數量 = 刪掉再加。若 P3 前端做起來很痛，
  再回頭補一個 `PATCH`。

---

## 下一步

計畫 4：補劑（`supplements` / `supplement_plans` / `supplement_intakes`）、
目標（`user_targets`）、統計（`/api/stats/daily`、`/api/stats/range`）。

`day_bounds()` 到那時會被大量重用 —— 每日統計的切法必須跟
`GET /api/meals?date=` 完全一致，否則同一天的餐點數和統計數會對不起來。
