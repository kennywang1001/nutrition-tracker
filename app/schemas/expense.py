from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

from app.models.expense import ExpenseCategory

# `YYYY-MM`。年份刻意限定 19xx/20xx 而不是 `\d{4}`：
# `date(0, 1, 1)` 會拋 ValueError，那是一個已認證使用者用
# `?month=0000-01` 就能觸發的 500。月份限定 01–12，同理
# （`date(2026, 13, 1)` 一樣拋 ValueError）。
#
# **擋在這一層而不是路由層**，是因為 FastAPI 對 Query 的 pattern 不符
# 會自動回 422 並帶上清楚的 loc/msg；自己在路由裡 parse 再 raise
# 要多寫一段，而且容易漏掉其中一種。
YEAR_MONTH_PATTERN = r"^(19|20)\d{2}-(0[1-9]|1[0-2])$"


class ExpenseCreateRequest(BaseModel):
    # gt=0 是第一道防線；資料庫的 ck_expenses_amount_positive 是第二道。
    # max_digits/decimal_places 對齊 numeric(10,2)：超過的話 asyncpg 會拋
    # DataError 變成未處理的 500，而不是 422。
    amount: Decimal = Field(gt=0, max_digits=10, decimal_places=2)
    category: ExpenseCategory
    spent_at: datetime
    note: str | None = Field(default=None, max_length=500)


class ExpenseUpdateRequest(BaseModel):
    """`PATCH /api/expenses/{id}`。

    跟 `MealUpdateRequest` 同一種哨兵寫法：每個欄位都是 `X | None = None`，
    `None` 代表「這次請求沒帶這個欄位」，路由用 `model_dump(exclude_unset=True)`
    決定要更新哪些。

    `amount` / `category` / `spent_at` 是 NOT NULL，顯式 `null` 必須擋在這裡——
    否則會一路流到 `setattr`，撞上 `asyncpg.NotNullViolationError` 變成
    已認證使用者就能觸發的 500（`UpdateMeRequest` 踩過的同一個坑）。
    但 Pydantic 沒辦法區分「沒帶」與「帶了 null」在同一個 `X | None` 欄位上，
    所以這裡用 `exclude_unset` + 路由層對 None 的明確檢查（見 Task 4）。

    **`meal_id` 不可改**：把一筆支出從一餐搬到另一餐沒有實際用途，
    而且是個好用的攻擊面（改成別人的 meal_id）——規格 §5.1。
    """

    amount: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
    category: ExpenseCategory | None = None
    spent_at: datetime | None = None
    note: str | None = Field(default=None, max_length=500)


class ExpenseResponse(BaseModel):
    id: int
    amount: Decimal
    category: ExpenseCategory
    spent_at: datetime
    note: str | None
    meal_id: int | None


class CategoryTotal(BaseModel):
    category: ExpenseCategory
    total: Decimal
    count: int


class ExpenseSummaryResponse(BaseModel):
    month: str
    total: Decimal
    by_category: list[CategoryTotal]
