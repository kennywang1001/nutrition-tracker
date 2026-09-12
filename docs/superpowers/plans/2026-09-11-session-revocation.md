# Session 撤銷 實作計畫

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 讓 refresh token 換發時舊票當場失效、被重複使用時判定外洩並撤銷整條鏈，並提供單裝置與全裝置登出，使前端能做出一個誠實的登出按鈕。

**Architecture:** 新增 `refresh_sessions` 表，每張 refresh token 在 payload 帶一個 `jti` 對應表中一列，同一次登入衍生的所有票共用一個 `family_id`。換發是一個條件式 `UPDATE ... WHERE used_at IS NULL RETURNING`，搶不到列就進入重用判斷。access token 完全不碰資料庫（刻意的 15 分鐘缺口，規格 §4）。

**Tech Stack:** SQLAlchemy 2.0 async · Alembic · PyJWT · FastAPI · pytest

**規格：** [docs/superpowers/specs/2026-09-11-session-revocation-design.md](../specs/2026-09-11-session-revocation-design.md)

---

## 開始之前

所有指令都在 repo 根目錄執行。測試跑在 host 的 venv，不在容器內：

```bash
docker compose up -d                        # 需要 db 起著（測試連 localhost:5433）
.venv/Scripts/python.exe -m pytest -W error
.venv/Scripts/ruff.exe check .
.venv/Scripts/python.exe -m mypy app
```

現況基準：**463 個測試全綠**。每個 task 結束時這個數字只能往上。

各 step 寫的「Expected: N passed」是照這份計畫裡的測試數推算的。實際跑起來
對不上時，先確認是不是自己多寫或少寫了測試 —— **真正的驗收條件是「沒有任何
原本會過的測試變紅」**，不是那個絕對數字。

---

## 這份計畫最重要的一個陷阱：測試看不見 `commit`

`tests/conftest.py` 的 `db_session` 用 `join_transaction_mode="create_savepoint"`，
外層交易在測試結束時整個 rollback。於是 **`commit()` 只是 RELEASE SAVEPOINT** ——
對同一個 session 來說，「已 flush 但沒 commit」與「已 commit」**在結構上不可觀察**。
而 `client` fixture 把同一個 session 交給 app，所以端點測試也看不見。

實測（Task 3 品質審查）：把 `start_session` 的 `await db.commit()` **整行刪掉**，
476 個測試**全綠**。但 production 的 `get_db` 是 per-request，`session.close()`
會把沒 commit 的 INSERT 丟掉 —— 登入發出一張沒有對應資料列的票，
Task 4 之後就是 100% 的換發失敗。

**要讓「有沒有 commit」變成可觀察，測試必須在斷言前自己 `await db_session.rollback()`。**
沒 commit 的資料還在 savepoint 裡，rollback 會把它抹掉；commit 過的不會。

這份計畫裡每一條宣稱「釘住了持久化」的測試都必須有那一行 rollback，
否則它證明的只是「資料在記憶體裡」。目前有兩條：
`test_start_session_commits_the_row`（Task 3）與
`test_reuse_detection_persists_the_revocation`（Task 4）。

### 用了 rollback 就不能再讀 ORM 屬性

`rollback()` 會讓 session 裡**所有** ORM 物件過期（`expire_on_commit=False`
不管這件事）。過期之後第一次讀屬性會觸發一次同步的 refresh 查詢，
在 async 環境下直接炸 `MissingGreenlet`。

所以 rollback 之後**不可以**再寫 `user.id`、`row.revoked_at` 這種東西。
兩個做法：

- 在 rollback **之前**把需要的值取進本地變數（`user_id = user.id`）
- 查詢時直接選欄位而不是實體（`select(RefreshSession.revoked_at)`
  而不是 `select(RefreshSession)`）

**為什麼這件事值得寫下來：** 忘記做的話，測試在突變下**仍然會變紅** ——
但是以「崩潰」而不是「斷言失敗」的方式。崩潰是偶然的守衛：它來自連線狀態，
不是來自你要驗證的性質，換個 SQLAlchemy 版本或稍微重寫測試就可能消失，
而缺陷還在。Task 4 實測踩到過，見突變表第 3 列。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `app/models/session.py`（新增） | `RefreshSession` 模型。只有欄位與索引，沒有邏輯 |
| `app/models/__init__.py`（修改） | 註冊新模型 —— **漏掉這步整個測試套件會在收集階段失敗** |
| `migrations/versions/0007_create_refresh_sessions.py`（新增） | 建表 |
| `app/security/tokens.py`（改寫） | JWT 的編解碼。拆成 access / refresh 兩組，refresh 強制帶 `jti` |
| `app/security/sessions.py`（新增） | 簽發、輪替、撤銷的**全部**邏輯。路由只負責翻譯錯誤 |
| `app/api/routes/auth.py`（修改） | login / refresh 改走 sessions；新增 logout / logout-all |
| `app/api/deps.py`（修改） | 改用 `decode_access_token` |
| `app/schemas/auth.py`（修改） | 新增 `LogoutRequest` |
| `app/cli.py`（修改） | `cleanup-sessions` 指令 |
| `tests/test_sessions.py`（新增） | 資料列、輪替、重用偵測 |
| `tests/test_auth_logout.py`（新增） | 兩個登出端點 + 規格 §4 的 15 分鐘缺口 |

**為什麼 `sessions.py` 跟 `tokens.py` 分開：** `tokens.py` 是純函式，不碰資料庫、可以單獨測；`sessions.py` 全部是資料庫操作。混在一起的話 `tokens.py` 現有那十幾個不需要資料庫的測試會全部被迫接上 fixture。

---

### Task 1：`refresh_sessions` 模型與 migration

**Files:**
- Create: `app/models/session.py`
- Modify: `app/models/__init__.py`
- Create: `migrations/versions/0007_create_refresh_sessions.py`
- Test: `tests/test_sessions.py`

- [ ] **Step 1: 寫失敗的測試**

Create `tests/test_sessions.py`:

```python
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.session import RefreshSession
from tests.factories import create_user


def _session_row(user_id: int, *, jti=None, family_id=None) -> RefreshSession:
    now = datetime.now(UTC)
    return RefreshSession(
        user_id=user_id,
        jti=jti or uuid4(),
        family_id=family_id or uuid4(),
        issued_at=now,
        expires_at=now + timedelta(days=14),
    )


async def test_a_session_row_can_be_stored_and_read_back(db_session):
    user = await create_user(db_session)
    row = _session_row(user.id)

    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.id is not None
    assert row.used_at is None
    assert row.revoked_at is None
    # DateTime(timezone=True) 必須回 aware 的 datetime —— Task 6 的比較
    # （Python 時鐘 vs 這個欄位）建立在這上面，naive 的話會直接 TypeError。
    assert row.issued_at.tzinfo is not None
    assert row.expires_at.tzinfo is not None


async def test_jti_is_unique(db_session):
    """jti 是查詢的鍵。重複的 jti 代表兩條不同的鏈共用一個識別，撤銷其中一條
    會誤傷另一條 —— 這要由資料庫擋，不是靠「uuid4 不會碰撞」這個假設。
    """
    user = await create_user(db_session)
    jti = uuid4()
    db_session.add(_session_row(user.id, jti=jti))
    await db_session.commit()

    db_session.add(_session_row(user.id, jti=jti))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    # conftest 開頭列的已知邊界 4：接住 commit 丟出的例外之後一定要 rollback，
    # 否則同一個測試後續所有資料庫操作都會炸 PendingRollbackError，
    # 而且錯誤訊息看起來跟真正的原因完全無關。
    await db_session.rollback()


async def test_sessions_are_deleted_when_the_user_is_deleted(db_session):
    """ON DELETE CASCADE —— 不留孤兒列。"""
    user = await create_user(db_session)
    db_session.add(_session_row(user.id))
    await db_session.commit()

    await db_session.delete(user)
    await db_session.commit()

    remaining = (await db_session.scalars(select(RefreshSession))).all()
    assert remaining == []


async def test_a_family_cannot_have_two_live_tokens(db_session):
    """鏈分岔就是這張表要防的 bug（規格 §3.1）。Task 4 的條件式 UPDATE 保證了它，
    但那是程式碼；這條測試證明資料庫也擋。

    **沒有這條測試，把部分唯一索引從 model 與 migration 同時刪掉，
    `alembic check` 乾淨、整套測試全綠、不變量安靜消失。**
    alembic check 抓的是「模型與 migration 不一致」，兩邊一起刪它看不見。
    """
    user = await create_user(db_session)
    family_id = uuid4()
    db_session.add(_session_row(user.id, family_id=family_id))
    await db_session.commit()

    db_session.add(_session_row(user.id, family_id=family_id))
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "one_live_per_family" in str(exc.value)
    await db_session.rollback()


async def test_used_and_revoked_rows_free_the_family_slot(db_session):
    """索引只約束**活**票 —— 否則輪替會在第二次換發就炸。

    這條跟上面那條是一對：上面證明它會擋，這條證明它擋對了東西。
    只有上面那條的話，把述詞寫成「family_id 唯一」也是綠的。
    """
    user = await create_user(db_session)
    family_id = uuid4()
    spent = _session_row(user.id, family_id=family_id)
    spent.used_at = datetime.now(UTC)
    db_session.add(spent)
    await db_session.commit()

    db_session.add(_session_row(user.id, family_id=family_id))
    await db_session.commit()  # 不該炸


async def test_expires_at_must_be_after_issued_at(db_session):
    """Task 4 刻意不檢查 expires_at，所以壞掉的值在程式碼裡不會報錯 ——
    使用者只會莫名被登出。由 CHECK 擋住。

    用 expires_at == issued_at 這個邊界值，不是明顯更小的值：
    `>=` 與 `>` 的差別只有這個輸入分得出來。
    """
    user = await create_user(db_session)
    row = _session_row(user.id)
    row.expires_at = row.issued_at
    db_session.add(row)
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "expires_after_issued" in str(exc.value)
    await db_session.rollback()
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.session'`

- [ ] **Step 3: 寫模型**

Create `app/models/session.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RefreshSession(Base):
    """一張 refresh token 對應一列。

    `family_id` 是一次登入衍生出的整條鏈：登入開一個新 family，之後每次輪替
    都在同一個 family 裡長出下一列。撤銷的單位是 family 而不是單一列 ——
    攻擊者手上那張票換出來的後續票也必須一起死。

    `used_at` 與 `revoked_at` 刻意分開，不合併成一個 status 欄位：
    「已經被拿去換過」是正常流程的終點，「被撤銷」是安全事件或使用者登出。
    合併之後就再也分不出「這條鏈正常輪替到底」與「這條鏈被判定外洩」。

    這裡只存 `jti`，不存 token 字串本身 —— token 進資料庫等於把一份可直接
    使用的憑證留在備份裡，而 jti 已經足夠做撤銷判斷。
    """

    __tablename__ = "refresh_sessions"
    __table_args__ = (
        # **核心不變量：一個 family 最多只有一張活票。**
        # 鏈分岔就是這張表要防的那個 bug。Task 4 的條件式 UPDATE 保證了它，
        # 但那是程式碼 —— WHERE 被改弱、或有人沒先作廢前一張就簽發，
        # 鏈會**安靜地**分岔。這個部分唯一索引讓資料庫也保證一次，
        # 真的發生時是一個大聲的 IntegrityError，不是兩張沒人發現的活票。
        Index(
            "uq_refresh_sessions_one_live_per_family",
            "family_id",
            unique=True,
            postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"),
        ),
        # 撤銷整個 family 時走這個索引。
        Index("ix_refresh_sessions_family_id", "family_id"),
        # logout-all：撈某個使用者所有還沒撤銷的列。user_id 當前導欄位同時也
        # 服務 ON DELETE CASCADE —— PostgreSQL 不會自動幫外鍵來源欄位建索引。
        Index("ix_refresh_sessions_user_id_revoked_at", "user_id", "revoked_at"),
        # Task 4 刻意不在換發時檢查 expires_at（理由見 app/security/sessions.py
        # 的 rotate_session），所以一個亂掉的 expires_at 不會在任何地方報錯 ——
        # 使用者只會莫名其妙被登出。由資料庫擋住它。
        # 注意：CheckConstraint 的 name= 是命名慣例的**輸入**不是最終名稱，
        # 最終會是 ck_refresh_sessions_expires_after_issued（陷阱表第 1 條）。
        CheckConstraint("expires_at > issued_at", name="expires_after_issued"),
    )
    # expires_at 刻意**不**建索引：唯一的消費者是每天跑一次的 cleanup-sessions，
    # 而那是會掃掉表中數 % 列的 bulk DELETE，規劃器本來就會選 seq scan。
    # 這張表是整個 app 寫入率最高的（每台活躍裝置每天約 100 列），
    # 不為一個量不到的節省在最熱的寫入路徑上多維護一棵 btree。等量到再加。

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # unique=True 會依 NAMING_CONVENTION 產生 uq_refresh_sessions_jti ——
    # 手寫的 migration 必須用一模一樣的名字，否則 alembic check 紅。
    jti: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, nullable=False)
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 只給 cleanup-sessions 用。**過期判斷本身由 JWT 的 exp 負責**，這個欄位
    # 刻意不參與換發時的條件判斷 —— 理由寫在 app/security/sessions.py 的
    # rotate_session 裡：兩個地方都擋的話，突變掉任一個都不會有測試變紅。
    #
    # 這四個時間戳（issued_at / expires_at / used_at / revoked_at）都由
    # **應用程式的時鐘**寫入，不像這個 schema 其他表用 server_default=func.now()。
    # 這是刻意的：issued_at 與 expires_at 必須來自同一個 now，TTL 才精確。
    # 因此拿它們做比較時也一律用 datetime.now(UTC)，不要用 SQL 的 now() ——
    # 混用的話，容器時鐘與 PostgreSQL 時鐘一旦漂移，session 會提早或延後
    # 過期，而且沒有任何東西指得出原因。
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
```

- [ ] **Step 4: 註冊模型**

Modify `app/models/__init__.py` — 加一行 import，並在 `__all__` 裡依字母序插入（在 `"MealType"` 與 `"RevisionStatus"` 之間）：

```python
from app.models.session import RefreshSession
```

```python
    "RefreshSession",
```

> **注意 dev 資料庫沒有被 migrate。** conftest 只對 `wallet_test` 跑
> `alembic upgrade head`；跑在容器裡的 api 用的是 `wallet`，那邊還沒有這張表。
> 要手動打 API 驗證之前，先跑一次：
> ```bash
> docker compose exec -T api alembic upgrade head
> ```

> **這一步不能漏。** `migrations/env.py` 的 `target_metadata` 是 `app.models.Base.metadata`，而 model 只有被 import 過才會註冊進 metadata。漏掉的話：表在資料庫裡、metadata 裡沒有 → `alembic check` 會認為這張表是多餘的，而 conftest 的 `migrated_database` fixture 每個 session 都會跑一次 `alembic check`，**整個測試套件會在收集階段就失敗**，錯誤訊息是一個看不出關聯的 `CalledProcessError`。

- [ ] **Step 5: 寫 migration**

Create `migrations/versions/0007_create_refresh_sessions.py`:

```python
"""create refresh_sessions

Revision ID: 0007
Revises: 0006
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "refresh_sessions",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("jti", UUID(as_uuid=True), nullable=False),
        sa.Column("family_id", UUID(as_uuid=True), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("id", name="pk_refresh_sessions"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_refresh_sessions_user_id_users",
            ondelete="CASCADE",
        ),
        # 名稱必須跟 NAMING_CONVENTION 的 uq 樣板算出來的一致
        # （uq_%(table_name)s_%(column_0_N_name)s）。差一個字 alembic check 就紅，
        # 而那個紅燈的訊息不會告訴你「只是名字不一樣」。
        sa.UniqueConstraint("jti", name="uq_refresh_sessions_jti"),
        # **name= 這裡要寫原始名字，不是完整名字**（實作時踩到，已驗證）。
        # alembic 的 op.create_table 內部建的暫時 MetaData 會從
        # migrations/env.py 的 target_metadata 繼承 NAMING_CONVENTION，
        # 而 ck 樣板是 "ck_%(table_name)s_%(constraint_name)s" —— 含
        # %(constraint_name)s token。給它一個已經完整的名字會再套一次樣板：
        #   name="ck_refresh_sessions_expires_after_issued"
        #     -> ck_refresh_sessions_ck_refresh_sessions_expires_after_issued
        # 跟模型算出來的對不上，alembic check 永久報漂移。
        # uq / fk / pk 三個樣板不含這個 token，所以它們寫完整名字沒事 ——
        # **只有 CheckConstraint 是這樣**（handover §7 第 1 條）。
        sa.CheckConstraint("expires_at > issued_at", name="expires_after_issued"),
    )
    # 核心不變量：一個 family 最多一張活票（規格 §3.1）。
    # postgresql_where 的述詞必須跟模型裡拼得一模一樣，否則 alembic check 報漂移。
    op.create_index(
        "uq_refresh_sessions_one_live_per_family",
        "refresh_sessions",
        ["family_id"],
        unique=True,
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )
    op.create_index("ix_refresh_sessions_family_id", "refresh_sessions", ["family_id"])
    op.create_index(
        "ix_refresh_sessions_user_id_revoked_at",
        "refresh_sessions",
        ["user_id", "revoked_at"],
    )


def downgrade() -> None:
    op.drop_table("refresh_sessions")
```

- [ ] **Step 6: 跑測試確認通過，漂移檢查同時也通過**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: 6 passed

conftest 的 `migrated_database` fixture 會先砍掉重建測試資料庫、跑 `alembic upgrade head`、再跑 `alembic check`。這三步任何一步失敗都會在這裡炸出來，所以這一次通過同時就是漂移檢查通過，不需要另外下指令。

- [ ] **Step 7: 跑完整套件**

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 469 passed（463 + 6）

- [ ] **Step 8: Commit**

```bash
git add app/models/session.py app/models/__init__.py \
        migrations/versions/0007_create_refresh_sessions.py tests/test_sessions.py
git commit -m "feat: 新增 refresh_sessions 資料表

jti 唯一、family_id 標示同一次登入衍生的整條鏈。
used_at 與 revoked_at 分開，才分得出「正常輪替到底」與「被判定外洩」。"
```

---

### Task 2：token 函式拆成 access / refresh，refresh 強制帶 jti

**為什麼值得動 25 個測試檔的一行：** 目前 `create_token(user_id, token_type)` 讓「簽一張沒有 jti 的 refresh token」是型別合法的。只要那條路存在，日後就會有人走上去，而走上去的後果是一張**永遠撤銷不掉**的票。拆成兩個函式之後，那個錯誤選擇在型別層就不存在了 —— 這是規格 §6 的「把檢查寫進程式碼，不要寫第三次警告」。改動全部由 mypy 抓，不會有漏網之魚。

**Files:**
- Modify: `app/security/tokens.py`（改寫）
- Modify: `app/api/deps.py:9,22`
- Modify: `app/api/routes/auth.py:18,84-85,92,101-102`
- Modify: `tests/test_tokens.py`、`tests/test_auth_login.py`、`tests/test_auth_refresh.py`、`tests/test_auth_me.py`，以及 21 個只有 `auth()` helper 用到的測試檔
- Test: `tests/test_tokens.py`

- [ ] **Step 1: 寫失敗的測試**

Replace `tests/test_tokens.py` 的全部內容：

```python
from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.security.tokens import (
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_access_token,
    decode_refresh_token,
)


def test_access_token_round_trip():
    token = create_access_token(user_id=42)
    assert decode_access_token(token) == 42


def test_refresh_token_round_trip_carries_the_jti():
    jti = uuid4()
    token = create_refresh_token(user_id=7, jti=jti)

    claims = decode_refresh_token(token)

    assert claims.user_id == 7
    assert claims.jti == jti


def test_refresh_token_is_rejected_where_an_access_token_is_expected():
    """這是重要的安全性質：長效的 refresh token 不可以拿來直接存取 API。"""
    token = create_refresh_token(user_id=1, jti=uuid4())
    with pytest.raises(TokenError):
        decode_access_token(token)


def test_access_token_is_rejected_where_a_refresh_token_is_expected():
    """注意這條測試**不是**在測 type 檢查 —— access token 沒有 jti，
    所以它在 `_decode` 的 require 清單那一關就被擋掉了，根本走不到
    type 比對。名字與實際守住的東西不一致，但兩個性質都該有測試，
    所以保留它，另外用下面那條補上 type 檢查。
    """
    token = create_access_token(user_id=1)
    with pytest.raises(TokenError):
        decode_refresh_token(token)


def test_a_token_typed_access_but_carrying_a_jti_is_still_rejected_as_refresh():
    """把 type 比對單獨釘住。

    上面那條被 require 清單擋在前面，於是「把 type 檢查整個拿掉」這個突變
    只有 refresh→access 那個方向會變紅（實測：2 個測試紅），access→refresh
    方向無人看守。這裡偽造一張 type=access 但帶合法 jti 的票 ——
    require 清單滿足了，**只剩 type 檢查能擋它**。
    """
    now = datetime.now(UTC)
    forged = _forge(
        {
            "sub": "1",
            "type": "access",
            "jti": str(uuid4()),
            "iat": now,
            "exp": now + timedelta(minutes=15),
        }
    )
    with pytest.raises(TokenError):
        decode_refresh_token(forged)


def test_tampered_token_is_rejected():
    token = create_access_token(user_id=1)
    tampered = token[:-4] + "AAAA"
    with pytest.raises(TokenError):
        decode_access_token(tampered)


def test_garbage_is_rejected():
    with pytest.raises(TokenError):
        decode_access_token("this-is-not-a-token")


def test_expired_access_token_is_rejected(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "access_token_ttl_minutes", -1)
    token = create_access_token(user_id=1)

    with pytest.raises(TokenError):
        decode_access_token(token)


def test_expired_refresh_token_is_rejected(monkeypatch):
    """兩條路徑現在真的是兩段不同的程式碼（require 清單不同），
    所以這個測試不再只是形式上的重複 —— 它是唯一會發現 refresh 路徑
    的過期驗證壞掉的東西。
    """
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_token_ttl_days", -1)
    token = create_refresh_token(user_id=1, jti=uuid4())

    with pytest.raises(TokenError):
        decode_refresh_token(token)


def _forge(payload: dict[str, object]) -> str:
    """繞過 create_*_token，直接用同一把密鑰簽一個任意 payload 的 token。"""
    import jwt as pyjwt

    from app.config import settings

    return pyjwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def test_forged_token_with_non_numeric_sub_raises_token_error():
    """簽章有效但 payload 形狀不對，也必須是 TokenError，不能是 ValueError。

    呼叫端（get_current_user）只接 TokenError，其他例外會變成 500。
    """
    now = datetime.now(UTC)
    forged = _forge(
        {"sub": "not-a-number", "type": "access", "iat": now, "exp": now + timedelta(minutes=15)}
    )
    with pytest.raises(TokenError):
        decode_access_token(forged)


def test_forged_token_without_sub_raises_token_error():
    now = datetime.now(UTC)
    forged = _forge({"type": "access", "iat": now, "exp": now + timedelta(minutes=15)})
    with pytest.raises(TokenError):
        decode_access_token(forged)


def test_forged_token_without_exp_is_rejected():
    """沒有 exp 的 token 不能被接受 —— 否則它永遠不會過期。"""
    forged = _forge({"sub": "1", "type": "access", "iat": datetime.now(UTC)})
    with pytest.raises(TokenError):
        decode_access_token(forged)


def test_refresh_token_without_jti_is_rejected():
    """**上線相容性的關鍵測試（規格 §7）。**

    部署當下所有已發出的 refresh token 都長這個樣子（沒有 jti）。
    它們必須被明確拒絕，而不是被當成「舊格式」放行 —— 放行等於這個缺陷
    還開著，而那段相容邏輯忘記拿掉就是一個永久的後門。
    """
    now = datetime.now(UTC)
    forged = _forge({"sub": "1", "type": "refresh", "iat": now, "exp": now + timedelta(days=14)})
    with pytest.raises(TokenError):
        decode_refresh_token(forged)


def test_refresh_token_with_a_malformed_jti_raises_token_error():
    """jti 不是合法 UUID 時要是 TokenError，不能讓 ValueError 漏出去變成 500。"""
    now = datetime.now(UTC)
    forged = _forge(
        {
            "sub": "1",
            "type": "refresh",
            "jti": "not-a-uuid",
            "iat": now,
            "exp": now + timedelta(days=14),
        }
    )
    with pytest.raises(TokenError):
        decode_refresh_token(forged)


def test_access_token_does_not_carry_a_jti():
    """access token 刻意沒有 jti：它不對應任何一列，也不查資料庫（規格 §4）。

    如果哪天有人幫它加上 jti，那多半意味著他正打算讓 access token 也查表 ——
    這個測試會讓那個決定停下來被討論，而不是安靜地發生。
    """
    import jwt as pyjwt

    from app.config import settings

    token = create_access_token(user_id=1)
    payload = pyjwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

    assert "jti" not in payload
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_tokens.py -v`

Expected: FAIL — `ImportError: cannot import name 'create_access_token' from 'app.security.tokens'`

- [ ] **Step 3: 改寫 `app/security/tokens.py`**

Replace 全部內容：

```python
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt

from app.config import settings


class TokenError(Exception):
    """token 無效、過期，或類型不符。"""


@dataclass(frozen=True)
class RefreshClaims:
    """decode_refresh_token 的結果。

    回 dataclass 而不是 tuple：呼叫端寫 `claims.jti` 讀得出意圖，寫
    `claims[1]` 讀不出來 —— 而 int 與 UUID 位置寫反了，型別檢查抓得到，
    但如果兩個都是 tuple 索引就沒人擋。
    """

    user_id: int
    jti: uuid.UUID


def _encode(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _decode(token: str, *, require: list[str]) -> dict[str, Any]:
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            # 預設只在 exp 存在時才驗證它 —— 少了 exp 的偽造 token 會永遠有效。
            options={"require": require},
        )
    except jwt.PyJWTError as exc:
        raise TokenError("token 無效或已過期") from exc
    return payload


# 保留這個 Literal：expected_type 打錯字（"acess"）要在 mypy 就爆掉 ——
# 這個 task 的整個論點就是「讓錯誤的選擇由型別擋住」。
TokenType = Literal["access", "refresh"]


def _user_id_from(payload: dict[str, Any], *, expected_type: TokenType) -> int:
    if payload.get("type") != expected_type:
        raise TokenError("token 類型不正確")
    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise TokenError("token payload 格式不正確") from exc


def create_access_token(user_id: int) -> str:
    """短效票，**不帶 jti、不對應任何資料列**（規格 §4）。"""
    now = datetime.now(UTC)
    return _encode(
        {
            "sub": str(user_id),
            "type": "access",
            "iat": now,
            "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
        }
    )


def create_refresh_token(user_id: int, jti: uuid.UUID) -> str:
    """長效票。**`jti` 是必填參數，沒有預設值。**

    這是刻意的：一張沒有 jti 的 refresh token 在 `refresh_sessions` 裡沒有
    對應的列，因此永遠撤銷不掉。把 jti 做成必填，讓那種票在型別層就造不
    出來，而不是靠註解提醒。
    """
    now = datetime.now(UTC)
    return _encode(
        {
            "sub": str(user_id),
            "type": "refresh",
            "jti": str(jti),
            "iat": now,
            "exp": now + timedelta(days=settings.refresh_token_ttl_days),
        }
    )


def decode_access_token(token: str) -> int:
    payload = _decode(token, require=["exp", "iat", "sub", "type"])
    return _user_id_from(payload, expected_type="access")


def decode_refresh_token(token: str) -> RefreshClaims:
    """`require` 比 access 多一個 `jti`（規格 §7）。

    部署當下所有已發出的 refresh token 都沒有 jti，會在這裡被拒絕 ——
    後果是全員重新登入一次，這是刻意的，不做向後相容。
    """
    payload = _decode(token, require=["exp", "iat", "sub", "type", "jti"])
    user_id = _user_id_from(payload, expected_type="refresh")

    # **這裡刻意只接 ValueError，不接 KeyError。**
    # 「jti 存不存在」是上面 require 清單的責任，這個 except 只負責
    # 「值的格式對不對」。兩者都接的話就是兩道防線互相掩護（§6 第 5 種）：
    # 把 require 裡的 jti 拿掉，KeyError 會被接住、拋出同一個 TokenError，
    # 測試全綠 —— 這個性質就從來沒有被任何單一守衛釘住過
    # （Task 2 品質審查實測驗證，不是推論）。
    #
    # 也刻意不先套 str()：str() 會讓一個 32 位十進位整數也變成合法 UUID。
    raw_jti = payload["jti"]
    if not isinstance(raw_jti, str):
        raise TokenError("token payload 格式不正確")
    try:
        jti = uuid.UUID(raw_jti)
    except ValueError as exc:
        raise TokenError("token payload 格式不正確") from exc
    return RefreshClaims(user_id=user_id, jti=jti)
```

- [ ] **Step 4: 跑 tokens 的測試確認通過**

Run: `.venv/Scripts/python.exe -m pytest tests/test_tokens.py -v`

Expected: 15 passed

- [ ] **Step 5: 讓 mypy 列出所有還沒改的呼叫點，逐一修掉**

Run: `.venv/Scripts/python.exe -m mypy app`

Expected: `app/api/deps.py` 與 `app/api/routes/auth.py` 各有錯誤。

Modify `app/api/deps.py` 第 9 行與第 22 行：

```python
from app.security.tokens import TokenError, decode_access_token
```

```python
        user_id = decode_access_token(credentials.credentials)
```

Modify `app/api/routes/auth.py`：頂端加 `import uuid`，import 行改成

```python
from app.security.tokens import (
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
)
```

`login()` 的回傳改成：

```python
    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id, uuid.uuid4()),
    )
```

`refresh()` 的本體改成：

```python
    try:
        claims = decode_refresh_token(payload.refresh_token)
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    user = await db.get(User, claims.user_id)
    if user is None:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期")

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id, uuid.uuid4()),
    )
```

> 這一版**還沒有任何撤銷能力** —— 它只是讓 token 帶上 jti、讓專案編得過。資料列與輪替在 Task 3、4 才接上。這是刻意拆開的：Task 2 的 diff 全部是機械性改名，混進邏輯會讓 review 看不出重點。

- [ ] **Step 6: 修測試裡的呼叫點**

25 個測試檔用到 `create_token`。先批次改主體：

```bash
grep -rl "create_token(" tests/ | xargs sed -i \
  -e "s/create_token(\([^,]*\), 'access')/create_access_token(\1)/g" \
  -e 's/create_token(\([^,]*\), "access")/create_access_token(\1)/g' \
  -e 's/create_token(user_id=\([^,]*\), token_type="access")/create_access_token(\1)/g'
```

然後**逐檔檢查 import 行** —— sed 不會幫你改對：

```bash
grep -rn "from app.security.tokens import" tests/
```

每一行的 `create_token` 都要改成 `create_access_token`（`tests/test_auth_login.py`、`tests/test_auth_me.py`、`tests/test_auth_refresh.py` 另外還要 `create_refresh_token` / `decode_access_token` / `decode_refresh_token`）。

`tests/test_auth_login.py` 第 16-17 行：

```python
    assert decode_access_token(body["access_token"]) == user.id
    assert decode_refresh_token(body["refresh_token"]).user_id == user.id
```

`tests/test_auth_me.py` 第 28 行（「拿 refresh token 打 /api/me 要被擋」）：

```python
    token = create_refresh_token(user.id, uuid4())
```

`tests/test_auth_refresh.py` 四個測試全部改用 `create_refresh_token(..., uuid4())` 與 `decode_access_token(...)`。**四個都會通過，不需要任何 xfail 標記。**

> **這份計畫原本在這裡寫錯，實作時由實測推翻 —— 記下來因為推翻的理由本身有價值。**
>
> 原本寫的是「其中兩個現在會失敗，先標 `xfail(strict=True)`，Task 4 再拿掉」。
> 那是錯的：Task 2 的 `refresh()` **根本不查 `refresh_sessions`**（那是 Task 4 的事），
> 它只是 decode 然後重簽一張。而測試自己用 `create_refresh_token(user.id, uuid4())`
> 鑄了一張帶合法 jti 的票，所以 decode 會過、`db.get(User, ...)` 也查得到，
> 結果就是 200。
>
> 寫計畫的人腦中想的是 **Task 4 之後**的狀態，然後把那個狀態寫進了 Task 2 的預期。
> 這是計畫文字層級的缺陷，而計畫的缺陷正是這個專案最常出問題的地方
> （見交接文件 §11 第 2 點）。
>
> **盲目照著加 `xfail(strict=True)` 會讓套件變紅**（XPASS），所以這裡的正確
> 行為是實測後拒絕執行計畫，而不是照做。

- [ ] **Step 7: 跑完整套件與靜態檢查**

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 473 passed（469 + test_tokens.py 淨增的 4 個），**0 xfailed**

Run: `.venv/Scripts/python.exe -m mypy app` → Success

Run: `.venv/Scripts/ruff.exe check .` → All checks passed

- [ ] **Step 8: Commit**

```bash
git add app/security/tokens.py app/api/deps.py app/api/routes/auth.py tests/
git commit -m "refactor: token 函式拆成 access / refresh，refresh 強制帶 jti

create_refresh_token 的 jti 是必填參數，沒有預設值 —— 一張沒有 jti 的
refresh token 永遠撤銷不掉，所以讓它在型別層就造不出來。

decode_refresh_token 的 require 清單多一個 jti，既有的 refresh token
會被拒絕（規格 §7：上線後全員重新登入一次，刻意不做向後相容）。"
```

---

### Task 3：`sessions.py` 與登入時開一條 family

**Files:**
- Create: `app/security/sessions.py`
- Modify: `app/api/routes/auth.py`（`login()`）
- Test: `tests/test_sessions.py`（追加）

- [ ] **Step 1: 寫失敗的測試**

Append to `tests/test_sessions.py`:

```python
from sqlalchemy import select

from app.security.sessions import start_session
from app.security.tokens import decode_access_token, decode_refresh_token
from tests.factories import DEFAULT_PASSWORD


async def test_start_session_writes_a_row_matching_the_issued_token(db_session):
    user = await create_user(db_session)

    issued = await start_session(db_session, user.id)

    claims = decode_refresh_token(issued.refresh_token)
    assert decode_access_token(issued.access_token) == user.id

    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
    assert row.user_id == user.id
    assert row.used_at is None
    assert row.revoked_at is None


async def test_two_logins_start_two_separate_families(db_session):
    """每次登入是獨立的一條鏈 —— 否則在手機上登出會把桌機也一起登出，
    而規格 §1 的整個出發點就是要能只撤銷一台裝置。
    """
    user = await create_user(db_session)

    first = await start_session(db_session, user.id)
    second = await start_session(db_session, user.id)

    first_family = (
        await db_session.scalar(
            select(RefreshSession).where(
                RefreshSession.jti == decode_refresh_token(first.refresh_token).jti
            )
        )
    ).family_id
    second_family = (
        await db_session.scalar(
            select(RefreshSession).where(
                RefreshSession.jti == decode_refresh_token(second.refresh_token).jti
            )
        )
    ).family_id

    assert first_family != second_family


async def test_login_endpoint_creates_a_session_row(client, db_session):
    """端點層：登入回的 refresh token 必須真的對應到一列。

    只測 start_session 不夠 —— login() 有可能繞過它自己簽一張票，
    那樣所有 sessions.py 的單元測試都還是綠的。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/auth/login",
        json={"email": user.email, "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
    claims = decode_refresh_token(response.json()["refresh_token"])
    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
    assert row.user_id == user.id


async def test_start_session_commits_the_row(db_session):
    """**這條測試守的是這個 task 唯一真正的決定：sessions.py 自己管交易。**

    `commit` 不能弱化成 `flush`，也不能省略 —— production 的 `get_db` 是
    per-request，session 一關就把沒 commit 的 INSERT 丟掉，登入會發出一張
    沒有對應資料列的票，Task 4 之後每一次換發都 401。

    而預設情況下這件事**測不出來**：測試的 `db_session` 用 create_savepoint，
    `commit()` 只是 RELEASE SAVEPOINT，對同一個 session 來說「有沒有 commit」
    不可觀察（實測：把 commit 整行刪掉，476 個測試全綠）。

    下面那行 `rollback()` 就是把它變成可觀察的：沒 commit 的話那一列還在
    savepoint 裡，rollback 會把它抹掉；commit 過的不會。
    """
    user = await create_user(db_session)
    issued = await start_session(db_session, user.id)

    await db_session.rollback()

    claims = decode_refresh_token(issued.refresh_token)
    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
```

> `test_login_endpoint_creates_a_session_row` 是這個 task 唯一有鑑別力的端點測試。既有的 `test_auth_login.py` 只斷言「回了一個能解碼的 refresh token」—— 把 `login()` 改回自己簽票、完全不寫資料列，那些測試一個都不會紅。

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'app.security.sessions'`

- [ ] **Step 3: 寫 `app/security/sessions.py`**

Create `app/security/sessions.py`:

```python
import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import RefreshSession
from app.security.tokens import create_access_token, create_refresh_token


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str


def _issue(db: AsyncSession, *, user_id: int, family_id: uuid.UUID) -> IssuedTokens:
    """寫一列，並簽出對應那一列的一組票。

    **寫列與簽票刻意綁在同一個函式裡，`jti` 不外流。** 拆成
    「`_add_row` 回傳 jti」+「`_tokens_for(jti)`」的話，呼叫端就有可能
    把兩者配錯 —— 而那個 bug 的後果是資料列與票上的 jti 不一致，
    每一次換發都 401（突變 11 已驗證這一類的破壞力）。綁在一起之後，
    配錯這件事在結構上不可表達。

    不在這裡 commit：呼叫端可能還要在同一個交易裡做別的事（Task 4 的輪替
    就是先 UPDATE 舊列再呼叫這裡），交易邊界交給呼叫端決定。
    """
    jti = uuid.uuid4()
    now = datetime.now(UTC)
    db.add(
        RefreshSession(
            user_id=user_id,
            jti=jti,
            family_id=family_id,
            issued_at=now,
            # 這個值只給 cleanup-sessions 用；過期判斷本身由 JWT 的 exp 負責。
            #
            # 它跟 token 的 exp 不是同一個時刻算出來的，實測差距約 150 毫秒
            # （主因是 JWT 的 exp 是整數秒的 NumericDate，PyJWT 會截斷；
            # 其次是兩次 datetime.now() 之間隔著一次資料庫往返）。
            # 截斷通常讓資料列比票晚過期（安全的方向），但**方向不保證** ——
            # 往返時間超過截斷餘數時會反過來。在 14 天的尾巴上差幾百毫秒，
            # 後果可以忽略，但不要以為這兩個值相等。
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    return IssuedTokens(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id, jti),
    )


async def start_session(db: AsyncSession, user_id: int) -> IssuedTokens:
    """登入：開一條全新的 family。

    每次登入都是獨立的一條鏈，所以在手機上登出不會動到桌機 —— 那是規格 §1
    整個要解決的問題（今天唯一的止血手段是換 JWT_SECRET，會把所有人一起登出）。

    **這個模組自己管交易，不把 commit 留給路由** —— 這違反了這個 codebase
    其他地方的慣例（交易邊界一律在 `app/api/routes/` 裡），所以理由寫在這裡：

    Task 4 的重用偵測必須**先把整個 family 的撤銷寫進資料庫、再拋例外**。
    例外一拋，路由層就不會 commit 了，撤銷會跟著被 rollback —— 結果是
    「回了 401、但票其實還活著」的靜默失效。既然那條路徑非自己 commit 不可，
    整個模組就統一自己管，不要一半一半。

    **代價：呼叫端不可以在呼叫這裡之前留下不相關的待寫入資料**，
    那些東西會被這裡的 commit 一起帶進去。今天的 `login()` 在這之前
    只有一次 SELECT，沒有寫入。
    """
    issued = _issue(db, user_id=user_id, family_id=uuid.uuid4())
    await db.commit()
    return issued
```

> **為什麼 commit 寫在這裡，而不是留給路由。** 這個模組的其他函式（Task 4）在「偵測到重用」時必須**先把整個 family 撤銷寫進資料庫、再拋例外**。例外一旦拋出，路由那層就不會 commit 了，撤銷會跟著被 rollback 掉 —— 那是一個「回了 401、但票其實還活著」的靜默失效。既然那條路徑非自己 commit 不可，整個模組就統一自己管交易，不要一半一半。

- [ ] **Step 4: 讓 `login()` 走 `start_session`**

Modify `app/api/routes/auth.py`：

import 加上

```python
from app.security.sessions import start_session
```

`login()` 結尾的 `return TokenResponse(...)` 換成：

```python
    issued = await start_session(db, user.id)
    return TokenResponse(
        access_token=issued.access_token,
        refresh_token=issued.refresh_token,
    )
```

`create_refresh_token` 與 `uuid` 在 `login()` 裡已經不用了，但 `refresh()` 還在用（Task 4 才換掉），先保留 import。

- [ ] **Step 5: 確認 `test_auth_refresh.py` 仍然全綠，並預告它會在 Task 4 變紅**

這一步不改任何東西，但要親自跑一次 `tests/test_auth_refresh.py`，確認四個都還是綠的。

> **Task 4 會讓 `test_refresh_returns_a_new_access_token` 變紅**，這是預期中的。
> 它現在用 `create_refresh_token(user.id, uuid4())` 手鑄一張票 —— Task 4 讓
> `rotate_session` 去 `refresh_sessions` 查那個 jti 之後，這張手鑄票查無此列，
> 回 401。**Task 4 Step 5 會把它改成先登入再換發。**
>
> 現在先知道這件事，否則 Task 4 跑出一個紅燈時，第一反應會是去懷疑
> `rotate_session` 寫錯了。

- [ ] **Step 6: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: 10 passed（Task 1 的 6 個 + 這裡的 4 個）

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 477 passed

- [ ] **Step 6b: 給 TTL 設定加下界**

Task 3 改變了「TTL 設成 0 或負數」的後果。在這之前那是軟性失敗（票一出生就
過期，但登入本身還是成功）；現在 `ck_refresh_sessions_expires_after_issued`
會在 `start_session` 的 commit 當下拋 `CheckViolationError`，**沒人接，
登入端點 500**。

照 `app/config.py` 既有的 fail-closed 精神（`_reject_known_public_placeholder`）
與 commit `0f9f331`（拒絕負的 `--min-age-hours`）的前例，讓它在啟動時就失敗：

```python
    access_token_ttl_minutes: int = Field(15, gt=0)
    refresh_token_ttl_days: int = Field(14, gt=0)
```

import 補上 `Field`。

> **確認一件事再改：** `tests/test_tokens.py` 有兩個測試用
> `monkeypatch.setattr(settings, "refresh_token_ttl_days", -1)` 測過期。
> Pydantic v2 的 `BaseSettings` 預設 `validate_assignment=False`，所以
> 指派不會觸發驗證，那兩個測試應該不受影響 —— **但要實際跑過確認**，
> 不要從文件推論。如果真的壞了，回報，不要改那兩個測試。

- [ ] **Step 7: Commit**

```bash
git add app/config.py app/security/sessions.py app/api/routes/auth.py tests/test_sessions.py
git commit -m "feat: 登入時開一條 refresh session family

sessions.py 自己管交易，不把 commit 留給路由 —— Task 4 的重用偵測必須
在拋例外前把撤銷寫進資料庫，那條路徑沒有別的選擇。"
```

---

### Task 4：輪替與重用偵測

這是整份計畫的核心。

**Files:**
- Modify: `app/security/sessions.py`
- Modify: `app/api/routes/auth.py`（`refresh()`）
- Modify: `tests/test_auth_refresh.py`（改寫一個手鑄 token 的測試 + 新增端點層測試）
- Test: `tests/test_sessions.py`（追加）

- [ ] **Step 1: 寫失敗的測試**

Append to `tests/test_sessions.py`:

```python
from app.security.sessions import ReuseDetectedError, rotate_session
from app.security.tokens import TokenError


async def test_rotation_issues_a_new_token_in_the_same_family(db_session):
    user = await create_user(db_session)
    first = await start_session(db_session, user.id)

    second = await rotate_session(db_session, first.refresh_token)

    first_row = await db_session.scalar(
        select(RefreshSession).where(
            RefreshSession.jti == decode_refresh_token(first.refresh_token).jti
        )
    )
    second_row = await db_session.scalar(
        select(RefreshSession).where(
            RefreshSession.jti == decode_refresh_token(second.refresh_token).jti
        )
    )

    assert first_row.used_at is not None
    assert second_row.used_at is None
    assert second_row.family_id == first_row.family_id


async def test_the_old_token_stops_working_after_rotation(db_session):
    """**這個專案要修的就是這一件事。**

    注意「換發後新票可用」那種測試對這個缺陷零鑑別力 —— 它在修好之前
    就是綠的，修好之後也是綠的，跟缺陷的重疊區間是空的（§6 第 6 條）。
    有鑑別力的形狀只有一種：拿【舊】票再換一次，必須失敗。
    """
    user = await create_user(db_session)
    first = await start_session(db_session, user.id)
    await rotate_session(db_session, first.refresh_token)

    with pytest.raises(TokenError):
        await rotate_session(db_session, first.refresh_token)


async def test_reusing_a_spent_token_revokes_the_whole_family(db_session):
    """三層鏈，不是兩層。

    A → B → C 之後拿 B 重用：B 失效是本來就會發生的事（它已經 used_at 了），
    真正要證明的是 **C 也一起死**。只驗兩層的話，把「撤銷整個 family」
    改成「只撤銷這一列」，測試照樣綠。
    """
    user = await create_user(db_session)
    a = await start_session(db_session, user.id)
    b = await rotate_session(db_session, a.refresh_token)
    c = await rotate_session(db_session, b.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, b.refresh_token)

    # C 必須也死了
    with pytest.raises(TokenError):
        await rotate_session(db_session, c.refresh_token)


async def test_reuse_detection_persists_the_revocation(db_session):
    """撤銷必須真的寫進資料庫，不能只是「拋了例外」。

    §6 第 3 條與第 7 條的組合：例外拋出後路由不會 commit，如果撤銷是靠
    呼叫端 commit 的，它會被 rollback 掉 —— 結果是「回了 401，但票還活著」，
    而只斷言例外的測試完全看不到這件事。
    """
    user = await create_user(db_session)
    # 先把 id 取出來。下面的 rollback() 會讓 user 這個 ORM 物件過期，
    # 之後再讀 user.id 會觸發一次同步的 refresh 查詢，在 async 環境下
    # 直接炸 MissingGreenlet —— 那會讓這條測試以「崩潰」而不是
    # 「斷言失敗」的方式變紅，而崩潰是偶然的守衛（見本計畫開頭那一節）。
    user_id = user.id
    a = await start_session(db_session, user_id)
    # 不賦值：這裡只需要「A 已經被輪替過一次」這件事，留著未使用的變數
    # ruff 會報 F841。
    await rotate_session(db_session, a.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, a.refresh_token)

    # **這一行不能省。** 沒有它，這個測試證明的只是「撤銷在記憶體裡」——
    # 測試的 db_session 用 create_savepoint，commit 只是 RELEASE SAVEPOINT，
    # 「有沒有 commit」對同一個 session 不可觀察（見本計畫開頭那一節）。
    # rollback 之後還讀得到的，才是真的寫進資料庫的。
    await db_session.rollback()

    # 選欄位而不是實體，同樣是為了不在 rollback 之後碰 ORM 屬性。
    revoked_at_values = (
        await db_session.scalars(
            select(RefreshSession.revoked_at).where(RefreshSession.user_id == user_id)
        )
    ).all()
    assert len(revoked_at_values) == 2
    assert all(value is not None for value in revoked_at_values)


async def test_revoking_one_family_leaves_another_family_alone(db_session):
    """手機外洩不該把桌機一起弄掉。"""
    user = await create_user(db_session)
    phone = await start_session(db_session, user.id)
    desktop = await start_session(db_session, user.id)
    await rotate_session(db_session, phone.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, phone.refresh_token)

    # 桌機那條鏈完全沒被波及
    rotated = await rotate_session(db_session, desktop.refresh_token)
    assert rotated.access_token


async def test_rotation_rejects_a_token_whose_row_does_not_exist(db_session):
    """簽章有效、jti 格式正確，但資料庫裡沒有這一列 —— 例如上線前發出的票
    （規格 §7），或資料庫被還原到更早的時間點。
    """
    user = await create_user(db_session)
    orphan = create_refresh_token(user.id, uuid4())

    with pytest.raises(TokenError):
        await rotate_session(db_session, orphan)
```

檔案頂端的 import 補上 `create_refresh_token`。

新增 `tests/test_sessions_concurrency.py`（獨立檔案，因為它需要完全不同的夾具）：

```python
"""並行行為的測試 —— 開真實的第二條連線。

`tests/conftest.py` 讓所有測試共用一個交易（外層 rollback 做隔離）。
那個設計是對的，但它有一個結構性的後果：**「兩個交易互相看不見對方」
這件事在那套夾具裡無法被觀察**，而這個模組所有的並行保證都活在那個維度上
（規格 §6 陷阱 5）。

所以這個檔案不用 `db_session`，自己開連線，而且寫進去的資料是**真的會
commit** 的 —— 必須自己清乾淨。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest_asyncio
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.session import RefreshSession
from app.models.user import User
from app.security.password import hash_password
from app.security.sessions import ReuseDetectedError, rotate_session, start_session
from app.security.tokens import decode_refresh_token
from tests.conftest import TEST_DATABASE_URL

# 給下面的 pg_stat_activity 輪詢用——asyncpg 的原生連線不吃 SQLAlchemy 的
# "+asyncpg" 這段方言標記。
_RAW_DSN = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


@pytest_asyncio.fixture
async def independent_sessions(
    migrated_database: None,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """一個可以開出多條互相獨立連線的 sessionmaker。

    每條連線各自有自己的交易，commit 是真的 commit —— 這正是重點。
    """
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def _wait_until_someone_else_is_lock_waiting(exclude_pid: int) -> None:
    """輪詢 `pg_stat_activity`，直到有一條不是 `exclude_pid` 的連線卡在 Lock 上。

    **為什麼是輪詢，不是 `sleep(常數)`。** 一般測試裡的 sleep 是在
    「等一段時間、希望某件事已經發生」——那正是規格文件列進「綠燈說謊」
    清單的那種 sleep，它掩蓋不確定性，不是消除它。這裡不一樣：我們要的
    不是「大概過了夠久」，而是**直接觀察到**另一條連線真的被鎖卡住了。
    這是一個可以直接查詢的事實（`wait_event_type = 'Lock'`），不需要用
    時間去猜要等多久；輪詢間隔只影響多等幾毫秒，不影響正確性。

    呼叫端用 `asyncio.timeout()` 包住這個函式，不是自己收一個 `timeout`
    參數（ruff ASYNC109）——逾時策略是呼叫端的事，這個函式只負責
    「這件事發生了嗎」。
    """
    raw = await asyncpg.connect(_RAW_DSN)
    try:
        while True:
            row = await raw.fetchrow(
                "SELECT 1 FROM pg_stat_activity "
                "WHERE datname = current_database() "
                "AND pid != $1 AND wait_event_type = 'Lock'",
                exclude_pid,
            )
            if row is not None:
                return
            await asyncio.sleep(0.005)
    finally:
        await raw.close()


async def test_reuse_detection_revokes_the_family_even_under_concurrent_rotation(
    independent_sessions,
):
    """**規格 §3.2：這是整個功能唯一真正要保證的性質。**

    攻擊形狀：攻擊者握有一份儲存傾印，裡面有已用過的 A 與還活著的 B，
    同時送出兩個 refresh。A 觸發重用偵測、撤銷整個 family；B 同時在輪替，
    剛插入的 C 若不在撤銷的視野裡，攻擊者就帶著一張活票走人 ——
    **在一個所有人都認為已經撤銷的 family 裡**。

    **這條測試曾經是 `asyncio.gather` 自然競速版本，被品質審查擋下。**
    規格 §6 規矩 1：「綠燈在被觀察到失敗之前不算證據，每個守衛都要突變
    過。」拿掉 `_lock_user_sessions` 之後，那個版本在某台機器
    （Windows + Docker Desktop）上連跑 25 次，一次都沒有變紅——不是因為
    這個性質成立，是因為那台機器上兩條連線的自然交錯穩定地落在安全的
    方向。那條測試從頭到尾沒有真的被突變觀察過，等於沒有守衛。

    這裡改成手動、確定性地建構規格 §3.2 描述的那個交錯，不依賴任何自然
    時序：

      1. 「干擾側」手動重現一次真正輪替 B 的資料庫動作（UPDATE 舊列、
         INSERT 新列 C），卡在 commit 之前不放。
      2. 輪詢 `pg_stat_activity`，確認 replay 側真的被鎖卡住了才放行——
         不是猜一個看起來夠長的 sleep，是直接觀察到那個狀態發生
         （見 `_wait_until_someone_else_is_lock_waiting`）。
      3. replay 側呼叫的是**真正的** `rotate_session`——它才是被測的對象。

    **耦合說明（刻意的取捨，不是缺點）：** 干擾側手寫了「UPDATE 舊列 →
    INSERT 新列」兩個步驟，而不是呼叫 `rotate_session` 本身——因為我們
    需要在這兩步之後、commit 之前暫停，那個暫停點在 `rotate_session`
    函式內部，外面插不進去。這讓這條測試知道 `rotate_session` 內部的
    操作順序：先 UPDATE 舊列、再 INSERT 新列。如果那個順序日後改變，
    這條測試可能要跟著調整。換來的是能夠**確定性地**重現這個競態，
    而不是每次執行看運氣——這是目前唯一看得見規格 §3.2 的方法。
    """
    async with independent_sessions() as setup:
        user = User(
            email="concurrency-probe@example.com",
            password_hash=hash_password("correct-horse-battery"),
            display_name="並行測試",
        )
        setup.add(user)
        await setup.commit()
        user_id = user.id

    try:
        async with independent_sessions() as s:
            a = await start_session(s, user_id)
            b = await rotate_session(s, a.refresh_token)

        claims_b = decode_refresh_token(b.refresh_token)
        rotation_ready = asyncio.Event()

        async def interfering_rotation() -> None:
            """手動重現一次輪替 B 的資料庫動作，卡在 commit 之前不放。"""
            async with independent_sessions() as s:
                # 這一側也要拿鎖——它在模擬一次真正的輪替，而真正的輪替
                # 會拿。少了它，這條測試在「rotate_session 的鎖被拿掉」時
                # 就抓不到問題：replay 側不會等它，兩邊會各走各的，永遠
                # 不會卡在同一列上。
                await s.execute(select(func.pg_advisory_xact_lock(user_id)))
                own_pid = await s.scalar(select(func.pg_backend_pid()))

                family_id = (
                    await s.execute(
                        update(RefreshSession)
                        .where(
                            RefreshSession.jti == claims_b.jti,
                            RefreshSession.used_at.is_(None),
                            RefreshSession.revoked_at.is_(None),
                        )
                        .values(used_at=datetime.now(UTC))
                        .returning(RefreshSession.family_id)
                    )
                ).scalar_one()

                now = datetime.now(UTC)
                s.add(
                    RefreshSession(
                        user_id=user_id,
                        jti=uuid.uuid4(),
                        family_id=family_id,
                        issued_at=now,
                        expires_at=now + timedelta(days=14),
                    )
                )

                rotation_ready.set()
                # 等到 replay 側真的卡住了（不管是卡在上面那個 advisory
                # lock，還是——如果鎖被拿掉——卡在 _revoke_family 想鎖
                # 這裡剛剛更新的 B 列），才放行 commit。逾時兜底不是這個
                # 等待的本體，只是避免測試在環境異常時無限卡住。
                try:
                    async with asyncio.timeout(5.0):
                        await _wait_until_someone_else_is_lock_waiting(own_pid)
                except TimeoutError as exc:
                    raise AssertionError(
                        "等不到 replay 側卡進 Lock 等待狀態——如果這裡逾時，"
                        "代表這個 PostgreSQL 環境的鎖等待行為跟預期不同，"
                        "不要調鬆 timeout 蓋過去，先確認 pg_stat_activity "
                        "的假設還成不成立。"
                    ) from exc
                await s.commit()

        async def replay_rotation() -> Exception | None:
            await rotation_ready.wait()
            async with independent_sessions() as s:
                try:
                    await rotate_session(s, a.refresh_token)
                except Exception as exc:
                    return exc
                return None

        _, replay_error = await asyncio.gather(
            interfering_rotation(),
            replay_rotation(),
        )

        assert isinstance(replay_error, ReuseDetectedError), (
            f"重放已用的 A 應該要被判定成重用，實際結果：{replay_error!r}"
        )

        # **這才是重點：整個 family 不可以留下任何一張活票。**
        async with independent_sessions() as check:
            live = await check.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(
                    RefreshSession.user_id == user_id,
                    RefreshSession.used_at.is_(None),
                    RefreshSession.revoked_at.is_(None),
                )
            )
        assert live == 0, (
            f"重用偵測回報已撤銷，但還有 {live} 張活票 —— "
            "攻擊者可以在一個所有人都認為已撤銷的 family 裡繼續換發（規格 §3.2）"
        )
    finally:
        async with independent_sessions() as cleanup:
            # ON DELETE CASCADE 會把 refresh_sessions 一起帶走
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
```

> **上面這段是實測驗證過的最終版本，不是計畫推測的版本。**
>
> 第一版用 `asyncio.gather` 靠自然競速，被品質審查擋下：拿掉
> `_lock_user_sessions` 之後，它在 Windows + Docker Desktop 上**連跑 25 次
> 一次都沒變紅** —— 那台機器上兩條連線的自然交錯穩定落在安全的方向。
> 那條測試從頭到尾沒有被突變觀察過，依規格 §6 規矩 1 等於沒有守衛。
>
> 現在的版本手動、確定性地建構規格 §3.2 的交錯。**驗收數據（雙向都要）：**
> 有鎖連跑 10 次全綠、拿掉鎖連跑 10 次全紅（實作者），主 session 又獨立
> 複跑 3 次綠 / 4 次紅，失敗一律是乾淨的 `assert 1 == 0`（恰好一張洩漏的活票）。
>
> **關於那個輪詢而不是 `sleep`：** 一般測試裡的 sleep 是「等一段時間、
> 希望某件事已經發生」，那種 sleep 掩蓋不確定性而不是消除它。這裡輪詢
> `pg_stat_activity` 的 `wait_event_type = 'Lock'`，是**直接觀察到**另一條
> 連線真的被鎖卡住了 —— 那是一個可以查詢的事實，不需要用時間去猜。
>
> **這條測試為什麼不跟其他測試放同一個檔案：** 它需要 `migrated_database`
> 但**不能**用 `db_session` / `client`。放獨立檔案讓「這個檔案的夾具規則
> 不一樣」一眼看得出來，不會有人順手把 `db_session` 加進參數列。
>
> **它比其他測試慢**（真的開連線、真的 commit），而且**不可重入** ——
> 用固定的 email，所以同一時間只能跑一份。這是刻意的取捨：
> 換來的是唯一一條看得見並行缺陷的測試。

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: FAIL — `ImportError: cannot import name 'ReuseDetectedError'`

- [ ] **Step 3: 實作輪替與重用偵測**

Append to `app/security/sessions.py`（頂端 import 補上 `NoReturn`、`select`、`update`、`RefreshClaims`、`TokenError`、`decode_refresh_token`）：

```python
class ReuseDetectedError(TokenError):
    """一張已經被換發過的 refresh token 又被拿來使用。

    繼承 TokenError，所以路由層只要接 TokenError 就同時涵蓋兩者 ——
    對呼叫端來說回應完全一樣（401 INVALID_TOKEN），**刻意不讓攻擊者
    從回應分辨出「我被偵測到了」**。分成兩個類別純粹是為了讓伺服器端
    的日誌能區分「票過期了」與「有人在重放」。
    """


async def _lock_user_sessions(db: AsyncSession, user_id: int) -> None:
    """把「同一個使用者的 session 變更」序列化。

    **為什麼需要（實測發現，不是理論）：** `_revoke_family` 是一個 bulk
    UPDATE，在 READ COMMITTED 下它的快照固定在 statement 開始的那一刻。
    同時間另一個交易 INSERT 進來的新列**完全不在它的視野裡** ——
    EvalPlanQual 只會重新檢查被鎖住的既有列，不會看見新插入的列。

    後果：攻擊者同時送出「已用過的 A」與「還活著的 B」，A 觸發重用偵測、
    撤銷整個 family，但 B 那條交易剛插入的 C 沒被撤銷到 —— 系統回報
    「已撤銷」、使用者被登出，而攻擊者手上握著一張活票。
    **60 次並行試驗重現 59 次**，這是主流結果不是罕見競態。

    **鎖的粒度是使用者而不是 family：** logout-all 一次要處理多個 family，
    用 family 當鍵的話它跟輪替不會互斥，同一個洞會從登出那條路再開一次。
    使用者層級讓輪替、登出、全部登出三條路徑共用同一個鍵空間。

    `user_id` 直接當鍵，不需要額外查詢 —— 它來自已驗簽的 JWT。
    代價可以忽略：一台裝置每 15 分鐘才換發一次票。

    這個 codebase 目前沒有其他地方用 advisory lock，所以不需要命名空間；
    日後若有，要改用有命名空間的雙參數形式。
    """
    await db.execute(select(func.pg_advisory_xact_lock(user_id)))


async def _revoke_family(db: AsyncSession, family_id: uuid.UUID) -> None:
    await db.execute(
        update(RefreshSession)
        .where(
            RefreshSession.family_id == family_id,
            RefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )


async def _reject(db: AsyncSession, claims: RefreshClaims) -> NoReturn:
    """搶不到那一列，判斷是哪一種失敗。"""
    row = await db.scalar(select(RefreshSession).where(RefreshSession.jti == claims.jti))

    if row is not None and row.revoked_at is None and row.used_at is not None:
        # 這張票已經被換發過了。兩種可能：(a) 攻擊者拿到舊票，
        # (b) 合法 client 因網路重試送了兩次。**伺服器無法區分這兩者**，
        # 而猜錯的代價不對稱 —— 把重試誤判為外洩的代價是使用者重新登入一次；
        # 把外洩誤判為重試的代價是攻擊者得到一條永久有效的鏈。所以一律撤銷。
        #
        # 這個決定把一個約束推給前端：同一時間只能有一個 refresh 在飛
        # （P3-A 規格 §6.4 的 single-flight 鎖）。後端刻意不做寬限期，
        # 寬限期會直接稀釋這個偵測的鑑別力。
        await _revoke_family(db, row.family_id)
        # 必須在拋例外前 commit：例外一拋，路由層就不會 commit 了。
        await db.commit()
        raise ReuseDetectedError("refresh token 被重複使用")

    raise TokenError("token 無效或已過期")


async def rotate_session(db: AsyncSession, refresh_token: str) -> IssuedTokens:
    """換發：舊票當場失效，新票長在同一條 family 上。"""
    # **呼叫前不可以在 session 上留著沒 commit 的 RefreshSession。**
    # SQLAlchemy 的 autoflush 會讓下面那個 db.execute() 先把待寫入的 INSERT
    # 送出去，順序就反過來 —— 新列在舊列被標 used_at 之前就進了部分唯一索引，
    # 直接撞 uq_refresh_sessions_one_live_per_family。目前所有呼叫路徑都安全
    # （get_db 是 per-request，start_session / rotate_session 都自己 commit），
    # 但下一個寫這張表的人不會知道，所以寫在這裡。
    claims = decode_refresh_token(refresh_token)

    # **必須在條件式 UPDATE 之前取得。** 見 _lock_user_sessions 的說明 ——
    # 少了這一行，重用偵測在並行下有 59/60 的機率留下一張活票。
    await _lock_user_sessions(db, claims.user_id)

    # 條件式 UPDATE ... RETURNING，不是「先 SELECT 判斷再 UPDATE」：
    # 兩個並行的換發請求都會通過 SELECT 的檢查，然後兩個都發出新票，
    # 而且誰都不會被判定成重用。把條件寫進 UPDATE 的 WHERE，
    # 由資料庫保證只有一個搶得到那一列。
    claimed = (
        await db.execute(
            update(RefreshSession)
            .where(
                RefreshSession.jti == claims.jti,
                RefreshSession.used_at.is_(None),
                RefreshSession.revoked_at.is_(None),
            )
            .values(used_at=datetime.now(UTC))
            .returning(RefreshSession.user_id, RefreshSession.family_id)
        )
    ).one_or_none()

    # 這裡刻意**不**檢查 expires_at —— 過期由 decode_refresh_token 的
    # JWT exp 負責，而且已經有測試釘住（test_expired_refresh_token_is_rejected）。
    # 兩個地方都擋的話，突變掉任何一個都不會有測試變紅，兩道防線互相掩護
    # （§6 第 5 種）。expires_at 欄位只服務 cleanup-sessions。
    if claimed is None:
        # _reject 的回傳型別是 NoReturn，mypy 據此知道這一行之後 claimed
        # 一定不是 None。若你的 mypy 版本沒有做這個收窄，把下一行改成
        # `user_id, family_id = claimed  # type: ignore[misc]` 之前，
        # 先確認 _reject 的簽章真的寫了 `-> NoReturn`。
        await _reject(db, claims)

    user_id, family_id = claimed
    issued = _issue(db, user_id=user_id, family_id=family_id)
    await db.commit()
    return issued
```

- [ ] **Step 4: 讓 `refresh()` 走 `rotate_session`**

Modify `app/api/routes/auth.py` 的 `refresh()`，整個本體換成：

```python
    try:
        issued = await rotate_session(db, payload.refresh_token)
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    return TokenResponse(
        access_token=issued.access_token,
        refresh_token=issued.refresh_token,
    )
```

import 改成 `from app.security.sessions import rotate_session, start_session`，並移除已經沒人用的 `create_access_token` / `create_refresh_token` / `decode_refresh_token` / `uuid` / `User` 的 import（若 `register()` 還在用 `User` 就留著）。ruff 會指出多餘的 import。

> `rotate_session` 自己查過使用者了嗎？沒有 —— 它查的是 session 列，而 session 列有 `ON DELETE CASCADE` 的外鍵。使用者被刪掉時那些列會一起消失，於是 `claimed is None` → `_reject` → 找不到列 → `TokenError`。**這就是 `test_refresh_rejects_a_token_for_a_deleted_user` 現在會通過的原因**，不需要在 `refresh()` 裡多查一次 `db.get(User, ...)`。

- [ ] **Step 5: 改寫手鑄 token 的測試，並加一個端點層測試**

**`test_refresh_returns_a_new_access_token` 到這一步會變紅，這是預期中的。**
它用 `create_refresh_token(user.id, uuid4())` 手鑄一張票，而 `rotate_session`
現在會去 `refresh_sessions` 查那個 jti —— 查無此列，回 401。

改成先登入取得一張**真的有對應資料列**的票：

```python
async def test_refresh_returns_a_new_access_token(client, db_session):
    user = await create_user(db_session)
    login = await client.post(
        "/api/auth/login", json={"email": user.email, "password": DEFAULT_PASSWORD}
    )
    refresh_token = login.json()["refresh_token"]

    response = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})

    assert response.status_code == 200
    body = response.json()
    assert decode_access_token(body["access_token"]) == user.id
```

檔案頂端 import 補上 `from tests.factories import DEFAULT_PASSWORD, create_user`。

另外三個測試不用改：`test_refresh_rejects_an_access_token` 與
`test_refresh_rejects_garbage` 在 decode 階段就被擋；
`test_refresh_rejects_a_token_for_a_deleted_user` 走的是「查無此列」那條路
（見上一個 step 的說明）。

再加一個端點層的測試（sessions.py 的單元測試證明不了路由真的接上了）：

```python
async def test_refresh_endpoint_invalidates_the_old_token(client, db_session):
    user = await create_user(db_session)
    first = await client.post(
        "/api/auth/login",
        json={"email": user.email, "password": DEFAULT_PASSWORD},
    )
    old_refresh = first.json()["refresh_token"]

    await client.post("/api/auth/refresh", json={"refresh_token": old_refresh})
    again = await client.post("/api/auth/refresh", json={"refresh_token": old_refresh})

    assert again.status_code == 401
    assert again.json()["error"]["code"] == "INVALID_TOKEN"
```

- [ ] **Step 6: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py tests/test_auth_refresh.py -v`

Expected: 16 passed + 5 passed

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 484 passed

Run: `.venv/Scripts/python.exe -m mypy app` → Success
Run: `.venv/Scripts/ruff.exe check .` → All checks passed

- [ ] **Step 7: Commit**

```bash
git add app/security/sessions.py app/api/routes/auth.py tests/
git commit -m "feat: refresh token 輪替與重用偵測

換發用條件式 UPDATE ... RETURNING 搶那一列，不是先 SELECT 再 UPDATE ——
後者在並行下兩個請求都會過。搶不到就進重用判斷：已經 used_at 的票
被再次使用一律當作外洩，撤銷整個 family。

刻意不在 UPDATE 的 WHERE 裡檢查 expires_at：過期由 JWT 的 exp 負責，
兩邊都擋的話突變任一個都不會有測試變紅（§6 第 5 種）。"
```

---

### Task 5：登出端點，以及那個刻意留著的 15 分鐘缺口

**Files:**
- Modify: `app/security/sessions.py`
- Modify: `app/schemas/auth.py`
- Modify: `app/api/routes/auth.py`
- Test: `tests/test_auth_logout.py`（新增）

- [ ] **Step 1: 寫失敗的測試**

Create `tests/test_auth_logout.py`:

```python
from tests.factories import DEFAULT_PASSWORD, create_user


async def _login(client, user) -> dict[str, str]:
    response = await client.post(
        "/api/auth/login", json={"email": user.email, "password": DEFAULT_PASSWORD}
    )
    assert response.status_code == 200
    return response.json()


async def test_logout_kills_the_refresh_token(client, db_session):
    """**斷言的是伺服器上那張票死了，不是回應碼。**

    只斷言「回 204」或「前端回到登入頁」，證明的是狀態碼與前端狀態 ——
    把 logout 寫成「什麼都不做直接回 204」，那種測試照樣綠（§6 第 3 條）。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)

    logout = await client.post(
        "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    assert logout.status_code == 204

    again = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert again.status_code == 401


async def test_logout_kills_the_whole_family_not_just_the_last_token(client, db_session):
    """登出時手上那張票可能已經輪替過好幾輪。撤銷必須及於整條鏈，
    否則鏈上任何一張還沒用過的票都還活著。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)
    rotated = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    newest = rotated.json()["refresh_token"]

    await client.post("/api/auth/logout", json={"refresh_token": newest})

    again = await client.post("/api/auth/refresh", json={"refresh_token": newest})
    assert again.status_code == 401


async def test_logout_is_idempotent(client, db_session):
    """登出是冪等的。「讓我登出」在票已經死掉時已經達成了 ——
    回錯誤只會逼前端在登出流程裡多寫一段沒有意義的錯誤處理。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)

    first = await client.post(
        "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )
    second = await client.post(
        "/api/auth/logout", json={"refresh_token": tokens["refresh_token"]}
    )

    assert first.status_code == 204
    assert second.status_code == 204


async def test_logout_accepts_garbage_without_leaking_whether_it_was_valid(client):
    """對無效的 token 一樣回 204。回 401 等於提供一個「這張票還活著嗎」的探針。"""
    response = await client.post("/api/auth/logout", json={"refresh_token": "nope"})
    assert response.status_code == 204


async def test_logout_only_affects_the_device_that_logged_out(client, db_session):
    """**規格 §1 的核心產出。** 手機登出，桌機不受影響。"""
    user = await create_user(db_session)
    phone = await _login(client, user)
    desktop = await _login(client, user)

    await client.post("/api/auth/logout", json={"refresh_token": phone["refresh_token"]})

    still_alive = await client.post(
        "/api/auth/refresh", json={"refresh_token": desktop["refresh_token"]}
    )
    assert still_alive.status_code == 200


async def test_logout_all_kills_every_device(client, db_session):
    user = await create_user(db_session)
    phone = await _login(client, user)
    desktop = await _login(client, user)

    response = await client.post(
        "/api/auth/logout-all",
        headers={"Authorization": f"Bearer {desktop['access_token']}"},
    )
    assert response.status_code == 204

    for tokens in (phone, desktop):
        refreshed = await client.post(
            "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
        )
        assert refreshed.status_code == 401


async def test_logout_all_requires_authentication(client):
    response = await client.post("/api/auth/logout-all")
    assert response.status_code == 401


async def test_logout_all_does_not_touch_another_users_sessions(client, db_session):
    user = await create_user(db_session)
    other = await create_user(db_session)
    other_tokens = await _login(client, other)
    mine = await _login(client, user)

    await client.post(
        "/api/auth/logout-all",
        headers={"Authorization": f"Bearer {mine['access_token']}"},
    )

    refreshed = await client.post(
        "/api/auth/refresh", json={"refresh_token": other_tokens["refresh_token"]}
    )
    assert refreshed.status_code == 200


async def test_an_access_token_still_works_after_logout_and_that_is_deliberate(
    client, db_session
):
    """**這個測試在斷言一個弱點存在，而且那是刻意的（規格 §4）。**

    access token 不查資料庫。每個請求都去查一次 session 表，等於把無狀態
    驗證的全部好處丟掉，換來最多 15 分鐘的延遲改善 —— 對這個規模不划算。
    所以撤銷的真實語意是：「再也換不到新票，但手上這張最多還能用 15 分鐘」。

    沒有這個測試的話，日後有人在 get_current_user 裡「順手補上」一次
    DB 查詢，不會有任何東西變紅提醒他剛剛付出了什麼代價。
    """
    user = await create_user(db_session)
    tokens = await _login(client, user)

    await client.post("/api/auth/logout", json={"refresh_token": tokens["refresh_token"]})

    me = await client.get(
        "/api/me", headers={"Authorization": f"Bearer {tokens['access_token']}"}
    )
    assert me.status_code == 200, (
        "access token 在登出後的剩餘壽命內仍然有效是刻意的設計（規格 §4）。"
        "如果這個斷言失敗，代表有人讓 access token 開始查資料庫了 —— "
        "那是一個需要被討論的效能取捨，不是一個順手的修正。"
    )
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_auth_logout.py -v`

Expected: FAIL — 多數是 404（`/api/auth/logout` 還不存在）

- [ ] **Step 3: 加撤銷函式**

> **這一段的程式碼曾經跟它自己的 docstring 矛盾。** 原本的版本在 docstring
> 裡寫「這裡也要先取 `_lock_user_sessions`」，但**程式碼範例裡沒有那行呼叫**。
> 照抄的人會漏掉，而漏掉的後果是登出那條路徑重新打開規格 §3.2 那個洞。
>
> 這正好是交接文件 §6 第 7 條的實例：**文件擋不住重蹈覆轍，程式碼可以。**
> 把警告寫進 docstring 而不是寫進程式碼本身，等於什麼都沒做。
> 下面的版本是從實作驗證過的 `app/security/sessions.py` 直接同步回來的。

Append to `app/security/sessions.py`:

```python
async def revoke_session(db: AsyncSession, refresh_token: str) -> None:
    """登出單一裝置：撤銷這張票所屬的整條 family。

    **這裡也要先取 `_lock_user_sessions`**（規格 §3.2）：`_revoke_family`
    是 bulk UPDATE，在 READ COMMITTED 下快照固定在 statement 開始那一刻，
    並行交易剛 INSERT 的列完全不在它的視野裡 —— 所以「登出的同時另一個
    分頁正在輪替」會留下一張活票，跟重用偵測那個洞是同一個，只是從登出
    這條路進來。鎖的粒度是使用者，讓輪替、登出、全部登出三條路徑互斥。

    **先 SELECT 拿到那一列、再取鎖，順序不能反。** 呼叫這個函式不需要
    通過身分驗證，只需要一張簽章有效的 refresh token——如果先取鎖，
    任何一張簽章有效但列已經被清掉的 token（過期太久被 Task 6 的
    cleanup 清掉、或使用者本尊早就登出過）都能讓沒有通過任何驗證的
    呼叫者，拿到那個使用者的 advisory lock。反過來先 SELECT：鎖只在
    真的找到列、真的要撤銷時才取，而且用**列上的** `user_id`（資料庫
    裡的事實），不是 token 聲稱的那個。這同時也修掉了另一個問題——
    原本 `row is None` 的提早 return 會在已經取到鎖之後才發生，
    離開時沒有 commit 也沒有 rollback，鎖只能等交易結束才釋放；
    先 SELECT 的話那個分支根本還沒碰過鎖。

    `family_id` 不會因為輪替而改變，所以先取到的值在拿鎖前後仍然有效；
    列在這段空窗期被刪除，代表對應的 family 早就因為使用者被刪除而
    整條消失，撤銷一個不存在的 family 是安全的空操作。

    **一律靜默成功。** 無效、過期、偽造、已經撤銷過的 token 都不回錯誤 ——
    回錯誤等於提供一個「這張票還活著嗎」的探針，而登出本來就是冪等的。
    """
    try:
        claims = decode_refresh_token(refresh_token)
    except TokenError:
        return

    row = await db.scalar(select(RefreshSession).where(RefreshSession.jti == claims.jti))
    if row is None:
        return

    await _lock_user_sessions(db, row.user_id)

    await _revoke_family(db, row.family_id)
    await db.commit()


async def revoke_all_for_user(db: AsyncSession, user_id: int) -> None:
    """登出所有裝置。`user_id` 來自已驗證的 access token，不是使用者輸入。

    同樣要先取 `_lock_user_sessions`。這也正是鎖的粒度選使用者而不是 family
    的原因：這個函式一次要處理多個 family，用 family 當鍵它跟輪替不會互斥。
    """
    await _lock_user_sessions(db, user_id)

    await db.execute(
        update(RefreshSession)
        .where(
            RefreshSession.user_id == user_id,
            RefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    await db.commit()
```

- [ ] **Step 4: 加 schema**

Append to `app/schemas/auth.py`:

```python
class LogoutRequest(BaseModel):
    """跟 RefreshRequest 形狀相同，但刻意是獨立的型別 ——

    兩個端點的請求體日後可能各自長出欄位（例如登出帶上裝置識別），
    共用一個型別會讓那時候的改動被迫同時影響兩邊。
    """

    refresh_token: str
```

- [ ] **Step 5: 加端點**

Append to `app/api/routes/auth.py`:

```python
@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: LogoutRequest, db: AsyncSession = Depends(get_db)) -> None:
    """刻意**不需要** access token。

    使用者要登出的時刻，手上的 access token 很可能已經過期了 —— 那正是
    他想登出的原因之一。要求 access token 會讓「票過期的裝置反而登不出去」。
    而呼叫者手上已經有那張 refresh token 了，能做的事遠比登出多。
    """
    await revoke_session(db, payload.refresh_token)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> None:
    await revoke_all_for_user(db, user.id)
```

import 補上：

```python
from app.api.deps import get_current_user
from app.schemas.auth import LogoutRequest
from app.security.sessions import revoke_all_for_user, revoke_session, rotate_session, start_session
```

- [ ] **Step 5a: 補兩條模組層的測試 —— HTTP 表面看不見這兩個性質**

Task 4 的 `rotate_session` 有 `tests/test_sessions.py` 的模組層覆蓋，
Task 5 原本只有路由層測試加一條並行測試。實測（Task 5 品質審查）證明
那不夠，**兩個突變存活，9 條登出測試全綠**：

| 突變 | 為什麼 HTTP 層看不見 |
|---|---|
| `revoke_session` 改成只撤銷被出示的那一列，不撤整個 family | 登出後重放鏈上任一張票都是 401 —— 已撤銷的走 `TokenError`、未撤銷但已用的走 `ReuseDetectedError`，兩者刻意回同一個 401。**端點層在定義上分不出來。** |
| `revoke_session` 拿掉 `await db.commit()` | 共用 session 的夾具讓沒 commit 的寫入對下一個請求仍然可見（見本計畫開頭那一節） |

兩條都加進 `tests/test_sessions.py`（**不是** `test_auth_logout.py`）：

```python
async def test_logout_revokes_the_whole_family(db_session):
    """三層鏈：登出時手上那張可能已經輪替過好幾輪，撤銷必須及於整條鏈。

    **端點層測不到這件事**：鏈上任一張票在登出後都回 401，不管是因為
    「已撤銷」還是因為「已用過」——那兩條路徑刻意回同一個 401。
    """
    user = await create_user(db_session)
    user_id = user.id
    a = await start_session(db_session, user_id)
    b = await rotate_session(db_session, a.refresh_token)

    await revoke_session(db_session, b.refresh_token)

    revoked = (
        await db_session.scalars(
            select(RefreshSession.revoked_at).where(RefreshSession.user_id == user_id)
        )
    ).all()
    assert len(revoked) == 2
    assert all(value is not None for value in revoked)


async def test_logout_persists_the_revocation(db_session):
    """撤銷必須真的寫進資料庫。rollback 之後還讀得到的才算數
    （見本計畫開頭那一節）。
    """
    user = await create_user(db_session)
    user_id = user.id
    issued = await start_session(db_session, user_id)

    await revoke_session(db_session, issued.refresh_token)
    await db_session.rollback()

    revoked = (
        await db_session.scalars(
            select(RefreshSession.revoked_at).where(RefreshSession.user_id == user_id)
        )
    ).all()
    assert revoked and all(value is not None for value in revoked)
```

> **為什麼這兩條不能只靠那條並行測試。** 它們目前唯一的守衛是
> `test_logout_revokes_the_family_even_under_concurrent_rotation`，而且是
> **偶然**守到的 —— 那條測試的失敗訊息講的是並行，不是「忘了 commit」。
> 它同時也是最貴、對環境最敏感的一條（輪詢 `pg_stat_activity`、5 秒逾時）。
> 那正是 CI 一不穩就會被 `xfail` 掉的測試 —— 而它一被關掉，
> **三個互相獨立的性質（鎖、family 範圍、持久化）會同時失去唯一的守衛。**

- [ ] **Step 5b: 補一條登出版的並行測試**

`revoke_session` 裡那把鎖，在這個 task 完成時**沒有任何測試在守**。
實測確認：把 `await _lock_user_sessions(...)` 從 `revoke_session` 拿掉，
完整套件 496 全綠。

`tests/test_sessions_concurrency.py` 現有那條只涵蓋「重用偵測 vs 輪替」。
「登出 vs 輪替」是**同一個洞的另一條路徑**，需要自己的測試。結構完全比照
現有那條（干擾側手動輪替卡在 commit 前、輪詢 `pg_stat_activity` 確認
登出側真的被鎖住、然後放行）：

```python
async def test_logout_revokes_the_family_even_under_concurrent_rotation(
    independent_sessions,
):
    """**規格 §3.2 的另一條路徑：登出 vs 輪替，跟重用偵測是同一個洞。**

    `revoke_session` 呼叫的是同一個 `_revoke_family`——一個 bulk UPDATE，
    在 READ COMMITTED 下快照固定在 statement 開始那一刻，並行交易剛
    INSERT 的新列完全不在它的視野裡。上面那條測試釘住的是「重用偵測 vs
    輪替」；這條走的是完全不同的呼叫路徑（使用者主動登出，不是重放判斷）
    ——Task 5 之前這條路徑上完全沒有測試看得見它。

    攻擊/意外形狀：裝置手上握著 A，使用者按下登出的同時，另一個分頁
    （或背景自動換發）剛好在輪替 A -> C。登出讀到 A 對應的 family_id，
    去撤銷整個 family，但如果撤銷發生在 C 被 INSERT 之後、卻在同一個
    bulk UPDATE 的快照之外，C 就會活下來——使用者以為登出了，
    但那張新票還能繼續換發。

    交錯的建構方式跟上面那條同構（同樣是實測驗證過、不依賴自然時序的
    確定性版本）：

      1. 「干擾側」手動重現一次真正輪替 A 的資料庫動作（UPDATE 舊列、
         INSERT 新列 C），卡在 commit 之前不放。
      2. 輪詢 `pg_stat_activity`，確認 replay 側真的卡住了才放行——
         有鎖時卡在 `_lock_user_sessions` 的 advisory lock；鎖被拿掉時
         卡在 `_revoke_family` 想鎖干擾側剛更新的 A 那一列（兩者的
         `wait_event_type` 都是 'Lock'，所以同一個輪詢函式兩種情況都認得出來）。
      3. replay 側呼叫的是**真正的** `revoke_session`——它才是被測的對象。
    """
    async with independent_sessions() as setup:
        user = User(
            email="logout-concurrency-probe@example.com",
            password_hash=hash_password("correct-horse-battery"),
            display_name="登出並行測試",
        )
        setup.add(user)
        await setup.commit()
        user_id = user.id

    try:
        async with independent_sessions() as s:
            a = await start_session(s, user_id)

        claims_a = decode_refresh_token(a.refresh_token)
        rotation_ready = asyncio.Event()

        async def interfering_rotation() -> None:
            """手動重現一次真正輪替 A 的資料庫動作，卡在 commit 之前不放。"""
            async with independent_sessions() as s:
                # 這一側也要拿鎖——它在模擬一次真正的輪替，而真正的輪替會拿。
                await s.execute(select(func.pg_advisory_xact_lock(user_id)))
                own_pid = await s.scalar(select(func.pg_backend_pid()))

                family_id = (
                    await s.execute(
                        update(RefreshSession)
                        .where(
                            RefreshSession.jti == claims_a.jti,
                            RefreshSession.used_at.is_(None),
                            RefreshSession.revoked_at.is_(None),
                        )
                        .values(used_at=datetime.now(UTC))
                        .returning(RefreshSession.family_id)
                    )
                ).scalar_one()

                now = datetime.now(UTC)
                s.add(
                    RefreshSession(
                        user_id=user_id,
                        jti=uuid.uuid4(),
                        family_id=family_id,
                        issued_at=now,
                        expires_at=now + timedelta(days=14),
                    )
                )

                rotation_ready.set()
                try:
                    async with asyncio.timeout(5.0):
                        await _wait_until_someone_else_is_lock_waiting(own_pid)
                except TimeoutError as exc:
                    raise AssertionError(
                        "等不到 replay 側卡進 Lock 等待狀態——如果這裡逾時，"
                        "代表這個 PostgreSQL 環境的鎖等待行為跟預期不同，"
                        "不要調鬆 timeout 蓋過去，先確認 pg_stat_activity "
                        "的假設還成不成立。"
                    ) from exc
                await s.commit()

        async def replay_logout() -> None:
            await rotation_ready.wait()
            async with independent_sessions() as s:
                await revoke_session(s, a.refresh_token)

        await asyncio.gather(interfering_rotation(), replay_logout())

        # **這才是重點：登出回報完成之後，這個使用者名下不可以留下任何活票。**
        async with independent_sessions() as check:
            live = await check.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(
                    RefreshSession.user_id == user_id,
                    RefreshSession.used_at.is_(None),
                    RefreshSession.revoked_at.is_(None),
                )
            )
        assert live == 0, (
            f"登出應該撤銷整個 family，但還有 {live} 張活票 —— "
            "使用者以為登出了，輪替出的新票卻還活著（規格 §3.2 的另一條路徑）"
        )
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
```

**驗收數據（雙向都要）：** 有鎖連跑 10 次全綠、拿掉鎖連跑 10 次全紅
（實作者）；主 session 又獨立複跑 2 次綠 / 3 次紅，失敗一律是乾淨的
`assert 1 == 0`，而且**只有登出那條變紅**，重用那條仍綠 —— 特異性正確。

- [ ] **Step 6: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_auth_logout.py -v`

Expected: 9 passed

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 493 passed

- [ ] **Step 7: Commit**

```bash
git add app/security/sessions.py app/schemas/auth.py app/api/routes/auth.py \
        tests/test_auth_logout.py
git commit -m "feat: POST /api/auth/logout 與 /logout-all

logout 不需要 access token：要登出的時刻手上那張多半已經過期，
要求它會讓過期的裝置反而登不出去。無效 token 一律靜默回 204，
回錯誤等於提供一個「這張票還活著嗎」的探針。

另外釘住規格 §4 那個刻意的 15 分鐘缺口 —— 沒有測試守著的話，
日後有人讓 access token 開始查資料庫不會有任何東西變紅。"
```

---

### Task 6：`cleanup-sessions` 指令

過期的列不清會一直長。形狀比照既有的 `cleanup-photos`。

**Files:**
- Modify: `app/cli.py`
- Test: `tests/test_cli.py`（追加）

- [ ] **Step 1: 寫失敗的測試**

Append to `tests/test_cli.py`:

```python
from datetime import UTC, datetime, timedelta
from uuid import uuid4

from sqlalchemy import select

from app.cli import build_parser, cleanup_expired_sessions
from app.models.session import RefreshSession


def _session_row(user_id: int, *, expires_at) -> RefreshSession:
    return RefreshSession(
        user_id=user_id,
        jti=uuid4(),
        family_id=uuid4(),
        issued_at=expires_at - timedelta(days=14),
        expires_at=expires_at,
    )


async def test_cleanup_removes_only_expired_sessions(db_session):
    user = await create_user(db_session)
    now = datetime.now(UTC)
    expired = _session_row(user.id, expires_at=now - timedelta(seconds=1))
    alive = _session_row(user.id, expires_at=now + timedelta(days=7))
    db_session.add_all([expired, alive])
    await db_session.commit()

    deleted = await cleanup_expired_sessions(db_session)

    assert deleted == 1
    remaining = (await db_session.scalars(select(RefreshSession))).all()
    assert [row.jti for row in remaining] == [alive.jti]


async def test_cleanup_removes_revoked_sessions_only_after_they_expire(db_session):
    """已撤銷但還沒過期的列**不能**刪。

    那一列正是「這張票已經死了」的唯一證據 —— 刪掉之後，rotate_session
    查不到列，走的是「找不到」那條路，結果仍然是 401，**測試看起來一樣綠**。
    但重用偵測的證據沒了：真正的攻擊會被降級成一次普通的失敗，
    伺服器日誌裡再也看不出有人在重放。
    """
    user = await create_user(db_session)
    now = datetime.now(UTC)
    revoked_but_fresh = _session_row(user.id, expires_at=now + timedelta(days=7))
    revoked_but_fresh.revoked_at = now
    db_session.add(revoked_but_fresh)
    await db_session.commit()

    deleted = await cleanup_expired_sessions(db_session)

    assert deleted == 0


async def test_cleanup_dry_run_deletes_nothing(db_session):
    user = await create_user(db_session)
    db_session.add(
        _session_row(user.id, expires_at=datetime.now(UTC) - timedelta(seconds=1))
    )
    await db_session.commit()

    would_delete = await cleanup_expired_sessions(db_session, dry_run=True)

    assert would_delete == 1
    remaining = (await db_session.scalars(select(RefreshSession))).all()
    assert len(remaining) == 1


async def test_cleanup_persists_the_deletion(db_session):
    """刪除必須真的 commit。

    **實測：拿掉 `cleanup_expired_sessions` 的 `await db.commit()`，
    完整套件 502 全綠。** 共用 session 的夾具讓「有沒有 commit」不可觀察
    （見本計畫開頭那一節）—— 這是這份計畫裡第三次踩到同一件事
    （Task 3 的 start_session、Task 5 的 revoke_session）。

    rollback 之後還消失的，才是真的被刪掉的。注意 rollback 前先把 jti 取進
    本地變數，查詢時選欄位而不是實體 —— rollback 之後讀 ORM 屬性會炸
    MissingGreenlet，讓測試以崩潰而非斷言的方式變紅。
    """
    user = await create_user(db_session)
    expired = _session_row(user.id, expires_at=datetime.now(UTC) - timedelta(seconds=1))
    db_session.add(expired)
    await db_session.commit()
    expired_jti = expired.jti

    await cleanup_expired_sessions(db_session)
    await db_session.rollback()

    remaining = (
        await db_session.scalars(
            select(RefreshSession.jti).where(RefreshSession.jti == expired_jti)
        )
    ).all()
    assert remaining == []


def test_parser_accepts_cleanup_sessions():
    args = build_parser().parse_args(["cleanup-sessions", "--dry-run"])
    assert args.command == "cleanup-sessions"
    assert args.dry_run is True
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_cli.py -v -k session`

Expected: FAIL — `ImportError: cannot import name 'cleanup_expired_sessions'`

- [ ] **Step 3: 實作**

Append to `app/cli.py`:

```python
async def cleanup_expired_sessions(db: AsyncSession, *, dry_run: bool = False) -> int:
    """刪掉 `expires_at` 已過的 refresh session 列，回傳筆數。

    **只看 `expires_at`，不看 `revoked_at`。** 一列已撤銷但還沒過期的紀錄，
    正是「這張票已經死了、而且是這樣死的」的唯一證據：提早刪掉的話，
    `rotate_session` 查不到列，走的是「找不到」那條路 —— 回應同樣是 401，
    測試同樣是綠的，但重用偵測的證據沒了，真正的攻擊會被降級成一次
    普通的失敗。過期之後才刪，那時 JWT 的 `exp` 已經自己擋住了。
    """
    cutoff = datetime.now(UTC)

    if dry_run:
        count = await db.scalar(
            select(func.count())
            .select_from(RefreshSession)
            .where(RefreshSession.expires_at < cutoff)
        )
        return count or 0

    # 單一 statement，不是「撈出來再一列一列 delete」——
    # 這張表每台活躍裝置每天長約 100 列，把幾千個 ORM 物件載進記憶體
    # 只為了刪掉它們，是沒有必要的。
    result = await db.execute(delete(RefreshSession).where(RefreshSession.expires_at < cutoff))
    await db.commit()
    # AsyncSession.execute() 的靜態型別是 Result[Any]——rowcount 定義在
    # CursorResult 上，但那正是 DML 陳述式實際回傳的物件。
    return cast(CursorResult[Any], result).rowcount
```

頂端 import 補上 `from app.models.session import RefreshSession`，以及 `from sqlalchemy import delete, func, select`（`select` 已經有了）。

`build_parser()` 在 `cleanup_parser` 之後追加：

```python
    cleanup_sessions_parser = subparsers.add_parser(
        "cleanup-sessions", help="刪除已過期的 refresh session 紀錄"
    )
    cleanup_sessions_parser.add_argument(
        "--dry-run", action="store_true", help="只計算筆數，不真的刪"
    )
```

追加執行函式：

```python
async def _run_cleanup_sessions(*, dry_run: bool) -> None:
    async with SessionLocal() as db:
        count = await cleanup_expired_sessions(db, dry_run=dry_run)

    verb = "會刪除" if dry_run else "已刪除"
    print(f"{verb} {count} 筆過期的 refresh session")
```

`_main()` 的分支追加：

```python
    elif args.command == "cleanup-sessions":
        await _run_cleanup_sessions(dry_run=args.dry_run)
```

> **`mypy app` 會擋 `result.rowcount`。** `AsyncSession.execute()` 的靜態
> 型別是 `Result[Any]`，而 `rowcount` 定義在 `CursorResult` 上 —— 但那正是
> DML 陳述式實際回傳的東西。用 `cast(CursorResult[Any], result).rowcount`，
> 並在旁邊註解說明為什麼這個 cast 是安全的。
> （計畫最初的程式碼片段漏了這個，實作時補上。）

- [ ] **Step 4: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_cli.py -v`

Expected: 既有測試 + 4 passed

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 497 passed

- [ ] **Step 5: Commit**

```bash
git add app/cli.py tests/test_cli.py
git commit -m "feat: cleanup-sessions 指令

只刪 expires_at 已過的列，不刪「已撤銷但還沒過期」的 ——
那一列是重用偵測的證據，提早刪掉會讓真正的攻擊降級成一次普通的失敗，
而且回應與測試都不會有任何差別。"
```

---

### Task 7：突變驗證、文件、上線備註

前六個 task 讓測試變綠。**這個 task 才是證明那些綠燈算數的地方。**

**Files:**
- Modify: `docs/deployment.md`
- Modify: `docs/handover.md`（§8.1 改成已完成）
- Modify: 本計畫文件（寫回突變結果）

- [ ] **Step 1: 逐一跑突變，把結果寫回這份文件**

每一個都是：改一行 → 跑指定的測試 → **確認它變紅** → 改回來。
**沒有親眼看到紅燈的守衛不算數（§6 規矩 1）。**

| # | 突變 | 必須變紅的測試 | 結果 |
|---|---|---|---|
| 1 | `rotate_session` 的 UPDATE 拿掉 `used_at.is_(None)` | `test_the_old_token_stops_working_after_rotation` | ✅ **已驗證**（Task 4）5 failed / 479 passed。除了預測的那條，還連帶紅了 `test_reusing_a_spent_token_revokes_the_whole_family`、`test_reuse_detection_persists_the_revocation`、`test_revoking_one_family_leaves_another_family_alone`、`test_refresh_endpoint_invalidates_the_old_token`——多數不是乾淨的斷言失敗，而是重複換發同一張已用票時撞上 `uq_refresh_sessions_one_live_per_family` 的 `IntegrityError`（同一 family 被發出兩張活票） |
| 2 | `_revoke_family` 的 where 從 `family_id ==` 改成 `jti ==` | `test_reusing_a_spent_token_revokes_the_whole_family` | ✅ **已驗證**（Task 4）2 failed / 482 passed：預測的那條，加上 `test_reuse_detection_persists_the_revocation`。乾淨的斷言失敗（`revoked_at is None`） |
| 3b | `rotate_session` 拿掉 `await _lock_user_sessions(...)` | `tests/test_sessions_concurrency.py` | ✅ **已驗證（第三輪，確定性版本）**。第一版 `test_sessions_concurrency.py` 靠 `asyncio.gather` 讓兩個真實連線自然競速，在某台機器（Windows + Docker Desktop）上跑了 25 次全部通過、一次都沒變紅——規格 §6 規矩 1：「沒被觀察到失敗的守衛不算數」，那個版本從沒被真的突變觀察過，等於沒有守衛，被品質審查擋下。改成手動、確定性地建構規格 §3.2 描述的交錯：「干擾側」手寫 UPDATE 舊列 + INSERT 新列 C、卡在 commit 之前，輪詢 `pg_stat_activity` 確認 replay 側真的卡進 `wait_event_type = 'Lock'`（不管是卡在 advisory lock 還是卡在 `_revoke_family` 想鎖被干擾側佔住的列）才放行 commit；replay 側呼叫真正的 `rotate_session`。**有鎖：連跑 10 次全綠。拿掉鎖：連跑 10 次全紅，每次都是乾淨的 `assert 1 == 0`（活票數）。** 兩個方向都是 10/10 確定性重現，不是機率性的。這條測試手寫了 `rotate_session` 內部「先 UPDATE 舊列、再 INSERT 新列」的操作順序，跟實作順序有耦合——如果那個順序改變，這條測試可能要跟著調整，這是刻意的取捨，換來的是確定性 |
| 3 | `_reject` 拿掉 `await db.commit()` | `test_reuse_detection_persists_the_revocation` | ✅ **已驗證**（Task 4，修過測試後複跑）1 failed / 483 passed，就是預測的那一條，沒有波及其他測試，乾淨的 `assert False`（`all(value is not None for value in revoked_at_values)`）。**修法之前**這條測試雖然也會變紅，但失敗形態是 `sqlalchemy.exc.MissingGreenlet`——rollback 後讀 `user.id` 這個過期的 ORM 屬性觸發同步 refresh 查詢在 async 環境炸掉，跟撤銷有沒有持久化無關，是偶然的守衛（見本計畫開頭「用了 rollback 就不能再讀 ORM 屬性」一節）。改成 rollback 前先存 `user_id`、查詢選欄位而非實體之後，才是真正在守這個性質的乾淨斷言 |
| 4 | `revoke_session` 改成直接 `return`（什麼都不做） | `test_logout_kills_the_refresh_token` | ✅ **已驗證**（Task 5）該條 + `test_logout_kills_the_whole_family_not_just_the_last_token` 一起變紅 |
| 4b | `revoke_session` 拿掉 `await _lock_user_sessions(...)` | `test_logout_revokes_the_family_even_under_concurrent_rotation` | ✅ **已驗證**（Task 5）**補這條測試之前完整套件 496 全綠** —— 那把鎖原本是沒有守衛的守衛。補完之後：有鎖 10/10 綠、沒鎖 10/10 紅，乾淨的 `assert 1 == 0` |
| 5 | `revoke_all_for_user` 的 where 拿掉 `user_id ==` | `test_logout_all_does_not_touch_another_users_sessions` | ✅ **已驗證**（Task 5）`401 == 200` 的乾淨斷言失敗 |
| 5b | `revoke_session` 只撤銷被出示的那一列，不撤整個 family | `test_logout_revokes_the_whole_family` | ✅ **已驗證**（Task 5）乾淨斷言失敗。**補這條模組層測試之前，9 條登出端點測試全綠** —— 端點層在定義上分不出來，見 Step 5a |
| 5c | `revoke_session` 拿掉 `await db.commit()` | `test_logout_persists_the_revocation` | ✅ **已驗證**（Task 5）乾淨斷言失敗，其餘 27 條全綠（特異性正確）。**補這條之前 9 條登出測試全綠** |
| 5d | `_revoke_family` 的 where 拿掉 `revoked_at.is_(None)` | `test_logout_is_idempotent`（強化後） | ✅ **已驗證**（Task 5）乾淨斷言失敗。**強化那條測試之前，33 條測試全綠** —— 冪等性「第二次呼叫不會破壞東西」那一半原本沒有守衛，`revoked_at` 會被覆寫，鑑識資訊（family 是什麼時候死的）會消失 |
| 6 | `start_session` 改成共用一個固定的 `family_id` | `test_two_logins_start_two_separate_families` 與 `test_logout_only_affects_the_device_that_logged_out` | 待填 |
| 7 | `decode_refresh_token` 的 `require` 拿掉 `"jti"` | `test_refresh_token_without_jti_is_rejected` | ✅ **已驗證**（Task 2）1 failed，拋的是未接住的 `KeyError: 'jti'` 而非 `TokenError`。**收窄 `except` 之前這個突變是存活的**（套件全綠） |
| 8 | `cleanup_expired_sessions` 的 where 改成 `revoked_at.is_not(None)` | `test_cleanup_removes_revoked_sessions_only_after_they_expire` | ✅ **已驗證**（Task 6）**4 failed** / 499 passed —— 該欄位同時影響 dry_run 與真刪兩條 where，所以四條清理測試一起變紅 |
| 8b | 拿掉 `dry_run` 分支（讓 dry run 也真的刪） | `test_cleanup_dry_run_deletes_nothing` | ✅ **已驗證**（Task 6）1 failed / 502 passed，乾淨的 `assert 0 == 1`，特異性正確 |
| 8c | `cleanup_expired_sessions` 拿掉 `await db.commit()` | `test_cleanup_persists_the_deletion` | ✅ **已驗證**（Task 6）**補這條測試之前 502 全綠** —— 這是同一個夾具盲點在這份計畫裡的第三次（Task 3、Task 5、Task 6）。補完之後 1 failed / 502 passed |
| 9 | 部分唯一索引從 **model 與 migration 同時**拿掉 | `test_a_family_cannot_have_two_live_tokens` | ✅ **已驗證**（Task 1）`DID NOT RAISE IntegrityError`，1 failed / 5 passed；同時 `alembic check` 乾淨 |
| 10 | `CheckConstraint` 從 **model 與 migration 同時**拿掉 | `test_expires_at_must_be_after_issued_at` | ✅ **已驗證**（Task 1）`DID NOT RAISE IntegrityError`，1 failed / 5 passed；同時 `alembic check` 乾淨 |
| 11 | `create_refresh_token` 忽略傳入的 `jti`，改簽 `uuid.uuid4()` | `test_refresh_token_round_trip_carries_the_jti` | ✅ **已驗證**（Task 2 品質審查）唯一變紅的測試。這個突變在正式環境的後果是資料列與票上的 jti 不一致，**每一次換發都 401** |
| 13 | `start_session` 的 `await db.commit()` 刪掉，或弱化成 `flush()` | `test_start_session_commits_the_row` | ✅ **已驗證**（Task 3，兩種突變各跑一次，主 session 又獨立複跑一次刪除版）1 failed / 476 passed，乾淨的斷言失敗。**加這條測試之前兩種突變都存活**（476 全綠） |
| 14 | `start_session` 改用固定的 `family_id` | `test_two_logins_start_two_separate_families` | ✅ **已驗證**（Task 3）1 failed / 475 passed，但**是 `IntegrityError` 不是斷言失敗** —— Task 1 的部分唯一索引先擋住了。斷言本身仍有鑑別力（索引若被拿掉，`FIXED != FIXED` 會失敗），但今天跑不到那一行 |
| 15 | `login()` 繞過 `start_session`，改回自己簽票 | `test_login_endpoint_creates_a_session_row` | ✅ **已驗證**（Task 3）1 failed / 475 passed，乾淨的斷言失敗。既有的 `test_auth_login.py` 一個都沒紅 —— 它只驗「票能解碼」 |
| 12 | `_user_id_from` 的 type 比對改成 `if False:` | 見右 | ✅ **已驗證**（Task 2）**3 failed** / 470 passed：`test_refresh_token_is_rejected_where_an_access_token_is_expected`、`test_a_token_typed_access_but_carrying_a_jti_is_still_rejected_as_refresh`、`test_auth_me.py::test_me_rejects_a_refresh_token` |

### 跑突變時的一條規矩（Task 2 踩到）

**突變一定要跑完整套件，不可以只跑「被改動的那個模組的測試檔」。**

Task 2 的突變 12，只跑 `tests/test_tokens.py` 得到 2 個紅燈，跑完整套件得到
3 個 —— 第三個在 `tests/test_auth_me.py`。

為什麼這件事重要：突變的目的是回答「哪些測試真的在守這一行」。把範圍限縮在
被改動的模組，等於預設「守衛都住在隔壁」—— 而端點層的測試往往才是真正
在守某個安全性質的東西（`test_me_rejects_a_refresh_token` 守的是
「長效票不能拿來存取 API」，那比單元測試更接近真正的攻擊面）。

漏掉它的後果不只是數字少一個：會誤以為某個方向沒有守衛而去補一條多餘的
測試，或者更糟 —— 誤以為某個守衛存在。

**第 9、10 條已在 Task 1 當場跑完**（那三條測試在約束已存在的情況下寫成，
直接就是綠的，所以紅燈只能用突變取得）。兩次的 `alembic check` 都是
`No new upgrade operations detected.` —— 這是這兩筆結果最重要的部分：
它證明漂移檢查對「兩邊一起刪」完全沒有鑑別力，那三條測試是唯一的守衛。

> 第 9、10 條要「**兩邊同時**拿掉」才是有效的突變。只拿掉一邊的話 `alembic check`
> 會先紅，那證明的是漂移檢查有效，**不是**那個約束有守衛。兩邊一起拿掉時
> `alembic check` 是乾淨的 —— 那時還會變紅的東西，才是真正的守衛。

> **突變存活時先問「這一行真的是唯一實現該保證的地方嗎」，再問「測試夠不夠力」**（§6 規矩 5）。例如突變 1 若存活，要先確認是不是 `_reject` 那條路徑也把它擋住了 —— 那樣的話兩道防線互相掩護，該處理的是設計不是測試。

- [ ] **Step 2: 更新部署手冊**

Modify `docs/deployment.md`，在部署步驟之後加一節：

````markdown
## 升級到含 session 撤銷的版本：所有人要重新登入一次

這個版本的 refresh token 多了一個 `jti` 欄位，並對應到資料庫裡的一列。
**升級前發出的 refresh token 全部沒有 `jti`，會被拒絕。**

後果：升級後所有裝置都要重新登入一次。這是一次性的、刻意的 ——
相容期間等於舊的缺陷還開著，而那段相容邏輯忘記拿掉就是一個永久的後門。

先知道這件事，否則它會表現成「升級後神秘的全員登出」，
而那種症狀沒人會聯想到這次變更。

### 定期清理過期的 session 紀錄

跟 `cleanup-photos` 一樣**必須在容器內執行**：

```bash
docker compose exec api python -m app.cli cleanup-sessions
```

建議的 cron（每天一次即可，過期的列不會造成任何功能問題，只是佔空間）：

```
30 4 * * * cd /volume1/docker/nutrition-tracker && docker compose exec -T api python -m app.cli cleanup-sessions
```
````

- [ ] **Step 3: 更新交接文件**

Modify `docs/handover.md` §8.1 —— 把「需要優先處理」整段換成：

```markdown
### 8.1 已完成

**session 撤銷。** refresh token 改為輪替制：換發時舊票當場失效，
舊票被重複使用一律判定外洩並撤銷整條 family。
新增 `POST /api/auth/logout`（單裝置）與 `/logout-all`（全部裝置）。

刻意留著的缺口：access token 不查資料庫，所以撤銷之後該裝置手上那張
最多還能再用 15 分鐘 —— 有一條測試明確斷言這個缺口存在，
避免日後有人「順手修好」它而沒發現效能代價。

規格：[session 撤銷設計](superpowers/specs/2026-09-11-session-revocation-design.md)
```

同時把 §10「前端需要知道的 API 事實」裡那句「**注意舊 refresh token 不會失效**（見 §8.1）」改成：

```markdown
**舊的 refresh token 在換發時會立刻失效**，而且重複使用會撤銷整條鏈 ——
前端必須保證同一時間只有一個 refresh 在飛（P3-A 規格 §6.4 的 single-flight 鎖），
否則兩個分頁同時換票會讓使用者莫名被登出。
```

- [ ] **Step 4: 最終驗證**

```bash
.venv/Scripts/python.exe -m pytest -W error
.venv/Scripts/ruff.exe check .
.venv/Scripts/python.exe -m mypy app
DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test" \
  .venv/Scripts/python.exe -m alembic check
```

Expected：497 passed、All checks passed、Success、`No new upgrade operations detected.`

覆蓋率不得低於現況：

```bash
.venv/Scripts/python.exe -m pytest --cov=app --cov-report=term-missing --cov-fail-under=80
```

- [ ] **Step 5: Commit 並開 PR**

```bash
git add docs/
git commit -m "docs: session 撤銷的上線備註與突變驗證結果

升級後所有人要重新登入一次（舊 token 沒有 jti），寫進部署手冊 ——
否則它會表現成「升級後神秘的全員登出」。"
```

---

## 完成標準（對照規格 §8）

- [ ] `refresh_sessions` 表 + migration `0007`，`alembic check` 乾淨
- [ ] 輪替：換發後舊票 401
- [ ] 重用偵測：**三層鏈**驗證 family 一起撤銷，且撤銷真的寫進資料庫
- [ ] `logout` / `logout-all`，含跨裝置與跨使用者隔離測試
- [ ] 規格 §4 那個 15 分鐘缺口有明確斷言它存在的測試
- [ ] 缺 `jti` 的 token 被拒
- [ ] `cleanup-sessions` 指令 + 部署手冊的 cron 與**全員重新登入**的上線備註
- [ ] 上表 8 個突變全部實際跑過，結果寫回這份文件
- [ ] `pytest -W error` 全綠、ruff、mypy strict、覆蓋率不低於現況
