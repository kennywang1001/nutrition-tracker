from datetime import date
from decimal import Decimal

from pydantic import BaseModel


class MacrosResponse(BaseModel):
    """一定有值的四個巨量營養素——沒有資料時是 0.00，不是 null（決定 2：
    統計只回數字）。`actual`、`breakdown.food`、`breakdown.supplement` 都用
    這個型別。
    """

    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


class NullableMacrosResponse(BaseModel):
    """四個欄位各自可能是 null（陷阱 3：目標的四個營養素欄位都可以獨立
    不設）。`target` 用這個型別放目標本身的值；`ratio` 用這個型別放
    逐欄位算出來的比例，同一個欄位在 target 是 null 時 ratio 也是 null，
    target 是 0 時 ratio 也是 null（除以 0 沒有意義，不能讓它變成 500）。
    """

    kcal: Decimal | None
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


class BreakdownResponse(BaseModel):
    food: MacrosResponse
    supplement: MacrosResponse


class DailyStatsResponse(BaseModel):
    """`GET /api/stats/daily` 的回應（Task 7，決定 2）。

    `target` 與 `ratio` 整組是 `NullableMacrosResponse | None`——最外層的
    `None` 代表「這一天完全沒有生效的目標」（決定 2：不是 0，也不是省略），
    跟裡面個別欄位的 `None`（陷阱 3：目標存在，但這個營養素沒設）是
    兩層不同的「沒有」，不能混為一談。
    """

    date: date
    actual: MacrosResponse
    target: NullableMacrosResponse | None
    ratio: NullableMacrosResponse | None
    breakdown: BreakdownResponse
