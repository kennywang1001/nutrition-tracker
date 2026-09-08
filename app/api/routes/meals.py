from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import Row, Select, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.days import day_bounds, today_in_timezone
from app.db import get_db
from app.errors import ConflictError, NotFoundError, UnprocessableEntityError
from app.food_visibility import load_visible_food
from app.models.food import Food, FoodPortion, FoodRevision
from app.models.meal import Meal, MealItem
from app.models.user import User
from app.nutrition import Macros, scale, total
from app.schemas.meal import (
    MealCreateRequest,
    MealItemCreateRequest,
    MealItemResponse,
    MealResponse,
    MealUpdateRequest,
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
    food_name: str
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
        food_name=food.name,
        food_revision_id=revision.id,
        revision=revision,
        portion_id=portion_id,
        quantity=quantity,
        quantity_g=quantity_g,
    )


def _item_response(
    item: MealItem, food_id: int, food_name: str, macros: Macros
) -> MealItemResponse:
    return MealItemResponse(
        id=item.id,
        food_id=food_id,
        food_name=food_name,
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
        items_response.append(
            _item_response(item, resolved.food_id, resolved.food_name, macros)
        )

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


def _item_join_query() -> Select[tuple[MealItem, FoodRevision, Food]]:
    """項目 join 它釘住的 revision、再 join 該 revision 當時所屬的食物。

    刻意不用 `selectinload`：本計畫不宣告 `relationship()`（見計畫「刻意不做的
    事」/程式碼組織限制），selectinload 需要 ORM 關聯屬性才能運作。改用明確的
    兩層 join，一次查詢就把項目、營養素、食物名稱全部帶回來 —— 讀一餐或列一天
    的餐，查詢次數都跟項目數無關，不會有「N 個項目 = N+1 次往返」的問題。
    """
    return (
        select(MealItem, FoodRevision, Food)
        .join(FoodRevision, MealItem.food_revision_id == FoodRevision.id)
        .join(Food, FoodRevision.food_id == Food.id)
    )


def _build_meal_response(
    meal: Meal, item_rows: Sequence[Row[tuple[MealItem, FoodRevision, Food]]]
) -> MealResponse:
    """把一筆 Meal 與它已經 join 好的項目列組成回應。

    **一律用項目當時釘住的 food_revision_id 換算，不是食物現在的
    current_revision_id**（`_item_join_query` 的 join 條件本身就保證了這件事：
    join 的起點是 `MealItem.food_revision_id`，從頭到尾没有碰過
    `Food.current_revision_id`）。這是版本化的重點：歷史紀錄要看到的是
    當時的數值，即使食物後來被審核通過新版本，這裡的數字也不能動。
    """
    items_response: list[MealItemResponse] = []
    macros_list: list[Macros] = []
    for item, revision, food in item_rows:
        macros = scale(revision, item.quantity_g)
        macros_list.append(macros)
        items_response.append(_item_response(item, food.id, food.name, macros))

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


async def _load_owned_meal(db: AsyncSession, meal_id: int, user: User) -> Meal:
    """依擁有權載入一筆餐點；不存在或不是自己的，一律回同一種 404
    （繼承規矩第 1 條：權限失敗不回 403，且跟「真的不存在」逐字相同）。

    擁有權判斷併進查詢的 WHERE 條件裡（`Meal.user_id == user.id`），
    不是「先查到再檢查擁有者」—— 後者會讓「不存在」跟「不是你的」在查詢層
    就走不同的路徑，容易一邊改一邊漏。GET / PATCH / DELETE 這一餐、以及
    項目的增刪，全部共用這一個函式：擁有權規則只寫一次，日後要修只會
    改到一個地方。
    """
    meal = await db.scalar(select(Meal).where(Meal.id == meal_id, Meal.user_id == user.id))
    if meal is None:
        raise NotFoundError("MEAL_NOT_FOUND", "找不到該餐點")
    return meal


@router.get("/{meal_id}", response_model=MealResponse)
async def read_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MealResponse:
    """讀單一餐點：只有 2 次查詢，跟項目數無關（見 `_item_join_query`）。"""
    meal = await _load_owned_meal(db, meal_id, user)

    rows = (
        await db.execute(
            _item_join_query().where(MealItem.meal_id == meal.id).order_by(MealItem.id)
        )
    ).all()
    return _build_meal_response(meal, rows)


@router.patch("/{meal_id}", response_model=MealResponse)
async def update_meal(
    meal_id: ResourceId,
    payload: MealUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MealResponse:
    """只改餐點本身：`eaten_at` / `meal_type` / `note`（計畫 3 決定 2）。
    項目不在這個端點的範圍內 —— 那是 `POST/DELETE .../items` 的事。

    用 `exclude_unset` 決定要更新哪些欄位（沒帶的欄位維持原樣），
    `MealUpdateRequest` 自己的驗證器已經擋掉 `eaten_at` / `meal_type`
    的顯式 `null`，所以流到這裡的 `None` 只可能是合法的 `note` 清空。
    """
    meal = await _load_owned_meal(db, meal_id, user)

    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(meal, field, value)

    await db.commit()
    await db.refresh(meal)

    rows = (
        await db.execute(
            _item_join_query().where(MealItem.meal_id == meal.id).order_by(MealItem.id)
        )
    ).all()
    return _build_meal_response(meal, rows)


@router.delete("/{meal_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_meal(
    meal_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪一餐。`meal_items` 靠 `ON DELETE CASCADE` 跟著走，這裡不逐筆刪 ——
    照片檔案的清理留到 Task 16。

    擁有權檢查（`_load_owned_meal`）必須在刪除**之前**：先查到、確認是
    自己的，才刪；不能「先刪、再檢查」，那種順序下「回 404」跟「真的沒刪掉」
    會脫鉤 —— 對一個一查就砍的實作，只斷言狀態碼的測試看不出差別。
    """
    meal = await _load_owned_meal(db, meal_id, user)
    await db.delete(meal)
    await db.commit()


@router.get("", response_model=list[MealResponse])
async def list_meals(
    date: date | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[MealResponse]:
    """依「使用者當地的一天」列出當天吃的餐（計畫 3 決定 1）。

    `day_bounds()` 把使用者的時區換算成 UTC 的半開區間 `[start, end)`——
    用 `<`，不是 `<=`：`<=` 會讓恰好落在當地午夜的一餐同時屬於兩天。
    省略 `date` 時預設「使用者時區的今天」，靠 `today_in_timezone()` 算，
    不是伺服器所在時區的今天，也不是 UTC 的今天。

    兩次查詢，跟這一天有幾筆餐、每筆餐有幾個項目都無關：
    第一次查出這天的所有 Meal，第二次用 `meal_id IN (...)` 一次把所有
    Meal 的項目、revision、food 都 join 回來，在記憶體裡依 meal_id 分組——
    不是對每筆 Meal 各查一次項目（那會是「這天吃了幾餐」次的往返）。
    """
    day = date or today_in_timezone(user.timezone)
    start, end = day_bounds(day, user.timezone)

    meals = (
        await db.scalars(
            select(Meal)
            .where(
                Meal.user_id == user.id,
                Meal.eaten_at >= start,
                Meal.eaten_at < end,
            )
            .order_by(Meal.eaten_at)
        )
    ).all()
    if not meals:
        return []

    meal_ids = [meal.id for meal in meals]
    rows = (
        await db.execute(
            _item_join_query().where(MealItem.meal_id.in_(meal_ids)).order_by(MealItem.id)
        )
    ).all()

    items_by_meal: dict[int, list[Row[tuple[MealItem, FoodRevision, Food]]]] = defaultdict(list)
    for row in rows:
        items_by_meal[row[0].meal_id].append(row)

    return [_build_meal_response(meal, items_by_meal.get(meal.id, [])) for meal in meals]
