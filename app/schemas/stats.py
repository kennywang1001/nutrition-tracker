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


class DayTrendResponse(BaseModel):
    """`GET /api/stats/range` 趨勢陣列裡的一天（Task 8）。

    欄位與 `DailyStatsResponse` 的前四項刻意完全一致，包括 `target` / `ratio`
    的兩層 null 語意 —— 趨勢裡的一天跟單獨查那一天，意義必須一樣，
    否則同一個日期從兩個端點拿到不同答案。

    沒有資料的日子 `actual` 是 0，不是把那一天從陣列裡拿掉：畫圖要連續。
    """

    date: date
    actual: MacrosResponse
    target: NullableMacrosResponse | None
    ratio: NullableMacrosResponse | None


class RangeStatsResponse(BaseModel):
    """`GET /api/stats/range?from=&to=` 的回應（Task 8）。

    查詢參數是 `from` / `to`（規格第 7.6 節），但回應欄位叫
    `date_from` / `date_to` —— `from` 是 Python 保留字，當欄位名要額外的
    alias 機制才寫得出來，而回應欄位名不影響使用者輸入的介面。

    區間**兩端都含**：使用者說「9/1 到 9/7」預期的是 7 天。
    （內部分桶仍然用半開區間，見 `app/stats.py`。）

    `adherence` 是決定 3 定義的補劑依從率：
    「有打卡的 (計畫, 日) 配對數 / 應該有的配對數」，每對最多算一次。
    完全沒有計畫時是 `null` —— 不是 0（那會讀成「一次都沒吃」），
    也不是 1（那會讀成「全部做到」）。
    """

    date_from: date
    date_to: date
    trend: list[DayTrendResponse]
    adherence: Decimal | None
