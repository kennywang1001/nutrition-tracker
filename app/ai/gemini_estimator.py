"""用 Google Gemini 估算「一份」的營養素（`AI_PROVIDER=gemini`）。

從 `feat/p2-gemini` 分支（P2 計畫一 b）搬來；那條分支把 Anthropic 整個換掉，
這裡改成並存。不獨立測試——見 `app/ai/estimator.py` 的說明。
"""

from google import genai
from google.genai import types

from app.ai.estimator import (
    ALLOWED_IMAGE_MEDIA_TYPES,
    IMAGE_ESTIMATE_INSTRUCTION,
    MAX_OUTPUT_TOKENS,
    SYSTEM_PROMPT,
    TEXT_ESTIMATE_INSTRUCTION,
    RawEstimate,
    parse_raw_estimate,
)
from app.errors import BadGatewayError, UnprocessableEntityError

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


def _extract_text(response: types.GenerateContentResponse) -> str:
    """`GenerateContentResponse.text` 是 `str | None`——`None` 或空字串本身
    就是一種「垃圾回應」，跟 JSON 解析失敗走同一條錯誤路徑。"""
    text = response.text
    if not text:
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")
    return text


class GeminiEstimator:
    def __init__(self, *, api_key: str, model: str) -> None:
        # 非同步走 `client.aio`——`genai.Client` 是同一個物件底下切出同步／
        # 非同步兩組介面，不需要另外 import 一個 Async 版本。
        self._client = genai.Client(api_key=api_key)
        self.model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        return await self._estimate(TEXT_ESTIMATE_INSTRUCTION.format(text=text))

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        if media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
            raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

        # `types.Part.from_bytes()` 直接吃原始 bytes，SDK 自己處理編碼。
        image_part = types.Part.from_bytes(data=image, mime_type=media_type)
        # 明確標註型別：不然 mypy 會把 [Part, str] 推成 list[object]，跟
        # generate_content() 期待的聯集型別對不上（list 是不變的）。
        contents: list[types.PartUnionDict] = [image_part, IMAGE_ESTIMATE_INSTRUCTION]
        return await self._estimate(contents)

    async def _estimate(self, contents: types.ContentListUnionDict) -> RawEstimate:
        config = types.GenerateContentConfig(
            system_instruction=SYSTEM_PROMPT,
            max_output_tokens=MAX_OUTPUT_TOKENS,
            response_mime_type="application/json",
            response_schema=_RESPONSE_SCHEMA,
        )
        response = await self._client.aio.models.generate_content(
            model=self.model,
            contents=contents,
            config=config,
        )
        return parse_raw_estimate(_extract_text(response))
