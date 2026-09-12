"""create refresh_sessions

Revision ID: 0007
Revises: 0006
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import UUID

revision: str = "0007"
down_revision: str | None = "0006"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "refresh_sessions",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("jti", UUID(as_uuid=True), nullable=False),
        sa.Column("family_id", UUID(as_uuid=True), nullable=False),
        sa.Column("issued_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True)),
        sa.Column("revoked_at", sa.DateTime(timezone=True)),
        sa.PrimaryKeyConstraint("id", name="pk_refresh_sessions"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_refresh_sessions_user_id_users",
            ondelete="CASCADE",
        ),
        # 名稱必須跟 NAMING_CONVENTION 的 uq 樣板算出來的一致
        # （uq_%(table_name)s_%(column_0_N_name)s）。差一個字 alembic check 就紅，
        # 而那個紅燈的訊息不會告訴你「只是名字不一樣」。
        sa.UniqueConstraint("jti", name="uq_refresh_sessions_jti"),
        # 注意：這裡故意用「原始」名字 expires_after_issued，不是完整的
        # ck_refresh_sessions_expires_after_issued —— op.create_table 內部的
        # 暫時 MetaData 會從 env.py 的 target_metadata 繼承 NAMING_CONVENTION
        # （見 alembic.operations.schemaobj.SchemaObjects.metadata），所以
        # CheckConstraint 的 name= 在這裡跟模型裡一樣，是樣板的**輸入**
        # （%(constraint_name)s token）而不是最終名字。uq / fk / pk 三種樣板
        # 不含 %(constraint_name)s token，給完整名字不影響結果，所以之前那三個
        # 沒事；ck 樣板含這個 token，給完整名字會被再套一次樣板，變成
        # ck_refresh_sessions_ck_refresh_sessions_expires_after_issued，
        # alembic check 因此報漂移（實測驗證，非猜測）。
        sa.CheckConstraint("expires_at > issued_at", name="expires_after_issued"),
    )
    # 核心不變量：一個 family 最多一張活票（規格 §3.1）。
    # postgresql_where 的述詞必須跟模型裡拼得一模一樣，否則 alembic check 報漂移。
    op.create_index(
        "uq_refresh_sessions_one_live_per_family",
        "refresh_sessions",
        ["family_id"],
        unique=True,
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )
    op.create_index("ix_refresh_sessions_family_id", "refresh_sessions", ["family_id"])
    op.create_index(
        "ix_refresh_sessions_user_id_revoked_at",
        "refresh_sessions",
        ["user_id", "revoked_at"],
    )


def downgrade() -> None:
    op.drop_table("refresh_sessions")
