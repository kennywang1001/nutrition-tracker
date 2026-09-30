from datetime import datetime
from decimal import Decimal

from fastapi import APIRouter, Depends, Query, Response, status
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user, get_owned_or_404
from app.api.params import ResourceId
from app.days import month_bounds, this_month_in_timezone
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.expense import Expense
from app.models.user import User
from app.schemas.expense import (
    YEAR_MONTH_PATTERN,
    CategoryTotal,
    ExpenseCreateRequest,
    ExpenseResponse,
    ExpenseSummaryResponse,
    ExpenseUpdateRequest,
)

router = APIRouter(prefix="/expenses", tags=["expenses"])


def _to_response(expense: Expense) -> ExpenseResponse:
    return ExpenseResponse(
        id=expense.id,
        amount=expense.amount,
        category=expense.category,
        spent_at=expense.spent_at,
        note=expense.note,
        meal_id=expense.meal_id,
    )


def _resolve_month(month: str | None, tz_name: str) -> tuple[datetime, datetime, str]:
    """把 `?month=YYYY-MM`（或省略）換成 UTC 半開區間，外加正規化後的月份字串。

    **`GET /api/expenses` 與 `GET /api/expenses/summary` 共用這一個函式。**
    兩個端點對「這個月」如果不是同一份實作，清單跟總額會對不起來——
    而且只在月初或月底那幾個小時對不起來，是最難重現的那種（規格 §5.1）。

    `month` 的格式由 `YEAR_MONTH_PATTERN` 在 FastAPI 那一層擋掉，
    所以這裡的 `int(...)` 不需要 try/except：走到這裡的字串一定是
    19xx/20xx-01..12。
    """
    if month is None:
        year, month_number = this_month_in_timezone(tz_name)
    else:
        year, month_number = int(month[:4]), int(month[5:7])

    start, end = month_bounds(year, month_number, tz_name)
    return start, end, f"{year:04d}-{month_number:02d}"


@router.post("", status_code=status.HTTP_201_CREATED, response_model=ExpenseResponse)
async def create_expense(
    payload: ExpenseCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpenseResponse:
    """手動記一筆花費。

    `user_id` 從 token 取，**不從 body 取**（P1 既有規則）——
    body 裡根本沒有這個欄位，所以「忘記檢查」這件事在結構上不可能發生。

    `meal_id` 一律是 NULL：從記一餐建出來的支出走 `POST /api/meals`
    的 `cost` 欄位（Task 6），不走這裡。
    """
    expense = Expense(
        user_id=user.id,
        meal_id=None,
        category=payload.category,
        amount=payload.amount,
        spent_at=payload.spent_at,
        note=payload.note,
    )
    db.add(expense)
    await db.commit()
    await db.refresh(expense)
    return _to_response(expense)


@router.get("", response_model=list[ExpenseResponse])
async def list_expenses(
    month: str | None = Query(default=None, pattern=YEAR_MONTH_PATTERN),
    limit: int = Query(default=100, ge=1, le=500),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> list[ExpenseResponse]:
    """這個月的花費，由新到舊。

    **沒有 offset。** `limit` 是一個上限，不是分頁——跟 `foods.py` 的
    `limit` 是同一種東西。一個月的個人支出撞到 500 筆的機率極低，
    真的撞到了再說（規格 §5.1）。
    """
    start, end, _ = _resolve_month(month, user.timezone)

    rows = (
        await db.scalars(
            select(Expense)
            .where(
                Expense.user_id == user.id,
                Expense.spent_at >= start,
                Expense.spent_at < end,
            )
            .order_by(Expense.spent_at.desc(), Expense.id.desc())
            .limit(limit)
        )
    ).all()
    return [_to_response(expense) for expense in rows]


_ZERO = Decimal("0.00")


@router.get("/summary", response_model=ExpenseSummaryResponse)
async def get_summary(
    month: str | None = Query(default=None, pattern=YEAR_MONTH_PATTERN),
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpenseSummaryResponse:
    """這個月花了多少、花在哪——這個模組存在的唯一理由(規格 §1.1)。

    一次 GROUP BY 查詢。`total` 在 Python 端把各分類加起來,不再發第二次
    查詢——`Decimal` 相加是精確的,不會有浮點誤差。

    **`total` 由後端算,不是前端加總。** 前端加總會在將來加上篩選或分頁時
    安靜地算錯(規格 §5.2)。

    月界線走 `_resolve_month()`,跟 `list_expenses` 同一份實作。
    """
    start, end, normalized_month = _resolve_month(month, user.timezone)

    rows = (
        await db.execute(
            select(
                Expense.category,
                func.sum(Expense.amount).label("total"),
                func.count().label("count"),
            )
            .where(
                Expense.user_id == user.id,
                Expense.spent_at >= start,
                Expense.spent_at < end,
            )
            .group_by(Expense.category)
            .order_by(func.sum(Expense.amount).desc())
        )
    ).all()

    by_category = [
        CategoryTotal(category=row.category, total=row.total, count=row.count) for row in rows
    ]
    # sum() 的 start 是 _ZERO 而不是 0:沒有任何資料時要回 "0.00",
    # 不是 "0"——回應型別是 Decimal,而 Decimal(0) 序列化成 "0"。
    total = sum((row.total for row in by_category), _ZERO)

    return ExpenseSummaryResponse(
        month=normalized_month, total=total, by_category=by_category
    )


# `amount` / `category` / `spent_at` 是 NOT NULL；`note` 是 nullable。
# 只有前三個的顯式 null 要擋。
_NOT_NULLABLE_FIELDS = ("amount", "category", "spent_at")


@router.patch("/{expense_id}", response_model=ExpenseResponse)
async def update_expense(
    expense_id: ResourceId,
    payload: ExpenseUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> ExpenseResponse:
    """改一筆花費。**`meal_id` 不在可改欄位裡**（規格 §5.1）。

    `exclude_unset=True` 是哨兵寫法的關鍵：沒帶的欄位不會出現在 dict 裡。
    少了它，`{"amount": "150"}` 這種請求會把 category 與 spent_at 一起
    設成 None，撞上 NOT NULL。

    但 `exclude_unset` 分不出「沒帶」與「帶了 null」以外的事——
    `{"amount": null}` 是「有帶」，值是 None。所以三個 NOT NULL 欄位
    要在這裡明確擋一次，不能只靠 Pydantic（UpdateMeRequest 踩過的坑）。
    """
    expense = await get_owned_or_404(
        db, Expense, expense_id, owner_id=user.id, owner_field="user_id"
    )

    changes = payload.model_dump(exclude_unset=True)
    for field in _NOT_NULLABLE_FIELDS:
        if field in changes and changes[field] is None:
            raise UnprocessableEntityError(
                "FIELD_NOT_NULLABLE", f"{field} 不能是 null"
            )

    for field, value in changes.items():
        setattr(expense, field, value)

    await db.commit()
    await db.refresh(expense)
    return _to_response(expense)


@router.delete("/{expense_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_expense(
    expense_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> Response:
    """硬刪。這張表沒有稽核需求，而且錯記一筆要能乾淨刪掉（規格 §5.1）。"""
    expense = await get_owned_or_404(
        db, Expense, expense_id, owner_id=user.id, owner_field="user_id"
    )
    await db.delete(expense)
    await db.commit()
    return Response(status_code=status.HTTP_204_NO_CONTENT)
