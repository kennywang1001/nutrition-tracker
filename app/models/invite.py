from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Text, func
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Invite(Base):
    """一次性邀請連結（邀請規格 §3.1）。

    只存 `token_hash`（SHA-256 hex），不存邀請碼本身——同 `RefreshSession`
    只存 `jti` 的理由：資料庫或備份外流時，拿不到能用的連結。

    「已使用」「已撤銷」「已過期」是三個獨立的欄位，不合併成一個 status：
    過期是時間決定的，不是一次寫入；而「誰用掉的」要跟著「已使用」一起留下來。
    """

    __tablename__ = "invites"
    __table_args__ = (
        # name= 是命名慣例的輸入，最終名稱是 ck_invites_expires_after_created
        # （handover §7 陷阱表第 1 條）。
        CheckConstraint("expires_at > created_at", name="expires_after_created"),
        # 撤銷端點與註冊的條件式 UPDATE 都會擋，這是最後一道：
        # 兩條路徑哪天有一條的 WHERE 被改弱，資料庫會大聲報錯。
        CheckConstraint(
            "used_at IS NULL OR revoked_at IS NULL", name="not_both_used_and_revoked"
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    note: Mapped[str | None] = mapped_column(Text, nullable=True)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    used_by: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
