"""create user_targets

Revision ID: 0006
Revises: 0005
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ExcludeConstraint

revision: str = "0006"
down_revision: str | None = "0005"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "user_targets",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("kcal", sa.Numeric(8, 2)),
        sa.Column("protein_g", sa.Numeric(8, 2)),
        sa.Column("fat_g", sa.Numeric(8, 2)),
        sa.Column("carb_g", sa.Numeric(8, 2)),
        sa.Column("label", sa.Text),
        sa.Column("effective_from", sa.Date, nullable=False),
        sa.Column("effective_to", sa.Date),
        sa.PrimaryKeyConstraint("id", name="pk_user_targets"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_user_targets_user_id_users",
            ondelete="CASCADE",
        ),
        # 陷阱 3：四個營養素欄位皆可為 NULL（允許只設熱量目標）。CHECK 必須是
        # "X IS NULL OR X >= 0"——即使 "X >= 0" 對 NULL 求值也是通過（三值邏輯，
        # NULL >= 0 是 NULL，CHECK 對 NULL 通過），IS NULL OR 把這個意圖寫明。
        sa.CheckConstraint("kcal IS NULL OR kcal >= 0", name="kcal_non_negative"),
        sa.CheckConstraint(
            "protein_g IS NULL OR protein_g >= 0", name="protein_non_negative"
        ),
        sa.CheckConstraint("fat_g IS NULL OR fat_g >= 0", name="fat_non_negative"),
        sa.CheckConstraint("carb_g IS NULL OR carb_g >= 0", name="carb_non_negative"),
        sa.CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="effective_range",
        ),
        # 決定 1：跟計畫 4a 的 supplement_plans 同構 —— 同一個使用者的目標期間
        # 不能重疊。已實測（計畫 4a）：字串欄位名 + text() 運算式的組合編譯出
        # 正確的 DDL。命名慣例不會替 ExcludeConstraint 加前綴，ex_ 前綴自己寫進
        # name= 裡。鍵只有 (user_id, daterange) 兩項——不像 supplement_plans 還有
        # time_of_day，同一個人在同一天只能有一組目標。
        ExcludeConstraint(
            ("user_id", "="),
            (sa.text("daterange(effective_from, effective_to, '[)')"), "&&"),
            name="ex_user_targets_no_overlap",
            using="gist",
        ),
    )
    op.create_index(
        "ix_user_targets_user_id_effective",
        "user_targets",
        ["user_id", "effective_from", "effective_to"],
    )


def downgrade() -> None:
    op.drop_table("user_targets")
