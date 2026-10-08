"""兩條真的連線同時兌換同一條重設連結——只有一條成功。

同 `tests/test_invites_concurrency.py`：共用一個交易的夾具裡看不見「兩個交易互相等待」
（handover §6 第 14 種）。這裡寫進去的資料是真的 commit 的，`finally` 自己清
（刪使用者時 `password_reset_tokens` 會 CASCADE）。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select, update
from sqlalchemy.exc import DBAPIError
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.auth import reset_password
from app.errors import ForbiddenError
from app.models.password_reset import PasswordResetToken
from app.models.user import User, UserRole
from app.password_resets import (
    RESET_LIFETIME,
    hash_reset_token,
    new_reset_token,
    redeem_reset,
    revoke_live_resets,
)
from app.schemas.password_reset import PasswordResetRequest
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


async def test_a_reset_waiting_for_the_user_row_is_not_holding_the_link_row(independent_sessions):
    """鎖的順序是**先使用者列、再連結列**（審查 M3）——改密碼、管理員產生連結、CLI 都是這個順序。

    重設原本反過來（先兌換連結、再改 `users`）：它握著連結列等使用者列的同時，改密碼握著
    使用者列要去撤銷連結列——兩邊互等，PostgreSQL 一秒後挑一個砍掉（40P01），那個請求變成 500。

    這裡**不等死結真的發生**（那要賭 `deadlock_timeout`）：讓另一條連線先握住使用者列（改密碼
    的第一步），等重設真的卡在鎖上，再用 `FOR UPDATE NOWAIT` 直接問「連結列現在有人握著嗎」。
    順序對的話沒有人握著，改密碼那一側接著撤銷連結、commit；重設醒來之後兌換落空 → 同一個 403，
    密碼是改密碼那一側的。
    """
    admin, user = _user("admin", UserRole.ADMIN), _user("user")
    token = new_reset_token()
    async with independent_sessions() as setup:
        setup.add_all([admin, user])
        await setup.flush()
        now = datetime.now(UTC)
        reset = PasswordResetToken(
            user_id=user.id,
            token_hash=hash_reset_token(token),
            created_by=admin.id,
            created_at=now,
            expires_at=now + RESET_LIFETIME,
        )
        setup.add(reset)
        await setup.commit()
    user_id, reset_id = user.id, reset.id

    async def redeem_over_http_handler() -> ForbiddenError | None:
        async with independent_sessions() as s:
            try:
                await reset_password(
                    PasswordResetRequest(token=token, new_password="reset-new-password"), s
                )
            except ForbiddenError as exc:
                return exc
            return None

    try:
        async with independent_sessions() as changer:
            # 改密碼的第一步：使用者列。
            await changer.execute(
                update(User).where(User.id == user_id).values(password_hash="changed-elsewhere")
            )
            changer_pid = await changer.scalar(select(func.pg_backend_pid()))

            attempt = asyncio.create_task(redeem_over_http_handler())
            async with asyncio.timeout(10.0):
                await _wait_until_someone_else_is_lock_waiting(changer_pid)

            try:
                await changer.execute(
                    select(PasswordResetToken.id)
                    .where(PasswordResetToken.id == reset_id)
                    .with_for_update(nowait=True)
                )
            except DBAPIError:
                await changer.rollback()  # 放掉使用者列，讓重設做完，不要留一個卡住的 task
                await attempt
                pytest.fail("重設握著連結列在等使用者列——跟改密碼的順序相反，兩邊會死結")

            # 改密碼的第二步：撤銷這個人還沒用的連結，然後 commit。
            await revoke_live_resets(changer, user_id)
            await changer.commit()

            outcome = await attempt

        assert isinstance(outcome, ForbiddenError)
        assert outcome.code == "RESET_LINK_INVALID"
        async with independent_sessions() as check:
            stored_hash = await check.scalar(select(User.password_hash).where(User.id == user_id))
            link = await check.get(PasswordResetToken, reset_id)
        # 輸的那一方整筆 rollback：它在等的時候已經送出的 `UPDATE users` 沒有留下來。
        assert stored_hash == "changed-elsewhere"
        assert link is not None and link.used_at is None and link.revoked_at is not None
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id.in_([admin.id, user.id])))
            await cleanup.commit()
