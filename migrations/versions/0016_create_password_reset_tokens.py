"""create password reset tokens

Revision ID: 0016
Revises: 0015
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("token_hash", sa.Text, nullable=False),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_password_reset_tokens"),
        sa.UniqueConstraint("token_hash", name="uq_password_reset_tokens_token_hash"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_password_reset_tokens_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name="fk_password_reset_tokens_created_by_users",
            ondelete="CASCADE",
        ),
        # name= 是命名慣例的輸入（同 0011）。
        sa.CheckConstraint("expires_at > created_at", name="expires_after_created"),
        sa.CheckConstraint(
            "used_at IS NULL OR revoked_at IS NULL", name="not_both_used_and_revoked"
        ),
    )
    # 述詞必須跟模型一字不差（同 0007 的說明）。
    op.create_index(
        "uq_password_reset_tokens_one_live_per_user",
        "password_reset_tokens",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("password_reset_tokens")
