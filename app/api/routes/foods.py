from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import ColumnElement, Select, func, or_, select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.db import get_db
from app.errors import ConflictError, ForbiddenError, NotFoundError
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
    PortionUpdateRequest,
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


async def _find_same_named_food(
    db: AsyncSession, *, owner_id: int | None, name: str, brand: str | None
) -> Food | None:
    """撞名檢查的範圍：同一個擁有者、同名、同品牌（`uq_foods_owner_id_name_brand`）。
    所以找到的一定是**你自己的**食物（或建全域食物時撞到的全域食物）——
    把它的 id 附在 409 裡不會洩漏別人的私人食物。"""
    existing: Food | None = await db.scalar(
        select(Food).where(
            Food.owner_id.is_not_distinct_from(owner_id),
            Food.name == name,
            Food.brand.is_not_distinct_from(brand),
        )
    )
    return existing


def _food_exists(existing: Food | None) -> ConflictError:
    """409 FOOD_EXISTS，附上撞到的那一筆的 id（AI 估算前端規格 §3.4）——
    前端才能提供「用現有的」。找不到（理論上不會）就不附。"""
    details = {"food_id": existing.id} if existing is not None else None
    return ConflictError("FOOD_EXISTS", "你已經建過同名的食物了", details)


@router.post("", status_code=status.HTTP_201_CREATED, response_model=FoodResponse)
async def create_food(
    payload: FoodCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FoodResponse:
    if payload.is_global and user.role is not UserRole.ADMIN:
        # 這是角色不符，不是擁有權不符 —— 所以是 403 而不是 404。
        # 資源存在、使用者也看得到，只是不能做這個動作。
        raise ForbiddenError("FORBIDDEN", "只有管理員能建立全域食物")

    owner_id = None if payload.is_global else user.id

    existing = await _find_same_named_food(
        db, owner_id=owner_id, name=payload.name, brand=payload.brand
    )
    if existing is not None:
        raise _food_exists(existing)

    food = Food(
        name=payload.name,
        brand=payload.brand,
        owner_id=owner_id,
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
        # 併發下另一個請求剛建好那一筆：rollback 之後重查一次，附上它的 id。
        raced = await _find_same_named_food(
            db, owner_id=owner_id, name=payload.name, brand=payload.brand
        )
        raise _food_exists(raced) from exc

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
        # 規格 §5：「有沒有改」是資料，不是只有操作本身。P1 就預留好這三個
        # 欄位，這裡是第一個真的寫入它們的呼叫端（Task 6）。不帶的話
        # payload.source 預設 'user'，另外兩個預設 None ——既有行為不變。
        source=payload.source,
        ai_confidence=payload.ai_confidence,
        ai_raw_response=payload.ai_raw_response,
    )
    db.add(revision)
    await db.flush()

    # 回填指標。三步在同一個交易裡。
    food.current_revision_id = revision.id

    if payload.default_portion is not None:
        # 跟食物、第一個版本在同一個交易裡（食物份量規格 §3.1）：任何一步
        # 失敗，下面的 commit 不會成功，不會留下「食物建了、份量沒建」的
        # 半套狀態。份量跟著食物走——私人食物建私人份量，公開食物建公開份量。
        db.add(
            FoodPortion(
                food_id=food.id,
                owner_id=owner_id,
                label=payload.default_portion.label,
                grams=payload.default_portion.grams,
                is_default=True,
            )
        )

    try:
        # 延後外鍵（fk_foods_current_revision_id_food_revisions 是
        # DEFERRABLE INITIALLY DEFERRED）要到這裡才檢查，所以 commit 仍然需要保護。
        # 名稱重複則是在上面的 flush 就擋掉了，走不到這裡。
        await db.commit()
    except IntegrityError as exc:
        # rollback 是必要的 —— 少了它，這個 session 之後所有操作都會拋
        # PendingRollbackError（見計畫 1 Task 7 的第四個邊界）。
        await db.rollback()
        # 防禦性的：commit 時的 IntegrityError 通常是延後外鍵或份量約束，不是撞名，
        # 重查通常找不到東西，此時 `_food_exists(None)` 不附 details。
        raced = await _find_same_named_food(
            db, owner_id=owner_id, name=payload.name, brand=payload.brand
        )
        raise _food_exists(raced) from exc

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


def _portion_response(portion: FoodPortion) -> PortionResponse:
    return PortionResponse(
        id=portion.id,
        label=portion.label,
        grams=portion.grams,
        is_default=portion.is_default,
        is_global=portion.owner_id is None,
    )


async def _load_manageable_portion(
    db: AsyncSession, food_id: int, portion_id: int, user: User
) -> FoodPortion:
    """修改、刪除份量的權限（小項目包規格 §3.1）：

    - 食物要看得到（`load_visible_food`，看不到 → 404）
    - 份量要屬於路徑上的食物、而且是自己的或公開的——別人的私人份量 → 404
      （不透露存在，handover §4.7）
    - 公開份量只有管理員能動 → 一般使用者 403（同「新增公開份量」：看得到但不能動）
    """
    food, _ = await load_visible_food(db, food_id, user)
    portion = await db.scalar(
        select(FoodPortion).where(
            FoodPortion.id == portion_id,
            FoodPortion.food_id == food.id,
            or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user.id),
        )
    )
    if portion is None:
        raise NotFoundError("PORTION_NOT_FOUND", "找不到該份量")
    if portion.owner_id is None and user.role is not UserRole.ADMIN:
        raise ForbiddenError("FORBIDDEN", "只有管理員能修改或刪除全域份量")
    return portion


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
    return [_portion_response(p) for p in portions]


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

    owner_id = None if payload.is_global else user.id
    if payload.is_default:
        # 同一個人、同一個食物只會有一個預設份量——新增預設時在同一個交易裡取消舊的
        # （`update_portion` 同一條規則）。
        # （create_food 的 default_portion 是全新食物，不會有其他份量，
        # 不需要這一步。）
        await db.execute(
            update(FoodPortion)
            .where(
                FoodPortion.food_id == food.id,
                FoodPortion.owner_id.is_not_distinct_from(owner_id),
                FoodPortion.is_default.is_(True),
            )
            .values(is_default=False)
        )

    portion = FoodPortion(
        food_id=food.id,
        owner_id=owner_id,
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
    return _portion_response(portion)


@router.patch("/{food_id}/portions/{portion_id}", response_model=PortionResponse)
async def update_portion(
    food_id: ResourceId,
    portion_id: ResourceId,
    payload: PortionUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PortionResponse:
    """改份量的名稱、重量或是否預設。

    **已經記下的餐不受影響**——`meal_items.quantity_g` 在寫入時算好、讀取不重算
    （handover §4.3）。改重量只影響之後新記的餐。
    """
    portion = await _load_manageable_portion(db, food_id, portion_id, user)
    changes = payload.model_dump(exclude_unset=True)

    if changes.get("is_default") is True:
        # 同一個擁有者、同一個食物只有一個預設（同 create_portion），同一個交易。
        await db.execute(
            update(FoodPortion)
            .where(
                FoodPortion.food_id == portion.food_id,
                FoodPortion.owner_id.is_not_distinct_from(portion.owner_id),
                FoodPortion.is_default.is_(True),
                FoodPortion.id != portion.id,
            )
            .values(is_default=False)
        )

    for field, value in changes.items():
        setattr(portion, field, value)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError("PORTION_EXISTS", "你已經為這個食物建過同名的份量了") from exc

    await db.refresh(portion)
    return _portion_response(portion)


@router.delete("/{food_id}/portions/{portion_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_portion(
    food_id: ResourceId,
    portion_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪除份量。用過它的餐點那一項 `portion_id` 由資料庫 `SET NULL`，
    `quantity_g` 不變——舊紀錄變成「直接輸入的公克數」，數字照舊。"""
    portion = await _load_manageable_portion(db, food_id, portion_id, user)
    await db.delete(portion)
    await db.commit()
