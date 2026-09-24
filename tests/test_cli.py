from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select

from app.cli import build_parser, cleanup_expired_sessions, create_admin, create_regular_user
from app.models.session import RefreshSession
from app.models.user import User, UserRole
from app.security.password import verify_password
from tests.factories import create_user


async def test_create_admin_creates_an_admin_user(db_session):
    await create_admin(db_session, "boss@example.com", "a-good-password", "老闆")

    user = await db_session.scalar(select(User).where(User.email == "boss@example.com"))
    assert user is not None
    assert user.role is UserRole.ADMIN
    assert verify_password("a-good-password", user.password_hash)


async def test_create_admin_promotes_an_existing_user(db_session):
    existing = await create_user(db_session, email="boss@example.com", role=UserRole.USER)

    await create_admin(db_session, "boss@example.com", "a-new-password", "老闆")

    await db_session.refresh(existing)
    assert existing.role is UserRole.ADMIN


async def test_create_admin_rejects_a_short_password(db_session):
    with pytest.raises(ValueError, match="密碼至少 8 個字元"):
        await create_admin(db_session, "boss@example.com", "short", "老闆")


async def test_create_admin_matches_an_existing_user_despite_whitespace_and_case(db_session):
    """citext 會折疊大小寫，但不會去除空白 —— 貼上時多一個尾端空格，
    就會建出第二個管理員帳號。
    """
    await create_user(db_session, email="boss@example.com", role=UserRole.USER)

    await create_admin(db_session, "  BOSS@Example.com  ", "a-good-password", "老闆")

    users = (await db_session.scalars(select(User))).all()
    assert len(users) == 1
    assert users[0].email == "boss@example.com"
    assert users[0].role is UserRole.ADMIN


async def test_create_admin_reports_created_true_for_a_new_email(db_session):
    _, created = await create_admin(db_session, "boss@example.com", "a-good-password", "老闆")

    assert created is True


async def test_create_admin_reports_created_false_for_an_existing_email(db_session):
    await create_user(db_session, email="boss@example.com", role=UserRole.USER)

    _, created = await create_admin(db_session, "boss@example.com", "a-good-password", "老闆")

    assert created is False


async def test_create_regular_user_creates_a_user(db_session):
    await create_regular_user(db_session, "member@example.com", "a-good-password", "成員")

    user = await db_session.scalar(select(User).where(User.email == "member@example.com"))
    assert user is not None
    assert user.role is UserRole.USER
    assert verify_password("a-good-password", user.password_hash)


async def test_create_regular_user_updates_an_existing_regular_user(db_session):
    """重跑種子不該失敗 —— 這個指令要能冪等地把密碼設回已知的值。"""
    existing = await create_user(db_session, email="member@example.com", role=UserRole.USER)

    user, created = await create_regular_user(
        db_session, "member@example.com", "a-new-password", "新名字"
    )

    assert created is False
    await db_session.refresh(existing)
    assert existing.role is UserRole.USER
    assert existing.display_name == "新名字"
    assert verify_password("a-new-password", existing.password_hash)


async def test_create_regular_user_refuses_to_demote_an_admin(db_session):
    """**這一條是這個 task 最重要的行為。**

    `create_admin` 對既有帳號是「提升」。如果這個指令對既有帳號是「降級」，
    那麼打錯一個 email 就會把管理員默默降成一般使用者 —— 而那件事沒有任何
    畫面會顯示出來，要到下一次登入發現進不去審核佇列才知道。

    提升是可逆的（再跑一次 `create-admin`）；在「你不知道它發生了」的情況下
    降級不是。所以這裡拒絕，而且要留著原本的密碼不動。
    """
    admin = await create_user(db_session, email="boss@example.com", role=UserRole.ADMIN)
    original_hash = admin.password_hash

    with pytest.raises(ValueError, match="已經是管理員"):
        await create_regular_user(db_session, "boss@example.com", "a-new-password", "老闆")

    await db_session.refresh(admin)
    assert admin.role is UserRole.ADMIN
    # 拒絕的意思是「什麼都沒做」，不是「角色沒改但密碼改了」
    assert admin.password_hash == original_hash


async def test_create_regular_user_rejects_a_short_password(db_session):
    with pytest.raises(ValueError, match="密碼至少 8 個字元"):
        await create_regular_user(db_session, "member@example.com", "short", "成員")


async def test_create_regular_user_matches_an_existing_user_despite_whitespace_and_case(
    db_session,
):
    """跟 create_admin 用同一套正規化 —— 兩個指令對「同一個 email」的判斷
    不一致的話，會出現「create-admin 提升了 A，create-user 卻建出了 A 的分身」。
    """
    existing = await create_user(db_session, email="member@example.com", role=UserRole.USER)

    _, created = await create_regular_user(
        db_session, "  MEMBER@Example.COM  ", "a-good-password", "成員"
    )

    assert created is False
    await db_session.refresh(existing)
    assert verify_password("a-good-password", existing.password_hash)


def test_parser_accepts_create_user():
    args = build_parser().parse_args(
        ["create-user", "member@example.com", "a-good-password", "成員"]
    )
    assert args.command == "create-user"
    assert args.email == "member@example.com"


def _session_row(user_id: int, *, expires_at: datetime) -> RefreshSession:
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
    db_session.add(_session_row(user.id, expires_at=datetime.now(UTC) - timedelta(seconds=1)))
    await db_session.commit()

    would_delete = await cleanup_expired_sessions(db_session, dry_run=True)

    assert would_delete == 1
    remaining = (await db_session.scalars(select(RefreshSession))).all()
    assert len(remaining) == 1


async def test_cleanup_persists_the_deletion(db_session):
    """`cleanup_expired_sessions` 的 `await db.commit()` 不能省略。

    跟計畫開頭那節一樣的理由：`db_session` 用 create_savepoint，`commit()`
    只是 RELEASE SAVEPOINT，「有沒有 commit」對同一個 session 在結構上
    不可觀察。實測：把這行 commit 整行刪掉，完整套件 502 全綠 ——
    production 的 `get_db` 是 per-request，session 一關就把沒 commit 的
    DELETE 丟掉，過期的列永遠不會真的被清掉，`refresh_sessions` 表只會
    一直長大。

    下面的 rollback() 把它變成可觀察：沒 commit 的話那一列還在 savepoint
    裡，rollback 會讓它復活；commit 過的不會。

    注意：`expired_jti` 要在 rollback 之前就取出來 —— rollback 之後
    session 裡所有 ORM 物件都會過期，再讀 `expired.jti` 會觸發一次同步的
    refresh 查詢，在 async 環境下直接炸 MissingGreenlet。
    """
    user = await create_user(db_session)
    expired = _session_row(user.id, expires_at=datetime.now(UTC) - timedelta(seconds=1))
    db_session.add(expired)
    await db_session.commit()
    expired_jti = expired.jti

    deleted = await cleanup_expired_sessions(db_session)
    assert deleted == 1

    await db_session.rollback()

    remaining_jtis = (
        await db_session.scalars(
            select(RefreshSession.jti).where(RefreshSession.jti == expired_jti)
        )
    ).all()
    assert remaining_jtis == []


def test_parser_accepts_cleanup_sessions():
    args = build_parser().parse_args(["cleanup-sessions", "--dry-run"])
    assert args.command == "cleanup-sessions"
    assert args.dry_run is True
