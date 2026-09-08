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
    Numeric,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class MealType(enum.StrEnum):
    BREAKFAST = "breakfast"
    LUNCH = "lunch"
    DINNER = "dinner"
    SNACK = "snack"


class Meal(Base):
    __tablename__ = "meals"
    __table_args__ = (
        # Task 5 實測發現：create_constraint=True 產生的 CHECK 是「type-bound」
        # （SQLAlchemy 為了 issue #3260 特別標記），alembic 的 check-constraint
        # 比對器會把 type-bound 約束整個排除在「model 這一側」之外
        # （alembic/util/sqla_compat.py::all_table_check_constraints），
        # 但套用到 DB 之後，reflection 讀回來的是一個普通 CHECK，並不知道自己
        # 是 type-bound。結果是 alembic check 每次都回報「偵測到被移除的
        # check constraint」——這個漂移永遠不會消失，因為天平的兩端本來就不對稱。
        # 改用 create_constraint=False + 這裡自己宣告一個一般的 CheckConstraint，
        # 就跟 quantity_positive 那些一樣不是 type-bound，兩側可以正常互相比對。
        CheckConstraint(
            "meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')",
            name="meal_type_valid",
        ),
        Index("ix_meals_user_id_eaten_at", "user_id", "eaten_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    eaten_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    meal_type: Mapped[MealType] = mapped_column(
        Enum(
            MealType,
            name="meal_type",
            native_enum=False,
            create_constraint=False,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    photo_path: Mapped[str | None] = mapped_column(Text)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class MealItem(Base):
    __tablename__ = "meal_items"
    __table_args__ = (
        CheckConstraint("quantity > 0", name="quantity_positive"),
        CheckConstraint("quantity_g > 0", name="quantity_g_positive"),
        Index("ix_meal_items_meal_id", "meal_id"),
        Index("ix_meal_items_food_revision_id", "food_revision_id"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    meal_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="CASCADE"), nullable=False
    )
    food_revision_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("food_revisions.id"), nullable=False
    )
    # 份量被刪掉時只斷開顯示用的關聯，quantity_g 不受影響 —— 歷史數值不能因此改變
    portion_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("food_portions.id", ondelete="SET NULL")
    )
    quantity: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    quantity_g: Mapped[Decimal] = mapped_column(Numeric(8, 2), nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
