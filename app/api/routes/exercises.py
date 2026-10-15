"""運動紀錄（運動規格 §6）。只讀寫自己的；別人的 id 一律 404。

健康相關的資料：這個模組不寫 log（`tests/test_exercise_privacy.py` 掃這個檔案）。"""

from datetime import date, datetime, timedelta
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response, status
from pydantic import AwareDatetime
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.params import ResourceId
from app.days import day_bounds, today_in_timezone, utc_now
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.exercise import ACTIVITIES, ActivityCode, KcalSource, label_for
from app.exercise_data import estimate_for
from app.models.exercise import ExerciseEntry
from app.models.user import User
from app.schemas.exercise import (
    ActivityResponse,
    EstimateMissing,
    EstimateReady,
    ExerciseCreateRequest,
    ExerciseListResponse,
    ExerciseResponse,
    ExerciseUpdateRequest,
)

# 兩個前綴（規格 §6）：`/api/exercise/...` 是活動清單與預覽，`/api/exercises` 是紀錄本身。
activities_router = APIRouter(prefix="/exercise", tags=["exercises"])
router = APIRouter(prefix="/exercises", tags=["exercises"])

# D18：給裝置時鐘的誤差。
FUTURE_TOLERANCE = timedelta(minutes=5)

def check_not_in_future(performed_at: datetime) -> None:
    """D18：運動的時間會決定用哪一筆體重，所以後端也擋未來（餐點只有前端擋）。"""
    if performed_at > utc_now() + FUTURE_TOLERANCE:
        raise UnprocessableEntityError("EXERCISE_IN_FUTURE", "不能記未來的運動")


# ---------------------------------------------------------------------------
# 活動清單與預覽（`/api/exercise/...`）
# ---------------------------------------------------------------------------


@activities_router.get("/activities", response_model=list[ActivityResponse])
async def list_activities(user: User = Depends(get_current_user)) -> list[ActivityResponse]:
    """固定的活動清單（D2）。前端不另外寫一份。"""
    return [ActivityResponse(code=a.code, label=a.label, met=a.met) for a in ACTIVITIES]


@activities_router.get("/estimate", response_model=EstimateReady | EstimateMissing)
async def preview_estimate(
    activity: ActivityCode,
    minutes: int = Query(ge=1, le=600),
    performed_at: AwareDatetime | None = None,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> EstimateReady | EstimateMissing:
    """存之前先看估算（D11）。`performed_at` 省略＝現在；用那一天（使用者時區）或之前最新的體重。"""
    when = performed_at if performed_at is not None else utc_now()
    check_not_in_future(when)
    result = await estimate_for(
        db,
        user_id=user.id,
        tz_name=user.timezone,
        activity=activity,
        minutes=minutes,
        performed_at=when,
    )
    if result is None:
        return EstimateMissing(ready=False, missing="weight")
    return EstimateReady(
        ready=True,
        kcal=result.kcal,
        met=result.met,
        weight_kg=result.weight_kg,
        weight_date=result.weight_date,
    )


# ---------------------------------------------------------------------------
# 紀錄本身（`/api/exercises`）
# ---------------------------------------------------------------------------


async def _estimated_kcal(
    db: AsyncSession,
    *,
    user_id: int,
    tz_name: str,
    activity: ActivityCode,
    minutes: int,
    performed_at: datetime,
) -> Decimal:
    """存檔用的估算：「其他」與沒有體重都是 422（預覽端點的同一件事是 `{ready: false}`）。"""
    if activity is ActivityCode.OTHER:
        raise UnprocessableEntityError("EXERCISE_NEEDS_KCAL", "「其他」沒辦法估算，要輸入熱量")
    result = await estimate_for(
        db,
        user_id=user_id,
        tz_name=tz_name,
        activity=activity,
        minutes=minutes,
        performed_at=performed_at,
    )
    if result is None:
        raise UnprocessableEntityError(
            "EXERCISE_NEEDS_WEIGHT", "先記一次體重，就能自動估算；或是直接輸入熱量"
        )
    return result.kcal


def _to_response(entry: ExerciseEntry) -> ExerciseResponse:
    return ExerciseResponse(
        id=entry.id,
        performed_at=entry.performed_at,
        activity=entry.activity,
        label=label_for(entry.activity, entry.name),
        name=entry.name,
        minutes=entry.minutes,
        kcal=entry.kcal,
        kcal_source=entry.kcal_source,
        note=entry.note,
        created_at=entry.created_at,
        updated_at=entry.updated_at,
    )


async def _load_owned(db: AsyncSession, user_id: int, exercise_id: int) -> ExerciseEntry:
    entry: ExerciseEntry | None = await db.scalar(
        select(ExerciseEntry).where(
            ExerciseEntry.id == exercise_id, ExerciseEntry.user_id == user_id
        )
    )
    if entry is None:
        # 別人的跟不存在的同一個回應（handover §4.7）：分不出「這個 id 有人用」。
        raise NotFoundError("EXERCISE_NOT_FOUND", "找不到這筆運動")
    return entry


async def _respond_then_commit(db: AsyncSession, entry: ExerciseEntry) -> ExerciseResponse:
    """D21：flush → refresh（`created_at`、`updated_at` 是資料庫給的；`kcal` 讀回兩位小數）
    → 組回應 → commit。commit 之後不碰 ORM 物件，也不送任何 SQL（身體資料審查 M6）。"""
    await db.flush()
    await db.refresh(entry)
    response = _to_response(entry)
    await db.commit()
    return response


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ExerciseResponse)
async def create_exercise(
    payload: ExerciseCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExerciseResponse:
    """記一筆運動。`kcal` 省略＝用那一天或之前最新的體重估算（D7、D10）；帶了＝手動。"""
    user_id, tz_name = user.id, user.timezone
    check_not_in_future(payload.performed_at)
    if payload.kcal is not None:
        kcal, source = payload.kcal, KcalSource.MANUAL
    else:
        kcal = await _estimated_kcal(
            db,
            user_id=user_id,
            tz_name=tz_name,
            activity=payload.activity,
            minutes=payload.minutes,
            performed_at=payload.performed_at,
        )
        source = KcalSource.ESTIMATED
    entry = ExerciseEntry(
        user_id=user_id,
        performed_at=payload.performed_at,
        activity=payload.activity,
        name=payload.name,
        minutes=payload.minutes,
        kcal=kcal,
        kcal_source=source,
        note=payload.note,
    )
    db.add(entry)
    return await _respond_then_commit(db, entry)


@router.get("", response_model=ExerciseListResponse)
async def list_exercises(
    date: date | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExerciseListResponse:
    """某一天（使用者時區）的運動，由舊到新。省略 `date`＝使用者的今天（D19）。"""
    day = date or today_in_timezone(user.timezone)
    start, end = day_bounds(day, user.timezone)
    entries = (
        await db.scalars(
            select(ExerciseEntry)
            .where(
                ExerciseEntry.user_id == user.id,
                ExerciseEntry.performed_at >= start,
                ExerciseEntry.performed_at < end,
            )
            # 同一個時刻的兩筆用 id 排，順序才穩定。
            .order_by(ExerciseEntry.performed_at, ExerciseEntry.id)
        )
    ).all()
    total = sum((entry.kcal for entry in entries), Decimal("0.00"))
    return ExerciseListResponse(
        date=day, total_kcal=total, entries=[_to_response(entry) for entry in entries]
    )


@router.get("/{exercise_id}", response_model=ExerciseResponse)
async def read_exercise(
    exercise_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExerciseResponse:
    """一筆（編輯畫面的預填）。別人的是 404。"""
    return _to_response(await _load_owned(db, user.id, exercise_id))


@router.patch("/{exercise_id}", response_model=ExerciseResponse)
async def update_exercise(
    exercise_id: ResourceId,
    payload: ExerciseUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExerciseResponse:
    """部分更新。估算的那一筆活動、分鐘或時間**真的變了**才重估（活動換 MET、分鐘換長度、
    時間可能換一筆體重）；只改備註、或重送一樣的值都不重估（D22）。`kcal` 帶數字＝手動；
    帶 null＝手動的那一筆改回估算，已經是估算的那一筆不因為它重估（審查 I1）。"""
    user_id, tz_name = user.id, user.timezone
    changes = payload.model_dump(exclude_unset=True)
    entry = await _load_owned(db, user_id, exercise_id)

    activity: ActivityCode = changes.get("activity", entry.activity)
    minutes: int = changes.get("minutes", entry.minutes)
    performed_at: datetime = changes.get("performed_at", entry.performed_at)
    # 帶了 null 的話 get 拿到的是 None（清掉），不是原本的名稱。
    name: str | None = changes.get("name", entry.name)
    if activity is not ActivityCode.OTHER:
        name = None  # D4：名稱只在「其他」有意義
    elif name is None:
        raise UnprocessableEntityError("EXERCISE_NEEDS_NAME", "「其他」要填名稱")
    if "performed_at" in changes:
        check_not_in_future(performed_at)

    # 值真的變了才算（審查 I1）：前端重送一樣的值、或同一個時刻換一種時差寫法，都不該重估。
    inputs_changed = (activity, minutes, performed_at) != (
        entry.activity,
        entry.minutes,
        entry.performed_at,
    )
    if changes.get("kcal") is not None:
        kcal, source = changes["kcal"], KcalSource.MANUAL
    elif ("kcal" in changes and entry.kcal_source is KcalSource.MANUAL) or (
        entry.kcal_source is KcalSource.ESTIMATED and inputs_changed
    ):
        kcal = await _estimated_kcal(
            db,
            user_id=user_id,
            tz_name=tz_name,
            activity=activity,
            minutes=minutes,
            performed_at=performed_at,
        )
        source = KcalSource.ESTIMATED
    else:
        kcal, source = entry.kcal, entry.kcal_source
        # 防禦：「其他」一定是手動（CHECK other_is_manual），這裡照理不會成立。
        if activity is ActivityCode.OTHER and source is KcalSource.ESTIMATED:
            raise UnprocessableEntityError("EXERCISE_NEEDS_KCAL", "「其他」沒辦法估算，要輸入熱量")

    entry.activity = activity
    entry.name = name
    entry.minutes = minutes
    entry.performed_at = performed_at
    entry.kcal = kcal
    entry.kcal_source = source
    if "note" in changes:
        entry.note = changes["note"]
    return await _respond_then_commit(db, entry)


@router.delete("/{exercise_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_exercise(
    exercise_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """刪掉自己的一筆。別人的是 404。"""
    deleted = await db.scalar(
        delete(ExerciseEntry)
        .where(ExerciseEntry.id == exercise_id, ExerciseEntry.user_id == user.id)
        .returning(ExerciseEntry.id)
    )
    if deleted is None:
        raise NotFoundError("EXERCISE_NOT_FOUND", "找不到這筆運動")
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
