"""用 Anthropic Claude 估算「一份」的營養素（`AI_PROVIDER=anthropic`）。

不打真的 API 測——花錢、不可重現（P2 規格 §8.1）。SDK 的錯誤怎麼分類，由
`tests/test_ai_provider_errors.py` 把 client 換成接假傳輸層的版本來測。
"""

import base64
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
    MAX_OUTPUT_TOKENS,
    SYSTEM_PROMPT,
    TEXT_ESTIMATE_INSTRUCTION,
    EstimatorMisconfiguredError,
    EstimatorUpstreamError,
    LLMEstimateSchema,
    RawEstimate,
    parse_raw_estimate,
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
    # 子類別（是 `AnthropicError` 底下的另一支），所以 `_estimate` 要另外接。
    return isinstance(error, CredentialsError)


class AnthropicEstimator:
    def __init__(self, *, api_key: str, model: str) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self.model = model

    async def estimate_text(self, text: str) -> RawEstimate:
        message: MessageParam = {
            "role": "user",
            "content": TEXT_ESTIMATE_INSTRUCTION.format(text=text),
        }
        return await self._estimate(message)

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        if media_type not in ALLOWED_IMAGE_MEDIA_TYPES:
            raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式")

        source: Base64ImageSourceParam = {
            "type": "base64",
            "media_type": cast(_ImageMediaType, media_type),
            "data": base64.standard_b64encode(image).decode("ascii"),
        }
        image_block: ImageBlockParam = {"type": "image", "source": source}
        text_block: TextBlockParam = {"type": "text", "text": IMAGE_ESTIMATE_INSTRUCTION}
        message: MessageParam = {"role": "user", "content": [image_block, text_block]}
        return await self._estimate(message)

    async def _estimate(self, message: MessageParam) -> RawEstimate:
        # 只包 SDK 那一次呼叫：回應解析失敗是 AI_BAD_RESPONSE（parse_raw_estimate），
        # 不是上游錯誤。
        try:
            response = await self._client.messages.create(
                model=self.model,
                max_tokens=MAX_OUTPUT_TOKENS,
                system=SYSTEM_PROMPT,
                messages=[message],
                output_config=_OUTPUT_CONFIG,
            )
        except (APIError, CredentialsError) as exc:
            # APIError 涵蓋連線錯誤、逾時（APIConnectionError／APITimeoutError）、
            # 所有 4xx／5xx（APIStatusError），以及回應形狀不對（APIResponseValidationError）。
            if _is_misconfiguration(exc):
                raise EstimatorMisconfiguredError(str(exc)) from exc
            raise EstimatorUpstreamError(str(exc)) from exc
        return parse_raw_estimate(_extract_text(response))
