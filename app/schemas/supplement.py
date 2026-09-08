from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, Field

_ZERO = Decimal("0")


class SupplementScope(StrEnum):
    ALL = "all"
    GLOBAL = "global"
    MINE = "mine"


class SupplementCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    brand: str | None = Field(default=None, max_length=100)
    # 開放集合（'capsule'、'g'、'ml'、'IU'……），純粹用於顯示，不參與計算
    # （規格第 6.4 節：跟 foods.serving_unit 一樣故意不做 enum）。
    serving_unit: str = Field(min_length=1, max_length=50)
    serving_size: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    # 四個都預設 0：只想記錄「吃了沒」而不記熱量的補劑（例如魚油）不用每次
    # 都特地填 0（計畫 Task 4 驗收項目之一）。這裡的 ge=0 在 Pydantic 這層
    # 就擋掉負值，資料庫的 CHECK 是第二道防線（跟 foods 的 NutritionInput
    # 同一種取捨）。
    kcal: Decimal = Field(default=_ZERO, ge=0, le=10000, max_digits=8, decimal_places=2)
    protein_g: Decimal = Field(default=_ZERO, ge=0, le=1000, max_digits=8, decimal_places=2)
    fat_g: Decimal = Field(default=_ZERO, ge=0, le=1000, max_digits=8, decimal_places=2)
    carb_g: Decimal = Field(default=_ZERO, ge=0, le=1000, max_digits=8, decimal_places=2)


class SupplementResponse(BaseModel):
    id: int
    name: str
    brand: str | None
    is_global: bool
    serving_unit: str
    serving_size: Decimal
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
