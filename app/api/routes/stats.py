from datetime import date, timedelta
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends, Query
from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.target import UserTarget
from app.models.user import User
from app.nutrition import Macros
from app.schemas.stats import (
    BreakdownResponse,
    DailyStatsResponse,
    DayTrendResponse,
    MacrosResponse,
    NullableMacrosResponse,
    RangeStatsResponse,
)
from app.stats import DayMacros, adherence_rate, bucket_daily_macros, daily_macros

router = APIRouter(prefix="/stats", tags=["stats"])

_CENTS = Decimal("0.01")

# 決定 4：一個請求最多彙總 366 天。沒有上限的話一次可以要求十年的資料，
# 而 P1 沒有分頁也沒有快取，回應體積與天數成正比。
MAX_RANGE_DAYS = 366


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


def _target_and_ratio(
    actual: Macros, target_row: UserTarget | None
) -> tuple[NullableMacrosResponse | None, NullableMacrosResponse | None]:
    """把「那一天生效的目標」轉成回應用的 target / ratio 兩組欄位。

    `/stats/daily` 與 `/stats/range` 共用這一段：趨勢裡的一天跟單獨查那一天，
    兩層 null 的語意必須完全一致，否則同一個日期從兩個端點會拿到不同答案。
    """
    if target_row is None:
        return (None, None)
    return (
        NullableMacrosResponse(
            kcal=target_row.kcal,
            protein_g=target_row.protein_g,
            fat_g=target_row.fat_g,
            carb_g=target_row.carb_g,
        ),
        NullableMacrosResponse(
            kcal=_ratio_field(actual.kcal, target_row.kcal),
            protein_g=_ratio_field(actual.protein_g, target_row.protein_g),
            fat_g=_ratio_field(actual.fat_g, target_row.fat_g),
            carb_g=_ratio_field(actual.carb_g, target_row.carb_g),
        ),
    )


@router.get("/range", response_model=RangeStatsResponse)
async def get_range_stats(
    date_from: date = Query(alias="from"),
    date_to: date = Query(alias="to"),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> RangeStatsResponse:
    """一段期間的每日趨勢與補劑依從率（決定 2：只回數字，不判斷達標與否）。

    `from` / `to` **兩端都含** —— 使用者說「9/1 到 9/7」預期的是 7 天。
    內部一律換成半開區間 `[from, to+1)` 再交給 `app/stats.py`，
    跟 `day_bounds()` 的慣例一致，不讓兩種區間慣例在同一個檔案裡並存。

    固定 5 次查詢（食物、補劑、目標、計畫、打卡各一次），跟期間有幾天無關。
    """
    if date_to < date_from:
        raise UnprocessableEntityError("INVALID_RANGE", "結束日期不能早於開始日期")
    span_days = (date_to - date_from).days + 1
    if span_days > MAX_RANGE_DAYS:
        raise UnprocessableEntityError(
            "RANGE_TOO_LONG", f"期間最多 {MAX_RANGE_DAYS} 天，這次是 {span_days} 天"
        )

    exclusive_end = date_to + timedelta(days=1)
    buckets = await bucket_daily_macros(
        db, user_id=user.id, tz_name=user.timezone, start=date_from, end=exclusive_end
    )

    # 期間內曾經生效過的目標，一次撈完；下面逐日在記憶體裡對應，
    # 不是每天發一次查詢。半開區間：effective_to 那一天已經不屬於這筆目標。
    targets = list(
        (
            await db.execute(
                select(UserTarget).where(
                    UserTarget.user_id == user.id,
                    UserTarget.effective_from < exclusive_end,
                    or_(
                        UserTarget.effective_to.is_(None),
                        UserTarget.effective_to > date_from,
                    ),
                )
            )
        ).scalars()
    )

    def target_for(day: date) -> UserTarget | None:
        for candidate in targets:
            if candidate.effective_from <= day and (
                candidate.effective_to is None or candidate.effective_to > day
            ):
                return candidate
        return None

    empty = DayMacros(food=Macros.zero(), supplement=Macros.zero())
    trend: list[DayTrendResponse] = []
    day = date_from
    while day <= date_to:
        day_macros = buckets.get(day, empty)
        actual = day_macros.actual
        target_response, ratio_response = _target_and_ratio(actual, target_for(day))
        trend.append(
            DayTrendResponse(
                date=day,
                actual=_macros_response(actual),
                target=target_response,
                ratio=ratio_response,
            )
        )
        day += timedelta(days=1)

    taken, expected = await adherence_rate(
        db, user_id=user.id, tz_name=user.timezone, start=date_from, end=exclusive_end
    )
    adherence = (
        None
        if expected == 0
        else (Decimal(taken) / Decimal(expected)).quantize(_CENTS, rounding=ROUND_HALF_UP)
    )

    return RangeStatsResponse(
        date_from=date_from, date_to=date_to, trend=trend, adherence=adherence
    )
