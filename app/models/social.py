"""按讚、留言、通知（社群規格 §3）。三張表都只被社群的模組讀寫；
「誰看得到」不在這裡——在讀取的那一層。"""

import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MealLike(Base):
    """一個人對一餐的讚。唯一約束同時是「這一餐的讚」的索引。

    「主人不能讚自己」不在這裡擋（要跨表）：端點擋，而且計數只算主人現在的好友。"""

    __tablename__ = "meal_likes"
    __table_args__ = (UniqueConstraint("meal_id", "user_id"),)

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MealComment(Base):
    __tablename__ = "meal_comments"
    __table_args__ = (
        # 長度在 schema 擋一次、這裡再擋一次：繞過 API 寫進來的也不會超過。
        CheckConstraint("char_length(body) BETWEEN 1 AND 200", name="body_length"),
        Index("ix_meal_comments_meal_id_id", "meal_id", "id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    body: Mapped[str] = mapped_column(Text, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class NotificationType(enum.StrEnum):
    LIKE = "like"
    COMMENT = "comment"
    FRIEND_REQUEST = "friend_request"
    FRIEND_ACCEPTED = "friend_accepted"


class Notification(Base):
    """`id` 也是排序的依據：`created_at` 是交易開始的時間，同一個交易裡會相同。"""

    __tablename__ = "notifications"
    __table_args__ = (
        CheckConstraint("user_id <> actor_id", name="not_self"),
        # 這一條同時是 `type` 的手寫約束（handover §7：create_constraint=False 的另一半）：
        # 四種以外的值三個分支都不成立。
        CheckConstraint(
            "(type = 'like' AND meal_id IS NOT NULL AND comment_id IS NULL)"
            " OR (type = 'comment' AND meal_id IS NOT NULL AND comment_id IS NOT NULL)"
            " OR (type IN ('friend_request', 'friend_accepted')"
            " AND meal_id IS NULL AND comment_id IS NULL)",
            name="shape_matches_type",
        ),
        # 同一個人對同一餐的讚只通知一次（規格 D12）。
        Index(
            "uq_notifications_like",
            "user_id",
            "actor_id",
            "meal_id",
            unique=True,
            postgresql_where=text("type = 'like'"),
        ),
        Index("ix_notifications_user_id_id", "user_id", "id"),
        Index("ix_notifications_unread", "user_id", postgresql_where=text("read_at IS NULL")),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    actor_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    type: Mapped[NotificationType] = mapped_column(
        Enum(
            NotificationType,
            name="notification_type",
            native_enum=False,
            create_constraint=False,
            length=16,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    meal_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=True
    )
    comment_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meal_comments.id", ondelete="CASCADE"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
