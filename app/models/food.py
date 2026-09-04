import enum
from datetime import datetime
from decimal import Decimal
from typing import Any

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Numeric,
    Text,
    UniqueConstraint,
    func,
    text,
)
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RevisionStatus(enum.StrEnum):
    PENDING = "pending"
    APPROVED = "approved"
    REJECTED = "rejected"


class BaseUnit(enum.StrEnum):
    G = "g"
    ML = "ml"


def _enum_column(enum_type: type[enum.StrEnum], name: str) -> Enum:
    return Enum(enum_type, name=name, values_callable=lambda e: [m.value for m in e])


class Food(Base):
    __tablename__ = "foods"
    __table_args__ = (
        UniqueConstraint(
            "owner_id",
            "name",
            "brand",
            name="uq_foods_owner_id_name_brand",
            postgresql_nulls_not_distinct=True,
        ),
        Index("ix_foods_owner_id", "owner_id"),
        Index(
            "ix_foods_name_trgm",
            "name",
            postgresql_using="gin",
            postgresql_ops={"name": "gin_trgm_ops"},
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    brand: Mapped[str | None] = mapped_column(Text)
    # NULL = 全域食物
    owner_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE")
    )
    # 指向目前生效的版本。只有審核通過才會更新這個指標 ——
    # 未審核的資料因此在結構上就查不到，不依賴任何人記得寫 WHERE status = 'approved'。
    current_revision_id: Mapped[int | None] = mapped_column(
        BigInteger,
        ForeignKey("food_revisions.id", deferrable=True, initially="DEFERRED"),
    )
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class FoodRevision(Base):
    __tablename__ = "food_revisions"
    __table_args__ = (
        CheckConstraint("kcal >= 0", name="kcal_non_negative"),
        CheckConstraint("protein_g >= 0", name="protein_non_negative"),
        CheckConstraint("fat_g >= 0", name="fat_non_negative"),
        CheckConstraint("carb_g >= 0", name="carb_non_negative"),
        CheckConstraint(
            "ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)",
            name="ai_confidence_in_range",
        ),
        CheckConstraint(
            "status <> 'rejected' OR reject_reason IS NOT NULL",
            name="rejected_needs_reason",
        ),
        # 兩個「部分索引」（帶 WHERE 條件）：
        #   uq_food_revisions_one_pending  同一食物同時只能有一筆待審（唯一）
        #   ix_food_revisions_pending      待審佇列的查詢索引
        # 曾經假設 alembic 對這種索引的比對不穩定、宣告在模型層會讓 alembic check
        # 產生假的漂移警報，因此把它們藏在 migration 裡不讓模型知道。
        # 這個假設沒有實際測過就寫進了計畫 —— 測過之後發現是錯的：模型完全不宣告
        # 才會讓 alembic check 真的報漂移（DB 有、模型沒有 → 判定成 remove_index）。
        # 宣告在這裡之後，alembic check 連續多次都乾淨，模型才是可信的單一事實來源。
        Index(
            "uq_food_revisions_one_pending",
            "food_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        Index(
            "ix_food_revisions_pending",
            "status",
            "created_at",
            postgresql_where=text("status = 'pending'"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    food_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("foods.id", ondelete="CASCADE"), nullable=False
    )
    base_unit: Mapped[BaseUnit] = mapped_column(
        _enum_column(BaseUnit, "base_unit"), nullable=False, default=BaseUnit.G
    )
    kcal: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    protein_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    fat_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    carb_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    status: Mapped[RevisionStatus] = mapped_column(
        _enum_column(RevisionStatus, "revision_status"),
        nullable=False,
        default=RevisionStatus.PENDING,
    )
    change_note: Mapped[str | None] = mapped_column(Text)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    reviewed_by: Mapped[int | None] = mapped_column(BigInteger, ForeignKey("users.id"))
    reviewed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    reject_reason: Mapped[str | None] = mapped_column(Text)
    # P2 階段（AI 分析）預留，本計畫不使用
    source: Mapped[str] = mapped_column(Text, nullable=False, server_default="user")
    ai_confidence: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    ai_raw_response: Mapped[dict[str, Any] | None] = mapped_column(JSONB)


class FoodPortion(Base):
    __tablename__ = "food_portions"
    __table_args__ = (
        CheckConstraint("grams > 0", name="grams_positive"),
        UniqueConstraint(
            "food_id",
            "owner_id",
            "label",
            name="uq_food_portions_food_id_owner_id_label",
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    food_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("foods.id", ondelete="CASCADE"), nullable=False
    )
    # NULL = 全域份量（管理員維護）
    owner_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE")
    )
    label: Mapped[str] = mapped_column(Text, nullable=False)
    grams: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    is_default: Mapped[bool] = mapped_column(Boolean, nullable=False, default=False)
