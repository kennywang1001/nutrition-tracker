"""create ai_analyses

Revision ID: 0008
Revises: 0007
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0008"
down_revision: str | None = "0007"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "ai_analyses",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        # native_enum=False：不是原生 PG enum，而是 VARCHAR + CHECK。CHECK 由
        # 下面自己宣告的 CheckConstraint 負責——見 app/models/ai_analysis.py
        # 的註解，type-bound 的自動 CHECK 會讓 alembic check 永遠回報漂移
        # （meal_type 已經踩過一次，見 migrations/0004 / app/models/meal.py）。
        sa.Column(
            "kind",
            sa.Enum("text", "image", name="analysis_kind", native_enum=False),
            nullable=False,
        ),
        sa.Column("model", sa.Text, nullable=False),
        sa.Column("input_hash", sa.Text, nullable=False),
        sa.Column("succeeded", sa.Boolean, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_ai_analyses"),
        sa.ForeignKeyConstraint(
            ["user_id"], ["users.id"], name="fk_ai_analyses_user_id_users"
        ),
        # 注意：name= 是 NAMING_CONVENTION 的 %(constraint_name)s 樣板輸入，
        # 不是最終名稱（最終會是 ck_ai_analyses_kind_valid）——跟
        # migrations/0004、app/models/meal.py 的寫法一致（陷阱表第 1 條）。
        sa.CheckConstraint("kind IN ('text', 'image')", name="kind_valid"),
    )
    # 額度查詢是 WHERE user_id = ? AND created_at >= ?（規格 §7.2）。
    # 順序是 (user_id, created_at)，不是反過來——篩選力來自 user_id，理由見
    # app/models/ai_analysis.py 的註解。
    op.create_index(
        "ix_ai_analyses_user_id_created_at", "ai_analyses", ["user_id", "created_at"]
    )


def downgrade() -> None:
    op.drop_table("ai_analyses")
