"""`POST /api/foods/parse-label-text`（標示 OCR 規格 §5）。

放在自己的檔案：要同時用 `food.py` 的 `NutritionResponse`／`ServingSize` 與 `ai.py` 的
`ConsistencyResult`，放進任一邊都會循環 import。
"""

from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

from app.models.food import BaseUnit
from app.schemas.ai import ConsistencyResult
from app.schemas.food import NutritionResponse, ServingSize

LABEL_TEXT_MAX_LENGTH = 4000


class LabelTextRequest(BaseModel):
    # 手機辨識（Tesseract.js）出來的字，或使用者貼上的。不存、不寫 log（規格 D7）。
    text: str = Field(min_length=1, max_length=LABEL_TEXT_MAX_LENGTH)


class LabelTextFound(BaseModel):
    """讀到的每 100（g 或 ml，看 `base_unit`）；讀不到的是 null。"""

    kcal: Decimal | None
    protein_g: Decimal | None
    fat_g: Decimal | None
    carb_g: Decimal | None


class LabelTextParseResponse(BaseModel):
    """營養標示的文字讀出來的東西。**讀不完整也是 200**（`complete: false`）：`found` 是讀到的、
    `missing` 是缺的、`reason` 是為什麼。`nutrition` 只在完整時有（每 100，直接餵得進
    `FoodCreateRequest.nutrition`）。確定性的規則：不呼叫 AI、不算額度、不寫 `ai_analyses`。"""

    complete: bool
    base_unit: BaseUnit
    nutrition: NutritionResponse | None
    found: LabelTextFound
    missing: list[Literal["kcal", "protein_g", "fat_g", "carb_g"]]
    reason: (
        Literal[
            "no_values", "columns_unknown", "needs_serving_size", "implausible", "missing_fields"
        ]
        | None
    )
    # 包裝上的一份；單位跟 base_unit 不一樣、或讀不到是 null。
    serving: ServingSize | None
    servings_per_package: Decimal | None
    # 用的是哪一欄；不完整時是 null。
    basis: Literal["per_100", "per_serving"] | None
    # 只在完整時有（同 read-label，只標記、不擋）。
    consistency: ConsistencyResult | None
