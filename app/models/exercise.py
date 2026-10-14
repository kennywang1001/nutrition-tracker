"""運動紀錄（運動規格 §5）。只有自己看得到：好友與社群的模組連這幾個名字都不准出現
（`tests/test_exercise_privacy.py` 掃的是文字）。"""

import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Integer,
    Numeric,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.exercise import ActivityCode, KcalSource
from app.models.base import Base

# CHECK 的文字從列舉產生，模型跟清單不會不同步；migration 裡是寫死的字面值
# （migration 不 import app）。
_ACTIVITY_CODES_SQL = ", ".join(f"'{code.value}'" for code in ActivityCode)


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


class ExerciseEntry(Base):
    """一天可以有很多筆（D1），所以有自己的 id；哪一天由 `performed_at` 與使用者時區決定，
    同餐點。"""

    __tablename__ = "exercise_entries"
    __table_args__ = (
        # name= 是命名慣例的輸入：最後是 ck_exercise_entries_<name>（handover §7）。
        # 列舉欄位用 create_constraint=False，這兩條手寫的 CHECK 是它們唯一的約束。
        CheckConstraint(f"activity IN ({_ACTIVITY_CODES_SQL})", name="activity_valid"),
        CheckConstraint("kcal_source IN ('estimated', 'manual')", name="kcal_source_valid"),
        # D4：「其他」⇔ 有名稱；「其他」沒有 MET，熱量一定是手動的。
        CheckConstraint("(activity = 'other') = (name IS NOT NULL)", name="other_has_name"),
        CheckConstraint("activity <> 'other' OR kcal_source = 'manual'", name="other_is_manual"),
        # CHECK 對 NULL 放行（handover §7）：名稱與備註可以沒有，有的話才看長度。
        CheckConstraint("char_length(name) BETWEEN 1 AND 50", name="name_length"),
        CheckConstraint("minutes BETWEEN 1 AND 600", name="minutes_range"),
        CheckConstraint("kcal BETWEEN 1 AND 5000", name="kcal_range"),
        CheckConstraint("char_length(note) <= 200", name="note_length"),
        # 「某人某一天的運動」與每日統計的 SUM 都走這個索引。
        Index("ix_exercise_entries_user_id_performed_at", "user_id", "performed_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    performed_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    activity: Mapped[ActivityCode] = mapped_column(
        _enum(ActivityCode, "exercise_activity", 32), nullable=False
    )
    name: Mapped[str | None] = mapped_column(Text)
    minutes: Mapped[int] = mapped_column(Integer, nullable=False)
    kcal: Mapped[Decimal] = mapped_column(Numeric(7, 2), nullable=False)
    kcal_source: Mapped[KcalSource] = mapped_column(
        _enum(KcalSource, "exercise_kcal_source", 16), nullable=False
    )
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
