from datetime import date, datetime
from decimal import Decimal
from enum import StrEnum

from pydantic import BaseModel, Field, model_validator

from app.models.supplement import TimeOfDay

_ZERO = Decimal("0")

# PostgreSQL 的 BIGINT 上限，同 app/schemas/meal.py 的 _MAX_BIGINT ——
# supplement_id 是 request body 欄位，不是路徑參數，ResourceId 用不上，
# 照抄同樣的邊界值：超過的話 asyncpg 會拋 DataError 變成未處理的 500。
_MAX_BIGINT = 2**63 - 1


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


class SupplementPlanCreateRequest(BaseModel):
    supplement_id: int = Field(gt=0, le=_MAX_BIGINT)
    # 份數，不是公克/毫升 —— 見計畫決定 1：dose 是 serving_size 的倍數，
    # kcal_total = supplement.kcal * dose，在打卡（Task 8）當下算好存快照。
    dose: Decimal = Field(gt=0, le=1000, max_digits=8, decimal_places=2)
    time_of_day: TimeOfDay
    effective_from: date
    effective_to: date | None = None

    @model_validator(mode="after")
    def _validate_effective_range(self) -> "SupplementPlanCreateRequest":
        # 跟資料庫的 CHECK (effective_to IS NULL OR effective_to > effective_from)
        # 是同一條規則，這裡先擋一次能給出更明確的錯誤位置；CHECK 是第二道防線。
        if self.effective_to is not None and self.effective_to <= self.effective_from:
            raise ValueError("effective_to 必須晚於 effective_from")
        return self


class SupplementPlanUpdateRequest(BaseModel):
    """`PATCH /api/supplement-plans/{id}` 的請求 —— 見計畫陷阱 3。

    這個端點**不修改**目標那一列的數值：它關閉舊期間、開一個新期間。
    三個欄位都可以省略（省略的欄位沿用舊列的值，`effective_date` 省略時
    預設「使用者時區的今天」），但比照 `UpdateMeRequest`（計畫 3 Task 3）
    的哨兵陷阱：**可以不帶，不接受明確的 null**——`X | None = None`
    這個型別本身無法區分「沒帶」跟「明確送 null」，兩者都要靠
    `model_fields_set` 與下面的驗證器分開處理，否則 null 會一路流到
    `setattr` 撞上資料庫的 NOT NULL，變成 500（計畫 3 Task 3 的教訓）。
    """

    dose: Decimal | None = Field(default=None, gt=0, le=1000, max_digits=8, decimal_places=2)
    time_of_day: TimeOfDay | None = None
    effective_date: date | None = None

    @model_validator(mode="after")
    def _reject_explicit_nulls(self) -> "SupplementPlanUpdateRequest":
        nulls = sorted(f for f in self.model_fields_set if getattr(self, f) is None)
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self


class SupplementPlanResponse(BaseModel):
    id: int
    supplement_id: int
    dose: Decimal
    time_of_day: TimeOfDay
    effective_from: date
    effective_to: date | None


class SupplementIntakeCreateRequest(BaseModel):
    supplement_id: int = Field(gt=0, le=_MAX_BIGINT)
    # NULL = 臨時記錄，不屬於任何固定計畫（規格第 6.4 節）。
    plan_id: int | None = Field(default=None, gt=0, le=_MAX_BIGINT)
    # 份數，跟 SupplementPlanCreateRequest.dose 同一個意思（決定 1）：
    # kcal_total = supplement.kcal * dose，在這裡（Task 8）當下算好存快照。
    dose: Decimal = Field(gt=0, le=1000, max_digits=8, decimal_places=2)
    taken_at: datetime


class SupplementIntakeResponse(BaseModel):
    id: int
    supplement_id: int
    plan_id: int | None
    dose: Decimal
    taken_at: datetime
    # 快照：這一次攝取的總量（已乘過 dose），寫入當下就固定，補劑主檔之後
    # 被改也不會連動（決定 3）。
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


class TodaySupplementItem(BaseModel):
    """`GET /api/supplements/today` 的一個項目 —— 陷阱 2：把「計畫」與
    「實際」對起來。`plan_id` 為 None 代表這是一筆臨時記錄（沒有對應的
    固定計畫），這種項目一定是 `done=True`（記錄本身就代表已經吃了）；
    `plan_id` 有值的項目才會有 `done=False` 的可能（計畫存在但今天還沒打卡）。
    """

    plan_id: int | None
    supplement_id: int
    supplement_name: str
    dose: Decimal
    time_of_day: TimeOfDay | None
    done: bool
    intake_id: int | None
