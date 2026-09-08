from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError
from app.models.supplement import SupplementPlan
from app.models.user import User
from app.schemas.supplement import SupplementPlanCreateRequest, SupplementPlanResponse
from app.supplement_visibility import assert_supplement_visible

router = APIRouter(prefix="/supplement-plans", tags=["supplement-plans"])


def _to_response(plan: SupplementPlan) -> SupplementPlanResponse:
    return SupplementPlanResponse(
        id=plan.id,
        supplement_id=plan.supplement_id,
        dose=plan.dose,
        time_of_day=plan.time_of_day,
        effective_from=plan.effective_from,
        effective_to=plan.effective_to,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=SupplementPlanResponse)
async def create_plan(
    payload: SupplementPlanCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SupplementPlanResponse:
    # 看不到的補劑一律 404 —— 跟「不存在」無法區分（繼承規矩第 1 條）。
    await assert_supplement_visible(db, payload.supplement_id, user)

    plan = SupplementPlan(
        user_id=user.id,
        supplement_id=payload.supplement_id,
        dose=payload.dose,
        time_of_day=payload.time_of_day,
        effective_from=payload.effective_from,
        effective_to=payload.effective_to,
    )
    db.add(plan)
    try:
        await db.commit()
    except IntegrityError as exc:
        # ex_supplement_plans_no_overlap（決定 2）：同一個使用者、同一個補劑、
        # 同一個時段的有效期間重疊。rollback 是必要的（繼承規矩第 3 條）——
        # 少了它，這個 session 之後所有操作都會拋 PendingRollbackError；
        # 而 rollback() 會讓 identity map 裡所有物件過期，呼叫端若還抓著
        # user / supplement 之類的物件，屬性存取會觸發重新查詢。
        await db.rollback()
        raise ConflictError(
            "PLAN_OVERLAPS", "這個補劑在同一時段已經有重疊的計畫"
        ) from exc

    await db.refresh(plan)
    return _to_response(plan)


@router.get("", response_model=list[SupplementPlanResponse])
async def list_plans(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[SupplementPlanResponse]:
    plans = (
        await db.scalars(
            select(SupplementPlan)
            .where(SupplementPlan.user_id == user.id)
            .order_by(SupplementPlan.effective_from.desc(), SupplementPlan.id.desc())
        )
    ).all()
    return [_to_response(p) for p in plans]
