from datetime import date
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

# 上限取一個生理上不可能的值，純粹是防呆與請求體衛生，不是營養學上的斷言
# ——跟 app/schemas/food.py 的 NutritionInput、app/schemas/supplement.py 同一種取捨。
# 這裡是「一天的目標總量」，不是「每 100g」，所以上限比那兩處大方一些。
_MAX_KCAL = Decimal("20000")
_MAX_GRAMS = Decimal("2000")


class TargetCreateRequest(BaseModel):
    """`POST /api/targets` 的請求（規格第 6.5 節 + 陷阱 3）。

    四個營養素皆可省略（None）——允許使用者只設熱量目標、不設三大營養素。
    這裡用 Pydantic 的 `ge=0` 當第一道防線，資料庫的
    `CHECK (x IS NULL OR x >= 0)` 是第二道（且已實測：CHECK 對 NULL 一律放行，
    真正擋掉 NULL 的是欄位型別本身允許 NULL——這裡兩層防線擋的是「負值」，
    不是「NULL」，兩件事不要混為一談）。
    """

    kcal: Decimal | None = Field(default=None, ge=0, le=_MAX_KCAL, max_digits=8, decimal_places=2)
    protein_g: Decimal | None = Field(
        default=None, ge=0, le=_MAX_GRAMS, max_digits=8, decimal_places=2
    )
    fat_g: Decimal | None = Field(
        default=None, ge=0, le=_MAX_GRAMS, max_digits=8, decimal_places=2
    )
    carb_g: Decimal | None = Field(
        default=None, ge=0, le=_MAX_GRAMS, max_digits=8, decimal_places=2
    )
    # '減脂期'、'增肌期' 之類的使用者自訂標籤，純顯示用，跟 model 的欄位註解一致。
    label: str | None = Field(default=None, max_length=100)
    effective_from: date
    effective_to: date | None = None

    @model_validator(mode="after")
    def _validate_effective_range(self) -> "TargetCreateRequest":
        # 跟資料庫的 effective_range CHECK（effective_to > effective_from）
        # 是同一條規則，這裡先擋一次能給出更明確的錯誤位置；CHECK 是第二道防線。
        if self.effective_to is not None and self.effective_to <= self.effective_from:
            raise ValueError("effective_to 必須晚於 effective_from")
        return self


class TargetResponse(BaseModel):
    id: int
    kcal: Decimal | None
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None
    label: str | None
    effective_from: date
    effective_to: date | None
