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
    UniqueConstraint,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class FriendshipStatus(enum.StrEnum):
    PENDING = "pending"
    ACCEPTED = "accepted"


class Friendship(Base):
    """一對朋友（或一個還在等的邀請）一列（好友規格 §3.2）。

    **`user_a < user_b`**：同一對人只有一種寫法，「我們是不是好友」一次查詢；
    不會有「A→B 有、B→A 沒有」這種兩列不同步的狀態。拒絕、收回、解除都是
    刪掉這一列——沒有 `rejected` 狀態，所以「拒絕之後可以再邀請」是自然結果。
    """

    __tablename__ = "friendships"
    __table_args__ = (
        # 同時擋掉「自己加自己」與「同一對存兩種順序」。
        CheckConstraint("user_a < user_b", name="ordered_pair"),
        CheckConstraint("requested_by IN (user_a, user_b)", name="requester_in_pair"),
        CheckConstraint("status IN ('pending', 'accepted')", name="status_valid"),
        CheckConstraint(
            "(status = 'accepted') = (accepted_at IS NOT NULL)", name="accepted_at_matches_status"
        ),
        UniqueConstraint("user_a", "user_b"),
        # 「我的好友」要查兩個方向；user_a 那一邊由唯一約束的前導欄位涵蓋。
        Index("ix_friendships_user_b", "user_b"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_a: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    user_b: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    requested_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    status: Mapped[FriendshipStatus] = mapped_column(
        Enum(
            FriendshipStatus,
            name="friendship_status",
            native_enum=False,
            create_constraint=False,
            length=16,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
