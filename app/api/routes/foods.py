from fastapi import APIRouter, Depends, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.db import get_db
from app.errors import ConflictError, NotFoundError
from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import User
from app.schemas.food import FoodCreateRequest, FoodResponse, NutritionResponse

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
    await db.flush()

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
        await db.commit()
    except IntegrityError as exc:
        # 併發下兩個相同名稱同時通過上面的檢查時，由唯一約束接住。
        # rollback 是必要的 —— 少了它，這個 session 之後所有操作都會拋
        # PendingRollbackError（見計畫 1 Task 7 的第四個邊界）。
        await db.rollback()
        raise ConflictError("FOOD_EXISTS", "你已經建過同名的食物了") from exc

    await db.refresh(food)
    # kcal 等欄位在記憶體裡還是使用者傳進來的原始精度（例如 "180.5"），
    # 要 refresh 才能拿到 NUMERIC(8, 2) 實際存的精度（"180.50"）。
    await db.refresh(revision)
    return _to_response(food, revision)


async def _load_visible_food(
    db: AsyncSession, food_id: int, user: User
) -> tuple[Food, FoodRevision | None]:
    """取出使用者看得到的食物：全域的，或自己的。

    看不到的一律 404 —— 「不存在」與「不屬於你」必須無法區分。
    """
    row = (
        await db.execute(
            select(Food, FoodRevision)
            .outerjoin(FoodRevision, Food.current_revision_id == FoodRevision.id)
            .where(
                Food.id == food_id,
                or_(Food.owner_id.is_(None), Food.owner_id == user.id),
            )
        )
    ).first()
    if row is None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")
    food, revision = row
    return food, revision


@router.get("/{food_id}", response_model=FoodResponse)
async def read_food(
    food_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FoodResponse:
    food, revision = await _load_visible_food(db, food_id, user)
    return _to_response(food, revision)
