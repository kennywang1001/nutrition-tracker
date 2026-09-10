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


class TargetUpdateRequest(BaseModel):
    """`PATCH /api/targets/{id}` 的請求 —— 決定 1：跟計畫 4a 的
    `supplement_plans` 同構，這不是原地修改，是「關閉舊期間、開新期間」。

    但這個端點的 NULL 合法性矩陣跟 `SupplementPlanUpdateRequest` 不同：
    那邊的 `dose` / `time_of_day` 都是 NOT NULL，顯式 null 一律拒絕。這裡
    四個營養素跟 `label` 在資料庫都允許 NULL（陷阱 3：規格第 6.5 節），
    所以「顯式送 null」是合法輸入，語意是「清除這個欄位」——
    跟 `MealUpdateRequest` 的 `note` 是同一種取捨，只是這裡有五個欄位而不是一個。

    `effective_from` 對應資料庫的 NOT NULL 欄位：可以省略（省略時預設「使用者
    時區的今天」，用 `today_in_timezone`，同 `supplement_plans` 的
    `effective_date`），但不接受顯式 `null`——那會一路流到 `setattr` 撞上
    NOT NULL（計畫 3 Task 3 的哨兵教訓，`_reject_explicit_null_on_non_nullable`
    這個名字跟 `MealUpdateRequest` 的驗證器同一個精神）。

    `effective_to` 對應資料庫可為 NULL 的欄位：省略與顯式 `null` 都合法、
    效果也相同——都代表新開的這個期間是開放式的、沒有結束日。
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
    label: str | None = Field(default=None, max_length=100)
    effective_from: date | None = None
    effective_to: date | None = None

    @model_validator(mode="after")
    def _reject_explicit_null_on_non_nullable(self) -> "TargetUpdateRequest":
        # effective_from 刻意不在 model 欄位型別上就寫死成必填：省略要能落到
        # 「預設今天」這條路由層邏輯，型別上就得是 `date | None`。哨兵留給
        # 型別，語意由這個驗證器把關——跟 MealUpdateRequest 對 eaten_at /
        # meal_type 的處理是同一招。
        non_nullable = {"effective_from"}
        nulls = sorted(
            field
            for field in self.model_fields_set
            if field in non_nullable and getattr(self, field) is None
        )
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self

    @model_validator(mode="after")
    def _validate_explicit_effective_range(self) -> "TargetUpdateRequest":
        # 只擋「兩個都有明確送」的情況：effective_from 省略時的預設值
        # （使用者時區的今天）要到路由層才算得出來，這裡還看不到，路由層會
        # 再檢查一次（跟 EFFECTIVE_DATE_TOO_EARLY 那個檢查同一個函式裡）。
        if (
            self.effective_from is not None
            and self.effective_to is not None
            and self.effective_to <= self.effective_from
        ):
            raise ValueError("effective_to 必須晚於 effective_from")
        return self
