"""create foods, food_revisions, food_portions

Revision ID: 0002
Revises: 0001
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op
from sqlalchemy.dialects.postgresql import ENUM, JSONB

revision: str = "0002"
down_revision: str | None = "0001"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    revision_status = sa.Enum("pending", "approved", "rejected", name="revision_status")
    revision_status.create(op.get_bind())
    base_unit = sa.Enum("g", "ml", name="base_unit")
    base_unit.create(op.get_bind())

    op.create_table(
        "foods",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("name", sa.Text, nullable=False),
        sa.Column("brand", sa.Text),
        sa.Column("owner_id", sa.BigInteger),
        sa.Column("current_revision_id", sa.BigInteger),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.PrimaryKeyConstraint("id", name="pk_foods"),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_foods_owner_id_users", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_foods_created_by_users"
        ),
    )

    op.create_table(
        "food_revisions",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("food_id", sa.BigInteger, nullable=False),
        sa.Column(
            "base_unit",
            ENUM("g", "ml", name="base_unit", create_type=False),
            nullable=False,
            server_default="g",
        ),
        sa.Column("kcal", sa.Numeric(8, 2), nullable=False),
        sa.Column("protein_g", sa.Numeric(8, 2), nullable=False),
        sa.Column("fat_g", sa.Numeric(8, 2), nullable=False),
        sa.Column("carb_g", sa.Numeric(8, 2), nullable=False),
        sa.Column(
            "status",
            ENUM("pending", "approved", "rejected", name="revision_status", create_type=False),
            nullable=False,
            server_default="pending",
        ),
        sa.Column("change_note", sa.Text),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at", sa.DateTime(timezone=True), nullable=False, server_default=sa.func.now()
        ),
        sa.Column("reviewed_by", sa.BigInteger),
        sa.Column("reviewed_at", sa.DateTime(timezone=True)),
        sa.Column("reject_reason", sa.Text),
        sa.Column("source", sa.Text, nullable=False, server_default="user"),
        sa.Column("ai_confidence", sa.Numeric(3, 2)),
        sa.Column("ai_raw_response", JSONB),
        sa.PrimaryKeyConstraint("id", name="pk_food_revisions"),
        sa.ForeignKeyConstraint(
            ["food_id"], ["foods.id"], name="fk_food_revisions_food_id_foods", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["created_by"], ["users.id"], name="fk_food_revisions_created_by_users"
        ),
        sa.ForeignKeyConstraint(
            ["reviewed_by"], ["users.id"], name="fk_food_revisions_reviewed_by_users"
        ),
        # 注意：naming convention 是 "ck": "ck_%(table_name)s_%(constraint_name)s"，
        # 這裡的 name= 會被當成 %(constraint_name)s 的輸入去組出最終名稱
        # （跟 app/models/food.py 的寫法一致），不能直接寫最終的完整名稱，
        # 否則會被再套用一次 convention，變成雙重前綴
        # （ck_food_revisions_ck_food_revisions_kcal_non_negative）。
        sa.CheckConstraint("kcal >= 0", name="kcal_non_negative"),
        sa.CheckConstraint("protein_g >= 0", name="protein_non_negative"),
        sa.CheckConstraint("fat_g >= 0", name="fat_non_negative"),
        sa.CheckConstraint("carb_g >= 0", name="carb_non_negative"),
        sa.CheckConstraint(
            "ai_confidence IS NULL OR (ai_confidence >= 0 AND ai_confidence <= 1)",
            name="ai_confidence_in_range",
        ),
        sa.CheckConstraint(
            "status <> 'rejected' OR reject_reason IS NOT NULL",
            name="rejected_needs_reason",
        ),
    )

    # 循環外鍵：foods 先建好才有 food_revisions 可以指，所以這條要最後加，
    # 而且必須 DEFERRABLE INITIALLY DEFERRED —— 否則「建立食物 + 建立第一版
    # + 回填指標」沒辦法在同一個交易內完成。
    op.create_foreign_key(
        "fk_foods_current_revision_id_food_revisions",
        "foods",
        "food_revisions",
        ["current_revision_id"],
        ["id"],
        deferrable=True,
        initially="DEFERRED",
    )

    op.create_table(
        "food_portions",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("food_id", sa.BigInteger, nullable=False),
        sa.Column("owner_id", sa.BigInteger),
        sa.Column("label", sa.Text, nullable=False),
        sa.Column("grams", sa.Numeric(8, 2), nullable=False),
        sa.Column("is_default", sa.Boolean, nullable=False, server_default=sa.false()),
        sa.PrimaryKeyConstraint("id", name="pk_food_portions"),
        sa.ForeignKeyConstraint(
            ["food_id"], ["foods.id"], name="fk_food_portions_food_id_foods", ondelete="CASCADE"
        ),
        sa.ForeignKeyConstraint(
            ["owner_id"], ["users.id"], name="fk_food_portions_owner_id_users", ondelete="CASCADE"
        ),
        sa.CheckConstraint("grams > 0", name="grams_positive"),
    )

    # NULLS NOT DISTINCT 讓「兩個全域的同名食物」被視為重複。
    # op.create_unique_constraint 不支援這個選項，只能用原生 SQL。
    op.execute(
        "ALTER TABLE foods ADD CONSTRAINT uq_foods_owner_id_name_brand "
        "UNIQUE NULLS NOT DISTINCT (owner_id, name, brand)"
    )
    op.execute(
        "ALTER TABLE food_portions ADD CONSTRAINT uq_food_portions_food_id_owner_id_label "
        "UNIQUE NULLS NOT DISTINCT (food_id, owner_id, label)"
    )

    op.create_index("ix_foods_owner_id", "foods", ["owner_id"])
    op.create_index(
        "ix_foods_name_trgm", "foods", ["name"], postgresql_using="gin",
        postgresql_ops={"name": "gin_trgm_ops"},
    )
    op.create_index(
        "uq_food_revisions_one_pending", "food_revisions", ["food_id"],
        unique=True, postgresql_where=sa.text("status = 'pending'"),
    )
    op.create_index(
        "ix_food_revisions_pending", "food_revisions", ["status", "created_at"],
        postgresql_where=sa.text("status = 'pending'"),
    )


def downgrade() -> None:
    op.drop_table("food_portions")
    op.drop_constraint("fk_foods_current_revision_id_food_revisions", "foods")
    op.drop_table("food_revisions")
    op.drop_table("foods")
    sa.Enum(name="base_unit").drop(op.get_bind())
    sa.Enum(name="revision_status").drop(op.get_bind())
