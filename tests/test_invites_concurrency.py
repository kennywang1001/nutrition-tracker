"""兩條真的連線同時兌換同一張邀請——只有一條成功。

跟 `tests/test_sessions_concurrency.py` 同一個理由不用 `db_session`：共用一個交易的
夾具裡看不見「兩個交易互相等待」（handover §6 第 14 種）。這裡寫進去的資料是
真的 commit 的，`finally` 自己清。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.invites import INVITE_LIFETIME, hash_invite_token, new_invite_token, redeem_invite
from app.models.invite import Invite
from app.models.user import User, UserRole
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
        email=f"invite-race-{label}-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name=label,
        role=role,
    )


async def test_only_one_of_two_concurrent_redemptions_wins(independent_sessions):
    admin, alice, bob = _user("admin", UserRole.ADMIN), _user("alice"), _user("bob")
    async with independent_sessions() as setup:
        setup.add_all([admin, alice, bob])
        await setup.flush()
        now = datetime.now(UTC)
        invite = Invite(
            token_hash=hash_invite_token(new_invite_token()),
            created_by=admin.id,
            created_at=now,
            expires_at=now + INVITE_LIFETIME,
        )
        setup.add(invite)
        await setup.commit()

    try:
        async with independent_sessions() as first, independent_sessions() as second:
            assert await redeem_invite(first, invite.id, alice.id) is True
            first_pid = await first.scalar(select(func.pg_backend_pid()))

            # 第二條在第一條 commit 之前就開始兌換——它必須卡在那一列的鎖上，
            # 等第一條 commit 之後重新評估 WHERE，然後落空。
            second_attempt = asyncio.create_task(redeem_invite(second, invite.id, bob.id))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()

            assert await second_attempt is False
            await second.commit()

        async with independent_sessions() as check:
            stored = await check.get(Invite, invite.id)
            assert stored is not None
            assert stored.used_by == alice.id
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(Invite).where(Invite.id == invite.id))
            await cleanup.execute(delete(User).where(User.id.in_([admin.id, alice.id, bob.id])))
            await cleanup.commit()
