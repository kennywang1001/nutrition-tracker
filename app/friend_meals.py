"""組 `FriendMeal`——好友動態、好友的某一天、單一餐點（社群規格 D7）共用的白名單序列化。

從 `routes/friends.py` 搬出來：單一餐點的端點在另一個路由檔，主人與好友看同一餐要走
**同一個**組法——兩份的話，哪天其中一份多帶一個欄位，就是「好友那條路多漏一個欄位」。
"""

from collections import defaultdict
from collections.abc import Sequence

from sqlalchemy.ext.asyncio import AsyncSession

from app.meal_reads import item_join_query
from app.models.food import Food, FoodRevision
from app.models.meal import Meal, MealItem
from app.models.user import User
from app.nutrition import Macros, scale, total
from app.schemas.friend import FriendMeal, FriendMealItem, PersonResponse
from app.social_visibility import social_counts


async def build_friend_meals(
    db: AsyncSession, viewer_id: int, meals: Sequence[Meal], people: dict[int, User]
) -> list[FriendMeal]:
    """組 `FriendMeal`。營養素用跟 `MealResponse` 同一套（`scale`／`total`，釘住
    當時的 revision）。一次查完所有項目（`meal_id IN (...)`）；讚與留言的數字再兩次查詢
    （`social_counts`），一樣跟餐數無關。

    **呼叫端要自己確認 viewer 看得到這幾餐**——這裡只負責組，不負責擋。"""
    if not meals:
        return []
    counts = await social_counts(db, viewer_id, [meal.id for meal in meals])
    rows = (
        await db.execute(
            item_join_query()
            .where(MealItem.meal_id.in_([meal.id for meal in meals]))
            .order_by(MealItem.id)
        )
    ).all()
    by_meal: dict[int, list[tuple[MealItem, FoodRevision, Food]]] = defaultdict(list)
    for item, revision, food in rows:
        by_meal[item.meal_id].append((item, revision, food))

    result: list[FriendMeal] = []
    for meal in meals:
        items: list[FriendMealItem] = []
        macros_list: list[Macros] = []
        for item, revision, food in by_meal[meal.id]:
            macros = scale(revision, item.quantity_g)
            macros_list.append(macros)
            items.append(
                FriendMealItem(
                    food_name=food.name,
                    quantity_g=item.quantity_g,
                    base_unit=revision.base_unit,
                    kcal=macros.kcal,
                )
            )
        totals = total(macros_list)
        owner = people[meal.user_id]
        result.append(
            FriendMeal(
                id=meal.id,
                user=PersonResponse(id=owner.id, display_name=owner.display_name),
                eaten_at=meal.eaten_at,
                meal_type=meal.meal_type,
                description=meal.description,
                items=items,
                kcal=totals.kcal,
                protein_g=totals.protein_g,
                fat_g=totals.fat_g,
                carb_g=totals.carb_g,
                has_photo=meal.photo_path is not None,
                like_count=counts[meal.id].like_count,
                comment_count=counts[meal.id].comment_count,
                liked_by_me=counts[meal.id].liked_by_me,
            )
        )
    return result
