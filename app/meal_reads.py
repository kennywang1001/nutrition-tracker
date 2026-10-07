"""讀餐點時共用的查詢（`/api/meals` 與好友的讀取都用）。"""

from sqlalchemy import Select, select

from app.models.food import Food, FoodRevision
from app.models.meal import MealItem


def item_join_query() -> Select[tuple[MealItem, FoodRevision, Food]]:
    """項目 join 它釘住的 revision、再 join 該 revision 當時所屬的食物。

    刻意不用 `selectinload`：模型沒有宣告 `relationship()`。明確的兩層 join
    一次把項目、營養素、食物名稱都帶回來——查詢次數跟項目數無關。
    """
    return (
        select(MealItem, FoodRevision, Food)
        .join(FoodRevision, MealItem.food_revision_id == FoodRevision.id)
        .join(Food, FoodRevision.food_id == Food.id)
    )
