from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.days import today_in_timezone
from app.db import get_db
from app.errors import ConflictError, NotFoundError, UnprocessableEntityError
from app.models.supplement import SupplementPlan
from app.models.user import User
from app.schemas.supplement import (
    SupplementPlanCreateRequest,
    SupplementPlanResponse,
    SupplementPlanUpdateRequest,
)
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


async def _load_owned_plan(db: AsyncSession, plan_id: int, user: User) -> SupplementPlan:
    """依擁有權載入一筆計畫；不存在或不是自己的，一律回同一種 404
    （繼承規矩第 1 條），比照 `app/api/routes/meals.py` 的 `_load_owned_meal`。
    PATCH 與 DELETE 共用這一個函式，擁有權規則只寫一次。
    """
    plan = await db.scalar(
        select(SupplementPlan).where(
            SupplementPlan.id == plan_id, SupplementPlan.user_id == user.id
        )
    )
    if plan is None:
        raise NotFoundError("SUPPLEMENT_PLAN_NOT_FOUND", "找不到該計畫")
    return plan


@router.patch("/{plan_id}", response_model=SupplementPlanResponse)
async def update_plan(
    plan_id: ResourceId,
    payload: SupplementPlanUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SupplementPlanResponse:
    """修改一筆計畫 —— 陷阱 3：這不是原地修改，是「關閉舊期間、開新期間」。

    舊列的 dose / time_of_day 完全不動，只有 effective_to 被設成生效日；
    新列從生效日起、承接沒有明確送的欄位（沿用舊列的值）。這正是有效期間制
    的意義：歷史不動，4b 的依從率才能靠舊列本身回答「當時該吃幾次」。

    **順序不能換**（陷阱 3 已實測）：EXCLUDE 約束逐列立即檢查，UPDATE 一定
    要先 flush，INSERT 的檢查才看得到已經關閉的舊期間；反過來的話新舊兩列
    會重疊，直接違反約束。這裡刻意分兩次 flush（而不是一次 flush 讓
    SQLAlchemy 自己決定 unit-of-work 內的順序），把順序寫死、不依賴實作細節。
    """
    plan = await _load_owned_plan(db, plan_id, user)

    updates = payload.model_dump(exclude_unset=True)
    effective_date = updates.pop("effective_date", None) or today_in_timezone(user.timezone)

    # 跟資料庫的 effective_range CHECK（effective_to > effective_from）同一條
    # 規則：這個生效日會變成舊列的 effective_to。
    if effective_date <= plan.effective_from:
        raise UnprocessableEntityError(
            "EFFECTIVE_DATE_TOO_EARLY", "生效日必須晚於目前這筆計畫的生效日"
        )

    dose = updates.get("dose", plan.dose)
    time_of_day = updates.get("time_of_day", plan.time_of_day)

    plan.effective_to = effective_date
    await db.flush()  # 1. UPDATE 舊列 —— 必須先執行，見上面的說明

    new_plan = SupplementPlan(
        user_id=user.id,
        supplement_id=plan.supplement_id,
        dose=dose,
        time_of_day=time_of_day,
        effective_from=effective_date,
        effective_to=None,
    )
    db.add(new_plan)
    try:
        await db.flush()  # 2. INSERT 新列
    except IntegrityError as exc:
        # 新期間往後延伸太多、撞上另一筆既有計畫（同補劑同時段重疊）。
        # rollback 是必要的（繼承規矩第 3 條）：這裡兩個 flush 都還沒
        # commit，rollback 會把上面那個 UPDATE 也一併復原 —— 交易要嘛
        # 整筆成功、要嘛完全不留下「舊列已關閉但新列沒開成」的半吊子狀態。
        await db.rollback()
        raise ConflictError(
            "PLAN_OVERLAPS", "這個補劑在同一時段已經有重疊的計畫"
        ) from exc

    await db.commit()
    await db.refresh(new_plan)
    return _to_response(new_plan)


@router.delete("/{plan_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_plan(
    plan_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪一筆計畫。擁有權檢查必須在刪除之前（`_load_owned_plan`）——
    不能「先刪、再檢查」，那種順序下「回 404」跟「真的沒刪掉」會脫鉤
    （計畫 3 Task 11 實測過這個坑），對一個一查就砍的實作，只斷言狀態碼
    的測試看不出差別。

    `supplement_intakes.plan_id` 是 `ON DELETE SET NULL`（model 裡宣告）：
    打卡紀錄是歷史，不因為計畫被刪而消失，只是不再屬於任何計畫 —— 這件事
    完全由資料庫的外鍵處理，這裡不需要、也不應該手動去更新 intakes。
    """
    plan = await _load_owned_plan(db, plan_id, user)
    await db.delete(plan)
    await db.commit()
