"""用 Google Gemini 估算營養素：一份（單樣）或一餐的每一樣（多樣）
（`AI_PROVIDER=gemini`）。

從 `feat/p2-gemini` 分支（P2 計畫一 b）搬來；那條分支把 Anthropic 整個換掉，
這裡改成並存。不打真的 API 測——見 `app/ai/estimator.py` 的說明；SDK 的錯誤怎麼
分類，由 `tests/test_ai_provider_errors.py` 把 client 換成接假傳輸層的版本來測。
"""

from dataclasses import dataclass

import httpx
from google import genai
from google.genai import errors, types

from app.ai.estimator import (
    ALLOWED_IMAGE_MEDIA_TYPES,
    IMAGE_ESTIMATE_INSTRUCTION,
    MAX_MEAL_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
    MEAL_IMAGE_INSTRUCTION,
    MEAL_SYSTEM_PROMPT,
    MEAL_TEXT_INSTRUCTION,
    SYSTEM_PROMPT,
    TEXT_ESTIMATE_INSTRUCTION,
    EstimatorMisconfiguredError,
    EstimatorUpstreamError,
    RawEstimate,
    RawMealEstimate,
    parse_raw_estimate,
    parse_raw_meal_estimate,
)
from app.errors import BadGatewayError, UnprocessableEntityError

# **不能直接把 `LLMEstimateSchema` 這個 pydantic model 傳給
# `response_schema`。** 計畫要求查證 `response_schema` 實際吃什麼形狀
# （P2 計畫一 b 的開工前必讀，`feat/p2-gemini` 分支），實測結果是：
# `google-genai` 2.25.0 確實接受直接傳一個
# pydantic `BaseModel` 子類別（`google.genai._transformers.t_schema()` 會
# 呼叫它的 `model_json_schema()`），**但 `LLMEstimateSchema` 的
# `Field(gt=..., decimal_places=..., max_digits=...)` 這些約束會讓
# pydantic 產生 `exclusiveMinimum` 這種 JSON Schema 關鍵字，而 Google 自己
# 的 `types.Schema`（是一個嚴格子集，不是完整 JSON Schema）不接受它**——
# 實測直接把 `LLMEstimateSchema` 傳進去，會在還沒打 API 之前就在 SDK 內部
# 因為 `types.Schema.model_validate()` 而炸 `pydantic_core.ValidationError:
# ...exclusiveMinimum ... Extra inputs are not permitted`。
#
# 所以這裡手刻一份只用 Google `Schema` 認得的關鍵字（`type` /
# `properties` / `required` / `nullable`，型別字串是大寫）的字典，
# 純粹是「提示模型輸出的形狀」，跟 `LLMEstimateSchema` 是兩件事——
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

# 多樣版：外面包一層 OBJECT，items 是既有那個 OBJECT 的 ARRAY。同樣只用 Google `Schema`
# 認得的關鍵字。**刻意不寫 minItems／maxItems**：沒有金鑰驗證不了真的 API 收不收，
# 而收不收都不影響正確性（樣數由 parse_raw_meal_estimate() 把關）；寫了卻被拒絕的話
# 是每一次估算都 400。也因此模型可以回空陣列表示「看不出任何食物」。
_MEAL_RESPONSE_SCHEMA: dict[str, object] = {
    "type": "OBJECT",
    "properties": {
        "description": {"type": "STRING"},
        "items": {"type": "ARRAY", "items": _RESPONSE_SCHEMA},
    },
    "required": ["description", "items"],
}


@dataclass(frozen=True)
class _Call:
    """一種呼叫的三個參數（同 anthropic_estimator.py 的 `_Call`）。"""

    system: str
    max_output_tokens: int
    response_schema: dict[str, object]


_SINGLE = _Call(SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, _RESPONSE_SCHEMA)
_MEAL = _Call(MEAL_SYSTEM_PROMPT, MAX_MEAL_OUTPUT_TOKENS, _MEAL_RESPONSE_SCHEMA)


def _extract_text(response: types.GenerateContentResponse) -> str:
    """`GenerateContentResponse.text` 是 `str | None`——`None` 或空字串本身
    就是一種「垃圾回應」，跟 JSON 解析失敗走同一條錯誤路徑。"""
    text = response.text
    if not text:
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")
    return text


# 金鑰錯、沒權限、模型不存在。**Gemini 的金鑰錯是 400 INVALID_ARGUMENT**
# （「API key not valid」，details 帶 `API_KEY_INVALID`），不是 401——所以 400 要看內容。
_MISCONFIGURED_STATUS_CODES = frozenset({401, 403, 404})


# `AI_MODEL` 含 `?`、`&` 或 `..` 時，google-genai 在送出之前就自己丟這個
# ValueError（`google.genai._transformers.t_model`）——模型名稱是設定，重試不會好。
# 只認這一句：其他的 ValueError 不是設定錯，照舊往外拋。
_INVALID_MODEL_MESSAGE = "invalid model parameter."


def _is_misconfiguration(error: errors.APIError) -> bool:
    """設定的問題（重試不會好）：401／403／404，或是 400 而內容指向金鑰或模型
    （`API_KEY_INVALID`、「API key not valid」、「GenerateContentRequest.model:
    unexpected model name format」）。

    其他的 400 不算：那是這次請求的內容被拒，不是設定錯。
    """
    if error.code in _MISCONFIGURED_STATUS_CODES:
        return True
    if error.code != 400:
        return False
    text = f"{error.message or ''} {error.details}".lower()
    return "api_key_invalid" in text or "api key" in text or "model" in text


def _image_contents(
    instruction: str, image: bytes, media_type: str
) -> list[types.PartUnionDict]:
    if media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
        raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")
    # `types.Part.from_bytes()` 直接吃原始 bytes，SDK 自己處理編碼。回傳型別明確標註：
    # 不然 mypy 會把 [Part, str] 推成 list[object]（list 是不變的）。
    return [types.Part.from_bytes(data=image, mime_type=media_type), instruction]


class GeminiEstimator:
    def __init__(self, *, api_key: str, model: str) -> None:
        # 非同步走 `client.aio`——`genai.Client` 是同一個物件底下切出同步／
        # 非同步兩組介面，不需要另外 import 一個 Async 版本。
        self._client = genai.Client(api_key=api_key)
        self.model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        contents = TEXT_ESTIMATE_INSTRUCTION.format(text=text)
        return parse_raw_estimate(await self._complete(contents, _SINGLE))

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        contents = _image_contents(IMAGE_ESTIMATE_INSTRUCTION, image, media_type)
        return parse_raw_estimate(await self._complete(contents, _SINGLE))

    async def estimate_meal_text(self, text: str) -> RawMealEstimate:
        contents = MEAL_TEXT_INSTRUCTION.format(text=text)
        return parse_raw_meal_estimate(await self._complete(contents, _MEAL))

    async def estimate_meal_image(self, image: bytes, media_type: str) -> RawMealEstimate:
        contents = _image_contents(MEAL_IMAGE_INSTRUCTION, image, media_type)
        return parse_raw_meal_estimate(await self._complete(contents, _MEAL))

    async def _complete(self, contents: types.ContentListUnionDict, call: _Call) -> str:
        """打一次 API，回模型說的那段文字。分類例外的地方只有這裡。"""
        config = types.GenerateContentConfig(
            system_instruction=call.system,
            max_output_tokens=call.max_output_tokens,
            response_mime_type="application/json",
            response_schema=call.response_schema,
        )
        # 只包 SDK 那一次呼叫：回應解析失敗是 AI_BAD_RESPONSE，不是上游錯誤。
        try:
            response = await self._client.aio.models.generate_content(
                model=self.model,
                contents=contents,
                config=config,
            )
        except errors.APIError as exc:
            # ClientError（4xx，含 429 RESOURCE_EXHAUSTED）與 ServerError（5xx）。
            if _is_misconfiguration(exc):
                raise EstimatorMisconfiguredError(str(exc)) from exc
            raise EstimatorUpstreamError(str(exc)) from exc
        except ValueError as exc:
            if str(exc) == _INVALID_MODEL_MESSAGE:
                raise EstimatorMisconfiguredError(str(exc)) from exc
            raise
        except httpx.TransportError as exc:
            # 連不上、逾時：google-genai 沒有包自己的例外，httpx 的直接穿出來
            # （沒裝 aiohttp 時非同步走 httpx，見 `google/genai/_api_client.py`）。
            raise EstimatorUpstreamError(str(exc) or type(exc).__name__) from exc
        return _extract_text(response)
