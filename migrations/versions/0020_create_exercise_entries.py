"""create exercise entries

Revision ID: 0020
Revises: 0019
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0020"
down_revision: str | None = "0019"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

# 寫死的字面值：migration 不 import app（以後改了 ActivityCode，這一版的 migration 不能跟著變）。
_ACTIVITY_CODES = (
    "walking",
    "brisk_walking",
    "jogging",
    "running",
    "cycling",
    "spinning",
    "swimming",
    "weight_training",
    "weight_training_vigorous",
    "yoga",
    "pilates",
    "hiit",
    "hiking",
    "stair_climbing",
    "basketball",
    "badminton",
    "table_tennis",
    "jump_rope",
    "other",
)


def _enum(name: str, *values: str, length: int) -> sa.Enum:
    return sa.Enum(*values, name=name, native_enum=False, create_constraint=False, length=length)


def upgrade() -> None:
    # 一張新表＋一個有預設值的欄位：舊版程式不讀新表；寫 users 的 INSERT 不提新欄位、吃預設值。
    # 所以這一版可以退版，不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.add_column(
        "users",
        sa.Column(
            "exercise_adds_to_budget", sa.Boolean, nullable=False, server_default=sa.true()
        ),
    )
    codes = ", ".join(f"'{code}'" for code in _ACTIVITY_CODES)
    op.create_table(
        "exercise_entries",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("performed_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column(
            "activity", _enum("exercise_activity", *_ACTIVITY_CODES, length=32), nullable=False
        ),
        sa.Column("name", sa.Text, nullable=True),
        sa.Column("minutes", sa.Integer, nullable=False),
        sa.Column("kcal", sa.Numeric(7, 2), nullable=False),
        sa.Column(
            "kcal_source",
            _enum("exercise_kcal_source", "estimated", "manual", length=16),
            nullable=False,
        ),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column(
            "updated_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_exercise_entries"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_exercise_entries_user_id_users",
            ondelete="CASCADE",
        ),
        # name= 是命名慣例的輸入（同 0013、0018、0019）：最後是 ck_exercise_entries_<name>。
        # 列舉欄位用 create_constraint=False，這兩條手寫的 CHECK 就是它們唯一的約束。
        sa.CheckConstraint(f"activity IN ({codes})", name="activity_valid"),
        sa.CheckConstraint("kcal_source IN ('estimated', 'manual')", name="kcal_source_valid"),
        sa.CheckConstraint("(activity = 'other') = (name IS NOT NULL)", name="other_has_name"),
        sa.CheckConstraint(
            "activity <> 'other' OR kcal_source = 'manual'", name="other_is_manual"
        ),
        sa.CheckConstraint("char_length(name) BETWEEN 1 AND 50", name="name_length"),
        sa.CheckConstraint("minutes BETWEEN 1 AND 600", name="minutes_range"),
        sa.CheckConstraint("kcal BETWEEN 1 AND 5000", name="kcal_range"),
        sa.CheckConstraint("char_length(note) <= 200", name="note_length"),
    )
    op.create_index(
        "ix_exercise_entries_user_id_performed_at",
        "exercise_entries",
        ["user_id", "performed_at"],
    )


def downgrade() -> None:
    op.drop_index("ix_exercise_entries_user_id_performed_at", table_name="exercise_entries")
    op.drop_table("exercise_entries")
    op.drop_column("users", "exercise_adds_to_budget")
