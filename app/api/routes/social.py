"""一餐上面的讚與留言（社群規格 §5）。

**每個端點的第一件事都是 `load_visible_meal`**——看不到與不存在是同一個 404。
這裡不直接碰好友關係的表：規則都在可見性模組。"""

from fastapi import APIRouter, Depends
from sqlalchemy import delete, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.friend_meals import build_friend_meals
from app.models.social import MealComment, MealLike
from app.models.user import User
from app.ratelimit import like_rate_limiter
from app.schemas.social import CommentResponse, LikerResponse, LikeState, SocialMealResponse
from app.social_visibility import author_counts, like_counts, load_visible_meal, social_counts

router = APIRouter(prefix="/social", tags=["social"])

# 一次最多回幾則留言（規格 D10）：最近的這麼多則，由舊到新。
COMMENTS_SHOWN = 100


def _comment_response(
    comment: MealComment, display_name: str, *, viewer_id: int, owner_id: int
) -> CommentResponse:
    is_me = comment.user_id == viewer_id
    return CommentResponse(
        id=comment.id,
        display_name=display_name,
        is_me=is_me,
        can_delete=is_me or owner_id == viewer_id,
        body=comment.body,
        created_at=comment.created_at,
    )


@router.get("/meals/{meal_id}", response_model=SocialMealResponse)
async def read_social_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SocialMealResponse:
    """一餐、誰按了讚、最近的留言。自己的餐與看得到的好友的餐都走這裡。"""
    meal = await load_visible_meal(db, user, meal_id)
    owner = user if meal.user_id == user.id else await db.get(User, meal.user_id)
    if owner is None:
        # 主人的帳號剛好被刪：餐也跟著 cascade 了。
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    [card] = await build_friend_meals(db, user.id, [meal], {owner.id: owner})

    likers = (
        await db.execute(
            select(User.display_name, MealLike.user_id)
            .join(User, User.id == MealLike.user_id)
            .where(MealLike.meal_id == meal.id, like_counts(MealLike.user_id, meal.user_id))
            .order_by(MealLike.id)
        )
    ).all()
    # 多拿一則：知道有沒有被截掉，不用另外數（數字在 card.comment_count）。
    rows = (
        await db.execute(
            select(MealComment, User.display_name)
            .join(User, User.id == MealComment.user_id)
            .where(MealComment.meal_id == meal.id, author_counts(MealComment.user_id, meal.user_id))
            .order_by(MealComment.id.desc())
            .limit(COMMENTS_SHOWN + 1)
        )
    ).all()
    shown = rows[:COMMENTS_SHOWN][::-1]
    return SocialMealResponse(
        meal=card,
        is_mine=meal.user_id == user.id,
        likes=[
            LikerResponse(display_name=name, is_me=liker_id == user.id) for name, liker_id in likers
        ],
        comments=[
            _comment_response(comment, name, viewer_id=user.id, owner_id=meal.user_id)
            for comment, name in shown
        ],
        comments_truncated=len(rows) > COMMENTS_SHOWN,
    )


async def _like_state(db: AsyncSession, user_id: int, meal_id: int) -> LikeState:
    counts = (await social_counts(db, user_id, [meal_id]))[meal_id]
    return LikeState(like_count=counts.like_count, liked_by_me=counts.liked_by_me)


@router.put("/meals/{meal_id}/like", response_model=LikeState)
async def like_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LikeState:
    """按讚。冪等：已經按過就什麼都不做，照樣回 200 與目前的數字。

    限速在最前面（查不查得到都算一次）。`ON CONFLICT DO NOTHING`：兩個同時到的 PUT，
    第二個等第一個 commit 之後什麼都不寫——不是 IntegrityError。"""
    # commit 之後 ORM 物件可能過期：要用的 id 先存成整數。
    user_id = user.id
    like_rate_limiter.hit(str(user_id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    if meal.user_id == user_id:
        raise UnprocessableEntityError("CANNOT_LIKE_OWN_MEAL", "不能對自己的餐點按讚")
    await db.execute(
        pg_insert(MealLike).values(meal_id=meal_id, user_id=user_id).on_conflict_do_nothing()
    )
    await db.commit()
    return await _like_state(db, user_id, meal_id)


@router.delete("/meals/{meal_id}/like", response_model=LikeState)
async def unlike_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LikeState:
    """收回讚。冪等。回 200 與目前的數字（不是 204）：跟按讚同一個形狀。
    看不到這一餐（包含已經解除好友）就是 404——那個讚本來就被藏起來了。"""
    user_id = user.id
    like_rate_limiter.hit(str(user_id))
    await load_visible_meal(db, user, meal_id, lock=True)
    await db.execute(
        delete(MealLike).where(MealLike.meal_id == meal_id, MealLike.user_id == user_id)
    )
    await db.commit()
    return await _like_state(db, user_id, meal_id)
