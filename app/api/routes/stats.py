from datetime import date
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.models.target import UserTarget
from app.models.user import User
from app.nutrition import Macros
from app.schemas.stats import (
    BreakdownResponse,
    DailyStatsResponse,
    MacrosResponse,
    NullableMacrosResponse,
)
from app.stats import daily_macros

router = APIRouter(prefix="/stats", tags=["stats"])

_CENTS = Decimal("0.01")


def _macros_response(macros: Macros) -> MacrosResponse:
    return MacrosResponse(
        kcal=macros.kcal, protein_g=macros.protein_g, fat_g=macros.fat_g, carb_g=macros.carb_g
    )


def _ratio_field(actual: Decimal, target_value: Decimal | None) -> Decimal | None:
    """陷阱 3 + 決定 2 的核心，逐欄位處理：

    - 目標沒設這個欄位（`None`）-> 比例也是 `None`（不是 0，「沒設目標」
      跟「目標是 0」是不同的事）。
    - 目標這個欄位設為 `0`（CHECK 允許，見計畫 Task 1/2 的實測發現：
      `CHECK (x IS NULL OR x >= 0)` 對 `0` 完全放行）-> 除法沒有意義，
      比例也回 `None`，而不是讓 ZeroDivisionError 一路逃逸成 500。
    - 其餘情況：四捨五入到小數點後兩位，跟 nutrition.py 的貨幣化精度一致。
    """
    if target_value is None or target_value == 0:
        return None
    return (actual / target_value).quantize(_CENTS, rounding=ROUND_HALF_UP)


@router.get("/daily", response_model=DailyStatsResponse)
async def get_daily_stats(
    date: date | None = Query(default=None),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> DailyStatsResponse:
    """回一天的實際攝取、目標、比例與食物/補劑分項（決定 2：只回數字，
    不判斷達標與否——同一個 110% 在減脂期跟增肌期意義相反，那個判斷留給
    前端）。

    省略 `date` 時預設「使用者時區的今天」，跟 `GET /api/meals?date=`、
    `GET /api/supplements/today` 用同一個 `today_in_timezone()`（陷阱 1：
    三個端點對「同一天」的判斷必須完全一致）。

    固定 3 次查詢（食物一次、補劑一次、目標一次），跟這一天有幾個餐點項目、
    幾筆補劑打卡都無關——`app/stats.py` 的 `daily_macros()` 已經保證了
    食物與補劑各自只發一次查詢，這裡再加一次目標查詢。
    """
    day = date or today_in_timezone(user.timezone)

    day_macros = await daily_macros(db, user_id=user.id, tz_name=user.timezone, day=day)
    actual = day_macros.actual

    # 半開區間判斷「那一天生效的目標」：跟 GET /api/targets?date= 是同一條
    # 規則（effective_from <= date < effective_to，effective_to 為 NULL 視為
    # 無窮遠的未來），兩處不能有一處用 <=。
    target_row = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user.id,
            UserTarget.effective_from <= day,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > day),
        )
    )

    target_response: NullableMacrosResponse | None = None
    ratio_response: NullableMacrosResponse | None = None
    if target_row is not None:
        target_response = NullableMacrosResponse(
            kcal=target_row.kcal,
            protein_g=target_row.protein_g,
            fat_g=target_row.fat_g,
            carb_g=target_row.carb_g,
        )
        ratio_response = NullableMacrosResponse(
            kcal=_ratio_field(actual.kcal, target_row.kcal),
            protein_g=_ratio_field(actual.protein_g, target_row.protein_g),
            fat_g=_ratio_field(actual.fat_g, target_row.fat_g),
            carb_g=_ratio_field(actual.carb_g, target_row.carb_g),
        )

    return DailyStatsResponse(
        date=day,
        actual=_macros_response(actual),
        target=target_response,
        ratio=ratio_response,
        breakdown=BreakdownResponse(
            food=_macros_response(day_macros.food),
            supplement=_macros_response(day_macros.supplement),
        ),
    )
