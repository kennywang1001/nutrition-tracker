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
| `tests/test_social_meal.py`、`test_social_likes.py`、`test_social_likes_concurrency.py`、`test_social_comments.py`、`test_notifications.py`（新）、`tests/test_friend_meals.py`、`tests/test_friend_requests.py` | 2–6 | |
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
- Create: `app/social_visibility.py`、`app/friend_meals.py`、`app/schemas/social.py`、`app/api/routes/social.py`、`tests/test_social_meal.py`
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

- [ ] **Step 6：`tests/test_social_meal.py`。**

```python
"""`GET /api/social/meals/{id}`：誰看得到一餐、看到什麼（社群規格 §4.1、§4.2、§5.1）。"""

from datetime import datetime
from decimal import Decimal
from types import SimpleNamespace

import pytest
from sqlalchemy import event

from app.models.food import FoodRevision
from app.models.friendship import Friendship, FriendshipStatus
from app.security.tokens import create_access_token
from tests.factories import (
    create_comment,
    create_expense,
    create_food,
    create_friendship,
    create_like,
    create_meal,
    create_user,
)

MISSING = 2**62  # 一定不存在的 id


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.fixture
async def cast(db_session):
    """愛麗絲是主人。鮑伯與小卡是她的好友、**彼此不是**；阿丁的邀請還在等；伊芙是陌生人。
    那一餐真的有餐費、備註、私人食物——「沒有外流」才不是空轉。"""
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
        alice=alice, bob=bob, carol=carol, dan=dan, eve=eve, meal=meal, revision=revision
    )


async def _read(client, viewer, meal_id):
    return await client.get(f"/api/social/meals/{meal_id}", headers=auth(viewer))


async def _unfriend(db_session, one, other):
    user_a, user_b = sorted((one.id, other.id))
    row = await db_session.scalar(
        Friendship.__table__.select().where(
            Friendship.user_a == user_a, Friendship.user_b == user_b
        )
    )
    assert row is not None  # 真的有東西可以解除
    await db_session.execute(
        Friendship.__table__.delete().where(
            Friendship.user_a == user_a, Friendship.user_b == user_b
        )
    )
    await db_session.commit()


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
    await _unfriend(db_session, cast.alice, cast.bob)
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
    # 餐費刻意是 4321.75：短的數字（180）會剛好出現在 id 或熱量裡。
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

    await _unfriend(db_session, cast.alice, cast.bob)
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
git add app/social_visibility.py app/friend_meals.py app/schemas/social.py app/schemas/friend.py app/api/routes/social.py app/api/routes/friends.py app/main.py tests/test_social_meal.py tests/test_friend_meals.py frontend/src/api/schema.d.ts
git commit -F "$S/social-plan-task2-msg.txt"   # feat(backend): 單一餐點的讀取——主人與好友同一個白名單、解除好友用讀取時過濾
```

---

