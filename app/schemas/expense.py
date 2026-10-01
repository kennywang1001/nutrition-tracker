from datetime import datetime
from decimal import Decimal

from pydantic import AwareDatetime, BaseModel, Field, model_validator

from app.models.expense import ExpenseCategory

# **`spent_at` 一律要帶時區偏移，naive 的一律 422。**
#
# 這不是潔癖，是這個模組唯一一個會算錯錢的地方（最終審查實測）：
# 沒有 offset 的 ISO 字串（`"2026-11-30T23:30"`）Pydantic 會照收成 naive，
# 然後 asyncpg 存進 timestamptz 時走 `dt.astimezone()`，而 `astimezone()`
# 對 naive 值**假設執行程序的本機時區**。於是同一個輸入：
#
#   開發機（Asia/Taipei）→ 2026-11-30T15:30Z → 月報表算成 11 月 ✅
#   容器（沒設 TZ，等於 UTC）→ 2026-11-30T23:30Z → 算成 12 月 ❌
#
# 台北使用者在每個月最後一天 16:00 之後記的每一筆，在 production 都會
# 跑到下個月，而**開發機上永遠重現不出來**。
#
# `<input type="datetime-local">` 產出的正是沒有 offset 的格式，
# 而那正是 P5 計畫二的前端表單會用的元件——這不是理論風險。
AwareInstant = AwareDatetime

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
    # AwareDatetime 而不是 datetime——見檔頭 AwareInstant 的說明。
    spent_at: AwareInstant
    note: str | None = Field(default=None, max_length=500)


class ExpenseUpdateRequest(BaseModel):
    """`PATCH /api/expenses/{id}`。

    跟 `MealUpdateRequest` 同一種哨兵寫法：每個欄位都是 `X | None = None`，
    `None` 代表「這次請求沒帶這個欄位」，路由用 `model_dump(exclude_unset=True)`
    決定要更新哪些。

    `amount` / `category` / `spent_at` 是 NOT NULL，顯式 `null` 必須擋在這裡——
    否則會一路流到 `setattr`，撞上 `asyncpg.NotNullViolationError` 變成
    已認證使用者就能觸發的 500（`UpdateMeRequest` 踩過的同一個坑）。
    `note` 是 nullable，`{"note": null}` 是合法輸入、必須放行到底。

    **`meal_id` 不可改**：把一筆支出從一餐搬到另一餐沒有實際用途，
    而且是個好用的攻擊面（改成別人的 meal_id）——規格 §5.1。
    它不是這個 model 的欄位，Pydantic 預設 `extra="ignore"` 會直接丟掉，
    所以「不可改」是結構性的，不是靠檢查——但那件事需要一條測試釘住
    （`tests/test_expenses_crud.py`），否則有人把它加進來也沒人會發現。
    """

    amount: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
    category: ExpenseCategory | None = None
    # AwareDatetime 而不是 datetime——見檔頭 AwareInstant 的說明。
    spent_at: AwareInstant | None = None
    note: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _reject_explicit_nulls_on_non_nullable_fields(self) -> "ExpenseUpdateRequest":
        """跟 `MealUpdateRequest` / `UpdateMeRequest` 一字不差的同一套寫法。

        **最終審查發現原本的實作在路由層丟 `UnprocessableEntityError`，
        回的是 `code: "FIELD_NOT_NULLABLE"`——全專案獨一無二的形狀。**
        既有兩處同類錯誤都走 `RequestValidationError`，前端拿到的是
        `code: "VALIDATION_ERROR"` 加上 `details.errors[].loc`。
        兩套形狀等於前端要為 `/expenses` 寫第二套錯誤處理。

        搬回 schema 層之後三處一致，而且這個限制會出現在 OpenAPI 裡。
        """
        # note 刻意不在這個集合裡：它在資料庫是 nullable，顯式 null 是
        # 合法的「清空備註」語意，不該被擋下來。
        non_nullable = {"amount", "category", "spent_at"}
        nulls = sorted(
            field
            for field in self.model_fields_set
            if field in non_nullable and getattr(self, field) is None
        )
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self


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
