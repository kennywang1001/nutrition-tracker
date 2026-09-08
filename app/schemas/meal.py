from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field, model_validator

from app.models.meal import MealType

# PostgreSQL 的 BIGINT 上限，同 app/api/params.py 的 ResourceId ——
# 但這裡是 request body 的欄位，不是路徑參數，ResourceId（Annotated[int, Path(...)]）
# 用不上，所以照抄同樣的邊界值。超過的話 asyncpg 會拋 DataError 變成未處理的 500。
_MAX_BIGINT = 2**63 - 1


class MealItemCreateRequest(BaseModel):
    # 只收 food_id，永遠不收 food_revision_id —— 見計畫陷阱 2：
    # 讓呼叫端指定版本，等於開一條繞過審核流程去讀未審核營養素的路。
    food_id: int = Field(gt=0, le=_MAX_BIGINT)
    quantity: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    portion_id: int | None = Field(default=None, gt=0, le=_MAX_BIGINT)


class MealCreateRequest(BaseModel):
    eaten_at: datetime
    meal_type: MealType
    note: str | None = Field(default=None, max_length=500)
    # 允許空清單是刻意的：P2 的流程是先拍照、之後才落項目（見計畫本文）。
    items: list[MealItemCreateRequest] = Field(default_factory=list)


class MealUpdateRequest(BaseModel):
    """`PATCH /api/meals/{id}` 的請求（計畫 3 決定 2）：只改餐點本身，
    項目的增刪走另外兩個端點（Task 12），這裡不收 `items`。

    跟 `UpdateMeRequest` 同一種哨兵寫法：三個欄位都是 `X | None = None`，
    `None` 代表「這次請求沒帶這個欄位」，路由層用
    `model_dump(exclude_unset=True)` 決定要更新哪些。

    但跟 `UpdateMeRequest` 不同的是，這裡三個欄位對 NOT NULL 的態度不一樣：
    `eaten_at` 與 `meal_type` 是 NOT NULL，顯式 `null` 必須擋在這裡 ——
    否則會一路流到 `setattr`，撞上 `asyncpg.NotNullViolationError` 變成
    已認證使用者就能觸發的 500（`UpdateMeRequest` 踩過的同一個坑）。
    `note` 是 nullable，`{"note": null}` 是合法輸入、必須放行到底。
    """

    eaten_at: datetime | None = None
    meal_type: MealType | None = None
    note: str | None = Field(default=None, max_length=500)

    @model_validator(mode="after")
    def _reject_explicit_nulls_on_non_nullable_fields(self) -> "MealUpdateRequest":
        # note 刻意不在這個集合裡：它在資料庫是 nullable，顯式 null 是
        # 合法的「清空備註」語意，不該被擋下來。
        non_nullable = {"eaten_at", "meal_type"}
        nulls = sorted(
            field
            for field in self.model_fields_set
            if field in non_nullable and getattr(self, field) is None
        )
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self


class MealItemResponse(BaseModel):
    id: int
    food_id: int
    # 顯示用：client 不用為了畫面上的食物名稱另外查一次 GET /api/foods/{id}。
    # 建立與讀取兩個端點共用同一個 response schema（計畫 3 Task 8）。
    food_name: str
    portion_id: int | None
    # quantity + portion_id 只用於顯示；quantity_g 才是所有計算的依據，
    # 寫入當下就換算好、之後永不改變（見計畫陷阱 1）。
    quantity: Decimal
    quantity_g: Decimal
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


class MealResponse(BaseModel):
    id: int
    eaten_at: datetime
    meal_type: MealType
    note: str | None
    # 相對於 photo_dir 的路徑；沒有照片是 None。計畫 3 Task 14：上傳成功後
    # 這個端點自己回的、以及之後 GET /api/meals/{id} 回的都要看得到同一個值。
    photo_path: str | None
    items: list[MealItemResponse]
    # 營養素總計：各項已四捨五入後的和，不是精確總和再四捨五入
    # （見 app/nutrition.py 的 total()）。
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
