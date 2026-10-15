"""營養素配餐讀資料庫的部分：候選食物、它們的預設份量、今天剩下的額度（規格 D1、D8、D12）。

只用呼叫端給的使用者。健康相關：這個模組不寫 log（tests/test_planner_privacy.py 掃）。
"""

from dataclasses import dataclass

from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.routes.foods import my_recorded_foods_stmt
from app.day_budget import DayBudget
from app.models.food import Food, FoodPortion, FoodRevision
from app.models.meal import Meal
from app.models.user import User
from app.nutrition import Macros
from app.planner import Candidate, Remaining, remaining_for

# 規格 D12：常吃的與最近吃的，去重後最多 30 個。
CANDIDATE_LIMIT = 30
# 常吃的先佔前 20 個，最近吃的補滿 30。**不能是「常吃前 30 再補最近的」**：兩個查詢來自同一批
# 食物，記過 30 個以上時常吃的就已經滿 30、最近的一個都進不來；不到 30 個時常吃的已經是全部。
# 那樣第二個查詢永遠是白做，新記的食物（次數 1、id 大）在記過很多食物之後永遠不是候選。
FREQUENT_SLOTS = 20


@dataclass(frozen=True)
class PlannerFood:
    food: Food
    revision: FoodRevision
    portion: FoodPortion | None

    def candidate(self) -> Candidate:
        return Candidate(
            per_100=Macros(
                kcal=self.revision.kcal,
                protein_g=self.revision.protein_g,
                fat_g=self.revision.fat_g,
                carb_g=self.revision.carb_g,
            ),
            portion_grams=self.portion.grams if self.portion is not None else None,
        )


def remaining_of(budget: DayBudget) -> Remaining | None:
    target = budget.target
    return remaining_for(
        kcal_budget=budget.kcal_budget,
        protein_target=target.protein_g if target is not None else None,
        fat_target=target.fat_g if target is not None else None,
        carb_target=target.carb_g if target is not None else None,
        actual=budget.macros.actual,
    )


async def load_candidates(db: AsyncSession, user: User) -> list[PlannerFood]:
    """常吃的前 `FREQUENT_SLOTS` 個在前、最近吃的補上（再不夠就用剩下的常吃的），去重、
    最多 `CANDIDATE_LIMIT` 個；只要有生效版本的。順序就是解題器平手時的順序（規格 D10）。"""
    frequent = (
        await db.execute(
            my_recorded_foods_stmt(
                user, CANDIDATE_LIMIT, func.count().desc(), require_nutrition=True
            )
        )
    ).all()
    recent = (
        await db.execute(
            my_recorded_foods_stmt(
                user, CANDIDATE_LIMIT, func.max(Meal.eaten_at).desc(), require_nutrition=True
            )
        )
    ).all()
    seen: set[int] = set()
    rows: list[tuple[Food, FoodRevision]] = []
    for food, revision in [*frequent[:FREQUENT_SLOTS], *recent, *frequent[FREQUENT_SLOTS:]]:
        if food.id in seen:
            continue
        seen.add(food.id)
        rows.append((food, revision))
        if len(rows) == CANDIDATE_LIMIT:
            break
    if not rows:
        return []
    portions = await _default_portions(db, user.id, [food.id for food, _ in rows])
    return [PlannerFood(food, revision, portions.get(food.id)) for food, revision in rows]


async def _default_portions(
    db: AsyncSession, user_id: int, food_ids: list[int]
) -> dict[int, FoodPortion]:
    """每個食物的預設份量：自己的優先，再來是公開的（同前端 `pickDefaultPortion`；規格 D8）。
    別人的私人份量看不到。一次查詢。"""
    portions = (
        await db.scalars(
            select(FoodPortion)
            .where(
                FoodPortion.food_id.in_(food_ids),
                FoodPortion.is_default.is_(True),
                or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user_id),
            )
            # 自己的（`owner_id IS NULL` 是 False）排前面，再用 id 讓結果固定。
            .order_by(FoodPortion.food_id, FoodPortion.owner_id.is_(None), FoodPortion.id)
        )
    ).all()
    result: dict[int, FoodPortion] = {}
    for portion in portions:
        result.setdefault(portion.food_id, portion)
    return result
