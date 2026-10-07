"""好友讀取的唯一入口（好友規格 §1.2、§4.3）。

**這個模組與 `app/api/routes/friends.py` 是整個後端唯二碰 `Friendship` 的地方**
（`tests/test_friend_meals.py` 的掃描測試守著）。既有端點不 import 這裡——
它們照舊只回自己的資料。
"""

from collections.abc import Sequence

from sqlalchemy import ColumnElement, Select, and_, case, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal
from app.models.user import User


def ordered_pair(first: int, second: int) -> tuple[int, int]:
    """`friendships` 的 `(user_a, user_b)`：小的在前（CHECK `user_a < user_b`）。"""
    return (first, second) if first < second else (second, first)


def involves(user_id: int) -> ColumnElement[bool]:
    return or_(Friendship.user_a == user_id, Friendship.user_b == user_id)


def other_side(user_id: int) -> ColumnElement[int]:
    return case((Friendship.user_a == user_id, Friendship.user_b), else_=Friendship.user_a)


async def friend_ids(db: AsyncSession, user: User) -> list[int]:
    """已經接受的好友。邀請中的不算（規格 §6.1）；不含自己。"""
    ids = await db.scalars(
        select(other_side(user.id)).where(
            involves(user.id), Friendship.status == FriendshipStatus.ACCEPTED
        )
    )
    return list(ids)


async def load_visible_friend(db: AsyncSession, user: User, friend_id: int) -> User:
    """`friend_id` 是 `user` 已經接受的好友 → 那個人；否則 404（不分「不存在」
    「不是好友」「還在邀請中」）。"""
    user_a, user_b = ordered_pair(user.id, friend_id)
    friend: User | None = await db.scalar(
        select(User)
        .join(
            Friendship,
            and_(
                Friendship.user_a == user_a,
                Friendship.user_b == user_b,
                Friendship.status == FriendshipStatus.ACCEPTED,
            ),
        )
        .where(User.id == friend_id, User.id != user.id)
    )
    if friend is None:
        raise NotFoundError("FRIEND_NOT_FOUND", "找不到這個好友")
    return friend


def shared_meals(owner_ids: Sequence[int]) -> Select[tuple[Meal]]:
    """好友看得到的餐：屬於這些人、而且不是「只有我看得到」。
    **好友讀餐的唯一查詢起點**——動態、某一天、照片都從這裡開始。"""
    return select(Meal).where(Meal.user_id.in_(owner_ids), Meal.is_private.is_(False))
