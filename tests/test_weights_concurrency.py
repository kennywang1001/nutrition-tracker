"""兩台裝置同時寫同一列（身體資料規格 D5、D13）：兩個都成功、只有一列。

跟 `tests/test_invites_concurrency.py` 同一個理由不用 `db_session`：共用一個交易的夾具裡
看不見「兩個交易互相等待」（handover §6 第 14 種）。這裡寫進去的資料是真的 commit 的，
`finally` 自己清（刪使用者，兩張表 cascade）。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import date
from decimal import Decimal

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.body import save_body_profile
from app.api.routes.weights import upsert_weight
from app.models.body import ActivityLevel, Goal, Sex, UserProfile, WeightEntry
from app.models.user import User
from app.schemas.body import BodyProfileRequest
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
        email=f"body-race-{label}-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name=label,
        # 明確給值：server_default 的欄位 commit 之後沒有載入，端點讀它會變成一次同步查詢。
        timezone="Asia/Taipei",
    )


async def test_two_concurrent_upserts_of_the_same_day_both_succeed(independent_sessions):
    """兩個同時到的 PUT（兩台裝置）：第二個卡在第一個的列鎖上，第一個 commit 之後走
    DO UPDATE——兩個都成功、只有一列、值是後到的。換成「先查再 INSERT」的寫法，第二個會
    撞主鍵（handover §6 第 14 種：共用 session 的端點測試看不到這件事）。"""
    user = _user("weight")
    async with independent_sessions() as setup:
        setup.add(user)
        await setup.commit()
    user_id = user.id
    day = date(2026, 10, 14)
    try:
        async with independent_sessions() as first, independent_sessions() as second:
            await upsert_weight(first, user_id, day, Decimal("80"))
            first_pid = await first.scalar(select(func.pg_backend_pid()))
            racing = asyncio.create_task(upsert_weight(second, user_id, day, Decimal("81")))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()
            saved = await racing
            await second.commit()
        async with independent_sessions() as check:
            rows = (
                await check.scalars(
                    select(WeightEntry.weight_kg).where(WeightEntry.user_id == user_id)
                )
            ).all()
        assert saved.weight_kg == Decimal("81.00")
        assert rows == [Decimal("81.00")]
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()


async def test_two_first_time_profile_saves_at_once_both_succeed(independent_sessions):
    """規格 §8.1：兩台裝置同時「第一次」存身體資料。第一個的 INSERT 還沒 commit，第二個
    （真的端點函式）卡在主鍵上；第一個 commit 之後第二個走 DO UPDATE——200、一列、值是後到的。
    換成「先查有沒有、沒有就 INSERT」，第二個會撞主鍵變 500。"""
    user = _user("profile")
    async with independent_sessions() as setup:
        setup.add(user)
        await setup.commit()
    user_id = user.id
    payload = BodyProfileRequest(
        sex=Sex.FEMALE,
        birth_year=1990,
        height_cm=Decimal("160"),
        activity_level=ActivityLevel.LIGHT,
        goal=Goal.MAINTAIN,
        rate_kg_per_week=None,
        target_weight_kg=None,
    )
    try:
        async with independent_sessions() as first, independent_sessions() as second:
            await first.execute(
                pg_insert(UserProfile).values(user_id=user_id, sex=Sex.MALE, birth_year=1980)
            )
            first_pid = await first.scalar(select(func.pg_backend_pid()))
            racing = asyncio.create_task(save_body_profile(payload, user=user, db=second))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()
            saved = await racing
        async with independent_sessions() as check:
            rows = (
                await check.execute(
                    select(UserProfile.sex, UserProfile.birth_year).where(
                        UserProfile.user_id == user_id
                    )
                )
            ).all()
        assert (saved.sex, saved.birth_year) == (Sex.FEMALE, 1990)
        assert [tuple(row) for row in rows] == [(Sex.FEMALE, 1990)]
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
