from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, status
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError, NotFoundError, UnprocessableEntityError
from app.food_visibility import load_visible_food
from app.models.food import FoodPortion, FoodRevision
from app.models.meal import Meal, MealItem
from app.models.user import User
from app.nutrition import Macros, scale, total
from app.schemas.meal import (
    MealCreateRequest,
    MealItemCreateRequest,
    MealItemResponse,
    MealResponse,
)

router = APIRouter(prefix="/meals", tags=["meals"])

_CENTS = Decimal("0.01")


@dataclass
class _ResolvedItem:
    """一個項目「解析後」的結果：食物與份量都驗證過、quantity_g 也算好了。

    刻意跟 MealItem（ORM model）分開：解析階段完全不寫入 DB（只有 SELECT），
    這樣「處理到第 3 個項目才發現看不到」的情況，前兩個項目不會留下任何
    已寫入 session 的痕跡 —— 整個建立餐點的動作要嘛全部成功、要嘛什麼都沒發生。
    """

    food_id: int
    food_revision_id: int
    revision: FoodRevision
    portion_id: int | None
    quantity: Decimal
    quantity_g: Decimal


async def _load_visible_portion(db: AsyncSession, portion_id: int, user: User) -> FoodPortion:
    """跟 app/food_visibility.py 的 load_visible_food 是同一種可見性判斷，
    只是換成 FoodPortion。份量沒有 revision 那一層，所以不用抽成共用模組。
    """
    portion = await db.scalar(
        select(FoodPortion).where(
            FoodPortion.id == portion_id,
            or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user.id),
        )
    )
    if portion is None:
        raise NotFoundError("PORTION_NOT_FOUND", "找不到該份量")
    return portion


async def _resolve_item(
    db: AsyncSession, payload: MealItemCreateRequest, user: User
) -> _ResolvedItem:
    """處理一個項目的完整順序 —— 這個順序是安全性的一部分（計畫 3 Task 7）：

    1. 用可見性條件載入 food（不可見 -> 404）
    2. food.current_revision_id 是 NULL -> 409（防禦性，正常流程不該發生）
    3. 有 portion_id 的話：載入份量（看不到 -> 404），
       確認 portion.food_id == food.id（不符 -> 422，這是不同於「看不到」的錯誤）
    4. quantity_g = portion.grams * quantity，或直接等於 quantity
    """
    food, revision = await load_visible_food(db, payload.food_id, user)
    if revision is None:
        # 食物存在也看得到，但沒有生效版本 —— 正常流程不會發生（沒有
        # current_revision_id 的食物本來就查不到），純粹防禦性。
        raise ConflictError("FOOD_HAS_NO_REVISION", "這個食物目前沒有生效的版本")

    quantity = payload.quantity
    portion_id = payload.portion_id
    if portion_id is None:
        quantity_g = quantity
    else:
        portion = await _load_visible_portion(db, portion_id, user)
        if portion.food_id != food.id:
            raise UnprocessableEntityError(
                "PORTION_FOOD_MISMATCH", "這個份量不屬於指定的食物"
            )
        quantity_g = (portion.grams * quantity).quantize(_CENTS, rounding=ROUND_HALF_UP)

    return _ResolvedItem(
        food_id=food.id,
        food_revision_id=revision.id,
        revision=revision,
        portion_id=portion_id,
        quantity=quantity,
        quantity_g=quantity_g,
    )


def _item_response(item: MealItem, food_id: int, macros: Macros) -> MealItemResponse:
    return MealItemResponse(
        id=item.id,
        food_id=food_id,
        portion_id=item.portion_id,
        # 用 refresh 過的 item.quantity / item.quantity_g，不是解析階段算出來的
        # Decimal —— 使用者傳進來的 "100" 在記憶體裡還是 1 位精度，要 refresh
        # 才能拿到 NUMERIC(8, 2) 實際存的精度（"100.00"），跟 foods.py 同一個坑。
        quantity=item.quantity,
        quantity_g=item.quantity_g,
        kcal=macros.kcal,
        protein_g=macros.protein_g,
        fat_g=macros.fat_g,
        carb_g=macros.carb_g,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=MealResponse)
async def create_meal(
    payload: MealCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MealResponse:
    # 先把所有項目都解析、驗證完（只有 SELECT，不寫任何東西進 session）。
    # 任何一個項目失敗都會在這裡就拋出例外 —— 這時候還沒有 Meal、
    # 也沒有任何 MealItem 被 add() 過，所以「原子性」不需要額外的
    # try/except + rollback，結構上就不可能留下部分寫入。
    resolved_items = [await _resolve_item(db, item, user) for item in payload.items]

    meal = Meal(
        user_id=user.id,
        eaten_at=payload.eaten_at,
        meal_type=payload.meal_type,
        note=payload.note,
    )
    db.add(meal)
    await db.flush()

    item_rows: list[MealItem] = []
    for resolved in resolved_items:
        item = MealItem(
            meal_id=meal.id,
            food_revision_id=resolved.food_revision_id,
            portion_id=resolved.portion_id,
            quantity=resolved.quantity,
            quantity_g=resolved.quantity_g,
        )
        db.add(item)
        item_rows.append(item)

    await db.commit()
    await db.refresh(meal)

    items_response: list[MealItemResponse] = []
    macros_list: list[Macros] = []
    for item, resolved in zip(item_rows, resolved_items, strict=True):
        await db.refresh(item)
        macros = scale(resolved.revision, item.quantity_g)
        macros_list.append(macros)
        items_response.append(_item_response(item, resolved.food_id, macros))

    totals = total(macros_list)
    return MealResponse(
        id=meal.id,
        eaten_at=meal.eaten_at,
        meal_type=meal.meal_type,
        note=meal.note,
        items=items_response,
        kcal=totals.kcal,
        protein_g=totals.protein_g,
        fat_g=totals.fat_g,
        carb_g=totals.carb_g,
    )
