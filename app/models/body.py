"""身體資料與體重（身體資料規格 §4）。健康資料：只有身體資料的模組讀寫這兩張表——
好友與社群的模組連這幾個名字都不准出現（`tests/test_body_privacy.py` 掃的是文字）。"""

import datetime as dt
import enum
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    DateTime,
    Enum,
    ForeignKey,
    Numeric,
    SmallInteger,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class Sex(enum.StrEnum):
    MALE = "male"
    FEMALE = "female"


class ActivityLevel(enum.StrEnum):
    SEDENTARY = "sedentary"
    LIGHT = "light"
    MODERATE = "moderate"
    ACTIVE = "active"
    VERY_ACTIVE = "very_active"


class Goal(enum.StrEnum):
    LOSE = "lose"
    MAINTAIN = "maintain"
    GAIN = "gain"


def _enum(cls: type[enum.StrEnum], name: str, length: int) -> Enum:
    # handover §7：create_constraint=True 會讓 alembic check 永久漂移；False 的另一半是
    # __table_args__ 裡手寫的 CHECK——只寫一半＝沒有約束。
    return Enum(
        cls,
        name=name,
        native_enum=False,
        create_constraint=False,
        length=length,
        values_callable=lambda e: [m.value for m in e],
    )


class UserProfile(Base):
    """一人一列（D1），每個欄位都可以是 null（還沒填）。

    CHECK 對 NULL 放行（handover §7）——這裡要的正是「null 或範圍內」，所以不用寫
    `x IS NULL OR …`。出生年的真正範圍跟「今天」有關，CHECK 只擋衛生範圍（D4）。"""

    __tablename__ = "user_profiles"
    __table_args__ = (
        CheckConstraint("sex IN ('male', 'female')", name="sex_valid"),
        CheckConstraint("birth_year BETWEEN 1900 AND 2100", name="birth_year_sane"),
        CheckConstraint("height_cm BETWEEN 100 AND 250", name="height_range"),
        CheckConstraint(
            "activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')",
            name="activity_level_valid",
        ),
        CheckConstraint("goal IN ('lose', 'maintain', 'gain')", name="goal_valid"),
        CheckConstraint("rate_kg_per_week IN (0.25, 0.50)", name="rate_valid"),
        CheckConstraint("target_weight_kg BETWEEN 25 AND 350", name="target_weight_range"),
        CheckConstraint(
            "targets_applied_weight_kg BETWEEN 25 AND 350", name="applied_weight_range"
        ),
    )

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    sex: Mapped[Sex | None] = mapped_column(_enum(Sex, "body_sex", 8))
    birth_year: Mapped[int | None] = mapped_column(SmallInteger)
    height_cm: Mapped[Decimal | None] = mapped_column(Numeric(4, 1))
    activity_level: Mapped[ActivityLevel | None] = mapped_column(
        _enum(ActivityLevel, "activity_level", 16)
    )
    goal: Mapped[Goal | None] = mapped_column(_enum(Goal, "body_goal", 8))
    rate_kg_per_week: Mapped[Decimal | None] = mapped_column(Numeric(3, 2))
    target_weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    # 套用建議時的體重（D15）；手動存目標時清成 null（D16）。只有後端寫，API 不收。
    targets_applied_weight_kg: Mapped[Decimal | None] = mapped_column(Numeric(5, 2))
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    # onupdate 只管 ORM 的 UPDATE；PUT 走 ON CONFLICT DO UPDATE，要在 set_ 裡自己寫。
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


class WeightEntry(Base):
    """一人一天一筆（D12）：主鍵就是 (user_id, date)，同時是「某段日期」與「最新一筆」的索引。

    `date` 是使用者時區的日曆日（記的時候選的那一天），不是時間點。`updated_at` 的
    `onupdate` 只在 ORM 的 UPDATE 生效——upsert 要自己在 `set_` 裡寫（`routes/weights.py`）。"""

    __tablename__ = "weight_entries"
    __table_args__ = (CheckConstraint("weight_kg BETWEEN 25 AND 350", name="weight_range"),)

    user_id: Mapped[int] = mapped_column(
        BigInteger,
        ForeignKey("users.id", ondelete="CASCADE"),
        primary_key=True,
        autoincrement=False,
    )
    date: Mapped[dt.date] = mapped_column(Date, primary_key=True)
    weight_kg: Mapped[Decimal] = mapped_column(Numeric(5, 2), nullable=False)
    created_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[dt.datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
