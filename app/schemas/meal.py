from datetime import datetime
from decimal import Decimal

from pydantic import BaseModel, Field

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
    items: list[MealItemResponse]
    # 營養素總計：各項已四捨五入後的和，不是精確總和再四捨五入
    # （見 app/nutrition.py 的 total()）。
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
