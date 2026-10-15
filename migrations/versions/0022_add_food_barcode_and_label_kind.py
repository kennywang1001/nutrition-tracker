"""add foods.barcode and 'label' to ai_analyses.kind

Revision ID: 0022
Revises: 0021
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0022"
down_revision: str | None = "0021"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 掃條碼規格 §10.1。既有的食物全部是 NULL：加一個可以是空的欄位不重寫表。
    op.add_column("foods", sa.Column("barcode", sa.Text(), nullable=True))
    # 名稱傳短的：命名慣例會套成 ck_foods_barcode_digits（同 0009、0021 的說明）。
    # CHECK 的文字 alembic check 不比——tests/test_foods_barcode_model.py 用真的寫入去撞。
    op.create_check_constraint("barcode_digits", "foods", "barcode ~ '^([0-9]{8}|[0-9]{13})$'")
    op.create_index("uq_foods_owner_id_barcode", "foods", ["owner_id", "barcode"], unique=True)
    op.create_index(
        "uq_foods_global_barcode",
        "foods",
        ["barcode"],
        unique=True,
        postgresql_where=sa.text("owner_id IS NULL"),
    )
    # 'label' 5 個字：0021 已經把欄位加寬到 VARCHAR(7)，這裡只換 CHECK。
    #
    # 退版安全（不進 scripts/deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS）：舊程式的 Food 沒有 barcode
    # （SELECT 只列它知道的欄位、INSERT 不帶 → NULL，CHECK 與兩個索引都放行 NULL）；舊程式從不載入
    # 別人的 ai_analyses.kind（額度只數列數，見 app/models/ai_analysis.py 的 SUGGEST）。
    op.drop_constraint("kind_valid", "ai_analyses", type_="check")
    op.create_check_constraint(
        "kind_valid", "ai_analyses", "kind IN ('text', 'image', 'suggest', 'label')"
    )


def downgrade() -> None:
    # 營養標示的列改記成 image：列數留著（今天的額度不變），只是分不出是營養標示。
    op.execute("UPDATE ai_analyses SET kind = 'image' WHERE kind = 'label'")
    op.drop_constraint("kind_valid", "ai_analyses", type_="check")
    op.create_check_constraint(
        "kind_valid", "ai_analyses", "kind IN ('text', 'image', 'suggest')"
    )
    # 條碼的資料會不見。
    op.drop_index("uq_foods_global_barcode", table_name="foods")
    op.drop_index("uq_foods_owner_id_barcode", table_name="foods")
    op.drop_constraint("barcode_digits", "foods", type_="check")
    op.drop_column("foods", "barcode")
