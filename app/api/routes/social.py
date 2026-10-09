"""一餐上面的讚與留言（社群規格 §5）。

**每個端點的第一件事都是 `load_visible_meal`**——看不到與不存在是同一個 404。
這裡不直接碰好友關係的表：規則都在可見性模組。"""

from fastapi import APIRouter, Depends, status
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
from app.notifications import forget_like, notify_comment, notify_like
from app.ratelimit import comment_rate_limiter, like_rate_limiter
from app.schemas.social import (
    CommentCreate,
    CommentResponse,
    LikerResponse,
    LikeState,
    SocialMealResponse,
)
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
    inserted = await db.scalar(
        pg_insert(MealLike)
        .values(meal_id=meal_id, user_id=user_id)
        .on_conflict_do_nothing()
        .returning(MealLike.id)
    )
    if inserted is not None:
        # 真的新增了才通知。重複的 PUT 不會走到這裡（衝突時 RETURNING 沒有列）。
        await notify_like(db, owner_id=meal.user_id, actor_id=user_id, meal_id=meal_id)
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
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    await db.execute(
        delete(MealLike).where(MealLike.meal_id == meal_id, MealLike.user_id == user_id)
    )
    # 同一個交易：讚不在了，「他按了讚」的通知也不該留著（規格 D12）。
    await forget_like(db, owner_id=meal.user_id, actor_id=user_id, meal_id=meal_id)
    await db.commit()
    return await _like_state(db, user_id, meal_id)


@router.post(
    "/meals/{meal_id}/comments",
    status_code=status.HTTP_201_CREATED,
    response_model=CommentResponse,
)
async def add_comment(
    meal_id: ResourceId,
    payload: CommentCreate,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> CommentResponse:
    """留言。看得到這一餐的人都可以，包含主人自己。不能改，只能刪掉重寫。

    限速在最前面（查不查得到都算一次）。"""
    # commit 之後 ORM 物件可能過期：要用的值先存起來。
    user_id, display_name = user.id, user.display_name
    comment_rate_limiter.hit(str(user_id))
    meal = await load_visible_meal(db, user, meal_id, lock=True)
    owner_id = meal.user_id
    comment = MealComment(meal_id=meal_id, user_id=user_id, body=payload.body)
    db.add(comment)
    await db.flush()  # 要先拿到留言的 id
    # 同一個交易：留言寫進去了通知就一定在。
    notify_comment(
        db, owner_id=owner_id, actor_id=user_id, meal_id=meal_id, comment_id=comment.id
    )
    await db.commit()
    await db.refresh(comment)
    return _comment_response(comment, display_name, viewer_id=user_id, owner_id=owner_id)


@router.delete("/meals/{meal_id}/comments/{comment_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_comment(
    meal_id: ResourceId,
    comment_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪留言：作者刪自己的，餐的主人刪這一餐底下任何一則。

    條件全部在一個 DELETE 的 WHERE 裡——留言 id、**它屬於路徑上的這一餐**、我有權刪。
    不存在、屬於另一餐、看得到但不是我的，都是同一個 404。"""
    meal = await load_visible_meal(db, user, meal_id)
    conditions = [MealComment.id == comment_id, MealComment.meal_id == meal.id]
    if meal.user_id != user.id:
        # 不是主人：只能刪自己寫的。
        conditions.append(MealComment.user_id == user.id)
    deleted = await db.scalar(delete(MealComment).where(*conditions).returning(MealComment.id))
    if deleted is None:
        raise NotFoundError("COMMENT_NOT_FOUND", "找不到這則留言")
    await db.commit()
