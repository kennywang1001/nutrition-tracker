from datetime import date

from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError
from app.models.target import UserTarget
from app.models.user import User
from app.schemas.target import TargetCreateRequest, TargetResponse

router = APIRouter(prefix="/targets", tags=["targets"])


def _to_response(target: UserTarget) -> TargetResponse:
    return TargetResponse(
        id=target.id,
        kcal=target.kcal,
        protein_g=target.protein_g,
        fat_g=target.fat_g,
        carb_g=target.carb_g,
        label=target.label,
        effective_from=target.effective_from,
        effective_to=target.effective_to,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=TargetResponse)
async def create_target(
    payload: TargetCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    target = UserTarget(
        user_id=user.id,
        kcal=payload.kcal,
        protein_g=payload.protein_g,
        fat_g=payload.fat_g,
        carb_g=payload.carb_g,
        label=payload.label,
        effective_from=payload.effective_from,
        effective_to=payload.effective_to,
    )
    db.add(target)
    try:
        await db.commit()
    except IntegrityError as exc:
        # ex_user_targets_no_overlap（決定 1）：同一個使用者的目標期間重疊。
        # rollback 是必要的（繼承規矩第 3 條）——少了它，這個 session 之後
        # 所有操作都會拋 PendingRollbackError。
        await db.rollback()
        raise ConflictError("TARGET_OVERLAPS", "這段期間已經有重疊的目標") from exc

    await db.refresh(target)
    return _to_response(target)


@router.get("", response_model=list[TargetResponse] | TargetResponse | None)
async def list_or_get_target(
    date: date | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[TargetResponse] | TargetResponse | None:
    """規格第 7.6 節的兩行合在同一個路由裡，用 `date` 有沒有帶區分：

    - 沒帶 `date`：`GET /api/targets` 列出我所有的期間（陣列，含已關閉的）。
    - 帶了 `date`：`GET /api/targets?date=` 回那一天生效的那一筆，
      沒有則回 `null`——**200，不是 404**。「沒設目標」是正常狀態，不是
      「目標不存在所以出錯」；4b 的統計端點要能分辨「沒設目標」跟
      「這筆目標 id 不存在」，是完全不同的兩件事。

    「那一天生效」用半開區間判斷（`effective_from <= date < effective_to`，
    `effective_to IS NULL` 視為無窮遠的未來）——跟資料庫 EXCLUDE 約束用的
    `daterange(..., '[)')` 是同一個邊界規則，兩處不能有一處用 `<=`。
    """
    if date is None:
        targets = (
            await db.scalars(
                select(UserTarget)
                .where(UserTarget.user_id == user.id)
                .order_by(UserTarget.effective_from.desc(), UserTarget.id.desc())
            )
        ).all()
        return [_to_response(t) for t in targets]

    target = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user.id,
            UserTarget.effective_from <= date,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > date),
        )
    )
    return _to_response(target) if target is not None else None
