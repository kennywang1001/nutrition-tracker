# 身體資料與目標（含體重紀錄）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者填身體資料、每天記體重，就能在 `/me/targets` 看到用公式算出的建議目標並一鍵套用；體重變了 1 公斤以上時「每日目標」卡片提示重算。體重有自己的頁面（`/weight`：圖表與清單）。

**Architecture:** 兩張新表（`user_profiles` 1:1、`weight_entries` 主鍵 `(user_id, date)`，migration `0019`）。公式是 `app/body_targets.py` 的純函式（Decimal、HALF_UP），讀資料的小函式在 `app/body_data.py`。端點在兩個新的路由模組：`routes/body.py`（`/api/me/body-profile`、`/api/me/target-suggestion`、`…/apply`）與 `routes/weights.py`（`/api/weights…`）。套用由後端在一個交易裡重算、比對畫面上看到的四個數字、用從 `set_target_from_today` 抽出來的 `write_target_from_today` 寫目標、記下套用時的體重；手動存目標清掉那個體重。前端的 query 都在 `["body", …]` 底下（進離線快取）；圖表是純渲染的 SVG（同 `TrendChart` 的慣例），數字運算只在 `lib/decimal.ts`。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · React 19 · TypeScript strict · TanStack Query v5 · react-router · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-14-body-targets-design.md`（以下稱「規格」；D1…D27 指它的 §2）

---

## 執行環境

- 分支 `feat/body-targets`（已建立，**不要 push**）。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（整套約 4 分鐘，timeout 給 10 分鐘；**同一時間只跑一個 pytest**——測試資料庫每次砍掉重建）。需要 dev 的 Postgres：`docker compose up -d`（專案 `wallet`，`localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`。**不要跑 `ruff format`**（handover §7）。
  - `alembic check` 指向測試資料庫（handover §9）：
    `DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test" ./.venv/Scripts/python.exe -m alembic check`
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式用 `npx biome check --write <檔案>`）。驗證時一起 grep `FAIL` 與 `Unhandled`。**typecheck 在每次 commit 之前單獨跑一次，跟 `git commit` 用 `&&` 串，不要用 `;`。**
- e2e：先 `docker compose up -d --build api`，**再** `docker compose exec -T api python -m alembic upgrade head`（重建不會替 dev 跑 migration，handover §7），`docker compose exec -T api python -m alembic current` 確認是 `0019`；然後在 `frontend/` 跑 `npx playwright test …`。
- 基準線（handover §2，2026-10-10）：後端 **1450**；前端 `Test Files 154`、`Tests 2128`（vitest 印出來的數字）；e2e **50**；端點 **87**；資料表 19。開工前自己再量一次，對不上照實記下來。
- **`schema.d.ts` 重新產生**——動到 `app/api/routes` 或 `app/schemas` 的每一個 commit（docstring 也算）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  產生之後跑 `cd frontend && npm run -s typecheck`。
- **突變**：改一行、看到指定的測試紅、改回、重跑看到綠。`.py` 改回之後 `touch` 那個檔案，並刪掉對應的 `__pycache__/*.pyc`（handover §7：pyc 用秒比 mtime）。**還沒 commit 的新檔案 `git checkout --` 救不回來**：突變前先 `cp app/x.py "$S/body-x.py.bak"`，改回之後 `diff` 確認。**每一批突變做完跑 `git diff`／`git status`**，確認沒有突變留在檔案裡（這件事發生過兩次）。突變可能變成無限迴圈：pytest 加 `--timeout` 不可用時，用 `timeout 300 ./.venv/Scripts/python.exe -m pytest …`。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/body-<task>-msg.txt`（每次用不同的檔名），最後一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`git add .`）。不要 amend。
- **看不見的字元**：Write／Edit 工具會把「反斜線 u＋四位十六進位」解成真的字元；Bash heredoc 會吃掉一層反斜線（handover §7）。腳本一律用 Write 工具寫成檔案再跑。每個 task commit 前跑一次（掃 Cc〔Tab、LF 除外〕、Cf、Zl、Zp、CR、BOM）：

  ```bash
  git diff --cached --name-only | ./.venv/Scripts/python.exe -c "import sys,unicodedata as u; [print(p.strip(), i+1, hex(ord(c))) for p in sys.stdin for i,l in enumerate(open(p.strip(),encoding='utf-8',newline='')) for c in l if (u.category(c) in ('Cc','Cf','Zl','Zp') and c not in '\t\n') or ord(c)==0xfeff]"
  ```

  Expected：沒有輸出。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。新模組還不存在時紅的是 import，不是斷言——斷言有沒有咬合力由每個 task 的突變步驟證明（handover §6 規矩 1、8）。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. **「今天」一律 monkeypatch，而且記下收到的時區**（handover §6 第 2、22 種）：`app.api.routes.body.today_in_timezone`、`app.api.routes.weights.today_in_timezone`、既有的 `app.api.routes.targets.today_in_timezone`。測試使用者的時區設成**不是預設的** `Asia/Taipei`（例如 `America/New_York`），否則「傳錯時區」測不出來。
4. `client` 夾具跟測試共用一個 session、外層一個交易（handover §6 第 14 種）：`now()` 在整條測試裡是同一個值，**`updated_at` 有沒有變在端點測試裡看不到**——不要寫那種斷言。並行的 upsert 用獨立的 session（Task 4）。
5. 共用 session 裡 `rollback()` 之後 ORM 物件會過期（`MissingGreenlet`）：id、日期先存成區域變數。要測「資料庫擋下來」用 `async with db_session.begin_nested():` 包住 raw SQL，**並斷言錯誤訊息裡是哪一個約束的名字**（第 13 種：別的約束先擋下來也會是 `IntegrityError`）。
6. 端點在 `await db.commit()` 之後不碰 ORM 物件（handover §7）：開頭就把 `user.id`、`user.timezone` 存成區域變數。
7. **「看不到」的測試先在同一條測試裡看得到一次**（A 自己讀得到、B 讀不到）。只斷言 404 的測試，路徑打錯也會綠。
8. 前端的 `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對：`/api/me` 的路由會吃掉 `/api/me/body-profile`、`/api/me/target-suggestion`。**新的 `/api/me/...` 路由一律排在 `/api/me` 前面**；既有測試裡會畫出新卡片的（`me.test.tsx`、`targets.test.tsx`、`app.test.tsx`……）在路由清單**最前面**加上 Task 6 的 `bodyRoutes()`。沒準備的路徑會 `throw`（query 變成 error，不會讓測試直接紅）——斷言「沒有發出某個請求」要看 `spy.mock.calls`。
9. 前端**不算今天**：預設日期、圖表的右端都用 `GET /api/weights` 回的 `today`；日期加減只用 `lib/civil-date.ts`（UTC，掃描測試守著）；數字運算只在 `lib/decimal.ts`（`tests/decimal-containment.test.ts`）。
10. Playwright 的名稱一律 `exact: true`；登入之後**只用點擊換頁**，不要 `page.goto`；等頁面獨有的元素再動作。
11. 離線快取裡的舊資料可能少了新欄位（`undefined`，不是 `null`）：畫面判斷用真值或 `?? null`（handover §7）。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**整份跑過。「Expected: PASS」的條數是照測試清單數的，不是量的；對不上照實回報。只有下面兩件不確定的事做了小實驗：

1. **建議的回應用聯集時不能加 discriminator。** `Annotated[Ready | Missing, Field(discriminator="ready")]`：OpenAPI 的 `discriminator.mapping` 鍵是 `"True"`／`"False"`，openapi-typescript 7.13 因此產生 `ready: "True"`（字串）。不加 discriminator：OpenAPI 是 `anyOf`，產生 `ready: true`／`ready: false`，前端可以 `if (s.ready)` 收窄。FastAPI 的 `response_model=SuggestionReady | SuggestionMissing` 序列化正常。
2. **公式的數字**：規格 §3 的五組（A–E）用跟 Task 2 同一套 `Decimal`／`ROUND_HALF_UP` 運算的腳本算過；7700 / 7 剛好是 1100，所以調整量是整數（275、550）。

## 與規格的差異

（執行中發現的寫在這裡。）

---

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `app/models/body.py`（新）、`app/models/__init__.py` | 1 | `UserProfile`、`WeightEntry`、`Sex`、`ActivityLevel`、`Goal` |
| `migrations/versions/0019_create_body_tables.py`（新） | 1 | 兩張表 |
| `tests/factories.py`、`tests/test_body_model.py`（新） | 1 | `create_profile`、`create_weight`；約束與 cascade |
| `app/body_targets.py`（新）、`tests/test_body_targets.py`（新） | 2 | 公式（純函式） |
| `app/body_data.py`（新） | 3、5 | `load_profile`、`latest_weight`、`inputs_from`、`clear_applied_weight` |
| `app/schemas/body.py`（新） | 3–5 | 身體資料、建議、套用、體重的形狀 |
| `app/api/routes/body.py`（新）、`app/main.py` | 3、5 | 身體資料、建議、套用 |
| `tests/test_body_profile.py`、`tests/test_target_suggestion.py`（新） | 3、5 | |
| `app/api/routes/weights.py`（新）、`app/export.py`、`app/api/routes/export.py` | 4 | 體重的三個端點、`weights.csv` |
| `tests/test_weights.py`、`tests/test_weights_concurrency.py`（新）、`tests/test_export.py` | 4 | |
| `app/api/routes/targets.py` | 5 | 抽出 `write_target_from_today`；手動存目標清掉套用體重 |
| `tests/test_body_privacy.py`（新）、`tests/test_targets_today.py` | 5 | 掃描；清掉套用體重 |
| `frontend/src/api/schema.d.ts` | 3–5 | 每個後端 task 重新產生 |
| `frontend/src/api/{body.ts（新）,queries.ts}`、`src/lib/{body.ts（新）,weights.ts（新）,decimal.ts,civil-date.ts}` | 6 | API 層、標籤、移動平均、數字與日期 |
| `frontend/tests/helpers/body-routes.ts`（新）、`tests/{body-api,weights-lib}.test.ts`（新）、`decimal.test.ts`、`civil-date.test.ts` | 6 | |
| `frontend/src/screens/BodyProfile.tsx`、`components/BodyProfileCard.tsx`（新）、`Me.tsx`、`App.tsx`、`lib/layout.ts` | 7 | `/me/body` |
| `frontend/src/components/{WeightCard,WeightForm,WeightChart}.tsx`、`screens/Weight.tsx`、`components/Segmented.module.css`（新）、`screens/Trend.{tsx,module.css}`、`index.css` | 8 | 體重 |
| `frontend/src/components/TargetSuggestion.tsx`（新）、`TargetsCard.tsx`、`screens/Targets.tsx`、`api/export.ts` | 9 | 建議、提示、匯出 |
| `frontend/e2e/body-targets.spec.ts`（新） | 10 | |
| `docs/handover.md`、`docs/deployment.md`、規格的狀態 | 11 | |

---

## Task 1：後端——migration `0019` 與模型

**Files:**
- Create: `app/models/body.py`、`migrations/versions/0019_create_body_tables.py`、`tests/test_body_model.py`
- Modify: `app/models/__init__.py`、`tests/factories.py`

- [ ] **Step 1：模型。** `app/models/body.py`：

```python
"""身體資料與體重（身體資料規格 §4）。健康資料：只有身體資料的模組讀寫這兩張表——
好友與社群的模組連這幾個名字都不准出現（`tests/test_body_privacy.py` 掃的是文字）。"""

import datetime as dt
import enum
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    SmallInteger,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Sex(enum.StrEnum):
    MALE = "male"
    FEMALE = "female"


class ActivityLevel(enum.StrEnum):
    SEDENTARY = "sedentary"
    LIGHT = "light"
    MODERATE = "moderate"
    ACTIVE = "active"
    VERY_ACTIVE = "very_active"


class Goal(enum.StrEnum):
    LOSE = "lose"
    MAINTAIN = "maintain"
    GAIN = "gain"


def _enum(cls: type[enum.StrEnum], name: str, length: int) -> Enum:
    # handover §7：create_constraint=True 會讓 alembic check 永久漂移；False 的另一半是
    # __table_args__ 裡手寫的 CHECK——只寫一半＝沒有約束。
    return Enum(
        cls,
        name=name,
        native_enum=False,
        create_constraint=False,
        length=length,
        values_callable=lambda e: [m.value for m in e],
    )


def _timestamps() -> tuple[Mapped[dt.datetime], Mapped[dt.datetime]]:
    return (
        mapped_column(DateTime(timezone=True), nullable=False, server_default=func.now()),
        mapped_column(
            DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
        ),
    )


class UserProfile(Base):
    """一人一列（D1），每個欄位都可以是 null（還沒填）。

    CHECK 對 NULL 放行（handover §7）——這裡要的正是「null 或範圍內」，所以不用寫
    `x IS NULL OR …`。出生年的真正範圍跟「今天」有關，CHECK 只擋衛生範圍（D4）。"""

    __tablename__ = "user_profiles"
    __table_args__ = (
        CheckConstraint("sex IN ('male', 'female')", name="sex_valid"),
        CheckConstraint("birth_year BETWEEN 1900 AND 2100", name="birth_year_sane"),
        CheckConstraint("height_cm BETWEEN 100 AND 250", name="height_range"),
        CheckConstraint(
            "activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')",
            name="activity_level_valid",
        ),
        CheckConstraint("goal IN ('lose', 'maintain', 'gain')", name="goal_valid"),
        CheckConstraint("rate_kg_per_week IN (0.25, 0.50)", name="rate_valid"),
        CheckConstraint("target_weight_kg BETWEEN 25 AND 350", name="target_weight_range"),
        CheckConstraint(
            "targets_applied_weight_kg BETWEEN 25 AND 350", name="applied_weight_range"
        ),
    )

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    sex: Mapped[Sex | None] = mapped_column(_enum(Sex, "body_sex", 8))
    birth_year: Mapped[int | None] = mapped_column(SmallInteger)
    height_cm: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    activity_level: Mapped[ActivityLevel | None] = mapped_column(
        _enum(ActivityLevel, "activity_level", 16)
    )
    goal: Mapped[Goal | None] = mapped_column(_enum(Goal, "body_goal", 8))
    rate_kg_per_week: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    target_weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    # 套用建議時的體重（D15）；手動存目標時清成 null（D16）。只有後端寫，API 不收。
    targets_applied_weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    created_at: Mapped[dt.datetime]
    updated_at: Mapped[dt.datetime]
    created_at, updated_at = _timestamps()


class WeightEntry(Base):
    """一人一天一筆（D12）：主鍵就是 (user_id, date)，同時是「某段日期」與「最新一筆」的索引。

    `date` 是使用者時區的日曆日（記的時候選的那一天），不是時間點。`updated_at` 的
    `onupdate` 只在 ORM 的 UPDATE 生效——upsert 要自己在 `set_` 裡寫（`routes/weights.py`）。"""

    __tablename__ = "weight_entries"
    __table_args__ = (CheckConstraint("weight_kg BETWEEN 25 AND 350", name="weight_range"),)

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    weight_kg: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    created_at: Mapped[dt.datetime]
    updated_at: Mapped[dt.datetime]
    created_at, updated_at = _timestamps()
```

> `created_at, updated_at = _timestamps()` 這種寫法如果 SQLAlchemy 的宣告式映射不認（先宣告註解、再在同一個類別裡解構賦值），
> 就照 `app/models/social.py` 的寫法每個欄位各寫一次 `mapped_column(...)`，刪掉 `_timestamps`——行為一樣，回報一行。

`app/models/__init__.py`：加 `from app.models.body import ActivityLevel, Goal, Sex, UserProfile, WeightEntry`，五個名字照字母順序放進 `__all__`。

- [ ] **Step 2：migration。** `migrations/versions/0019_create_body_tables.py`（格式照 `0018`）：

```python
"""create body tables

Revision ID: 0019
Revises: 0018
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def _enum(name: str, *values: str, length: int) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False, create_constraint=False, length=length)


def _user_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["users.id"], name=f"fk_{table}_user_id_users", ondelete="CASCADE"
    )


def upgrade() -> None:
    # 只有新表：舊版程式不讀不寫它們，所以這一版可以退版，
    # 不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("sex", _enum("body_sex", "male", "female", length=8), nullable=True),
        sa.Column("birth_year", sa.SmallInteger, nullable=True),
        sa.Column("height_cm", sa.Numeric(4, 1), nullable=True),
        sa.Column(
            "activity_level",
            _enum(
                "activity_level",
                "sedentary",
                "light",
                "moderate",
                "active",
                "very_active",
                length=16,
            ),
            nullable=True,
        ),
        sa.Column("goal", _enum("body_goal", "lose", "maintain", "gain", length=8), nullable=True),
        sa.Column("rate_kg_per_week", sa.Numeric(3, 2), nullable=True),
        sa.Column("target_weight_kg", sa.Numeric(5, 2), nullable=True),
        sa.Column("targets_applied_weight_kg", sa.Numeric(5, 2), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("user_id", name="pk_user_profiles"),
        _user_fk("user_profiles"),
        # name= 是命名慣例的輸入（同 0013、0018）：最後是 ck_user_profiles_<name>。
        sa.CheckConstraint("sex IN ('male', 'female')", name="sex_valid"),
        sa.CheckConstraint("birth_year BETWEEN 1900 AND 2100", name="birth_year_sane"),
        sa.CheckConstraint("height_cm BETWEEN 100 AND 250", name="height_range"),
        sa.CheckConstraint(
            "activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')",
            name="activity_level_valid",
        ),
        sa.CheckConstraint("goal IN ('lose', 'maintain', 'gain')", name="goal_valid"),
        sa.CheckConstraint("rate_kg_per_week IN (0.25, 0.50)", name="rate_valid"),
        sa.CheckConstraint("target_weight_kg BETWEEN 25 AND 350", name="target_weight_range"),
        sa.CheckConstraint(
            "targets_applied_weight_kg BETWEEN 25 AND 350", name="applied_weight_range"
        ),
    )
    op.create_table(
        "weight_entries",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("weight_kg", sa.Numeric(5, 2), nullable=False),
        *_timestamps(),
        sa.PrimaryKeyConstraint("user_id", "date", name="pk_weight_entries"),
        _user_fk("weight_entries"),
        sa.CheckConstraint("weight_kg BETWEEN 25 AND 350", name="weight_range"),
    )


def downgrade() -> None:
    op.drop_table("weight_entries")
    op.drop_table("user_profiles")
```

- [ ] **Step 3：factories。** `tests/factories.py` 加（import `Sex`、`ActivityLevel`、`Goal`、`UserProfile`、`WeightEntry`）：

```python
async def create_profile(
    db_session: AsyncSession,
    *,
    user: User,
    sex: Sex | None = Sex.MALE,
    birth_year: int | None = 1990,
    height_cm: Decimal | int | str | None = 175,
    activity_level: ActivityLevel | None = ActivityLevel.MODERATE,
    goal: Goal | None = Goal.LOSE,
    rate_kg_per_week: Decimal | str | None = "0.5",
    target_weight_kg: Decimal | int | str | None = None,
    targets_applied_weight_kg: Decimal | int | str | None = None,
) -> UserProfile:
    """預設是規格 §3.2 那一位（男、1990、175 cm、中度、減重每週 0.5）——配上 80 kg 的體重
    與 2026-10-14 的「今天」就是 2110 kcal。"""

    def dec(value: Decimal | int | str | None) -> Decimal | None:
        return None if value is None else Decimal(str(value))

    profile = UserProfile(
        user_id=user.id,
        sex=sex,
        birth_year=birth_year,
        height_cm=dec(height_cm),
        activity_level=activity_level,
        goal=goal,
        rate_kg_per_week=dec(rate_kg_per_week),
        target_weight_kg=dec(target_weight_kg),
        targets_applied_weight_kg=dec(targets_applied_weight_kg),
    )
    db_session.add(profile)
    await db_session.commit()
    return profile


async def create_weight(
    db_session: AsyncSession, *, user: User, day: date, weight_kg: Decimal | int | str = 80
) -> WeightEntry:
    entry = WeightEntry(user_id=user.id, date=day, weight_kg=Decimal(str(weight_kg)))
    db_session.add(entry)
    await db_session.commit()
    return entry
```

- [ ] **Step 4：約束的測試。** `tests/test_body_model.py`：

```python
"""兩張表的約束與 cascade（身體資料規格 §4）。每一條「擋下來」都斷言是**哪一個**約束
（handover §6 第 13 種：別的約束先擋也是 IntegrityError）。"""

from datetime import date

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.models.body import UserProfile, WeightEntry
from app.models.user import User
from tests.factories import create_profile, create_user, create_weight

PROFILE_INSERT = (
    "INSERT INTO user_profiles (user_id, sex, birth_year, height_cm, activity_level, goal,"
    " rate_kg_per_week, target_weight_kg, targets_applied_weight_kg)"
    " VALUES (:user_id, :sex, :birth_year, :height_cm, :activity_level, :goal,"
    " :rate, :target, :applied)"
)
VALID = {
    "sex": "female",
    "birth_year": 1990,
    "height_cm": 160,
    "activity_level": "light",
    "goal": "gain",
    "rate": 0.25,
    "target": 60,
    "applied": 55,
}


async def _insert_profile(db_session, user_id: int, **overrides) -> None:
    async with db_session.begin_nested():
        await db_session.execute(text(PROFILE_INSERT), {**VALID, "user_id": user_id, **overrides})


async def test_a_valid_profile_and_an_all_null_profile_both_insert(db_session):
    first, second = await create_user(db_session), await create_user(db_session)
    first_id, second_id = first.id, second.id

    await _insert_profile(db_session, first_id)
    await _insert_profile(
        db_session,
        second_id,
        sex=None,
        birth_year=None,
        height_cm=None,
        activity_level=None,
        goal=None,
        rate=None,
        target=None,
        applied=None,
    )

    count = await db_session.scalar(
        select(func.count()).select_from(UserProfile).where(
            UserProfile.user_id.in_([first_id, second_id])
        )
    )
    assert count == 2


@pytest.mark.parametrize(
    ("field", "value", "constraint"),
    [
        ("sex", "other", "ck_user_profiles_sex_valid"),
        ("birth_year", 1899, "ck_user_profiles_birth_year_sane"),
        ("height_cm", 99.9, "ck_user_profiles_height_range"),
        ("height_cm", 250.1, "ck_user_profiles_height_range"),
        ("activity_level", "extreme", "ck_user_profiles_activity_level_valid"),
        ("goal", "bulk", "ck_user_profiles_goal_valid"),
        ("rate", 0.3, "ck_user_profiles_rate_valid"),
        ("target", 24.99, "ck_user_profiles_target_weight_range"),
        ("applied", 350.01, "ck_user_profiles_applied_weight_range"),
    ],
)
async def test_each_profile_check_rejects_its_own_bad_value(db_session, field, value, constraint):
    """只改一個欄位，其他都是 VALID——擋下來的一定是那個欄位的約束。"""
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        await _insert_profile(db_session, user_id, **{field: value})

    assert constraint in str(caught.value.orig)


@pytest.mark.parametrize(
    ("field", "value"), [("height_cm", 100), ("height_cm", 250), ("target", 25), ("target", 350)]
)
async def test_the_range_edges_are_inclusive(db_session, field, value):
    user = await create_user(db_session)
    user_id = user.id

    await _insert_profile(db_session, user_id, **{field: value})


async def test_one_weight_per_user_per_day(db_session):
    user = await create_user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=date(2026, 10, 1), weight_kg=70)

    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (:u, :d, 71)"),
                {"u": user_id, "d": date(2026, 10, 1)},
            )

    assert "pk_weight_entries" in str(caught.value.orig)


@pytest.mark.parametrize("weight", [24.99, 350.01])
async def test_a_weight_out_of_range_is_rejected(db_session, weight):
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (:u, :d, :w)"),
                {"u": user_id, "d": date(2026, 10, 1), "w": weight},
            )

    assert "ck_weight_entries_weight_range" in str(caught.value.orig)


async def test_deleting_a_user_takes_the_profile_and_the_weights(db_session):
    user = await create_user(db_session)
    other = await create_user(db_session)
    await create_profile(db_session, user=user)
    await create_profile(db_session, user=other)
    await create_weight(db_session, user=user, day=date(2026, 10, 1))
    await create_weight(db_session, user=other, day=date(2026, 10, 1))
    user_id, other_id = user.id, other.id

    await db_session.execute(delete(User).where(User.id == user_id))
    await db_session.commit()

    profiles = (await db_session.scalars(select(UserProfile.user_id))).all()
    weights = (await db_session.scalars(select(WeightEntry.user_id))).all()
    assert user_id not in profiles and user_id not in weights
    # 別人的還在：cascade 沒有多刪。
    assert other_id in profiles and other_id in weights
```

- [ ] **Step 5：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_body_model.py
```

Expected：PASS（18 條）。接著 `alembic check`（執行環境那一行）——Expected：`No new upgrade operations detected.`。再驗退版：

```bash
export DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test"
./.venv/Scripts/python.exe -m alembic downgrade -1 && ./.venv/Scripts/python.exe -m alembic current
./.venv/Scripts/python.exe -m alembic upgrade head && ./.venv/Scripts/python.exe -m alembic current
unset DATABASE_URL
```

Expected：`0018`，然後 `0019 (head)`。

- [ ] **Step 6：突變。** 各改一處、看指定測試紅、改回（模型與 migration 是**同一份約束的兩處**：測試資料庫由 migration 建，所以突變要改 migration）：
  1. migration 的 `height_range` 改成 `height_cm > 100 AND height_cm < 250` → `test_the_range_edges_are_inclusive` 紅。
  2. migration 拿掉 `rate_valid` → `test_each_profile_check_rejects_its_own_bad_value[rate-…]` 紅。
  3. migration 的 `_user_fk` 拿掉 `ondelete="CASCADE"` → `test_deleting_a_user_takes_the_profile_and_the_weights` 紅（`users` 刪不掉，FK 擋下來）。
  4. 模型拿掉 `rate_valid`（migration 不動）→ `alembic check` 報漂移（`remove_constraint`）。

  改回、`touch`、刪 pyc，`git diff` 確認乾淨，重跑 Step 5 全綠。

- [ ] **Step 7：檢查與 commit。**

```bash
./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/models/body.py app/models/__init__.py migrations/versions/0019_create_body_tables.py tests/factories.py tests/test_body_model.py
```

訊息（`$S/body-t1-msg.txt`）：`feat(body): 身體資料與體重的兩張表（migration 0019）`，內文一兩行說明主鍵與手寫 CHECK。

---

## Task 2：後端——建議目標的公式（純函式）

**Files:**
- Create: `app/body_targets.py`、`tests/test_body_targets.py`

- [ ] **Step 1：先寫測試。** `tests/test_body_targets.py`（數字是規格 §3 的五組，腳本算過）：

```python
"""建議目標的公式（身體資料規格 §3）。全部是手算得出來的數字；年齡用固定的今天。"""

from datetime import date
from decimal import Decimal

import pytest

from app.body_targets import BodyInputs, Suggestion, round_half_up, suggest
from app.models.body import ActivityLevel, Goal, Sex

TODAY = date(2026, 10, 14)
D = Decimal


def inputs(**overrides) -> BodyInputs:
    base = {
        "sex": Sex.MALE,
        "birth_year": 1990,
        "height_cm": D(175),
        "activity_level": ActivityLevel.MODERATE,
        "goal": Goal.LOSE,
        "rate_kg_per_week": D("0.5"),
        "weight_kg": D(80),
    }
    return BodyInputs(**{**base, **overrides})


def macros(result: Suggestion | list) -> tuple:
    assert isinstance(result, Suggestion)
    return (result.kcal, result.protein_g, result.fat_g, result.carb_g)


def test_case_a_the_worked_example():
    result = suggest(inputs(), TODAY)

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1719), D(2664), D(-550))
    assert result.floor_applied is False
    assert result.floor_kcal == D(1500)
    assert macros(result) == (D(2110), D(144), D(59), D(251))


def test_case_b_the_floor_applies():
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1960,
            height_cm=D(155),
            weight_kg=D(50),
            activity_level=ActivityLevel.SEDENTARY,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee) == (D(978), D(1173))
    assert result.floor_applied is True
    assert result.floor_kcal == D(1200)
    assert macros(result) == (D(1200), D(90), D(33), D(136))


def test_case_c_gain_adds():
    result = suggest(
        inputs(
            birth_year=2000,
            height_cm=D(180),
            weight_kg=D(70),
            activity_level=ActivityLevel.ACTIVE,
            goal=Goal.GAIN,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1700), D(2933), D(275))
    assert macros(result) == (D(3210), D(140), D(89), D(462))


def test_case_d_maintain_ignores_the_rate():
    """速度是 0.5，但目標是維持：調整是 0。"""
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1985,
            height_cm=D(165),
            weight_kg=D(60),
            activity_level=ActivityLevel.LIGHT,
            goal=Goal.MAINTAIN,
            rate_kg_per_week=D("0.5"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1265), D(1740), D(0))
    assert macros(result) == (D(1740), D(96), D(48), D(231))


def test_case_e_carbs_are_clamped_at_zero():
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1926,
            height_cm=D(100),
            weight_kg=D(150),
            activity_level=ActivityLevel.SEDENTARY,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert result.floor_applied is False
    assert macros(result) == (D(1210), D(270), D(34), D(0))


def test_the_floor_is_judged_on_the_raw_value_not_the_rounded_one():
    """原始 1499.2：四捨五入到 10 是 1500、不低於下限；但原始值低於下限——下限有套用（D8）。
    男、40 歲、170 cm、61.1 kg、久坐、減 0.25：BMR 611 + 1062.5 − 200 + 5 = 1478.5；
    TDEE 1774.2；原始 1499.2。"""
    result = suggest(
        inputs(
            birth_year=1986,
            height_cm=D(170),
            weight_kg=D("61.1"),
            activity_level=ActivityLevel.SEDENTARY,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert result.floor_applied is True
    assert result.kcal == D(1500)


def test_case_f_carbs_use_the_rounded_protein():
    """蛋白質有小數（1.8 × 68.4 = 123.12）：碳水要用四捨五入後的 123 算，四個數字才自洽。
    男、30 歲、172.5 cm、非常高、減 0.25 → 原始 2797.5375 → 2800；
    (2800 − 492 − 702) / 4 = 401.5 → 402（用 123.12 算是 401.38 → 401）。"""
    result = suggest(
        inputs(
            birth_year=1996,
            height_cm=D("172.5"),
            weight_kg=D("68.4"),
            activity_level=ActivityLevel.VERY_ACTIVE,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert macros(result) == (D(2800), D(123), D(78), D(402))


def test_age_comes_from_the_year_of_today_that_was_passed_in():
    """同一份資料，今天換成隔年：年齡多一歲，BMR 少 5。"""
    this_year = suggest(inputs(), TODAY)
    next_year = suggest(inputs(), date(2027, 1, 1))

    assert isinstance(this_year, Suggestion) and isinstance(next_year, Suggestion)
    assert this_year.bmr - next_year.bmr == D(5)


@pytest.mark.parametrize(
    ("value", "step", "expected"),
    [
        (D("2105"), D(10), D(2110)),  # 銀行家捨入會給 2100
        (D("400.5"), D(1), D(401)),  # 銀行家捨入會給 400
        (D("58.49"), D(1), D(58)),
        (D("-550"), D(1), D(-550)),
    ],
)
def test_round_half_up(value, step, expected):
    assert round_half_up(value, step) == expected


ALL_MISSING = [
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "weight",
]


def test_everything_missing_is_listed_in_order():
    empty = BodyInputs(None, None, None, None, None, None, None)

    # 目標沒填時速度也算缺：不知道要不要速度，就先要。
    assert suggest(empty, TODAY) == ALL_MISSING


@pytest.mark.parametrize(
    ("field", "name"),
    [
        ("sex", "sex"),
        ("birth_year", "birth_year"),
        ("height_cm", "height_cm"),
        ("activity_level", "activity_level"),
        ("goal", "goal"),
        ("rate_kg_per_week", "rate_kg_per_week"),
        ("weight_kg", "weight"),
    ],
)
def test_each_single_missing_input_is_named(field, name):
    assert suggest(inputs(**{field: None}), TODAY) == [name]


def test_maintain_does_not_need_a_rate():
    result = suggest(inputs(goal=Goal.MAINTAIN, rate_kg_per_week=None), TODAY)

    assert isinstance(result, Suggestion)
    assert result.adjustment_kcal == D(0)
```

- [ ] **Step 2：跑，看它紅。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_body_targets.py` → Expected：FAIL（`ModuleNotFoundError: app.body_targets`）。

- [ ] **Step 3：實作。** `app/body_targets.py`：

```python
"""建議目標的公式（身體資料規格 §3）。純函式：不碰資料庫，「今天」由呼叫端給。

**全程 Decimal、ROUND_HALF_UP。** 浮點的 1.55 × 1718.75 不是 2664.0625；Python 內建的
`round()` 是銀行家捨入（2105 → 2100、400.5 → 400），跟手算、跟使用者的直覺都不一樣。

公式（Mifflin-St Jeor）：
    男 BMR = 10·kg + 6.25·cm − 5·歲 + 5；女 BMR = 10·kg + 6.25·cm − 5·歲 − 161
    TDEE = BMR × 活動係數；熱量 = TDEE ∓ 每週速度 × 7700 / 7
    下限：女 1200、男 1500（看**原始值**，D8）；否則四捨五入到 10
    蛋白質 = g/kg × 目前體重；脂肪 = 熱量 25% / 9；碳水 = 剩下的 / 4，不小於 0
"""

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from app.models.body import ActivityLevel, Goal, Sex

ACTIVITY_FACTORS: dict[ActivityLevel, Decimal] = {
    ActivityLevel.SEDENTARY: Decimal("1.2"),
    ActivityLevel.LIGHT: Decimal("1.375"),
    ActivityLevel.MODERATE: Decimal("1.55"),
    ActivityLevel.ACTIVE: Decimal("1.725"),
    ActivityLevel.VERY_ACTIVE: Decimal("1.9"),
}
PROTEIN_PER_KG: dict[Goal, Decimal] = {
    Goal.LOSE: Decimal("1.8"),
    Goal.MAINTAIN: Decimal("1.6"),
    Goal.GAIN: Decimal("2.0"),
}
KCAL_FLOOR: dict[Sex, Decimal] = {Sex.FEMALE: Decimal(1200), Sex.MALE: Decimal(1500)}
KCAL_PER_KG_BODY_WEIGHT = Decimal(7700)
FAT_SHARE = Decimal("0.25")
# 最新體重跟套用時差這麼多（含）就提示重算（D17）。
RESUGGEST_THRESHOLD_KG = Decimal(1)

MissingInput = Literal[
    "sex", "birth_year", "height_cm", "activity_level", "goal", "rate_kg_per_week", "weight"
]


@dataclass(frozen=True)
class BodyInputs:
    sex: Sex | None
    birth_year: int | None
    height_cm: Decimal | None
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None
    weight_kg: Decimal | None


@dataclass(frozen=True)
class Suggestion:
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    bmr: Decimal
    tdee: Decimal
    adjustment_kcal: Decimal
    floor_applied: bool
    floor_kcal: Decimal


def round_half_up(value: Decimal, step: Decimal = Decimal(1)) -> Decimal:
    """四捨五入到 `step` 的倍數（`step=10`：2105 → 2110）。"""
    return (value / step).quantize(Decimal(1), rounding=ROUND_HALF_UP) * step


def missing_inputs(inputs: BodyInputs) -> list[MissingInput]:
    """缺什麼（D11 的固定順序）。速度只有減重、增重要；目標還沒填時也算缺。"""
    missing: list[MissingInput] = []
    if inputs.sex is None:
        missing.append("sex")
    if inputs.birth_year is None:
        missing.append("birth_year")
    if inputs.height_cm is None:
        missing.append("height_cm")
    if inputs.activity_level is None:
        missing.append("activity_level")
    if inputs.goal is None:
        missing.append("goal")
    if inputs.goal is not Goal.MAINTAIN and inputs.rate_kg_per_week is None:
        missing.append("rate_kg_per_week")
    if inputs.weight_kg is None:
        missing.append("weight")
    return missing


def suggest(inputs: BodyInputs, today: date) -> Suggestion | list[MissingInput]:
    """完整就回建議，不完整就回缺什麼（D11）。"""
    sex, birth_year, height = inputs.sex, inputs.birth_year, inputs.height_cm
    activity, goal, weight = inputs.activity_level, inputs.goal, inputs.weight_kg
    rate = Decimal(0) if goal is Goal.MAINTAIN else inputs.rate_kg_per_week
    if (
        sex is None
        or birth_year is None
        or height is None
        or activity is None
        or goal is None
        or rate is None
        or weight is None
    ):
        # 跟 missing_inputs 是同一組條件；兩邊漂移由「每一種單獨缺」的測試抓。
        return missing_inputs(inputs)

    age = today.year - birth_year  # D7：只有出生年
    bmr = (
        Decimal(10) * weight
        + Decimal("6.25") * height
        - Decimal(5) * age
        + (Decimal(5) if sex is Sex.MALE else Decimal(-161))
    )
    tdee = bmr * ACTIVITY_FACTORS[activity]
    step = rate * KCAL_PER_KG_BODY_WEIGHT / Decimal(7)
    adjustment = {Goal.LOSE: -step, Goal.MAINTAIN: Decimal(0), Goal.GAIN: step}[goal]
    raw = tdee + adjustment

    floor = KCAL_FLOOR[sex]
    floor_applied = raw < floor  # D8：看原始值
    kcal = floor if floor_applied else round_half_up(raw, Decimal(10))

    protein = round_half_up(PROTEIN_PER_KG[goal] * weight)
    fat = round_half_up(kcal * FAT_SHARE / Decimal(9))
    # 用已經四捨五入的蛋白質與脂肪：四個數字加起來對得上熱量（誤差在四捨五入內）。
    carb = max(Decimal(0), round_half_up((kcal - protein * 4 - fat * 9) / Decimal(4)))

    return Suggestion(
        kcal=kcal,
        protein_g=protein,
        fat_g=fat,
        carb_g=carb,
        bmr=round_half_up(bmr),
        tdee=round_half_up(tdee),
        adjustment_kcal=round_half_up(adjustment),
        floor_applied=floor_applied,
        floor_kcal=floor,
    )
```

- [ ] **Step 4：跑。** 同 Step 2 → Expected：PASS（21 條）。

- [ ] **Step 5：突變**（各一處、看指定測試紅、改回；`app/body_targets.py` 是新檔案，先 `cp` 一份備份）：
  1. 女的 `-161` 改成 `-151` → case B、D、E 紅。
  2. `ROUND_HALF_UP` 改成 `ROUND_HALF_EVEN` → `test_round_half_up[2105…]`、`[400.5…]` 紅。
  3. `floor_applied = raw < floor` 改成 `round_half_up(raw, Decimal(10)) < floor` → `test_the_floor_is_judged_on_the_raw_value…` 紅（1499.2 四捨五入是 1500，突變版說「沒套用」）。
  4. `max(Decimal(0), …)` 拿掉 → case E 紅。
  5. `rate = Decimal(0) if goal is Goal.MAINTAIN else …` 改成永遠用 `inputs.rate_kg_per_week` → `test_maintain_does_not_need_a_rate` 紅（維持、速度 null 也被當成缺）。（case D 存活：維持的調整在 dict 裡本來就是 0——這是預期的。）
  6. `missing_inputs` 裡 `weight` 那一段拿掉 → `test_each_single_missing_input_is_named[weight_kg-weight]` 紅（`suggest` 回 `[]`）。
  7. 碳水的算式改用沒四捨五入的蛋白質（`PROTEIN_PER_KG[goal] * weight`）→ `test_case_f_carbs_use_the_rounded_protein` 紅（A–E 的蛋白質都是整數，全部存活——這就是 F 存在的理由）。

  `diff` 備份確認改回，`git status` 乾淨（除了新檔案）。

- [ ] **Step 6：commit。** `ruff check .`、`mypy app` 通過後：

```bash
git add app/body_targets.py tests/test_body_targets.py
```

訊息（`$S/body-t2-msg.txt`）：`feat(body): 建議目標的公式——Mifflin-St Jeor、下限、三大營養素（純函式）`。

---

## Task 3：後端——身體資料端點與 `GET /api/me/target-suggestion`

**Files:**
- Create: `app/schemas/body.py`、`app/body_data.py`、`app/api/routes/body.py`、`tests/test_body_profile.py`、`tests/test_target_suggestion.py`
- Modify: `app/main.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：schema。** `app/schemas/body.py`（這個 task 先寫身體資料與建議；體重與套用的形狀在 Task 4、5 加進同一個檔案）：

```python
"""身體資料、建議目標、體重的請求與回應（身體資料規格 §5）。健康資料：這些形狀只出現在
身體資料的端點，好友與社群的回應不准引用（`tests/test_body_privacy.py`）。"""

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.body_targets import MissingInput
from app.models.body import ActivityLevel, Goal, Sex

RATES = (Decimal("0.25"), Decimal("0.5"))


class BodyProfileRequest(BaseModel):
    """`PUT /api/me/body-profile`：**七個鍵都必填、值可以 null**（D5，同 `TargetTodayRequest`）。

    出生年這裡只擋衛生範圍（同資料庫的 CHECK）；「今年 − 100 到今年 − 13」要知道使用者的
    今天，在端點擋（D4）。"""

    sex: Sex | None
    birth_year: int | None = Field(ge=1900, le=2100)
    height_cm: Decimal | None = Field(ge=100, le=250, max_digits=4, decimal_places=1)
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None = Field(max_digits=3, decimal_places=2)
    target_weight_kg: Decimal | None = Field(ge=25, le=350, max_digits=5, decimal_places=2)

    @field_validator("rate_kg_per_week")
    @classmethod
    def _rate_is_one_of_two(cls, value: Decimal | None) -> Decimal | None:
        if value is not None and value not in RATES:
            raise ValueError("速度只能是每週 0.25 或 0.5 公斤")
        return value


class BodyProfileResponse(BaseModel):
    """沒有那一列＝七個都是 null（不是 404）。**不含** `targets_applied_weight_kg`（內部用）。"""

    sex: Sex | None
    birth_year: int | None
    height_cm: Decimal | None
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None
    target_weight_kg: Decimal | None


class SuggestionReady(BaseModel):
    """建議目標（D10：跟 `SuggestionMissing` 是普通聯集，不加 discriminator——加了
    openapi-typescript 會產生 `ready: "True"`）。"""

    ready: Literal[True]
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    bmr: Decimal
    tdee: Decimal
    adjustment_kcal: Decimal
    floor_applied: bool
    floor_kcal: Decimal
    weight_kg: Decimal
    based_on_date: date
    applied_weight_kg: Decimal | None
    weight_change_kg: Decimal | None
    resuggest: bool


class SuggestionMissing(BaseModel):
    ready: Literal[False]
    missing: list[MissingInput]
```

> 必填但可為 null 的寫法：`sex: Sex | None`（沒有預設值）在 Pydantic v2 是必填；有 `Field(...)` 而沒有 `default=` 的也是（同 `TargetTodayRequest`）。

- [ ] **Step 2：讀資料的小函式。** `app/body_data.py`：

```python
"""身體資料端點共用的讀寫（身體資料規格 §5）。只用呼叫端給的 user_id——沒有「讀別人的」這條路。"""

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.body_targets import BodyInputs
from app.models.body import UserProfile, WeightEntry


async def load_profile(db: AsyncSession, user_id: int) -> UserProfile | None:
    return await db.scalar(select(UserProfile).where(UserProfile.user_id == user_id))


async def latest_weight(db: AsyncSession, user_id: int) -> WeightEntry | None:
    """**日期**最新的一筆（不是最後寫的那一筆：補記上週的不會變成「目前體重」）。"""
    return await db.scalar(
        select(WeightEntry)
        .where(WeightEntry.user_id == user_id)
        .order_by(WeightEntry.date.desc())
        .limit(1)
    )


def inputs_from(profile: UserProfile | None, latest: WeightEntry | None) -> BodyInputs:
    return BodyInputs(
        sex=profile.sex if profile else None,
        birth_year=profile.birth_year if profile else None,
        height_cm=profile.height_cm if profile else None,
        activity_level=profile.activity_level if profile else None,
        goal=profile.goal if profile else None,
        rate_kg_per_week=profile.rate_kg_per_week if profile else None,
        weight_kg=latest.weight_kg if latest else None,
    )


async def clear_applied_weight(db: AsyncSession, user_id: int) -> None:
    """手動存目標時呼叫（D16）。不 commit：跟目標在同一個交易。沒有那一列就什麼都不做。"""
    await db.execute(
        update(UserProfile)
        .where(UserProfile.user_id == user_id)
        .values(targets_applied_weight_kg=None)
    )
```

- [ ] **Step 3：先寫測試。** `tests/test_body_profile.py`（`auth()` 同 `test_targets_today.py`；`today` 夾具 monkeypatch `app.api.routes.body.today_in_timezone`，固定 `date(2026, 10, 14)` 並記下時區）。`FULL` 是一組完整的請求：

```python
FULL = {
    "sex": "female",
    "birth_year": 1990,
    "height_cm": "162.5",
    "activity_level": "light",
    "goal": "lose",
    "rate_kg_per_week": "0.25",
    "target_weight_kg": "55",
}
```

測試清單（每條一兩個斷言；寫法照既有的端點測試）：

1. `test_an_empty_profile_is_all_nulls_not_404`：沒有列 → 200、七個鍵都是 `None`、**沒有** `targets_applied_weight_kg` 這個鍵。
2. `test_put_saves_the_whole_profile_and_get_reads_it_back`：PUT `FULL` → 200，回應等於 `FULL`（數字比 `Decimal`）；再 GET 一樣；資料庫裡只有一列。
3. `test_a_second_put_replaces_every_field`：先 PUT `FULL`，再 PUT 一組全部不同（含 `target_weight_kg: None`）→ 資料庫那一列是第二組（`target_weight_kg` 是 null），`created_at` 不變。
4. `test_put_does_not_touch_the_applied_weight`：`create_profile(..., targets_applied_weight_kg=80)` 之後 PUT `FULL` → 資料庫裡仍然是 80（`set_` 只放七個欄位）。
5. `test_every_key_is_required`（parametrize 七個鍵）：拿掉一個 → 422。
6. `test_out_of_range_values_are_422`（parametrize）：`height_cm` 99.9／250.1／`"170.25"`（兩位小數）、`target_weight_kg` 24.99／350.01、`rate_kg_per_week` `"0.3"`、`sex` `"other"`、`activity_level` `"extreme"`、`goal` `"bulk"` → 422；邊界 100、250、25、350、`"0.50"` → 200。
7. `test_birth_year_is_judged_by_the_users_today`（parametrize `(1926, 200)`、`(1925, 422)`、`(2013, 200)`、`(2014, 422)`）：使用者時區設 `America/New_York`；422 的 `error.code` 是 `BIRTH_YEAR_OUT_OF_RANGE`、訊息含「1926」與「2013」；`seen_timezones == ["America/New_York"]`。
8. `test_maintain_keeps_whatever_rate_was_sent`：`goal: "maintain"`、`rate_kg_per_week: "0.5"` → 存 0.5（D3：不清掉，切回減重還在）。
9. `test_someone_elses_profile_is_untouched`：A PUT `FULL`；B GET 是全 null；B PUT 另一組之後 A 的那一列沒變（**先**證明 A 讀得到自己的）。
10. `test_it_needs_a_login`：GET、PUT 不帶 token → 401。

`tests/test_target_suggestion.py`（這個 task 只寫 GET；`today` 同上 monkeypatch `app.api.routes.body.today_in_timezone`，固定 2026-10-14）：

1. `test_the_worked_example`：`create_profile(user=…)`（預設值）＋ `create_weight(day=2026-10-10, weight_kg=80)` → 回應等於

   ```python
   {
       "ready": True, "kcal": "2110", "protein_g": "144", "fat_g": "59", "carb_g": "251",
       "bmr": "1719", "tdee": "2664", "adjustment_kcal": "-550", "floor_applied": False,
       "floor_kcal": "1500", "weight_kg": "80.00", "based_on_date": "2026-10-10",
       "applied_weight_kg": None, "weight_change_kg": None, "resuggest": False,
   }
   ```

   （數字欄位用 `Decimal(body[k]) == Decimal(v)` 比，不比字串的小數位數。）
2. `test_the_latest_weight_is_by_date_not_by_insertion`：先建 10/10 的 80，再建 10/01 的 90 → `weight_kg` 是 80、`based_on_date` 是 10/10。
3. `test_nothing_set_lists_everything_missing`：沒有列、沒有體重 → `{"ready": False, "missing": [七個]}`（順序同 Task 2）。
4. `test_a_profile_without_a_weight_is_missing_only_the_weight`。
5. `test_resuggest_threshold`（parametrize `(applied, latest, change, resuggest)`：`("80", "79.01", "-0.99", False)`、`("80", "79", "-1.00", True)`、`("80", "81", "1.00", True)`、`(None, "81", None, False)`）。
6. `test_someone_elses_weight_does_not_count`：A 有完整的資料與體重（先證明 A 是 ready）；B 有完整的資料、沒有體重 → B 是 `missing: ["weight"]`。
7. `test_it_uses_the_users_timezone`：時區 `America/New_York` → 夾具記到它。

- [ ] **Step 4：跑，看它紅。** `pytest -q -W error tests/test_body_profile.py tests/test_target_suggestion.py` → Expected：FAIL（404：路由還不存在）。

- [ ] **Step 5：路由。** `app/api/routes/body.py`：

```python
"""身體資料與建議目標（身體資料規格 §5.1、§5.2）。只讀寫自己的：路徑上沒有使用者 id。

健康資料：這個模組不 import logging（`tests/test_body_privacy.py`）。"""

from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.body_data import inputs_from, latest_weight, load_profile
from app.body_targets import RESUGGEST_THRESHOLD_KG, suggest
from app.days import today_in_timezone
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.body import UserProfile
from app.models.user import User
from app.schemas.body import (
    BodyProfileRequest,
    BodyProfileResponse,
    SuggestionMissing,
    SuggestionReady,
)

router = APIRouter(tags=["body"])

# D4：出生年在「使用者的今年 − 100」到「今年 − 13」。
MAX_AGE = 100
MIN_AGE = 13
PROFILE_FIELDS = (
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "target_weight_kg",
)


def _profile_response(profile: UserProfile | None) -> BodyProfileResponse:
    if profile is None:
        return BodyProfileResponse(**dict.fromkeys(PROFILE_FIELDS))
    return BodyProfileResponse(**{field: getattr(profile, field) for field in PROFILE_FIELDS})


@router.get("/me/body-profile", response_model=BodyProfileResponse)
async def read_body_profile(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> BodyProfileResponse:
    """自己的身體資料。還沒填過＝七個都是 null（200，不是 404）。"""
    return _profile_response(await load_profile(db, user.id))


@router.put("/me/body-profile", response_model=BodyProfileResponse)
async def save_body_profile(
    payload: BodyProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BodyProfileResponse:
    """整組取代自己的身體資料（D5）。`INSERT … ON CONFLICT DO UPDATE`：兩台裝置同時第一次存
    不會撞主鍵變 500。套用時的體重不在這裡改（`set_` 只有七個欄位）。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    if payload.birth_year is not None:
        earliest, latest = today.year - MAX_AGE, today.year - MIN_AGE
        if not earliest <= payload.birth_year <= latest:
            raise UnprocessableEntityError(
                "BIRTH_YEAR_OUT_OF_RANGE", f"出生年要在 {earliest} 到 {latest} 之間"
            )

    values = payload.model_dump()
    statement = (
        pg_insert(UserProfile)
        .values(user_id=user_id, **values)
        .on_conflict_do_update(
            index_elements=[UserProfile.user_id],
            # ON CONFLICT 不走 ORM 的 onupdate：updated_at 自己寫。
            set_={**values, "updated_at": func.now()},
        )
        .returning(*(getattr(UserProfile, field) for field in PROFILE_FIELDS))
    )
    row = (await db.execute(statement)).one()
    await db.commit()
    return BodyProfileResponse(**row._asdict())


@router.get("/me/target-suggestion", response_model=SuggestionReady | SuggestionMissing)
async def read_target_suggestion(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> SuggestionReady | SuggestionMissing:
    """依身體資料與**日期最新**的體重算建議目標（規格 §3）；缺什麼就回缺什麼（D11）。

    `resuggest`：最新體重跟套用建議時的體重差 ≥ 1 公斤（D17）。從沒套用過、或之後手動改過
    目標（D16）時 `applied_weight_kg` 是 null，不提示。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    profile = await load_profile(db, user_id)
    latest = await latest_weight(db, user_id)
    result = suggest(inputs_from(profile, latest), today)
    if isinstance(result, list):
        return SuggestionMissing(ready=False, missing=result)
    assert latest is not None  # suggest 只有在有體重時才回建議

    applied = profile.targets_applied_weight_kg if profile is not None else None
    change: Decimal | None = None if applied is None else latest.weight_kg - applied
    return SuggestionReady(
        ready=True,
        kcal=result.kcal,
        protein_g=result.protein_g,
        fat_g=result.fat_g,
        carb_g=result.carb_g,
        bmr=result.bmr,
        tdee=result.tdee,
        adjustment_kcal=result.adjustment_kcal,
        floor_applied=result.floor_applied,
        floor_kcal=result.floor_kcal,
        weight_kg=latest.weight_kg,
        based_on_date=latest.date,
        applied_weight_kg=applied,
        weight_change_kg=change,
        resuggest=change is not None and abs(change) >= RESUGGEST_THRESHOLD_KG,
    )
```

`app/main.py`：`from app.api.routes import body`（照字母順序加進既有的 import 清單），`app.include_router(body.router, prefix="/api")` 放在 `me.router` 那一行後面。

> `.returning(...)` 回來的 `sex`、`activity_level`、`goal` 是 enum 成員（欄位型別是 `Enum`）。如果 asyncpg 回的是字串而 Pydantic 照樣收（StrEnum），不用處理。

- [ ] **Step 6：跑。** 同 Step 4 → Expected：PASS（`test_body_profile.py` 約 30 條含 parametrize、`test_target_suggestion.py` 10 條）。

- [ ] **Step 7：突變**（`routes/body.py`、`body_data.py` 是新檔案，先備份）：
  1. `save_body_profile` 拿掉出生年的檢查 → 第 7 條的 `1925`、`2014` 紅。
  2. `MIN_AGE` 的比較寫成 `<`（`earliest <= birth_year < latest`）→ `2013` 那一格紅。
  3. `set_` 改成 `{**values}`（拿掉 `updated_at`）→ **存活**（`now()` 在共用交易裡不變，開工前必讀第 4 點）。記下來，不補測試。
  4. `on_conflict_do_update` 整段拿掉 → 第 3 條紅（第二次 PUT 撞主鍵：500 或 IntegrityError）。
  5. `latest_weight` 的 `.desc()` 拿掉 → `test_the_latest_weight_is_by_date_not_by_insertion` 紅。
  6. `abs(change) >= …` 改成 `change >= …` → `resuggest` 的 `-1.00` 那一格紅。
  7. `today_in_timezone(user.timezone)` 改成 `today_in_timezone("Asia/Taipei")` → 時區那兩條紅。

  改回、`touch`、刪 pyc，`diff` 備份、`git diff` 乾淨。

- [ ] **Step 8：重新產生 `schema.d.ts`**（執行環境那一段），`cd frontend && npm run -s typecheck` → 綠。

- [ ] **Step 9：檢查與 commit。** `ruff check .`、`mypy app` 通過：

```bash
git add app/schemas/body.py app/body_data.py app/api/routes/body.py app/main.py tests/test_body_profile.py tests/test_target_suggestion.py frontend/src/api/schema.d.ts
```

訊息（`$S/body-t3-msg.txt`）：`feat(body): 身體資料的讀寫與建議目標（GET /api/me/body-profile、PUT、/api/me/target-suggestion）`。

---

## Task 4：後端——體重的三個端點與 `weights.csv`

**Files:**
- Create: `app/api/routes/weights.py`、`tests/test_weights.py`、`tests/test_weights_concurrency.py`
- Modify: `app/schemas/body.py`、`app/main.py`、`app/export.py`、`app/api/routes/export.py`、`tests/test_export.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：schema。** `app/schemas/body.py` 加：

```python
class WeightRequest(BaseModel):
    weight_kg: Decimal = Field(ge=25, le=350, max_digits=5, decimal_places=2)


class WeightEntryResponse(BaseModel):
    date: date
    weight_kg: Decimal


class WeightListResponse(BaseModel):
    """`today` 是使用者時區的今天（D14）：前端拿它當表單的預設日期與圖表的右端，不自己算。"""

    today: date
    entries: list[WeightEntryResponse]
```

> `WeightEntryResponse` 的欄位叫 `date`、型別也是 `date`：Pydantic 的類別本體裡 `date: date` 會讓之後的註解看到欄位而不是型別。這個類別只有這一個 `date` 註解，而且在 `weight_kg` 前面——沒有問題；**不要在它後面再加用到 `date` 型別的欄位**。

- [ ] **Step 2：先寫測試。** `tests/test_weights.py`。夾具 `today` monkeypatch `app.api.routes.weights.today_in_timezone`：固定 `TODAY = date(2026, 10, 14)`、記下時區。使用者時區設 `America/New_York`。

1. `test_put_creates_then_corrects_the_same_day`：PUT `/api/weights/2026-10-14` `{"weight_kg": "80.4"}` → 200 `{"date": "2026-10-14", "weight_kg": "80.40"}`；再 PUT `"79.9"` → 200；資料庫裡那一天只有一列、值是 79.90、`created_at` 跟第一次一樣。
2. `test_the_date_boundaries_follow_the_users_today`（parametrize：`TODAY` → 200、`TODAY + 1 天` → 422 `WEIGHT_DATE_IN_FUTURE`、`TODAY − 730 天` → 200、`TODAY − 731 天` → 422 `WEIGHT_DATE_TOO_OLD`）；`seen_timezones` 都是 `America/New_York`。
3. `test_bad_weights_are_422`（parametrize `"24.99"`、`"350.01"`、`"80.123"`、`"abc"`、缺 `weight_kg`）；`"25"`、`"350"` → 200。
4. `test_a_date_that_is_not_a_date_is_422`：`/api/weights/2026-13-01`、`/api/weights/yesterday`。
5. `test_list_defaults_to_the_last_800_days_oldest_first`：建 `TODAY`、`TODAY − 799`、`TODAY − 800`、`TODAY − 3` 四筆 → `GET /api/weights` 回 `today == "2026-10-14"`、entries 是 `TODAY − 799`、`TODAY − 3`、`TODAY` 三筆（由舊到新，800 天前那筆不在）。
6. `test_list_with_a_range`：`?from=2026-10-01&to=2026-10-10` 只回範圍內（兩端都含）；只給 `from` → `to` 是今天；只給 `to` → `from` 是 `to − 799`。
7. `test_list_range_errors`：`from > to` → 422 `INVALID_RANGE`；801 天 → 422 `RANGE_TOO_LONG`；800 天 → 200。
8. `test_delete`：刪一筆 → 204、再 GET 沒有它；再刪一次 → 404 `WEIGHT_NOT_FOUND`。
9. `test_someone_elses_weights`：A 記一筆（**先**證明 A 的 GET 有它）；B 的 GET 是空的；B 刪同一天 → 404，A 的那筆還在；B PUT 同一天 → 200 但 A 的值沒變。
10. `test_it_needs_a_login`：三個端點不帶 token → 401。

- [ ] **Step 3：並行的 upsert。** `tests/test_weights_concurrency.py`：照抄 `tests/test_invites_concurrency.py` 的 `independent_sessions` 夾具與 `_wait_until_someone_else_is_lock_waiting`（或從那裡 import——那兩個是模組層級的名字），直接呼叫 `routes/weights.py` 的 `upsert_weight`（Step 5）：

```python
async def test_two_concurrent_upserts_of_the_same_day_both_succeed(independent_sessions):
    """兩個同時到的 PUT（兩台裝置）：第二個卡在第一個的列鎖上，第一個 commit 之後走
    DO UPDATE——兩個都成功、只有一列、值是後到的。換成「先查再 INSERT」的寫法，第二個會
    撞主鍵（handover §6 第 14 種：共用 session 的端點測試看不到這件事）。"""
    user = User(
        email=f"weight-race-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name="race",
    )
    async with independent_sessions() as setup:
        setup.add(user)
        await setup.commit()
    day = date(2026, 10, 14)
    try:
        async with independent_sessions() as first, independent_sessions() as second:
            await upsert_weight(first, user.id, day, Decimal("80"))
            first_pid = await first.scalar(select(func.pg_backend_pid()))
            racing = asyncio.create_task(upsert_weight(second, user.id, day, Decimal("81")))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()
            await racing
            await second.commit()
        async with independent_sessions() as check:
            rows = (
                await check.execute(
                    select(WeightEntry.weight_kg).where(WeightEntry.user_id == user.id)
                )
            ).scalars().all()
        assert rows == [Decimal("81.00")]
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user.id))
            await cleanup.commit()
```

> `_wait_until_someone_else_is_lock_waiting` 的簽名以那個檔案的現況為準；它等的是 `pg_stat_activity` 裡別的連線在等鎖。

- [ ] **Step 4：跑，看它紅。** → Expected：FAIL（路由、`upsert_weight` 不存在）。

- [ ] **Step 5：路由。** `app/api/routes/weights.py`：

```python
"""體重紀錄（身體資料規格 §5.3）。一人一天一筆，日期是使用者時區的日曆日；只讀寫自己的。

健康資料：這個模組不 import logging（`tests/test_body_privacy.py`）。"""

from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.models.body import WeightEntry
from app.models.user import User
from app.schemas.body import WeightEntryResponse, WeightListResponse, WeightRequest

router = APIRouter(prefix="/weights", tags=["weights"])

# D13：可以補記兩年內的日子。D14：清單一次最多 800 天（比兩年多一點，剛記的都在裡面）。
MAX_BACKFILL_DAYS = 730
MAX_LIST_DAYS = 800


async def upsert_weight(
    db: AsyncSession, user_id: int, day: date, weight_kg: Decimal
) -> WeightEntryResponse:
    """新增或更正那一天（D13）。不 commit。`ON CONFLICT DO UPDATE` 由資料庫決定誰先誰後：
    同一天兩個同時到的請求，後到的等先到的 commit 再更新，兩個都成功（並行測試守著）。"""
    statement = (
        pg_insert(WeightEntry)
        .values(user_id=user_id, date=day, weight_kg=weight_kg)
        .on_conflict_do_update(
            index_elements=[WeightEntry.user_id, WeightEntry.date],
            set_={"weight_kg": weight_kg, "updated_at": func.now()},
        )
        .returning(WeightEntry.date, WeightEntry.weight_kg)
    )
    row = (await db.execute(statement)).one()
    return WeightEntryResponse(date=row.date, weight_kg=row.weight_kg)


@router.put("/{day}", response_model=WeightEntryResponse)
async def put_weight(
    day: date,
    payload: WeightRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WeightEntryResponse:
    """記（或更正）某一天的體重。日期不能是使用者的明天以後，也不能早於兩年前。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    if day > today:
        raise UnprocessableEntityError("WEIGHT_DATE_IN_FUTURE", "不能記未來的體重")
    if day < today - timedelta(days=MAX_BACKFILL_DAYS):
        raise UnprocessableEntityError("WEIGHT_DATE_TOO_OLD", "只能補記兩年內的體重")
    saved = await upsert_weight(db, user_id, day, payload.weight_kg)
    await db.commit()
    return saved


@router.delete("/{day}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_weight(
    day: date,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    deleted = await db.scalar(
        delete(WeightEntry)
        .where(WeightEntry.user_id == user.id, WeightEntry.date == day)
        .returning(WeightEntry.date)
    )
    if deleted is None:
        raise NotFoundError("WEIGHT_NOT_FOUND", "那一天沒有體重紀錄")
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("", response_model=WeightListResponse)
async def list_weights(
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WeightListResponse:
    """一段日期的體重，由舊到新，兩端都含（D14）。`to` 省略＝使用者的今天；`from` 省略＝
    `to` 往回 799 天（共 800 天）。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    end = date_to if date_to is not None else today
    start = date_from if date_from is not None else end - timedelta(days=MAX_LIST_DAYS - 1)
    if end < start:
        raise UnprocessableEntityError("INVALID_RANGE", "結束日期不能早於開始日期")
    span = (end - start).days + 1
    if span > MAX_LIST_DAYS:
        raise UnprocessableEntityError(
            "RANGE_TOO_LONG", f"期間最多 {MAX_LIST_DAYS} 天，這次是 {span} 天"
        )
    rows = (
        await db.execute(
            select(WeightEntry.date, WeightEntry.weight_kg)
            .where(
                WeightEntry.user_id == user_id,
                WeightEntry.date >= start,
                WeightEntry.date <= end,
            )
            .order_by(WeightEntry.date)
        )
    ).all()
    return WeightListResponse(
        today=today,
        entries=[WeightEntryResponse(date=row.date, weight_kg=row.weight_kg) for row in rows],
    )
```

`app/main.py`：import `weights`，`app.include_router(weights.router, prefix="/api")`。

- [ ] **Step 6：`weights.csv`。** `app/export.py`：

```python
WEIGHT_COLUMNS = ("日期", "體重(kg)")


async def weight_csv(db: AsyncSession, *, user_id: int) -> AsyncIterator[bytes]:
    """體重：一天一列，由舊到新。日期就是記的時候選的那一天（日曆日），不用換時區。
    主鍵是 (user_id, date)，所以游標只要日期。"""
    yield encode_header(WEIGHT_COLUMNS)
    after: date | None = None
    while True:
        query = (
            select(WeightEntry.date, WeightEntry.weight_kg)
            .where(WeightEntry.user_id == user_id)
            .order_by(WeightEntry.date)
            .limit(EXPORT_CHUNK_ROWS)
        )
        if after is not None:
            query = query.where(WeightEntry.date > after)
        rows = (await db.execute(query)).all()
        if not rows:
            return
        yield encode_rows([(row.date.isoformat(), row.weight_kg) for row in rows])
        after = rows[-1].date
```

（`from datetime import date, datetime`、`from app.models.body import WeightEntry`。）`app/api/routes/export.py` 照 `export_supplements` 加：

```python
@router.get("/weights.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_weights(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的體重：一天一列，由舊到新。"""
    return await _csv_response(db, weight_csv(db, user_id=user.id), name="weights", user=user)
```

> 先確認既有的三個匯出端點掛的依賴（`export_slot`、限速）——照它們的寫法掛，四個共用同一個額度（規格 D18）。`>` 改成 `>=` 會變成無限迴圈（handover §7）：突變時加 `timeout`。

`tests/test_export.py`：`WEIGHTS = "/api/export/weights.csv"`、`WEIGHT_HEADER = ["日期", "體重(kg)"]`；兩個既有的 parametrize（檔名與標題、要登入）各加一組；新增：

```python
async def test_weights_come_oldest_first_one_row_per_day(client, db_session, monkeypatch):
    """跨兩塊（chunk 調成 2）：三天、順序、值，而且沒有別人的。"""
    monkeypatch.setattr("app.export.EXPORT_CHUNK_ROWS", 2)
    user = await create_user(db_session)
    other = await create_user(db_session)
    for day, kg in [(date(2026, 10, 3), "70.5"), (date(2026, 10, 1), "71"), (date(2026, 10, 2), "70.8")]:
        await create_weight(db_session, user=user, day=day, weight_kg=kg)
    await create_weight(db_session, user=other, day=date(2026, 10, 1), weight_kg="99")

    response = await client.get(WEIGHTS, headers=auth(user.id))

    rows = list(csv.reader(io.StringIO(response.content.decode("utf-8-sig"))))
    assert rows == [
        WEIGHT_HEADER,
        ["2026-10-01", "71.00"],
        ["2026-10-02", "70.80"],
        ["2026-10-03", "70.50"],
    ]
```

（`EXPORT_CHUNK_ROWS` 的 monkeypatch 寫法以 `test_export.py` 現況為準；`auth()` 也是。）

- [ ] **Step 7：跑。** `pytest -q -W error tests/test_weights.py tests/test_weights_concurrency.py tests/test_export.py` → Expected：PASS。

- [ ] **Step 8：突變**（新檔案先備份；`weight_csv` 的突變用 `timeout 300`）：
  1. `if day > today` 改成 `>=` → 第 2 條的 `TODAY` 紅。
  2. `MAX_BACKFILL_DAYS` 的比較改成 `<=` → `TODAY − 730` 紅。
  3. `upsert_weight` 換成「`db.add(WeightEntry(...))` + flush」→ 第 1 條紅（第二次 PUT 撞主鍵）、並行那條紅。
  4. 只換並行那一種寫法：先 `select` 有沒有，沒有就 `insert … ON CONFLICT DO NOTHING`、有就 `update` → **端點測試全綠、只有並行那條紅**（這就是它存在的理由）。
  5. `list_weights` 的 `end - timedelta(days=MAX_LIST_DAYS - 1)` 改成 `MAX_LIST_DAYS` → 第 5 條紅（800 天前那筆跑進來）。
  6. `delete_weight` 的 `WeightEntry.user_id == user.id` 拿掉 → 第 9 條紅。
  7. `weight_csv` 的 `.where(WeightEntry.user_id == user_id)` 拿掉 → 匯出那條紅（多一列 99）。

  改回、`touch`、刪 pyc、`diff` 備份、`git diff` 乾淨。

- [ ] **Step 9：重新產生 `schema.d.ts`**、`npm run -s typecheck` 綠。

- [ ] **Step 10：commit。** `ruff check .`、`mypy app`：

```bash
git add app/schemas/body.py app/api/routes/weights.py app/main.py app/export.py app/api/routes/export.py tests/test_weights.py tests/test_weights_concurrency.py tests/test_export.py frontend/src/api/schema.d.ts
```

訊息（`$S/body-t4-msg.txt`）：`feat(body): 體重紀錄的三個端點與 weights.csv 匯出`。
