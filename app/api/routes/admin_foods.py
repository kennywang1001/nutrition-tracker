from datetime import UTC, datetime

from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import require_admin
from app.api.params import ResourceId
from app.db import get_db
from app.errors import ConflictError, NotFoundError
from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import User
from app.schemas.food import PendingRevisionResponse, RevisionRejectRequest, RevisionResponse

router = APIRouter(prefix="/admin/food-revisions", tags=["admin"])


@router.get("", response_model=list[PendingRevisionResponse])
async def list_pending_revisions(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[PendingRevisionResponse]:
    current = aliased(FoodRevision)
    proposer = aliased(User)

    rows = (
        await db.execute(
            select(FoodRevision, Food, current, proposer)
            .join(Food, FoodRevision.food_id == Food.id)
            .join(proposer, FoodRevision.created_by == proposer.id)
            .outerjoin(current, Food.current_revision_id == current.id)
            .where(FoodRevision.status == RevisionStatus.PENDING)
            .order_by(FoodRevision.created_at, FoodRevision.id)
        )
    ).all()

    return [
        PendingRevisionResponse(
            id=revision.id,
            food_id=food.id,
            food_name=food.name,
            food_brand=food.brand,
            base_unit=revision.base_unit,
            kcal=revision.kcal,
            protein_g=revision.protein_g,
            fat_g=revision.fat_g,
            carb_g=revision.carb_g,
            status=revision.status,
            change_note=revision.change_note,
            created_by=revision.created_by,
            created_by_name=proposer_row.display_name,
            created_at=revision.created_at,
            current_kcal=cur.kcal if cur else None,
            current_protein_g=cur.protein_g if cur else None,
            current_fat_g=cur.fat_g if cur else None,
            current_carb_g=cur.carb_g if cur else None,
        )
        for revision, food, cur, proposer_row in rows
    ]


async def _load_pending(db: AsyncSession, revision_id: int) -> tuple[FoodRevision, Food]:
    row = (
        await db.execute(
            select(FoodRevision, Food)
            .join(Food, FoodRevision.food_id == Food.id)
            .where(FoodRevision.id == revision_id)
        )
    ).first()
    if row is None:
        raise NotFoundError("REVISION_NOT_FOUND", "找不到該編輯提案")

    revision, food = row
    if revision.status is not RevisionStatus.PENDING:
        raise ConflictError("REVISION_NOT_PENDING", "這筆提案已經審核過了")
    return revision, food


@router.post("/{revision_id}/approve", response_model=RevisionResponse)
async def approve_revision(
    revision_id: ResourceId,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> RevisionResponse:
    revision, food = await _load_pending(db, revision_id)

    revision.status = RevisionStatus.APPROVED
    revision.reviewed_by = admin.id
    revision.reviewed_at = datetime.now(UTC)
    # 指標只在這裡動。這一行就是「未審核資料查不到」這個保證的全部。
    food.current_revision_id = revision.id

    await db.commit()
    await db.refresh(revision)

    result = RevisionResponse.model_validate(revision)
    result.is_current = True
    return result


@router.post("/{revision_id}/reject", response_model=RevisionResponse)
async def reject_revision(
    revision_id: ResourceId,
    payload: RevisionRejectRequest,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> RevisionResponse:
    revision, food = await _load_pending(db, revision_id)

    revision.status = RevisionStatus.REJECTED
    revision.reviewed_by = admin.id
    revision.reviewed_at = datetime.now(UTC)
    revision.reject_reason = payload.reason
    # 指標不動 —— 駁回的提案從來沒有生效過

    await db.commit()
    await db.refresh(revision)

    result = RevisionResponse.model_validate(revision)
    result.is_current = revision.id == food.current_revision_id
    return result
