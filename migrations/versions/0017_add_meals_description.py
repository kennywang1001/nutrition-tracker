"""add meals.description

Revision ID: 0017
Revises: 0016
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0017"
down_revision: str | None = "0016"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 只加一個可以是 NULL 的欄位：既有的餐都是 NULL，舊版程式不認得它也照樣能寫入
    # （INSERT 不帶這一欄）。所以這一版可以退版，不用進 deploy.sh 的
    # ROLLBACK_UNSAFE_REVISIONS。長度（500）在 schema 擋，跟 note 一樣沒有 CHECK。
    op.add_column("meals", sa.Column("description", sa.Text, nullable=True))


def downgrade() -> None:
    op.drop_column("meals", "description")
