"""create social tables

Revision ID: 0018
Revises: 0017
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0018"
down_revision: str | None = "0017"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def _id() -> sa.Column:
    return sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False)


def _created_at() -> sa.Column:
    return sa.Column(
        "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
    )


def _fk(table: str, column: str, target: str) -> sa.ForeignKeyConstraint:
    return sa.ForeignKeyConstraint(
        [column], [f"{target}.id"], name=f"fk_{table}_{column}_{target}", ondelete="CASCADE"
    )


def upgrade() -> None:
    # 只有新表：舊版程式不讀不寫它們，所以這一版可以退版，
    # 不用進 deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS。
    op.create_table(
        "meal_likes",
        _id(),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_meal_likes"),
        sa.UniqueConstraint("meal_id", "user_id", name="uq_meal_likes_meal_id_user_id"),
        _fk("meal_likes", "meal_id", "meals"),
        _fk("meal_likes", "user_id", "users"),
    )
    op.create_table(
        "meal_comments",
        _id(),
        sa.Column("meal_id", sa.BigInteger, nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("body", sa.Text, nullable=False),
        _created_at(),
        sa.PrimaryKeyConstraint("id", name="pk_meal_comments"),
        _fk("meal_comments", "meal_id", "meals"),
        _fk("meal_comments", "user_id", "users"),
        # name= 是命名慣例的輸入（同 0013）。
        sa.CheckConstraint("char_length(body) BETWEEN 1 AND 200", name="body_length"),
    )
    op.create_index("ix_meal_comments_meal_id_id", "meal_comments", ["meal_id", "id"])
    op.create_table(
        "notifications",
        _id(),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("actor_id", sa.BigInteger, nullable=False),
        sa.Column(
            "type",
            sa.Enum(
                "like",
                "comment",
                "friend_request",
                "friend_accepted",
                name="notification_type",
                native_enum=False,
                create_constraint=False,
                length=16,
            ),
            nullable=False,
        ),
        sa.Column("meal_id", sa.BigInteger, nullable=True),
        sa.Column("comment_id", sa.BigInteger, nullable=True),
        _created_at(),
        sa.Column("read_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_notifications"),
        _fk("notifications", "user_id", "users"),
        _fk("notifications", "actor_id", "users"),
        _fk("notifications", "meal_id", "meals"),
        _fk("notifications", "comment_id", "meal_comments"),
        sa.CheckConstraint("user_id <> actor_id", name="not_self"),
        # 這一條同時是 type 的手寫約束：四種以外的值三個分支都不成立。
        sa.CheckConstraint(
            "(type = 'like' AND meal_id IS NOT NULL AND comment_id IS NULL)"
            " OR (type = 'comment' AND meal_id IS NOT NULL AND comment_id IS NOT NULL)"
            " OR (type IN ('friend_request', 'friend_accepted')"
            " AND meal_id IS NULL AND comment_id IS NULL)",
            name="shape_matches_type",
        ),
    )
    # 述詞必須跟模型一字不差（同 0007 的說明）。
    op.create_index(
        "uq_notifications_like",
        "notifications",
        ["user_id", "actor_id", "meal_id"],
        unique=True,
        postgresql_where=sa.text("type = 'like'"),
    )
    op.create_index("ix_notifications_user_id_id", "notifications", ["user_id", "id"])
    op.create_index(
        "ix_notifications_unread",
        "notifications",
        ["user_id"],
        postgresql_where=sa.text("read_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("notifications")
    op.drop_table("meal_comments")
    op.drop_table("meal_likes")
