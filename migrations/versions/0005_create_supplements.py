"""create supplements, supplement_plans, supplement_intakes

Revision ID: 0005
Revises: 0004
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ExcludeConstraint

revision: str = "0005"
down_revision: str | None = "0004"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "supplements",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("brand", sa.Text),
        sa.Column("owner_id", sa.BigInteger),
        sa.Column("serving_unit", sa.Text, nullable=False),
        sa.Column("serving_size", sa.Numeric(8, 2), nullable=False),
        sa.Column("kcal", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("protein_g", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("fat_g", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("carb_g", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_supplements"),
        sa.ForeignKeyConstraint(
            ["owner_id"],
            ["users.id"],
            name="fk_supplements_owner_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_supplements_created_by_users"
        ),
        sa.CheckConstraint("serving_size > 0", name="serving_size_positive"),
        sa.CheckConstraint("kcal >= 0", name="kcal_non_negative"),
        sa.CheckConstraint("protein_g >= 0", name="protein_non_negative"),
        sa.CheckConstraint("fat_g >= 0", name="fat_non_negative"),
        sa.CheckConstraint("carb_g >= 0", name="carb_non_negative"),
        sa.UniqueConstraint(
            "owner_id",
            "name",
            "brand",
            name="uq_supplements_owner_id_name_brand",
            postgresql_nulls_not_distinct=True,
        ),
    )

    op.create_table(
        "supplement_plans",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("supplement_id", sa.BigInteger, nullable=False),
        sa.Column("dose", sa.Numeric(8, 2), nullable=False),
        # native_enum=False：VARCHAR + CHECK，不是原生 PG enum（規格決策 7）。
        # 不設 create_constraint：CHECK 由下面自己宣告的 CheckConstraint 負責，
        # 跟 0004 的 meal_type 寫法一致（見 app/models/meal.py 的註解 ——
        # create_constraint=True 產生的是 type-bound CHECK，會讓 alembic check
        # 永遠回報漂移）。
        sa.Column(
            "time_of_day",
            sa.Enum(
                "morning",
                "noon",
                "evening",
                "bedtime",
                "preworkout",
                "postworkout",
                name="time_of_day",
                native_enum=False,
            ),
            nullable=False,
        ),
        sa.Column("effective_from", sa.Date, nullable=False),
        sa.Column("effective_to", sa.Date),
        sa.PrimaryKeyConstraint("id", name="pk_supplement_plans"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_supplement_plans_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["supplement_id"],
            ["supplements.id"],
            name="fk_supplement_plans_supplement_id_supplements",
        ),
        sa.CheckConstraint("dose > 0", name="dose_positive"),
        sa.CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="effective_range",
        ),
        sa.CheckConstraint(
            "time_of_day IN ('morning', 'noon', 'evening', 'bedtime', "
            "'preworkout', 'postworkout')",
            name="time_of_day_valid",
        ),
        # 決定 2：規格第 6.4 節漏掉的 EXCLUDE 不重疊約束（已實測，見計畫 Task 1）。
        # 欄位用字串名、運算式用 text()，編譯出的 DDL 完全正確。命名慣例不會替
        # ExcludeConstraint 加前綴（app/models/base.py 的 NAMING_CONVENTION 沒有
        # "ex" 這個 key），所以 ex_ 前綴要自己寫進 name= 裡。
        ExcludeConstraint(
            ("user_id", "="),
            ("supplement_id", "="),
            ("time_of_day", "="),
            (sa.text("daterange(effective_from, effective_to, '[)')"), "&&"),
            name="ex_supplement_plans_no_overlap",
            using="gist",
        ),
    )
    op.create_index(
        "ix_supplement_plans_user_id_effective",
        "supplement_plans",
        ["user_id", "effective_from", "effective_to"],
    )

    op.create_table(
        "supplement_intakes",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("supplement_id", sa.BigInteger, nullable=False),
        # NULL = 臨時吃的（不屬於任何固定清單）
        sa.Column("plan_id", sa.BigInteger),
        sa.Column("dose", sa.Numeric(8, 2), nullable=False),
        sa.Column("taken_at", sa.DateTime(timezone=True), nullable=False),
        # 快照：這一次攝取的總量（已乘過 dose），見計畫決定 3
        sa.Column("kcal", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("protein_g", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("fat_g", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column("carb_g", sa.Numeric(8, 2), nullable=False, server_default="0"),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.PrimaryKeyConstraint("id", name="pk_supplement_intakes"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_supplement_intakes_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["supplement_id"],
            ["supplements.id"],
            name="fk_supplement_intakes_supplement_id_supplements",
        ),
        # 計畫被刪除時打卡紀錄仍要留著（歷史不能因為計畫被刪而消失），
        # 但不再屬於任何計畫 —— 跟 meal_items.portion_id 是同一個處理。
        sa.ForeignKeyConstraint(
            ["plan_id"],
            ["supplement_plans.id"],
            name="fk_supplement_intakes_plan_id_supplement_plans",
            ondelete="SET NULL",
        ),
        sa.CheckConstraint("dose > 0", name="dose_positive"),
    )
    op.create_index(
        "ix_supplement_intakes_user_id_taken_at",
        "supplement_intakes",
        ["user_id", "taken_at"],
    )


def downgrade() -> None:
    op.drop_table("supplement_intakes")
    op.drop_table("supplement_plans")
    op.drop_table("supplements")
