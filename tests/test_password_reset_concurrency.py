"""兩條真的連線同時兌換同一條重設連結——只有一條成功。

同 `tests/test_invites_concurrency.py`：共用一個交易的夾具裡看不見「兩個交易互相等待」
（handover §6 第 14 種）。這裡寫進去的資料是真的 commit 的，`finally` 自己清
（刪使用者時 `password_reset_tokens` 會 CASCADE）。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.password_reset import PasswordResetToken
from app.models.user import User, UserRole
from app.password_resets import RESET_LIFETIME, hash_reset_token, new_reset_token, redeem_reset
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


def _user(label: str, role: UserRole = UserRole.USER) -> User:
    return User(
        email=f"reset-race-{label}-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name=label,
        role=role,
    )


async def test_only_one_of_two_concurrent_redemptions_wins(independent_sessions):
    admin, user = _user("admin", UserRole.ADMIN), _user("user")
    async with independent_sessions() as setup:
        setup.add_all([admin, user])
        await setup.flush()
        now = datetime.now(UTC)
        reset = PasswordResetToken(
            user_id=user.id,
            token_hash=hash_reset_token(new_reset_token()),
            created_by=admin.id,
            created_at=now,
            expires_at=now + RESET_LIFETIME,
        )
        setup.add(reset)
        await setup.commit()

    try:
        async with independent_sessions() as first, independent_sessions() as second:
            assert await redeem_reset(first, reset.id) == user.id
            first_pid = await first.scalar(select(func.pg_backend_pid()))

            # 第二條在第一條 commit 之前開始兌換——卡在列鎖上，第一條 commit 後重新評估 WHERE、落空。
            second_attempt = asyncio.create_task(redeem_reset(second, reset.id))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()

            assert await second_attempt is None
            await second.commit()
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id.in_([admin.id, user.id])))
            await cleanup.commit()
