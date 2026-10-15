"""`GET /api/planner/library-suggestions`：今天還能吃什麼——從常吃的食物配
（營養素配餐規格 §4、D13、D14）。只讀、只看呼叫者自己的資料。"""

from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.day_budget import load_day_budget
from app.days import today_in_timezone
from app.db import get_db
from app.models.food import FoodPortion
from app.models.user import User
from app.nutrition import Macros
from app.planner import Combo, Remaining, is_full, suggest_combos
from app.planner_data import PlannerFood, load_candidates, remaining_of
from app.schemas.food import FoodResponse
from app.schemas.planner import (
    LibrarySuggestionsResponse,
    PlannedComboResponse,
    PlannedItemResponse,
    PlannedPortionResponse,
    PlannerStatus,
    RemainingResponse,
)
from app.schemas.stats import MacrosResponse, NullableMacrosResponse

router = APIRouter(prefix="/planner", tags=["planner"])

_CENTS = Decimal("0.01")


def _remaining_response(remaining: Remaining) -> RemainingResponse:
    return RemainingResponse(
        kcal=remaining.kcal,
        protein_g=remaining.protein_g,
        fat_g=remaining.fat_g,
        carb_g=remaining.carb_g,
    )


def _macros(macros: Macros) -> MacrosResponse:
    return MacrosResponse(
        kcal=macros.kcal, protein_g=macros.protein_g, fat_g=macros.fat_g, carb_g=macros.carb_g
    )


def _portion_response(portion: FoodPortion) -> PlannedPortionResponse:
    return PlannedPortionResponse(id=portion.id, label=portion.label, grams=portion.grams)


def _fill(total: Decimal, left: Decimal | None) -> Decimal | None:
    # 同 `/stats/daily` 的 `_ratio_field`：不考慮（null）或 0 → null，其餘四捨五入到兩位。
    if left is None or left == 0:
        return None
    return (total / left).quantize(_CENTS, rounding=ROUND_HALF_UP)


def _combo_response(
    combo: Combo, foods: list[PlannerFood], remaining: Remaining
) -> PlannedComboResponse:
    items = []
    for choice in combo.choices:
        planned = foods[choice.candidate]
        portion = planned.portion
        items.append(
            PlannedItemResponse(
                food=FoodResponse.of(planned.food, planned.revision),
                portion=None if portion is None else _portion_response(portion),
                quantity=choice.quantity,
                quantity_g=choice.quantity_g,
                nutrition=_macros(choice.macros),
            )
        )
    total = combo.total
    return PlannedComboResponse(
        items=items,
        total=_macros(total),
        fill=NullableMacrosResponse(
            kcal=_fill(total.kcal, remaining.kcal),
            protein_g=_fill(total.protein_g, remaining.protein_g),
            fat_g=_fill(total.fat_g, remaining.fat_g),
            carb_g=_fill(total.carb_g, remaining.carb_g),
        ),
    )


@router.get("/library-suggestions", response_model=LibrarySuggestionsResponse)
async def library_suggestions(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> LibrarySuggestionsResponse:
    """今天還剩多少，以及從常吃、最近吃的食物配出的最多 3 組（1～3 樣）。

    `status`：`no_target`（沒有熱量目標）、`full`（剩不到 50 kcal）、`no_candidates`（還沒有
    記過有營養素的食物）、`no_fit`（每一樣最小的量就超過剩下的 105%）、`ok`。「今天」是
    使用者時區的今天；熱量的剩下用今天的額度（運動設定開時含運動）。不寫任何東西。
    """
    user_id, tz_name = user.id, user.timezone
    adds_exercise = user.exercise_adds_to_budget
    day = today_in_timezone(tz_name)
    budget = await load_day_budget(
        db, user_id=user_id, tz_name=tz_name, adds_exercise=adds_exercise, day=day
    )
    remaining = remaining_of(budget)

    def respond(
        status: PlannerStatus, combos: list[PlannedComboResponse] | None = None
    ) -> LibrarySuggestionsResponse:
        return LibrarySuggestionsResponse(
            date=day,
            status=status,
            remaining=None if remaining is None else _remaining_response(remaining),
            combos=combos or [],
        )

    if remaining is None:
        return respond(PlannerStatus.NO_TARGET)
    if is_full(remaining):
        return respond(PlannerStatus.FULL)
    foods = await load_candidates(db, user)
    if not foods:
        return respond(PlannerStatus.NO_CANDIDATES)
    combos = suggest_combos([food.candidate() for food in foods], remaining)
    if not combos:
        return respond(PlannerStatus.NO_FIT)
    return respond(
        PlannerStatus.OK, [_combo_response(combo, foods, remaining) for combo in combos]
    )
