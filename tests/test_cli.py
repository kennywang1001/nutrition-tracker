import pytest
from sqlalchemy import select

from app.cli import create_admin
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
