from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.api.deps import require_admin
from app.db import get_db
from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import User
from app.schemas.food import PendingRevisionResponse

router = APIRouter(prefix="/admin/food-revisions", tags=["admin"])


@router.get("", response_model=list[PendingRevisionResponse])
async def list_pending_revisions(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[PendingRevisionResponse]:
    current = aliased(FoodRevision)

    rows = (
        await db.execute(
            select(FoodRevision, Food, current)
            .join(Food, FoodRevision.food_id == Food.id)
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
            created_at=revision.created_at,
            current_kcal=cur.kcal if cur else None,
            current_protein_g=cur.protein_g if cur else None,
            current_fat_g=cur.fat_g if cur else None,
            current_carb_g=cur.carb_g if cur else None,
        )
        for revision, food, cur in rows
    ]
