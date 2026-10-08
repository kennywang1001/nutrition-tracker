from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PasswordResetToken(Base):
    """管理員產生的一次性重設密碼連結（帳號設定規格 §4.1）。

    跟 `Invite` 同一個形狀：只存 `token_hash`（SHA-256 hex）；「用掉」「撤銷」「過期」
    是三個獨立欄位（過期由時間決定，不是一次寫入）。
    """

    __tablename__ = "password_reset_tokens"
    __table_args__ = (
        # name= 是命名慣例的輸入，最終名稱 ck_password_reset_tokens_…（handover §7）。
        CheckConstraint("expires_at > created_at", name="expires_after_created"),
        CheckConstraint(
            "used_at IS NULL OR revoked_at IS NULL", name="not_both_used_and_revoked"
        ),
        # **一個人最多一條活連結**（規格決定 14）。產生端點先 FOR UPDATE 那個使用者、
        # 撤銷舊的再插新的——那是程式碼；這個索引讓資料庫再保證一次，哪天流程被改壞，
        # 是一個大聲的 IntegrityError，不是兩條都能用的連結。user_id 當前導欄位，
        # 同時服務「撤銷這個人的活連結」與 ON DELETE CASCADE 的查找。
        # 述詞要跟 migration 一字不差，否則 alembic check 報漂移。
        Index(
            "uq_password_reset_tokens_one_live_per_user",
            "user_id",
            unique=True,
            postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
