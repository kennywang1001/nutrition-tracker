"""用 Anthropic Claude 估算營養素：一份（單樣）或一餐的每一樣（多樣），以及營養素配餐的一餐建議
（`AI_PROVIDER=anthropic`），以及營養標示的照抄（`read_label`）。

不打真的 API 測——花錢、不可重現（P2 規格 §8.1）。SDK 的錯誤怎麼分類，由
`tests/test_ai_provider_errors.py` 把 client 換成接假傳輸層的版本來測。
"""

import base64
import logging
from dataclasses import dataclass

# 模組上的名字（不是 time.perf_counter）：測試換掉它，量出來的秒數才是固定的。
from time import perf_counter
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
    SUGGEST_SYSTEM_PROMPT,
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
    parse_raw_meal_suggestion,
    with_hint,
)
from app.ai.label import (
    LABEL_IMAGE_INSTRUCTION,
    LABEL_SYSTEM_PROMPT,
    MAX_LABEL_OUTPUT_TOKENS,
    LLMLabelSchema,
    RawLabel,
    parse_raw_label,
)
from app.ai.timing import Source, log_provider_call, outcome_of
from app.config import AiEffort
from app.errors import BadGatewayError, UnprocessableEntityError

# Anthropic 的 Base64ImageSourceParam.media_type 是一個 Literal，只接受這四種；
# ALLOWED_IMAGE_MEDIA_TYPES 驗證過之後縮成 Literal 給 mypy。
_ImageMediaType = Literal["image/jpeg", "image/png", "image/gif", "image/webp"]

logger = logging.getLogger(__name__)

# 模型自己寫完才停的那一種。其餘的（`max_tokens`：寫到上限被截斷；`refusal`：拒絕回答；
# 以及這裡不該出現的 `tool_use`、`pause_turn`、`stop_sequence`——沒給工具、沒給停止字串）
# 都值得留一行 log。
_NORMAL_STOP_REASON = "end_turn"

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
    """一種呼叫的參數：單樣與多樣只差這幾個，其餘（模型、分類例外）是同一條路。
    `kind` 只給計時的 log 用（照片說明規格 §7.1）。"""

    kind: str
    system: str
    max_tokens: int
    output_config: OutputConfigParam


_SINGLE = _Call("single", SYSTEM_PROMPT, MAX_OUTPUT_TOKENS, _OUTPUT_CONFIG)
_MEAL = _Call("meal", MEAL_SYSTEM_PROMPT, MAX_MEAL_OUTPUT_TOKENS, _MEAL_OUTPUT_CONFIG)
# 配餐：多樣的 schema 與輸出上限，換 system prompt（營養素配餐規格 D19）。
_SUGGEST = _Call("suggest", SUGGEST_SYSTEM_PROMPT, MAX_MEAL_OUTPUT_TOKENS, _MEAL_OUTPUT_CONFIG)
# 營養標示：平的 schema（掃條碼規格 D28）。寫計畫時實測 transform_schema() 對它的輸出：
# `Decimal | None` → anyOf [number, string, null]、`Literal` → enum（同 LLMEstimateSchema）。
_LABEL = _Call(
    "label",
    LABEL_SYSTEM_PROMPT,
    MAX_LABEL_OUTPUT_TOKENS,
    {"format": {"type": "json_schema", "schema": transform_schema(LLMLabelSchema)}},
)


def _with_effort(output_config: OutputConfigParam, effort: AiEffort | None) -> OutputConfigParam:
    """`AI_EFFORT` 放進 `output_config`（照片說明規格 §8.2）。沒設 → 原樣，送出去的跟以前一樣。

    另外組一份新的字典：`_Call.output_config` 是模組層級的常數、每個實例共用，寫回去的話設過
    effort 的那一次之後，沒設的也會帶著它。"""
    if effort is None:
        return output_config
    return {**output_config, "effort": effort}


def _usage_fields(message: Message) -> dict[str, object]:
    """計時那一行要的用量（名稱同 `_warn_if_abnormal`）。`output_tokens` **含**思考；
    `thinking_tokens` 是其中多少（SDK 沒給是 None）。"""
    details = message.usage.output_tokens_details
    return {
        "stop_reason": message.stop_reason,
        "input_tokens": message.usage.input_tokens,
        "output_tokens": message.usage.output_tokens,
        "thinking_tokens": details.thinking_tokens if details is not None else None,
    }


def _first_text(message: Message) -> str | None:
    for block in message.content:
        if isinstance(block, TextBlock):
            return block.text
    return None


def _extract_text(message: Message) -> str:
    """從回應裡取出第一個文字內容區塊。找不到本身就是一種「垃圾回應」，
    跟 JSON 解析失敗走同一條錯誤路徑。"""
    text = _first_text(message)
    if text is None:
        raise BadGatewayError("AI_BAD_RESPONSE", "AI 回應沒有文字內容")
    return text


def _warn_if_abnormal(message: Message, *, model: str, max_tokens: int) -> None:
    """不是正常寫完、或根本沒有字：留一行 WARNING（審查 I1）。

    這種回覆接下來會在 parse 那一步變成 `AI_BAD_RESPONSE`——畫面只說「看不懂」，而且
    算一次額度。少了這一行，「模型把思考算進輸出上限、JSON 被截斷」與「模型回了別的
    形狀」在後端完全分不出來。

    **只記原因與用量。** 提示詞、使用者輸入的字、照片、模型的輸出都不進 log：那是
    別人吃了什麼，而且模型的輸出是不可信的文字（可以帶換行偽造 log 行）。這裡用到的
    值都是供應商給的列舉字串與整數，加上我們自己的設定。
    """
    if message.stop_reason == _NORMAL_STOP_REASON and _first_text(message):
        return
    logger.warning(
        "AI 回覆不是正常結束（model=%s, stop_reason=%s, max_tokens=%d, "
        "input_tokens=%d, output_tokens=%d, has_text=%s）",
        model,
        message.stop_reason,
        max_tokens,
        message.usage.input_tokens,
        message.usage.output_tokens,
        bool(_first_text(message)),
    )


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
    訊息指向 `model`）、這個模型不收 `AI_EFFORT`（400，訊息指向 `effort` 或 `thinking`）
    ——都是設定的問題，重試不會好。

    其他的 400 不算：那是這次請求的內容被拒（例如照片太大），不是設定錯。
    """
    if isinstance(error, (AuthenticationError, PermissionDeniedError, NotFoundError)):
        return True
    if isinstance(error, BadRequestError):
        # model：模型名稱不合法。effort／thinking：這個模型不收 AI_EFFORT（照片說明規格 D16）——
        # 重試不會好，而且不該每按一次就算一次額度。
        message = _provider_message(error).lower()
        return any(word in message for word in ("model", "effort", "thinking"))
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
    def __init__(self, *, api_key: str, model: str, effort: AiEffort | None = None) -> None:
        self._client = AsyncAnthropic(api_key=api_key)
        self.model = model
        # AI_EFFORT（照片說明規格 D14）：四種呼叫都套用；None＝不送，供應商預設。
        self.effort = effort

    async def estimate_text(self, text: str) -> RawEstimate:
        message = _text_message(TEXT_ESTIMATE_INSTRUCTION, text)
        return parse_raw_estimate(await self._complete(message, _SINGLE, source="text"))

    async def estimate_image(
        self, image: bytes, media_type: str, hint: str | None = None
    ) -> RawEstimate:
        # 說明接在指示後面、同一個文字區塊（照片說明規格 D3）；沒有說明時指示原樣。
        message = _image_message(with_hint(IMAGE_ESTIMATE_INSTRUCTION, hint), image, media_type)
        return parse_raw_estimate(await self._complete(message, _SINGLE, source="image"))

    async def estimate_meal_text(self, text: str) -> RawMealEstimate:
        message = _text_message(MEAL_TEXT_INSTRUCTION, text)
        return parse_raw_meal_estimate(
            await self._complete(message, _MEAL, source="text")
        )

    async def estimate_meal_image(
        self, image: bytes, media_type: str, hint: str | None = None
    ) -> RawMealEstimate:
        message = _image_message(with_hint(MEAL_IMAGE_INSTRUCTION, hint), image, media_type)
        return parse_raw_meal_estimate(
            await self._complete(message, _MEAL, source="image")
        )

    async def suggest_meal(self, request: str) -> RawMealEstimate:
        # 訊息原樣送出：剩下的額度與偏好已經由 suggestion_request() 組好，不再套樣板。
        message: MessageParam = {"role": "user", "content": request}
        return parse_raw_meal_suggestion(
            await self._complete(message, _SUGGEST, source="text")
        )

    async def read_label(
        self, image: bytes, media_type: str, hint: str | None = None
    ) -> RawLabel:
        message = _image_message(with_hint(LABEL_IMAGE_INSTRUCTION, hint), image, media_type)
        return parse_raw_label(await self._complete(message, _LABEL, source="image"))

    async def _complete(self, message: MessageParam, call: _Call, *, source: Source) -> str:
        """打一次 API，回模型說的那段文字；前後量時間、留一行 INFO（照片說明規格 §7.1）。
        四種呼叫共用。"""
        # 兩次 perf_counter 之間只有 SDK 那一次呼叫——含 SDK 自己的重試（預設兩次），所以
        # 「被限流、退避重試」也算在這裡面。
        started = perf_counter()
        try:
            response = await self._create(message, call)
        except Exception as exc:
            # 失敗也要一行：「30 秒後逾時」跟「馬上被拒」是兩件事。沒有用量可記。
            log_provider_call(
                logger,
                kind=call.kind,
                source=source,
                model=self.model,
                effort=self.effort,
                elapsed=perf_counter() - started,
                outcome=outcome_of(exc),
            )
            raise
        log_provider_call(
            logger,
            kind=call.kind,
            source=source,
            model=self.model,
            effort=self.effort,
            elapsed=perf_counter() - started,
            outcome="ok",
            usage=_usage_fields(response),
        )
        # 在取出文字**之前**：沒有文字時下一行就丟例外了。
        _warn_if_abnormal(response, model=self.model, max_tokens=call.max_tokens)
        return _extract_text(response)

    async def _create(self, message: MessageParam, call: _Call) -> Message:
        """打一次 API。**分類例外的地方只有這裡**（從 `_complete` 拆出來，計時包在外面）。

        只包 SDK 那一次呼叫：回應解析失敗是 AI_BAD_RESPONSE（兩個 parse 函式），
        不是上游錯誤。
        """
        try:
            return await self._client.messages.create(
                model=self.model,
                max_tokens=call.max_tokens,
                system=call.system,
                messages=[message],
                output_config=_with_effort(call.output_config, self.effort),
            )
        except (APIError, CredentialsError) as exc:
            # APIError 涵蓋連線錯誤、逾時（APIConnectionError／APITimeoutError）、
            # 所有 4xx／5xx（APIStatusError），以及回應形狀不對（APIResponseValidationError）。
            if _is_misconfiguration(exc):
                raise EstimatorMisconfiguredError(str(exc)) from exc
            raise EstimatorUpstreamError(str(exc)) from exc
