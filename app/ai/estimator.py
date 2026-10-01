"""LLM 估算的介面與實作。

**Protocol 不是為了「將來換供應商」寫的，是為了測試能斷言它沒被呼叫。**

規格 §8.3：「搜得到就不呼叫 LLM」這條保證，如果測試只斷言「回傳的營養素
等於食物庫裡那筆」，那麼一個**先呼叫 LLM、再用食物庫的值覆蓋**的實作
也會全綠 —— 而它每次都在花錢。必須斷言的是「那個方法被呼叫了 0 次」，
而那需要一個可以注入的假實作（Task 5：`app.dependency_overrides[get_estimator]`）。

**P2 計畫一 b（2026-09-27）把這裡的實作從 Anthropic 換成 Gemini。** 556 則
測試裡只有這個模組自己的測試受影響——`app/api/routes/ai.py`、
`tests/test_ai_analyze.py`、`tests/test_ai_consistency.py` 都注入假實作或
只碰純函式，一行都沒改，證明了上面那句話：Protocol 是為了測試斷言存在的，
「將來換供應商」只是它的副作用。

## 這個模組不獨立測試 Gemini 實作本身

打真的網路：慢、花錢、不可重現（規格 §8.1）。Task 5 用一個假的
`NutritionEstimator` 注入到 FastAPI 依賴裡，間接驗證整條路徑接得起來。

**但 `parse_raw_estimate()` 是純函式**（不碰網路、不碰資料庫），拆出來單獨測，
見 `tests/test_ai_estimator.py`。它就是規格 §8.2「LLM 回傳垃圾不能讓畫面
炸掉」那條保證實際落地的地方。
"""

import json
import logging
from dataclasses import dataclass
from decimal import Decimal
from typing import Protocol

from google import genai
from google.genai import types
from pydantic import BaseModel, Field, ValidationError

from app.errors import BadGatewayError, UnprocessableEntityError

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


# `types.Part.from_bytes(data=..., mime_type=...)` 的 mime_type 只是 `str`，
# 不像 Anthropic 的 Base64ImageSourceParam.media_type 是一個四選一的
# Literal——但驗證仍然要做：Protocol 的 estimate_image() 刻意收 `str`
# （呼叫端——app/api/routes/ai.py——用既有的照片驗證慣例，也就是 Pillow
# 實際解碼後判斷格式，不是信任 client 宣告的 Content-Type），這裡是打 API
# 之前的第二道防禦性關卡，擋掉理論上不該出現、但也沒有理由假設不會出現的
# 格式。
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


# **不能直接把 `_LLMEstimateSchema` 這個 pydantic model 傳給
# `response_schema`。** 計畫要求查證 `response_schema` 實際吃什麼形狀
# （見開工前必讀），實測結果是：`google-genai` 2.25.0 確實接受直接傳一個
# pydantic `BaseModel` 子類別（`google.genai._transformers.t_schema()` 會
# 呼叫它的 `model_json_schema()`），**但 `_LLMEstimateSchema` 的
# `Field(gt=..., decimal_places=..., max_digits=...)` 這些約束會讓
# pydantic 產生 `exclusiveMinimum` 這種 JSON Schema 關鍵字，而 Google 自己
# 的 `types.Schema`（是一個嚴格子集，不是完整 JSON Schema）不接受它**——
# 實測直接把 `_LLMEstimateSchema` 傳進去，會在還沒打 API 之前就在 SDK 內部
# 因為 `types.Schema.model_validate()` 而炸 `pydantic_core.ValidationError:
# ...exclusiveMinimum ... Extra inputs are not permitted`。
#
# 所以這裡手刻一份只用 Google `Schema` 認得的關鍵字（`type` /
# `properties` / `required` / `nullable`，型別字串是大寫）的字典，
# 純粹是「提示模型輸出的形狀」，跟 `_LLMEstimateSchema` 是兩件事——
# **真正的數值範圍驗證（`gt=0`、`le=10000` 那些）仍然只由
# `parse_raw_estimate()` 事後做一次**，不會因為這裡少了約束就變寬鬆。
# 這不是唯一的防線 —— 就算 API 忽略這個提示，`parse_raw_estimate()` 的
# pydantic 驗證仍然會擋下任何不合規的回應。
_RESPONSE_SCHEMA: dict[str, object] = {
    "type": "OBJECT",
    "properties": {
        "name": {"type": "STRING"},
        "brand": {"type": "STRING", "nullable": True},
        "serving_grams": {"type": "NUMBER"},
        "serving_kcal": {"type": "NUMBER"},
        "serving_protein_g": {"type": "NUMBER"},
        "serving_fat_g": {"type": "NUMBER"},
        "serving_carb_g": {"type": "NUMBER"},
        "confidence": {"type": "NUMBER"},
    },
    "required": [
        "name",
        "brand",
        "serving_grams",
        "serving_kcal",
        "serving_protein_g",
        "serving_fat_g",
        "serving_carb_g",
        "confidence",
    ],
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
        raise BadGatewayError(
            "AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON"
        ) from exc

    if not isinstance(parsed_json, dict):
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回傳的 JSON 不是一個物件")

    try:
        validated = _LLMEstimateSchema.model_validate(parsed_json)
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


def _extract_text(response: types.GenerateContentResponse) -> str:
    """從回應裡取出文字內容。

    `GenerateContentResponse.text` 是 `str | None`（inspect 過，見開工前
    必讀）——`None` 或空字串本身就是一種「垃圾回應」，跟 JSON 解析失敗
    走同一條錯誤路徑（`response.text` 不像 Anthropic 的 `message.content`
    是一串要自己找 TextBlock 的區塊，SDK 已經幫忙串好了）。
    """
    text = response.text
    if not text:
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")
    return text


class GeminiEstimator:
    """用 Google Gemini 估算「一份」的營養素。

    這個類別本身沒有獨立測試 —— 打真的 API 會花錢、不可重現（規格 §8.1）。
    `NutritionEstimator` Protocol 的存在就是為了讓測試能用假實作取代它，
    然後斷言「這個類別的方法被呼叫了幾次」。
    """

    def __init__(self, *, api_key: str, model: str) -> None:
        # 非同步走 `client.aio`（inspect 過，見開工前必讀）——`AsyncAnthropic`
        # 是一個獨立的類別，`genai.Client` 是同一個物件底下切出同步／非同步
        # 兩組介面，不需要另外 import 一個 Async 版本。
        self._client = genai.Client(api_key=api_key)
        self._model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        return await self._estimate(_TEXT_ESTIMATE_INSTRUCTION.format(text=text))

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        if media_type not in _ALLOWED_IMAGE_MEDIA_TYPES:
            # app/api/routes/ai.py 在呼叫這裡之前應該已經用 Pillow 實際解碼過
            # 圖片、確認過格式（跟 app/storage/photos.py 同一個「不信任宣告」
            # 的原則）。這裡是第二道關卡，理論上不會踩到。
            raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

        # `types.Part.from_bytes()` 直接吃原始 bytes，SDK 自己處理編碼——
        # 比 Anthropic 版本少一步手動 base64 編碼（開工前必讀「比 Anthropic
        # 那版簡單的三處」）。
        image_part = types.Part.from_bytes(data=image, mime_type=media_type)
        # 明確標註型別：不然 mypy 會把 [Part, str] 這個字面 list 推成
        # list[object]，跟 generate_content() 期待的聯集型別對不上。
        # `PartUnionDict` 是 SDK 自己匯出的別名，跟 `contents` 參數型別裡
        # 那個 list 分支的元素型別一模一樣（list 是不變的，型別要精準對齊，
        # 不能只是「相容」）。
        contents: list[types.PartUnionDict] = [image_part, _IMAGE_ESTIMATE_INSTRUCTION]
        return await self._estimate(contents)

    async def _estimate(self, contents: types.ContentListUnionDict) -> RawEstimate:
        config = types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            max_output_tokens=_MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
            response_schema=_RESPONSE_SCHEMA,
        )
        response = await self._client.aio.models.generate_content(
            model=self._model,
            contents=contents,
            config=config,
        )
        return parse_raw_estimate(_extract_text(response))
