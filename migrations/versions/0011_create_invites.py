"""create invites

Revision ID: 0011
Revises: 0010
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0011"
down_revision: str | None = "0010"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "invites",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("token_hash", sa.Text, nullable=False),
        sa.Column("note", sa.Text, nullable=True),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("used_by", sa.BigInteger, nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_invites"),
        sa.UniqueConstraint("token_hash", name="uq_invites_token_hash"),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_invites_created_by_users", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["used_by"], ["users.id"], name="fk_invites_used_by_users", ondelete="SET NULL"
        ),
        # name= 是命名慣例的輸入（同 0010 的寫法）。
        sa.CheckConstraint("expires_at > created_at", name="expires_after_created"),
        sa.CheckConstraint(
            "used_at IS NULL OR revoked_at IS NULL", name="not_both_used_and_revoked"
        ),
    )


def downgrade() -> None:
    op.drop_table("invites")
