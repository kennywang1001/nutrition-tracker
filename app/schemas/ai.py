from decimal import Decimal
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.models.food import BaseUnit


class AnalyzeTextRequest(BaseModel):
    kind: Literal["text"] = "text"
    # 這是一段描述（規格 §4.1 範例：「一碗滷肉飯」），不是搜尋關鍵字——
    # 上限給得寬鬆，純粹防呆，不是想限制使用者怎麼描述。
    text: str = Field(min_length=1, max_length=2000)


class AnalyzeImageRequest(BaseModel):
    kind: Literal["image"] = "image"
    image_base64: str = Field(min_length=1)


# `kind` 是判別欄位。兩個入口（規格 §1.2 使用者原話：「兩個」）在 schema
# 層就是兩種不同形狀的 request，不是同一個 model 靠 Optional 欄位兼兩種用途。
AnalyzeRequest = Annotated[
    AnalyzeTextRequest | AnalyzeImageRequest, Field(discriminator="kind")
]


class AnalyzedNutrition(BaseModel):
    """AI 估算的營養素，**同時**帶每 100g 與一份的值，兩者都由後端算。

    `kcal` / `protein_g` / `fat_g` / `carb_g` 是每 100g/ml —— 直接餵得進
    `FoodCreateRequest.nutrition`（計畫 Task 6，不在這個 task 的範圍）。
    `serving_*` 是一份的值，給人看的。

    **兩組數字的一致性由 `app/api/routes/ai.py` 的算法保證，不是巧合**：
    `serving_kcal` 是從已經四捨五入過的 `kcal`（每 100g）反推回去的
    （`kcal × serving_grams / 100`，再四捨五入），不是 LLM 原始說的
    `serving_kcal` 直接填進來——否則兩個各自獨立四捨五入的數字會漂移，
    而使用者會同時看到兩個不一致的「一份熱量」。
    """

    base_unit: BaseUnit
    serving_grams: Decimal
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    serving_kcal: Decimal
    serving_protein_g: Decimal
    serving_fat_g: Decimal
    serving_carb_g: Decimal


class ConsistencyResult(BaseModel):
    """`app.ai.consistency.Consistency`（frozen dataclass）的 API 形狀。

    `from_attributes=True`：直接 `model_validate()` 那個 dataclass 實體，
    不用手動一個個欄位複製。
    """

    model_config = ConfigDict(from_attributes=True)

    atwater_kcal: Decimal
    deviation: Decimal
    flagged: bool


class AnalyzeResponse(BaseModel):
    # 走①食物庫短路命中時是 None——那一次沒有呼叫 LLM，也沒有寫
    # ai_analyses（規格 §3：「不計入每日上限」），沒有列可以參照。
    analysis_id: int | None
    name: str
    brand: str | None
    nutrition: AnalyzedNutrition
    # ⚠️ 這是 LLM 自陳的信心值，不是量出來的（規格 §4.1）——不可以被當成
    # 可靠度顯示給使用者，畫面上該顯示的是 consistency。
    confidence: Decimal
    consistency: ConsistencyResult
