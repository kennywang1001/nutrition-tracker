"""身體資料、建議目標、體重的請求與回應（身體資料規格 §5）。健康資料：這些形狀只出現在
身體資料的端點，好友與社群的回應不准引用（`tests/test_body_privacy.py`）。"""

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field, field_validator

from app.body_targets import MissingInput
from app.models.body import ActivityLevel, Goal, Sex

RATES = (Decimal("0.25"), Decimal("0.5"))


class BodyProfileRequest(BaseModel):
    """`PUT /api/me/body-profile`：**七個鍵都必填、值可以 null**（D5，同 `TargetTodayRequest`）。

    出生年這裡只擋衛生範圍（同資料庫的 CHECK）；「今年 − 100 到今年 − 13」要知道使用者的
    今天，在端點擋（D4）。"""

    sex: Sex | None
    birth_year: int | None = Field(ge=1900, le=2100)
    height_cm: Decimal | None = Field(ge=100, le=250, max_digits=4, decimal_places=1)
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None = Field(max_digits=3, decimal_places=2)
    target_weight_kg: Decimal | None = Field(ge=25, le=350, max_digits=5, decimal_places=2)

    @field_validator("rate_kg_per_week")
    @classmethod
    def _rate_is_one_of_two(cls, value: Decimal | None) -> Decimal | None:
        # Decimal 比的是數值：0.50 也算 0.5。
        if value is not None and value not in RATES:
            raise ValueError("速度只能是每週 0.25 或 0.5 公斤")
        return value


class BodyProfileResponse(BaseModel):
    """沒有那一列＝七個都是 null（不是 404）。**不含** `targets_applied_weight_kg`（內部用）。"""

    sex: Sex | None
    birth_year: int | None
    height_cm: Decimal | None
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None
    target_weight_kg: Decimal | None


class SuggestionReady(BaseModel):
    """建議目標（D10：跟 `SuggestionMissing` 是普通聯集，不加 discriminator——加了
    openapi-typescript 會產生 `ready: "True"`）。"""

    ready: Literal[True]
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    bmr: Decimal
    tdee: Decimal
    adjustment_kcal: Decimal
    floor_applied: bool
    floor_kcal: Decimal
    weight_kg: Decimal
    based_on_date: date
    applied_weight_kg: Decimal | None
    weight_change_kg: Decimal | None
    resuggest: bool


class SuggestionMissing(BaseModel):
    """缺什麼（D11 的固定順序）：前端照順序列出、決定連到身體資料還是記錄體重。"""

    ready: Literal[False]
    missing: list[MissingInput]
