"""身體資料端點共用的讀寫（身體資料規格 §5）。只用呼叫端給的 user_id——沒有「讀別人的」這條路。"""

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.body_targets import BodyInputs
from app.models.body import UserProfile, WeightEntry


async def load_profile(db: AsyncSession, user_id: int) -> UserProfile | None:
    return await db.scalar(select(UserProfile).where(UserProfile.user_id == user_id))


async def latest_weight(db: AsyncSession, user_id: int) -> WeightEntry | None:
    """**日期**最新的一筆（不是最後寫的那一筆：補記上週的不會變成「目前體重」）。"""
    return await db.scalar(
        select(WeightEntry)
        .where(WeightEntry.user_id == user_id)
        .order_by(WeightEntry.date.desc())
        .limit(1)
    )


def inputs_from(profile: UserProfile | None, latest: WeightEntry | None) -> BodyInputs:
    return BodyInputs(
        sex=profile.sex if profile else None,
        birth_year=profile.birth_year if profile else None,
        height_cm=profile.height_cm if profile else None,
        activity_level=profile.activity_level if profile else None,
        goal=profile.goal if profile else None,
        rate_kg_per_week=profile.rate_kg_per_week if profile else None,
        weight_kg=latest.weight_kg if latest else None,
    )


async def clear_applied_weight(db: AsyncSession, user_id: int) -> None:
    """手動存目標時呼叫（D16）。不 commit：跟目標在同一個交易。沒有那一列就什麼都不做。"""
    await db.execute(
        update(UserProfile)
        .where(UserProfile.user_id == user_id)
        .values(targets_applied_weight_kg=None)
    )
