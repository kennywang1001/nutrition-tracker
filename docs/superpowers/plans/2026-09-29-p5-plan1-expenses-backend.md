# P5 計畫一：記帳模組後端 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓使用者能記錄生活花費、在記一餐時順手記下餐費，並查詢「這個月花了多少、花在哪」。

**Architecture:** 一張獨立的 `expenses` 表，餐費透過 nullable 的 `meal_id` 掛在餐點上（`ON DELETE SET NULL`，刪餐點不刪錢）。分類是寫死的 `StrEnum` + 手寫 `CheckConstraint`。月份邊界一律走 `app/days.py` 的新函式，不在路由層自己算日期。

**Tech Stack:** FastAPI · SQLAlchemy 2.0 async · asyncpg · Alembic · Pydantic v2 · pytest（`asyncio_mode=auto`）· httpx `ASGITransport`

**依據規格：** `docs/superpowers/specs/2026-09-28-p5-expenses-design.md`

---

## 執行環境（Task 1 實測修正）

- **venv 不在 PATH 上。** 所有指令都要用 `./.venv/Scripts/python.exe -m ...`，
  不是 `python -m ...`。計畫原本寫錯，已全數更正。
- **不要跑 `ruff format --check`。** CI 只跑 `ruff check .` 與 `mypy app`
  （`.github/workflows/ci.yml:90,93`）。master 上有 40 個既有檔案不符合
  `ruff format`，把它當驗收條件會被既有問題擋住。
- **`ruff check` 與 `mypy` 分開跑**，不要用 `&&` 串——串起來時前面失敗會讓
  後面根本沒機會跑，而你會以為兩個都壞了。
- 本機 venv 是 **Python 3.13.14**，不是 3.12（`pyproject.toml` 的
  `target-version = "py312"` 指的是語法目標，不是直譯器版本）。
- 開工前的基準線：**556 passed**。Task 1 之後是 **561 passed**。

---

## 開工前必讀：這份計畫的文字沒有權威性

**這個專案最近兩份計畫，我對「哪條測試會變紅」的預測錯了 9 次。**
P3-B 計畫一 6 個任務裡錯 5 個；P2 後端 6 個任務裡有 4 個任務回報了計畫錯誤。

所以：

1. 每一個「Expected: FAIL」如果**沒有**如預期失敗，**停下來回報**，不要調整測試讓它變紅。
   綠燈本身就是發現——它代表這條測試守不住我以為它守的東西。
2. 檔案清單漏掉東西是常態（P2 漏了 compose、漏了 migration）。
   發現要改的檔案不在清單上，**停下來回報**，不要默默改。
3. 引用既有程式碼的地方（行號、函式名、既有模式）如果對不上，**以現況為準**，回報差異。

---

## 開工前已經查證過的事實

這些是我在寫這份計畫時**實際讀過原始碼**確認的，不是從記憶寫的：

| 事實 | 出處 |
|---|---|
| 最新 migration 是 `0009_add_food_revisions_source_valid.py` | `migrations/versions/` |
| migration 目錄是 `migrations/versions/`，**不是** `alembic/versions/` | `alembic.ini:8` `script_location = %(here)s/migrations` |
| `migrations/env.py` 用 `from app.models import Base` | `migrations/env.py:10` |
| → **模型沒有在 `app/models/__init__.py` 匯入的話，`alembic check` 會失敗** | 同上，`target_metadata = Base.metadata` |
| 約束命名慣例 `ck_%(table_name)s_%(constraint_name)s`，所以 `name="amount_positive"` 最終是 `ck_expenses_amount_positive` | `app/models/base.py` `NAMING_CONVENTION` |
| `day_bounds(day, tz_name)` 與 `today_in_timezone(tz_name)` 已存在，**沒有** month 版本 | `app/days.py` 全文只有這兩個函式 |
| 路徑參數用 `ResourceId = Annotated[int, Path(gt=0, lt=2**63)]` | `app/api/params.py` |
| 跨使用者存取一律走 `get_owned_or_404(...)`，回 404 不是 403 | `app/api/deps.py` |
| 測試取得授權標頭的寫法是每個測試檔自己定義 `def auth(user)` | `tests/test_supplements.py:7-8` |
| `conftest.py` 的 `migrated_database` fixture 會跑 `alembic upgrade head` **和** `alembic check` | `tests/conftest.py` |
| Decimal 在 JSON 回應裡是**字串**（`"1.00"`） | `tests/test_supplements.py` 斷言 `body["serving_size"] == "1.00"` |
| `create_meal` 只有一次 `await db.commit()`（在 `meals.py:175`） | `app/api/routes/meals.py` |

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/days.py`（改） | 多兩個純函式：`month_bounds()`、`this_month_in_timezone()`。**月份邊界只能從這裡來。** |
| `app/models/expense.py`（新） | `ExpenseCategory` enum + `Expense` model。只有資料形狀，沒有商業邏輯。 |
| `app/models/__init__.py`（改） | 匯出上面兩個——**漏了這步 `alembic check` 會紅** |
| `migrations/versions/0010_create_expenses.py`（新） | 建表 + 兩個索引 |
| `app/schemas/expense.py`（新） | 請求/回應 schema + `YEAR_MONTH_PATTERN` |
| `app/api/routes/expenses.py`（新） | 五個端點。**只有這一個檔案，不拆**——五個端點共用 `_to_response()` 與月份解析，拆開會讓它們散掉。 |
| `app/main.py`（改） | 註冊 router |
| `app/schemas/meal.py`（改） | `MealCreateRequest` 多一個 `cost` |
| `app/api/routes/meals.py`（改） | `create_meal` 在同一個交易裡建支出 |
| `tests/factories.py`（改） | `create_expense()` |
| `tests/test_days.py`（改） | `month_bounds` 的測試 |
| `tests/test_expenses_model.py`（新） | DB 層約束與 `ON DELETE SET NULL` |
| `tests/test_expenses_crud.py`（新） | 四個 CRUD 端點 + 擁有權 |
| `tests/test_expenses_summary.py`（新） | 月報表 |
| `tests/test_meals_cost.py`（新） | 記一餐帶金額 |

---

## Task 1: `month_bounds()` 與 `this_month_in_timezone()`

**Files:**
- Modify: `app/days.py`
- Test: `tests/test_days.py`

這兩個是純函式、不碰資料庫，所以排第一——後面每一個任務都依賴它們，而它們可以獨立驗證。

- [ ] **Step 1: 寫失敗的測試**

加到 `tests/test_days.py` 檔尾：

```python
def test_month_bounds_taipei_september():
    """台北 9 月 1 日 00:00 = UTC 8 月 31 日 16:00（UTC+8）。

    這條測試守的是「月初不是 UTC 月初」。如果 month_bounds 忘了帶時區、
    直接用 datetime(year, month, 1)，start 會是 2026-09-01T00:00+00:00，
    這條就會紅。
    """
    start, end = month_bounds(2026, 9, "Asia/Taipei")

    assert start == datetime(2026, 8, 31, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 9, 30, 16, 0, tzinfo=UTC)


def test_month_bounds_december_rolls_over_to_next_year():
    """12 月的下個月是**隔年**1 月。

    `month + 1` 在 12 月會變成 13，datetime(2026, 13, 1) 直接拋 ValueError。
    這是這個函式唯一會寫錯的一行，而且**一年只有一個月會錯**——
    所以這條測試必須寫死 12 月，不能用 today()。
    """
    start, end = month_bounds(2026, 12, "Asia/Taipei")

    assert start == datetime(2026, 11, 30, 16, 0, tzinfo=UTC)
    assert end == datetime(2026, 12, 31, 16, 0, tzinfo=UTC)


def test_month_bounds_is_half_open():
    """[start, end)：end 是下個月的第一刻，不是這個月的最後一刻。

    如果寫成 23:59:59，恰好落在那一秒的支出會從兩個月份都消失。
    """
    _, september_end = month_bounds(2026, 9, "Asia/Taipei")
    october_start, _ = month_bounds(2026, 10, "Asia/Taipei")

    assert september_end == october_start


def test_month_bounds_utc_user():
    start, end = month_bounds(2026, 2, "UTC")

    assert start == datetime(2026, 2, 1, 0, 0, tzinfo=UTC)
    assert end == datetime(2026, 3, 1, 0, 0, tzinfo=UTC)


def test_this_month_in_timezone_matches_today(monkeypatch):
    """用 today_in_timezone 當接縫替換，不依賴真實時鐘。

    `datetime.datetime` 是不可變的 C 型別，測試沒辦法 monkeypatch 它的 now()
    ——這正是 today_in_timezone 當初被抽成獨立函式的原因（見它的 docstring）。
    this_month_in_timezone 必須建立在它之上，才繼承得到這個接縫。
    """
    monkeypatch.setattr(days, "today_in_timezone", lambda tz_name: date(2026, 12, 31))

    assert days.this_month_in_timezone("Asia/Taipei") == (2026, 12)
```

`tests/test_days.py` 現有的 import 不含 `days` 模組本身，也不含兩個新函式。
**先讀一次那個檔案現有的 import 再改**（既有的 `day_bounds` / `datetime` 可能已經在了，
重複匯入會被 ruff 擋下）。需要補齊到至少涵蓋：

```python
from datetime import UTC, date, datetime

from app import days
from app.days import month_bounds
```

`this_month_in_timezone` **不要**直接匯入——那條測試一律用
`days.this_month_in_timezone(...)`，理由見下面。

> **注意**：`test_this_month_in_timezone_matches_today` 用 `days.this_month_in_timezone(...)`
> 而不是直接匯入的名字——monkeypatch 換掉的是**模組屬性**，而
> `this_month_in_timezone` 內部必須是 `today_in_timezone(...)` 這種**模組內查找**
> 才會看到被換掉的版本。如果實作寫成在函式外先綁定，這條會紅。

- [ ] **Step 2: 跑測試確認它失敗**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_days.py -v`

Expected: **collection error** — `ImportError: cannot import name 'month_bounds' from 'app.days'`

（不是單條 FAIL，是整個檔案匯入就失敗。這是預期的。）

- [ ] **Step 3: 實作**

在 `app/days.py` 檔尾加上：

```python
def month_bounds(year: int, month: int, tz_name: str) -> tuple[datetime, datetime]:
    """回傳該使用者當地某一個月的 UTC 起訖，半開區間 [start, end)。

    **刻意建立在 `day_bounds()` 之上，而不是自己組 datetime。** 時區轉換只有
    一份實作，這個函式就不可能跟 `day_bounds` 對「當地午夜是 UTC 幾點」
    有不同的看法——而那種不一致的具體表現，是每個月的第一筆與最後一筆支出
    跑到隔壁月去（規格 §5.4）。

    12 月的下個月是隔年 1 月。`month + 1` 會變成 13，`date(2026, 13, 1)`
    直接拋 ValueError——這是這個函式唯一會寫錯的地方，而且**一年只有一個月
    會錯**，所以測試寫死 12 月（`tests/test_days.py`）。
    """
    start, _ = day_bounds(date(year, month, 1), tz_name)
    next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
    next_start, _ = day_bounds(date(next_year, next_month, 1), tz_name)
    return start, next_start


def this_month_in_timezone(tz_name: str) -> tuple[int, int]:
    """使用者當地的「這個月」，回 (year, month)。

    給 `GET /api/expenses` 與 `GET /api/expenses/summary` 省略 `month=` 時
    當預設值用（規格 §5.3）。

    建立在 `today_in_timezone()` 之上、而且是模組內查找——理由跟那個函式的
    docstring 一樣：測試沒辦法 monkeypatch `datetime.now()`，只能替換我們
    自己的薄函式。
    """
    today = today_in_timezone(tz_name)
    return today.year, today.month
```

`app/days.py` 目前的 import 是 `from datetime import UTC, date, datetime, time, timedelta`——
`date` 已經在裡面，不用改。

- [ ] **Step 4: 跑測試確認通過**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_days.py -v`
Expected: PASS（含既有的 `day_bounds` 測試）

- [ ] **Step 5: 突變測試——證明 12 月那條真的守得住**

把實作暫時改成明顯錯的版本：

```python
    next_year, next_month = (year, month + 1)
```

Run: `./.venv/Scripts/python.exe -m pytest tests/test_days.py -v`
Expected: `test_month_bounds_december_rolls_over_to_next_year` **FAIL**（`ValueError: month must be in 1..12`），其他月份的測試照樣 PASS。

**看到它失敗之後改回來。** 沒有被觀察到失敗的綠燈不算證據。

- [ ] **Step 6: 突變測試——證明時區那條真的守得住**

把實作暫時改成：

```python
    start = datetime(year, month, 1, tzinfo=UTC)
    next_year, next_month = (year + 1, 1) if month == 12 else (year, month + 1)
    next_start = datetime(next_year, next_month, 1, tzinfo=UTC)
    return start, next_start
```

Run: `./.venv/Scripts/python.exe -m pytest tests/test_days.py -v`
Expected: `test_month_bounds_taipei_september` 與 `test_month_bounds_december_rolls_over_to_next_year` **FAIL**；`test_month_bounds_utc_user` 與 `test_month_bounds_is_half_open` 照樣 PASS。

> **`test_month_bounds_is_half_open` 在這個突變下仍然綠，這是預期的、也是重點**：
> 那條測試守的是「半開區間」，不是「時區」。一條測試守一件事。

**改回來。**

- [ ] **Step 7: 靜態檢查**

Run: `./.venv/Scripts/python.exe -m ruff check app tests`
Run: `./.venv/Scripts/python.exe -m mypy app`
Expected: 兩者都通過

> **分開跑，而且不要跑 `ruff format --check`。** CI 實際上只跑 `ruff check .` 與
> `mypy app`（`.github/workflows/ci.yml:90,93`）——`ruff format --check` 從來不是
> 這個專案的閘門，而且在目前的 master 上有 40 個既有檔案不符合它。
> 把它寫進驗收條件是計畫的錯（Task 1 的實作者發現並回報）。

- [ ] **Step 8: Commit**

```bash
git add app/days.py tests/test_days.py
git commit -m "feat(days): 加上 month_bounds 與 this_month_in_timezone

建立在 day_bounds/today_in_timezone 之上，不自己組 datetime——
時區轉換只有一份實作，就不可能跟既有函式對「當地午夜是 UTC 幾點」
有不同的看法。

12 月進位寫死在測試裡：那一行是唯一會寫錯的地方，而且一年只有一個月
會錯，用 today() 當測資的話 11 個月都沒有鑑別力。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 2: `Expense` 模型、migration、測試工廠

**Files:**
- Create: `app/models/expense.py`
- Modify: `app/models/__init__.py`
- Create: `migrations/versions/0010_create_expenses.py`
- Modify: `tests/factories.py`
- Test: `tests/test_expenses_model.py`

- [ ] **Step 1: 寫模型**

Create `app/models/expense.py`:

```python
import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Numeric,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ExpenseCategory(enum.StrEnum):
    """寫死的分類清單（規格 §3.2）。

    **不做成使用者自訂是刻意的。** 這個專案已經連續兩次踩到同一個坑：
    食物與補劑都是「後端蓋好了，但前端沒有任何地方可以新增」。分類如果
    做成使用者自訂，那會是第三次——而且更糟，因為「沒有分類可選」會讓
    記帳從第一天就不能用。

    **這份清單是猜的，一定會錯**（規格 §3.4）。改它是一行 enum + 一個
    只改 CheckConstraint 的 migration，既有資料不動。
    """

    FOOD = "food"
    TRANSPORT = "transport"
    DAILY = "daily"
    ENTERTAINMENT = "entertainment"
    MEDICAL = "medical"
    HOUSING = "housing"
    OTHER = "other"


class Expense(Base):
    """一筆花費。餐費透過 `meal_id` 掛在餐點上，但不依附於它。"""

    __tablename__ = "expenses"
    __table_args__ = (
        # native_enum=False + create_constraint=False + 這裡手寫一個一般的
        # CheckConstraint —— 跟 meal.py 的 MealType、ai_analysis.py 的
        # AnalysisKind 同一套，**不是** food.py / user.py 那種原生 PG enum。
        #
        # 兩個理由：
        # 1. handover §7：create_constraint=True 產生的是 type-bound CHECK，
        #    alembic 的比對器把它排除在 model 那一側，但 reflection 讀回來的
        #    是普通 CHECK ——兩側永遠對不上，alembic check 每次報漂移。
        # 2. **更直接**：這張表預期會改分類（規格 §3.4）。原生 PG enum 加值
        #    要 ALTER TYPE ... ADD VALUE，而那個語句不能在交易區塊內執行，
        #    alembic migration 預設就跑在交易裡。
        #
        # 也因此：**只寫 create_constraint=False 卻忘了手寫這個 CheckConstraint，
        # 等於完全沒有約束** ——資料庫會收任何字串，而所有靜態檢查與既有測試
        # 都是綠的，因為沒有一條會去 INSERT 非法值。
        CheckConstraint(
            "category IN ('food', 'transport', 'daily', 'entertainment',"
            " 'medical', 'housing', 'other')",
            name="category_valid",
        ),
        # 不收 0 也不收負數。負數等於退款/收入，那是範圍外（規格 §2.4、§8）。
        #
        # 這個約束是「範圍外」在資料庫層的具體表現：將來要做退款時它會擋住你，
        # 逼你回來重新想，而不是讓一筆負數安靜地混進月報表。
        CheckConstraint("amount > 0", name="amount_positive"),
        # 月報表唯一會用到的索引：
        # WHERE user_id = ? AND spent_at >= ? AND spent_at < ?
        #
        # 順序是 (user_id, spent_at) 不是反過來——篩選力來自 user_id，跟
        # ai_analyses 的 (user_id, created_at) 同一個理由：反過來的話，
        # 全部使用者的列都散在同一段時間範圍裡，前導欄位篩不掉任何列。
        Index("ix_expenses_user_id_spent_at", "user_id", "spent_at"),
        # 為了「這一餐花了多少」的反查，以及 ON DELETE SET NULL 本身——
        # 沒有這個索引，每刪一筆 meal 都要全表掃描 expenses。
        Index("ix_expenses_meal_id", "meal_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # **ON DELETE SET NULL，不是 CASCADE。** 你刪掉一筆記錯的餐點，
    # 那筆錢還是花了（規格 §2.3）。CASCADE 會讓月結算少一筆，
    # 而且不會有任何地方告訴你少了。
    meal_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="SET NULL")
    )
    category: Mapped[ExpenseCategory] = mapped_column(
        Enum(
            ExpenseCategory,
            name="expense_category",
            native_enum=False,
            create_constraint=False,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    # numeric(10,2)，絕不用 float。錢跟營養素同一條規則，但更嚴格：
    # 0.1 + 0.2 != 0.3 在營養素上是四捨五入的小問題，在錢上是對不起來的帳。
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    # timestamptz 不是 date：「這筆算哪個月」必須走使用者時區，由後端決定
    # （P1 陷阱 1）。存 date 的話時區資訊在寫入當下就永久遺失。
    spent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
```

- [ ] **Step 2: 匯出模型**

Modify `app/models/__init__.py` —— 加一行 import、兩個 `__all__` 條目：

```python
from app.models.expense import Expense, ExpenseCategory
```

`__all__` 裡加 `"Expense"` 與 `"ExpenseCategory"`（清單是字母序，放在 `"BaseUnit"` 之後、`"Food"` 之前）。

> **這一步漏掉的話 `alembic check` 會紅**，而且錯誤訊息是「偵測到多出來的
> 資料表 expenses」——看起來像 migration 寫錯，實際上是模型沒進 metadata。
> `migrations/env.py:10` 是 `from app.models import Base`，只認這個檔案匯入過的東西。

- [ ] **Step 3: 寫 migration**

Create `migrations/versions/0010_create_expenses.py`:

```python
"""create expenses

Revision ID: 0010
Revises: 0009
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "expenses",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("meal_id", sa.BigInteger, nullable=True),
        # native_enum=False：VARCHAR + CHECK，CHECK 由下面自己宣告的
        # CheckConstraint 負責（見 app/models/expense.py 的註解）。
        sa.Column(
            "category",
            sa.Enum(
                "food",
                "transport",
                "daily",
                "entertainment",
                "medical",
                "housing",
                "other",
                name="expense_category",
                native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("spent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_expenses"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_expenses_user_id_users", ondelete="CASCADE"
        ),
        # SET NULL，不是 CASCADE：刪餐點不刪錢（規格 §2.3）。
        sa.ForeignKeyConstraint(
            ["meal_id"], ["meals.id"], name="fk_expenses_meal_id_meals", ondelete="SET NULL"
        ),
        # 注意：name= 是 NAMING_CONVENTION 的 %(constraint_name)s 樣板輸入，
        # 不是最終名稱（最終是 ck_expenses_category_valid / ck_expenses_amount_positive）
        # ——跟 migrations/0004、0008 的寫法一致。
        sa.CheckConstraint(
            "category IN ('food', 'transport', 'daily', 'entertainment',"
            " 'medical', 'housing', 'other')",
            name="category_valid",
        ),
        sa.CheckConstraint("amount > 0", name="amount_positive"),
    )
    op.create_index("ix_expenses_user_id_spent_at", "expenses", ["user_id", "spent_at"])
    op.create_index("ix_expenses_meal_id", "expenses", ["meal_id"])


def downgrade() -> None:
    op.drop_table("expenses")
```

- [ ] **Step 4: 加測試工廠**

Modify `tests/factories.py` —— 在 `create_target` 之後加：

```python
# 固定時刻，不用 datetime.now()：依賴月界線的測試會因為「現在是幾月」
# 隨機失敗，跟 _DEFAULT_EATEN_AT 是同一個理由。
# 刻意挑 12 月：12 月進位是 month_bounds 唯一會寫錯的地方（見 app/days.py）。
_DEFAULT_SPENT_AT = datetime(2026, 12, 15, 12, 0, tzinfo=UTC)


async def create_expense(
    db_session: AsyncSession,
    *,
    user: User,
    amount: Decimal | int = 100,
    category: ExpenseCategory = ExpenseCategory.OTHER,
    spent_at: datetime | None = None,
    note: str | None = None,
    meal: Meal | None = None,
) -> Expense:
    """建立一筆支出。

    `category` 預設 OTHER 而不是 FOOD：FOOD 是「從記一餐建出來的」那條路徑
    的專屬分類，工廠預設用它會讓「手動記的花費」與「餐費」在測試裡混在一起。
    """
    expense = Expense(
        user_id=user.id,
        meal_id=meal.id if meal is not None else None,
        category=category,
        amount=Decimal(amount),
        spent_at=spent_at or _DEFAULT_SPENT_AT,
        note=note,
    )
    db_session.add(expense)
    await db_session.commit()
    await db_session.refresh(expense)
    return expense
```

`tests/factories.py` 的 import 要加：

```python
from app.models.expense import Expense, ExpenseCategory
```

- [ ] **Step 5: 寫失敗的測試**

Create `tests/test_expenses_model.py`:

```python
"""資料庫層的約束與外鍵行為。

刻意不透過 API：這裡測的是 **PostgreSQL 真的會不會擋**，而 API 層的
Pydantic 驗證會在請求到達資料庫之前就攔下大部分非法值——透過 API 測
約束，測到的是 Pydantic，不是約束。
"""

from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select, text
from sqlalchemy.exc import IntegrityError

from app.models.expense import Expense, ExpenseCategory
from tests.factories import create_expense, create_meal, create_user


async def test_amount_must_be_positive(db_session):
    """ck_expenses_amount_positive 真的擋得住 0。

    注意這裡繞過了 Pydantic（直接建 ORM 物件）——那正是重點：
    約束是第二道防線，第二道防線要能獨立成立。
    """
    user = await create_user(db_session)
    db_session.add(
        Expense(
            user_id=user.id,
            category=ExpenseCategory.OTHER,
            amount=Decimal("0"),
            spent_at=datetime(2026, 12, 15, 12, 0, tzinfo=UTC),
        )
    )

    with pytest.raises(IntegrityError):
        await db_session.commit()

    await db_session.rollback()


async def test_amount_must_not_be_negative(db_session):
    user = await create_user(db_session)
    db_session.add(
        Expense(
            user_id=user.id,
            category=ExpenseCategory.OTHER,
            amount=Decimal("-1"),
            spent_at=datetime(2026, 12, 15, 12, 0, tzinfo=UTC),
        )
    )

    with pytest.raises(IntegrityError):
        await db_session.commit()

    await db_session.rollback()


async def test_category_check_constraint_rejects_unknown_value(db_session):
    """用原生 SQL 塞一個不在清單裡的分類。

    **不能用 ORM 塞**：SQLAlchemy 的 Enum 型別會在送出之前就自己擋下來，
    那樣測到的是 SQLAlchemy，不是資料庫的 CHECK——而 create_constraint=False
    的情況下，「忘記手寫 CheckConstraint」的症狀正好是資料庫什麼都收，
    只有繞過 ORM 才看得見。
    """
    user = await create_user(db_session)

    with pytest.raises(IntegrityError):
        await db_session.execute(
            text(
                "INSERT INTO expenses (user_id, category, amount, spent_at)"
                " VALUES (:user_id, 'crypto', 100, :spent_at)"
            ),
            {"user_id": user.id, "spent_at": datetime(2026, 12, 15, 12, 0, tzinfo=UTC)},
        )

    await db_session.rollback()


async def test_deleting_a_meal_keeps_the_expense_and_nulls_meal_id(db_session):
    """規格 §2.3 的核心主張：刪掉餐點，錢還在。

    **先斷言刪之前 meal_id 真的有值。** 少了這一步，就算 meal 跟 expense
    根本沒有連起來，這條測試也會綠——它會「證明」一個從來沒發生過的
    CASCADE 沒有發生。
    """
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    expense = await create_expense(db_session, user=user, meal=meal, amount=250)

    assert expense.meal_id == meal.id  # 前提：兩者真的連著

    await db_session.delete(meal)
    await db_session.commit()

    remaining = await db_session.scalar(select(Expense).where(Expense.id == expense.id))
    assert remaining is not None
    assert remaining.meal_id is None
    assert remaining.amount == Decimal("250.00")


async def test_deleting_a_user_deletes_their_expenses(db_session):
    """user_id 是 CASCADE（跟 meal_id 相反）：使用者沒了，他的帳也沒有意義。"""
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)
    expense_id = expense.id

    await db_session.delete(user)
    await db_session.commit()

    remaining = await db_session.scalar(select(Expense).where(Expense.id == expense_id))
    assert remaining is None
```

- [ ] **Step 6: 跑測試確認它失敗**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_model.py -v`

Expected: **collection error** — `ModuleNotFoundError: No module named 'app.models.expense'`

如果 Step 1–4 已經做完才跑，預期是 `alembic check` 之後全部 PASS。
**這個任務的步驟順序刻意讓實作先於測試**——模型與 migration 是「形狀」，
沒有形狀就連測試檔都匯入不了。TDD 在這裡退化成「先寫形狀、再寫行為斷言」，
這是刻意的取捨，不是疏忽。

- [ ] **Step 7: 跑完整測試確認 migration 與模型一致**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_model.py tests/test_infra.py -v`

Expected: PASS。

`conftest.py` 的 `migrated_database` fixture 會跑 `alembic upgrade head` **和**
`alembic check`——**`alembic check` 是這一步真正的驗收點**：它比對
「migration 建出來的實際 schema」與「`Base.metadata`」。
兩者有任何差異（欄位型別、約束名稱、索引）都會讓整個測試 session 紅掉。

如果它報「偵測到多出來的資料表 expenses」→ Step 2 漏了。
如果它報 check constraint 漂移 → 模型或 migration 有一邊用了 `create_constraint=True`。

- [ ] **Step 8: 突變測試——證明 SET NULL 那條測試守得住**

把 `migrations/versions/0010_create_expenses.py` 的 meal FK 暫時改成 CASCADE：

```python
            ["meal_id"], ["meals.id"], name="fk_expenses_meal_id_meals", ondelete="CASCADE"
```

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_model.py -v`

Expected: `test_deleting_a_meal_keeps_the_expense_and_nulls_meal_id` **FAIL**
（`assert remaining is not None` 掛掉）。

> 如果它沒紅，**停下來回報**——最可能的原因是 `alembic check` 先擋下來了
> （模型還是 SET NULL、migration 是 CASCADE，兩邊不一致），
> 那樣整個 session 會在 fixture 就錯，而不是那一條測試紅。
> 那也是有效的資訊，但不是這個突變要驗證的東西：
> 這時候把**模型**也一起改成 CASCADE 再跑一次。

**改回來（模型與 migration 兩邊都要）。**

- [ ] **Step 9: 靜態檢查**

Run: `./.venv/Scripts/python.exe -m ruff check app tests`
Run: `./.venv/Scripts/python.exe -m mypy app`
Expected: 兩者都通過

> **分開跑，而且不要跑 `ruff format --check`。** CI 實際上只跑 `ruff check .` 與
> `mypy app`（`.github/workflows/ci.yml:90,93`）——`ruff format --check` 從來不是
> 這個專案的閘門，而且在目前的 master 上有 40 個既有檔案不符合它。
> 把它寫進驗收條件是計畫的錯（Task 1 的實作者發現並回報）。

- [ ] **Step 10: Commit**

```bash
git add app/models/expense.py app/models/__init__.py migrations/versions/0010_create_expenses.py tests/factories.py tests/test_expenses_model.py
git commit -m "feat(expenses): expenses 資料表與模型

meal_id 是 ON DELETE SET NULL 不是 CASCADE——刪掉一筆記錯的餐點時，
那筆錢還是花了。CASCADE 會讓月結算少一筆而且不會有任何地方說。

category 用 native_enum=False + 手寫 CheckConstraint（meal.py 那一套，
不是 food.py 的原生 PG enum）：這張表預期會改分類，而 ALTER TYPE
不能在 alembic 的交易區塊裡跑。

SET NULL 的測試先斷言「刪之前 meal_id 真的有值」——少了那一步，
兩者根本沒連起來時這條測試也會綠。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 3: Schema 與 `POST` / `GET` 清單

**Files:**
- Create: `app/schemas/expense.py`
- Create: `app/api/routes/expenses.py`
- Modify: `app/main.py`
- Test: `tests/test_expenses_crud.py`

- [ ] **Step 1: 寫失敗的測試**

Create `tests/test_expenses_crud.py`:

```python
from datetime import UTC, datetime

from sqlalchemy import func, select

from app.models.expense import Expense, ExpenseCategory
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_create_expense_returns_the_expense(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={
            "amount": "250.50",
            "category": "transport",
            "spent_at": "2026-12-15T12:00:00+08:00",
            "note": "高鐵",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["amount"] == "250.50"
    assert body["category"] == "transport"
    assert body["note"] == "高鐵"
    assert body["meal_id"] is None


async def test_create_expense_requires_authentication(client):
    response = await client.post(
        "/api/expenses",
        json={"amount": "1", "category": "other", "spent_at": "2026-12-15T12:00:00+08:00"},
    )

    assert response.status_code == 401


async def test_create_expense_rejects_zero_amount(client, db_session):
    """Pydantic 的 gt=0 是第一道防線，資料庫的 CHECK 是第二道
    （tests/test_expenses_model.py）。兩道都要有。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={"amount": "0", "category": "other", "spent_at": "2026-12-15T12:00:00+08:00"},
    )

    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_create_expense_rejects_unknown_category(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/expenses",
        headers=auth(user),
        json={"amount": "1", "category": "crypto", "spent_at": "2026-12-15T12:00:00+08:00"},
    )

    assert response.status_code == 422


async def test_list_expenses_defaults_to_this_month(client, db_session, monkeypatch):
    """省略 month 時是「使用者時區的這個月」（規格 §5.3）。

    monkeypatch 的目標是 **routes 模組裡的名字**，不是 app.days 裡的——
    路由是 `from app.days import this_month_in_timezone` 匯入的，
    換掉 app.days 那一份不會影響已經綁好的參照。
    """
    from app.api.routes import expenses as expenses_route

    monkeypatch.setattr(expenses_route, "this_month_in_timezone", lambda tz_name: (2026, 12))

    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 預設 2026-12-15
    await create_expense(
        db_session, user=user, amount=999, spent_at=datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
    )

    response = await client.get("/api/expenses", headers=auth(user))

    assert response.status_code == 200
    amounts = [item["amount"] for item in response.json()]
    assert amounts == ["100.00"]


async def test_list_expenses_accepts_explicit_month(client, db_session):
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15

    response = await client.get("/api/expenses?month=2026-12", headers=auth(user))

    assert response.status_code == 200
    assert [item["amount"] for item in response.json()] == ["100.00"]


async def test_list_expenses_rejects_year_zero(client, db_session):
    """month=0000-01 必須是 422，不是 500。

    `date(0, 1, 1)` 直接拋 ValueError，那會變成一個已認證使用者就能
    觸發的 500。年份的 pattern 限定 19xx/20xx 就擋在 FastAPI 層。
    """
    user = await create_user(db_session)

    response = await client.get("/api/expenses?month=0000-01", headers=auth(user))

    assert response.status_code == 422


async def test_list_expenses_rejects_month_thirteen(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/expenses?month=2026-13", headers=auth(user))

    assert response.status_code == 422


async def test_list_expenses_only_returns_my_own(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_expense(db_session, user=alice, amount=100)
    await create_expense(db_session, user=bob, amount=200)

    response = await client.get("/api/expenses?month=2026-12", headers=auth(alice))

    assert response.status_code == 200
    assert [item["amount"] for item in response.json()] == ["100.00"]
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: 全部 FAIL，`404 Not Found`（router 還沒註冊）；
`test_list_expenses_defaults_to_this_month` 是 `ModuleNotFoundError`。

- [ ] **Step 3: 寫 schema**

Create `app/schemas/expense.py`:

```python
from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.models.expense import ExpenseCategory

# `YYYY-MM`。年份刻意限定 19xx/20xx 而不是 `\d{4}`：
# `date(0, 1, 1)` 會拋 ValueError，那是一個已認證使用者用
# `?month=0000-01` 就能觸發的 500。月份限定 01–12，同理
# （`date(2026, 13, 1)` 一樣拋 ValueError）。
#
# **擋在這一層而不是路由層**，是因為 FastAPI 對 Query 的 pattern 不符
# 會自動回 422 並帶上清楚的 loc/msg；自己在路由裡 parse 再 raise
# 要多寫一段，而且容易漏掉其中一種。
YEAR_MONTH_PATTERN = r"^(19|20)\d{2}-(0[1-9]|1[0-2])$"


class ExpenseCreateRequest(BaseModel):
    # gt=0 是第一道防線；資料庫的 ck_expenses_amount_positive 是第二道。
    # max_digits/decimal_places 對齊 numeric(10,2)：超過的話 asyncpg 會拋
    # DataError 變成未處理的 500，而不是 422。
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    category: ExpenseCategory
    spent_at: datetime
    note: str | None = Field(default=None, max_length=500)


class ExpenseUpdateRequest(BaseModel):
    """`PATCH /api/expenses/{id}`。

    跟 `MealUpdateRequest` 同一種哨兵寫法：每個欄位都是 `X | None = None`，
    `None` 代表「這次請求沒帶這個欄位」，路由用 `model_dump(exclude_unset=True)`
    決定要更新哪些。

    `amount` / `category` / `spent_at` 是 NOT NULL，顯式 `null` 必須擋在這裡——
    否則會一路流到 `setattr`，撞上 `asyncpg.NotNullViolationError` 變成
    已認證使用者就能觸發的 500（`UpdateMeRequest` 踩過的同一個坑）。
    但 Pydantic 沒辦法區分「沒帶」與「帶了 null」在同一個 `X | None` 欄位上，
    所以這裡用 `exclude_unset` + 路由層對 None 的明確檢查（見 Task 4）。

    **`meal_id` 不可改**：把一筆支出從一餐搬到另一餐沒有實際用途，
    而且是個好用的攻擊面（改成別人的 meal_id）——規格 §5.1。
    """

    amount: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
    category: ExpenseCategory | None = None
    spent_at: datetime | None = None
    note: str | None = Field(default=None, max_length=500)


class ExpenseResponse(BaseModel):
    id: int
    amount: Decimal
    category: ExpenseCategory
    spent_at: datetime
    note: str | None
    meal_id: int | None


class CategoryTotal(BaseModel):
    category: ExpenseCategory
    total: Decimal
    count: int


class ExpenseSummaryResponse(BaseModel):
    month: str
    total: Decimal
    by_category: list[CategoryTotal]
```

- [ ] **Step 4: 寫路由**

Create `app/api/routes/expenses.py`:

```python
from datetime import datetime

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import month_bounds, this_month_in_timezone
from app.db import get_db
from app.models.expense import Expense
from app.models.user import User
from app.schemas.expense import (
    YEAR_MONTH_PATTERN,
    ExpenseCreateRequest,
    ExpenseResponse,
)

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _to_response(expense: Expense) -> ExpenseResponse:
    return ExpenseResponse(
        id=expense.id,
        amount=expense.amount,
        category=expense.category,
        spent_at=expense.spent_at,
        note=expense.note,
        meal_id=expense.meal_id,
    )


def _resolve_month(month: str | None, tz_name: str) -> tuple[datetime, datetime, str]:
    """把 `?month=YYYY-MM`（或省略）換成 UTC 半開區間，外加正規化後的月份字串。

    **`GET /api/expenses` 與 `GET /api/expenses/summary` 共用這一個函式。**
    兩個端點對「這個月」如果不是同一份實作，清單跟總額會對不起來——
    而且只在月初或月底那幾個小時對不起來，是最難重現的那種（規格 §5.1）。

    `month` 的格式由 `YEAR_MONTH_PATTERN` 在 FastAPI 那一層擋掉，
    所以這裡的 `int(...)` 不需要 try/except：走到這裡的字串一定是
    19xx/20xx-01..12。
    """
    if month is None:
        year, month_number = this_month_in_timezone(tz_name)
    else:
        year, month_number = int(month[:4]), int(month[5:7])

    start, end = month_bounds(year, month_number, tz_name)
    return start, end, f"{year:04d}-{month_number:02d}"


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ExpenseResponse)
async def create_expense(
    payload: ExpenseCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpenseResponse:
    """手動記一筆花費。

    `user_id` 從 token 取，**不從 body 取**（P1 既有規則）——
    body 裡根本沒有這個欄位，所以「忘記檢查」這件事在結構上不可能發生。

    `meal_id` 一律是 NULL：從記一餐建出來的支出走 `POST /api/meals`
    的 `cost` 欄位（Task 6），不走這裡。
    """
    expense = Expense(
        user_id=user.id,
        meal_id=None,
        category=payload.category,
        amount=payload.amount,
        spent_at=payload.spent_at,
        note=payload.note,
    )
    db.add(expense)
    await db.commit()
    await db.refresh(expense)
    return _to_response(expense)


@router.get("", response_model=list[ExpenseResponse])
async def list_expenses(
    month: str | None = Query(default=None, pattern=YEAR_MONTH_PATTERN),
    limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ExpenseResponse]:
    """這個月的花費，由新到舊。

    **沒有 offset。** `limit` 是一個上限，不是分頁——跟 `foods.py` 的
    `limit` 是同一種東西。一個月的個人支出撞到 500 筆的機率極低，
    真的撞到了再說（規格 §5.1）。
    """
    start, end, _ = _resolve_month(month, user.timezone)

    rows = (
        await db.scalars(
            select(Expense)
            .where(
                Expense.user_id == user.id,
                Expense.spent_at >= start,
                Expense.spent_at < end,
            )
            .order_by(Expense.spent_at.desc(), Expense.id.desc())
            .limit(limit)
        )
    ).all()
    return [_to_response(expense) for expense in rows]
```

> **這個檔案在 Task 3 還用不到 `Decimal`、`func`、`ResourceId`、
> `Response`、`UnprocessableEntityError`** —— 它們是 Task 4、5 才會加的。
> **現在不要先匯入**：`ruff check tests app` 會因為未使用的 import 而紅
> （F401），而那個紅燈跟你正在做的事無關，只會浪費一輪。

- [ ] **Step 5: 註冊 router**

Modify `app/main.py` —— 在 `app.include_router(ai.router, prefix="/api")` 之後加一行：

```python
app.include_router(expenses.router, prefix="/api")
```

並在檔案上方的 import 加上 `expenses`（那一行是
`from app.api.routes import admin_foods, ai, auth, foods, health, me, meals, ...` 這種形式，
把 `expenses` 按字母序插進去）。

- [ ] **Step 6: 跑測試確認通過**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: 全部 PASS

- [ ] **Step 7: 突變測試——證明「只看得到自己的」那條守得住**

把 `list_expenses` 的 `Expense.user_id == user.id` 暫時刪掉。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: `test_list_expenses_only_returns_my_own` **FAIL**（會看到兩筆）。

**改回來。**

- [ ] **Step 8: 突變測試——證明年份 pattern 真的擋住 500**

把 `YEAR_MONTH_PATTERN` 暫時改成 `r"^\d{4}-\d{2}$"`。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: `test_list_expenses_rejects_year_zero` 與 `test_list_expenses_rejects_month_thirteen`
兩條都 **FAIL**，而且是 **500** 不是 422——這正是那兩條測試存在的理由。

**改回來。**

- [ ] **Step 9: 靜態檢查**

Run: `./.venv/Scripts/python.exe -m ruff check app tests`
Run: `./.venv/Scripts/python.exe -m mypy app`
Expected: 兩者都通過

> **分開跑，而且不要跑 `ruff format --check`。** CI 實際上只跑 `ruff check .` 與
> `mypy app`（`.github/workflows/ci.yml:90,93`）——`ruff format --check` 從來不是
> 這個專案的閘門，而且在目前的 master 上有 40 個既有檔案不符合它。
> 把它寫進驗收條件是計畫的錯（Task 1 的實作者發現並回報）。

- [ ] **Step 10: Commit**

```bash
git add app/schemas/expense.py app/api/routes/expenses.py app/main.py tests/test_expenses_crud.py
git commit -m "feat(expenses): POST /api/expenses 與清單端點

month 的年份限定 19xx/20xx、月份限定 01-12，擋在 FastAPI 的 pattern 層：
date(0, 1, 1) 與 date(2026, 13, 1) 都會拋 ValueError，那是已認證使用者
用 ?month=0000-01 就能觸發的 500。

清單與月報表共用 _resolve_month()——兩個端點對「這個月」如果不是同一份
實作，清單跟總額會在月初月底那幾小時對不起來。

limit 是上限不是分頁，跟 foods.py 一致。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 4: `PATCH` 與 `DELETE`

**Files:**
- Modify: `app/api/routes/expenses.py`
- Test: `tests/test_expenses_crud.py`

- [ ] **Step 1: 寫失敗的測試**

加到 `tests/test_expenses_crud.py` 檔尾：

```python
async def test_patch_expense_updates_amount(client, db_session):
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user, amount=100)

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"amount": "150.25"}
    )

    assert response.status_code == 200
    assert response.json()["amount"] == "150.25"


async def test_patch_expense_leaves_untouched_fields_alone(client, db_session):
    """只帶 amount 時，category 不能被打成預設值。

    這是哨兵寫法真正要守的東西：`model_dump(exclude_unset=True)` 如果
    寫成 `model_dump()`，沒帶的欄位會以 None 出現在 dict 裡，
    然後被 setattr 寫進 NOT NULL 欄位。
    """
    user = await create_user(db_session)
    expense = await create_expense(
        db_session, user=user, amount=100, category=ExpenseCategory.TRANSPORT
    )

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"amount": "150"}
    )

    assert response.status_code == 200
    assert response.json()["category"] == "transport"


async def test_patch_expense_can_clear_the_note(client, db_session):
    """note 是 nullable，`{"note": null}` 是合法輸入、必須放行到底。"""
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user, note="原本的備註")

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"note": None}
    )

    assert response.status_code == 200
    assert response.json()["note"] is None


async def test_patch_expense_rejects_explicit_null_on_not_null_field(client, db_session):
    """`{"amount": null}` 必須是 422，不是 500。

    amount 是 NOT NULL。顯式 null 如果流到 setattr，會撞上
    asyncpg.NotNullViolationError 變成已認證使用者就能觸發的 500
    （UpdateMeRequest 踩過的同一個坑）。
    """
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(user), json={"amount": None}
    )

    assert response.status_code == 422


async def test_patch_someone_elses_expense_is_404(client, db_session):
    """404 不是 403——403 等於告訴對方「這個 ID 存在，只是你不能看」。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    expense = await create_expense(db_session, user=alice, amount=100)

    response = await client.patch(
        f"/api/expenses/{expense.id}", headers=auth(bob), json={"amount": "1"}
    )

    assert response.status_code == 404


async def test_patch_nonexistent_expense_is_404_with_identical_body(client, db_session):
    """「不存在」與「不是你的」必須回一模一樣的東西，否則差異本身就是洩漏。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    alices_expense = await create_expense(db_session, user=alice, amount=100)

    not_mine = await client.patch(
        f"/api/expenses/{alices_expense.id}", headers=auth(bob), json={"amount": "1"}
    )
    missing = await client.patch(
        "/api/expenses/999999", headers=auth(bob), json={"amount": "1"}
    )

    assert not_mine.status_code == missing.status_code == 404
    assert not_mine.json() == missing.json()


async def test_delete_expense_removes_it(client, db_session):
    user = await create_user(db_session)
    expense = await create_expense(db_session, user=user)

    response = await client.delete(f"/api/expenses/{expense.id}", headers=auth(user))

    assert response.status_code == 204
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_delete_someone_elses_expense_is_404_and_keeps_it(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    expense = await create_expense(db_session, user=alice)

    response = await client.delete(f"/api/expenses/{expense.id}", headers=auth(bob))

    assert response.status_code == 404
    # 關鍵斷言：不只是回 404，那筆資料要真的還在
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 1
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: 上面 9 條 FAIL（`405 Method Not Allowed`），Task 3 的測試照樣 PASS。

- [ ] **Step 3: 實作**

在 `app/api/routes/expenses.py` 加上 import：

```python
from fastapi import APIRouter, Depends, Query, Response, status

from app.api.deps import get_current_user, get_owned_or_404
from app.api.params import ResourceId
from app.errors import UnprocessableEntityError
from app.schemas.expense import (
    YEAR_MONTH_PATTERN,
    ExpenseCreateRequest,
    ExpenseResponse,
    ExpenseUpdateRequest,
)
```

並在檔尾加上兩個端點：

```python
# `amount` / `category` / `spent_at` 是 NOT NULL；`note` 是 nullable。
# 只有前三個的顯式 null 要擋。
_NOT_NULLABLE_FIELDS = ("amount", "category", "spent_at")


@router.patch("/{expense_id}", response_model=ExpenseResponse)
async def update_expense(
    expense_id: ResourceId,
    payload: ExpenseUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpenseResponse:
    """改一筆花費。**`meal_id` 不在可改欄位裡**（規格 §5.1）。

    `exclude_unset=True` 是哨兵寫法的關鍵：沒帶的欄位不會出現在 dict 裡。
    少了它，`{"amount": "150"}` 這種請求會把 category 與 spent_at 一起
    設成 None，撞上 NOT NULL。

    但 `exclude_unset` 分不出「沒帶」與「帶了 null」以外的事——
    `{"amount": null}` 是「有帶」，值是 None。所以三個 NOT NULL 欄位
    要在這裡明確擋一次，不能只靠 Pydantic（UpdateMeRequest 踩過的坑）。
    """
    expense = await get_owned_or_404(
        db, Expense, expense_id, owner_id=user.id, owner_field="user_id"
    )

    changes = payload.model_dump(exclude_unset=True)
    for field in _NOT_NULLABLE_FIELDS:
        if field in changes and changes[field] is None:
            raise UnprocessableEntityError(
                "FIELD_NOT_NULLABLE", f"{field} 不能是 null"
            )

    for field, value in changes.items():
        setattr(expense, field, value)

    await db.commit()
    await db.refresh(expense)
    return _to_response(expense)


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(
    expense_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """硬刪。這張表沒有稽核需求，而且錯記一筆要能乾淨刪掉（規格 §5.1）。"""
    expense = await get_owned_or_404(
        db, Expense, expense_id, owner_id=user.id, owner_field="user_id"
    )
    await db.delete(expense)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
```

> **`get_owned_or_404` 的 `owner_field="user_id"` 不能省。**
> 它的預設值是 `"owner_id"`（給 foods/supplements 用的），
> 而 `Expense` 沒有 `owner_id` 欄位——省略的話會是
> `AttributeError` 變成 500，而不是 404。

- [ ] **Step 4: 跑測試確認通過**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: 全部 PASS

- [ ] **Step 5: 突變測試——證明 `exclude_unset` 那條守得住**

把 `payload.model_dump(exclude_unset=True)` 暫時改成 `payload.model_dump()`。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: `test_patch_expense_leaves_untouched_fields_alone` **FAIL**——
但**注意它會怎麼失敗**：`_NOT_NULLABLE_FIELDS` 的檢查會先攔下來，
所以是 **422**，不是「category 被改掉」。

> 這是預期的，而且是好事：兩層防護互相補位。
> **但如果它回的是 500，停下來回報**——那代表 `_NOT_NULLABLE_FIELDS`
> 沒有涵蓋到全部 NOT NULL 欄位。

**改回來。**

- [ ] **Step 6: 突變測試——證明擁有權檢查守得住**

把 `delete_expense` 的 `get_owned_or_404(...)` 暫時換成
`expense = await db.get(Expense, expense_id)`（並加 `assert expense is not None`）。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_crud.py -v`
Expected: `test_delete_someone_elses_expense_is_404_and_keeps_it` **FAIL**——
而且是**兩個斷言都掛**（回 204、資料真的被刪了）。

**改回來。**

- [ ] **Step 7: 靜態檢查**

Run: `./.venv/Scripts/python.exe -m ruff check app tests`
Run: `./.venv/Scripts/python.exe -m mypy app`
Expected: 兩者都通過

> **分開跑，而且不要跑 `ruff format --check`。** CI 實際上只跑 `ruff check .` 與
> `mypy app`（`.github/workflows/ci.yml:90,93`）——`ruff format --check` 從來不是
> 這個專案的閘門，而且在目前的 master 上有 40 個既有檔案不符合它。
> 把它寫進驗收條件是計畫的錯（Task 1 的實作者發現並回報）。

- [ ] **Step 8: Commit**

```bash
git add app/api/routes/expenses.py tests/test_expenses_crud.py
git commit -m "feat(expenses): PATCH 與 DELETE

meal_id 不可改：把支出從一餐搬到另一餐沒有用途，而且是個好用的攻擊面。

三個 NOT NULL 欄位的顯式 null 在路由層明確擋掉，不只靠 exclude_unset——
{\"amount\": null} 是「有帶、值是 None」，exclude_unset 攔不住它，
流到 setattr 就是已認證使用者觸發的 500（UpdateMeRequest 的同一個坑）。

get_owned_or_404 必須帶 owner_field=\"user_id\"，預設的 \"owner_id\"
在 Expense 上不存在，會是 AttributeError 變 500 而不是 404。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 5: 月報表

**Files:**
- Modify: `app/api/routes/expenses.py`
- Test: `tests/test_expenses_summary.py`

- [ ] **Step 1: 寫失敗的測試**

Create `tests/test_expenses_summary.py`:

```python
from datetime import UTC, datetime

from app.models.expense import ExpenseCategory
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_summary_groups_by_category(client, db_session):
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100, category=ExpenseCategory.FOOD)
    await create_expense(db_session, user=user, amount=250, category=ExpenseCategory.FOOD)
    await create_expense(
        db_session, user=user, amount=50, category=ExpenseCategory.TRANSPORT
    )

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["month"] == "2026-12"
    assert body["total"] == "400.00"
    assert body["by_category"] == [
        {"category": "food", "total": "350.00", "count": 2},
        {"category": "transport", "total": "50.00", "count": 1},
    ]


async def test_summary_omits_categories_with_no_data(client, db_session):
    """零元的分類不回——前端有完整的分類清單可以自己對（規格 §5.2）。"""
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100, category=ExpenseCategory.FOOD)

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    categories = [row["category"] for row in response.json()["by_category"]]
    assert categories == ["food"]


async def test_summary_of_an_empty_month_is_zero_not_an_error(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/expenses/summary?month=2026-03", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["total"] == "0.00"
    assert body["by_category"] == []


async def test_summary_excludes_other_months(client, db_session):
    """11 月的花費不能算進 12 月。"""
    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15
    await create_expense(
        db_session, user=user, amount=999, spent_at=datetime(2026, 11, 15, 12, 0, tzinfo=UTC)
    )

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    assert response.json()["total"] == "100.00"


async def test_summary_respects_user_timezone_at_the_month_boundary(client, db_session):
    """台北 12 月 1 日 01:00 = UTC 11 月 30 日 17:00。

    這一筆對台北使用者來說是 **12 月**的花費。如果 summary 用 UTC 算月界線，
    它會被算進 11 月，而 12 月的總額會少這一筆。

    **這是整個模組最容易錯、也最難發現的地方**——錯的時候每個月只有
    邊界那幾小時的資料會跑錯月，平常完全看不出來。
    """
    user = await create_user(db_session)  # timezone 預設 Asia/Taipei
    await create_expense(
        db_session,
        user=user,
        amount=777,
        spent_at=datetime(2026, 11, 30, 17, 0, tzinfo=UTC),
    )

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(user))

    assert response.json()["total"] == "777.00"


async def test_summary_only_counts_my_own(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_expense(db_session, user=alice, amount=100)
    await create_expense(db_session, user=bob, amount=999)

    response = await client.get("/api/expenses/summary?month=2026-12", headers=auth(alice))

    assert response.json()["total"] == "100.00"


async def test_summary_defaults_to_this_month(client, db_session, monkeypatch):
    from app.api.routes import expenses as expenses_route

    monkeypatch.setattr(expenses_route, "this_month_in_timezone", lambda tz_name: (2026, 12))

    user = await create_user(db_session)
    await create_expense(db_session, user=user, amount=100)  # 2026-12-15

    response = await client.get("/api/expenses/summary", headers=auth(user))

    assert response.status_code == 200
    assert response.json()["month"] == "2026-12"
    assert response.json()["total"] == "100.00"
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_summary.py -v`
Expected: 全部 FAIL — `422`。

> **這個 422 值得注意，它不是「端點不存在」。**
> `/api/expenses/summary` 會先被 `GET /api/expenses/{expense_id}` 匹配到嗎？
> **不會——這份計畫沒有 `GET /api/expenses/{id}` 這個端點。**
> 實際上會落到 `GET /api/expenses`（prefix 是 `/expenses`，`/summary`
> 是不同路徑）→ 404。
>
> **如果實際看到的不是 404，停下來回報實際的狀態碼與 body。**
> 路由匹配順序在這個專案踩過（`foods.py:160` 有相關註解），
> 我對它的預測可靠度不高。

- [ ] **Step 3: 實作**

在 `app/api/routes/expenses.py` 的 import 補上：

```python
from decimal import Decimal

from sqlalchemy import func, select

from app.schemas.expense import (
    YEAR_MONTH_PATTERN,
    CategoryTotal,
    ExpenseCreateRequest,
    ExpenseResponse,
    ExpenseSummaryResponse,
    ExpenseUpdateRequest,
)
```

**`summary` 這個路由要放在 `PATCH /{expense_id}` 與 `DELETE /{expense_id}` 之前**
（檔案裡的宣告順序 = FastAPI 的匹配順序）。
把它加在 `list_expenses` 之後、`update_expense` 之前：

```python
_ZERO = Decimal("0.00")


@router.get("/summary", response_model=ExpenseSummaryResponse)
async def get_summary(
    month: str | None = Query(default=None, pattern=YEAR_MONTH_PATTERN),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpenseSummaryResponse:
    """這個月花了多少、花在哪——這個模組存在的唯一理由（規格 §1.1）。

    一次 GROUP BY 查詢。`total` 在 Python 端把各分類加起來，不再發第二次
    查詢——`Decimal` 相加是精確的，不會有浮點誤差。

    **`total` 由後端算，不是前端加總。** 前端加總會在將來加上篩選或分頁時
    安靜地算錯（規格 §5.2）。

    月界線走 `_resolve_month()`，跟 `list_expenses` 同一份實作。
    """
    start, end, normalized_month = _resolve_month(month, user.timezone)

    rows = (
        await db.execute(
            select(
                Expense.category,
                func.sum(Expense.amount).label("total"),
                func.count().label("count"),
            )
            .where(
                Expense.user_id == user.id,
                Expense.spent_at >= start,
                Expense.spent_at < end,
            )
            .group_by(Expense.category)
            .order_by(func.sum(Expense.amount).desc())
        )
    ).all()

    by_category = [
        CategoryTotal(category=row.category, total=row.total, count=row.count) for row in rows
    ]
    # sum() 的 start 是 _ZERO 而不是 0：沒有任何資料時要回 "0.00"，
    # 不是 "0"——回應型別是 Decimal，而 Decimal(0) 序列化成 "0"。
    total = sum((row.total for row in by_category), _ZERO)

    return ExpenseSummaryResponse(
        month=normalized_month, total=total, by_category=by_category
    )
```

- [ ] **Step 4: 跑測試確認通過**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_summary.py -v`
Expected: 全部 PASS

> **如果 `test_summary_of_an_empty_month_is_zero_not_an_error` 回的是 `"0"`
> 而不是 `"0.00"`，那是 `_ZERO` 的 quantize 沒有生效**——
> 回報實際值，不要改測試去遷就。

- [ ] **Step 5: 突變測試——證明時區那條守得住**

把 `_resolve_month` 裡的 `month_bounds(year, month_number, tz_name)`
暫時改成 `month_bounds(year, month_number, "UTC")`。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_summary.py -v`
Expected: `test_summary_respects_user_timezone_at_the_month_boundary` **FAIL**
（`"0.00" != "777.00"`）。其他測試應該照樣 PASS，因為它們的測資都在月中。

> **如果其他測試也紅了，那更好——回報哪幾條。**
> 但我預期只有這一條，因為 `_DEFAULT_SPENT_AT` 是 12 月 15 日中午，
> 離月界線很遠。

**改回來。**

- [ ] **Step 6: 突變測試——證明路由順序真的重要**

把 `get_summary` 的宣告位置暫時搬到 `delete_expense` 之後（檔尾）。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_expenses_summary.py -v`
Expected: 全部 FAIL，`422`——`/summary` 被 `PATCH`/`DELETE` 的
`{expense_id}` 搶走，而 `ResourceId` 解析 `"summary"` 失敗回 422。

> **如果它照樣全綠，那代表 FastAPI 的匹配不受宣告順序影響（或這個
> 組合剛好不衝突）——停下來回報。** 那會推翻我在 Step 3 寫的
> 「宣告順序 = 匹配順序」，而那句話正是我要求你把 summary 放前面的理由。

**改回來。**

- [ ] **Step 7: 靜態檢查**

Run: `./.venv/Scripts/python.exe -m ruff check app tests`
Run: `./.venv/Scripts/python.exe -m mypy app`
Expected: 兩者都通過

> **分開跑，而且不要跑 `ruff format --check`。** CI 實際上只跑 `ruff check .` 與
> `mypy app`（`.github/workflows/ci.yml:90,93`）——`ruff format --check` 從來不是
> 這個專案的閘門，而且在目前的 master 上有 40 個既有檔案不符合它。
> 把它寫進驗收條件是計畫的錯（Task 1 的實作者發現並回報）。

- [ ] **Step 8: Commit**

```bash
git add app/api/routes/expenses.py tests/test_expenses_summary.py
git commit -m "feat(expenses): 月報表端點

一次 GROUP BY，total 在 Python 端用 Decimal 相加（精確，不用第二次查詢）。
空月份回 \"0.00\" 不是錯誤。

月界線走 _resolve_month() 與 list_expenses 共用。測試涵蓋台北時區的
月界線（UTC 11/30 17:00 對台北是 12 月）——用 UTC 算月界線的話，
每個月只有邊界那幾小時的資料會跑錯月，平常完全看不出來。

/summary 的宣告必須在 /{expense_id} 之前，否則被路徑參數搶走。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## Task 6: 記一餐順手填金額

**Files:**
- Modify: `app/schemas/meal.py:22-27`（`MealCreateRequest`）
- Modify: `app/api/routes/meals.py:143-200`（`create_meal`）
- Test: `tests/test_meals_cost.py`

- [ ] **Step 1: 寫失敗的測試**

Create `tests/test_meals_cost.py`:

```python
"""記一餐時順手記下餐費（規格 §4）。

**這裡不測「支出插入失敗時餐點會回滾」**，理由見檔尾的說明——
那條路徑從 API 打不到，硬要測只能 mock，而 mock 出來的綠燈
證明的是 mock，不是交易。
"""

from decimal import Decimal

from sqlalchemy import func, select

from app.models.expense import Expense, ExpenseCategory
from app.models.meal import Meal
from app.security.tokens import create_access_token
from tests.factories import create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_creating_a_meal_with_cost_creates_a_linked_expense(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "180"},
    )

    assert response.status_code == 201
    meal_id = response.json()["id"]

    expense = await db_session.scalar(select(Expense))
    assert expense is not None
    assert expense.meal_id == meal_id
    assert expense.amount == Decimal("180.00")
    assert expense.category is ExpenseCategory.FOOD
    # spent_at 跟著 eaten_at 走，不是「現在」——否則跨月補記一餐會把錢
    # 記到這個月
    assert expense.spent_at.isoformat() == "2026-12-15T04:00:00+00:00"


async def test_creating_a_meal_without_cost_creates_no_expense(client, db_session):
    """cost 是選填的。沒帶就不建支出——自己煮的一餐沒有花錢（規格 §2.2）。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch"},
    )

    assert response.status_code == 201
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_meal_response_does_not_include_cost(client, db_session):
    """**刻意不在 MealResponse 裡回 cost。**

    要在回應裡帶 cost，讀取路徑（GET /api/meals、GET /api/meals/{id}）
    就得 LEFT JOIN expenses。不做的話，同一個 MealResponse 型別會在
    建立時有值、在讀取時永遠是 null——一個永遠說謊的欄位比沒有這個欄位更糟。

    金額的確認在 /expenses 頁看。真的需要每一餐都顯示金額時，
    那是一次獨立的改動（把 LEFT JOIN 加進三條讀取路徑），不是順手加一個欄位。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "180"},
    )

    assert "cost" not in response.json()


async def test_rejected_cost_creates_neither_meal_nor_expense(client, db_session):
    """cost = 0 被 Pydantic 擋下來時，餐點也不能留下。

    這是「同一個交易」在 API 層唯一打得到的失敗路徑：驗證發生在
    任何寫入之前，所以兩者都不存在。

    **這條測試守的不是 rollback，是「驗證在寫入之前」。**
    真正的 DB 層交易回滾由結構保證（create_meal 只有一次 commit），
    不是由錯誤處理保證。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "0"},
    )

    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Meal)) == 0
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_create_meal_commits_exactly_once(client, db_session):
    """原始碼掃描：`create_meal` 裡只能有一次 `await db.commit()`。

    這是「餐點與支出要嘛都在、要嘛都不在」的**實際**保證。
    從 API 打不到「支出寫入失敗」那條路徑（amount 被 Pydantic 的 gt=0
    先擋掉），所以沒有辦法用行為測試證明回滾——能證明的只有結構：
    兩次寫入之間沒有 commit，就不可能有一半成功。

    **這條測試會在有人「順手」加第二次 commit 時變紅**，
    而那正是這個保證被破壞的方式。
    """
    import inspect

    from app.api.routes.meals import create_meal

    source = inspect.getsource(create_meal)
    assert source.count("await db.commit()") == 1
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py -v`

Expected:
- `test_creating_a_meal_with_cost_creates_a_linked_expense` **FAIL**
  （`assert expense is not None` — `cost` 被 Pydantic 忽略，沒有建支出）
- `test_rejected_cost_creates_neither_meal_nor_expense` **FAIL**
  （回 201 不是 422——`cost` 這個欄位還不存在，Pydantic 不會驗證它）
- `test_creating_a_meal_without_cost_creates_no_expense` **PASS**（本來就沒有支出）
- `test_meal_response_does_not_include_cost` **PASS**（本來就沒有這個欄位）
- `test_create_meal_commits_exactly_once` **PASS**（現在就是一次）

> **後面三條一開始就綠是預期的，不是問題。** 它們是**迴歸防護**：
> 守的是實作完之後不要多出東西。如果它們一開始就紅，停下來回報。

- [ ] **Step 3: 改 schema**

Modify `app/schemas/meal.py` —— `MealCreateRequest` 加一個欄位：

```python
class MealCreateRequest(BaseModel):
    eaten_at: datetime
    meal_type: MealType
    note: str | None = Field(default=None, max_length=500)
    # 允許空清單是刻意的：P2 的流程是先拍照、之後才落項目（見計畫本文）。
    items: list[MealItemCreateRequest] = Field(default_factory=list)
    # 選填的餐費（P5 規格 §4.1）。有值時，POST /api/meals 會在**同一個交易裡**
    # 建一筆 category=food、meal_id 指過來的支出。
    #
    # **不做成兩次 API 呼叫**：那有一個半成功狀態——餐點記起來了、支出沒有，
    # 而使用者完全不會知道。在手機上、網路不穩的情況下這不是理論風險。
    #
    # gt=0 / max_digits / decimal_places 對齊 expenses.amount 的
    # numeric(10,2) 與 ck_expenses_amount_positive。不對齊的話，
    # 超出範圍的值會走到 asyncpg 變成 500 而不是 422。
    cost: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
```

`app/schemas/meal.py` 的 import 已經有 `Decimal`（`MealItemCreateRequest` 的
`quantity` 在用），確認一下；沒有就補 `from decimal import Decimal`。

- [ ] **Step 4: 改路由**

Modify `app/api/routes/meals.py` —— import 加上：

```python
from app.models.expense import Expense, ExpenseCategory
```

在 `create_meal` 裡，`await db.flush()`（`meals.py:161`）之後、
`item_rows` 的迴圈之前，插入：

```python
    # 餐費：跟餐點在**同一個交易**裡（P5 規格 §4.1）。
    #
    # 這裡不需要 try/except + rollback——下面只有一次 db.commit()，
    # 兩次 add() 之間沒有任何提交點，所以「餐點成功但支出失敗」在結構上
    # 不可能發生。這跟上面 _resolve_item 的原子性是同一個道理：
    # 靠結構，不靠錯誤處理。
    #
    # spent_at 用 payload.eaten_at 不是「現在」：跨月補記一餐時，
    # 那筆錢屬於吃那一餐的月份，不是補記的月份。
    if payload.cost is not None:
        db.add(
            Expense(
                user_id=user.id,
                meal_id=meal.id,
                category=ExpenseCategory.FOOD,
                amount=payload.cost,
                spent_at=payload.eaten_at,
                note=None,
            )
        )
```

**不要動 `MealResponse`。** 見 `test_meal_response_does_not_include_cost` 的說明。

- [ ] **Step 5: 跑測試確認通過**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py -v`
Expected: 全部 PASS

- [ ] **Step 6: 跑既有的餐點測試，確認沒有弄壞任何東西**

Run: `./.venv/Scripts/python.exe -m pytest tests/test_meals_create.py tests/test_meals_read.py tests/test_meals_update.py tests/test_meals_items.py -v`
Expected: 全部 PASS

> `create_meal` 是這個系統最核心的寫入路徑。**這一步不是形式**——
> 加一個 `db.add()` 進去，最可能的副作用是 `await db.refresh(meal)`
> 之後某個既有斷言的資料狀態變了。

- [ ] **Step 7: 突變測試——證明「一次 commit」那條守得住**

在 `create_meal` 的 `db.add(Expense(...))` **之後**暫時多加一行
`await db.commit()`。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py -v`
Expected: `test_create_meal_commits_exactly_once` **FAIL**
（`assert 2 == 1`）。

> 注意其他幾條**很可能照樣綠**——那正是這條原始碼掃描測試存在的理由：
> 多一次 commit 在正常路徑上看不出任何差別，只在出錯的時候才會顯現，
> 而那個出錯路徑從 API 打不到。

**改回來。**

- [ ] **Step 8: 突變測試——證明 `spent_at` 跟著 `eaten_at` 走**

把 `spent_at=payload.eaten_at` 暫時改成
`spent_at=datetime.now(UTC)`（需要 import）。

Run: `./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py -v`
Expected: `test_creating_a_meal_with_cost_creates_a_linked_expense` **FAIL**
（最後那條 `isoformat()` 斷言）。

**改回來，並把暫時加的 import 也移除。**

- [ ] **Step 9: 跑完整測試套件**

Run: `./.venv/Scripts/python.exe -m pytest -q`
Expected: 全部 PASS

- [ ] **Step 10: 靜態檢查**

Run: `./.venv/Scripts/python.exe -m ruff check app tests`
Run: `./.venv/Scripts/python.exe -m mypy app`
Expected: 兩者都通過

> **分開跑，而且不要跑 `ruff format --check`。** CI 實際上只跑 `ruff check .` 與
> `mypy app`（`.github/workflows/ci.yml:90,93`）——`ruff format --check` 從來不是
> 這個專案的閘門，而且在目前的 master 上有 40 個既有檔案不符合它。
> 把它寫進驗收條件是計畫的錯（Task 1 的實作者發現並回報）。

- [ ] **Step 11: Commit**

```bash
git add app/schemas/meal.py app/api/routes/meals.py tests/test_meals_cost.py
git commit -m "feat(meals): 記一餐可以順手填金額

cost 有值時在同一個交易裡建一筆 category=food 的支出。不做成兩次 API
呼叫：那有一個半成功狀態——餐點記起來了、支出沒有，而使用者不會知道。

spent_at 跟著 eaten_at 走，不是「現在」：跨月補記一餐時那筆錢屬於
吃那一餐的月份。

刻意不把 cost 放進 MealResponse：讀取路徑不 JOIN expenses，放進去的話
同一個型別會在建立時有值、讀取時永遠 null——一個永遠說謊的欄位比
沒有這個欄位更糟。

原子性用「create_meal 只有一次 commit」的原始碼掃描測試守，不是用
行為測試：支出寫入失敗那條路徑從 API 打不到（amount 被 Pydantic 的
gt=0 先擋掉），硬要測只能 mock，而 mock 出來的綠燈證明的是 mock。

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>"
```

---

## 收尾

- [ ] **跑一次完整套件（含平行）**

Run: `./.venv/Scripts/python.exe -m pytest -q -n 4`（如果裝了 `pytest-xdist`；沒裝就跳過）
Expected: 全部 PASS

> P3-B 有一條 Playwright 測試在單跑時永遠綠、4 worker 平行時約 50% 紅，
> 而錯誤訊息指向的是那條測試要守的東西、不是真正的原因。
> 後端測試靠交易隔離，理論上不受影響，但值得跑一次確認。

- [ ] **更新 handover §6「綠燈說謊」**

把這一輪新增的候選寫進 handover 文件：

1. **月份相關的測試如果用「當月」當測資，一年有 11 個月沒有鑑別力。**
   `month_bounds` 的 12 月進位是唯一會寫錯的一行，測資必須寫死 12 月。
   （這是 P3-B「mock 日期剛好是計畫撰寫日」的變形。）
2. **`ON DELETE SET NULL` 的測試，如果兩者本來就沒連起來，會永遠綠**——
   它會「證明」一個從來沒發生過的 CASCADE 沒有發生。必須先斷言連著。
3. **`create_constraint=False` 卻忘記手寫 `CheckConstraint`，等於完全沒有約束**，
   而所有靜態檢查與既有測試都是綠的——因為沒有一條會去 INSERT 非法值。
   透過 ORM 測也看不見（SQLAlchemy 的 Enum 型別會先擋），必須用原生 SQL。
4. **交易原子性如果從 API 打不到失敗路徑，行為測試證明不了它。**
   mock 出來的綠燈證明的是 mock。改用原始碼掃描斷言「只有一次 commit」。

- [ ] **開 PR**

```bash
git push -u origin docs/p5-expenses-spec
gh pr create --title "P5 計畫一：記帳模組後端" --body "..."
```

PR 內文要包含：規格連結、六個任務的摘要、以及**所有實作過程中發現的計畫錯誤**。

---

## 自我檢查（寫完計畫後對照規格）

**規格涵蓋率：**

| 規格章節 | 對應任務 |
|---|---|
| §2.1 `expenses` 表 | Task 2 |
| §2.3 `ON DELETE SET NULL` | Task 2 Step 5、Step 8 |
| §2.4 金額型別與 `amount > 0` | Task 2（DB）、Task 3（Pydantic） |
| §2.5 `spent_at` 是 timestamptz | Task 2 |
| §3 分類 enum 與寫法 | Task 2 |
| §4.1 記一餐同一交易 | Task 6 |
| §4.2 `PATCH /api/meals` 不碰金額 | **沒有任務**——因為它是「不做什麼」。Task 4 的 `ExpenseUpdateRequest` docstring 記了這個決定 |
| §4.3 分類固定 food | Task 6 Step 1 的斷言 |
| §5.1 五個端點、`meal_id` 不可改 | Task 3、4、5 |
| §5.2 summary 回應形狀 | Task 5 |
| §5.3 `month` 預設值 | Task 3、5 |
| §5.4 `month_bounds()` | Task 1 |
| §6 前端 | **不在這份計畫**（規格 §9：前端是計畫二） |
| §7.1 六項要測的 | 1→Task 1；2→Task 1；3→Task 2；4→Task 6（改成結構斷言，理由已寫）；5→Task 2+3；6→Task 4 |
| §7.2 綠燈說謊候選 | 收尾 |
| §8 不做 | 無任務（定義範圍外） |

**一處與規格不同，已在計畫內說明理由：**
規格 §7.1 第 4 項要求「用一個會讓支出插入失敗的輸入去測交易回滾」。
**做不到**——`amount` 的 `gt=0` 在 Pydantic 就擋掉了，從 API 打不到 DB 層失敗。
Task 6 改成兩條測試：一條驗「驗證在寫入之前」（可達、有意義），
一條用原始碼掃描驗「只有一次 commit」（守得住真正的保證）。
規格 §7.2 其實已經預告了這個陷阱。
