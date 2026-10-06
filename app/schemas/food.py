from datetime import datetime
from decimal import Decimal
from enum import StrEnum
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

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


class DefaultPortionInput(BaseModel):
    """新增食物時一併建立的「一份」（食物份量規格 §3.1）。

    限制跟 `PortionCreateRequest` 的同名欄位一樣——同一個資料庫欄位，
    不該有兩套規則。
    """

    label: str = Field(min_length=1, max_length=50)
    grams: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)


class FoodCreateRequest(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    brand: str | None = Field(default=None, max_length=100)
    nutrition: NutritionInput
    # 只有管理員能建立全域食物
    is_global: bool = False
    # 選填的「一份」，跟食物在同一個交易裡建立（食物份量規格 §3.1）。
    default_portion: DefaultPortionInput | None = None
    # P1 就預留好的三個欄位（`food_revisions`），P2 是第一個使用者。
    # 規格 §5：「直接確認」與「改過才確認」要分得出來——編輯這個動作本身
    # 帶著資訊。'user' 不代表「沒有 AI 參與」，可能是「AI 估過、但改過才
    # 確認」（那時 ai_raw_response 仍然會一起送進來）。
    #
    # Literal 而不是 str：資料庫這一欄目前沒有 CheckConstraint，前端能送
    # 任意字串進去是一個洞（Task 6 報告）。這裡在 API 層先擋一次；DB 層
    # 另外用 migrations/0009 補了 CheckConstraint，兩層各自獨立生效——
    # 這一層擋不住的（例如未來別的呼叫端直接寫 ORM），DB 那層還是擋得住。
    source: Literal["user", "ai", "official"] = "user"
    ai_confidence: Decimal | None = Field(
        default=None, ge=0, le=1, max_digits=3, decimal_places=2
    )
    ai_raw_response: dict[str, Any] | None = None


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


class PendingRevisionResponse(BaseModel):
    id: int
    food_id: int
    food_name: str
    food_brand: str | None
    base_unit: BaseUnit
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    status: RevisionStatus
    change_note: str | None
    created_by: int
    created_by_name: str
    created_at: datetime
    # 目前生效的數值，供審核者比對
    current_kcal: Decimal | None
    current_protein_g: Decimal | None
    current_fat_g: Decimal | None
    current_carb_g: Decimal | None


class RevisionRejectRequest(BaseModel):
    reason: str = Field(min_length=1, max_length=500)


class PortionCreateRequest(BaseModel):
    label: str = Field(min_length=1, max_length=50)
    grams: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    is_default: bool = False
    # 只有管理員能建立全域份量
    is_global: bool = False


class PortionUpdateRequest(BaseModel):
    """`PATCH /api/foods/{food_id}/portions/{portion_id}`（小項目包規格 §3.1）。

    `exclude_unset`：不帶＝不動。限制同 `PortionCreateRequest`。三個欄位都是
    NOT NULL——顯式 `null` 擋在這裡（不擋會一路流到 asyncpg 變成 500，
    跟 `MealUpdateRequest` 同一個坑）。
    """

    label: str | None = Field(default=None, min_length=1, max_length=50)
    grams: Decimal | None = Field(
        default=None, gt=0, le=10000, max_digits=8, decimal_places=2
    )
    is_default: bool | None = None

    @model_validator(mode="after")
    def _reject_explicit_null(self) -> "PortionUpdateRequest":
        for name in ("label", "grams", "is_default"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} 可以省略，但不接受 null")
        return self


class PortionResponse(BaseModel):
    id: int
    label: str
    grams: Decimal
    is_default: bool
    is_global: bool
