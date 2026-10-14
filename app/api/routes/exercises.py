"""運動紀錄（運動規格 §6）。只讀寫自己的；別人的 id 一律 404。

健康相關的資料：這個模組不寫 log（`tests/test_exercise_privacy.py` 掃這個檔案）。"""

from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, Query
from pydantic import AwareDatetime
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import utc_now
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.exercise import ACTIVITIES, ActivityCode
from app.exercise_data import estimate_for
from app.models.user import User
from app.schemas.exercise import ActivityResponse, EstimateMissing, EstimateReady

# 兩個前綴（規格 §6）：`/api/exercise/...` 是活動清單與預覽，`/api/exercises` 是紀錄本身。
activities_router = APIRouter(prefix="/exercise", tags=["exercises"])
router = APIRouter(prefix="/exercises", tags=["exercises"])

# D18：給裝置時鐘的誤差。
FUTURE_TOLERANCE = timedelta(minutes=5)


def check_not_in_future(performed_at: datetime) -> None:
    """D18：運動的時間會決定用哪一筆體重，所以後端也擋未來（餐點只有前端擋）。"""
    if performed_at > utc_now() + FUTURE_TOLERANCE:
        raise UnprocessableEntityError("EXERCISE_IN_FUTURE", "不能記未來的運動")


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
