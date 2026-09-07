from datetime import datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, ConfigDict, Field

from app.models.food import BaseUnit, RevisionStatus


class FoodScope(StrEnum):
    ALL = "all"
    GLOBAL = "global"
    MINE = "mine"


class NutritionInput(BaseModel):
    base_unit: BaseUnit = BaseUnit.G
    # 每 100g / 100ml 的數值。上限取一個生理上不可能的值，
    # 純粹是防呆與請求體衛生，不是營養學上的斷言。
    kcal: Decimal = Field(ge=0, le=10000, max_digits=8, decimal_places=2)
    protein_g: Decimal = Field(ge=0, le=1000, max_digits=8, decimal_places=2)
    fat_g: Decimal = Field(ge=0, le=1000, max_digits=8, decimal_places=2)
    carb_g: Decimal = Field(ge=0, le=1000, max_digits=8, decimal_places=2)


class NutritionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    base_unit: BaseUnit
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


class FoodCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    brand: str | None = Field(default=None, max_length=100)
    nutrition: NutritionInput


class FoodResponse(BaseModel):
    id: int
    name: str
    brand: str | None
    is_global: bool
    # 沒有生效版本時為 None —— 全域食物的初版被駁回就會是這個狀態
    nutrition: NutritionResponse | None


class RevisionCreateRequest(BaseModel):
    nutrition: NutritionInput
    change_note: str | None = Field(default=None, max_length=500)


class RevisionResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    base_unit: BaseUnit
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    status: RevisionStatus
    change_note: str | None
    created_by: int
    created_at: datetime
    reviewed_by: int | None
    reviewed_at: datetime | None
    reject_reason: str | None
    is_current: bool = False


class PortionCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=50)
    grams: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    is_default: bool = False
    # 只有管理員能建立全域份量
    is_global: bool = False


class PortionResponse(BaseModel):
    id: int
    label: str
    grams: Decimal
    is_default: bool
    is_global: bool
