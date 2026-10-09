# 按讚、留言、通知 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 好友的餐可以按讚、留言；每一餐有自己的頁面（`/meals/:id`）；有人對你的餐按讚或留言、送好友邀請或接受邀請時，「我的」的分頁上有未讀數字、`/notifications` 看得到是誰。

**Architecture:** 三張新表（`meal_likes`、`meal_comments`、`notifications`，migration `0018`）。「看不看得到一餐」「一則讚或留言還算不算數」全部寫在新的 `app/social_visibility.py`——解除好友不刪資料，讀的時候用 `EXISTS friendships` 過濾。端點全部是新的（`/api/social/...`、`/api/notifications...`），`/api/meals` 仍然只回自己的餐，只多兩個數字。主人與好友看同一餐走同一個白名單序列化（`FriendMeal`，搬到 `app/friend_meals.py`）。讚用 `INSERT … ON CONFLICT DO NOTHING`，通知跟讚／留言在同一個交易寫。前端的社群 query 都在 `["social", …]` 底下、不進 localStorage；讚是樂觀更新＋一次一個請求；未讀數由 `LoggedInShell` 輪詢後當 prop 傳給 `TabBar`／`SideNav`。

**Tech Stack:** FastAPI · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · React 19 · TypeScript strict · TanStack Query v5 · react-router · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-10-social-interactions-design.md`（以下稱「規格」；D1…D22 指它的 §2）

---

## 執行環境

- 分支 `feat/social-interactions`（已建立，**不要 push**）。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q -W error`（整套約 2 分 50 秒，timeout 給 10 分鐘；**同一時間只跑一個 pytest**——測試資料庫每次砍掉重建）。需要 dev 的 Postgres：`docker compose up -d`（專案 `wallet`，`localhost:5433`）。**絕對不要跑 `down -v`。**
  - `./.venv/Scripts/python.exe -m ruff check .`、`./.venv/Scripts/python.exe -m mypy app`。**不要跑 `ruff format`**（handover §7）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式用 `npx biome check --write <檔案>`）。驗證時一起 grep `FAIL` 與 `Unhandled`。**typecheck 在每次 commit 之前單獨跑一次，跟 `git commit` 用 `&&` 串，不要用 `;`。**
- e2e：先 `docker compose up -d --build api`（migration 烤在映像裡，handover §7），再在 `frontend/` 跑 `npx playwright test …`。
- 基準線（`8cb9122`，handover §2）：後端 **1227**；前端 `Test Files 142`、`Tests 1817`（vitest 印出來的數字）；e2e **47**；端點 **79**；資料表 16。開工前自己再量一次，對不上照實記下來。
- **`schema.d.ts` 重新產生**——動到 `app/api/routes` 或 `app/schemas` 的每一個 commit（docstring 也算）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

  產生之後跑 `cd frontend && npm run -s typecheck`：新的**必填**回應欄位會讓有型別標註的測試資料變紅（各 task 寫了是哪幾處）。
- **突變**：改一行、看到指定的測試紅、改回、重跑看到綠。`.py` 改回之後 `touch` 那個檔案（`.pyc` 的 mtime）。**還沒 commit 的新檔案 `git checkout --` 救不回來**：突變前先複製一份到 scratchpad（`cp app/x.py "$S/social-plan-x.py.bak"`），改回之後 `diff` 確認。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/social-plan-<task>-msg.txt`（每次用不同的檔名），最後一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`git add .`）。不要 amend。
- **看不見的字元**：Write／Edit 工具會把「反斜線 u＋四位十六進位」解成真的字元（handover §7）。這份計畫的測試一律寫 `chr(0x202E)`（Python）或 `String.fromCodePoint(0x202e)`（TS），不寫跳脫字元。每個 task commit 前跑一次：

  ```bash
  git diff --cached --name-only | ./.venv/Scripts/python.exe -c "import sys,unicodedata as u; [print(p.strip(), i+1, hex(ord(c))) for p in sys.stdin for i,l in enumerate(open(p.strip(),encoding='utf-8')) for c in l if u.category(c) in ('Cf','Zl','Zp') and ord(c)!=0x200D]"
  ```

  Expected：沒有輸出。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。新模組還不存在時紅的是 import，不是斷言——斷言有沒有咬合力由每個 task 的突變步驟證明（handover §6 規矩 1、8）。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. **要測 A 過濾器，測試資料必須讓 B 過濾器無效**（規矩 2）。這個功能有三道會互相遮住的過濾：「看不看得到餐」「作者還算不算數」「是不是私人」。每條測試的 docstring 寫明它讓哪兩道無效。
4. **「看不到」的測試一律先在同一條測試裡看得到一次**（先 200、解除、再 404）。只斷言 404 的測試，路徑打錯也會綠。
5. **不外流的測試用真的有餐費、備註的餐**；斷言「回應裡沒有這個字串」之前，先斷言同一個回應裡有描述（第 5 種：兩個都要有）。
6. `client` 夾具跟測試共用一個 session（handover §6 第 14 種）：看不見兩個交易互相等。並行按讚那一條用獨立的 session（照抄 `tests/test_invites_concurrency.py` 的 `independent_sessions`），資料真的 commit、`finally` 自己清。
7. 共用 session 裡 `rollback()` 之後 ORM 物件會過期（`MissingGreenlet`）。要測「資料庫擋下來」用 `async with db_session.begin_nested():` 包住 raw SQL，id 先存成整數。
8. `tests/helpers/mock-api.ts` 用 `url.includes(path)` **依序**比對：`/api/social/meals/5` 不會被 `/api/meals` 吃掉（這是 D6 的理由之一），但 `/api/social/meals/5/like` 會被 `/api/social/meals/5` 吃掉——越具體的排越前面。沒準備的路徑會 `throw`（query 變成 error，不會讓測試直接紅）——所以**斷言「沒有發出某個請求」要看 `spy.mock.calls`，不能靠它 throw**。
9. `TabBar`／`SideNav` 的既有測試**沒有 `QueryClientProvider`**：這兩個元件不准呼叫任何 query hook（未讀數是 prop，預設 0）。
10. Playwright 的名稱預設是子字串比對：一律 `exact: true`。可及名稱帶時間的元素不要用時間去對（Chromium 是 en-US）。登入之後**只用點擊換頁**，不要 `page.goto`。一個使用者一個 context。
11. 離線快取裡的舊餐沒有新欄位（`undefined`，不是 `null`）：畫面一律 `?? 0`（handover §7）。
12. `app/schemas/*.py`、`app/models/*.py`、`routes/meals.py` 的**註解**不要出現 `social_visibility`、`load_visible_meal`、`meal_visible_to`、`build_friend_meals`、`friend_meals` 這幾個字——Task 2 的掃描測試是掃文字的。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**在 worktree 裡整份跑過。「Expected: PASS」的條數是照測試清單數的，不是量的；對不上照實回報。只有下面三件不確定的事做了小實驗：

| 實驗 | 結果 |
|---|---|
| Task 1 的三個模型＋Task 2 的 `social_visibility.py` 整份，對 `wallet_test` 在一個 rollback 掉的交易裡建表、塞五個人（主人、兩個好友、陌生人、邀請中）跑過 | 可見性表格、`FOR SHARE OF meals`、`ON CONFLICT DO NOTHING … RETURNING`（衝突時回 `None`）、部分唯一索引擋第二則讚的通知、解除後數字與通知立刻少掉、刪餐 cascade、三條 CHECK——全部如預期。**`ON CONFLICT` 也會吃掉一個 identity 值**（id 會跳號，不要斷言 id 連續） |
| `type` 的 CHECK | 寫了 `type IN (…)` 也永遠看不到它：四種以外的值先被 `shape_matches_type` 擋。所以只留一條（規格 §3.3） |
| jsdom 裡 `aria-hidden` 的標記不進連結名稱；`aria-describedby` 指到連結外面的元素；按鈕 `aria-pressed`＋`aria-describedby` 指到自己裡面的元素 | `getByRole("link", { name: "我的" })`、`toHaveAccessibleDescription("12 則新通知")`、`getByRole("button", { name: "讚，鮑伯的午餐", pressed: true })` 都對 |

## 與規格的差異

（執行時發現的寫在這裡。）

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `app/models/social.py`（新）、`app/models/__init__.py` | 1 | `MealLike`、`MealComment`、`Notification`、`NotificationType` |
| `migrations/versions/0018_create_social_tables.py`（新） | 1 | 三張表 |
| `tests/factories.py`、`tests/test_social_model.py`（新） | 1 | `create_like`、`create_comment`；約束與 cascade |
| `app/social_visibility.py`（新） | 2、5 | 可見性、作者過濾、數字、通知的過濾 |
| `app/friend_meals.py`（新） | 2 | `build_friend_meals`（從 `routes/friends.py` 搬來，多三個數字） |
| `app/schemas/social.py`（新）、`app/schemas/friend.py` | 2–5 | 回應與請求的形狀；`FriendMeal` 多三個欄位 |
| `app/api/routes/social.py`（新）、`app/main.py` | 2–4 | `/api/social/meals/...` 五個端點 |
| `app/api/routes/friends.py` | 2、6 | 改用 `build_friend_meals`；邀請與接受寫通知 |
| `app/ratelimit.py`、`tests/conftest.py` | 3、4 | `like_rate_limiter`、`comment_rate_limiter` 與重置 |
| `app/api/routes/meals.py`、`app/schemas/meal.py` | 3 | `MealResponse` 多兩個數字 |
| `app/notifications.py`（新） | 5、6 | 寫通知的三個函式 |
| `app/api/routes/notifications.py`（新） | 5 | `/api/notifications` 三個端點 |
| `tests/social_helpers.py`、`test_social_meal.py`、`test_social_likes.py`、`test_social_likes_concurrency.py`、`test_social_comments.py`、`test_notifications.py`（新）、`tests/test_friend_meals.py`、`tests/test_friend_requests.py` | 2–6 | |
| `frontend/src/api/schema.d.ts` | 2–6 | 每個後端 task 重新產生 |
| `frontend/src/api/{social,notifications}.ts`（新）、`queries.ts`、`persist.ts` | 7 | API 層 |
| `frontend/src/components/LikeButton.tsx`（新）、`FriendMealCard.tsx`、`screens/MealList.tsx`、`ui.module.css` | 8 | |
| `frontend/src/screens/MealDetail.tsx`、`components/{CommentForm,CommentList}.tsx`（新）、`App.tsx` | 9 | |
| `frontend/src/screens/Notifications.tsx`、`components/NotificationsCard.tsx`（新）、`TabBar.tsx`、`SideNav.tsx`、`Me.tsx`、`App.tsx` | 10 | |
| `frontend/e2e/social.spec.ts`（新） | 11 | |
| `docs/handover.md`、`docs/deployment.md`、規格的狀態 | 12 | |

---

## Task 1：後端——migration `0018` 與模型

**Files:**
- Create: `app/models/social.py`、`migrations/versions/0018_create_social_tables.py`、`tests/test_social_model.py`
- Modify: `app/models/__init__.py`、`tests/factories.py`

- [ ] **Step 1：模型。** `app/models/social.py`：

```python
"""按讚、留言、通知（社群規格 §3）。三張表都只被社群的模組讀寫；
「誰看得到」不在這裡——在讀取的那一層。"""

import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MealLike(Base):
    """一個人對一餐的讚。唯一約束同時是「這一餐的讚」的索引。

    「主人不能讚自己」不在這裡擋（要跨表）：端點擋，而且計數只算主人現在的好友。"""

    __tablename__ = "meal_likes"
    __table_args__ = (UniqueConstraint("meal_id", "user_id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MealComment(Base):
    __tablename__ = "meal_comments"
    __table_args__ = (
        # 長度在 schema 擋一次、這裡再擋一次：繞過 API 寫進來的也不會超過。
        CheckConstraint("char_length(body) BETWEEN 1 AND 200", name="body_length"),
        Index("ix_meal_comments_meal_id_id", "meal_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class NotificationType(enum.StrEnum):
    LIKE = "like"
    COMMENT = "comment"
    FRIEND_REQUEST = "friend_request"
    FRIEND_ACCEPTED = "friend_accepted"


class Notification(Base):
    """`id` 也是排序的依據：`created_at` 是交易開始的時間，同一個交易裡會相同。"""

    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint("user_id <> actor_id", name="not_self"),
        # 這一條同時是 `type` 的手寫約束（handover §7：create_constraint=False 的另一半）：
        # 四種以外的值三個分支都不成立。
        CheckConstraint(
            "(type = 'like' AND meal_id IS NOT NULL AND comment_id IS NULL)"
            " OR (type = 'comment' AND meal_id IS NOT NULL AND comment_id IS NOT NULL)"
            " OR (type IN ('friend_request', 'friend_accepted')"
            " AND meal_id IS NULL AND comment_id IS NULL)",
            name="shape_matches_type",
        ),
        # 同一個人對同一餐的讚只通知一次（規格 D12）。
        Index(
            "uq_notifications_like",
            "user_id",
            "actor_id",
            "meal_id",
            unique=True,
            postgresql_where=text("type = 'like'"),
        ),
        Index("ix_notifications_user_id_id", "user_id", "id"),
        Index("ix_notifications_unread", "user_id", postgresql_where=text("read_at IS NULL")),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[NotificationType] = mapped_column(
        Enum(
            NotificationType,
            name="notification_type",
            native_enum=False,
            create_constraint=False,
            length=16,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    meal_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=True
    )
    comment_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meal_comments.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

`app/models/__init__.py`：加 `from app.models.social import MealComment, MealLike, Notification, NotificationType`，四個名字照字母順序放進 `__all__`。

- [ ] **Step 2：migration。** `migrations/versions/0018_create_social_tables.py`（格式照 `0013`、`0016`）：

```python
"""create social tables

Revision ID: 0018
Revises: 0017
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _id() -> sa.Column:
    return sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False)


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )


def _fk(table: str, column: str, target: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=f"fk_{table}_{column}_{target}", ondelete="CASCADE"
    )


def upgrade() -> None:
    # 只有新表：舊版程式不讀不寫它們，所以這一版可以退版，
    # 不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.create_table(
        "meal_likes",
        _id(),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_meal_likes"),
        sa.UniqueConstraint("meal_id", "user_id", name="uq_meal_likes_meal_id_user_id"),
        _fk("meal_likes", "meal_id", "meals"),
        _fk("meal_likes", "user_id", "users"),
    )
    op.create_table(
        "meal_comments",
        _id(),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_meal_comments"),
        _fk("meal_comments", "meal_id", "meals"),
        _fk("meal_comments", "user_id", "users"),
        # name= 是命名慣例的輸入（同 0013）。
        sa.CheckConstraint("char_length(body) BETWEEN 1 AND 200", name="body_length"),
    )
    op.create_index("ix_meal_comments_meal_id_id", "meal_comments", ["meal_id", "id"])
    op.create_table(
        "notifications",
        _id(),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("actor_id", sa.BigInteger, nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "like",
                "comment",
                "friend_request",
                "friend_accepted",
                name="notification_type",
                native_enum=False,
                create_constraint=False,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column("meal_id", sa.BigInteger, nullable=True),
        sa.Column("comment_id", sa.BigInteger, nullable=True),
        _created_at(),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_notifications"),
        _fk("notifications", "user_id", "users"),
        _fk("notifications", "actor_id", "users"),
        _fk("notifications", "meal_id", "meals"),
        _fk("notifications", "comment_id", "meal_comments"),
        sa.CheckConstraint("user_id <> actor_id", name="not_self"),
        sa.CheckConstraint(
            "(type = 'like' AND meal_id IS NOT NULL AND comment_id IS NULL)"
            " OR (type = 'comment' AND meal_id IS NOT NULL AND comment_id IS NOT NULL)"
            " OR (type IN ('friend_request', 'friend_accepted')"
            " AND meal_id IS NULL AND comment_id IS NULL)",
            name="shape_matches_type",
        ),
    )
    op.create_index(
        "uq_notifications_like",
        "notifications",
        ["user_id", "actor_id", "meal_id"],
        unique=True,
        postgresql_where=sa.text("type = 'like'"),
    )
    op.create_index("ix_notifications_user_id_id", "notifications", ["user_id", "id"])
    op.create_index(
        "ix_notifications_unread",
        "notifications",
        ["user_id"],
        postgresql_where=sa.text("read_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("notifications")
    op.drop_table("meal_comments")
    op.drop_table("meal_likes")
```

- [ ] **Step 3：工廠。** `tests/factories.py` 最後加（import `MealComment`、`MealLike`）：

```python
async def create_like(db_session: AsyncSession, *, meal: Meal, user: User) -> MealLike:
    """直接寫一列讚——不經過端點的可見性與「不能讚自己」。"""
    like = MealLike(meal_id=meal.id, user_id=user.id)
    db_session.add(like)
    await db_session.commit()
    await db_session.refresh(like)
    return like


async def create_comment(
    db_session: AsyncSession, *, meal: Meal, user: User, body: str = "看起來好好吃"
) -> MealComment:
    comment = MealComment(meal_id=meal.id, user_id=user.id, body=body)
    db_session.add(comment)
    await db_session.commit()
    await db_session.refresh(comment)
    return comment
```

- [ ] **Step 4：測試。** `tests/test_social_model.py`：

```python
"""社群三張表的資料庫保證（社群規格 §3）。這裡全部直接寫資料庫——端點的規則在別的檔案。"""

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.models.meal import Meal
from app.models.social import MealComment, MealLike, Notification, NotificationType
from app.models.user import User
from tests.factories import create_comment, create_like, create_meal, create_user


@pytest.fixture
async def scene(db_session):
    owner = await create_user(db_session, display_name="主人")
    fan = await create_user(db_session, display_name="粉絲")
    meal = await create_meal(db_session, user=owner)
    return owner, fan, meal


async def _refused(db_session, sql: str, **params) -> str:
    """這個 INSERT 被資料庫擋下來 → 回錯誤訊息（裡面有約束的名字）。
    用 savepoint 包住：共用 session 整個 rollback 的話，之後的物件都會過期。"""
    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(text(sql), params)
    return str(caught.value.orig)


async def _counts(db_session) -> tuple[int, int, int]:
    likes, comments, notes = [
        await db_session.scalar(select(func.count()).select_from(model))
        for model in (MealLike, MealComment, Notification)
    ]
    return likes, comments, notes


_LIKE = "INSERT INTO meal_likes (meal_id, user_id) VALUES (:meal, :user)"
_COMMENT = "INSERT INTO meal_comments (meal_id, user_id, body) VALUES (:meal, :user, :body)"
_NOTE = (
    "INSERT INTO notifications (user_id, actor_id, type, meal_id, comment_id)"
    " VALUES (:to, :by, :type, :meal, :comment)"
)


async def test_one_like_per_person_per_meal(db_session, scene):
    owner, fan, meal = scene
    await create_like(db_session, meal=meal, user=fan)
    other_meal = await create_meal(db_session, user=owner)

    error = await _refused(db_session, _LIKE, meal=meal.id, user=fan.id)

    assert "uq_meal_likes_meal_id_user_id" in error
    # 同一個人對另一餐、另一個人對同一餐都可以：擋的是那一對，不是其中一欄。
    await create_like(db_session, meal=other_meal, user=fan)
    await create_like(db_session, meal=meal, user=owner)


@pytest.mark.parametrize(("length", "ok"), [(0, False), (1, True), (200, True), (201, False)])
async def test_the_database_bounds_a_comments_length(db_session, scene, length, ok):
    owner, fan, meal = scene
    params = {"meal": meal.id, "user": fan.id, "body": "字" * length}
    if ok:
        await db_session.execute(text(_COMMENT), params)
    else:
        assert "ck_meal_comments_body_length" in await _refused(db_session, _COMMENT, **params)


async def test_a_notification_cannot_be_to_yourself(db_session, scene):
    owner, _, _ = scene
    error = await _refused(
        db_session, _NOTE, to=owner.id, by=owner.id, type="friend_accepted", meal=None, comment=None
    )
    assert "ck_notifications_not_self" in error


@pytest.mark.parametrize(
    ("kind", "with_meal", "with_comment"),
    [
        ("like", False, False),
        ("like", True, True),
        ("comment", True, False),
        ("comment", False, True),
        ("friend_request", True, False),
        ("friend_accepted", True, True),
        ("poke", False, False),
        ("poke", True, False),
    ],
)
async def test_a_notifications_shape_must_match_its_type(
    db_session, scene, kind, with_meal, with_comment
):
    owner, fan, meal = scene
    comment = await create_comment(db_session, meal=meal, user=fan)
    error = await _refused(
        db_session,
        _NOTE,
        to=owner.id,
        by=fan.id,
        type=kind,
        meal=meal.id if with_meal else None,
        comment=comment.id if with_comment else None,
    )
    assert "ck_notifications_shape_matches_type" in error


async def test_the_right_shapes_are_accepted(db_session, scene):
    owner, fan, meal = scene
    comment = await create_comment(db_session, meal=meal, user=fan)
    for kind, meal_id, comment_id in [
        ("like", meal.id, None),
        ("comment", meal.id, comment.id),
        ("friend_request", None, None),
        ("friend_accepted", None, None),
    ]:
        await db_session.execute(
            text(_NOTE),
            {"to": owner.id, "by": fan.id, "type": kind, "meal": meal_id, "comment": comment_id},
        )
    assert (await _counts(db_session))[2] == 4


async def test_only_one_like_notification_per_actor_and_meal(db_session, scene):
    owner, fan, meal = scene
    first = await create_comment(db_session, meal=meal, user=fan, body="一")
    second = await create_comment(db_session, meal=meal, user=fan, body="二")
    like = {"to": owner.id, "by": fan.id, "type": "like", "meal": meal.id, "comment": None}
    await db_session.execute(text(_NOTE), like)

    assert "uq_notifications_like" in await _refused(db_session, _NOTE, **like)
    # 部分索引只管讚：同一個人在同一餐的兩則留言各有一則通知。
    for comment in (first, second):
        await db_session.execute(text(_NOTE), {**like, "type": "comment", "comment": comment.id})


async def _fill(db_session, owner, fan, meal) -> MealComment:
    await create_like(db_session, meal=meal, user=fan)
    comment = await create_comment(db_session, meal=meal, user=fan)
    db_session.add_all(
        [
            Notification(
                user_id=owner.id, actor_id=fan.id, type=NotificationType.LIKE, meal_id=meal.id
            ),
            Notification(
                user_id=owner.id,
                actor_id=fan.id,
                type=NotificationType.COMMENT,
                meal_id=meal.id,
                comment_id=comment.id,
            ),
        ]
    )
    await db_session.commit()
    return comment


async def test_deleting_a_meal_takes_everything_on_it_and_nothing_else(db_session, scene):
    owner, fan, meal = scene
    await _fill(db_session, owner, fan, meal)
    kept = await create_meal(db_session, user=owner)
    await _fill(db_session, owner, fan, kept)
    assert await _counts(db_session) == (2, 2, 4)

    await db_session.execute(delete(Meal).where(Meal.id == meal.id))
    await db_session.commit()

    # 另一餐的那一份還在：刪的是「這一餐的」，不是整張表（規矩 3）。
    assert await _counts(db_session) == (1, 1, 2)


async def test_deleting_a_comment_takes_only_its_notification(db_session, scene):
    owner, fan, meal = scene
    comment = await _fill(db_session, owner, fan, meal)

    await db_session.execute(delete(MealComment).where(MealComment.id == comment.id))
    await db_session.commit()

    assert await _counts(db_session) == (1, 0, 1)  # 讚與讚的通知還在


async def test_deleting_a_user_takes_what_they_did(db_session, scene):
    """現在沒有刪帳號的路（規格 §3.5）——這條守的是哪天有了，不會被 FK 擋成 500。"""
    owner, fan, meal = scene
    await _fill(db_session, owner, fan, meal)
    bystander = await create_user(db_session)
    await create_like(db_session, meal=meal, user=bystander)

    await db_session.execute(delete(User).where(User.id == fan.id))
    await db_session.commit()

    assert await _counts(db_session) == (1, 0, 0)
```

- [ ] **Step 5：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_model.py
```

Expected：**19 passed**（1＋4＋1＋8＋1＋1＋3；`conftest.py` 的 `alembic upgrade head`＋`alembic check` 在這一步就會跑——`check` 報漂移就是模型與 migration 對不上，先修那個）。

- [ ] **Step 6：突變（每一個改完跑 Step 5，看到指定的紅，再改回）。** migration 與模型要**一起**改（只改一邊紅的是 `alembic check`，那是另一道防線——規矩 8）。

| 突變（模型＋migration 兩邊） | 該紅的 |
|---|---|
| 拿掉 `meal_likes` 的唯一約束 | `test_one_like_per_person_per_meal` |
| `BETWEEN 1 AND 200` → `BETWEEN 0 AND 200`；→ `BETWEEN 1 AND 201` | `…bounds_a_comments_length[0-False]`；`[201-False]` |
| 拿掉 `not_self` | `test_a_notification_cannot_be_to_yourself` |
| `shape` 的 `like` 分支拿掉 `AND comment_id IS NULL` | `…shape…[like-True-True]` |
| `uq_notifications_like` 拿掉 `unique=True`；拿掉 `postgresql_where` | `test_only_one_like_notification…` 的前半；後半 |
| `notifications.comment_id` 的 `ondelete` 改成 `SET NULL` | `test_deleting_a_comment…`（而且是 `shape` 的 CHECK 把它擋成 IntegrityError——照實記下紅的樣子） |
| 只改模型不改 migration（任一個索引改名） | 整個 session 在 `alembic check` 就停 |

- [ ] **Step 7：整套＋靜態檢查＋commit。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
```

Expected：`1227 + 新的條數 passed`；ruff、mypy 乾淨。這個 task 沒有動 `routes`／`schemas`，不用重新產生 `schema.d.ts`。

```bash
git add app/models/social.py app/models/__init__.py migrations/versions/0018_create_social_tables.py tests/factories.py tests/test_social_model.py
git commit -F "$S/social-plan-task1-msg.txt"   # feat(backend): 讚、留言、通知的三張表（migration 0018）
```

---

## Task 2：後端——可見性模組、`FriendMeal` 的組法搬家、單一餐點的讀取

**Files:**
- Create: `app/social_visibility.py`、`app/friend_meals.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`tests/social_helpers.py`、`tests/test_social_meal.py`
- Modify: `app/schemas/friend.py`、`app/api/routes/friends.py`、`app/main.py`、`tests/test_friend_meals.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：`app/social_visibility.py`**（整份；寫計畫時對真的資料庫跑過）：

```python
"""讚、留言、通知的可見性（社群規格 §4）。

**兩件事都在這裡，而且只在這裡：**

1. 看不看得到一餐（`load_visible_meal`）：主人，或主人現在的好友而且不是「只有我看得到」。
2. 一則讚或留言還算不算數（`like_counts`／`author_counts`）：作者是主人，或作者**現在**
   是主人的好友。解除好友不刪資料——讀的時候過濾，重新加好友就回來（規格 D4）。

`app/friend_visibility.py` 管「好友的餐點清單」；這裡管「一餐上面的東西」。兩個模組與
`routes/friends.py` 是後端唯三碰 `Friendship` 的地方（`tests/test_friend_meals.py` 的掃描測試）。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal
from app.models.social import MealComment, MealLike
from app.models.user import User


def _pair(one: Any, other: Any) -> tuple[ColumnElement[bool], ColumnElement[bool]]:
    """`friendships` 的那一列（`user_a < user_b`）。`one`／`other` 可以是欄位也可以是整數；
    `least`／`greatest` 讓它對得上 `uq_friendships_user_a_user_b`，不用 OR 兩個方向。"""
    return (
        Friendship.user_a == func.least(one, other),
        Friendship.user_b == func.greatest(one, other),
    )


def _are_friends(one: Any, other: Any) -> ColumnElement[bool]:
    return exists().where(Friendship.status == FriendshipStatus.ACCEPTED, *_pair(one, other))


def meal_visible_to(viewer_id: int) -> ColumnElement[bool]:
    return or_(
        Meal.user_id == viewer_id,
        and_(Meal.is_private.is_(False), _are_friends(Meal.user_id, viewer_id)),
    )


async def load_visible_meal(
    db: AsyncSession, viewer: User, meal_id: int, *, lock: bool = False
) -> Meal:
    """看得到 → 那一餐；否則 404，跟 `/api/meals/{id}` 的「不存在」逐字相同（handover §4.7）。
    條件全部在一個查詢的 WHERE 裡：不存在、不是好友、私人走同一條路。

    `lock=True`（要寫讚或留言時）：`FOR SHARE OF meals` 鎖到交易結束——跟「改成只有我
    看得到」的 PATCH（`FOR UPDATE`）互斥，不會有一則讚落在已經關起來的餐上。"""
    query = select(Meal).where(Meal.id == meal_id, meal_visible_to(viewer.id))
    if lock:
        query = query.with_for_update(read=True, of=Meal)
    meal: Meal | None = await db.scalar(query)
    if meal is None:
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    return meal


def like_counts(liker: Any, owner: Any) -> ColumnElement[bool]:
    """這個讚算不算：按的人現在是主人的好友。主人自己的不算（本來就不該有那一列）。"""
    return _are_friends(liker, owner)


def author_counts(author: Any, owner: Any) -> ColumnElement[bool]:
    """這則留言顯不顯示：作者是主人，或作者現在是主人的好友。"""
    return or_(author == owner, _are_friends(author, owner))


@dataclass(frozen=True)
class SocialCounts:
    like_count: int = 0
    comment_count: int = 0
    liked_by_me: bool = False


async def social_counts(
    db: AsyncSession, viewer_id: int, meal_ids: Sequence[int]
) -> dict[int, SocialCounts]:
    """這幾餐各有幾個讚、幾則留言、我按了沒。**兩次查詢，跟餐數無關。**

    **不檢查 viewer 看不看得到這幾餐**——呼叫端傳進來的 id 必須是已經過了自己那一關的
    （自己的餐、`shared_meals`、`load_visible_meal`）。每一個傳進來的 id 都有一筆結果。"""
    if not meal_ids:
        return {}
    likes = (
        await db.execute(
            select(MealLike.meal_id, func.count(), func.bool_or(MealLike.user_id == viewer_id))
            .join(Meal, Meal.id == MealLike.meal_id)
            .where(MealLike.meal_id.in_(meal_ids), like_counts(MealLike.user_id, Meal.user_id))
            .group_by(MealLike.meal_id)
        )
    ).all()
    comments = (
        await db.execute(
            select(MealComment.meal_id, func.count())
            .join(Meal, Meal.id == MealComment.meal_id)
            .where(
                MealComment.meal_id.in_(meal_ids),
                author_counts(MealComment.user_id, Meal.user_id),
            )
            .group_by(MealComment.meal_id)
        )
    ).all()
    liked = {meal_id: (count, bool(mine)) for meal_id, count, mine in likes}
    commented = {meal_id: count for meal_id, count in comments}
    return {
        meal_id: SocialCounts(
            like_count=liked.get(meal_id, (0, False))[0],
            comment_count=commented.get(meal_id, 0),
            liked_by_me=liked.get(meal_id, (0, False))[1],
        )
        for meal_id in meal_ids
    }
```

- [ ] **Step 2：`FriendMeal` 多三個欄位、組法搬家。**

`app/schemas/friend.py` 的 `FriendMeal` 最後加（**沒有預設值**——漏帶是當場的驗證錯誤，同 `MealResponse.description` 的註解）：

```python
    # 社群規格 §5.6：過濾後的數字——只算主人現在的好友（留言另外算主人自己的）。
    like_count: int
    comment_count: int
    liked_by_me: bool
```

`app/friend_meals.py`（新）：把 `routes/friends.py` 的 `_friend_meals` **整個搬過來**，改名、多一個參數、多三個欄位；其餘一個字不動：

```python
"""組 `FriendMeal`——好友動態、好友的某一天、單一餐點（社群規格 D7）共用的白名單序列化。"""

# import：defaultdict、Sequence、AsyncSession、item_join_query、Food、FoodRevision、Meal、MealItem、
# User、Macros、scale、total、FriendMeal、FriendMealItem、PersonResponse、social_counts


async def build_friend_meals(
    db: AsyncSession, viewer_id: int, meals: Sequence[Meal], people: dict[int, User]
) -> list[FriendMeal]:
    """（原本的 docstring）＋ 數字再兩次查詢（`social_counts`），一樣跟餐數無關。
    **呼叫端要自己確認 viewer 看得到這幾餐。**"""
    if not meals:
        return []
    counts = await social_counts(db, viewer_id, [meal.id for meal in meals])
    # … 原本的項目查詢與迴圈 …
            FriendMeal(
                # … 原本的欄位；user=PersonResponse(id=…, display_name=…) …
                like_count=counts[meal.id].like_count,
                comment_count=counts[meal.id].comment_count,
                liked_by_me=counts[meal.id].liked_by_me,
            )
```

`app/api/routes/friends.py`：刪掉 `_friend_meals`，兩個呼叫點改成 `await build_friend_meals(db, user.id, page, people)`、`await build_friend_meals(db, user.id, meals, {friend.id: friend})`；清掉用不到的 import（`defaultdict`、`item_join_query`、`Food`、`FoodRevision`、`MealItem`、`Macros`、`scale`、`total`、`FriendMeal`、`FriendMealItem`——ruff 會指出來）。

- [ ] **Step 3：`app/schemas/social.py`**（這個 task 只用到讀取的三個；其餘 Task 3、4 才加）：

```python
"""讚與留言的回應（社群規格 §5）。**沒有 email、沒有作者的 user id**（D9）：
「是不是我」「能不能刪」由伺服器算好。"""

from datetime import datetime

from pydantic import BaseModel

from app.schemas.friend import FriendMeal


class LikerResponse(BaseModel):
    display_name: str
    is_me: bool


class CommentResponse(BaseModel):
    id: int
    display_name: str
    is_me: bool
    # 我是作者，或我是這一餐的主人。
    can_delete: bool
    body: str
    created_at: datetime


class SocialMealResponse(BaseModel):
    """一餐與它上面的讚、留言。`meal` 是好友看的那個白名單——主人看自己的餐也是
    （沒有餐費與備註；要看那些去編輯畫面）。"""

    meal: FriendMeal
    is_mine: bool
    likes: list[LikerResponse]
    comments: list[CommentResponse]
    comments_truncated: bool
```

- [ ] **Step 4：`app/api/routes/social.py`**，並在 `app/main.py` 註冊（`app.include_router(social.router, prefix="/api")`，放在 `friends` 後面；`app/api/routes/__init__.py` 如果有列名字就照加）：

```python
"""一餐上面的讚與留言（社群規格 §5）。

**每個端點的第一件事都是 `load_visible_meal`**——看不到與不存在是同一個 404。
這裡不直接碰好友關係的表：規則都在可見性模組。"""

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.db import get_db
from app.errors import NotFoundError
from app.friend_meals import build_friend_meals
from app.models.social import MealComment, MealLike
from app.models.user import User
from app.schemas.social import CommentResponse, LikerResponse, SocialMealResponse
from app.social_visibility import author_counts, like_counts, load_visible_meal

router = APIRouter(prefix="/social", tags=["social"])

# 一次最多回幾則留言（規格 D10）：最近的這麼多則，由舊到新。
COMMENTS_SHOWN = 100


def _comment_response(
    comment: MealComment, display_name: str, *, viewer_id: int, owner_id: int
) -> CommentResponse:
    is_me = comment.user_id == viewer_id
    return CommentResponse(
        id=comment.id,
        display_name=display_name,
        is_me=is_me,
        can_delete=is_me or owner_id == viewer_id,
        body=comment.body,
        created_at=comment.created_at,
    )


@router.get("/meals/{meal_id}", response_model=SocialMealResponse)
async def read_social_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SocialMealResponse:
    """一餐、誰按了讚、最近的留言。自己的餐與看得到的好友的餐都走這裡。"""
    meal = await load_visible_meal(db, user, meal_id)
    owner = user if meal.user_id == user.id else await db.get(User, meal.user_id)
    if owner is None:
        # 主人的帳號剛好被刪：餐也跟著 cascade 了。
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    [card] = await build_friend_meals(db, user.id, [meal], {owner.id: owner})

    likers = (
        await db.execute(
            select(User.display_name, MealLike.user_id)
            .join(User, User.id == MealLike.user_id)
            .where(MealLike.meal_id == meal.id, like_counts(MealLike.user_id, meal.user_id))
            .order_by(MealLike.id)
        )
    ).all()
    # 多拿一則：知道有沒有被截掉，不用另外數（數字在 card.comment_count）。
    rows = (
        await db.execute(
            select(MealComment, User.display_name)
            .join(User, User.id == MealComment.user_id)
            .where(MealComment.meal_id == meal.id, author_counts(MealComment.user_id, meal.user_id))
            .order_by(MealComment.id.desc())
            .limit(COMMENTS_SHOWN + 1)
        )
    ).all()
    shown = rows[:COMMENTS_SHOWN][::-1]
    return SocialMealResponse(
        meal=card,
        is_mine=meal.user_id == user.id,
        likes=[
            LikerResponse(display_name=name, is_me=liker_id == user.id) for name, liker_id in likers
        ],
        comments=[
            _comment_response(comment, name, viewer_id=user.id, owner_id=meal.user_id)
            for comment, name in shown
        ],
        comments_truncated=len(rows) > COMMENTS_SHOWN,
    )
```

- [ ] **Step 5：掃描測試。** `tests/test_friend_meals.py`：

1. `test_only_the_friend_modules_touch_the_friendship_table` 的 `friend_modules` 加一行 `root / "social_visibility.py",`（docstring 補一句「社群的可見性模組是第三個」）。
2. 白名單那條（`test_a_friends_shared_meal_shows_in_the_feed_with_only_the_whitelisted_fields`）的 `set(shared) == {…}` 加 `"like_count", "comment_count", "liked_by_me"`——**刻意的改變**，並加一行 `assert (shared["like_count"], shared["comment_count"], shared["liked_by_me"]) == (0, 0, False)`。
3. 檔尾新增：

```python
def test_only_the_social_modules_widen_who_can_read_a_meal():
    """社群規格 D6：「看得到別人的一餐」只有社群的模組做得到。`/api/meals` 仍然只回自己的——
    它從可見性模組只准拿「這幾餐各有幾個讚」（`social_counts` 不放寬任何讀取）。

    掃的是文字：這幾個名字連註解都不准出現在別的模組。"""
    root = Path(__file__).resolve().parent.parent / "app"
    routes = root / "api" / "routes"
    social_modules = {
        root / "social_visibility.py",
        root / "friend_meals.py",
        routes / "friends.py",
        routes / "social.py",
        routes / "notifications.py",
    }
    words = re.compile(
        r"\bsocial_visibility\b|\bload_visible_meal\b|\bmeal_visible_to\b"
        r"|\bbuild_friend_meals\b|\bfriend_meals\b|\blike_counts\b|\bauthor_counts\b"
    )
    allowed_in_meals = "from app.social_visibility import SocialCounts, social_counts\n"
    offenders = []
    for path in root.rglob("*.py"):
        if path in social_modules:
            continue
        source = path.read_text(encoding="utf-8")
        if path == routes / "meals.py":
            source = source.replace(allowed_in_meals, "", 1)
        if words.search(source):
            offenders.append(str(path.relative_to(root)))
    assert offenders == []
```

- [ ] **Step 6：`tests/social_helpers.py` 與 `tests/test_social_meal.py`。** 這一組人之後四個測試檔都要用，所以放在一個普通的模組裡（不是 `conftest.py`：只有社群的測試需要）。

`tests/social_helpers.py`：

```python
"""社群測試共用的一組人與小工具。"""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

from sqlalchemy import delete

from app.models.food import FoodRevision
from app.models.friendship import Friendship, FriendshipStatus
from app.security.tokens import create_access_token
from tests.factories import (
    create_expense,
    create_food,
    create_friendship,
    create_meal,
    create_user,
)

MISSING = 2**62  # 一定不存在的 id


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def make_cast(db_session) -> SimpleNamespace:
    """愛麗絲是主人。鮑伯與小卡是她的好友、**彼此不是**；阿丁的邀請還在等；伊芙是陌生人。
    那一餐真的有餐費、備註、私人食物——「沒有外流」才不是空轉。
    餐費刻意是 4321.75：短的數字（180）會剛好出現在 id 或熱量裡。"""
    alice, bob, carol, dan, eve = [
        await create_user(db_session, display_name=name)
        for name in ("愛麗絲", "鮑伯", "小卡", "阿丁", "伊芙")
    ]
    await create_friendship(db_session, alice, bob)
    await create_friendship(db_session, carol, alice)
    await create_friendship(db_session, dan, alice, status=FriendshipStatus.PENDING)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的私房菜")
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    meal = await create_meal(
        db_session,
        user=alice,
        eaten_at=datetime.fromisoformat("2026-10-06T04:00:00+00:00"),
        items=[(revision, 150)],
        note="今天心情很差",
        description="滷肉飯配燙青菜",
    )
    await create_expense(db_session, user=alice, amount=Decimal("4321.75"), meal=meal)
    return SimpleNamespace(
        alice=alice, bob=bob, carol=carol, dan=dan, eve=eve, meal=meal, food=food, revision=revision
    )


async def unfriend(db_session, one, other) -> None:
    user_a, user_b = sorted((one.id, other.id))
    deleted = await db_session.scalar(
        delete(Friendship)
        .where(Friendship.user_a == user_a, Friendship.user_b == user_b)
        .returning(Friendship.id)
    )
    assert deleted is not None  # 真的有東西可以解除
    await db_session.commit()
```

`tests/test_social_meal.py`：

```python
"""`GET /api/social/meals/{id}`：誰看得到一餐、看到什麼（社群規格 §4.1、§4.2、§5.1）。"""

from datetime import datetime

import pytest
from sqlalchemy import event

from tests.factories import create_comment, create_friendship, create_like, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


async def _read(client, viewer, meal_id):
    return await client.get(f"/api/social/meals/{meal_id}", headers=auth(viewer))


# ---------- §4.1：看不看得到 ----------


@pytest.mark.parametrize(
    ("who", "public", "private"),
    [
        ("alice", 200, 200),
        ("bob", 200, 404),
        ("carol", 200, 404),
        ("dan", 404, 404),
        ("eve", 404, 404),
    ],
)
async def test_who_can_open_a_meal(client, db_session, cast, who, public, private):
    viewer = getattr(cast, who)

    assert (await _read(client, viewer, cast.meal.id)).status_code == public

    cast.meal.is_private = True
    await db_session.commit()
    assert (await _read(client, viewer, cast.meal.id)).status_code == private


async def test_cannot_see_and_does_not_exist_are_the_same_response(client, cast):
    hidden = await _read(client, cast.eve, cast.meal.id)
    missing = await _read(client, cast.eve, MISSING)
    own_endpoint = await client.get(f"/api/meals/{MISSING}", headers=auth(cast.eve))

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content == own_endpoint.content


async def test_it_needs_a_login(client, cast):
    assert (await client.get(f"/api/social/meals/{cast.meal.id}")).status_code == 401


async def test_unfriending_closes_the_door(client, db_session, cast):
    assert (await _read(client, cast.bob, cast.meal.id)).status_code == 200
    await unfriend(db_session, cast.alice, cast.bob)
    assert (await _read(client, cast.bob, cast.meal.id)).status_code == 404
    # 小卡不受影響：關的是鮑伯那一扇，不是整個端點。
    assert (await _read(client, cast.carol, cast.meal.id)).status_code == 200


# ---------- 看到什麼 ----------


async def test_a_friend_sees_the_whitelisted_meal_and_nothing_private(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="好香")

    response = await _read(client, cast.bob, cast.meal.id)

    body = response.json()
    assert set(body) == {"meal", "is_mine", "likes", "comments", "comments_truncated"}
    assert body["is_mine"] is False
    assert body["meal"]["user"] == {"id": cast.alice.id, "display_name": "愛麗絲"}
    assert body["meal"]["description"] == "滷肉飯配燙青菜"
    assert [item["food_name"] for item in body["meal"]["items"]] == ["愛麗絲的私房菜"]
    assert body["likes"] == [{"display_name": "小卡", "is_me": False}]
    assert set(body["comments"][0]) == {
        "id", "display_name", "is_me", "can_delete", "body", "created_at",
    }
    # 描述在（上面斷言過），備註、餐費、email、食物 id 不在——同一個回應裡兩種都有才算數。
    secrets = ("今天心情很差", "4321.75", "food_id", "note", "cost", "photo_path", "@example.com")
    for secret in secrets:
        assert secret not in response.text


async def test_the_owner_gets_the_same_whitelist(client, cast):
    response = await _read(client, cast.alice, cast.meal.id)

    assert response.json()["is_mine"] is True
    assert "今天心情很差" not in response.text and "4321.75" not in response.text


async def test_mutual_friends_of_the_owner_see_each_other(client, db_session, cast):
    """規格 D3：鮑伯與小卡不是好友，但在愛麗絲的餐上看得到彼此。"""
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="好香")
    await create_comment(db_session, meal=cast.meal, user=cast.alice, body="謝謝")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我也要")

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    rows = [(c["display_name"], c["body"], c["is_me"], c["can_delete"]) for c in body["comments"]]
    assert rows == [
        ("小卡", "好香", False, False),
        ("愛麗絲", "謝謝", False, False),
        ("鮑伯", "我也要", True, True),
    ]
    assert (body["meal"]["like_count"], body["meal"]["comment_count"]) == (1, 3)
    assert body["meal"]["liked_by_me"] is False


async def test_the_owner_can_delete_every_comment(client, db_session, cast):
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.alice)

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    rows = [(c["is_me"], c["can_delete"]) for c in body["comments"]]
    assert rows == [(False, True), (True, True)]


# ---------- §4.2：解除之後 ----------


async def test_an_unfriended_persons_likes_and_comments_vanish_for_everyone_then_return(
    client, db_session, cast
):
    """過濾看的是「作者與主人」的關係：看的人是小卡（她一直看得到這一餐），被解除的是鮑伯。"""
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯說")
    await create_comment(db_session, meal=cast.meal, user=cast.carol, body="小卡說")

    async def seen():
        body = (await _read(client, cast.carol, cast.meal.id)).json()
        return (
            [like["display_name"] for like in body["likes"]],
            [c["body"] for c in body["comments"]],
            body["meal"]["like_count"],
            body["meal"]["comment_count"],
        )

    assert await seen() == (["鮑伯", "小卡"], ["鮑伯說", "小卡說"], 2, 2)

    await unfriend(db_session, cast.alice, cast.bob)
    assert await seen() == (["小卡"], ["小卡說"], 1, 1)
    # 主人看到的也一樣。
    owner_view = (await _read(client, cast.alice, cast.meal.id)).json()
    assert owner_view["meal"]["like_count"] == 1 and len(owner_view["comments"]) == 1

    await create_friendship(db_session, cast.alice, cast.bob)
    assert await seen() == (["鮑伯", "小卡"], ["鮑伯說", "小卡說"], 2, 2)


async def test_a_pending_request_does_not_count_as_a_friend(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.dan)
    await create_comment(db_session, meal=cast.meal, user=cast.dan)

    body = (await _read(client, cast.bob, cast.meal.id)).json()

    assert (body["likes"], body["comments"], body["meal"]["like_count"]) == ([], [], 0)


async def test_a_self_like_row_never_counts(client, db_session, cast):
    """端點會擋（Task 3）；這條守的是就算有那樣一列，數字也不算它。"""
    await create_like(db_session, meal=cast.meal, user=cast.alice)

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    meal = body["meal"]
    assert (body["likes"], meal["like_count"], meal["liked_by_me"]) == ([], 0, False)


async def test_going_private_keeps_what_was_written_for_the_owner(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="留著")
    cast.meal.is_private = True
    await db_session.commit()

    body = (await _read(client, cast.alice, cast.meal.id)).json()

    assert [c["body"] for c in body["comments"]] == ["留著"]
    assert body["meal"]["like_count"] == 1


# ---------- 上限、liked_by_me、卡片上的數字 ----------


async def test_only_the_latest_hundred_comments_oldest_first(client, db_session, cast):
    for index in range(101):
        await create_comment(db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則")

    body = (await _read(client, cast.carol, cast.meal.id)).json()

    assert body["comments_truncated"] is True
    assert [c["body"] for c in body["comments"]] == [f"第{index}則" for index in range(1, 101)]
    assert body["meal"]["comment_count"] == 101  # 數字是全部，不是顯示出來的


async def test_exactly_a_hundred_is_not_truncated(client, db_session, cast):
    for index in range(100):
        await create_comment(db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則")

    body = (await _read(client, cast.carol, cast.meal.id)).json()

    assert body["comments_truncated"] is False and len(body["comments"]) == 100


async def test_the_feed_and_the_day_carry_the_same_numbers(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.eve)  # 陌生人的列：不算
    await create_comment(db_session, meal=cast.meal, user=cast.carol)

    feed = (await client.get("/api/friends/feed", headers=auth(cast.bob))).json()
    day = (
        await client.get(
            f"/api/friends/{cast.alice.id}/meals?date=2026-10-06", headers=auth(cast.bob)
        )
    ).json()
    as_carol = (await client.get("/api/friends/feed", headers=auth(cast.carol))).json()

    def numbers(meal):
        return (meal["like_count"], meal["comment_count"], meal["liked_by_me"])

    assert numbers(feed["meals"][0]) == numbers(day["meals"][0]) == (1, 1, True)
    assert numbers(as_carol["meals"][0]) == (1, 1, False)


async def test_the_feed_does_not_query_per_meal(client, db_session, db_connection, cast):
    """1 餐與 6 餐的 SELECT 次數一樣（每一餐都有讚與留言——沒有的話少查也看不出來）。"""
    seen: list[str] = []

    def record(conn, cursor, statement, parameters, context, executemany):
        if statement.lstrip().upper().startswith("SELECT"):
            seen.append(statement)

    async def selects() -> int:
        seen.clear()
        event.listen(db_connection.sync_connection, "before_cursor_execute", record)
        try:
            response = await client.get("/api/friends/feed", headers=auth(cast.bob))
        finally:
            event.remove(db_connection.sync_connection, "before_cursor_execute", record)
        assert response.status_code == 200
        return len(seen)

    await create_like(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    one = await selects()
    for hour in range(5):
        meal = await create_meal(
            db_session,
            user=cast.alice,
            eaten_at=datetime.fromisoformat(f"2026-10-07T0{hour}:00:00+00:00"),
            items=[(cast.revision, 100)],
        )
        await create_like(db_session, meal=meal, user=cast.carol)
        await create_comment(db_session, meal=meal, user=cast.carol)

    assert await selects() == one
```

- [ ] **Step 7：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_meal.py tests/test_friend_meals.py tests/test_friend_requests.py
```

Expected：全部 PASS（`test_social_meal.py` 是 **20** 條：8＋4＋4＋4）。`test_friend_meals.py` 既有的條數不變、多 1 條掃描。

- [ ] **Step 8：突變。** `social_visibility.py`、`friend_meals.py`、`routes/social.py` 都是新檔案——先各 `cp` 一份到 `$S`。

| 突變 | 該紅的 |
|---|---|
| `meal_visible_to` 拿掉 `Meal.is_private.is_(False)` | `test_who_can_open_a_meal[bob…]`、`[carol…]` |
| `_are_friends` 拿掉 `status == ACCEPTED` | `test_who_can_open_a_meal[dan…]`、`test_a_pending_request_does_not_count…` |
| `meal_visible_to` 整個換成 `true()` | `[dan]`、`[eve]`、`…same_response`、`test_unfriending_closes_the_door` |
| `_pair` 的 `least`／`greatest` 對調 | 幾乎全部（好友都看不到了）——確認紅的是 200 那一半 |
| `like_counts` 改成 `author_counts`（主人的讚也算） | `test_a_self_like_row_never_counts` |
| `author_counts` 拿掉 `author == owner` | `test_mutual_friends…`、`test_the_owner_can_delete_every_comment` |
| `social_counts` 兩個查詢各拿掉過濾（`like_counts(...)`／`author_counts(...)` 那一個條件） | `…vanish_for_everyone…`、`…feed_and_the_day…`（陌生人的讚被算進去） |
| `read_social_meal` 的名單查詢拿掉 `like_counts(...)`；留言查詢拿掉 `author_counts(...)` | `…vanish_for_everyone…`、`test_a_pending_request…` |
| `.order_by(MealComment.id.desc())` 改成 `.asc()` | `test_only_the_latest_hundred…`（回的是最舊的 100 則） |
| `COMMENTS_SHOWN + 1` 改成 `COMMENTS_SHOWN` | `test_only_the_latest_hundred…`（`truncated` 是 False） |
| `> COMMENTS_SHOWN` 改成 `>=` | `test_exactly_a_hundred_is_not_truncated` |
| `can_delete=is_me or …` 改成 `can_delete=is_me` | `test_the_owner_can_delete_every_comment` |
| `build_friend_meals` 的 `social_counts` 搬進迴圈（每餐查一次） | `test_the_feed_does_not_query_per_meal` |
| `social.py` 加一行註解提到 `Friendship`；`routes/meals.py` 加 `from app.social_visibility import load_visible_meal` | 兩條掃描測試各一條 |

- [ ] **Step 9：`schema.d.ts`、整套、commit。** 重新產生 `schema.d.ts`（多一條路徑、四個 schema、`FriendMeal` 多三個欄位）→ `cd frontend && npm run -s typecheck && npm run -s test`（Expected：都綠——`FriendMeal` 的測試資料沒有型別標註，不會紅）。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/social_visibility.py app/friend_meals.py app/schemas/social.py app/schemas/friend.py app/api/routes/social.py app/api/routes/friends.py app/main.py tests/social_helpers.py tests/test_social_meal.py tests/test_friend_meals.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task2-msg.txt"   # feat(backend): 單一餐點的讀取——主人與好友同一個白名單、解除好友用讀取時過濾
```

---

## Task 3：後端——讚的端點、自己的餐點清單上的數字

**Files:**
- Create: `tests/test_social_likes.py`、`tests/test_social_likes_concurrency.py`
- Modify: `app/ratelimit.py`、`tests/conftest.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`app/schemas/meal.py`、`app/api/routes/meals.py`、`frontend/src/api/schema.d.ts`、`frontend/tests/timeline.test.ts`

- [ ] **Step 1：限速器。** `app/ratelimit.py` 檔尾（兩個一起加，Task 4 用第二個）：

```python
LIKE_LIMIT = 60
COMMENT_LIMIT = 20
SOCIAL_WINDOW_SECONDS = 60.0

# 按讚與收回**共用**（社群規格 D20），鍵是使用者 id（`str(user.id)`）。分開算的話額度實際上
# 是兩倍。60：連按、反悔、一口氣滑過一頁動態都在額度內——擋的是寫壞的迴圈與拿 id 亂試的人
# （限速在可見性檢查之前）。
like_rate_limiter = KeyedRateLimiter(
    limit=LIKE_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_LIKES",
    message="按得太快了，請稍後再試",
)

# 留言：每一則都會通知餐的主人，所以比讚緊。刪留言不算。
comment_rate_limiter = KeyedRateLimiter(
    limit=COMMENT_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_COMMENTS",
    message="留言太頻繁，請稍後再試",
)
```

`tests/conftest.py`：import 這兩個，`_reset_login_rate_limiter` 裡加 `like_rate_limiter.reset()`、`comment_rate_limiter.reset()`（docstring 補一句）。

- [ ] **Step 2：測試（先寫，看它紅）。** `tests/test_social_likes.py`：

```python
"""`PUT`／`DELETE /api/social/meals/{id}/like`（社群規格 §5.2）與卡片上的數字（§5.6）。"""

import pytest
from sqlalchemy import select

from app.models.social import MealLike
from app.ratelimit import LIKE_LIMIT
from tests.factories import create_comment, create_friendship, create_like
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


def _url(meal_id) -> str:
    return f"/api/social/meals/{meal_id}/like"


async def _likers(db_session, meal) -> list[int]:
    rows = await db_session.scalars(
        select(MealLike.user_id).where(MealLike.meal_id == meal.id).order_by(MealLike.id)
    )
    return list(rows)


async def test_like_then_take_it_back(client, db_session, cast):
    first = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    second = await client.put(_url(cast.meal.id), headers=auth(cast.carol))

    assert first.status_code == 200
    assert first.json() == {"like_count": 1, "liked_by_me": True}
    assert second.json() == {"like_count": 2, "liked_by_me": True}

    gone = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))

    assert gone.status_code == 200
    assert gone.json() == {"like_count": 1, "liked_by_me": False}
    # 刪的是「我的」那一列，不是這一餐全部的讚。
    assert await _likers(db_session, cast.meal) == [cast.carol.id]


async def test_both_directions_are_idempotent(client, db_session, cast):
    for _ in range(2):
        liked = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
        assert (liked.status_code, liked.json()["like_count"]) == (200, 1)
    assert await _likers(db_session, cast.meal) == [cast.bob.id]

    for _ in range(2):
        gone = await client.delete(_url(cast.meal.id), headers=auth(cast.bob))
        assert (gone.status_code, gone.json()) == (200, {"like_count": 0, "liked_by_me": False})
    never = await client.delete(_url(cast.meal.id), headers=auth(cast.carol))
    assert never.status_code == 200


async def test_the_owner_cannot_like_their_own_meal(client, db_session, cast):
    response = await client.put(_url(cast.meal.id), headers=auth(cast.alice))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CANNOT_LIKE_OWN_MEAL"
    assert await _likers(db_session, cast.meal) == []
    # 收回沒有東西可以收，照樣是 200（冪等）。
    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.alice))).status_code == 200


@pytest.mark.parametrize("method", ["put", "delete"])
@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_touch_its_likes(
    client, db_session, cast, method, who
):
    viewer = getattr(cast, who)
    await create_like(db_session, meal=cast.meal, user=viewer)  # DELETE 有東西可以刪才算數

    hidden = await client.request(method, _url(cast.meal.id), headers=auth(viewer))
    missing = await client.request(method, _url(MISSING), headers=auth(viewer))

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _likers(db_session, cast.meal) == [viewer.id]  # 沒有多一列、也沒有被刪


async def test_a_meal_gone_private_can_be_neither_liked_nor_unliked(client, db_session, cast):
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 200
    cast.meal.is_private = True
    await db_session.commit()

    assert (await client.put(_url(cast.meal.id), headers=auth(cast.carol))).status_code == 404
    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 404
    assert await _likers(db_session, cast.meal) == [cast.bob.id]


async def test_after_unfriending_the_like_stays_hidden_until_they_are_friends_again(
    client, db_session, cast
):
    await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    await unfriend(db_session, cast.alice, cast.bob)

    assert (await client.delete(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 404
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.bob))).status_code == 404
    # 小卡按讚拿到的數字不含鮑伯那一個。
    as_carol = await client.put(_url(cast.meal.id), headers=auth(cast.carol))
    assert as_carol.json() == {"like_count": 1, "liked_by_me": True}

    await create_friendship(db_session, cast.alice, cast.bob)
    again = await client.put(_url(cast.meal.id), headers=auth(cast.bob))
    assert again.json() == {"like_count": 2, "liked_by_me": True}
    assert len(await _likers(db_session, cast.meal)) == 2  # 鮑伯原本那一列一直都在，沒有多一列


async def test_it_needs_a_login(client, cast):
    assert (await client.put(_url(cast.meal.id))).status_code == 401
    assert (await client.delete(_url(cast.meal.id))).status_code == 401


async def test_likes_and_unlikes_share_one_budget_per_person(client, cast):
    for index in range(LIKE_LIMIT):
        method = "put" if index % 2 == 0 else "delete"
        ok = await client.request(method, _url(cast.meal.id), headers=auth(cast.bob))
        assert ok.status_code == 200

    for method in ("put", "delete"):
        blocked = await client.request(method, _url(cast.meal.id), headers=auth(cast.bob))
        assert blocked.status_code == 429
        assert blocked.json()["error"]["code"] == "TOO_MANY_LIKES"
        assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    # 額度是每個人的。
    assert (await client.put(_url(cast.meal.id), headers=auth(cast.carol))).status_code == 200


async def test_guessing_ids_runs_into_the_limit_before_the_lookup(client, cast):
    for _ in range(LIKE_LIMIT):
        assert (await client.put(_url(MISSING), headers=auth(cast.eve))).status_code == 404
    assert (await client.put(_url(MISSING), headers=auth(cast.eve))).status_code == 429


# ---------- 自己的餐點清單（`MealResponse`） ----------


async def _own_views(client, cast) -> dict[str, tuple[int, int]]:
    """每一條回 `MealResponse` 的路徑看到的 (讚, 留言)。"""
    me = auth(cast.alice)
    meal_id = cast.meal.id
    responses = {
        "read": await client.get(f"/api/meals/{meal_id}", headers=me),
        "list": await client.get("/api/meals?date=2026-10-06", headers=me),
        "patch": await client.patch(f"/api/meals/{meal_id}", headers=me, json={"note": "改"}),
        "add_item": await client.post(
            f"/api/meals/{meal_id}/items",
            headers=me,
            json={"food_id": cast.food.id, "quantity": "50"},
        ),
    }
    views = {}
    for name, response in responses.items():
        assert response.status_code in (200, 201), (name, response.text)
        body = response.json()[0] if name == "list" else response.json()
        assert "liked_by_me" not in body  # 規格「與原始決定的差異」第 3 點
        views[name] = (body["like_count"], body["comment_count"])
    return views


async def test_every_path_that_returns_my_meal_carries_the_numbers(client, db_session, cast):
    await create_like(db_session, meal=cast.meal, user=cast.bob)
    await create_like(db_session, meal=cast.meal, user=cast.eve)  # 陌生人的列：不算
    await create_comment(db_session, meal=cast.meal, user=cast.carol)
    await create_comment(db_session, meal=cast.meal, user=cast.alice)

    assert set((await _own_views(client, cast)).values()) == {(1, 2)}

    await unfriend(db_session, cast.alice, cast.bob)
    await unfriend(db_session, cast.alice, cast.carol)
    assert set((await _own_views(client, cast)).values()) == {(0, 1)}


async def test_a_new_meal_starts_at_zero(client, cast):
    response = await client.post(
        "/api/meals",
        headers=auth(cast.alice),
        json={"eaten_at": "2026-10-06T05:00:00+00:00", "meal_type": "snack", "items": []},
    )

    assert response.status_code == 201
    assert (response.json()["like_count"], response.json()["comment_count"]) == (0, 0)
```

`tests/test_social_likes_concurrency.py`（兩條真的連線；照 `tests/test_invites_concurrency.py` 的骨架）：

```python
"""兩個同時到的 PUT（連按兩下、兩台裝置）——都成功，只有一列（社群規格 D8）。

不用 `db_session`：共用一個交易的夾具看不見「第二個 INSERT 卡在唯一索引上等第一個」
（handover §6 第 14 種）。資料真的 commit，`finally` 自己清。"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.social import like_meal
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal, MealType
from app.models.social import MealLike
from app.models.user import User
from tests.conftest import TEST_DATABASE_URL
from tests.test_sessions_concurrency import _wait_until_someone_else_is_lock_waiting


@pytest_asyncio.fixture
async def independent_sessions(
    migrated_database: None,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


def _user(label: str) -> User:
    return User(
        email=f"like-race-{label}-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name=label,
    )


async def test_the_second_of_two_simultaneous_likes_waits_then_does_nothing(independent_sessions):
    alice, bob = _user("alice"), _user("bob")
    async with independent_sessions() as setup:
        setup.add_all([alice, bob])
        await setup.flush()
        user_a, user_b = sorted((alice.id, bob.id))
        setup.add(
            Friendship(
                user_a=user_a,
                user_b=user_b,
                requested_by=alice.id,
                status=FriendshipStatus.ACCEPTED,
                accepted_at=datetime.now(UTC),
            )
        )
        meal = Meal(user_id=alice.id, eaten_at=datetime.now(UTC), meal_type=MealType.LUNCH)
        setup.add(meal)
        await setup.commit()

    try:
        async with independent_sessions() as first, independent_sessions() as second:
            # 第一個 PUT 做到一半：那一列寫了、還沒 commit。
            first.add(MealLike(meal_id=meal.id, user_id=bob.id))
            await first.flush()
            first_pid = await first.scalar(select(func.pg_backend_pid()))

            bob_again = await second.get(User, bob.id)
            assert bob_again is not None
            attempt = asyncio.create_task(like_meal(meal.id, user=bob_again, db=second))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()

            state = await attempt
            assert (state.like_count, state.liked_by_me) == (1, True)

        async with independent_sessions() as check:
            rows = await check.scalar(
                select(func.count()).select_from(MealLike).where(MealLike.meal_id == meal.id)
            )
            assert rows == 1
    finally:
        async with independent_sessions() as cleanup:
            # 餐、讚、好友關係都跟著使用者 cascade。
            await cleanup.execute(delete(User).where(User.id.in_([alice.id, bob.id])))
            await cleanup.commit()
```

Run：`./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_likes.py tests/test_social_likes_concurrency.py`
Expected：FAIL——端點不存在是 405／404，`like_meal` 的 import 是 collection error。

- [ ] **Step 3：端點。** `app/schemas/social.py` 加：

```python
class LikeState(BaseModel):
    """按讚與收回都回這個：過濾後的數字，前端拿它對帳（規格 D19）。"""

    like_count: int
    liked_by_me: bool
```

`app/api/routes/social.py` 加（import `delete`、`from sqlalchemy.dialects.postgresql import insert as pg_insert`、`UnprocessableEntityError`、`like_rate_limiter`、`LikeState`、`social_counts`）：

```python
async def _like_state(db: AsyncSession, user_id: int, meal_id: int) -> LikeState:
    counts = (await social_counts(db, user_id, [meal_id]))[meal_id]
    return LikeState(like_count=counts.like_count, liked_by_me=counts.liked_by_me)


@router.put("/meals/{meal_id}/like", response_model=LikeState)
async def like_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LikeState:
    """按讚。冪等：已經按過就什麼都不做，照樣回 200 與目前的數字。

    限速在最前面（查不查得到都算一次）。`ON CONFLICT DO NOTHING`：兩個同時到的 PUT，
    第二個等第一個 commit 之後什麼都不寫——不是 IntegrityError。"""
    like_rate_limiter.hit(str(user.id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    if meal.user_id == user.id:
        raise UnprocessableEntityError("CANNOT_LIKE_OWN_MEAL", "不能對自己的餐點按讚")
    await db.execute(
        pg_insert(MealLike).values(meal_id=meal.id, user_id=user.id).on_conflict_do_nothing()
    )
    await db.commit()
    return await _like_state(db, user.id, meal.id)


@router.delete("/meals/{meal_id}/like", response_model=LikeState)
async def unlike_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LikeState:
    """收回讚。冪等。回 200 與目前的數字（不是 204）：跟按讚同一個形狀。
    看不到這一餐（包含已經解除好友）就是 404——那個讚本來就被藏起來了。"""
    like_rate_limiter.hit(str(user.id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    await db.execute(
        delete(MealLike).where(MealLike.meal_id == meal.id, MealLike.user_id == user.id)
    )
    await db.commit()
    return await _like_state(db, user.id, meal.id)
```

- [ ] **Step 4：`MealResponse` 的兩個數字。**

`app/schemas/meal.py` 的 `MealResponse` 最後加：

```python
    # 這一餐有幾個讚、幾則留言（社群規格 §5.6；只算現在的好友）。沒有預設值，理由同
    # description：每一條回 MealResponse 的路徑都要帶真的數字。主人不能讚自己，所以沒有
    # 「我按了沒」。
    like_count: int
    comment_count: int
```

`app/api/routes/meals.py`：

1. import **一字不差**（掃描測試比對這一行）：`from app.social_visibility import SocialCounts, social_counts`（放在 `app.schemas.meal` 與 `app.storage.photos` 之間）。
2. `_build_meal_response(meal, item_rows, cost, counts: SocialCounts)`：多一個**必填**參數，`MealResponse(…, like_count=counts.like_count, comment_count=counts.comment_count)`。
3. 六個呼叫點。單一餐的五個（`read_meal`、`update_meal`、`add_meal_item`、`update_meal_item`、`upload_meal_photo`）：

   ```python
       costs = await _costs_by_meal(db, [meal.id])
       counts = await social_counts(db, user.id, [meal.id])
       return _build_meal_response(meal, rows, costs.get(meal.id), counts[meal.id])
   ```

   `list_meals`：`counts = await social_counts(db, user.id, meal_ids)`，迴圈裡傳 `counts[meal.id]`。
4. `create_meal` 直接組 `MealResponse` 的那一處：`like_count=0, comment_count=0,`，上面一行註解「剛建立的餐不會有讚與留言」。
5. `read_meal`、`list_meals` 的 docstring 把查詢次數改對（3 → 5：多了讚與留言各一次，一樣跟餐數無關）。

- [ ] **Step 5：跑。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_likes.py tests/test_social_likes_concurrency.py tests/test_friend_meals.py
```

Expected：`test_social_likes.py` **14 passed**（1＋1＋1＋4＋1＋1＋1＋1＋1＋1＋1）、並行 1 條、掃描測試仍然綠（`meals.py` 那一行 import 被允許）。

- [ ] **Step 6：突變。**

| 突變 | 該紅的 |
|---|---|
| `like_meal` 的 `.on_conflict_do_nothing()` 拿掉 | 並行那一條（`IntegrityError`）；`test_both_directions_are_idempotent`（共用 session 裡是 500／例外） |
| `like_meal` 拿掉「主人」的檢查 | `test_the_owner_cannot_like_their_own_meal` |
| 兩個端點的 `load_visible_meal` 換成 `db.get(Meal, meal_id)` | `test_who_cannot_see…` 四條、`…gone_private…`、`…after_unfriending…` |
| `unlike_meal` 的 `delete` 拿掉 `MealLike.user_id == user.id` | `test_like_then_take_it_back`（小卡的也被刪） |
| `like_rate_limiter.hit` 搬到 `load_visible_meal` 後面 | `test_guessing_ids_runs_into_the_limit…` |
| `unlike_meal` 改用另一個新的限速器 | `test_likes_and_unlikes_share_one_budget…` |
| `LIKE_LIMIT = 61` | 同上（第 61 次是 200） |
| `conftest.py` 拿掉 `like_rate_limiter.reset()` | 這個檔案單獨跑不一定紅（每條測試的使用者 id 都不同）——**預期存活**，理由同 `export_rate_limiter`（`conftest.py` 的 docstring）。照實記下 |
| `read_meal`／`list_meals`／`update_meal`／`add_meal_item` 各自改傳 `SocialCounts()` | `test_every_path…`（`_own_views` 的那一個名字） |
| `update_meal_item`、`upload_meal_photo` 改傳 `SocialCounts()` | **沒有測試會紅**（`_own_views` 沒有走這兩條）。在 `_own_views` 補上這兩條路徑之後再突變一次——需要一個項目 id 與一張 JPEG（照 `tests/test_friend_meals.py` 的 `_jpeg()`）；補不上就照實寫進「與規格的差異」 |
| `meals.py` 的 import 改成 `from app.social_visibility import SocialCounts, load_visible_meal, social_counts` | `test_only_the_social_modules_widen…` |

- [ ] **Step 7：`schema.d.ts` 與前端的型別。** 重新產生 → `cd frontend && npm run -s typecheck`。
Expected：**紅一處**——`tests/timeline.test.ts` 的 `meal()`（唯一有型別標註的 `Meal` 測試資料）少了兩個欄位。加上 `like_count: 0, comment_count: 0,`，再跑 `npm run -s typecheck && npm run -s test`，全綠、數字跟基準線一樣。

- [ ] **Step 8：整套、commit。**

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/ratelimit.py tests/conftest.py app/schemas/social.py app/api/routes/social.py app/schemas/meal.py app/api/routes/meals.py tests/test_social_likes.py tests/test_social_likes_concurrency.py frontend/src/api/schema.d.ts frontend/tests/timeline.test.ts
git commit -F "$S/social-plan-task3-msg.txt"   # feat(backend): 按讚與收回（冪等、並行不會 500）；自己的餐點清單帶讚與留言數
```

---

## Task 4：後端——留言

**Files:**
- Create: `tests/test_social_comments.py`
- Modify: `app/schemas/social.py`、`app/api/routes/social.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：測試。** `tests/test_social_comments.py`（`cast` 夾具、`auth` 等照 Task 3 的檔頭）：

```python
"""留言的新增與刪除（社群規格 §5.3、§5.4）。"""

import pytest
from sqlalchemy import select

from app.models.social import MealComment
from app.ratelimit import COMMENT_LIMIT
from tests.factories import create_comment, create_meal
from tests.social_helpers import MISSING, auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


def _url(meal_id, comment_id=None) -> str:
    base = f"/api/social/meals/{meal_id}/comments"
    return base if comment_id is None else f"{base}/{comment_id}"


async def _post(client, user, meal_id, body="看起來好好吃"):
    return await client.post(_url(meal_id), headers=auth(user), json={"body": body})


async def _bodies(db_session, meal) -> list[str]:
    rows = await db_session.scalars(
        select(MealComment.body).where(MealComment.meal_id == meal.id).order_by(MealComment.id)
    )
    return list(rows)


# ---------- 新增 ----------


async def test_a_friend_comments_and_everyone_who_can_see_the_meal_reads_it(client, cast):
    response = await _post(client, cast.bob, cast.meal.id, "好吃嗎")

    assert response.status_code == 201
    created = response.json()
    assert set(created) == {"id", "display_name", "is_me", "can_delete", "body", "created_at"}
    assert (created["display_name"], created["is_me"], created["can_delete"]) == ("鮑伯", True, True)
    assert created["created_at"].endswith(("Z", "+00:00"))

    seen = await client.get(f"/api/social/meals/{cast.meal.id}", headers=auth(cast.carol))
    assert [(c["id"], c["body"], c["is_me"]) for c in seen.json()["comments"]] == [
        (created["id"], "好吃嗎", False)
    ]


async def test_the_owner_can_comment_even_on_a_private_meal(client, db_session, cast):
    cast.meal.is_private = True
    await db_session.commit()

    assert (await _post(client, cast.alice, cast.meal.id, "自己的筆記")).status_code == 201
    assert (await _post(client, cast.bob, cast.meal.id)).status_code == 404
    assert await _bodies(db_session, cast.meal) == ["自己的筆記"]


async def test_the_body_is_cleaned_into_one_safe_line(client, db_session, cast):
    """換行、Tab、NUL、雙向控制字元都變成空白並壓成一個；ZWJ 的表情符號留著。"""
    family = "".join(chr(code) for code in (0x1F468, 0x200D, 0x1F469, 0x200D, 0x1F467))
    raw = "  好吃\n\t嗎" + chr(0x202E) + "真的" + chr(0) + " " + family + "  "

    response = await _post(client, cast.bob, cast.meal.id, raw)

    assert response.status_code == 201
    assert response.json()["body"] == f"好吃 嗎 真的 {family}"
    assert await _bodies(db_session, cast.meal) == [f"好吃 嗎 真的 {family}"]


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ("字" * 200, 201),
        ("字" * 201, 422),
        # 上限算的是清理之後：200 個字＋一堆會被清掉的空白仍然是 200。
        ("字" * 200 + " \n" * 100, 201),
        (chr(0x1F600) * 200, 201),  # 一個表情符號算一個字（code point），不是兩個
        (chr(0x1F600) * 201, 422),
        ("", 422),
        ("   \n\t ", 422),
        (chr(0x202E) + chr(0), 422),  # 清完是空的
        ("字" * 1001, 422),  # 清理之前的上限
    ],
    # 明寫 id：參數裡有控制字元與一千個字，不要讓 pytest 自己拿去當測試名稱。
    ids=["200", "201", "200-padded", "emoji-200", "emoji-201", "empty", "blank", "control", "raw"],
)
async def test_the_length_limit_applies_after_cleaning(client, db_session, cast, body, status):
    response = await _post(client, cast.bob, cast.meal.id, body)

    assert response.status_code == status
    assert len(await _bodies(db_session, cast.meal)) == (1 if status == 201 else 0)


async def test_the_body_must_be_a_string(client, cast):
    for payload in ({}, {"body": None}, {"body": 5}, {"body": ["a"]}):
        response = await client.post(_url(cast.meal.id), headers=auth(cast.bob), json=payload)
        assert response.status_code == 422, payload


@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_comment(client, db_session, cast, who):
    viewer = getattr(cast, who)

    hidden = await _post(client, viewer, cast.meal.id)
    missing = await _post(client, viewer, MISSING)

    assert hidden.status_code == missing.status_code == 404
    assert hidden.content == missing.content
    assert await _bodies(db_session, cast.meal) == []


async def test_after_unfriending_no_more_comments(client, db_session, cast):
    assert (await _post(client, cast.bob, cast.meal.id, "之前")).status_code == 201
    await unfriend(db_session, cast.alice, cast.bob)

    assert (await _post(client, cast.bob, cast.meal.id, "之後")).status_code == 404
    assert await _bodies(db_session, cast.meal) == ["之前"]


async def test_comments_are_limited_per_person(client, cast):
    for index in range(COMMENT_LIMIT):
        assert (await _post(client, cast.bob, cast.meal.id, f"第{index}則")).status_code == 201

    blocked = await _post(client, cast.bob, cast.meal.id, "太多了")

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_COMMENTS"
    assert 1 <= int(blocked.headers["Retry-After"]) <= 60
    assert (await _post(client, cast.carol, cast.meal.id)).status_code == 201


# ---------- 刪除 ----------


async def _delete(client, user, meal_id, comment_id):
    return await client.delete(_url(meal_id, comment_id), headers=auth(user))


async def test_the_author_deletes_their_own_and_only_that_one(client, db_session, cast):
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="我的")
    await create_comment(db_session, meal=cast.meal, user=cast.bob, body="也是我的")

    response = await _delete(client, cast.bob, cast.meal.id, mine.id)

    assert response.status_code == 204 and response.content == b""
    assert await _bodies(db_session, cast.meal) == ["也是我的"]
    # 再刪一次：已經不在了。
    assert (await _delete(client, cast.bob, cast.meal.id, mine.id)).status_code == 404


async def test_the_owner_deletes_anyones_comment_on_their_meal(client, db_session, cast):
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.carol)

    assert (await _delete(client, cast.alice, cast.meal.id, theirs.id)).status_code == 204
    assert await _bodies(db_session, cast.meal) == []


async def test_a_third_person_cannot_delete_someone_elses_comment(client, db_session, cast):
    """小卡看得到鮑伯的留言（所以「看不到這一餐」那道過濾無效），但那不是她的、餐也不是她的。"""
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")

    refused = await _delete(client, cast.carol, cast.meal.id, theirs.id)
    missing = await _delete(client, cast.carol, cast.meal.id, MISSING)

    assert refused.status_code == missing.status_code == 404
    assert refused.content == missing.content
    assert refused.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


async def test_owning_another_meal_does_not_let_you_delete_through_it(client, db_session, cast):
    """IDOR：小卡是**她自己那一餐**的主人；把別的餐的留言 id 掛在自己的餐底下刪。"""
    theirs = await create_comment(db_session, meal=cast.meal, user=cast.bob, body="鮑伯的")
    carols_meal = await create_meal(db_session, user=cast.carol)

    response = await _delete(client, cast.carol, carols_meal.id, theirs.id)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "COMMENT_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["鮑伯的"]


@pytest.mark.parametrize("who", ["dan", "eve"])
async def test_who_cannot_see_the_meal_cannot_delete(client, db_session, cast, who):
    viewer = getattr(cast, who)
    own = await create_comment(db_session, meal=cast.meal, user=viewer, body="混進來的")

    response = await _delete(client, viewer, cast.meal.id, own.id)

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEAL_NOT_FOUND"
    assert await _bodies(db_session, cast.meal) == ["混進來的"]


async def test_an_unfriended_author_can_no_longer_delete(client, db_session, cast):
    """規格 §9.1 第 2 點（已知限制）：看不到那一餐了，留言被藏起來、也收不回來。"""
    mine = await create_comment(db_session, meal=cast.meal, user=cast.bob)
    await unfriend(db_session, cast.alice, cast.bob)

    assert (await _delete(client, cast.bob, cast.meal.id, mine.id)).status_code == 404
    # 主人還是刪得掉——就算它現在不顯示。
    assert (await _delete(client, cast.alice, cast.meal.id, mine.id)).status_code == 204


async def test_comments_need_a_login(client, cast):
    assert (await client.post(_url(cast.meal.id), json={"body": "嗨"})).status_code == 401
    assert (await client.delete(_url(cast.meal.id, 1))).status_code == 401
```

Run → Expected：FAIL（405／404）。

- [ ] **Step 2：schema。** `app/schemas/social.py` 加（import `Annotated`、`AfterValidator`、`Field`、`single_line`）：

```python
COMMENT_MAX_LENGTH = 200


def _clean_comment(value: str) -> str:
    """留言是不可信的文字、會顯示給別人：先清成一行，**清完之後**才量長度。"""
    cleaned = single_line(value)
    if not cleaned:
        raise ValueError("留言不能是空的")
    if len(cleaned) > COMMENT_MAX_LENGTH:
        raise ValueError(f"留言最多 {COMMENT_MAX_LENGTH} 個字")
    return cleaned


class CommentCreate(BaseModel):
    # 1000 是清理**之前**的長度（同 MealCreateRequest.description 的寫法）：擋掉超大的 body，
    # 又不會因為貼上的文字多了幾個換行就 422。
    body: Annotated[str, AfterValidator(_clean_comment)] = Field(max_length=1000)
```

- [ ] **Step 3：端點。** `app/api/routes/social.py` 加（import `status`、`comment_rate_limiter`、`CommentCreate`）：

```python
@router.post(
    "/meals/{meal_id}/comments",
    status_code=status.HTTP_201_CREATED,
    response_model=CommentResponse,
)
async def add_comment(
    meal_id: ResourceId,
    payload: CommentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CommentResponse:
    """留言。看得到這一餐的人都可以，包含主人自己。不能改，只能刪掉重寫。"""
    comment_rate_limiter.hit(str(user.id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    comment = MealComment(meal_id=meal.id, user_id=user.id, body=payload.body)
    db.add(comment)
    await db.commit()
    await db.refresh(comment)
    return _comment_response(
        comment, user.display_name, viewer_id=user.id, owner_id=meal.user_id
    )


@router.delete(
    "/meals/{meal_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT
)
async def delete_comment(
    meal_id: ResourceId,
    comment_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪留言：作者刪自己的，餐的主人刪這一餐底下任何一則。

    條件全部在一個 DELETE 的 WHERE 裡——留言 id、**它屬於路徑上的這一餐**、我有權刪。
    不存在、屬於另一餐、看得到但不是我的，都是同一個 404。"""
    meal = await load_visible_meal(db, user, meal_id)
    conditions = [MealComment.id == comment_id, MealComment.meal_id == meal.id]
    if meal.user_id != user.id:
        # 不是主人：只能刪自己寫的。
        conditions.append(MealComment.user_id == user.id)
    deleted = await db.scalar(delete(MealComment).where(*conditions).returning(MealComment.id))
    if deleted is None:
        raise NotFoundError("COMMENT_NOT_FOUND", "找不到這則留言")
    await db.commit()
```

- [ ] **Step 4：跑。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_social_comments.py`
Expected：**25 passed**（新增 1＋1＋1＋9＋1＋2＋1＋1＝17；刪除 1＋1＋1＋1＋2＋1＋1＝8）。

- [ ] **Step 5：突變。**

| 突變 | 該紅的 |
|---|---|
| `_clean_comment` 不清理（`cleaned = value.strip()`） | `…cleaned_into_one_safe_line`、`…after_cleaning[200-padded]`、`[control]` |
| 長度改量清理之前（`len(value)`） | `…after_cleaning[200-padded]` |
| `COMMENT_MAX_LENGTH = 201` | `[201]`——而且是**資料庫的 CHECK** 把它擋成 500（`IntegrityError` 從 `client.post` 冒出來）。那是另一道防線：照實記下紅的樣子（規矩 8） |
| 拿掉 `if not cleaned` | `[empty]`、`[blank]`、`[control]`（同上，是 CHECK 擋的） |
| `Field(max_length=1000)` 拿掉 | `[raw]`？**不會**——清理之後的 200 上限先擋。這個上限守的是「不要把 10 MB 的字串送進正規表示式」，沒有測試看得到；**預期存活**，照實記下 |
| `add_comment`、`delete_comment` 的 `load_visible_meal` 換成 `db.get(Meal, meal_id)` | `…cannot_comment` 兩條、`…no_more_comments`、`…cannot_delete` 兩條、`…unfriended_author…` |
| `delete_comment` 拿掉 `MealComment.meal_id == meal.id` | `test_owning_another_meal…` |
| 拿掉「不是主人只能刪自己的」那個 `if` | `test_a_third_person…` |
| `if meal.user_id != user.id` 反過來 | `test_the_owner_deletes_anyones…`、`test_a_third_person…` |
| `comment_rate_limiter.hit` 拿掉；`COMMENT_LIMIT = 21` | `test_comments_are_limited_per_person` |
| `_comment_response` 的 `display_name` 傳成 `user.email` | `test_a_friend_comments…` |

- [ ] **Step 6：`schema.d.ts`、整套、commit。** 重新產生（多兩個 operation、一個 schema）→ `cd frontend && npm run -s typecheck`（綠）。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/schemas/social.py app/api/routes/social.py tests/test_social_comments.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task4-msg.txt"   # feat(backend): 留言——清成一行、1 到 200 字；作者與餐的主人可以刪
```

---

## Task 5：後端——讚與留言的通知、通知的三個端點

**Files:**
- Create: `app/notifications.py`、`app/api/routes/notifications.py`、`tests/test_notifications.py`
- Modify: `app/social_visibility.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`app/main.py`、`tests/test_social_likes_concurrency.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1：測試。** `tests/test_notifications.py`（檔頭的 `cast` 夾具同 Task 3；這裡的通知**都經過端點產生**，不直接寫表——要測的就是端點有沒有寫）：

```python
"""通知：誰收到、什麼時候消失、已讀（社群規格 §4.3、§5.5、D11–D15）。"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select, update

from app.models.social import Notification, NotificationType
from tests.factories import create_comment, create_friendship
from tests.social_helpers import auth, make_cast, unfriend


@pytest.fixture
async def cast(db_session):
    return await make_cast(db_session)


async def _like(client, user, meal):
    response = await client.put(f"/api/social/meals/{meal.id}/like", headers=auth(user))
    assert response.status_code == 200


async def _unlike(client, user, meal):
    response = await client.delete(f"/api/social/meals/{meal.id}/like", headers=auth(user))
    assert response.status_code == 200


async def _comment(client, user, meal, body="好吃嗎") -> int:
    response = await client.post(
        f"/api/social/meals/{meal.id}/comments", headers=auth(user), json={"body": body}
    )
    assert response.status_code == 201
    return response.json()["id"]


async def _inbox(client, user) -> list[dict]:
    response = await client.get("/api/notifications", headers=auth(user))
    assert response.status_code == 200
    assert set(response.json()) == {"items"}
    return response.json()["items"]


async def _unread(client, user) -> int:
    response = await client.get("/api/notifications/unread-count", headers=auth(user))
    assert response.status_code == 200
    return response.json()["count"]


def _who_did_what(items) -> list[tuple[str, str]]:
    return [(item["actor_name"], item["type"]) for item in items]


# ---------- 寫入 ----------


async def test_a_like_tells_the_owner_and_nobody_else(client, cast):
    await _like(client, cast.bob, cast.meal)

    [item] = await _inbox(client, cast.alice)
    assert set(item) == {
        "id", "type", "actor_name", "meal", "comment_preview", "created_at", "is_read",
    }
    assert (item["type"], item["actor_name"], item["is_read"]) == ("like", "鮑伯", False)
    assert item["meal"] == {
        "id": cast.meal.id,
        "meal_type": "lunch",
        "eaten_at": "2026-10-06T04:00:00Z",
    }
    assert item["comment_preview"] is None
    assert await _unread(client, cast.alice) == 1
    # 按的人自己、同一餐上的另一個好友：都沒有通知。
    assert await _inbox(client, cast.bob) == [] and await _inbox(client, cast.carol) == []


async def test_liking_twice_or_unliking_and_reliking_never_piles_up(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.bob, cast.meal)
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]

    await _unlike(client, cast.bob, cast.meal)
    assert await _inbox(client, cast.alice) == []
    assert await db_session.scalar(select(func.count()).select_from(Notification)) == 0

    await _like(client, cast.bob, cast.meal)
    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]


async def test_unliking_only_removes_my_like_notification(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)
    await _comment(client, cast.bob, cast.meal)

    await _unlike(client, cast.bob, cast.meal)

    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "comment"), ("小卡", "like")]


async def test_a_comment_tells_only_the_owner(client, cast):
    """不做「跟著這串留言」（D11）：小卡先留過言，鮑伯再留，小卡不會收到。
    主人在自己的餐留言：沒有人收到。"""
    await _comment(client, cast.carol, cast.meal, "先留的")
    await _comment(client, cast.bob, cast.meal, "後留的")
    await _comment(client, cast.alice, cast.meal, "主人回覆")

    items = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["type"], i["comment_preview"]) for i in items] == [
        ("鮑伯", "comment", "後留的"),
        ("小卡", "comment", "先留的"),
    ]
    assert await _inbox(client, cast.carol) == [] and await _inbox(client, cast.bob) == []


@pytest.mark.parametrize(("length", "preview"), [(40, "字" * 40), (41, "字" * 40 + "…")])
async def test_the_preview_is_the_first_forty_characters(client, cast, length, preview):
    await _comment(client, cast.bob, cast.meal, "字" * length)

    [item] = await _inbox(client, cast.alice)
    assert item["comment_preview"] == preview


async def test_nothing_private_rides_along(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "看得到的預覽")

    response = await client.get("/api/notifications", headers=auth(cast.alice))

    assert "看得到的預覽" in response.text  # 預覽在（下面那些才不是空轉）
    for secret in ("@example.com", "actor_id", "user_id", "今天心情很差", "4321.75"):
        assert secret not in response.text


# ---------- 什麼時候消失（§4.3） ----------


async def test_deleting_the_comment_or_the_meal_takes_the_notifications(client, cast):
    comment_id = await _comment(client, cast.bob, cast.meal)
    await _like(client, cast.carol, cast.meal)

    deleted = await client.delete(
        f"/api/social/meals/{cast.meal.id}/comments/{comment_id}", headers=auth(cast.bob)
    )
    assert deleted.status_code == 204
    assert _who_did_what(await _inbox(client, cast.alice)) == [("小卡", "like")]

    assert (
        await client.delete(f"/api/meals/{cast.meal.id}", headers=auth(cast.alice))
    ).status_code == 204
    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0


async def test_unfriending_hides_their_notifications_until_they_are_back(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal, "不該留在通知裡的預覽")
    await _like(client, cast.carol, cast.meal)
    assert await _unread(client, cast.alice) == 3

    await unfriend(db_session, cast.alice, cast.bob)

    response = await client.get("/api/notifications", headers=auth(cast.alice))
    assert _who_did_what(response.json()["items"]) == [("小卡", "like")]
    assert "不該留在通知裡的預覽" not in response.text
    assert await _unread(client, cast.alice) == 1

    await create_friendship(db_session, cast.alice, cast.bob)
    assert len(await _inbox(client, cast.alice)) == 3


async def test_going_private_keeps_the_owners_notifications(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    cast.meal.is_private = True
    await db_session.commit()

    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]


# ---------- 清單的上限與順序 ----------


async def test_the_latest_fifty_newest_first(client, db_session, cast):
    for index in range(51):
        comment = await create_comment(
            db_session, meal=cast.meal, user=cast.bob, body=f"第{index}則"
        )
        db_session.add(
            Notification(
                user_id=cast.alice.id,
                actor_id=cast.bob.id,
                type=NotificationType.COMMENT,
                meal_id=cast.meal.id,
                comment_id=comment.id,
            )
        )
    await db_session.commit()

    items = await _inbox(client, cast.alice)

    assert [item["comment_preview"] for item in items] == [
        f"第{index}則" for index in range(50, 0, -1)
    ]
    assert await _unread(client, cast.alice) == 51  # 未讀數不受 50 則的上限影響


# ---------- 已讀 ----------


async def _read_all(client, user, up_to):
    return await client.post(
        "/api/notifications/read-all", headers=auth(user), json={"up_to": up_to}
    )


async def test_read_all_marks_up_to_what_was_seen_and_no_further(client, cast):
    await _like(client, cast.bob, cast.meal)
    await _comment(client, cast.bob, cast.meal)
    seen = await _inbox(client, cast.alice)
    await _like(client, cast.carol, cast.meal)  # 清單載入之後才到的

    response = await _read_all(client, cast.alice, seen[0]["id"])

    assert response.status_code == 200
    assert response.json() == {"count": 1}
    after = await _inbox(client, cast.alice)
    assert [(i["actor_name"], i["is_read"]) for i in after] == [
        ("小卡", False),
        ("鮑伯", True),
        ("鮑伯", True),
    ]
    assert await _unread(client, cast.alice) == 1


async def test_read_all_cannot_touch_someone_elses(client, db_session, cast):
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)

    response = await _read_all(client, cast.bob, item["id"] + 1000)

    assert response.json() == {"count": 0}
    assert await _unread(client, cast.alice) == 1


async def test_reading_again_does_not_restamp_what_was_already_read(client, db_session, cast):
    """共用交易裡 `now()` 不會動（整條測試是同一個外層交易）——比兩次的時間看不出差別。
    所以直接把已讀時間改成很久以前，看它有沒有被蓋掉。"""
    await _like(client, cast.bob, cast.meal)
    [item] = await _inbox(client, cast.alice)
    long_ago = datetime(2020, 1, 1, tzinfo=UTC)
    await db_session.execute(update(Notification).values(read_at=long_ago))
    await db_session.commit()

    await _read_all(client, cast.alice, item["id"])

    assert await db_session.scalar(select(Notification.read_at)) == long_ago


@pytest.mark.parametrize(
    "payload",
    [{}, {"up_to": 0}, {"up_to": -1}, {"up_to": 2**63}, {"up_to": "x"}],
    ids=["missing", "zero", "negative", "too-big", "not-a-number"],
)
async def test_read_all_validates_its_body(client, cast, payload):
    response = await client.post(
        "/api/notifications/read-all", headers=auth(cast.alice), json=payload
    )
    assert response.status_code == 422


async def test_all_three_need_a_login(client):
    assert (await client.get("/api/notifications")).status_code == 401
    assert (await client.get("/api/notifications/unread-count")).status_code == 401
    assert (await client.post("/api/notifications/read-all", json={"up_to": 1})).status_code == 401
```

`tests/test_social_likes_concurrency.py`：`check` 那一段多數一次通知（import `Notification`）：

```python
            notes = await check.scalar(
                select(func.count())
                .select_from(Notification)
                .where(Notification.meal_id == meal.id)
            )
            # 第一個「PUT」是測試自己寫的列（沒寫通知）；第二個什麼都沒新增，所以也不該寫。
            assert notes == 0
```

Run → Expected：FAIL（`/api/notifications` 404；寫入那幾條是「清單是空的」）。

- [ ] **Step 2：寫通知。** `app/notifications.py`：

```python
"""寫通知（社群規格 D11、D12、§5.7）。

**這裡的函式都不 commit**：通知跟著呼叫端的那個交易一起成立、一起消失——讚寫進去了
通知就一定在，讚被 rollback 了通知也不會留下。「誰看得到通知」不在這裡，在讀的那一層。
"""

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social import Notification, NotificationType


async def notify_like(db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int) -> None:
    """同一個人對同一餐只有一則（`uq_notifications_like`）；已經有就什麼都不做。"""
    if owner_id == actor_id:
        return
    await db.execute(
        pg_insert(Notification)
        .values(user_id=owner_id, actor_id=actor_id, type=NotificationType.LIKE, meal_id=meal_id)
        .on_conflict_do_nothing()
    )


async def forget_like(db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int) -> None:
    """收回讚：那一則通知跟著消失——不然「按了又收回」會留下一則指向不存在的讚的通知。"""
    await db.execute(
        delete(Notification).where(
            Notification.user_id == owner_id,
            Notification.actor_id == actor_id,
            Notification.meal_id == meal_id,
            Notification.type == NotificationType.LIKE,
        )
    )


def notify_comment(
    db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int, comment_id: int
) -> None:
    """只通知餐的主人；主人自己留言不通知自己。留言被刪時由 FK cascade 帶走。"""
    if owner_id == actor_id:
        return
    db.add(
        Notification(
            user_id=owner_id,
            actor_id=actor_id,
            type=NotificationType.COMMENT,
            meal_id=meal_id,
            comment_id=comment_id,
        )
    )
```

`app/api/routes/social.py` 接上去：

```python
    # like_meal：原本的 execute 換成這一段
    inserted = await db.scalar(
        pg_insert(MealLike)
        .values(meal_id=meal.id, user_id=user.id)
        .on_conflict_do_nothing()
        .returning(MealLike.id)
    )
    if inserted is not None:
        # 真的新增了才通知。重複的 PUT 不會走到這裡（衝突時 RETURNING 沒有列）。
        await notify_like(db, owner_id=meal.user_id, actor_id=user.id, meal_id=meal.id)
    await db.commit()

    # unlike_meal：delete 之後、commit 之前
    await forget_like(db, owner_id=meal.user_id, actor_id=user.id, meal_id=meal.id)

    # add_comment：db.add(comment) 之後
    await db.flush()  # 要先拿到留言的 id
    notify_comment(
        db, owner_id=meal.user_id, actor_id=user.id, meal_id=meal.id, comment_id=comment.id
    )
    await db.commit()
```

- [ ] **Step 3：讀通知的過濾。** `app/social_visibility.py` 檔尾加（import `Notification`、`NotificationType`；寫計畫時跑過）：

```python
def notification_visible() -> ColumnElement[bool]:
    """這則通知現在還看不看得到（規格 §4.3）。跟 `Notification` 一起用在 WHERE 裡。

    - 好友邀請：那個邀請**還在等**（接受、拒絕、收回之後就不顯示）。
    - 其他三種：做這件事的人現在是我的好友——解除之後，他留言的預覽不會留在我的通知裡。

    餐或留言被刪的情況不用管：FK cascade 已經把那一列帶走了。"""
    pair = (Notification.user_id, Notification.actor_id)
    still_pending = exists().where(
        Friendship.status == FriendshipStatus.PENDING,
        Friendship.requested_by == Notification.actor_id,
        *_pair(*pair),
    )
    is_request = Notification.type == NotificationType.FRIEND_REQUEST
    return or_(and_(is_request, still_pending), and_(~is_request, _are_friends(*pair)))
```

- [ ] **Step 4：schema 與端點。** `app/schemas/social.py` 加（import `MealType`、`NotificationType`）：

```python
class NotificationMeal(BaseModel):
    """畫「你的午餐」與連結所需要的最少欄位。"""

    id: int
    meal_type: MealType
    eaten_at: datetime


class NotificationItem(BaseModel):
    id: int
    type: NotificationType
    # 只有名字（D9）。
    actor_name: str
    # 讚與留言才有；好友的兩種是 None。
    meal: NotificationMeal | None
    comment_preview: str | None
    created_at: datetime
    is_read: bool


class NotificationsResponse(BaseModel):
    items: list[NotificationItem]


class UnreadCount(BaseModel):
    count: int


class ReadAllRequest(BaseModel):
    # 清單裡最新那一則的 id：之後才到的通知不會沒被看過就變成已讀（D15）。
    up_to: int = Field(gt=0, lt=2**63)
```

`app/api/routes/notifications.py`（`app/main.py` 註冊在 `social` 後面）：

```python
"""通知（社群規格 §5.5）。三個端點都只碰「收件人是我」的列。"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.models.meal import Meal
from app.models.social import MealComment, Notification
from app.models.user import User
from app.schemas.social import (
    NotificationItem,
    NotificationMeal,
    NotificationsResponse,
    ReadAllRequest,
    UnreadCount,
)
from app.social_visibility import notification_visible

router = APIRouter(prefix="/notifications", tags=["notifications"])

# 清單只回最近這麼多則（規格 D22）；這一版不自動刪舊的。
NOTIFICATIONS_SHOWN = 50
PREVIEW_LENGTH = 40


def _preview(body: str | None) -> str | None:
    if body is None or len(body) <= PREVIEW_LENGTH:
        return body
    return body[:PREVIEW_LENGTH] + "…"


@router.get("", response_model=NotificationsResponse)
async def list_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationsResponse:
    """最近 50 則，新的在前。一次查詢：動作者的名字、餐、留言都 join 回來。"""
    rows = (
        await db.execute(
            select(Notification, User.display_name, Meal.meal_type, Meal.eaten_at, MealComment.body)
            .join(User, User.id == Notification.actor_id)
            .outerjoin(Meal, Meal.id == Notification.meal_id)
            .outerjoin(MealComment, MealComment.id == Notification.comment_id)
            .where(Notification.user_id == user.id, notification_visible())
            .order_by(Notification.id.desc())
            .limit(NOTIFICATIONS_SHOWN)
        )
    ).all()
    return NotificationsResponse(
        items=[
            NotificationItem(
                id=note.id,
                type=note.type,
                actor_name=actor_name,
                meal=(
                    None
                    if note.meal_id is None or meal_type is None or eaten_at is None
                    else NotificationMeal(id=note.meal_id, meal_type=meal_type, eaten_at=eaten_at)
                ),
                comment_preview=_preview(body),
                created_at=note.created_at,
                is_read=note.read_at is not None,
            )
            for note, actor_name, meal_type, eaten_at, body in rows
        ]
    )


async def _unread(db: AsyncSession, user_id: int) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.read_at.is_(None),
            notification_visible(),
        )
    )
    return count or 0


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCount:
    """分頁上的數字。跟清單同一個過濾，但不受 50 則的上限影響。"""
    return UnreadCount(count=await _unread(db, user.id))


@router.post("/read-all", response_model=UnreadCount)
async def read_all(
    payload: ReadAllRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCount:
    """把我的、`id <= up_to`、還沒讀的標成已讀；回剩下的未讀數。

    不套可見性的過濾：現在看不到的（對方已經解除好友）一起標掉沒有壞處。"""
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == user.id,
            Notification.id <= payload.up_to,
            Notification.read_at.is_(None),
        )
        .values(read_at=func.now())
    )
    await db.commit()
    return UnreadCount(count=await _unread(db, user.id))
```

- [ ] **Step 5：跑。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_notifications.py tests/test_social_likes.py tests/test_social_comments.py tests/test_social_likes_concurrency.py tests/test_friend_meals.py`
Expected：`test_notifications.py` **20 passed**（寫入 1＋1＋1＋1＋2＋1；消失 1＋1＋1；上限 1；已讀 1＋1＋1＋5＋1）；其餘照舊。`eaten_at` 的字串如果是 `+00:00` 結尾而不是 `Z`，照實改測試裡的那一個字串。

- [ ] **Step 6：突變。**

| 突變 | 該紅的 |
|---|---|
| `like_meal` 拿掉 `if inserted is not None`（沒新增也通知） | 並行那一條（`notes == 1`） |
| `notify_like` 的 `.on_conflict_do_nothing()` 拿掉 | **預期存活**：有上面那個 `if`，經過端點寫不出「讚是新的、通知已經在」的狀態。它是第二道防線（哪天有別的路徑寫通知），照實記 |
| 兩個一起拿掉 | `test_liking_twice…`（`uq_notifications_like` 擋成例外） |
| `unlike_meal` 不呼叫 `forget_like` | `test_liking_twice…`（收回之後還在） |
| `forget_like` 拿掉 `type == LIKE`；拿掉 `actor_id == …` | `test_unliking_only_removes_my_like_notification`（留言的通知、小卡的讚也被刪） |
| `notify_comment`／`notify_like` 拿掉 `owner_id == actor_id` 的 return | `test_a_comment_tells_only_the_owner`（CHECK `not_self` 擋成例外——照實記）；讚那一個沒有路徑走得到（主人按讚先 422），**預期存活** |
| `notify_comment` 的 `user_id=owner_id` 改成通知所有留過言的人 | 不用做——`test_a_comment_tells_only_the_owner` 的小卡那一半守著 |
| `notification_visible` 的 `_are_friends(*pair)` 換成 `true()` | `test_unfriending_hides_their_notifications…` |
| `list_notifications` 拿掉 `Notification.user_id == user.id` | `test_a_like_tells_the_owner_and_nobody_else`（鮑伯也看到） |
| `.order_by(Notification.id.desc())` 改 `.asc()`；`NOTIFICATIONS_SHOWN = 51` | `test_the_latest_fifty_newest_first` |
| `_unread` 拿掉 `read_at.is_(None)`；拿掉 `notification_visible()` | `test_read_all_marks…`；`test_unfriending_hides…` |
| `PREVIEW_LENGTH = 41`；`<=` 改 `<` | `test_the_preview…[41]`；`[40]` |
| `read_all` 拿掉 `id <= payload.up_to`；拿掉 `user_id == user.id`；拿掉 `read_at.is_(None)` | `test_read_all_marks…`；`…cannot_touch_someone_elses`；`test_reading_again_does_not_restamp…` |
| `ReadAllRequest` 的 `gt=0` 拿掉；`lt=2**63` 拿掉 | `test_read_all_validates_its_body[zero]`、`[negative]`；`[too-big]`（asyncpg 的 `DataError` 冒出來） |

- [ ] **Step 7：`schema.d.ts`、整套、commit。** 重新產生（三條路徑、五個 schema）→ `cd frontend && npm run -s typecheck`。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/notifications.py app/api/routes/notifications.py app/social_visibility.py app/schemas/social.py app/api/routes/social.py app/main.py tests/test_notifications.py tests/test_social_likes_concurrency.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task5-msg.txt"   # feat(backend): 通知——讚與留言寫給餐的主人；清單、未讀數、已讀
```

---

## Task 6：後端——好友邀請與接受的通知

這個 task 可以整個不做（規格 D14 是「便宜才做」）：不做的話前端 Task 10 的四種文字少兩種，其餘不受影響。做的話只動 `friends.py` 的兩個函式。

**Files:**
- Modify: `app/notifications.py`、`app/api/routes/friends.py`、`tests/test_notifications.py`

- [ ] **Step 1：測試。** `tests/test_notifications.py` 檔尾加（import `format_friend_code`）：

```python
# ---------- 好友的通知（規格 D14、§5.7） ----------


async def _send_request(client, sender, target):
    response = await client.post(
        "/api/friends/requests",
        headers=auth(sender),
        json={"code": format_friend_code(target.friend_code)},
    )
    assert response.status_code in (200, 201), response.text
    return response


async def _pending_id(client, user, box: str, other) -> int:
    """`user` 的收件匣（incoming）或寄件匣（outgoing）裡，跟 `other` 的那一個邀請。
    用人去找：`make_cast` 裡阿丁給愛麗絲的邀請一直都在。"""
    requests = (await client.get("/api/friends/requests", headers=auth(user))).json()
    [request] = [r for r in requests[box] if r["person"]["id"] == other.id]
    return request["id"]


async def test_a_friend_request_tells_the_receiver(client, cast):
    await _send_request(client, cast.eve, cast.alice)

    [item] = await _inbox(client, cast.alice)
    assert (item["type"], item["actor_name"], item["meal"], item["comment_preview"]) == (
        "friend_request", "伊芙", None, None,
    )
    assert await _inbox(client, cast.eve) == []


async def test_accepting_tells_the_sender_and_retires_the_request_notice(client, cast):
    await _send_request(client, cast.eve, cast.alice)
    request_id = await _pending_id(client, cast.alice, "incoming", cast.eve)

    accepted = await client.post(
        f"/api/friends/requests/{request_id}/accept", headers=auth(cast.alice)
    )

    assert accepted.status_code == 200
    assert _who_did_what(await _inbox(client, cast.eve)) == [("愛麗絲", "friend_accepted")]
    # 邀請不在等了：收件人那一則不再顯示，未讀數也不算它。
    assert await _inbox(client, cast.alice) == []
    assert await _unread(client, cast.alice) == 0


@pytest.mark.parametrize(
    ("who_deletes", "box", "other"),
    [("alice", "incoming", "eve"), ("eve", "outgoing", "alice")],
)
async def test_rejecting_or_withdrawing_hides_the_request_notice(
    client, cast, who_deletes, box, other
):
    await _send_request(client, cast.eve, cast.alice)
    assert len(await _inbox(client, cast.alice)) == 1
    actor = getattr(cast, who_deletes)
    request_id = await _pending_id(client, actor, box, getattr(cast, other))

    deleted = await client.delete(f"/api/friends/requests/{request_id}", headers=auth(actor))

    assert deleted.status_code == 204
    assert await _inbox(client, cast.alice) == []


async def test_sending_to_someone_who_already_asked_makes_friends_and_tells_them(client, cast):
    """阿丁的邀請還在等（`make_cast`）；愛麗絲用他的好友碼送邀請 → 直接成立。"""
    response = await _send_request(client, cast.alice, cast.dan)

    assert response.json()["status"] == "accepted"
    assert _who_did_what(await _inbox(client, cast.dan)) == [("愛麗絲", "friend_accepted")]
    assert await _inbox(client, cast.alice) == []


async def test_asking_again_after_a_rejection_leaves_one_fresh_notice(client, db_session, cast):
    await _send_request(client, cast.eve, cast.alice)
    [first] = await _inbox(client, cast.alice)
    await client.post(
        "/api/notifications/read-all", headers=auth(cast.alice), json={"up_to": first["id"]}
    )
    request_id = await _pending_id(client, cast.alice, "incoming", cast.eve)
    await client.delete(f"/api/friends/requests/{request_id}", headers=auth(cast.alice))

    await _send_request(client, cast.eve, cast.alice)

    [again] = await _inbox(client, cast.alice)  # 一則，不是兩則
    assert again["id"] != first["id"] and again["is_read"] is False
    total = await db_session.scalar(select(func.count()).select_from(Notification))
    assert total == 1


async def test_unfriending_hides_the_accepted_notice(client, db_session, cast):
    await _send_request(client, cast.eve, cast.alice)
    request_id = await _pending_id(client, cast.alice, "incoming", cast.eve)
    await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(cast.alice))
    assert len(await _inbox(client, cast.eve)) == 1

    await unfriend(db_session, cast.alice, cast.eve)

    assert await _inbox(client, cast.eve) == []


async def test_becoming_friends_again_keeps_their_older_notifications(client, db_session, cast):
    """好友通知「只留最新一則」的那個 DELETE 不能掃到讚與留言的通知。"""
    await _like(client, cast.bob, cast.meal)
    await unfriend(db_session, cast.alice, cast.bob)
    await _send_request(client, cast.bob, cast.alice)
    request_id = await _pending_id(client, cast.alice, "incoming", cast.bob)
    await client.post(f"/api/friends/requests/{request_id}/accept", headers=auth(cast.alice))

    assert _who_did_what(await _inbox(client, cast.alice)) == [("鮑伯", "like")]
```

Run → Expected：FAIL（清單是空的）。

- [ ] **Step 2：實作。** `app/notifications.py` 加：

```python
_FRIEND_TYPES = (NotificationType.FRIEND_REQUEST, NotificationType.FRIEND_ACCEPTED)


async def notify_friend(
    db: AsyncSession, *, to: int, actor: int, kind: NotificationType
) -> None:
    """好友邀請（`to` 收到 `actor` 的邀請）或接受（`actor` 接受了 `to` 的邀請）。

    先刪掉同一個方向的舊好友通知：拒絕之後再邀請、解除之後再加回來，都只有最新的一則。"""
    await db.execute(
        delete(Notification).where(
            Notification.user_id == to,
            Notification.actor_id == actor,
            Notification.type.in_(_FRIEND_TYPES),
        )
    )
    db.add(Notification(user_id=to, actor_id=actor, type=kind))
```

`app/api/routes/friends.py`（import `notify_friend`、`NotificationType`）：

```python
# _insert_request：try 區塊改成
    try:
        # 先 flush 讓唯一約束說話：下面的 DELETE 會觸發 autoflush，IntegrityError 要落在這個 try 裡。
        await db.flush()
        await notify_friend(
            db,
            to=user_b if requested_by == user_a else user_a,
            actor=requested_by,
            kind=NotificationType.FRIEND_REQUEST,
        )
        await db.commit()
    except IntegrityError:
        # （原本的處理不動）

# _accept：`accepted_at, user_a, user_b = row` 之後、return 之前
    other_id = user_b if user_a == receiver_id else user_a
    # 跟接受在同一個交易：呼叫端 commit 才成立，接受落空（rollback）就不會留下通知。
    await notify_friend(
        db, to=other_id, actor=receiver_id, kind=NotificationType.FRIEND_ACCEPTED
    )
    return _Accepted(since=accepted_at, other_id=other_id)
```

- [ ] **Step 3：跑。** `./.venv/Scripts/python.exe -m pytest -q -W error tests/test_notifications.py tests/test_friend_requests.py tests/test_friend_meals.py`
Expected：`test_notifications.py` **28 passed**（20＋8）；`test_friend_requests.py` **一條都不能紅**——它有三條用 monkeypatch 建構競態的測試（`_load_pair` 第一次看不到、`_accept` 落空），`_insert_request` 的 `IntegrityError` 路徑變了就會在那裡現形。掃描測試照舊綠（`friends.py` 本來就在兩份名單裡）。

- [ ] **Step 4：突變。**

| 突變 | 該紅的 |
|---|---|
| `_insert_request` 的 `to=` 寫反（通知寄給送邀請的人） | `test_a_friend_request_tells_the_receiver`（CHECK `not_self` 擋成例外——照實記） |
| `_insert_request` 拿掉 `await db.flush()` | `test_friend_requests.py` 的並行互送那一條**可能仍然綠**（autoflush 的例外也落在 try 裡）——那行是讓順序明確，不是唯一的保證；照實記 |
| `notify_friend` 拿掉前面的 `delete` | `test_asking_again_after_a_rejection…` |
| `delete` 拿掉 `type.in_(…)` | `test_becoming_friends_again_keeps_their_older_notifications` |
| `_accept` 不寫通知 | `test_accepting_tells_the_sender…`、`test_sending_to_someone_who_already_asked…` |
| `notification_visible` 的 `still_pending` 拿掉 `requested_by == actor_id` | **預期存活**（一對人只有一列 pending，方向不對的通知寫不出來）；照實記 |
| `still_pending` 的 `PENDING` 改成 `ACCEPTED` | `test_a_friend_request_tells_the_receiver`、`test_accepting_tells_the_sender…` |

- [ ] **Step 5：整套、commit。** 這個 task 動了 `routes/friends.py`（沒有改 docstring 的話 `schema.d.ts` 不會變——**照樣重新產生一次**確認 `git diff --stat frontend/src/api/schema.d.ts` 是空的）。

```bash
./.venv/Scripts/python.exe -m pytest -q -W error && ./.venv/Scripts/python.exe -m ruff check . && ./.venv/Scripts/python.exe -m mypy app
git add app/notifications.py app/api/routes/friends.py tests/test_notifications.py
git commit -F "$S/social-plan-task6-msg.txt"   # feat(backend): 好友邀請與接受也有通知
```

後端到這裡做完。量一次：`./.venv/Scripts/python.exe -m pytest -q -W error` 的條數、`grep -c "@router\." app/api/routes/*.py` 的加總（Expected：79＋8＝**87**），記下來給 Task 12。

---

