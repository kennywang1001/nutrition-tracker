from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import ColumnElement, Select, func, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.db import get_db
from app.errors import ConflictError, ForbiddenError
from app.food_visibility import assert_food_visible, load_visible_food
from app.models.food import Food, FoodPortion, FoodRevision, RevisionStatus
from app.models.meal import Meal, MealItem
from app.models.user import User, UserRole
from app.schemas.food import (
    FoodCreateRequest,
    FoodResponse,
    FoodScope,
    NutritionResponse,
    PortionCreateRequest,
    PortionResponse,
    RevisionCreateRequest,
    RevisionResponse,
)

router = APIRouter(prefix="/foods", tags=["foods"])


def _to_response(food: Food, revision: FoodRevision | None) -> FoodResponse:
    return FoodResponse(
        id=food.id,
        name=food.name,
        brand=food.brand,
        is_global=food.owner_id is None,
        nutrition=NutritionResponse.model_validate(revision) if revision else None,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=FoodResponse)
async def create_food(
    payload: FoodCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FoodResponse:
    existing = await db.scalar(
        select(Food).where(
            Food.owner_id == user.id,
            Food.name == payload.name,
            Food.brand.is_not_distinct_from(payload.brand),
        )
    )
    if existing is not None:
        raise ConflictError("FOOD_EXISTS", "你已經建過同名的食物了")

    food = Food(
        name=payload.name,
        brand=payload.brand,
        owner_id=user.id,
        created_by=user.id,
    )
    db.add(food)
    try:
        # 唯一約束是在「這裡」檢查的，不是在下面的 commit ——
        # INSERT 在 flush 當下就送進資料庫了。併發下兩個請求同時通過上面的
        # 前置 SELECT 時，後到的那個會在這一行違反 uq_foods_owner_id_name_brand。
        #
        # 這一段原本沒有保護，於是那個情境會變成未處理的 500：
        # 底下 commit 的 except IntegrityError 雖然註解寫著「由唯一約束接住」，
        # 但例外早在好幾行之前就炸開了，那個 handler 對這個情境不可達。
        # （計畫 4a Task 11 稽核 rollback 呼叫點時發現並實測確認。）
        await db.flush()
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError("FOOD_EXISTS", "你已經建過同名的食物了") from exc

    revision = FoodRevision(
        food_id=food.id,
        base_unit=payload.nutrition.base_unit,
        kcal=payload.nutrition.kcal,
        protein_g=payload.nutrition.protein_g,
        fat_g=payload.nutrition.fat_g,
        carb_g=payload.nutrition.carb_g,
        # 私人食物的編輯直接生效
        status=RevisionStatus.APPROVED,
        created_by=user.id,
    )
    db.add(revision)
    await db.flush()

    # 回填指標。三步在同一個交易裡。
    food.current_revision_id = revision.id

    try:
        # 延後外鍵（fk_foods_current_revision_id_food_revisions 是
        # DEFERRABLE INITIALLY DEFERRED）要到這裡才檢查，所以 commit 仍然需要保護。
        # 名稱重複則是在上面的 flush 就擋掉了，走不到這裡。
        await db.commit()
    except IntegrityError as exc:
        # rollback 是必要的 —— 少了它，這個 session 之後所有操作都會拋
        # PendingRollbackError（見計畫 1 Task 7 的第四個邊界）。
        await db.rollback()
        raise ConflictError("FOOD_EXISTS", "你已經建過同名的食物了") from exc

    await db.refresh(food)
    # kcal 等欄位在記憶體裡還是使用者傳進來的原始精度（例如 "180.5"），
    # 要 refresh 才能拿到 NUMERIC(8, 2) 實際存的精度（"180.50"）。
    await db.refresh(revision)
    return _to_response(food, revision)


@router.get("", response_model=list[FoodResponse])
async def search_foods(
    q: str | None = None,
    scope: FoodScope = FoodScope.ALL,
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FoodResponse]:
    visibility: ColumnElement[bool]
    if scope is FoodScope.GLOBAL:
        visibility = Food.owner_id.is_(None)
    elif scope is FoodScope.MINE:
        visibility = Food.owner_id == user.id
    else:
        visibility = or_(Food.owner_id.is_(None), Food.owner_id == user.id)

    stmt = (
        select(Food, FoodRevision)
        .outerjoin(FoodRevision, Food.current_revision_id == FoodRevision.id)
        .where(visibility)
        .order_by(Food.name)
        .limit(limit)
    )
    if q:
        stmt = stmt.where(Food.name.ilike(f"%{q}%"))

    rows = (await db.execute(stmt)).all()
    return [_to_response(food, revision) for food, revision in rows]


# `/frequent` 與 `/recent` 必須宣告在 `/{food_id}` 之前 ——
# FastAPI／Starlette 依宣告順序比對路由，`/{food_id}` 會先比對到
# `/foods/frequent`，把 "frequent" 當成 food_id 去解析成 int，
# 因為 ResourceId 解析失敗而回 422（而不是 404 或正確路由到這裡）。
# 這是實測過的：把這兩個端點放在 `/{food_id}` 之後會讓
# tests/test_foods_frequent.py 全部收到 422 VALIDATION_ERROR。
_CurrentRevision = aliased(FoodRevision)


def _my_recorded_foods_stmt(
    user: User, limit: int, order_by: ColumnElement[Any]
) -> Select[tuple[Food, FoodRevision]]:
    """`frequent` 與 `recent` 共用的查詢：使用者記錄過的食物，join 回食物「目前」
    生效的版本（不是項目當時釘住的版本 —— 那是 `GET /api/meals/{id}` 的事，
    這裡刻意相反：這個端點是要再記一筆，必須看到今天的營養素資料）。

    可見性過濾（`Food.owner_id IS NULL OR owner_id = :me`）今天是空轉的 ——
    `POST /api/meals` 已經擋住「記錄看不到的食物」，所以自己的餐裡不可能有
    看不到的食物。保留它純粹是防禦性：日後若加上「刪除食物」或「取消分享」，
    這裡會是唯一會漏的地方。這件事今天測不出來，因為沒有任何突變能讓它失守。

    規格第 6.6 節：P1 用查詢 + 索引解決，不建快取表。
    實測過 `EXPLAIN (ANALYZE, BUFFERS)`（10,500 與 610,500 筆 meal_items 兩種規模）：
    `ix_meals_user_id_eaten_at` 確實被用來過濾 `Meal.user_id`（Bitmap Index Scan），
    資料量大時 `meal_items -> meals` 這段 join 用的是既有的 `ix_meal_items_meal_id`
    （Index Scan，nested loop）。`ix_meal_items_food_revision_id` 在兩種規模下
    都沒有出現在計畫裡 —— 這個查詢的篩選力來自 `user_id`，不是 `food_revision_id`，
    所以規格原本設想「這個索引就是為 frequent/recent 而存在」並不成立，
    是先前沒有實測就寫進計畫的假設。
    """
    return (
        select(Food, _CurrentRevision)
        .select_from(MealItem)
        .join(Meal, MealItem.meal_id == Meal.id)
        .join(FoodRevision, MealItem.food_revision_id == FoodRevision.id)
        .join(Food, FoodRevision.food_id == Food.id)
        .outerjoin(_CurrentRevision, Food.current_revision_id == _CurrentRevision.id)
        .where(
            Meal.user_id == user.id,
            or_(Food.owner_id.is_(None), Food.owner_id == user.id),
        )
        .group_by(Food.id, _CurrentRevision.id)
        .order_by(order_by, Food.id)
        .limit(limit)
    )


@router.get("/frequent", response_model=list[FoodResponse])
async def list_frequent_foods(
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FoodResponse]:
    """使用者最常吃的食物，依吃過的次數多到少排序（規格第 11 節：每天走最多次的路徑）。"""
    stmt = _my_recorded_foods_stmt(user, limit, func.count().desc())
    rows = (await db.execute(stmt)).all()
    return [_to_response(food, revision) for food, revision in rows]


@router.get("/recent", response_model=list[FoodResponse])
async def list_recent_foods(
    limit: int = Query(default=10, ge=1, le=50),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[FoodResponse]:
    """使用者最近吃過的食物，依最後一次吃的時間新到舊排序。"""
    stmt = _my_recorded_foods_stmt(user, limit, func.max(Meal.eaten_at).desc())
    rows = (await db.execute(stmt)).all()
    return [_to_response(food, revision) for food, revision in rows]


@router.get("/{food_id}", response_model=FoodResponse)
async def read_food(
    food_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FoodResponse:
    food, revision = await load_visible_food(db, food_id, user)
    return _to_response(food, revision)


@router.get("/{food_id}/revisions", response_model=list[RevisionResponse])
async def list_revisions(
    food_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[RevisionResponse]:
    food = await assert_food_visible(db, food_id, user)

    revisions = (
        await db.scalars(
            select(FoodRevision)
            .where(FoodRevision.food_id == food.id)
            .order_by(FoodRevision.created_at.desc(), FoodRevision.id.desc())
        )
    ).all()

    result = []
    for revision in revisions:
        item = RevisionResponse.model_validate(revision)
        item.is_current = revision.id == food.current_revision_id
        result.append(item)
    return result


@router.post(
    "/{food_id}/revisions", status_code=status.HTTP_201_CREATED, response_model=RevisionResponse
)
async def propose_revision(
    food_id: ResourceId,
    payload: RevisionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RevisionResponse:
    food = await assert_food_visible(db, food_id, user)

    is_own_private_food = food.owner_id == user.id
    now = datetime.now(UTC)

    revision = FoodRevision(
        food_id=food.id,
        base_unit=payload.nutrition.base_unit,
        kcal=payload.nutrition.kcal,
        protein_g=payload.nutrition.protein_g,
        fat_g=payload.nutrition.fat_g,
        carb_g=payload.nutrition.carb_g,
        change_note=payload.change_note,
        created_by=user.id,
        # 自己的私人食物直接生效；全域食物要等管理員審核
        status=RevisionStatus.APPROVED if is_own_private_food else RevisionStatus.PENDING,
        reviewed_by=user.id if is_own_private_food else None,
        reviewed_at=now if is_own_private_food else None,
    )
    db.add(revision)

    try:
        await db.flush()
    except IntegrityError as exc:
        # uq_food_revisions_one_pending：同一個食物已經有待審編輯。
        # rollback 是必要的，否則這個 session 之後全部會拋 PendingRollbackError。
        await db.rollback()
        raise ConflictError(
            "REVISION_PENDING", "這個食物已經有一筆待審的編輯，請等審核完成"
        ) from exc

    if is_own_private_food:
        food.current_revision_id = revision.id

    await db.commit()
    await db.refresh(revision)

    result = RevisionResponse.model_validate(revision)
    result.is_current = revision.id == food.current_revision_id
    return result


@router.get("/{food_id}/portions", response_model=list[PortionResponse])
async def list_portions(
    food_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[PortionResponse]:
    food, _ = await load_visible_food(db, food_id, user)

    portions = (
        await db.scalars(
            select(FoodPortion)
            .where(
                FoodPortion.food_id == food.id,
                or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user.id),
            )
            .order_by(FoodPortion.label)
        )
    ).all()
    return [
        PortionResponse(
            id=p.id, label=p.label, grams=p.grams,
            is_default=p.is_default, is_global=p.owner_id is None,
        )
        for p in portions
    ]


@router.post(
    "/{food_id}/portions", status_code=status.HTTP_201_CREATED, response_model=PortionResponse
)
async def create_portion(
    food_id: ResourceId,
    payload: PortionCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PortionResponse:
    food, _ = await load_visible_food(db, food_id, user)

    if payload.is_global and user.role is not UserRole.ADMIN:
        # 這是角色不符，不是擁有權不符 —— 所以是 403 而不是 404。
        # 資源存在、使用者也看得到，只是不能做這個動作。
        raise ForbiddenError("FORBIDDEN", "只有管理員能建立全域份量")

    portion = FoodPortion(
        food_id=food.id,
        owner_id=None if payload.is_global else user.id,
        label=payload.label,
        grams=payload.grams,
        is_default=payload.is_default,
    )
    db.add(portion)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError("PORTION_EXISTS", "你已經為這個食物建過同名的份量了") from exc

    await db.refresh(portion)
    return PortionResponse(
        id=portion.id, label=portion.label, grams=portion.grams,
        is_default=portion.is_default, is_global=portion.owner_id is None,
    )
