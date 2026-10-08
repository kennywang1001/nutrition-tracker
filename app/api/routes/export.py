"""匯出自己的資料成 CSV（報表月份與匯出規格 §3）。

三個端點共用一個限速額度、同一種回應：`text/csv; charset=utf-8`、開頭有 BOM、
`Content-Disposition: attachment`，檔名帶使用者時區的今天。內容在 `app/export.py`，
CSV 的寫法在 `app/csv_export.py`。
"""

from collections.abc import AsyncIterator
from typing import Any

from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.export import expense_csv, meal_csv, supplement_csv
from app.models.user import User
from app.ratelimit import export_rate_limiter

router = APIRouter(prefix="/export", tags=["export"])

# OpenAPI 上寫明回的是 CSV（預設會寫成 application/json）。
_CSV_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "CSV（UTF-8，開頭有 BOM）",
        "content": {"text/csv": {"schema": {"type": "string"}}},
    }
}


def _csv_response(body: AsyncIterator[bytes], *, name: str, user: User) -> StreamingResponse:
    """`body` 這時候還沒開始跑：generator 要等 Starlette 送出標頭之後才被迭代。

    **`db` 一定要是預設（request）範圍的依賴**：FastAPI 0.118 起，`yield` 的依賴在回應
    **送完之後**才收尾，串流到一半 session 還開著。改成 `Depends(get_db, scope="function")`
    或退回 0.118 之前，session 會在第一塊送出之前就被關掉（`tests/test_export.py` 有一條守著）。
    """
    today = today_in_timezone(user.timezone)
    return StreamingResponse(
        body,
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{name}-{today.isoformat()}.csv"',
            # 個人資料：不要留在任何中間的快取裡。
            "Cache-Control": "no-store",
        },
    )


@router.get("/meals.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_meals(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的餐點：一個項目一列，由舊到新。"""
    # 限速在碰資料庫之前；三個端點同一個鍵（這個使用者），共用每分鐘的額度。
    export_rate_limiter.hit(str(user.id))
    return _csv_response(
        meal_csv(db, user_id=user.id, tz_name=user.timezone), name="meals", user=user
    )


@router.get("/expenses.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_expenses(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的花費：一筆一列，由舊到新。"""
    export_rate_limiter.hit(str(user.id))
    return _csv_response(
        expense_csv(db, user_id=user.id, tz_name=user.timezone), name="expenses", user=user
    )


@router.get("/supplements.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_supplements(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的補劑打卡：一次一列，由舊到新。"""
    export_rate_limiter.hit(str(user.id))
    return _csv_response(
        supplement_csv(db, user_id=user.id, tz_name=user.timezone),
        name="supplements",
        user=user,
    )
