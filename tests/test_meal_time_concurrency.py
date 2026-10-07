"""兩條真的連線：一條在改這一餐的時間、還沒 commit，另一條同時幫這一餐補金額。

補的餐費 `spent_at` 要是**新的**時間（改時間規格 §3：錢屬於吃那一餐的時間）。
沒有鎖的話，補金額那條讀到的是舊的 `eaten_at`（MVCC 看不到還沒 commit 的
修改），查餐費也還沒有——改時間那條沒有餐費可以跟著改，補的那筆就帶著舊時間
寫進去，兩條都成功，報表的月份錯了。`update_meal` 用 `SELECT … FOR UPDATE`
載入這一餐，補金額那條會等改時間那條 commit 之後才讀。

跟 `tests/test_invites_concurrency.py` 同一個理由不用 `db_session`：共用一個交易
的夾具裡看不見「兩個交易互相等待」。這裡寫進去的資料是真的 commit 的，
`finally` 自己清。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime
from decimal import Decimal

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.meals import update_meal
from app.models.expense import Expense
from app.models.meal import Meal, MealType
from app.models.user import User
from app.schemas.meal import MealUpdateRequest
from tests.conftest import TEST_DATABASE_URL
from tests.test_sessions_concurrency import _wait_until_someone_else_is_lock_waiting

OCT_3 = datetime(2026, 10, 3, 4, tzinfo=UTC)  # 台北 10/3 中午
SEP_28 = datetime(2026, 9, 28, 11, tzinfo=UTC)  # 台北 9/28 晚上 7 點


@pytest_asyncio.fixture
async def independent_sessions(
    migrated_database: None,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def test_adding_a_cost_while_the_meal_is_being_moved_uses_the_new_time(
    independent_sessions,
):
    user = User(
        email=f"meal-time-race-{uuid.uuid4().hex}@example.com",
        password_hash="not-a-real-hash",
        display_name="race",
    )
    async with independent_sessions() as setup:
        setup.add(user)
        await setup.flush()
        meal = Meal(user_id=user.id, eaten_at=OCT_3, meal_type=MealType.LUNCH)
        setup.add(meal)
        await setup.commit()
    meal_id = meal.id

    try:
        async with independent_sessions() as first, independent_sessions() as second:
            first_pid = await first.scalar(select(func.pg_backend_pid()))

            # 改時間那條：走真的 update_meal，只是 commit 先擋住——模擬它做完
            # 所有讀寫、還沒 commit 的那一刻。
            reached_commit = asyncio.Event()
            release = asyncio.Event()
            real_commit = first.commit

            async def gated_commit() -> None:
                reached_commit.set()
                await release.wait()
                await real_commit()

            first.commit = gated_commit  # type: ignore[method-assign]
            moving = asyncio.create_task(
                update_meal(meal_id, MealUpdateRequest(eaten_at=SEP_28), user=user, db=first)
            )
            async with asyncio.timeout(5.0):
                await reached_commit.wait()

            # 補金額那條：它應該卡在這一餐的列鎖上。沒有鎖的話它不會等，
            # 直接帶著舊時間寫完——那就讓它寫完，下面的斷言會抓到。
            adding = asyncio.create_task(
                update_meal(meal_id, MealUpdateRequest(cost=Decimal("90")), user=user, db=second)
            )
            waiting = asyncio.create_task(_wait_until_someone_else_is_lock_waiting(first_pid))
            async with asyncio.timeout(5.0):
                await asyncio.wait({adding, waiting}, return_when=asyncio.FIRST_COMPLETED)
            waiting.cancel()

            release.set()
            async with asyncio.timeout(5.0):
                await moving
                await adding

        async with independent_sessions() as check:
            eaten_at = await check.scalar(select(Meal.eaten_at).where(Meal.id == meal_id))
            spent_at = await check.scalar(
                select(Expense.spent_at).where(Expense.meal_id == meal_id)
            )
            assert eaten_at == SEP_28
            assert spent_at == SEP_28
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(Expense).where(Expense.meal_id == meal_id))
            await cleanup.execute(delete(Meal).where(Meal.id == meal_id))
            await cleanup.execute(delete(User).where(User.id == user.id))
            await cleanup.commit()
