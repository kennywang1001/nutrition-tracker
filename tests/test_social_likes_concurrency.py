"""按讚（與留言）的並行（社群規格 D8、§4.4）——兩條真的連線。

1. 兩個同時到的 PUT（連按兩下、兩台裝置）：都成功，只有一列。
2. 主人正在把這一餐改成「只有我看得到」、還沒 commit，好友同時按讚：讚等主人 commit，
   然後是 404——不會有一則讚落在已經關起來的餐上。
3. 同一件事換成留言：留言也等，然後也是 404。

不用 `db_session`：共用一個交易的夾具看不見「一個交易在等另一個」
（handover §6 第 14 種）。資料真的 commit，`finally` 自己清。"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime

import pytest
import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes.social import add_comment, like_meal
from app.errors import NotFoundError
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal, MealType
from app.models.social import MealComment, MealLike
from app.models.user import User
from app.schemas.social import CommentCreate
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


async def _friends_and_a_meal(sessions) -> tuple[User, User, Meal]:
    """愛麗絲與鮑伯是好友，愛麗絲有一餐（公開）。真的 commit——呼叫端的 `finally` 要清。"""
    alice, bob = _user("alice"), _user("bob")
    async with sessions() as setup:
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
    return alice, bob, meal


async def _clean_up(sessions, *users: User) -> None:
    async with sessions() as cleanup:
        # 餐、讚、好友關係都跟著使用者 cascade。
        await cleanup.execute(delete(User).where(User.id.in_([user.id for user in users])))
        await cleanup.commit()


async def _like_rows(sessions, meal: Meal) -> int:
    async with sessions() as check:
        rows = await check.scalar(
            select(func.count()).select_from(MealLike).where(MealLike.meal_id == meal.id)
        )
    assert rows is not None
    return int(rows)


async def test_the_second_of_two_simultaneous_likes_waits_then_does_nothing(independent_sessions):
    alice, bob, meal = await _friends_and_a_meal(independent_sessions)

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

        assert await _like_rows(independent_sessions, meal) == 1
    finally:
        await _clean_up(independent_sessions, alice, bob)


async def test_a_like_racing_the_owner_closing_the_meal_waits_and_is_then_refused(
    independent_sessions,
):
    """規格 §4.4。沒有 `FOR SHARE` 的話：按讚那一條讀到的是還沒被改的那一版（MVCC 看不到
    沒 commit 的修改），不等、直接寫進去——主人 commit 之後，一餐「只有我看得到」的餐上
    多了一個剛剛才落下的讚。有鎖：等主人 commit，重新檢查條件，這一餐已經看不到了。"""
    alice, bob, meal = await _friends_and_a_meal(independent_sessions)

    try:
        async with independent_sessions() as owner_side, independent_sessions() as friend_side:
            # 主人的 PATCH 做到一半（`update_meal` 的寫法：FOR UPDATE 載入、改、還沒 commit）。
            closing = await owner_side.scalar(
                select(Meal).where(Meal.id == meal.id).with_for_update()
            )
            assert closing is not None
            closing.is_private = True
            await owner_side.flush()
            owner_pid = await owner_side.scalar(select(func.pg_backend_pid()))

            bob_again = await friend_side.get(User, bob.id)
            assert bob_again is not None
            attempt = asyncio.create_task(like_meal(meal.id, user=bob_again, db=friend_side))
            try:
                async with asyncio.timeout(5.0):
                    await _wait_until_someone_else_is_lock_waiting(owner_pid)
            except TimeoutError as exc:
                raise AssertionError("按讚沒有等主人的交易——讚可以落在正在關起來的餐上") from exc
            await owner_side.commit()

            with pytest.raises(NotFoundError) as refused:
                await attempt
            assert refused.value.code == "MEAL_NOT_FOUND"

        assert await _like_rows(independent_sessions, meal) == 0
    finally:
        await _clean_up(independent_sessions, alice, bob)


async def test_a_comment_racing_the_owner_closing_the_meal_waits_and_is_then_refused(
    independent_sessions,
):
    """規格 §4.4 的另一半：留言寫入時也鎖。沒有鎖的話，主人關門的那一瞬間還會落下一則
    留言——而且主人會收到它的通知。"""
    alice, bob, meal = await _friends_and_a_meal(independent_sessions)

    try:
        async with independent_sessions() as owner_side, independent_sessions() as friend_side:
            closing = await owner_side.scalar(
                select(Meal).where(Meal.id == meal.id).with_for_update()
            )
            assert closing is not None
            closing.is_private = True
            await owner_side.flush()
            owner_pid = await owner_side.scalar(select(func.pg_backend_pid()))

            bob_again = await friend_side.get(User, bob.id)
            assert bob_again is not None
            attempt = asyncio.create_task(
                add_comment(
                    meal.id, CommentCreate(body="趕在關門前"), user=bob_again, db=friend_side
                )
            )
            try:
                async with asyncio.timeout(5.0):
                    await _wait_until_someone_else_is_lock_waiting(owner_pid)
            except TimeoutError as exc:
                raise AssertionError("留言沒有等主人的交易——可以落在正在關起來的餐上") from exc
            await owner_side.commit()

            with pytest.raises(NotFoundError) as refused:
                await attempt
            assert refused.value.code == "MEAL_NOT_FOUND"

        async with independent_sessions() as check:
            rows = await check.scalar(
                select(func.count()).select_from(MealComment).where(MealComment.meal_id == meal.id)
            )
        assert rows == 0
    finally:
        await _clean_up(independent_sessions, alice, bob)
