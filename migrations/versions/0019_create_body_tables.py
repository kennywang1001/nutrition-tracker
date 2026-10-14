"""create body tables

Revision ID: 0019
Revises: 0018
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0019"
down_revision: str | None = "0018"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _timestamps() -> list[sa.Column]:
    return [
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
    ]


def _enum(name: str, *values: str, length: int) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False, create_constraint=False, length=length)


def _user_fk(table: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        ["user_id"], ["users.id"], name=f"fk_{table}_user_id_users", ondelete="CASCADE"
    )


def upgrade() -> None:
    # 只有新表：舊版程式不讀不寫它們，所以這一版可以退版，
    # 不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.create_table(
        "user_profiles",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("sex", _enum("body_sex", "male", "female", length=8), nullable=True),
        sa.Column("birth_year", sa.SmallInteger, nullable=True),
        sa.Column("height_cm", sa.Numeric(4, 1), nullable=True),
        sa.Column(
            "activity_level",
            _enum(
                "activity_level",
                "sedentary",
                "light",
                "moderate",
                "active",
                "very_active",
                length=16,
            ),
            nullable=True,
        ),
        sa.Column("goal", _enum("body_goal", "lose", "maintain", "gain", length=8), nullable=True),
        sa.Column("rate_kg_per_week", sa.Numeric(3, 2), nullable=True),
        sa.Column("target_weight_kg", sa.Numeric(5, 2), nullable=True),
        sa.Column("targets_applied_weight_kg", sa.Numeric(5, 2), nullable=True),
        *_timestamps(),
        sa.PrimaryKeyConstraint("user_id", name="pk_user_profiles"),
        _user_fk("user_profiles"),
        # name= 是命名慣例的輸入（同 0013、0018）：最後是 ck_user_profiles_<name>。
        # 列舉欄位用 create_constraint=False，這幾條手寫的 CHECK 就是它們唯一的約束。
        sa.CheckConstraint("sex IN ('male', 'female')", name="sex_valid"),
        sa.CheckConstraint("birth_year BETWEEN 1900 AND 2100", name="birth_year_sane"),
        sa.CheckConstraint("height_cm BETWEEN 100 AND 250", name="height_range"),
        sa.CheckConstraint(
            "activity_level IN ('sedentary', 'light', 'moderate', 'active', 'very_active')",
            name="activity_level_valid",
        ),
        sa.CheckConstraint("goal IN ('lose', 'maintain', 'gain')", name="goal_valid"),
        sa.CheckConstraint("rate_kg_per_week IN (0.25, 0.50)", name="rate_valid"),
        sa.CheckConstraint("target_weight_kg BETWEEN 25 AND 350", name="target_weight_range"),
        sa.CheckConstraint(
            "targets_applied_weight_kg BETWEEN 25 AND 350", name="applied_weight_range"
        ),
    )
    op.create_table(
        "weight_entries",
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("date", sa.Date, nullable=False),
        sa.Column("weight_kg", sa.Numeric(5, 2), nullable=False),
        *_timestamps(),
        # 主鍵同時是「某人某段日期」與「某人最新一筆」的索引，不需要另一個 id。
        sa.PrimaryKeyConstraint("user_id", "date", name="pk_weight_entries"),
        _user_fk("weight_entries"),
        sa.CheckConstraint("weight_kg BETWEEN 25 AND 350", name="weight_range"),
    )


def downgrade() -> None:
    op.drop_table("weight_entries")
    op.drop_table("user_profiles")
