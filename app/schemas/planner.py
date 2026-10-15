"""`GET /api/planner/library-suggestions` 的回應（營養素配餐規格 D13）。"""

import enum
from datetime import date
from decimal import Decimal

from pydantic import BaseModel

from app.schemas.food import FoodResponse
from app.schemas.stats import MacrosResponse, NullableMacrosResponse


class PlannerStatus(enum.StrEnum):
    OK = "ok"
    # 沒有熱量目標：畫面請使用者先設定（規格 D3）。
    NO_TARGET = "no_target"
    # 剩下的熱量不到 50 kcal（規格 D4）。
    FULL = "full"
    # 自己的餐裡沒有任何有生效版本的食物。
    NO_CANDIDATES = "no_candidates"
    # 有候選，但沒有任何一組不超過上限（每一樣最小的量就太多）。
    NO_FIT = "no_fit"


class RemainingResponse(BaseModel):
    """今天還能吃多少。三大營養素是 null＝沒設目標（或目標是 0），不考慮（規格 D2）。"""

    kcal: Decimal
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


class PlannedPortionResponse(BaseModel):
    id: int
    label: str
    grams: Decimal


class PlannedItemResponse(BaseModel):
    """組合裡的一樣。`portion` 不是 null 時 `quantity` 是「幾份」（記一餐送 `portion_id`）；
    是 null 時 `quantity` 是 g 或 ml（看 `food.nutrition.base_unit`）。`nutrition` 是這一樣的量的
    四個數字（跟記下去之後 `/stats/daily` 算的一樣，`app/nutrition.py` 的 `scale()`）。"""

    food: FoodResponse
    portion: PlannedPortionResponse | None
    quantity: Decimal
    quantity_g: Decimal
    nutrition: MacrosResponse


class PlannedComboResponse(BaseModel):
    items: list[PlannedItemResponse]
    total: MacrosResponse
    # 合計 / 剩下（兩位小數）。不考慮的那一項、或剩下 0 的那一項是 null。
    fill: NullableMacrosResponse


class LibrarySuggestionsResponse(BaseModel):
    date: date
    status: PlannerStatus
    # 只有 `no_target` 時是 null。
    remaining: RemainingResponse | None
    # 只有 `ok` 時有東西：1 到 3 組，最好的在前。
    combos: list[PlannedComboResponse]
