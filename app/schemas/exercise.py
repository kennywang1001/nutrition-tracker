"""運動紀錄的請求與回應（運動規格 §6）。"""

from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import AwareDatetime, BaseModel, Field, model_validator

from app.exercise import ActivityCode, KcalSource
from app.schemas.validators import OptionalSingleLine


class ActivityResponse(BaseModel):
    code: ActivityCode
    label: str
    # 「其他」是 null：沒有 MET，只能手動輸入熱量。
    met: Decimal | None


class EstimateReady(BaseModel):
    """預覽（D11：跟 `EstimateMissing` 是普通聯集，不加 discriminator——同身體資料 D10）。
    `weight_kg`、`weight_date` 是估算用的那一筆體重：運動那一天（使用者時區）或之前最新的。"""

    ready: Literal[True]
    kcal: Decimal
    met: Decimal
    weight_kg: Decimal
    weight_date: date


class EstimateMissing(BaseModel):
    """運動那一天以前沒有任何體重：表單改成手動輸入（D8）。"""

    ready: Literal[False]
    missing: Literal["weight"]


class ExerciseCreateRequest(BaseModel):
    """`POST /api/exercises`。`kcal` 省略＝讓後端估算（D10）。"""

    activity: ActivityCode
    # 清成一行（控制字元、看不見的格式字元）；清完是空的＝null（D5）。
    # max_length 量的是清之前的長度（同 meals.description）：清完只會更短。
    name: OptionalSingleLine = Field(default=None, max_length=50)
    minutes: int = Field(ge=1, le=600)
    # naive 的時間是 422（同餐點）：「哪一天」要用帳號時區算，沒有時區就算不出來。
    performed_at: AwareDatetime
    # 兩位小數、1–5000（D5）；max_digits=6 剛好收得下 5000.00。
    kcal: Decimal | None = Field(default=None, ge=1, le=5000, max_digits=6, decimal_places=2)
    note: OptionalSingleLine = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _other_rules(self) -> "ExerciseCreateRequest":
        # D4：「其他」要名稱、要熱量；其他活動的名稱沒地方顯示，一律不存。
        if self.activity is ActivityCode.OTHER:
            if self.name is None:
                raise ValueError("「其他」要填名稱")
            if self.kcal is None:
                raise ValueError("「其他」沒辦法估算，要輸入熱量")
        else:
            self.name = None
        return self


class ExerciseUpdateRequest(BaseModel):
    """`PATCH /api/exercises/{id}`。不帶＝不動；`kcal: null`＝改回估算（D10）；`name`／`note`
    的 null＝清掉。`activity`、`minutes`、`performed_at` 是 NOT NULL，顯式 null 在這裡擋
    （同 `MealUpdateRequest`）。合併之後的規則（「其他」要名稱與熱量）在端點判斷——
    那要看資料庫裡原本是什麼。"""

    activity: ActivityCode | None = None
    name: OptionalSingleLine = Field(default=None, max_length=50)
    minutes: int | None = Field(default=None, ge=1, le=600)
    performed_at: AwareDatetime | None = None
    kcal: Decimal | None = Field(default=None, ge=1, le=5000, max_digits=6, decimal_places=2)
    note: OptionalSingleLine = Field(default=None, max_length=200)

    @model_validator(mode="after")
    def _reject_explicit_nulls(self) -> "ExerciseUpdateRequest":
        # name、note、kcal 的 null 有意義（清掉／改回估算），所以不在這個集合裡。
        nulls = sorted(
            field
            for field in self.model_fields_set
            if field in {"activity", "minutes", "performed_at"} and getattr(self, field) is None
        )
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self


class ExerciseResponse(BaseModel):
    id: int
    performed_at: datetime
    activity: ActivityCode
    # D20：固定活動是中文標籤，「其他」是名稱——時間線與卡片不用另外抓活動清單。
    label: str
    name: str | None
    minutes: int
    kcal: Decimal
    kcal_source: KcalSource
    note: str | None
    created_at: datetime
    updated_at: datetime


class ExerciseListResponse(BaseModel):
    """某一天（使用者時區）的運動，依時間由舊到新（D19）。`date` 是後端算的那一天——
    前端不用自己算「今天」。"""

    date: date
    total_kcal: Decimal
    entries: list[ExerciseResponse]
