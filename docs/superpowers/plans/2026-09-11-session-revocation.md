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
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: FAIL — `ModuleNotFoundError: No module named 'app.models.session'`

- [ ] **Step 3: 寫模型**

Create `app/models/session.py`:

```python
import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index
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
        # 撤銷整個 family 時走這個索引。
        Index("ix_refresh_sessions_family_id", "family_id"),
        # logout-all：撈某個使用者所有還沒撤銷的列。
        Index("ix_refresh_sessions_user_id_revoked_at", "user_id", "revoked_at"),
        # cleanup-sessions：刪掉過期的列。
        Index("ix_refresh_sessions_expires_at", "expires_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    jti: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, nullable=False)
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 只給 cleanup-sessions 用。**過期判斷本身由 JWT 的 exp 負責**，
    # 這個欄位刻意不參與換發時的條件判斷 —— 理由見 Task 4 Step 3 的註解。
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
    )
    op.create_index("ix_refresh_sessions_family_id", "refresh_sessions", ["family_id"])
    op.create_index(
        "ix_refresh_sessions_user_id_revoked_at",
        "refresh_sessions",
        ["user_id", "revoked_at"],
    )
    op.create_index("ix_refresh_sessions_expires_at", "refresh_sessions", ["expires_at"])


def downgrade() -> None:
    op.drop_table("refresh_sessions")
```

- [ ] **Step 6: 跑測試確認通過，漂移檢查同時也通過**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: 3 passed

conftest 的 `migrated_database` fixture 會先砍掉重建測試資料庫、跑 `alembic upgrade head`、再跑 `alembic check`。這三步任何一步失敗都會在這裡炸出來，所以這一次通過同時就是漂移檢查通過，不需要另外下指令。

- [ ] **Step 7: 跑完整套件**

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 466 passed（463 + 3）

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
    token = create_access_token(user_id=1)
    with pytest.raises(TokenError):
        decode_refresh_token(token)


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
from typing import Any

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


def _user_id_from(payload: dict[str, Any], *, expected_type: str) -> int:
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
    try:
        jti = uuid.UUID(str(payload["jti"]))
    except (KeyError, ValueError, AttributeError) as exc:
        raise TokenError("token payload 格式不正確") from exc
    return RefreshClaims(user_id=user_id, jti=jti)
```

- [ ] **Step 4: 跑 tokens 的測試確認通過**

Run: `.venv/Scripts/python.exe -m pytest tests/test_tokens.py -v`

Expected: 14 passed

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

`tests/test_auth_refresh.py` 四個測試全部改用 `create_refresh_token(..., uuid4())` 與 `decode_access_token(...)`。**其中兩個現在會失敗** —— `test_refresh_returns_a_new_access_token` 與 `test_refresh_rejects_a_token_for_a_deleted_user` 都需要資料列存在才會通過，而資料列要到 Task 3 才有。這一步先標記：

```python
@pytest.mark.xfail(reason="Task 3 接上 refresh_sessions 之後才會通過", strict=True)
```

> **`strict=True` 是重點。** 非 strict 的 xfail 在測試意外通過時仍然是綠的，那會讓「Task 3 忘記拿掉標記」變成一個沒有任何東西會發現的錯誤。strict 之下，測試一旦通過就變 XPASS 紅燈，逼你回來拿掉。

- [ ] **Step 7: 跑完整套件與靜態檢查**

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 467 passed, 2 xfailed（466 + test_tokens.py 新增的 3 個，再減掉轉成 xfail 的 2 個）

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
- Modify: `tests/test_auth_refresh.py`（拿掉 Task 2 的 xfail）
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


def _add_row(db: AsyncSession, *, user_id: int, family_id: uuid.UUID) -> uuid.UUID:
    jti = uuid.uuid4()
    now = datetime.now(UTC)
    db.add(
        RefreshSession(
            user_id=user_id,
            jti=jti,
            family_id=family_id,
            issued_at=now,
            # 這個值只給 cleanup-sessions 用。過期判斷本身由 JWT 的 exp 負責，
            # 所以這裡跟 token 的 exp 之間幾微秒的差距沒有任何影響。
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    return jti


def _tokens_for(user_id: int, jti: uuid.UUID) -> IssuedTokens:
    return IssuedTokens(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id, jti),
    )


async def start_session(db: AsyncSession, user_id: int) -> IssuedTokens:
    """登入：開一條全新的 family。

    每次登入都是獨立的一條鏈，所以在手機上登出不會動到桌機 —— 那是規格 §1
    整個要解決的問題（今天唯一的止血手段是換 JWT_SECRET，會把所有人一起登出）。
    """
    jti = _add_row(db, user_id=user_id, family_id=uuid.uuid4())
    await db.commit()
    return _tokens_for(user_id, jti)
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

- [ ] **Step 5: 拿掉 `test_auth_refresh.py` 裡那個現在會過的 xfail**

`test_refresh_rejects_a_token_for_a_deleted_user` 現在仍然失敗（Task 4 才會過），**保留它的 xfail**。

`test_refresh_returns_a_new_access_token` 也還沒過 —— `refresh()` 目前仍是 Task 2 那個「自己簽一張新票」的版本，它會通過但不寫資料列。**兩個 xfail 都留到 Task 4。**

> 這一步刻意什麼都不做，但要親自跑一次確認 xfail 狀態沒變。`strict=True` 的 xfail 在意外通過時會變成 XPASS 紅燈，那正是我們要它做的事。

- [ ] **Step 6: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_sessions.py -v`

Expected: 6 passed（Task 1 的 3 個 + 這裡的 3 個）

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 470 passed, 2 xfailed

- [ ] **Step 7: Commit**

```bash
git add app/security/sessions.py app/api/routes/auth.py tests/test_sessions.py
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
- Modify: `tests/test_auth_refresh.py`（拿掉兩個 xfail）
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
    a = await start_session(db_session, user.id)
    b = await rotate_session(db_session, a.refresh_token)

    with pytest.raises(ReuseDetectedError):
        await rotate_session(db_session, a.refresh_token)

    rows = (
        await db_session.scalars(
            select(RefreshSession).where(RefreshSession.user_id == user.id)
        )
    ).all()
    assert len(rows) == 2
    assert all(row.revoked_at is not None for row in rows)


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
    claims = decode_refresh_token(refresh_token)

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
    jti = _add_row(db, user_id=user_id, family_id=family_id)
    await db.commit()
    return _tokens_for(user_id, jti)
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

- [ ] **Step 5: 拿掉兩個 xfail**

Modify `tests/test_auth_refresh.py`：刪掉 Task 2 加的兩個 `@pytest.mark.xfail(...)` 裝飾器與不再需要的 `import pytest`。

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

Expected: 12 passed + 5 passed，**0 xfailed**（兩個標記都拿掉了）

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 479 passed（兩個 xfail 轉為正常通過）

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
from uuid import uuid4

from app.security.tokens import create_access_token, create_refresh_token
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

Append to `app/security/sessions.py`:

```python
async def revoke_session(db: AsyncSession, refresh_token: str) -> None:
    """登出單一裝置：撤銷這張票所屬的整條 family。

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

    await _revoke_family(db, row.family_id)
    await db.commit()


async def revoke_all_for_user(db: AsyncSession, user_id: int) -> None:
    """登出所有裝置。`user_id` 來自已驗證的 access token，不是使用者輸入。"""
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

- [ ] **Step 6: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_auth_logout.py -v`

Expected: 9 passed

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 488 passed

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
    """刪掉 expires_at 已過的 refresh session 列，回傳筆數。

    **只看 expires_at，不看 revoked_at。** 一列已撤銷但還沒過期的紀錄，
    正是「這張票已經死了、而且是這樣死的」的唯一證據：提早刪掉的話，
    rotate_session 查不到列，走的是「找不到」那條路 —— 回應同樣是 401，
    測試同樣是綠的，但重用偵測的證據沒了，真正的攻擊會被降級成一次
    普通的失敗。過期之後才刪，那時 JWT 的 exp 已經自己擋住了。
    """
    stmt = select(RefreshSession).where(RefreshSession.expires_at < datetime.now(UTC))
    rows = (await db.scalars(stmt)).all()

    if dry_run:
        return len(rows)

    for row in rows:
        await db.delete(row)
    await db.commit()
    return len(rows)
```

頂端 import 補上 `from app.models.session import RefreshSession`。

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

- [ ] **Step 4: 跑測試**

Run: `.venv/Scripts/python.exe -m pytest tests/test_cli.py -v`

Expected: 既有測試 + 4 passed

Run: `.venv/Scripts/python.exe -m pytest -W error`

Expected: 492 passed

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
| 1 | `rotate_session` 的 UPDATE 拿掉 `used_at.is_(None)` | `test_the_old_token_stops_working_after_rotation` | 待填 |
| 2 | `_revoke_family` 的 where 從 `family_id ==` 改成 `jti ==` | `test_reusing_a_spent_token_revokes_the_whole_family` | 待填 |
| 3 | `_reject` 拿掉 `await db.commit()` | `test_reuse_detection_persists_the_revocation` | 待填 |
| 4 | `revoke_session` 改成直接 `return`（什麼都不做） | `test_logout_kills_the_refresh_token` | 待填 |
| 5 | `revoke_all_for_user` 的 where 拿掉 `user_id ==` | `test_logout_all_does_not_touch_another_users_sessions` | 待填 |
| 6 | `start_session` 改成共用一個固定的 `family_id` | `test_two_logins_start_two_separate_families` 與 `test_logout_only_affects_the_device_that_logged_out` | 待填 |
| 7 | `decode_refresh_token` 的 `require` 拿掉 `"jti"` | `test_refresh_token_without_jti_is_rejected` | 待填 |
| 8 | `cleanup_expired_sessions` 的 where 改成 `revoked_at.is_not(None)` | `test_cleanup_removes_revoked_sessions_only_after_they_expire` | 待填 |

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

Expected：492 passed、All checks passed、Success、`No new upgrade operations detected.`

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
