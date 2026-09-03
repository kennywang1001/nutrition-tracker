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
