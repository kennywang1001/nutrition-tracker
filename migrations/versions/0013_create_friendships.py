"""create friendships

Revision ID: 0013
Revises: 0012
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0013"
down_revision: str | None = "0012"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "friendships",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_a", sa.BigInteger, nullable=False),
        sa.Column("user_b", sa.BigInteger, nullable=False),
        sa.Column("requested_by", sa.BigInteger, nullable=False),
        sa.Column(
            "status",
            sa.Enum(
                "pending",
                "accepted",
                name="friendship_status",
                native_enum=False,
                create_constraint=False,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("accepted_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_friendships"),
        sa.UniqueConstraint("user_a", "user_b", name="uq_friendships_user_a_user_b"),
        sa.ForeignKeyConstraint(
            ["user_a"], ["users.id"], name="fk_friendships_user_a_users", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["user_b"], ["users.id"], name="fk_friendships_user_b_users", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["requested_by"],
            ["users.id"],
            name="fk_friendships_requested_by_users",
            ondelete="CASCADE",
        ),
        # name= 是命名慣例的輸入（同 0010、0011 的寫法）。
        sa.CheckConstraint("user_a < user_b", name="ordered_pair"),
        sa.CheckConstraint("requested_by IN (user_a, user_b)", name="requester_in_pair"),
        sa.CheckConstraint("status IN ('pending', 'accepted')", name="status_valid"),
        sa.CheckConstraint(
            "(status = 'accepted') = (accepted_at IS NOT NULL)",
            name="accepted_at_matches_status",
        ),
    )
    op.create_index("ix_friendships_user_b", "friendships", ["user_b"])


def downgrade() -> None:
    op.drop_table("friendships")
