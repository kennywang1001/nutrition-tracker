"""create meals and meal_items

Revision ID: 0004
Revises: 0003
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0004"
down_revision: str | None = "0003"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "meals",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("eaten_at", sa.DateTime(timezone=True), nullable=False),
        # native_enum=False：不是原生 PG enum，而是 VARCHAR + CHECK。
        # create_constraint=False：CHECK 改由下面自己宣告的 CheckConstraint 負責
        # ——見 app/models/meal.py 的註解，type-bound 的自動 CHECK 會讓
        # alembic check 永遠回報漂移（已實測）。
        sa.Column(
            "meal_type",
            sa.Enum(
                "breakfast",
                "lunch",
                "dinner",
                "snack",
                name="meal_type",
                native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("photo_path", sa.Text),
        sa.Column("note", sa.Text),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_meals"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_meals_user_id_users", ondelete="CASCADE"
        ),
        # 注意：name= 是 %(constraint_name)s 的輸入，不是最終名稱
        # （跟 app/models/meal.py、migrations/0002 的寫法一致）。
        sa.CheckConstraint(
            "meal_type IN ('breakfast', 'lunch', 'dinner', 'snack')",
            name="meal_type_valid",
        ),
    )
    op.create_index("ix_meals_user_id_eaten_at", "meals", ["user_id", "eaten_at"])

    op.create_table(
        "meal_items",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("food_revision_id", sa.BigInteger, nullable=False),
        sa.Column("portion_id", sa.BigInteger),
        sa.Column("quantity", sa.Numeric(8, 2), nullable=False),
        sa.Column("quantity_g", sa.Numeric(8, 2), nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_meal_items"),
        sa.ForeignKeyConstraint(
            ["meal_id"], ["meals.id"], name="fk_meal_items_meal_id_meals", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["food_revision_id"],
            ["food_revisions.id"],
            name="fk_meal_items_food_revision_id_food_revisions",
        ),
        sa.ForeignKeyConstraint(
            ["portion_id"],
            ["food_portions.id"],
            name="fk_meal_items_portion_id_food_portions",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint("quantity > 0", name="quantity_positive"),
        sa.CheckConstraint("quantity_g > 0", name="quantity_g_positive"),
    )
    op.create_index("ix_meal_items_meal_id", "meal_items", ["meal_id"])
    op.create_index("ix_meal_items_food_revision_id", "meal_items", ["food_revision_id"])


def downgrade() -> None:
    op.drop_table("meal_items")
    op.drop_table("meals")
