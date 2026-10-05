"""LLM 估算的介面與實作。

**Protocol 不是為了「將來換供應商」寫的，是為了測試能斷言它沒被呼叫。**

規格 §8.3：「搜得到就不呼叫 LLM」這條保證，如果測試只斷言「回傳的營養素
等於食物庫裡那筆」，那麼一個**先呼叫 LLM、再用食物庫的值覆蓋**的實作
也會全綠 —— 而它每次都在花錢。必須斷言的是「那個方法被呼叫了 0 次」，
而那需要一個可以注入的假實作（Task 5：`app.dependency_overrides[get_estimator_factory]`）。

## 兩家實作各一個檔案

`app/ai/anthropic_estimator.py` 與 `app/ai/gemini_estimator.py`，用哪一家由
`AI_PROVIDER` 決定（`app/api/deps.py` 的 `build_estimator`）。這個檔案只放兩家
共用的：Protocol、`RawEstimate`、提示詞、回覆的形狀與 `parse_raw_estimate()`。

兩家實作都不獨立測試——打真的網路：慢、花錢、不可重現（P2 規格 §8.1）。路由的
測試注入假實作，間接驗證整條路徑接得起來。

**但 `parse_raw_estimate()` 是純函式**（不碰網路、不碰資料庫），拆出來單獨測，
見 `tests/test_ai_estimator.py`。它就是規格 §8.2「LLM 回傳垃圾不能讓畫面
炸掉」那條保證實際落地的地方。
"""

import json
import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from pydantic import BaseModel, Field, ValidationError

from app.errors import BadGatewayError

logger = logging.getLogger(__name__)


@dataclass(frozen=True)
class RawEstimate:
    """LLM 對「一份」的估算。

    **這是「一份」的值，不是每 100g。** 換算成 `NutritionInput` 要的
    每 100g 由 `app/api/routes/ai.py` 做一次，前端不重算（規格 §4.1）。
    """

    name: str
    brand: str | None
    serving_grams: Decimal
    # **欄位名帶 serving_ 前綴是刻意的。**
    #
    # `AnalyzedNutrition`（Task 5）有一組叫 `kcal` / `protein_g` / … 的欄位，
    # 而那組是**每 100g**。如果這裡也叫 `kcal`，兩個意義完全不同的東西
    # 就會共用同一個名字，而它們會在同一個檔案裡被同時操作（換算那一段）。
    #
    # 那正是這個專案反覆踩到的形狀：兩處講「同一個」東西，其實不是同一個。
    serving_kcal: Decimal
    serving_protein_g: Decimal
    serving_fat_g: Decimal
    serving_carb_g: Decimal
    confidence: Decimal
    raw: dict[str, object]


class NutritionEstimator(Protocol):
    # 實際用的模型名稱——ai_analyses.model 記的是它（AI 估算前端計畫 Task 1），
    # 之後才問得出「哪個模型的估算常被改」。
    model: str

    async def estimate_text(self, text: str) -> RawEstimate: ...
    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate: ...


# 兩家實作打 API 之前的第二道關卡：路由已經用 Pillow 實際解碼判斷過格式
# （`app/api/routes/ai.py` 的 `_decode_photo`），這裡擋掉理論上不該出現、但也沒有
# 理由假設不會出現的格式。
ALLOWED_IMAGE_MEDIA_TYPES: frozenset[str] = frozenset(
    {"image/jpeg", "image/png", "image/gif", "image/webp"}
)

# 一份估算的 JSON 很短（8 個欄位），這個上限只是防止模型跑題輸出一大段文字
# 還是被硬截斷在 JSON 中間，那種半成品一樣會在 parse_raw_estimate() 被擋下來，
# 但不需要讓它有機會輸出到幾千 token 才被擋。
MAX_OUTPUT_TOKENS = 1024

# 四個硬要求（計畫 Task 4）：
# 1. 回 JSON，欄位名跟 RawEstimate 對齊（含 serving_ 前綴）
# 2. 估「一份」是幾克 —— serving_grams，沒有它就換算不了
# 3. 只回一樣食物 —— 規格 §9，這一版不做多食物辨識
# 4. 不要求它自己檢查 Atwater —— 那是 app/ai/consistency.py 的工作，
#    那一層的價值就在於它不是 LLM 說的
SYSTEM_PROMPT = """你是一個幫忙記錄飲食的營養分析助手。你的任務是估算「一份」\
食物的營養素，讓使用者可以快速記錄一餐。

你會收到一段文字描述，或一張食物照片。不管哪一種，你都只回傳一個 JSON 物件，
不要加任何說明文字、不要用 ```json 這種 code fence 包起來，就只有那個 JSON。

JSON 物件要包含這些欄位：

- "name"：食物名稱（字串），例如 "滷肉飯"
- "brand"：品牌名稱（字串），看不出品牌就填 null
- "serving_grams"：你估計「一份」大約是幾克（數字）—— 這是換算成每 100 克
  營養素的依據，務必給出你的估計，不要省略
- "serving_kcal"：這一份的熱量，單位大卡（數字）
- "serving_protein_g"：這一份的蛋白質克數（數字）
- "serving_fat_g"：這一份的脂肪克數（數字）
- "serving_carb_g"：這一份的碳水化合物克數（數字）
- "confidence"：你對這個估算的信心程度，0 到 1 之間的數字，1 代表非常確定

如果文字或照片裡看得出不只一種食物（例如一張照片裡有飯、有肉、還有燙青菜），
只挑其中份量最主要的那一種來估算，回傳一筆結果就好 —— 不要回傳陣列，
也不要把好幾樣食物混在一起加總。

只要盡力給出你的估計值，不需要自己檢查熱量與蛋白質、脂肪、碳水化合物三者
是否算得起來 —— 那件事會由後端另外的程式檢查，不是你的工作。

範例輸出（純示意，不代表任何真實食物的正確答案）：
{"name": "滷肉飯", "brand": null, "serving_grams": 250, "serving_kcal": 480, \
"serving_protein_g": 14, "serving_fat_g": 18, "serving_carb_g": 62, "confidence": 0.7}
"""

TEXT_ESTIMATE_INSTRUCTION = "請估算以下食物的營養素，只回傳前面說明的那個 JSON 物件：\n\n{text}"
IMAGE_ESTIMATE_INSTRUCTION = "請估算這張照片裡那份食物的營養素，只回傳前面說明的那個 JSON 物件。"


class LLMEstimateSchema(BaseModel):
    """驗證 LLM 回傳 JSON 的形狀。

    規格 §8.2：「缺欄位、負數、超出範圍、不是 JSON」都要被擋下來——
    這個 model 就是那道防線，`parse_raw_estimate()` 用它來驗證。

    數值上限刻意採用跟 `app/schemas/food.py`（`NutritionInput`、
    `PortionCreateRequest`）同一種風格：「生理上不可能的值」，
    不是營養學上的斷言。
    """

    name: str = Field(min_length=1, max_length=200)
    brand: str | None
    serving_grams: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    serving_kcal: Decimal = Field(ge=0, le=100000, max_digits=8, decimal_places=2)
    serving_protein_g: Decimal = Field(ge=0, le=10000, max_digits=8, decimal_places=2)
    serving_fat_g: Decimal = Field(ge=0, le=10000, max_digits=8, decimal_places=2)
    serving_carb_g: Decimal = Field(ge=0, le=10000, max_digits=8, decimal_places=2)
    confidence: Decimal = Field(ge=0, le=1, decimal_places=2)


def parse_raw_estimate(response_text: str) -> RawEstimate:
    """把 LLM 回覆的文字解析成 `RawEstimate`，解析失敗拋 `AI_BAD_RESPONSE`。

    純函式、不碰網路 —— 這是這個模組裡真正可以獨立測試的部分。
    餵它任何字串，不需要打 API。

    **`raw` 存的是 `json.loads` 解出來的原始字典**，不是驗證過、型別轉換過的
    `LLMEstimateSchema` 物件 —— 規格 §5：「AI 常常錯很多嗎」要靠它回答，
    存下驗證後的版本會讓這個欄位失去「LLM 原始說了什麼」這個意義。
    """
    try:
        parsed_json = json.loads(response_text)
    except json.JSONDecodeError as exc:
        raise BadGatewayError(
            "AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON"
        ) from exc

    if not isinstance(parsed_json, dict):
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回傳的 JSON 不是一個物件")

    try:
        validated = LLMEstimateSchema.model_validate(parsed_json)
    except ValidationError as exc:
        raise BadGatewayError(
            "AI_BAD_RESPONSE", "AI 回傳的內容缺欄位、型別錯誤，或數值超出範圍"
        ) from exc

    return RawEstimate(
        name=validated.name,
        brand=validated.brand,
        serving_grams=validated.serving_grams,
        serving_kcal=validated.serving_kcal,
        serving_protein_g=validated.serving_protein_g,
        serving_fat_g=validated.serving_fat_g,
        serving_carb_g=validated.serving_carb_g,
        confidence=validated.confidence,
        raw=parsed_json,
    )
