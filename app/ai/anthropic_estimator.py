"""用 Anthropic Claude 估算營養素：一份（單樣）或一餐的每一樣（多樣）
（`AI_PROVIDER=anthropic`）。

不打真的 API 測——花錢、不可重現（P2 規格 §8.1）。SDK 的錯誤怎麼分類，由
`tests/test_ai_provider_errors.py` 把 client 換成接假傳輸層的版本來測。
"""

import base64
from dataclasses import dataclass
from typing import Literal, cast

from anthropic import (
    APIError,
    APIStatusError,
    AsyncAnthropic,
    AuthenticationError,
    BadRequestError,
    CredentialsError,
    NotFoundError,
    PermissionDeniedError,
    transform_schema,
)
from anthropic.types import (
    Base64ImageSourceParam,
    ImageBlockParam,
    Message,
    MessageParam,
    OutputConfigParam,
    TextBlock,
    TextBlockParam,
)

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
    LLMEstimateSchema,
    LLMMealEstimateSchema,
    RawEstimate,
    RawMealEstimate,
    parse_raw_estimate,
    parse_raw_meal_estimate,
)
from app.errors import BadGatewayError, UnprocessableEntityError

# Anthropic 的 Base64ImageSourceParam.media_type 是一個 Literal，只接受這四種；
# ALLOWED_IMAGE_MEDIA_TYPES 驗證過之後縮成 Literal 給 mypy。
_ImageMediaType = Literal["image/jpeg", "image/png", "image/gif", "image/webp"]

# 用 anthropic 官方提供的 transform_schema() 從 pydantic model 產生 structured
# output 要的 JSON schema。**這不是唯一的防線**——就算 API 忽略這個提示，
# parse_raw_estimate() 的 pydantic 驗證仍然會擋下任何不合規的回應。
_RESPONSE_SCHEMA: dict[str, object] = transform_schema(LLMEstimateSchema)
_OUTPUT_CONFIG: OutputConfigParam = {"format": {"type": "json_schema", "schema": _RESPONSE_SCHEMA}}

# 多樣版的 schema。實測（anthropic 1.8.0）：巢狀清單變成 `$defs`＋`$ref`；清單的上限
# （`maxItems: 8`）被 transform_schema() 移進 description（只是提示），所以「最多 8 樣」
# 同樣只靠 parse_raw_meal_estimate() 把關。
_MEAL_OUTPUT_CONFIG: OutputConfigParam = {
    "format": {"type": "json_schema", "schema": transform_schema(LLMMealEstimateSchema)}
}


@dataclass(frozen=True)
class _Call:
    """一種呼叫的三個參數：單樣與多樣只差這三個，其餘（模型、分類例外）是同一條路。"""

    system: str
    max_tokens: int
    output_config: OutputConfigParam


_SINGLE = _Call(SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, _OUTPUT_CONFIG)
_MEAL = _Call(MEAL_SYSTEM_PROMPT, MAX_MEAL_OUTPUT_TOKENS, _MEAL_OUTPUT_CONFIG)


def _extract_text(message: Message) -> str:
    """從回應裡取出第一個文字內容區塊。找不到本身就是一種「垃圾回應」，
    跟 JSON 解析失敗走同一條錯誤路徑。"""
    for block in message.content:
        if isinstance(block, TextBlock):
            return block.text
    raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")


def _provider_message(error: APIStatusError) -> str:
    """供應商在 body 裡說的那句話（`{"error": {"message": ...}}`），拿不到就用整個
    例外訊息（`Error code: 400 - {...}`）。"""
    body = error.body
    if isinstance(body, dict):
        inner = body.get("error")
        message = inner.get("message") if isinstance(inner, dict) else None
        if isinstance(message, str):
            return message
    return error.message


def _is_misconfiguration(error: APIError | CredentialsError) -> bool:
    """金鑰錯（401）、沒權限（403）、模型不存在（404）、模型名稱不合法（400，
    訊息指向 `model`）——都是設定的問題，重試不會好。

    其他的 400 不算：那是這次請求的內容被拒（例如照片太大），不是設定錯。
    """
    if isinstance(error, (AuthenticationError, PermissionDeniedError, NotFoundError)):
        return True
    if isinstance(error, BadRequestError):
        return "model" in _provider_message(error).lower()
    # 讀不到憑證（設定檔、環境變數）——跟金鑰錯是同一件事。它不是 `APIError` 的
    # 子類別（是 `AnthropicError` 底下的另一支），所以 `_complete` 要另外接。
    return isinstance(error, CredentialsError)


def _text_message(instruction: str, text: str) -> MessageParam:
    return {"role": "user", "content": instruction.format(text=text)}


def _image_message(instruction: str, image: bytes, media_type: str) -> MessageParam:
    if media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
        raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

    source: Base64ImageSourceParam = {
        "type": "base64",
        "media_type": cast(_ImageMediaType, media_type),
        "data": base64.standard_b64encode(image).decode("ascii"),
    }
    image_block: ImageBlockParam = {"type": "image", "source": source}
    text_block: TextBlockParam = {"type": "text", "text": instruction}
    return {"role": "user", "content": [image_block, text_block]}


class AnthropicEstimator:
    def __init__(self, *, api_key: str, model: str) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self.model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        message = _text_message(TEXT_ESTIMATE_INSTRUCTION, text)
        return parse_raw_estimate(await self._complete(message, _SINGLE))

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        message = _image_message(IMAGE_ESTIMATE_INSTRUCTION, image, media_type)
        return parse_raw_estimate(await self._complete(message, _SINGLE))

    async def estimate_meal_text(self, text: str) -> RawMealEstimate:
        message = _text_message(MEAL_TEXT_INSTRUCTION, text)
        return parse_raw_meal_estimate(await self._complete(message, _MEAL))

    async def estimate_meal_image(self, image: bytes, media_type: str) -> RawMealEstimate:
        message = _image_message(MEAL_IMAGE_INSTRUCTION, image, media_type)
        return parse_raw_meal_estimate(await self._complete(message, _MEAL))

    async def _complete(self, message: MessageParam, call: _Call) -> str:
        """打一次 API，回模型說的那段文字。**分類例外的地方只有這裡**——單樣與多樣共用。

        只包 SDK 那一次呼叫：回應解析失敗是 AI_BAD_RESPONSE（兩個 parse 函式），
        不是上游錯誤。
        """
        try:
            response = await self._client.messages.create(
                model=self.model,
                max_tokens=call.max_tokens,
                system=call.system,
                messages=[message],
                output_config=call.output_config,
            )
        except (APIError, CredentialsError) as exc:
            # APIError 涵蓋連線錯誤、逾時（APIConnectionError／APITimeoutError）、
            # 所有 4xx／5xx（APIStatusError），以及回應形狀不對（APIResponseValidationError）。
            if _is_misconfiguration(exc):
                raise EstimatorMisconfiguredError(str(exc)) from exc
            raise EstimatorUpstreamError(str(exc)) from exc
        return _extract_text(response)
