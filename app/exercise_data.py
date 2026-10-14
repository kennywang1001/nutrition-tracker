"""運動端點與每日統計共用的讀取（運動規格 §4.3、§6）。只用呼叫端給的 user_id。

健康相關的資料：這個模組不寫 log（`tests/test_exercise_privacy.py` 掃這個檔案）。"""

from dataclasses import dataclass
from datetime import date, datetime
from decimal import Decimal
from zoneinfo import ZoneInfo

from sqlalchemy.ext.asyncio import AsyncSession

from app.body_data import weight_as_of
from app.errors import UnprocessableEntityError
from app.exercise import ACTIVITY_BY_CODE, MAX_KCAL, ActivityCode, estimate_kcal


@dataclass(frozen=True)
class Estimate:
    kcal: Decimal
    met: Decimal
    weight_kg: Decimal
    weight_date: date


def local_day(instant: datetime, tz_name: str) -> date:
    """這個時刻在使用者時區是哪一天（跟 `day_bounds` 同一個時區庫）。"""
    return instant.astimezone(ZoneInfo(tz_name)).date()


async def estimate_for(
    db: AsyncSession,
    *,
    user_id: int,
    tz_name: str,
    activity: ActivityCode,
    minutes: int,
    performed_at: datetime,
) -> Estimate | None:
    """估算這一筆。**沒有可用的體重回 `None`**（D8：不給預設體重，呼叫端決定是 422 還是
    `{ready: false}`）。「其他」與超過 5000 是 422（D9：存下去的數字要是算出來的或使用者打的，
    不悄悄夾到 5000）。"""
    met = ACTIVITY_BY_CODE[activity].met
    if met is None:
        raise UnprocessableEntityError("EXERCISE_NOT_ESTIMABLE", "「其他」沒有辦法估算，請輸入熱量")
    entry = await weight_as_of(db, user_id, local_day(performed_at, tz_name))
    if entry is None:
        return None
    kcal = estimate_kcal(met, entry.weight_kg, minutes)
    if kcal > MAX_KCAL:
        raise UnprocessableEntityError(
            "EXERCISE_ESTIMATE_TOO_HIGH",
            f"估算是 {kcal} kcal，超過 {MAX_KCAL}：請手動輸入熱量，或拆成兩筆",
        )
    return Estimate(kcal=kcal, met=met, weight_kg=entry.weight_kg, weight_date=entry.date)
