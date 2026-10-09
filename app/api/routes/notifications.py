"""通知（社群規格 §5.5）。三個端點都只碰「收件人是我」的列。"""

from fastapi import APIRouter, Depends
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.models.meal import Meal
from app.models.social import MealComment, Notification
from app.models.user import User
from app.schemas.social import (
    NotificationItem,
    NotificationMeal,
    NotificationsResponse,
    ReadAllRequest,
    UnreadCount,
)
from app.social_visibility import notification_visible

router = APIRouter(prefix="/notifications", tags=["notifications"])

# 清單只回最近這麼多則（規格 D22）；這一版不自動刪舊的。
NOTIFICATIONS_SHOWN = 50
PREVIEW_LENGTH = 40


def _preview(body: str | None) -> str | None:
    if body is None or len(body) <= PREVIEW_LENGTH:
        return body
    return body[:PREVIEW_LENGTH] + "…"


@router.get("", response_model=NotificationsResponse)
async def list_notifications(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> NotificationsResponse:
    """最近 50 則，新的在前。一次查詢：動作者的名字、餐、留言都 join 回來。

    餐不用再過一次「看不看得到」：讚與留言的通知只寫給餐的主人，收件人就是主人——
    她把那一餐改成只有自己看得到，通知照樣在（規格 D5）。"""
    rows = (
        await db.execute(
            select(Notification, User.display_name, Meal.meal_type, Meal.eaten_at, MealComment.body)
            .join(User, User.id == Notification.actor_id)
            .outerjoin(Meal, Meal.id == Notification.meal_id)
            .outerjoin(MealComment, MealComment.id == Notification.comment_id)
            .where(Notification.user_id == user.id, notification_visible())
            .order_by(Notification.id.desc())
            .limit(NOTIFICATIONS_SHOWN)
        )
    ).all()
    return NotificationsResponse(
        items=[
            NotificationItem(
                id=note.id,
                type=note.type,
                actor_name=actor_name,
                meal=(
                    None
                    if note.meal_id is None or meal_type is None or eaten_at is None
                    else NotificationMeal(id=note.meal_id, meal_type=meal_type, eaten_at=eaten_at)
                ),
                comment_preview=_preview(body),
                created_at=note.created_at,
                is_read=note.read_at is not None,
            )
            for note, actor_name, meal_type, eaten_at, body in rows
        ]
    )


async def _unread(db: AsyncSession, user_id: int) -> int:
    count = await db.scalar(
        select(func.count())
        .select_from(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.read_at.is_(None),
            notification_visible(),
        )
    )
    return count or 0


@router.get("/unread-count", response_model=UnreadCount)
async def unread_count(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCount:
    """分頁上的數字。跟清單同一個過濾，但不受 50 則的上限影響。"""
    return UnreadCount(count=await _unread(db, user.id))


@router.post("/read-all", response_model=UnreadCount)
async def read_all(
    payload: ReadAllRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> UnreadCount:
    """把我的、`id <= up_to`、還沒讀的標成已讀；回剩下的未讀數。

    不套可見性的過濾：現在看不到的（對方已經解除好友）一起標掉沒有壞處。"""
    # commit 之後 ORM 物件可能過期：要用的 id 先存成整數。
    user_id = user.id
    await db.execute(
        update(Notification)
        .where(
            Notification.user_id == user_id,
            Notification.id <= payload.up_to,
            Notification.read_at.is_(None),
        )
        .values(read_at=func.now())
    )
    await db.commit()
    return UnreadCount(count=await _unread(db, user_id))
