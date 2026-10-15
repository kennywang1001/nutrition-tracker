"""add 'suggest' to ai_analyses.kind

Revision ID: 0021
Revises: 0020
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0021"
down_revision: str | None = "0020"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 營養素配餐規格 D18、§6。`native_enum=False` 的 Enum 是「最長的值」那麼長的 VARCHAR：
    # 'text'／'image' 時是 VARCHAR(5)，'suggest' 放不進去。先加寬（PostgreSQL 加寬 varchar
    # 只改目錄、不重寫表）。寫計畫時實測：只改模型、不改欄位，alembic check 報 modify_type；
    # 改成 VARCHAR(7) 之後乾淨。
    #
    # 退版安全（不進 scripts/deploy.sh 的 ROLLBACK_UNSAFE_REVISIONS）：舊程式只寫 'text'／'image'、
    # 額度只數列數，從來不載入別人的 kind（見 app/models/ai_analysis.py 的 AnalysisKind.SUGGEST）。
    op.alter_column(
        "ai_analyses",
        "kind",
        type_=sa.String(length=7),
        existing_type=sa.String(length=5),
        existing_nullable=False,
    )
    # 名稱傳短的：命名慣例會套成 ck_ai_analyses_kind_valid（同 0009 的說明）。
    # CHECK 的文字 alembic check 不比——tests/test_ai_analysis_model.py 直接讀約束定義。
    op.drop_constraint("kind_valid", "ai_analyses", type_="check")
    op.create_check_constraint(
        "kind_valid", "ai_analyses", "kind IN ('text', 'image', 'suggest')"
    )


def downgrade() -> None:
    # 配餐的列改記成 text：列數留著（今天的額度不變），只是分不出是配餐。不改的話
    # 縮回 VARCHAR(5) 會失敗（'suggest' 放不進去），CHECK 也建不起來。
    op.execute("UPDATE ai_analyses SET kind = 'text' WHERE kind = 'suggest'")
    op.drop_constraint("kind_valid", "ai_analyses", type_="check")
    op.create_check_constraint("kind_valid", "ai_analyses", "kind IN ('text', 'image')")
    op.alter_column(
        "ai_analyses",
        "kind",
        type_=sa.String(length=5),
        existing_type=sa.String(length=7),
        existing_nullable=False,
    )
