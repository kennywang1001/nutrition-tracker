"""create expenses

Revision ID: 0010
Revises: 0009
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0010"
down_revision: str | None = "0009"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "expenses",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("meal_id", sa.BigInteger, nullable=True),
        # native_enum=False：VARCHAR + CHECK，CHECK 由下面自己宣告的
        # CheckConstraint 負責（見 app/models/expense.py 的註解）。
        sa.Column(
            "category",
            sa.Enum(
                "food",
                "transport",
                "daily",
                "entertainment",
                "medical",
                "housing",
                "other",
                name="expense_category",
                native_enum=False,
                # 明寫 length：不給的話是 VARCHAR(13)（最長值的長度），
                # 加一個更長的分類就會 StringDataRightTruncation。
                # 見 app/models/expense.py 的說明。
                length=32,
            ),
            nullable=False,
        ),
        sa.Column("amount", sa.Numeric(10, 2), nullable=False),
        sa.Column("spent_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_expenses"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_expenses_user_id_users", ondelete="CASCADE"
        ),
        # SET NULL，不是 CASCADE：刪餐點不刪錢（規格 §2.3）。
        sa.ForeignKeyConstraint(
            ["meal_id"], ["meals.id"], name="fk_expenses_meal_id_meals", ondelete="SET NULL"
        ),
        # 注意：name= 是 NAMING_CONVENTION 的 %(constraint_name)s 樣板輸入，
        # 不是最終名稱（最終是 ck_expenses_category_valid / ck_expenses_amount_positive）
        # ——跟 migrations/0004、0008 的寫法一致。
        sa.CheckConstraint(
            "category IN ('food', 'transport', 'daily', 'entertainment',"
            " 'medical', 'housing', 'other')",
            name="category_valid",
        ),
        sa.CheckConstraint("amount > 0", name="amount_positive"),
    )
    op.create_index("ix_expenses_user_id_spent_at", "expenses", ["user_id", "spent_at"])
    op.create_index("ix_expenses_meal_id", "expenses", ["meal_id"])


def downgrade() -> None:
    op.drop_table("expenses")
