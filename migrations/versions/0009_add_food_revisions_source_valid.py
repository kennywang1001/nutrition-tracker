"""add food_revisions source_valid check constraint

Revision ID: 0009
Revises: 0008
"""

from collections.abc import Sequence

from alembic import op

revision: str = "0009"
down_revision: str | None = "0008"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # `food_revisions.source` 從 0002（第一版 migration）就存在，一直是
    # `TEXT NOT NULL DEFAULT 'user'`，但**從來沒有 CheckConstraint**——
    # P2 Task 6 是第一個真的讓使用者輸入（透過 `POST /api/foods` 的
    # `FoodCreateRequest.source`）能影響這一欄的呼叫端，實測確認資料庫這一側
    # 完全不擋，任何字串都插得進去。
    #
    # app/schemas/food.py 的 `Literal["user", "ai", "official"]` 在 API 層先擋
    # 一次，但 Pydantic 只保護這一個進來的端點——`food_revisions` 這張表本身
    # 沒有理由假設「以後只有這一條路會寫它」。跟 app/models/ai_analysis.py 的
    # `kind_valid` / app/models/meal.py 的 `meal_type_valid` 同一個理由：
    # DB 層的 CheckConstraint 才是不管哪個呼叫端寫入都成立的保證。
    op.create_check_constraint(
        "source_valid", "food_revisions", "source IN ('user', 'ai', 'official')"
    )


def downgrade() -> None:
    # 注意：`op.drop_constraint` 跟 `op.create_check_constraint` 一樣，
    # 傳進去的名稱一樣會被 NAMING_CONVENTION 的 %(constraint_name)s 樣板套用
    # 一次——傳完整名稱 "ck_food_revisions_source_valid" 進去，實測會被
    # 再套一次樣板變成 "ck_food_revisions_ck_food_revisions_source_valid"，
    # 導致 UndefinedObjectError。跟 upgrade() 一樣傳短名稱 "source_valid"。
    op.drop_constraint("source_valid", "food_revisions", type_="check")
