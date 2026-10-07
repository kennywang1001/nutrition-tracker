"""unique expense per meal

Revision ID: 0015
Revises: 0014
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 先查重複（安全補強規格 §3.2）。有的話**失敗**，不自動刪——那是錢的紀錄，
    # 要人看過再決定刪哪一筆。
    duplicates = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT meal_id FROM expenses WHERE meal_id IS NOT NULL "
                "GROUP BY meal_id HAVING count(*) > 1 ORDER BY meal_id"
            )
        )
        .scalars()
        .all()
    )
    if duplicates:
        raise RuntimeError(
            "這些餐有不只一筆餐費，無法建立唯一索引："
            f"meal_id {', '.join(str(d) for d in duplicates)}。"
            "這是錢的紀錄，migration 不會自動刪——到報表裡刪掉多的那筆再升級。"
        )
    op.drop_index("ix_expenses_meal_id", table_name="expenses")
    # 部分唯一索引：手動記的帳 meal_id 是 null，不受限制。它同時服務
    # ON DELETE SET NULL 的查找（舊的 ix_expenses_meal_id 的用途）。
    op.create_index(
        "uq_expenses_meal_id",
        "expenses",
        ["meal_id"],
        unique=True,
        postgresql_where=sa.text("meal_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_expenses_meal_id", table_name="expenses")
    op.create_index("ix_expenses_meal_id", "expenses", ["meal_id"])
