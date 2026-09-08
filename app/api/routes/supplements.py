from fastapi import APIRouter, Depends, Query, status
from sqlalchemy import ColumnElement, or_, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError
from app.models.supplement import Supplement
from app.models.user import User
from app.schemas.supplement import SupplementCreateRequest, SupplementResponse, SupplementScope

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
