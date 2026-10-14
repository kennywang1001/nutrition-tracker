"""體重紀錄（身體資料規格 §5.3）。一人一天一筆，日期是使用者時區的日曆日；只讀寫自己的。

健康資料：這個模組不寫 log（`tests/test_body_privacy.py` 掃這個檔案，連註解都不能出現那幾個字）。"""

from datetime import date, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import delete, func, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.models.body import WeightEntry
from app.models.user import User
from app.schemas.body import WeightEntryResponse, WeightListResponse, WeightRequest

router = APIRouter(prefix="/weights", tags=["weights"])

# D13：可以補記兩年內的日子。D14：清單一次最多 800 天（比兩年多一點，剛記的都在裡面）。
MAX_BACKFILL_DAYS = 730
MAX_LIST_DAYS = 800


async def upsert_weight(
    db: AsyncSession, user_id: int, day: date, weight_kg: Decimal
) -> WeightEntryResponse:
    """新增或更正那一天（D13）。不 commit。`ON CONFLICT DO UPDATE` 由資料庫決定誰先誰後：
    同一天兩個同時到的請求，後到的等先到的 commit 再更新，兩個都成功（並行測試守著）。"""
    statement = (
        pg_insert(WeightEntry)
        .values(user_id=user_id, date=day, weight_kg=weight_kg)
        .on_conflict_do_update(
            index_elements=[WeightEntry.user_id, WeightEntry.date],
            set_={"weight_kg": weight_kg, "updated_at": func.now()},
        )
        .returning(WeightEntry.date, WeightEntry.weight_kg)
    )
    row = (await db.execute(statement)).one()
    return WeightEntryResponse(date=row.date, weight_kg=row.weight_kg)


@router.put("/{day}", response_model=WeightEntryResponse)
async def put_weight(
    day: date,
    payload: WeightRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WeightEntryResponse:
    """記（或更正）某一天的體重。日期不能是使用者的明天以後，也不能早於兩年前。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    if day > today:
        raise UnprocessableEntityError("WEIGHT_DATE_IN_FUTURE", "不能記未來的體重")
    if day < today - timedelta(days=MAX_BACKFILL_DAYS):
        raise UnprocessableEntityError("WEIGHT_DATE_TOO_OLD", "只能補記兩年內的體重")
    saved = await upsert_weight(db, user_id, day, payload.weight_kg)
    await db.commit()
    return saved


@router.delete("/{day}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_weight(
    day: date,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """刪掉自己某一天的體重。別人的同一天也是 404（只看得到自己的，所以分不出「別人的」）。"""
    deleted = await db.scalar(
        delete(WeightEntry)
        .where(WeightEntry.user_id == user.id, WeightEntry.date == day)
        .returning(WeightEntry.date)
    )
    if deleted is None:
        raise NotFoundError("WEIGHT_NOT_FOUND", "那一天沒有體重紀錄")
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)


@router.get("", response_model=WeightListResponse)
async def list_weights(
    date_from: date | None = Query(default=None, alias="from"),
    date_to: date | None = Query(default=None, alias="to"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> WeightListResponse:
    """一段日期的體重，由舊到新，兩端都含（D14）。`to` 省略＝使用者的今天；`from` 省略＝
    `to` 往回 799 天（共 800 天）。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    end = date_to if date_to is not None else today
    start = date_from if date_from is not None else end - timedelta(days=MAX_LIST_DAYS - 1)
    if end < start:
        raise UnprocessableEntityError("INVALID_RANGE", "結束日期不能早於開始日期")
    span = (end - start).days + 1
    if span > MAX_LIST_DAYS:
        raise UnprocessableEntityError(
            "RANGE_TOO_LONG", f"期間最多 {MAX_LIST_DAYS} 天，這次是 {span} 天"
        )
    rows = (
        await db.execute(
            select(WeightEntry.date, WeightEntry.weight_kg)
            .where(
                WeightEntry.user_id == user_id,
                WeightEntry.date >= start,
                WeightEntry.date <= end,
            )
            .order_by(WeightEntry.date)
        )
    ).all()
    return WeightListResponse(
        today=today,
        entries=[WeightEntryResponse(date=row.date, weight_kg=row.weight_kg) for row in rows],
    )
