"""讚、留言、通知的可見性（社群規格 §4）。

**兩件事都在這裡，而且只在這裡：**

1. 看不看得到一餐（`load_visible_meal`）：主人，或主人現在的好友而且不是「只有我看得到」。
2. 一則讚或留言還算不算數（`like_counts`／`author_counts`）：作者是主人，或作者**現在**
   是主人的好友。解除好友不刪資料——讀的時候過濾，重新加好友就回來（規格 D4）。

`app/friend_visibility.py` 管「好友的餐點清單」；這裡管「一餐上面的東西」。兩個模組與
`routes/friends.py` 是後端唯三碰 `Friendship` 的地方（`tests/test_friend_meals.py` 的掃描測試）。
"""

from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any

from sqlalchemy import ColumnElement, and_, exists, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.models.friendship import Friendship, FriendshipStatus
from app.models.meal import Meal
from app.models.social import MealComment, MealLike, Notification, NotificationType
from app.models.user import User


def _pair(one: Any, other: Any) -> tuple[ColumnElement[bool], ColumnElement[bool]]:
    """`friendships` 的那一列（`user_a < user_b`）。`one`／`other` 可以是欄位也可以是整數；
    `least`／`greatest` 讓它對得上 `uq_friendships_user_a_user_b`，不用 OR 兩個方向。"""
    return (
        Friendship.user_a == func.least(one, other),
        Friendship.user_b == func.greatest(one, other),
    )


def _are_friends(one: Any, other: Any) -> ColumnElement[bool]:
    """**已經接受**的那一列才算：邀請還在等（不管誰邀誰）不是好友。"""
    return exists().where(Friendship.status == FriendshipStatus.ACCEPTED, *_pair(one, other))


def meal_visible_to(viewer_id: int) -> ColumnElement[bool]:
    return or_(
        Meal.user_id == viewer_id,
        and_(Meal.is_private.is_(False), _are_friends(Meal.user_id, viewer_id)),
    )


async def load_visible_meal(
    db: AsyncSession, viewer: User, meal_id: int, *, lock: bool = False
) -> Meal:
    """看得到 → 那一餐；否則 404，跟 `/api/meals/{id}` 的「不存在」逐字相同（handover §4.7）。
    條件全部在一個查詢的 WHERE 裡：不存在、不是好友、私人走同一條路。

    `lock=True`（要寫讚或留言時）：`FOR SHARE OF meals` 鎖到交易結束——跟「改成只有我
    看得到」的 PATCH（`FOR UPDATE`）互斥，不會有一則讚落在已經關起來的餐上。"""
    query = select(Meal).where(Meal.id == meal_id, meal_visible_to(viewer.id))
    if lock:
        query = query.with_for_update(read=True, of=Meal)
    meal: Meal | None = await db.scalar(query)
    if meal is None:
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    return meal


def like_counts(liker: Any, owner: Any) -> ColumnElement[bool]:
    """這個讚算不算：按的人現在是主人的好友。主人自己的不算（本來就不該有那一列）。"""
    return _are_friends(liker, owner)


def author_counts(author: Any, owner: Any) -> ColumnElement[bool]:
    """這則留言顯不顯示：作者是主人，或作者現在是主人的好友。"""
    return or_(author == owner, _are_friends(author, owner))


@dataclass(frozen=True)
class SocialCounts:
    like_count: int = 0
    comment_count: int = 0
    liked_by_me: bool = False


async def social_counts(
    db: AsyncSession, viewer_id: int, meal_ids: Sequence[int]
) -> dict[int, SocialCounts]:
    """這幾餐各有幾個讚、幾則留言、我按了沒。**兩次查詢，跟餐數無關。**

    **不檢查 viewer 看不看得到這幾餐**——呼叫端傳進來的 id 必須是已經過了自己那一關的
    （自己的餐、`shared_meals`、`load_visible_meal`）。每一個傳進來的 id 都有一筆結果。"""
    if not meal_ids:
        return {}
    likes = (
        await db.execute(
            select(MealLike.meal_id, func.count(), func.bool_or(MealLike.user_id == viewer_id))
            .join(Meal, Meal.id == MealLike.meal_id)
            .where(MealLike.meal_id.in_(meal_ids), like_counts(MealLike.user_id, Meal.user_id))
            .group_by(MealLike.meal_id)
        )
    ).all()
    comments = (
        await db.execute(
            select(MealComment.meal_id, func.count())
            .join(Meal, Meal.id == MealComment.meal_id)
            .where(
                MealComment.meal_id.in_(meal_ids),
                author_counts(MealComment.user_id, Meal.user_id),
            )
            .group_by(MealComment.meal_id)
        )
    ).all()
    liked = {meal_id: (count, bool(mine)) for meal_id, count, mine in likes}
    commented = {meal_id: count for meal_id, count in comments}
    return {
        meal_id: SocialCounts(
            like_count=liked.get(meal_id, (0, False))[0],
            comment_count=commented.get(meal_id, 0),
            liked_by_me=liked.get(meal_id, (0, False))[1],
        )
        for meal_id in meal_ids
    }


def notification_visible() -> ColumnElement[bool]:
    """這則通知現在還看不看得到（規格 §4.3）。跟 `Notification` 一起用在 WHERE 裡。

    - 好友邀請：那個邀請**還在等**（接受、拒絕、收回之後就不顯示）。
    - 其他三種：做這件事的人現在是我的好友——解除之後，他留言的預覽不會留在我的通知裡。

    餐或留言被刪的情況不用管：FK cascade 已經把那一列帶走了。"""
    pair = (Notification.user_id, Notification.actor_id)
    still_pending = exists().where(
        Friendship.status == FriendshipStatus.PENDING,
        Friendship.requested_by == Notification.actor_id,
        *_pair(*pair),
    )
    is_request = Notification.type == NotificationType.FRIEND_REQUEST
    return or_(and_(is_request, still_pending), and_(~is_request, _are_friends(*pair)))
