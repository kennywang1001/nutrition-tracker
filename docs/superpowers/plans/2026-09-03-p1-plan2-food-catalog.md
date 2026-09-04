# P1 計畫 2：食物主檔 + 版本化 + 審核流程 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立食物主檔的分層結構（全域 + 私人）、營養素的版本化、以及全域食物編輯的管理員審核流程。這是整份規格裡資料庫設計最重的一塊。

**Architecture:** `foods` 只存身分，`food_revisions` 存營養素並帶審核狀態，`foods.current_revision_id` 指向目前生效的版本 —— 未審核的資料在結構上就查不到。兩張表互相參照，靠 `DEFERRABLE INITIALLY DEFERRED` 讓「建立食物 + 建立第一版」在同一個交易內完成。`food_portions` 同樣分層。

**Tech Stack:** 沿用計畫 1 —— FastAPI、SQLAlchemy 2.0 (async)、Alembic、Pydantic v2、PostgreSQL 16.15、pytest、ruff、mypy

**規格來源：** [2026-09-02-diet-tracker-p1-design.md](../specs/2026-09-02-diet-tracker-p1-design.md) 第 5（決策 2/3/4）、6.2、7.2、7.3、9、10.3 節

**前置狀態：** 計畫 1 已合併，63 個測試通過，覆蓋率 95%，CI 綠燈。

---

## 這份計畫從計畫 1 繼承的規矩

實作時必須遵守，違反會在 `alembic check` 或 CI 被擋下來：

1. **每個 `CheckConstraint` 都必須明確給 `name=`。** `app/models/base.py` 的
   `NAMING_CONVENTION` 用了 `%(constraint_name)s`，沒給名字會在定義表的當下就拋
   `InvalidRequestError`。
2. **enum 欄位型別要用 `postgresql.ENUM(..., create_type=False)`**，型別的建立與刪除
   另外用 `sa.Enum(...).create()` / `.drop()` 明確管理。直接把 `sa.Enum` 丟進
   `op.create_table` 會發出第二道 `CREATE TYPE`，撞成 `DuplicateObjectError`。
3. **手寫 migration 的約束名稱要跟 `NAMING_CONVENTION` 算出來的一致。**
   主鍵要明確寫 `sa.PrimaryKeyConstraint("id", name="pk_<表名>")`。
   寫完跑 `alembic check`，必須是 `No new upgrade operations detected.`。
4. **存取他人資源回 404，不是 403。** 403 等於告訴對方「這個 ID 存在」。
   Task 1 的 `get_owned_or_404` 就是為了讓這條規則只有一個實作。
5. **任何 handler 捕捉了 `db.commit()` 的錯誤，必須先 `await db.rollback()`**
   才能再用那個 session，否則同一個測試後續的所有查詢都會拋 `PendingRollbackError`。
6. **所有資料庫存取都要經過 `get_db`**，否則會跑在測試的交易隔離外面。

---

## 檔案結構

```
app/
  models/
    food.py          Food / FoodRevision / FoodPortion / RevisionStatus / BaseUnit
    __init__.py      註冊新 model（漏掉的話 autogenerate 會想刪表）
  schemas/
    food.py          食物、版本、份量的請求與回應
  api/
    deps.py          新增 get_owned_or_404
    routes/
      foods.py       /api/foods 的所有端點
      admin_foods.py /api/admin/food-revisions 的審核端點
  main.py            掛上兩個新 router

migrations/versions/
  0002_create_foods.py

tests/
  factories.py            新增 create_food / create_revision / create_portion
  test_deps_ownership.py  get_owned_or_404
  test_foods_create.py
  test_foods_read.py
  test_foods_search.py
  test_foods_revisions.py
  test_foods_portions.py
  test_admin_review.py
  test_cross_user_isolation.py
```

**分割原則：** 食物的一般端點與管理員審核端點分成兩個 router，因為它們的權限依賴
不同（`get_current_user` vs `require_admin`），混在一起容易漏掉權限檢查。

---

### Task 1: `get_owned_or_404`

**先做這個，再寫任何一條有擁有權檢查的路由。** 計畫 1 的審查特別指出：抄
`require_admin`（角色不符 → `ForbiddenError` → 403）的直覺會抄錯，因為擁有權不符
看起來形狀一模一樣，但規格要求 404。

**Files:**
- Modify: `app/api/deps.py`
- Test: `tests/test_deps_ownership.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_deps_ownership.py`:

```python
import pytest

from app.api.deps import get_owned_or_404
from app.errors import NotFoundError
from app.models.user import User
from tests.factories import create_user


async def test_returns_the_resource_when_the_owner_matches(db_session):
    user = await create_user(db_session)

    found = await get_owned_or_404(db_session, User, user.id, owner_id=user.id, owner_field="id")

    assert found.id == user.id


async def test_raises_not_found_when_the_owner_differs(db_session):
    """別人的資源要回 404，不是 403 —— 403 等於承認這個 ID 存在。"""
    owner = await create_user(db_session)
    other = await create_user(db_session)

    with pytest.raises(NotFoundError):
        await get_owned_or_404(db_session, User, owner.id, owner_id=other.id, owner_field="id")


async def test_raises_not_found_when_the_resource_does_not_exist(db_session):
    user = await create_user(db_session)

    with pytest.raises(NotFoundError):
        await get_owned_or_404(db_session, User, 999_999, owner_id=user.id, owner_field="id")


async def test_the_two_failure_modes_are_indistinguishable(db_session):
    """「不存在」跟「不屬於你」必須拋出完全一樣的錯誤。"""
    owner = await create_user(db_session)
    other = await create_user(db_session)

    with pytest.raises(NotFoundError) as not_yours:
        await get_owned_or_404(db_session, User, owner.id, owner_id=other.id, owner_field="id")
    with pytest.raises(NotFoundError) as missing:
        await get_owned_or_404(db_session, User, 999_999, owner_id=other.id, owner_field="id")

    assert not_yours.value.code == missing.value.code
    assert not_yours.value.message == missing.value.message
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_deps_ownership.py -v`
Expected: FAIL，`ImportError: cannot import name 'get_owned_or_404'`

- [ ] **Step 3: 寫實作**

在 `app/api/deps.py` 的 import 區補上：

```python
from sqlalchemy.orm import DeclarativeBase

from app.errors import ForbiddenError, NotFoundError, UnauthorizedError
```

並在檔案末端加入：

```python
async def get_owned_or_404[Model: DeclarativeBase](
    db: AsyncSession,
    model: type[Model],
    resource_id: int,
    *,
    owner_id: int,
    owner_field: str = "owner_id",
) -> Model:
    """取出資源，若不存在或不屬於 owner_id 則拋 NotFoundError。

    規格第 9 節：存取他人資源要回 404 而非 403 —— 403 等於告訴對方
    「這個 ID 存在，只是你不能看」，攻擊者可以據此列舉系統裡有哪些資源。

    兩種失敗必須拋出一模一樣的錯誤，否則差異本身就是洩漏。
    """
    resource = await db.get(model, resource_id)
    if resource is None or getattr(resource, owner_field) != owner_id:
        raise NotFoundError("NOT_FOUND", "找不到該資源")
    return resource
```

> **`"NOT_FOUND"` 這個泛用代碼是刻意的，不是偷懶。**
> 若之後某條路由想要 `FOOD_NOT_FOUND`，那必須發生在這個函式**外面**
> （呼叫端接住再重拋）。**絕對不能**在函式裡依「是哪一種失敗」來分岔代碼 ——
> 那個分岔本身就是這個函式存在要防止的洩漏。

> **泛型用 PEP 695 的行內語法（`[Model: DeclarativeBase]`），不是 `TypeVar`。**
> 這個專案的 ruff 開了 `UP` 規則、`target-version = "py312"`，
> 舊的 `TypeVar` 寫法會被 `UP047` 擋下來。
>
> 型別窄化是有效的：呼叫端拿到的是具體的 `Food`，不是 `DeclarativeBase`
> （用 `reveal_type` 驗證過）。

> **`owner_field` 打錯字會拋 `AttributeError`，這是對的。**
> 它在**每一次**呼叫都會炸，而不是只在擁有權真的不符時 —— 所以第一次跑到那條路由
> 就會發現。不要加 `hasattr` 防護：那會把一個大聲的呼叫端 bug
> 變成一個安靜的、錯誤的 404。

> **為什麼要有 `owner_field` 參數：** `foods` 的擁有者欄位叫 `owner_id`，
> 但 `users` 自己的「擁有者」就是 `id`。之後 `meals` 用的是 `user_id`。
> 一個參數就涵蓋全部，不需要為每張表寫一個函式。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_deps_ownership.py -v`
Expected: `4 passed`

- [ ] **Step 5: Commit**

```bash
git add app/api/deps.py tests/test_deps_ownership.py
git commit -m "feat: 新增 get_owned_or_404 擁有權檢查輔助函式"
```

---

### Task 2: 食物相關的 model

**Files:**
- Create: `app/models/food.py`
- Modify: `app/models/__init__.py`

- [ ] **Step 1: 建立 model**

`app/models/food.py`:

```python
import enum
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RevisionStatus(enum.StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class BaseUnit(enum.StrEnum):
    G = "g"
    ML = "ml"


def _enum_column(enum_type: type[enum.StrEnum], name: str) -> Enum:
    return Enum(enum_type, name=name, values_callable=lambda e: [m.value for m in e])


class Food(Base):
    __tablename__ = "foods"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "name",
            "brand",
            name="uq_foods_owner_id_name_brand",
            postgresql_nulls_not_distinct=True,
        ),
        Index("ix_foods_owner_id", "owner_id"),
        Index(
            "ix_foods_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    brand: Mapped[str | None] = mapped_column(Text)
    # NULL = 全域食物
    owner_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE")
    )
    # 指向目前生效的版本。只有審核通過才會更新這個指標 ——
    # 未審核的資料因此在結構上就查不到，不依賴任何人記得寫 WHERE status = 'approved'。
    current_revision_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("food_revisions.id", deferrable=True, initially="DEFERRED"),
    )
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class FoodRevision(Base):
    __tablename__ = "food_revisions"
    __table_args__ = (
        CheckConstraint("kcal >= 0", name="kcal_non_negative"),
        CheckConstraint("protein_g >= 0", name="protein_non_negative"),
        CheckConstraint("fat_g >= 0", name="fat_non_negative"),
        CheckConstraint("carb_g >= 0", name="carb_non_negative"),
        CheckConstraint(
            "ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)",
            name="ai_confidence_in_range",
        ),
        CheckConstraint(
            "status <> 'rejected' OR reject_reason IS NOT NULL",
            name="rejected_needs_reason",
        ),
        # 同一個食物同時只能有一筆待審編輯。交給資料庫擋，不是靠程式檢查。
        Index(
            "uq_food_revisions_one_pending",
            "food_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        Index(
            "ix_food_revisions_pending",
            "status",
            "created_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    food_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("foods.id", ondelete="CASCADE"), nullable=False
    )
    base_unit: Mapped[BaseUnit] = mapped_column(
        _enum_column(BaseUnit, "base_unit"), nullable=False, default=BaseUnit.G
    )
    kcal: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    protein_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    fat_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    carb_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    status: Mapped[RevisionStatus] = mapped_column(
        _enum_column(RevisionStatus, "revision_status"),
        nullable=False,
        default=RevisionStatus.PENDING,
    )
    change_note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    reviewed_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reject_reason: Mapped[str | None] = mapped_column(Text)
    # P2 階段（AI 分析）預留，本計畫不使用
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="user")
    ai_confidence: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    ai_raw_response: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class FoodPortion(Base):
    __tablename__ = "food_portions"
    __table_args__ = (
        CheckConstraint("grams > 0", name="grams_positive"),
        UniqueConstraint(
            "food_id",
            "owner_id",
            "label",
            name="uq_food_portions_food_id_owner_id_label",
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    food_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("foods.id", ondelete="CASCADE"), nullable=False
    )
    # NULL = 全域份量（管理員維護）
    owner_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE")
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    grams: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
```

- [ ] **Step 2: 註冊 model**

`app/models/__init__.py` 改為：

```python
from app.models.base import Base
from app.models.food import BaseUnit, Food, FoodPortion, FoodRevision, RevisionStatus
from app.models.user import User, UserRole

__all__ = [
    "Base",
    "BaseUnit",
    "Food",
    "FoodPortion",
    "FoodRevision",
    "RevisionStatus",
    "User",
    "UserRole",
]
```

> 漏掉這一步，`alembic revision --autogenerate` 不會報錯 —— 它會**認為那些表該被刪掉**。

- [ ] **Step 3: 確認 model 能載入且約束名稱如預期**

Run:
```bash
python -c "
from app.models import Base
for t in sorted(Base.metadata.tables):
    print(t, sorted(c.name for c in Base.metadata.tables[t].constraints))
"
```
Expected: `foods`、`food_revisions`、`food_portions`、`users` 四張表，且 CHECK 約束的名稱都是
`ck_<表名>_<用途>` 的形式（例如 `ck_food_revisions_kcal_non_negative`）。

若載入時拋出 `InvalidRequestError` 且訊息提到 `constraint_name`，代表某個
`CheckConstraint` 漏了 `name=` —— 那是 `NAMING_CONVENTION` 刻意造成的，把名字補上。

- [ ] **Step 4: 確認 `postgresql_nulls_not_distinct` 在這個版本可用**

Run:
```bash
python -c "
from sqlalchemy.schema import CreateTable
from app.models import Base
print(CreateTable(Base.metadata.tables['foods']).compile(dialect=__import__('sqlalchemy').dialects.postgresql.dialect()))
"
```
Expected: 輸出的 DDL 裡有 `UNIQUE NULLS NOT DISTINCT`。

若沒有，代表安裝的 SQLAlchemy 版本不支援這個參數 —— **停下來回報**，不要改用
其他寫法，因為 `NULLS NOT DISTINCT` 是「全域食物同名視為重複」的關鍵。

- [ ] **Step 5: Commit**

```bash
git add app/models/food.py app/models/__init__.py
git commit -m "feat: 新增 foods / food_revisions / food_portions 的 model"
```

> **這個 task 結束時測試套件是紅的，這是必然的，不是做錯了。**
>
> `tests/conftest.py` 的 `migrated_database` fixture 每個 session 都會跑
> `alembic check`。model 加了、migration 還沒加，它就會正確地偵測到漂移，
> 於是**所有碰資料庫的測試都會在 fixture 階段失敗**（不是斷言失敗）。
>
> 實測：26 過 / 41 錯。Task 3 的 migration 一落地就會恢復。
>
> 這是計畫 1 那道漂移檢查的直接代價 —— 它是載重的防護，代價就是
> **model 與 migration 之間存在一個必然為紅的中間狀態**。
> 不要為了讓它變綠而動 conftest。

> **`ai_raw_response` 要寫 `Mapped[dict[str, Any] | None]`。**
> 裸的 `dict` 在 `mypy --strict` 下會報 `Missing type arguments for generic type "dict"`。
> `app/errors.py` 與 `app/security/tokens.py` 已經是這個寫法。

> **循環外鍵讓 `Base.metadata.sorted_tables` 發出警告：**
> `Cannot correctly sort tables; there are unresolvable cycles between tables
> "food_revisions, foods"`，而且它會**直接放棄考慮那些外鍵的順序**。
>
> 目前沒有東西呼叫 `sorted_tables`（測試跑的是真的 Alembic migration，不是
> `create_all`），所以不會觸發。但這證實了 Task 3 的做法是必要的：
> **兩張表要先各自建好、`current_revision_id` 的外鍵最後用
> `op.create_foreign_key` 單獨加**，不能指望自動排序。

---

### Task 3: migration 0002

**Files:**
- Create: `migrations/versions/0002_create_foods.py`

- [ ] **Step 1: 手寫 migration**

`migrations/versions/0002_create_foods.py`:

```python
"""create foods, food_revisions, food_portions

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ENUM, JSONB

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    revision_status = sa.Enum("pending", "approved", "rejected", name="revision_status")
    revision_status.create(op.get_bind())
    base_unit = sa.Enum("g", "ml", name="base_unit")
    base_unit.create(op.get_bind())

    op.create_table(
        "foods",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("brand", sa.Text),
        sa.Column("owner_id", sa.BigInteger),
        sa.Column("current_revision_id", sa.BigInteger),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_foods"),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_foods_owner_id_users", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_foods_created_by_users"
        ),
    )

    op.create_table(
        "food_revisions",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("food_id", sa.BigInteger, nullable=False),
        sa.Column(
            "base_unit",
            ENUM("g", "ml", name="base_unit", create_type=False),
            nullable=False,
            server_default="g",
        ),
        sa.Column("kcal", sa.Numeric(8, 2), nullable=False),
        sa.Column("protein_g", sa.Numeric(8, 2), nullable=False),
        sa.Column("fat_g", sa.Numeric(8, 2), nullable=False),
        sa.Column("carb_g", sa.Numeric(8, 2), nullable=False),
        sa.Column(
            "status",
            ENUM("pending", "approved", "rejected", name="revision_status", create_type=False),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("change_note", sa.Text),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("reviewed_by", sa.BigInteger),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("reject_reason", sa.Text),
        sa.Column("source", sa.Text, nullable=False, server_default="user"),
        sa.Column("ai_confidence", sa.Numeric(3, 2)),
        sa.Column("ai_raw_response", JSONB),
        sa.PrimaryKeyConstraint("id", name="pk_food_revisions"),
        sa.ForeignKeyConstraint(
            ["food_id"], ["foods.id"], name="fk_food_revisions_food_id_foods", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_food_revisions_created_by_users"
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by"], ["users.id"], name="fk_food_revisions_reviewed_by_users"
        ),
        sa.CheckConstraint("kcal >= 0", name="kcal_non_negative"),
        sa.CheckConstraint("protein_g >= 0", name="protein_non_negative"),
        sa.CheckConstraint("fat_g >= 0", name="fat_non_negative"),
        sa.CheckConstraint("carb_g >= 0", name="carb_non_negative"),
        sa.CheckConstraint(
            "ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)",
            name="ai_confidence_in_range",
        ),
        sa.CheckConstraint(
            "status <> 'rejected' OR reject_reason IS NOT NULL",
            name="rejected_needs_reason",
        ),
    )

    # 注意：CheckConstraint 的 name 給「短名」就好，不要給完整名稱。
    # 命名慣例是 ck_%(table_name)s_%(constraint_name)s，你給的名字是那個
    # %(constraint_name)s 的「輸入」，不是最終名稱 ——
    # 寫完整名稱會變成 ck_food_revisions_ck_food_revisions_kcal_non_negative。
    # （PrimaryKeyConstraint / ForeignKeyConstraint / UniqueConstraint 的 name
    #  則是最終名稱，慣例不會再套一層。只有 CheckConstraint 是這樣。）

    # 循環外鍵：foods 先建好才有 food_revisions 可以指，所以這條要最後加，
    # 而且必須 DEFERRABLE INITIALLY DEFERRED —— 否則「建立食物 + 建立第一版
    # + 回填指標」沒辦法在同一個交易內完成。
    op.create_foreign_key(
        "fk_foods_current_revision_id_food_revisions",
        "foods",
        "food_revisions",
        ["current_revision_id"],
        ["id"],
        deferrable=True,
        initially="DEFERRED",
    )

    op.create_table(
        "food_portions",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("food_id", sa.BigInteger, nullable=False),
        sa.Column("owner_id", sa.BigInteger),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("grams", sa.Numeric(8, 2), nullable=False),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.PrimaryKeyConstraint("id", name="pk_food_portions"),
        sa.ForeignKeyConstraint(
            ["food_id"], ["foods.id"], name="fk_food_portions_food_id_foods", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_food_portions_owner_id_users", ondelete="CASCADE"
        ),
        sa.CheckConstraint("grams > 0", name="grams_positive"),
    )

    # NULLS NOT DISTINCT 讓「兩個全域的同名食物」被視為重複。
    # op.create_unique_constraint 不支援這個選項，只能用原生 SQL。
    op.execute(
        "ALTER TABLE foods ADD CONSTRAINT uq_foods_owner_id_name_brand "
        "UNIQUE NULLS NOT DISTINCT (owner_id, name, brand)"
    )
    op.execute(
        "ALTER TABLE food_portions ADD CONSTRAINT uq_food_portions_food_id_owner_id_label "
        "UNIQUE NULLS NOT DISTINCT (food_id, owner_id, label)"
    )

    op.create_index("ix_foods_owner_id", "foods", ["owner_id"])
    op.create_index(
        "ix_foods_name_trgm", "foods", ["name"], postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
    op.create_index(
        "uq_food_revisions_one_pending", "food_revisions", ["food_id"],
        unique=True, postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "ix_food_revisions_pending", "food_revisions", ["status", "created_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_table("food_portions")
    op.drop_constraint("fk_foods_current_revision_id_food_revisions", "foods")
    op.drop_table("food_revisions")
    op.drop_table("foods")
    sa.Enum(name="base_unit").drop(op.get_bind())
    sa.Enum(name="revision_status").drop(op.get_bind())
```

> **三個索引全部宣告在 model 裡 —— 這是實測之後的結論，值得記下來。**
>
> 計畫初稿寫「只放 migration、不宣告在 model，可以避免假的漂移警報」。
> **那個推理是反的**：Alembic 的 autogenerate 把「資料庫裡有、模型裡沒有」
> 直接當成**「請刪掉它」**，三個索引全被報成 `remove_index`，`alembic check`
> 永遠紅。
>
> 而避開模型宣告的理由（帶 `WHERE` 的部分索引比對不穩）**從來沒被實測過**。
> 實際測下來：
>
> | 索引 | 型態 | 比對結果 |
> |---|---|---|
> | `ix_foods_name_trgm` | GIN + `gin_trgm_ops` | **乾淨** |
> | `uq_food_revisions_one_pending` | 部分唯一（`WHERE`） | **乾淨** |
> | `ix_food_revisions_pending` | 部分（`WHERE`） | **乾淨** |
>
> `alembic check` 連跑 7 次（含一次完整 downgrade/upgrade 循環之後）全部乾淨，
> 沒有不穩定。擔心的那個 `status = 'pending'` vs
> `(status = 'pending'::revision_status)` 正規化差異，Alembic 有正確處理。
>
> **所以不需要 `include_object` hook，`migrations/env.py` 不用動。**
> 計畫 3、4 遇到同類索引時，預設就宣告在模型裡。

> **`ix_foods_name_trgm` 的 operator class 寫法：**
> `gin_trgm_ops` 這種 operator class 在 SQLAlchemy 的模型層要用
> `Index(..., postgresql_ops=...)` 表達，而 `alembic check` 對它的比對不穩定。
> 這個索引只影響搜尋效能、不影響正確性，所以刻意只放在 migration 裡。
> **如果 `alembic check` 因為它而抱怨，回報實際訊息，不要自己刪索引或改模型。**

- [ ] **Step 2: 套用並驗證可逆**

```bash
alembic upgrade head
alembic downgrade 0001
alembic upgrade head
```

`downgrade` 那一步特別重要：循環外鍵如果順序寫錯，drop 會失敗。

- [ ] **Step 3: 驗證約束真的存在且名稱正確**

```bash
docker compose exec -T db psql -U wallet -d wallet -c "
SELECT conrelid::regclass AS tbl, conname, contype
FROM pg_constraint
WHERE conrelid::regclass::text IN ('foods','food_revisions','food_portions')
ORDER BY tbl, conname;"
```

Expected: 名稱全部是 `pk_` / `uq_` / `fk_` / `ck_` 開頭，沒有 PostgreSQL 自動命名的
`foods_pkey`、`food_revisions_check` 之類。

- [ ] **Step 4: 驗證 deferrable 外鍵真的是 deferred**

```bash
docker compose exec -T db psql -U wallet -d wallet -c "
SELECT conname, condeferrable, condeferred FROM pg_constraint
WHERE conname = 'fk_foods_current_revision_id_food_revisions';"
```
Expected: `condeferrable = t`, `condeferred = t`。兩個都要是 `t`，只有第一個是 `t`
代表「可以延後但預設不延後」，那樣還是會在 INSERT 當下就檢查。

- [ ] **Step 5: 驗證單一待審的部分唯一索引真的會擋**

用原生 SQL 直接測（不經過應用程式），確認這是資料庫在擋而不是程式在擋：

```bash
docker compose exec -T db psql -U wallet -d wallet <<'SQL'
BEGIN;
INSERT INTO foods (name, created_by) VALUES ('測試食物', 3) RETURNING id \gset
INSERT INTO food_revisions (food_id, kcal, protein_g, fat_g, carb_g, created_by)
  VALUES (:id, 100, 1, 1, 1, 3);
-- 第二筆 pending 應該失敗
INSERT INTO food_revisions (food_id, kcal, protein_g, fat_g, carb_g, created_by)
  VALUES (:id, 200, 2, 2, 2, 3);
ROLLBACK;
SQL
```
Expected: 第二個 INSERT 失敗，訊息含 `uq_food_revisions_one_pending`。

- [ ] **Step 6: 漂移檢查**

Run: `alembic check`
Expected: `No new upgrade operations detected.`

若這裡紅了，**先回報實際輸出再動手** —— 多半是某個約束名稱跟
`NAMING_CONVENTION` 算出來的不一致。

- [ ] **Step 7: Commit**

```bash
git add migrations/versions/0002_create_foods.py
git commit -m "feat: 新增 foods / food_revisions / food_portions 的 migration"
```

---

### Task 4: 測試資料產生器

**Files:**
- Modify: `tests/factories.py`

- [ ] **Step 1: 新增 factory**

在 `tests/factories.py` 的 import 區補上：

```python
from decimal import Decimal

from app.models.food import BaseUnit, Food, FoodPortion, FoodRevision, RevisionStatus
```

並在檔案末端加入：

```python
_food_counter = count(1)


async def create_food(
    db_session: AsyncSession,
    *,
    created_by: User,
    name: str | None = None,
    brand: str | None = None,
    owner: User | None = None,
    kcal: Decimal | int = 100,
    protein_g: Decimal | int = 10,
    fat_g: Decimal | int = 5,
    carb_g: Decimal | int = 20,
    base_unit: BaseUnit = BaseUnit.G,
) -> Food:
    """建立食物與它的第一版營養素，並把指標指過去。

    owner=None 代表全域食物。第一版一律是 approved —— 未審核的食物
    連 current_revision_id 都沒有，等於不存在。
    """
    food = Food(
        name=name or f"測試食物{next(_food_counter)}",
        brand=brand,
        owner_id=owner.id if owner is not None else None,
        created_by=created_by.id,
    )
    db_session.add(food)
    await db_session.flush()

    revision = FoodRevision(
        food_id=food.id,
        base_unit=base_unit,
        kcal=Decimal(kcal),
        protein_g=Decimal(protein_g),
        fat_g=Decimal(fat_g),
        carb_g=Decimal(carb_g),
        status=RevisionStatus.APPROVED,
        created_by=created_by.id,
        reviewed_by=created_by.id,
        reviewed_at=datetime.now(UTC),
    )
    db_session.add(revision)
    await db_session.flush()

    food.current_revision_id = revision.id
    await db_session.commit()
    await db_session.refresh(food)
    return food


async def create_pending_revision(
    db_session: AsyncSession,
    *,
    food: Food,
    created_by: User,
    kcal: Decimal | int = 999,
    protein_g: Decimal | int = 99,
    fat_g: Decimal | int = 99,
    carb_g: Decimal | int = 99,
    change_note: str | None = "測試用的編輯提案",
) -> FoodRevision:
    revision = FoodRevision(
        food_id=food.id,
        kcal=Decimal(kcal),
        protein_g=Decimal(protein_g),
        fat_g=Decimal(fat_g),
        carb_g=Decimal(carb_g),
        status=RevisionStatus.PENDING,
        change_note=change_note,
        created_by=created_by.id,
    )
    db_session.add(revision)
    await db_session.commit()
    await db_session.refresh(revision)
    return revision


async def create_portion(
    db_session: AsyncSession,
    *,
    food: Food,
    label: str = "1 碗",
    grams: Decimal | int = 200,
    owner: User | None = None,
    is_default: bool = False,
) -> FoodPortion:
    portion = FoodPortion(
        food_id=food.id,
        owner_id=owner.id if owner is not None else None,
        label=label,
        grams=Decimal(grams),
        is_default=is_default,
    )
    db_session.add(portion)
    await db_session.commit()
    await db_session.refresh(portion)
    return portion
```

檔案開頭的 import 還要補上：

```python
from datetime import UTC, datetime
```

> **`create_food` 用 `flush()` 而不是 `commit()` 建立前兩步，是刻意的。**
> 它示範了 deferrable 外鍵的用法：先寫 `foods`（`current_revision_id` 是 NULL）、
> 再寫 `food_revisions`、最後回填指標，全部在同一個交易裡。
> 如果外鍵不是 deferred，這個順序在 `flush()` 當下就會失敗。

- [ ] **Step 2: 驗證 factory 能跑**

寫一個暫時的測試檔驗證三個 factory，跑完刪掉：

```python
from tests.factories import create_food, create_pending_revision, create_portion, create_user


async def test_factories_work(db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    assert food.current_revision_id is not None

    portion = await create_portion(db_session, food=food, owner=user)
    assert portion.grams == 200

    global_food = await create_food(db_session, created_by=user)
    assert global_food.owner_id is None

    pending = await create_pending_revision(db_session, food=global_food, created_by=user)
    assert pending.status.value == "pending"
```

Run: `pytest tests/test_tmp_factories.py -v` → `1 passed`，然後刪除該檔案。

- [ ] **Step 3: Commit**

```bash
git add tests/factories.py
git commit -m "test: 新增食物相關的測試資料產生器"
```

---

### Task 5: 建立私人食物（`POST /api/foods`）

這是循環外鍵第一次真正派上用場的地方。

**Files:**
- Create: `app/schemas/food.py`
- Create: `app/api/routes/foods.py`
- Modify: `app/main.py`
- Test: `tests/test_foods_create.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_create.py`:

```python
from sqlalchemy import select

from app.models.food import Food, FoodRevision, RevisionStatus
from app.security.tokens import create_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_create_food_returns_the_food_with_its_nutrition(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "brand": None,
            "nutrition": {
                "base_unit": "g",
                "kcal": "180.5",
                "protein_g": "6.2",
                "fat_g": "7.1",
                "carb_g": "22.4",
            },
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "滷肉飯"
    assert body["is_global"] is False
    assert body["nutrition"]["kcal"] == "180.50"
    assert body["nutrition"]["base_unit"] == "g"


async def test_create_food_persists_food_and_first_revision_and_links_them(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"},
        },
    )

    food = await db_session.scalar(select(Food).where(Food.id == response.json()["id"]))
    assert food is not None
    assert food.owner_id == user.id
    assert food.current_revision_id is not None

    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    assert revision.food_id == food.id
    assert revision.status is RevisionStatus.APPROVED


async def test_create_food_requires_authentication(client):
    response = await client.post(
        "/api/foods",
        json={"name": "滷肉飯", "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}},
    )

    assert response.status_code == 401


async def test_create_food_rejects_negative_nutrition(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "-1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 422


async def test_create_food_rejects_a_duplicate_name_for_the_same_owner(client, db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="滷肉飯")

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "FOOD_EXISTS"


async def test_two_users_can_each_have_a_food_with_the_same_name(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_food(db_session, created_by=alice, owner=alice, name="滷肉飯")

    response = await client.post(
        "/api/foods",
        headers=auth(bob),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 201
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_foods_create.py -v`
Expected: FAIL，全部 404

- [ ] **Step 3: 寫 schema**

`app/schemas/food.py`:

```python
from decimal import Decimal

from pydantic import BaseModel, ConfigDict, Field

from app.models.food import BaseUnit


class NutritionInput(BaseModel):
    base_unit: BaseUnit = BaseUnit.G
    # 每 100g / 100ml 的數值。上限取一個生理上不可能的值，
    # 純粹是防呆與請求體衛生，不是營養學上的斷言。
    kcal: Decimal = Field(ge=0, le=10000, max_digits=8, decimal_places=2)
    protein_g: Decimal = Field(ge=0, le=1000, max_digits=8, decimal_places=2)
    fat_g: Decimal = Field(ge=0, le=1000, max_digits=8, decimal_places=2)
    carb_g: Decimal = Field(ge=0, le=1000, max_digits=8, decimal_places=2)


class NutritionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    base_unit: BaseUnit
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


class FoodCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    brand: str | None = Field(default=None, max_length=100)
    nutrition: NutritionInput


class FoodResponse(BaseModel):
    id: int
    name: str
    brand: str | None
    is_global: bool
    # 沒有生效版本時為 None —— 全域食物的初版被駁回就會是這個狀態
    nutrition: NutritionResponse | None
```

- [ ] **Step 4: 寫路由**

`app/api/routes/foods.py`:

```python
from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError
from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import User
from app.schemas.food import FoodCreateRequest, FoodResponse, NutritionResponse

router = APIRouter(prefix="/foods", tags=["foods"])


def _to_response(food: Food, revision: FoodRevision | None) -> FoodResponse:
    return FoodResponse(
        id=food.id,
        name=food.name,
        brand=food.brand,
        is_global=food.owner_id is None,
        nutrition=NutritionResponse.model_validate(revision) if revision else None,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=FoodResponse)
async def create_food(
    payload: FoodCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FoodResponse:
    existing = await db.scalar(
        select(Food).where(
            Food.owner_id == user.id, Food.name == payload.name, Food.brand.is_not_distinct_from(payload.brand)
        )
    )
    if existing is not None:
        raise ConflictError("FOOD_EXISTS", "你已經建過同名的食物了")

    food = Food(
        name=payload.name,
        brand=payload.brand,
        owner_id=user.id,
        created_by=user.id,
    )
    db.add(food)
    await db.flush()

    revision = FoodRevision(
        food_id=food.id,
        base_unit=payload.nutrition.base_unit,
        kcal=payload.nutrition.kcal,
        protein_g=payload.nutrition.protein_g,
        fat_g=payload.nutrition.fat_g,
        carb_g=payload.nutrition.carb_g,
        # 私人食物的編輯直接生效
        status=RevisionStatus.APPROVED,
        created_by=user.id,
    )
    db.add(revision)
    await db.flush()

    # 回填指標。這三步在同一個交易裡，靠 deferrable 外鍵才成立 ——
    # 非 deferred 的話，寫 foods 那一刻就會因為指標還是 NULL 之後才填而卡住。
    food.current_revision_id = revision.id

    try:
        await db.commit()
    except IntegrityError as exc:
        # 併發下兩個相同名稱同時通過上面的檢查時，由唯一約束接住。
        # rollback 是必要的 —— 少了它，這個 session 之後所有操作都會拋
        # PendingRollbackError（見計畫 1 Task 7 的第四個邊界）。
        await db.rollback()
        raise ConflictError("FOOD_EXISTS", "你已經建過同名的食物了") from exc

    await db.refresh(food)
    return _to_response(food, revision)
```

> **`Food.brand.is_not_distinct_from(payload.brand)`** 而不是 `== payload.brand`：
> `brand` 可以是 NULL，而 SQL 裡 `NULL = NULL` 是 NULL 不是 true。
> 用 `IS NOT DISTINCT FROM` 才能對得上資料庫端的 `NULLS NOT DISTINCT` 唯一約束。
> 寫成 `==` 的話，「沒有品牌的滷肉飯」永遠查不到既有那筆，
> 於是走到 INSERT、撞唯一約束、靠上面那個 `IntegrityError` 兜底 —— 能動但繞遠路。

- [ ] **Step 5: 掛上路由**

`app/main.py` 的 import 改為 `from app.api.routes import auth, foods, health, me`，
並加入 `app.include_router(foods.router, prefix="/api")`。

- [ ] **Step 6: 執行測試，確認通過**

Run: `pytest tests/test_foods_create.py -v`
Expected: `6 passed`

- [ ] **Step 7: 驗證 deferrable 外鍵真的是關鍵**

暫時把 migration 的 `deferrable=True, initially="DEFERRED"` 拿掉、重建測試資料庫、
再跑一次這組測試，確認它會失敗。看到失敗後把 migration 改回來、確認測試恢復通過。
**回報那個失敗訊息** —— 那是循環外鍵為什麼需要 deferrable 的直接證據。

- [ ] **Step 8: Commit**

```bash
git add app/schemas/food.py app/api/routes/foods.py app/main.py tests/test_foods_create.py
git commit -m "feat: 新增建立私人食物的 API"
```

---

### Task 6: 讀取單一食物（`GET /api/foods/{id}`）

**Files:**
- Modify: `app/api/routes/foods.py`
- Test: `tests/test_foods_read.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_read.py`:

```python
from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_read_own_private_food(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="自助餐便當", kcal=250)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "自助餐便當"
    assert body["is_global"] is False
    assert body["nutrition"]["kcal"] == "250.00"


async def test_read_a_global_food(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, name="7-11 茶葉蛋", kcal=70)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(user))

    assert response.status_code == 200
    assert response.json()["is_global"] is True


async def test_another_users_private_food_returns_404(client, db_session):
    """不是 403 —— 403 等於承認這個 ID 存在。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(bob))

    assert response.status_code == 404


async def test_a_nonexistent_food_returns_the_same_404(client, db_session):
    bob = await create_user(db_session)
    alice = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    not_yours = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    missing = await client.get("/api/foods/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code
    assert not_yours.json() == missing.json()


async def test_pending_revisions_do_not_leak_into_the_response(client, db_session):
    """待審的編輯不能出現在正式查詢結果裡。

    這靠的是 current_revision_id 指標 —— 只有核准才會更新它，
    所以未審核的資料在結構上就查不到，不依賴任何人記得寫 WHERE status = 'approved'。
    """
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    await create_pending_revision(db_session, food=food, created_by=user, kcal=700)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(user))

    assert response.json()["nutrition"]["kcal"] == "70.00"


async def test_read_requires_authentication(client, db_session):
    admin = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.get(f"/api/foods/{food.id}")

    assert response.status_code == 401
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_foods_read.py -v`
Expected: FAIL，全部 404 或 405

- [ ] **Step 3: 寫實作**

在 `app/api/routes/foods.py` 的 import 補上 `from app.errors import ConflictError, NotFoundError`
與 `from sqlalchemy.orm import aliased`（若需要），並加入：

```python
async def _load_visible_food(
    db: AsyncSession, food_id: int, user: User
) -> tuple[Food, FoodRevision | None]:
    """取出使用者看得到的食物：全域的，或自己的。

    看不到的一律 404 —— 「不存在」與「不屬於你」必須無法區分。
    """
    row = (
        await db.execute(
            select(Food, FoodRevision)
            .outerjoin(FoodRevision, Food.current_revision_id == FoodRevision.id)
            .where(
                Food.id == food_id,
                or_(Food.owner_id.is_(None), Food.owner_id == user.id),
            )
        )
    ).first()
    if row is None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")
    food, revision = row
    return food, revision


@router.get("/{food_id}", response_model=FoodResponse)
async def read_food(
    food_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FoodResponse:
    food, revision = await _load_visible_food(db, food_id, user)
    return _to_response(food, revision)
```

import 區還要加上 `from sqlalchemy import or_, select`。

> **這裡沒有用 Task 1 的 `get_owned_or_404`，是刻意的。**
> 那個函式處理的是「只有擁有者看得到」，但食物的可見範圍是
> 「全域的 **或** 自己的」—— 條件不同。`get_owned_or_404` 會用在
> 只有擁有者能碰的資源上（例如 Task 9 編輯私人食物、之後的 meals）。
> 硬把它套進來會讓全域食物變成查不到。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_foods_read.py -v`
Expected: `6 passed`

- [ ] **Step 5: Commit**

```bash
git add app/api/routes/foods.py tests/test_foods_read.py
git commit -m "feat: 新增讀取單一食物的 API"
```

---

### Task 7: 搜尋食物（`GET /api/foods`）

**Files:**
- Modify: `app/api/routes/foods.py`, `app/schemas/food.py`
- Test: `tests/test_foods_search.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_search.py`:

```python
from app.security.tokens import create_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_search_returns_both_global_and_own_foods(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="全域滷肉飯")
    await create_food(db_session, created_by=user, owner=user, name="我的滷肉飯")

    response = await client.get("/api/foods", params={"q": "滷肉"}, headers=auth(user))

    assert response.status_code == 200
    names = {item["name"] for item in response.json()}
    assert names == {"全域滷肉飯", "我的滷肉飯"}


async def test_search_never_returns_another_users_food(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的滷肉飯")

    response = await client.get("/api/foods", params={"q": "滷肉"}, headers=auth(bob))

    assert response.json() == []


async def test_scope_global_excludes_own_foods(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="全域滷肉飯")
    await create_food(db_session, created_by=user, owner=user, name="我的滷肉飯")

    response = await client.get(
        "/api/foods", params={"q": "滷肉", "scope": "global"}, headers=auth(user)
    )

    names = {item["name"] for item in response.json()}
    assert names == {"全域滷肉飯"}


async def test_scope_mine_excludes_global_foods(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="全域滷肉飯")
    await create_food(db_session, created_by=user, owner=user, name="我的滷肉飯")

    response = await client.get(
        "/api/foods", params={"q": "滷肉", "scope": "mine"}, headers=auth(user)
    )

    names = {item["name"] for item in response.json()}
    assert names == {"我的滷肉飯"}


async def test_search_without_a_query_returns_everything_visible(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="茶葉蛋")
    await create_food(db_session, created_by=user, owner=user, name="便當")

    response = await client.get("/api/foods", headers=auth(user))

    assert len(response.json()) == 2


async def test_search_is_case_insensitive_and_partial(client, db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="Chicken Breast")

    response = await client.get("/api/foods", params={"q": "chick"}, headers=auth(user))

    assert len(response.json()) == 1


async def test_search_rejects_an_unknown_scope(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/foods", params={"scope": "everything"}, headers=auth(user))

    assert response.status_code == 422
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_foods_search.py -v`
Expected: FAIL

- [ ] **Step 3: 寫實作**

在 `app/schemas/food.py` 加入：

```python
from enum import StrEnum


class FoodScope(StrEnum):
    ALL = "all"
    GLOBAL = "global"
    MINE = "mine"
```

在 `app/api/routes/foods.py` 加入（放在 `@router.get("/{food_id}")` **之前**）：

```python
@router.get("", response_model=list[FoodResponse])
async def search_foods(
    q: str | None = None,
    scope: FoodScope = FoodScope.ALL,
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FoodResponse]:
    if scope is FoodScope.GLOBAL:
        visibility = Food.owner_id.is_(None)
    elif scope is FoodScope.MINE:
        visibility = Food.owner_id == user.id
    else:
        visibility = or_(Food.owner_id.is_(None), Food.owner_id == user.id)

    stmt = (
        select(Food, FoodRevision)
        .outerjoin(FoodRevision, Food.current_revision_id == FoodRevision.id)
        .where(visibility)
        .order_by(Food.name)
        .limit(limit)
    )
    if q:
        stmt = stmt.where(Food.name.ilike(f"%{q}%"))

    rows = (await db.execute(stmt)).all()
    return [_to_response(food, revision) for food, revision in rows]
```

import 區補上 `from fastapi import APIRouter, Depends, Query, status` 與
`from app.schemas.food import FoodScope`。

> **路由順序很重要。** `@router.get("")` 必須寫在 `@router.get("/{food_id}")`
> 之前，否則 FastAPI 會把 `/api/foods` 之後的東西當成 `food_id` 去比對。
> （實際上因為前者路徑是空字串、後者有 `/`，這裡不會衝突 ——
> 但把清單端點放前面是通則，別依賴巧合。）
>
> **搜尋用 `ILIKE` 而不是 pg_trgm 的相似度排序。** `ix_foods_name_trgm` 這個
> GIN 索引會讓 `ILIKE '%...%'` 走索引而不是全表掃描 —— 這正是 pg_trgm 的主要用途。
> 相似度排序（`ORDER BY name <-> :q`）是另一回事，等有真實資料量、
> 而且確定需要「打錯字也找得到」時再說。現在加只是把查詢複雜化。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_foods_search.py -v`
Expected: `7 passed`

- [ ] **Step 5: 確認索引真的被用到**

```bash
docker compose exec -T db psql -U wallet -d wallet -c "
EXPLAIN SELECT * FROM foods WHERE name ILIKE '%滷肉%';"
```

資料量太小時 PostgreSQL 會選 Seq Scan，那是正常的。**用
`SET enable_seqscan = off;` 再跑一次**，確認它「有能力」用 `ix_foods_name_trgm`。
如果強制關掉 seq scan 之後仍然不用那個索引，代表索引建錯了 —— 回報。

- [ ] **Step 6: Commit**

```bash
git add app/schemas/food.py app/api/routes/foods.py tests/test_foods_search.py
git commit -m "feat: 新增食物搜尋 API"
```

---

### Task 8: 版本歷史（`GET /api/foods/{id}/revisions`）

**Files:**
- Modify: `app/api/routes/foods.py`, `app/schemas/food.py`
- Test: `tests/test_foods_revisions.py`（本檔在 Task 9 會再擴充）

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_revisions.py`:

```python
from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_revision_history_lists_all_versions_newest_first(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["kcal"] == "75.00"
    assert body[0]["status"] == "pending"
    assert body[1]["status"] == "approved"
    assert body[1]["is_current"] is True
    assert body[0]["is_current"] is False


async def test_revision_history_of_another_users_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(bob))

    assert response.status_code == 404


async def test_revision_history_requires_authentication(client, db_session):
    admin = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.get(f"/api/foods/{food.id}/revisions")

    assert response.status_code == 401
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_foods_revisions.py -v`
Expected: FAIL，全部 404

- [ ] **Step 3: 寫實作**

在 `app/schemas/food.py` 加入：

```python
from datetime import datetime


class RevisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    base_unit: BaseUnit
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    status: str
    change_note: str | None
    created_by: int
    created_at: datetime
    reviewed_by: int | None
    reviewed_at: datetime | None
    reject_reason: str | None
    is_current: bool = False
```

在 `app/api/routes/foods.py` 加入：

```python
@router.get("/{food_id}/revisions", response_model=list[RevisionResponse])
async def list_revisions(
    food_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RevisionResponse]:
    food, _ = await _load_visible_food(db, food_id, user)

    revisions = (
        await db.scalars(
            select(FoodRevision)
            .where(FoodRevision.food_id == food.id)
            .order_by(FoodRevision.created_at.desc(), FoodRevision.id.desc())
        )
    ).all()

    result = []
    for revision in revisions:
        item = RevisionResponse.model_validate(revision)
        item.is_current = revision.id == food.current_revision_id
        result.append(item)
    return result
```

import 補上 `from app.schemas.food import ..., RevisionResponse`。

> **排序用 `created_at DESC, id DESC` 兩個鍵。** `created_at` 的預設值是
> `now()`，而 PostgreSQL 的 `now()` 是**交易開始時間** —— 同一個交易裡建立的
> 多筆版本會有一模一樣的時間戳。只用 `created_at` 排序的話，順序是不確定的，
> 測試會間歇性失敗。`id` 是遞增的 identity，可以當穩定的第二排序鍵。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_foods_revisions.py -v`
Expected: `3 passed`

- [ ] **Step 5: Commit**

```bash
git add app/schemas/food.py app/api/routes/foods.py tests/test_foods_revisions.py
git commit -m "feat: 新增版本歷史 API"
```

---

### Task 9: 提出編輯（`POST /api/foods/{id}/revisions`）

兩條路徑共用同一張表：私人食物直接生效，全域食物進待審。

**Files:**
- Modify: `app/api/routes/foods.py`, `app/schemas/food.py`
- Test: `tests/test_foods_revisions.py`（擴充）

- [ ] **Step 1: 寫失敗的測試**

在 `tests/test_foods_revisions.py` 末端加入：

```python
from sqlalchemy import select

from app.models.food import Food, FoodRevision, RevisionStatus


NUTRITION = {"kcal": "123", "protein_g": "4", "fat_g": "5", "carb_g": "6"}


async def test_editing_own_private_food_takes_effect_immediately(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": NUTRITION, "change_note": "修正熱量"},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "approved"

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "123.00"


async def test_editing_a_global_food_goes_to_pending(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": NUTRITION, "change_note": "標示改了"},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "pending"

    # 指標沒有動，正式查詢仍然看到舊值
    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "70.00"


async def test_a_second_pending_edit_is_rejected(client, db_session):
    """同一個食物同時只能有一筆待審 —— 由部分唯一索引在資料庫層擋掉。"""
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_pending_revision(db_session, food=food, created_by=alice)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(bob),
        json={"nutrition": NUTRITION, "change_note": "我也想改"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "REVISION_PENDING"


async def test_the_session_still_works_after_a_rejected_second_edit(client, db_session):
    """409 之後 session 必須還能用 —— 漏掉 rollback 的話後續全部會爆。"""
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_pending_revision(db_session, food=food, created_by=alice)

    await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(bob),
        json={"nutrition": NUTRITION},
    )

    read = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    assert read.status_code == 200


async def test_editing_another_users_private_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(bob),
        json={"nutrition": NUTRITION},
    )

    assert response.status_code == 404


async def test_editing_records_who_proposed_it(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": NUTRITION},
    )

    assert response.json()["created_by"] == user.id
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_foods_revisions.py -v`
Expected: 新加的 6 個失敗（405 或 404）

- [ ] **Step 3: 寫實作**

在 `app/schemas/food.py` 加入：

```python
class RevisionCreateRequest(BaseModel):
    nutrition: NutritionInput
    change_note: str | None = Field(default=None, max_length=500)
```

在 `app/api/routes/foods.py` 加入：

```python
@router.post(
    "/{food_id}/revisions", status_code=status.HTTP_201_CREATED, response_model=RevisionResponse
)
async def propose_revision(
    food_id: int,
    payload: RevisionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RevisionResponse:
    food, _ = await _load_visible_food(db, food_id, user)

    is_own_private_food = food.owner_id == user.id
    now = datetime.now(UTC)

    revision = FoodRevision(
        food_id=food.id,
        base_unit=payload.nutrition.base_unit,
        kcal=payload.nutrition.kcal,
        protein_g=payload.nutrition.protein_g,
        fat_g=payload.nutrition.fat_g,
        carb_g=payload.nutrition.carb_g,
        change_note=payload.change_note,
        created_by=user.id,
        # 自己的私人食物直接生效；全域食物要等管理員審核
        status=RevisionStatus.APPROVED if is_own_private_food else RevisionStatus.PENDING,
        reviewed_by=user.id if is_own_private_food else None,
        reviewed_at=now if is_own_private_food else None,
    )
    db.add(revision)

    try:
        await db.flush()
    except IntegrityError as exc:
        # uq_food_revisions_one_pending：同一個食物已經有待審編輯。
        # rollback 是必要的，否則這個 session 之後全部會拋 PendingRollbackError。
        await db.rollback()
        raise ConflictError(
            "REVISION_PENDING", "這個食物已經有一筆待審的編輯，請等審核完成"
        ) from exc

    if is_own_private_food:
        food.current_revision_id = revision.id

    await db.commit()
    await db.refresh(revision)

    result = RevisionResponse.model_validate(revision)
    result.is_current = revision.id == food.current_revision_id
    return result
```

import 補上 `from datetime import UTC, datetime` 與 `RevisionCreateRequest`。

> **這裡沒有用 `get_owned_or_404`。** 編輯的可見範圍跟讀取一樣是
> 「全域的或自己的」，只是**後續行為**依擁有權分岔。`_load_visible_food`
> 已經處理了「別人的私人食物 → 404」。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_foods_revisions.py -v`
Expected: `9 passed`

- [ ] **Step 5: Commit**

```bash
git add app/schemas/food.py app/api/routes/foods.py tests/test_foods_revisions.py
git commit -m "feat: 新增提出編輯的 API（私人直接生效、全域待審）"
```

---

### Task 10: 份量換算（`POST /api/foods/{id}/portions`）

**Files:**
- Modify: `app/api/routes/foods.py`, `app/schemas/food.py`
- Test: `tests/test_foods_portions.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_portions.py`:

```python
from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_anyone_can_add_a_personal_portion_to_a_global_food(client, db_session):
    """「一碗」因人而異 —— 任何人都可以在任何食物上加自己的份量。"""
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "我的碗", "grams": "230"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["is_global"] is False
    assert body["grams"] == "230.00"


async def test_listing_portions_shows_global_and_own_but_not_others(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="1 碗", grams=200)
    await create_portion(db_session, food=food, label="愛麗絲的碗", grams=180, owner=alice)
    await create_portion(db_session, food=food, label="鮑伯的碗", grams=260, owner=bob)

    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(alice))

    labels = {item["label"] for item in response.json()}
    assert labels == {"1 碗", "愛麗絲的碗"}


async def test_a_normal_user_cannot_create_a_global_portion(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "1 碗", "grams": "200", "is_global": True},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_an_admin_can_create_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(admin),
        json={"label": "1 碗", "grams": "200", "is_global": True},
    )

    assert response.status_code == 201
    assert response.json()["is_global"] is True


async def test_duplicate_label_for_the_same_owner_is_rejected(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="我的碗", owner=user)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "我的碗", "grams": "999"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PORTION_EXISTS"


async def test_two_users_can_use_the_same_label(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="1 碗", owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(bob),
        json={"label": "1 碗", "grams": "260"},
    )

    assert response.status_code == 201


async def test_adding_a_portion_to_another_users_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(bob),
        json={"label": "1 碗", "grams": "200"},
    )

    assert response.status_code == 404


async def test_grams_must_be_positive(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "空碗", "grams": "0"},
    )

    assert response.status_code == 422
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_foods_portions.py -v`
Expected: FAIL

- [ ] **Step 3: 寫實作**

在 `app/schemas/food.py` 加入：

```python
class PortionCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=50)
    grams: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    is_default: bool = False
    # 只有管理員能建立全域份量
    is_global: bool = False


class PortionResponse(BaseModel):
    id: int
    label: str
    grams: Decimal
    is_default: bool
    is_global: bool
```

在 `app/api/routes/foods.py` 加入：

```python
@router.get("/{food_id}/portions", response_model=list[PortionResponse])
async def list_portions(
    food_id: int,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PortionResponse]:
    food, _ = await _load_visible_food(db, food_id, user)

    portions = (
        await db.scalars(
            select(FoodPortion)
            .where(
                FoodPortion.food_id == food.id,
                or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user.id),
            )
            .order_by(FoodPortion.label)
        )
    ).all()
    return [
        PortionResponse(
            id=p.id, label=p.label, grams=p.grams,
            is_default=p.is_default, is_global=p.owner_id is None,
        )
        for p in portions
    ]


@router.post(
    "/{food_id}/portions", status_code=status.HTTP_201_CREATED, response_model=PortionResponse
)
async def create_portion(
    food_id: int,
    payload: PortionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PortionResponse:
    food, _ = await _load_visible_food(db, food_id, user)

    if payload.is_global and user.role is not UserRole.ADMIN:
        # 這是角色不符，不是擁有權不符 —— 所以是 403 而不是 404。
        # 資源存在、使用者也看得到，只是不能做這個動作。
        raise ForbiddenError("FORBIDDEN", "只有管理員能建立全域份量")

    portion = FoodPortion(
        food_id=food.id,
        owner_id=None if payload.is_global else user.id,
        label=payload.label,
        grams=payload.grams,
        is_default=payload.is_default,
    )
    db.add(portion)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError("PORTION_EXISTS", "你已經為這個食物建過同名的份量了") from exc

    await db.refresh(portion)
    return PortionResponse(
        id=portion.id, label=portion.label, grams=portion.grams,
        is_default=portion.is_default, is_global=portion.owner_id is None,
    )
```

import 補上 `FoodPortion`、`UserRole`、`ForbiddenError`、`PortionCreateRequest`、`PortionResponse`。

> **這裡的 403 跟 Task 6 的 404 是不同性質，不要混。**
>
> - 「別人的私人食物」→ **404**：連存在都不該讓對方知道。
> - 「不是管理員，不能建全域份量」→ **403**：資源存在、你也看得到，
>   只是這個**動作**你不能做。403 在這裡沒有洩漏任何東西。
>
> 判準是：**403 會不會透露出「有一個你原本不知道的東西存在」？**
> 會就用 404，不會就用 403。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_foods_portions.py -v`
Expected: `8 passed`

- [ ] **Step 5: Commit**

```bash
git add app/schemas/food.py app/api/routes/foods.py tests/test_foods_portions.py
git commit -m "feat: 新增份量換算 API（全域 + 私人分層）"
```

> **這裡是一個自然的檢查點。** 到此為止，私人食物已經完整可用：建立、讀取、
> 搜尋、編輯、份量。剩下的 Task 11–14 是全域食物的審核流程。

---

### Task 11: 待審佇列（`GET /api/admin/food-revisions`）

**Files:**
- Create: `app/api/routes/admin_foods.py`
- Modify: `app/main.py`, `app/schemas/food.py`
- Test: `tests/test_admin_review.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_admin_review.py`:

```python
from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_admin_sees_the_pending_queue(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, name="7-11 茶葉蛋", kcal=70)
    revision = await create_pending_revision(
        db_session, food=food, created_by=user, kcal=75, change_note="標示改了"
    )

    response = await client.get("/api/admin/food-revisions", headers=auth(admin))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["id"] == revision.id
    assert body[0]["food_name"] == "7-11 茶葉蛋"
    assert body[0]["change_note"] == "標示改了"
    assert body[0]["kcal"] == "75.00"
    # 審核者需要看到「現在是多少」才能判斷這個提案合不合理
    assert body[0]["current_kcal"] == "70.00"


async def test_a_normal_user_cannot_see_the_queue(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/admin/food-revisions", headers=auth(user))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_the_queue_requires_authentication(client):
    response = await client.get("/api/admin/food-revisions")

    assert response.status_code == 401


async def test_the_queue_only_contains_pending_revisions(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    # create_food 產生的第一版是 approved，不該出現在佇列裡
    food = await create_food(db_session, created_by=admin)
    await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.get("/api/admin/food-revisions", headers=auth(admin))

    assert len(response.json()) == 1
    assert response.json()[0]["status"] == "pending"
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_admin_review.py -v`
Expected: FAIL，全部 404

- [ ] **Step 3: 寫實作**

在 `app/schemas/food.py` 加入：

```python
class PendingRevisionResponse(BaseModel):
    id: int
    food_id: int
    food_name: str
    food_brand: str | None
    base_unit: BaseUnit
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    status: str
    change_note: str | None
    created_by: int
    created_at: datetime
    # 目前生效的數值，供審核者比對
    current_kcal: Decimal | None
    current_protein_g: Decimal | None
    current_fat_g: Decimal | None
    current_carb_g: Decimal | None
```

`app/api/routes/admin_foods.py`:

```python
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.orm import aliased
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.db import get_db
from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import User
from app.schemas.food import PendingRevisionResponse

router = APIRouter(prefix="/admin/food-revisions", tags=["admin"])


@router.get("", response_model=list[PendingRevisionResponse])
async def list_pending_revisions(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[PendingRevisionResponse]:
    current = aliased(FoodRevision)

    rows = (
        await db.execute(
            select(FoodRevision, Food, current)
            .join(Food, FoodRevision.food_id == Food.id)
            .outerjoin(current, Food.current_revision_id == current.id)
            .where(FoodRevision.status == RevisionStatus.PENDING)
            .order_by(FoodRevision.created_at, FoodRevision.id)
        )
    ).all()

    return [
        PendingRevisionResponse(
            id=revision.id,
            food_id=food.id,
            food_name=food.name,
            food_brand=food.brand,
            base_unit=revision.base_unit,
            kcal=revision.kcal,
            protein_g=revision.protein_g,
            fat_g=revision.fat_g,
            carb_g=revision.carb_g,
            status=revision.status.value,
            change_note=revision.change_note,
            created_by=revision.created_by,
            created_at=revision.created_at,
            current_kcal=cur.kcal if cur else None,
            current_protein_g=cur.protein_g if cur else None,
            current_fat_g=cur.fat_g if cur else None,
            current_carb_g=cur.carb_g if cur else None,
        )
        for revision, food, cur in rows
    ]
```

> **`aliased(FoodRevision)` 是必要的。** 這個查詢要同時取「待審的那一版」跟
> 「目前生效的那一版」，兩者都來自 `food_revisions`。不做別名的話，SQLAlchemy
> 無法區分兩次 join 指的是哪一個，產生的 SQL 會是錯的。
>
> **佇列按 `created_at, id` 正序（最舊的在前）**，跟版本歷史相反 ——
> 待審清單要先處理最久沒人理的那一筆。

- [ ] **Step 4: 掛上路由**

`app/main.py` 的 import 改為 `from app.api.routes import admin_foods, auth, foods, health, me`，
並加入 `app.include_router(admin_foods.router, prefix="/api")`。

- [ ] **Step 5: 執行測試，確認通過**

Run: `pytest tests/test_admin_review.py -v`
Expected: `4 passed`

- [ ] **Step 6: Commit**

```bash
git add app/schemas/food.py app/api/routes/admin_foods.py app/main.py tests/test_admin_review.py
git commit -m "feat: 新增管理員待審佇列 API"
```

---

### Task 12: 核准（`POST /api/admin/food-revisions/{id}/approve`）

**Files:**
- Modify: `app/api/routes/admin_foods.py`
- Test: `tests/test_admin_review.py`（擴充）

- [ ] **Step 1: 寫失敗的測試**

在 `tests/test_admin_review.py` 末端加入：

```python
from app.models.food import Food, FoodRevision, RevisionStatus


async def test_approving_moves_the_pointer_and_changes_what_users_see(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    revision = await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin)
    )

    assert response.status_code == 200
    assert response.json()["status"] == "approved"
    assert response.json()["reviewed_by"] == admin.id

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "75.00"


async def test_approving_does_not_change_history(client, db_session):
    """核准新版本之後，舊版本仍然在歷史裡，而且數值沒有被改動。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    revision = await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    await client.post(f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin))

    history = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))
    values = {item["kcal"] for item in history.json()}
    assert values == {"70.00", "75.00"}


async def test_a_normal_user_cannot_approve(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(user)
    )

    assert response.status_code == 403


async def test_approving_an_already_reviewed_revision_returns_409(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin))
    again = await client.post(
        f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin)
    )

    assert again.status_code == 409
    assert again.json()["error"]["code"] == "REVISION_NOT_PENDING"


async def test_approving_a_nonexistent_revision_returns_404(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await client.post(
        "/api/admin/food-revisions/999999/approve", headers=auth(admin)
    )

    assert response.status_code == 404


async def test_approving_frees_the_slot_for_a_new_pending_edit(client, db_session):
    """核准之後，同一個食物才能再接受新的待審編輯。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(f"/api/admin/food-revisions/{revision.id}/approve", headers=auth(admin))

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}},
    )

    assert response.status_code == 201
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_admin_review.py -v`
Expected: 新加的 6 個失敗

- [ ] **Step 3: 寫實作**

在 `app/api/routes/admin_foods.py` 加入：

```python
async def _load_pending(db: AsyncSession, revision_id: int) -> tuple[FoodRevision, Food]:
    row = (
        await db.execute(
            select(FoodRevision, Food)
            .join(Food, FoodRevision.food_id == Food.id)
            .where(FoodRevision.id == revision_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("REVISION_NOT_FOUND", "找不到該編輯提案")

    revision, food = row
    if revision.status is not RevisionStatus.PENDING:
        raise ConflictError("REVISION_NOT_PENDING", "這筆提案已經審核過了")
    return revision, food


@router.post("/{revision_id}/approve", response_model=RevisionResponse)
async def approve_revision(
    revision_id: int,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> RevisionResponse:
    revision, food = await _load_pending(db, revision_id)

    revision.status = RevisionStatus.APPROVED
    revision.reviewed_by = admin.id
    revision.reviewed_at = datetime.now(UTC)
    # 指標只在這裡動。這一行就是「未審核資料查不到」這個保證的全部。
    food.current_revision_id = revision.id

    await db.commit()
    await db.refresh(revision)

    result = RevisionResponse.model_validate(revision)
    result.is_current = True
    return result
```

import 補上 `from datetime import UTC, datetime`、`ConflictError`、`NotFoundError`、`RevisionResponse`。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_admin_review.py -v`
Expected: `10 passed`

- [ ] **Step 5: Commit**

```bash
git add app/api/routes/admin_foods.py tests/test_admin_review.py
git commit -m "feat: 新增核准編輯提案的 API"
```

---

### Task 13: 駁回（`POST /api/admin/food-revisions/{id}/reject`）

**Files:**
- Modify: `app/api/routes/admin_foods.py`, `app/schemas/food.py`
- Test: `tests/test_admin_review.py`（擴充）

- [ ] **Step 1: 寫失敗的測試**

在 `tests/test_admin_review.py` 末端加入：

```python
async def test_rejecting_records_the_reason_and_leaves_the_pointer_alone(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    revision = await create_pending_revision(db_session, food=food, created_by=user, kcal=700)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": "熱量對不上三大營養素"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "rejected"
    assert body["reject_reason"] == "熱量對不上三大營養素"
    assert body["is_current"] is False

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "70.00"


async def test_rejecting_requires_a_reason(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": ""},
    )

    assert response.status_code == 422


async def test_a_normal_user_cannot_reject(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    response = await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(user),
        json={"reason": "不行"},
    )

    assert response.status_code == 403


async def test_rejecting_frees_the_slot_for_a_new_pending_edit(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": "數值不對"},
    )

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}},
    )

    assert response.status_code == 201


async def test_the_rejected_revision_stays_in_the_history(client, db_session):
    """駁回不是刪除 —— 誰提了什麼、為什麼被拒，都要留著。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    revision = await create_pending_revision(db_session, food=food, created_by=user)

    await client.post(
        f"/api/admin/food-revisions/{revision.id}/reject",
        headers=auth(admin),
        json={"reason": "數值不對"},
    )

    history = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))
    rejected = [r for r in history.json() if r["id"] == revision.id]
    assert len(rejected) == 1
    assert rejected[0]["reject_reason"] == "數值不對"
```

- [ ] **Step 2: 執行測試，確認失敗**

Run: `pytest tests/test_admin_review.py -v`
Expected: 新加的 5 個失敗

- [ ] **Step 3: 寫實作**

在 `app/schemas/food.py` 加入：

```python
class RevisionRejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)
```

在 `app/api/routes/admin_foods.py` 加入：

```python
@router.post("/{revision_id}/reject", response_model=RevisionResponse)
async def reject_revision(
    revision_id: int,
    payload: RevisionRejectRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> RevisionResponse:
    revision, food = await _load_pending(db, revision_id)

    revision.status = RevisionStatus.REJECTED
    revision.reviewed_by = admin.id
    revision.reviewed_at = datetime.now(UTC)
    revision.reject_reason = payload.reason
    # 指標不動 —— 駁回的提案從來沒有生效過

    await db.commit()
    await db.refresh(revision)

    result = RevisionResponse.model_validate(revision)
    result.is_current = revision.id == food.current_revision_id
    return result
```

> **駁回不刪資料。** `ck_food_revisions_rejected_needs_reason` 這個約束
> 強制了「狀態是 rejected 就必須有理由」—— 提案者要看得到自己為什麼被拒，
> 而且這是稽核軌跡的一部分。

- [ ] **Step 4: 執行測試，確認通過**

Run: `pytest tests/test_admin_review.py -v`
Expected: `15 passed`

- [ ] **Step 5: Commit**

```bash
git add app/schemas/food.py app/api/routes/admin_foods.py tests/test_admin_review.py
git commit -m "feat: 新增駁回編輯提案的 API"
```

---

### Task 14: 跨使用者隔離總掃描

規格第 10.3 節把這一類列為最有價值的測試。前面每個 task 各自測了自己那條路徑，
這個 task 把它們集中成一份清單 —— **每一個會碰到使用者資料的端點都要有一筆。**

**Files:**
- Test: `tests/test_cross_user_isolation.py`

- [ ] **Step 1: 寫測試**

`tests/test_cross_user_isolation.py`:

```python
import pytest

from app.security.tokens import create_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


NUTRITION = {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}


@pytest.fixture
async def alices_food(db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的便當")
    return alice, bob, food


async def test_bob_cannot_read_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_list_alices_revisions(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_edit_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.post(
        f"/api/foods/{food.id}/revisions", headers=auth(bob), json={"nutrition": NUTRITION}
    )
    assert response.status_code == 404


async def test_bob_cannot_list_alices_portions(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_add_a_portion_to_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.post(
        f"/api/foods/{food.id}/portions", headers=auth(bob), json={"label": "1 碗", "grams": "200"}
    )
    assert response.status_code == 404


async def test_bob_cannot_find_alices_food_by_search(client, alices_food):
    _, bob, food = alices_food
    response = await client.get("/api/foods", params={"q": "愛麗絲"}, headers=auth(bob))
    assert response.json() == []


async def test_bob_cannot_see_alices_portion_on_a_global_food(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="愛麗絲的碗", owner=alice)

    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(bob))

    assert response.json() == []


async def test_every_isolation_failure_looks_identical(client, alices_food):
    """所有「不是你的」都必須跟「不存在」長得一模一樣。"""
    _, bob, food = alices_food

    not_yours = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    missing = await client.get("/api/foods/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code
    assert not_yours.json() == missing.json()
```

- [ ] **Step 2: 執行測試**

Run: `pytest tests/test_cross_user_isolation.py -v`
Expected: `8 passed`（這些路徑前面都已實作，所以應該直接通過）

**若有任何一個失敗，那是真的洩漏，不是測試寫錯 —— 停下來回報。**

- [ ] **Step 3: 用突變測試證明這些斷言不是空轉的**

這組測試一開始就是綠的，沒有紅轉綠可以佐證。所以要主動破壞再確認：

把 `app/api/routes/foods.py` 的 `_load_visible_food` 裡的可見性條件
`or_(Food.owner_id.is_(None), Food.owner_id == user.id)` 暫時改成
`Food.id == food_id`（等於拿掉擁有權檢查），跑這組測試，確認**多個**測試失敗。
然後改回來，確認全部恢復通過。

**回報哪幾個測試抓到了這個突變。** 有任何一個沒抓到，代表那條路徑沒有真正被覆蓋。

- [ ] **Step 4: Commit**

```bash
git add tests/test_cross_user_isolation.py
git commit -m "test: 新增跨使用者隔離的總掃描"
```

---

## 完成驗收

每一項都要親自跑過並看到預期結果：

- [ ] `alembic downgrade 0001` 後再 `alembic upgrade head`，兩次都成功
- [ ] `alembic check` → `No new upgrade operations detected.`
- [ ] `pytest -v -W error` 全部通過，且測試數 ≥ 110
- [ ] `ruff check .` 無錯誤
- [ ] `mypy app` 無錯誤
- [ ] `pytest --cov=app --cov-fail-under=80` 通過
- [ ] `docker compose up -d` 後 `/docs` 打得開，列出所有新端點
- [ ] `pg_constraint` 裡 `foods` / `food_revisions` / `food_portions` 的約束名稱
      全部是 `pk_` / `uq_` / `fk_` / `ck_` 開頭，沒有 PostgreSQL 自動命名的
- [ ] Task 14 的突變測試確實讓多個隔離測試失敗

## 超出規格的一個新增

規格第 7.2 節只列了 `POST /api/foods/{id}/portions`，沒有列讀取端點。
本計畫加了 **`GET /api/foods/{id}/portions`**，理由：

1. 沒有它就無法驗證份量分層真的有效（全域看得到、自己的看得到、別人的看不到）——
   那是這次新增 `owner_id` 的全部意義。
2. 計畫 3 記錄餐點時必須先讓使用者選份量，一定會需要它。

## 這份計畫刻意不做的事

- **`GET /api/foods/frequent` 與 `/recent`** —— 需要 `meal_items`，計畫 3 實作
- **全域食物的建立端點** —— 全域食物目前只能由種子資料或管理員直接寫入；
  規格的 `POST /api/foods` 明確只建私人食物。AI 產生全域食物是 P2 階段的事
- **份量的編輯與刪除** —— 只有新增。份量沒有版本化，改動會影響歷史紀錄的顯示，
  但不影響已存的 `quantity_g`（計畫 3 會處理那個快照）
- **搜尋的相似度排序** —— `ILIKE` 配 GIN 索引已經夠用，
  等有真實資料量再考慮 `ORDER BY name <-> :q`
- **審核通知** —— 提案者不會收到「你的提案被駁回了」的通知，只能自己去看歷史

## 下一步

計畫 3（餐點紀錄 + 照片）。屆時要處理的核心問題：

- `meal_items` 存 `food_revision_id` 而非 `food_id` —— 歷史數值不會因為食物被編輯而變
- `quantity_g` 的快照：份量換算沒有版本化，所以記錄當下就要把克數固定住
- 照片上傳、壓縮、以及**經過 API 驗證擁有權後才回傳**（不能用靜態檔案服務）
- `GET /api/foods/frequent` 與 `/recent` 在這裡才有資料可查

---
