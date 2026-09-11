import uuid
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, ForeignKey, Identity, Index
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RefreshSession(Base):
    """一張 refresh token 對應一列。

    `family_id` 是一次登入衍生出的整條鏈:登入開一個新 family,之後每次輪替
    都在同一個 family 裡長出下一列。撤銷的單位是 family 而不是單一列 ——
    攻擊者手上那張票換出來的後續票也必須一起死。

    `used_at` 與 `revoked_at` 刻意分開,不合併成一個 status 欄位:
    「已經被拿去換過」是正常流程的終點,「被撤銷」是安全事件或使用者登出。
    合併之後就再也分不出「這條鏈正常輪替到底」與「這條鏈被判定外洩」。

    這裡只存 `jti`,不存 token 字串本身 —— token 進資料庫等於把一份可直接
    使用的憑證留在備份裡,而 jti 已經足夠做撤銷判斷。
    """

    __tablename__ = "refresh_sessions"
    __table_args__ = (
        # 撤銷整個 family 時走這個索引。
        Index("ix_refresh_sessions_family_id", "family_id"),
        # logout-all:撈某個使用者所有還沒撤銷的列。
        Index("ix_refresh_sessions_user_id_revoked_at", "user_id", "revoked_at"),
        # cleanup-sessions:刪掉過期的列。
        Index("ix_refresh_sessions_expires_at", "expires_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    jti: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, nullable=False)
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 只給 cleanup-sessions 用。**過期判斷本身由 JWT 的 exp 負責**,
    # 這個欄位刻意不參與換發時的條件判斷 —— 理由見 Task 4。
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
