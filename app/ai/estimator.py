"""LLM 估算的介面與實作。

**Protocol 不是為了「將來換供應商」寫的，是為了測試能斷言它沒被呼叫。**

規格 §8.3：「搜得到就不呼叫 LLM」這條保證，如果測試只斷言「回傳的營養素
等於食物庫裡那筆」，那麼一個**先呼叫 LLM、再用食物庫的值覆蓋**的實作
也會全綠 —— 而它每次都在花錢。必須斷言的是「那個方法被呼叫了 0 次」，
而那需要一個可以注入的假實作（Task 5：`app.dependency_overrides[get_estimator]`）。

## 這個模組不獨立測試 Anthropic 實作本身

打真的網路：慢、花錢、不可重現（規格 §8.1）。Task 5 用一個假的
`NutritionEstimator` 注入到 FastAPI 依賴裡，間接驗證整條路徑接得起來。

**但 `parse_raw_estimate()` 是純函式**（不碰網路、不碰資料庫），拆出來單獨測，
見 `tests/test_ai_estimator.py`。它就是規格 §8.2「LLM 回傳垃圾不能讓畫面
炸掉」那條保證實際落地的地方。
"""

import base64
import json
import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol, cast

from anthropic import AsyncAnthropic, transform_schema
from anthropic.types import (
    Base64ImageSourceParam,
    ImageBlockParam,
    Message,
    MessageParam,
    OutputConfigParam,
    TextBlock,
    TextBlockParam,
)
from pydantic import BaseModel, Field, ValidationError

from app.errors import UnprocessableEntityError

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
    async def estimate_text(self, text: str) -> RawEstimate: ...
    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate: ...


# Anthropic 的 Base64ImageSourceParam.media_type 是一個 Literal，只接受這四種。
# Protocol 的 estimate_image() 刻意收 `str`（呼叫端——Task 5 的路由——用既有的
# 照片驗證慣例，也就是 Pillow 實際解碼後判斷格式，不是信任 client 宣告的
# Content-Type），所以這裡要在打 API 之前重新驗證一次、縮成 Literal 給
# mypy，也是防禦性的第二道關卡。
_ImageMediaType = Literal["image/jpeg", "image/png", "image/gif", "image/webp"]
_ALLOWED_IMAGE_MEDIA_TYPES: frozenset[str] = frozenset(
    {"image/jpeg", "image/png", "image/gif", "image/webp"}
)

# 一份估算的 JSON 很短（8 個欄位），這個上限只是防止模型跑題輸出一大段文字
# 還是被硬截斷在 JSON 中間，那種半成品一樣會在 parse_raw_estimate() 被擋下來，
# 但不需要讓它有機會輸出到幾千 token 才被擋。
_MAX_OUTPUT_TOKENS = 1024

# 四個硬要求（計畫 Task 4）：
# 1. 回 JSON，欄位名跟 RawEstimate 對齊（含 serving_ 前綴）
# 2. 估「一份」是幾克 —— serving_grams，沒有它就換算不了
# 3. 只回一樣食物 —— 規格 §9，這一版不做多食物辨識
# 4. 不要求它自己檢查 Atwater —— 那是 app/ai/consistency.py 的工作，
#    那一層的價值就在於它不是 LLM 說的
_SYSTEM_PROMPT = """你是一個幫忙記錄飲食的營養分析助手。你的任務是估算「一份」\
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

_TEXT_ESTIMATE_INSTRUCTION = "請估算以下食物的營養素，只回傳前面說明的那個 JSON 物件：\n\n{text}"
_IMAGE_ESTIMATE_INSTRUCTION = "請估算這張照片裡那份食物的營養素，只回傳前面說明的那個 JSON 物件。"


class _LLMEstimateSchema(BaseModel):
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


# 用 anthropic 官方提供的 transform_schema() 從上面的 pydantic model 產生
# structured output 要的 JSON schema，請模型直接照這個形狀輸出（`anthropic`
# 套件的實際 API 形狀是讀 .venv 裡的原始碼確認的，見開工前必讀）。
# **這不是唯一的防線** —— 就算 API 忽略這個提示，parse_raw_estimate() 的
# pydantic 驗證仍然會擋下任何不合規的回應。
_RESPONSE_SCHEMA: dict[str, object] = transform_schema(_LLMEstimateSchema)
_OUTPUT_CONFIG: OutputConfigParam = {
    "format": {"type": "json_schema", "schema": _RESPONSE_SCHEMA}
}


def parse_raw_estimate(response_text: str) -> RawEstimate:
    """把 LLM 回覆的文字解析成 `RawEstimate`，解析失敗拋 `AI_BAD_RESPONSE`。

    純函式、不碰網路 —— 這是這個模組裡真正可以獨立測試的部分。
    餵它任何字串，不需要打 API。

    **`raw` 存的是 `json.loads` 解出來的原始字典**，不是驗證過、型別轉換過的
    `_LLMEstimateSchema` 物件 —— 規格 §5：「AI 常常錯很多嗎」要靠它回答，
    存下驗證後的版本會讓這個欄位失去「LLM 原始說了什麼」這個意義。
    """
    try:
        parsed_json = json.loads(response_text)
    except json.JSONDecodeError as exc:
        raise UnprocessableEntityError(
            "AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON"
        ) from exc

    if not isinstance(parsed_json, dict):
        raise UnprocessableEntityError("AI_BAD_RESPONSE", "AI 回傳的 JSON 不是一個物件")

    try:
        validated = _LLMEstimateSchema.model_validate(parsed_json)
    except ValidationError as exc:
        raise UnprocessableEntityError(
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


def _extract_text(message: Message) -> str:
    """從回應裡取出第一個文字內容區塊。

    正常情況下（沒有開 extended thinking、沒有用 tool）content 就是一個
    TextBlock。找不到文字區塊本身就是一種「垃圾回應」，跟 JSON 解析失敗
    走同一條錯誤路徑。
    """
    for block in message.content:
        if isinstance(block, TextBlock):
            return block.text
    raise UnprocessableEntityError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")


class AnthropicEstimator:
    """用 Anthropic Claude 估算「一份」的營養素。

    這個類別本身沒有獨立測試 —— 打真的 API 會花錢、不可重現（規格 §8.1）。
    `NutritionEstimator` Protocol 的存在就是為了讓 Task 5 能用假實作取代它，
    然後斷言「這個類別的方法被呼叫了幾次」。
    """

    def __init__(self, *, api_key: str, model: str) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self._model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        message: MessageParam = {
            "role": "user",
            "content": _TEXT_ESTIMATE_INSTRUCTION.format(text=text),
        }
        return await self._estimate(message)

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        if media_type not in _ALLOWED_IMAGE_MEDIA_TYPES:
            # Task 5 的路由在呼叫這裡之前應該已經用 Pillow 實際解碼過圖片、
            # 確認過格式（跟 app/storage/photos.py 同一個「不信任宣告」的
            # 原則）。這裡是第二道關卡，理論上不會踩到。
            raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

        source: Base64ImageSourceParam = {
            "type": "base64",
            "media_type": cast(_ImageMediaType, media_type),
            "data": base64.standard_b64encode(image).decode("ascii"),
        }
        image_block: ImageBlockParam = {"type": "image", "source": source}
        text_block: TextBlockParam = {"type": "text", "text": _IMAGE_ESTIMATE_INSTRUCTION}
        message: MessageParam = {"role": "user", "content": [image_block, text_block]}
        return await self._estimate(message)

    async def _estimate(self, message: MessageParam) -> RawEstimate:
        response = await self._client.messages.create(
            model=self._model,
            max_tokens=_MAX_OUTPUT_TOKENS,
            system=_SYSTEM_PROMPT,
            messages=[message],
            output_config=_OUTPUT_CONFIG,
        )
        response_text = _extract_text(response)
        return parse_raw_estimate(response_text)
