"""寫通知（社群規格 D11、D12、§5.7）。

**這裡的函式都不 commit**：通知跟著呼叫端的那個交易一起成立、一起消失——讚寫進去了
通知就一定在，讚被 rollback 了通知也不會留下。「誰看得到通知」不在這裡，在讀的那一層。
"""

from sqlalchemy import delete
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.social import Notification, NotificationType


async def notify_like(db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int) -> None:
    """同一個人對同一餐只有一則（`uq_notifications_like`）；已經有就什麼都不做。"""
    if owner_id == actor_id:
        return
    await db.execute(
        pg_insert(Notification)
        .values(user_id=owner_id, actor_id=actor_id, type=NotificationType.LIKE, meal_id=meal_id)
        .on_conflict_do_nothing()
    )


async def forget_like(db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int) -> None:
    """收回讚：那一則通知跟著消失——不然「按了又收回」會留下一則指向不存在的讚的通知。"""
    await db.execute(
        delete(Notification).where(
            Notification.user_id == owner_id,
            Notification.actor_id == actor_id,
            Notification.meal_id == meal_id,
            Notification.type == NotificationType.LIKE,
        )
    )


def notify_comment(
    db: AsyncSession, *, owner_id: int, actor_id: int, meal_id: int, comment_id: int
) -> None:
    """只通知餐的主人；主人自己留言不通知自己。留言被刪時由 FK cascade 帶走。"""
    if owner_id == actor_id:
        return
    db.add(
        Notification(
            user_id=owner_id,
            actor_id=actor_id,
            type=NotificationType.COMMENT,
            meal_id=meal_id,
            comment_id=comment_id,
        )
    )


_FRIEND_TYPES = (NotificationType.FRIEND_REQUEST, NotificationType.FRIEND_ACCEPTED)


async def notify_friend(db: AsyncSession, *, to: int, actor: int, kind: NotificationType) -> None:
    """好友邀請（`to` 收到 `actor` 的邀請）或接受（`actor` 接受了 `to` 的邀請）。

    先刪掉同一個方向的舊好友通知：拒絕之後再邀請、解除之後再加回來，都只有最新的一則。"""
    await db.execute(
        delete(Notification).where(
            Notification.user_id == to,
            Notification.actor_id == actor,
            Notification.type.in_(_FRIEND_TYPES),
        )
    )
    db.add(Notification(user_id=to, actor_id=actor, type=kind))
