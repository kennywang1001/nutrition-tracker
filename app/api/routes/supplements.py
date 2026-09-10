from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import day_bounds, today_in_timezone
from app.db import get_db
from app.errors import ConflictError
from app.models.supplement import Supplement, SupplementIntake, SupplementPlan
from app.models.user import User
from app.schemas.supplement import (
    SupplementCreateRequest,
    SupplementResponse,
    SupplementScope,
    TodaySupplementItem,
)

router = APIRouter(prefix="/supplements", tags=["supplements"])


def _to_response(supplement: Supplement) -> SupplementResponse:
    return SupplementResponse(
        id=supplement.id,
        name=supplement.name,
        brand=supplement.brand,
        is_global=supplement.owner_id is None,
        serving_unit=supplement.serving_unit,
        serving_size=supplement.serving_size,
        kcal=supplement.kcal,
        protein_g=supplement.protein_g,
        fat_g=supplement.fat_g,
        carb_g=supplement.carb_g,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=SupplementResponse)
async def create_supplement(
    payload: SupplementCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SupplementResponse:
    supplement = Supplement(
        name=payload.name,
        brand=payload.brand,
        owner_id=user.id,
        serving_unit=payload.serving_unit,
        serving_size=payload.serving_size,
        kcal=payload.kcal,
        protein_g=payload.protein_g,
        fat_g=payload.fat_g,
        carb_g=payload.carb_g,
        created_by=user.id,
    )
    db.add(supplement)
    try:
        await db.commit()
    except IntegrityError as exc:
        # uq_supplements_owner_id_name_brand：併發下兩筆同名同品牌同時通過
        # 檢查（其實這裡連檢查都沒做，直接靠約束）。rollback 是必要的 ——
        # 少了它，這個 session 之後所有操作都會拋 PendingRollbackError。
        await db.rollback()
        raise ConflictError("SUPPLEMENT_EXISTS", "你已經建過同名同品牌的補劑了") from exc

    await db.refresh(supplement)
    return _to_response(supplement)


@router.get("", response_model=list[SupplementResponse])
async def search_supplements(
    q: str | None = None,
    scope: SupplementScope = SupplementScope.ALL,
    limit: int = Query(default=50, ge=1, le=200),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SupplementResponse]:
    visibility: ColumnElement[bool]
    if scope is SupplementScope.GLOBAL:
        visibility = Supplement.owner_id.is_(None)
    elif scope is SupplementScope.MINE:
        visibility = Supplement.owner_id == user.id
    else:
        visibility = or_(Supplement.owner_id.is_(None), Supplement.owner_id == user.id)

    stmt = select(Supplement).where(visibility).order_by(Supplement.name).limit(limit)
    if q:
        stmt = stmt.where(Supplement.name.ilike(f"%{q}%"))

    supplements = (await db.scalars(stmt)).all()
    return [_to_response(s) for s in supplements]


@router.get("/today", response_model=list[TodaySupplementItem])
async def list_today(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TodaySupplementItem]:
    """今日待打卡清單：把「計畫」與「實際」對起來（陷阱 2）。

    `supplement_plans.effective_from/to` 是 `date`，`supplement_intakes.taken_at`
    是 `timestamptz`，兩種型別的「今天」判斷方式不同，但**只算一次**
    `today_in_timezone()`，同時餵給計畫的日期比較與 `day_bounds()` 的
    timestamptz 半開區間 —— 不能分開各自算一次，否則使用者當地時區跟 UTC
    交界的那幾小時，兩者會對到不同的日子（清單顯示昨天的計畫、今天的打卡）。

    `day_bounds()` 回傳半開區間 `[start, end)`，用 `<`，不是 `<=`：
    `<=` 會讓恰好落在當地午夜的一筆打卡同時屬於兩天，4b 的依從率會把
    那次攝取算兩次（計畫 3 Task 9 同一個坑）。
    """
    today = today_in_timezone(user.timezone)
    start, end = day_bounds(today, user.timezone)

    plans = (
        await db.scalars(
            select(SupplementPlan).where(
                SupplementPlan.user_id == user.id,
                SupplementPlan.effective_from <= today,
                or_(
                    SupplementPlan.effective_to.is_(None),
                    SupplementPlan.effective_to > today,
                ),
            )
        )
    ).all()

    intakes = (
        await db.scalars(
            select(SupplementIntake).where(
                SupplementIntake.user_id == user.id,
                SupplementIntake.taken_at >= start,
                SupplementIntake.taken_at < end,
            )
        )
    ).all()

    intakes_by_plan: dict[int, SupplementIntake] = {}
    ad_hoc: list[SupplementIntake] = []
    for intake in intakes:
        plan_id = intake.plan_id
        if plan_id is None:
            ad_hoc.append(intake)
        else:
            # 同一筆計畫今天打卡超過一次（重複打卡）只需要標示「完成」，
            # 挑第一筆即可 —— P1 沒有「今天吃了幾次」這種需求（那是 4b 的事）。
            intakes_by_plan.setdefault(plan_id, intake)

    supplement_ids = {plan.supplement_id for plan in plans} | {
        intake.supplement_id for intake in ad_hoc
    }
    supplements_by_id: dict[int, Supplement] = {}
    if supplement_ids:
        rows = (
            await db.scalars(select(Supplement).where(Supplement.id.in_(supplement_ids)))
        ).all()
        supplements_by_id = {s.id: s for s in rows}

    items = [
        TodaySupplementItem(
            plan_id=plan.id,
            supplement_id=plan.supplement_id,
            supplement_name=supplements_by_id[plan.supplement_id].name,
            dose=plan.dose,
            time_of_day=plan.time_of_day,
            done=plan.id in intakes_by_plan,
            intake_id=intakes_by_plan[plan.id].id if plan.id in intakes_by_plan else None,
        )
        for plan in plans
    ]
    items.extend(
        TodaySupplementItem(
            plan_id=None,
            supplement_id=intake.supplement_id,
            supplement_name=supplements_by_id[intake.supplement_id].name,
            dose=intake.dose,
            time_of_day=None,
            done=True,
            intake_id=intake.id,
        )
        for intake in ad_hoc
    )
    return items
