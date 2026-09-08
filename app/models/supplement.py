import enum
from datetime import date, datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
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
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class TimeOfDay(enum.StrEnum):
    MORNING = "morning"
    NOON = "noon"
    EVENING = "evening"
    BEDTIME = "bedtime"
    PREWORKOUT = "preworkout"
    POSTWORKOUT = "postworkout"


class Supplement(Base):
    __tablename__ = "supplements"
    __table_args__ = (
        CheckConstraint("serving_size > 0", name="serving_size_positive"),
        CheckConstraint("kcal >= 0", name="kcal_non_negative"),
        CheckConstraint("protein_g >= 0", name="protein_non_negative"),
        CheckConstraint("fat_g >= 0", name="fat_non_negative"),
        CheckConstraint("carb_g >= 0", name="carb_non_negative"),
        UniqueConstraint(
            "owner_id",
            "name",
            "brand",
            name="uq_supplements_owner_id_name_brand",
            postgresql_nulls_not_distinct=True,
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    name: Mapped[str] = mapped_column(Text, nullable=False)
    brand: Mapped[str | None] = mapped_column(Text)
    # NULL = 全域補劑（管理員維護）
    owner_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE")
    )
    serving_unit: Mapped[str] = mapped_column(Text, nullable=False)
    serving_size: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    # 每一份的量。dose（服用份數）在 supplement_plans / supplement_intakes，
    # kcal_total = kcal * dose（見計畫決定 1）。
    kcal: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    protein_g: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    fat_g: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    carb_g: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class SupplementPlan(Base):
    __tablename__ = "supplement_plans"
    __table_args__ = (
        CheckConstraint("dose > 0", name="dose_positive"),
        CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="effective_range",
        ),
        # 決定 2：規格第 6.4 節漏掉的 EXCLUDE 不重疊約束。
        # 已實測（見計畫）：字串欄位名 + text() 運算式的組合編譯出正確的 DDL、
        # 語意 6/6 符合預期。命名慣例不會替 ExcludeConstraint 加前綴 ——
        # name= 給什麼最終就是什麼，所以 ex_ 前綴自己寫進名字。
        ExcludeConstraint(
            ("user_id", "="),
            ("supplement_id", "="),
            ("time_of_day", "="),
            (text("daterange(effective_from, effective_to, '[)')"), "&&"),
            name="ex_supplement_plans_no_overlap",
            using="gist",
        ),
        Index(
            "ix_supplement_plans_user_id_effective",
            "user_id",
            "effective_from",
            "effective_to",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    supplement_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("supplements.id"), nullable=False
    )
    dose: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    time_of_day: Mapped[TimeOfDay] = mapped_column(
        Enum(
            TimeOfDay,
            name="time_of_day",
            native_enum=False,
            create_constraint=False,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date)


class SupplementIntake(Base):
    __tablename__ = "supplement_intakes"
    __table_args__ = (
        CheckConstraint("dose > 0", name="dose_positive"),
        Index("ix_supplement_intakes_user_id_taken_at", "user_id", "taken_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    supplement_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("supplements.id"), nullable=False
    )
    # NULL = 臨時吃的（不屬於任何固定清單）。計畫被刪除時打卡紀錄仍要留著
    # （歷史不能因為計畫被刪而消失），所以是 SET NULL 不是 CASCADE。
    plan_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("supplement_plans.id", ondelete="SET NULL")
    )
    dose: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    taken_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 快照：這一次攝取的總量（已乘過 dose），保護歷史不受補劑主檔修改影響
    # （見計畫決定 3）。4b 的統計因此是單純的 SUM，不需要再乘一次。
    kcal: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    protein_g: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    fat_g: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    carb_g: Mapped[Decimal] = mapped_column(
        Numeric(8, 2), nullable=False, server_default="0"
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
