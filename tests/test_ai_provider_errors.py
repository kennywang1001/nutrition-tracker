"""供應商的 SDK 丟錯時怎麼分類（AI 與編輯畫面的收尾規格 §2 第 2 項）。

- **設定錯誤**（認證、權限、找不到模型、模型名稱不合法的 400；Gemini 的 SDK 在送出之前
  就擋下的模型名稱）→ estimator 拋
  `EstimatorMisconfiguredError` → 路由回 `503 AI_MISCONFIGURED`，**不記一列、不算額度**。
- **上游錯誤**（連線、逾時、5xx、限流、其他 API 錯誤）→ `EstimatorUpstreamError`
  → `502 AI_UPSTREAM_ERROR`，**照舊記一列失敗**。

**假的是傳輸層，不是 SDK。** 兩家的 client 都換成接 `MockTransport` 的 HTTP client，
例外由 SDK 自己從那個 HTTP 回應（或傳輸層例外）建出來——所以測到的是「SDK 實際會丟
什麼」，不是「我以為它會丟什麼」。Anthropic 的 SDK 用 `httpx2`，Gemini 的用 `httpx`。

**每個測試都斷言假的供應商真的收到了請求（`upstream.requests`）。** 少了這一行，
假的傳輸層沒接上時 SDK 會打到真的網路、拿假金鑰換到一個真的 401——「設定錯誤」那幾條
照樣全綠，綠的理由卻完全不是這裡的程式碼（handover §6 規矩 8：紅燈／綠燈要問為什麼）。
"""

import json
import logging
from collections.abc import Callable
from typing import Any

import anthropic
import httpx
import httpx2
import pytest
from anthropic import AsyncAnthropic
from google import genai
from google.genai import errors as genai_errors
from google.genai import types
from sqlalchemy import select

from app.ai.anthropic_estimator import AnthropicEstimator
from app.ai.estimator import (
    MAX_MEAL_OUTPUT_TOKENS,
    MAX_OUTPUT_TOKENS,
    MEAL_IMAGE_INSTRUCTION,
    MEAL_SYSTEM_PROMPT,
    MEAL_TEXT_INSTRUCTION,
    SYSTEM_PROMPT,
    EstimatorMisconfiguredError,
    EstimatorUpstreamError,
    NutritionEstimator,
)
from app.ai.gemini_estimator import GeminiEstimator
from app.api.deps import get_estimator_factory
from app.config import settings
from app.errors import BadGatewayError, UnprocessableEntityError
from app.main import app
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.security.tokens import create_access_token
from tests.factories import create_user

_VALID_ESTIMATE_JSON = json.dumps(
    {
        "name": "滷肉飯",
        "brand": None,
        "serving_grams": 250,
        "serving_kcal": 480,
        "serving_protein_g": 14,
        "serving_fat_g": 18,
        "serving_carb_g": 62,
        "confidence": 0.7,
    },
    ensure_ascii=False,
)

_VALID_MEAL_JSON = json.dumps(
    {
        "description": "一碗白飯、滷雞腿一隻",
        "items": [
            json.loads(_VALID_ESTIMATE_JSON),
            {**json.loads(_VALID_ESTIMATE_JSON), "name": "滷雞腿"},
        ],
    },
    ensure_ascii=False,
)

_MISCONFIGURED_MESSAGE = "AI 設定有問題（金鑰或模型），請管理員檢查"
_UPSTREAM_MESSAGE = "AI 服務暫時無法使用，請稍後再試"


class FakeUpstream:
    """假的供應商：數收到幾個請求，回固定的狀態碼與 body，或丟傳輸層例外。

    `transport_error` 收 request、回一個例外（兩家的 HTTP 函式庫不同，例外要用
    對應的那一套建，SDK 才認得）。
    """

    def __init__(
        self,
        *,
        status: int = 200,
        body: object = None,
        transport_error: Callable[[Any], Exception] | None = None,
    ) -> None:
        self.status = status
        self.body = body
        self.transport_error = transport_error
        self.requests = 0
        # 每個請求的 body（解過的 JSON）：多樣的測試要看「送出去的是什麼」。
        self.bodies: list[dict[str, Any]] = []

    def anthropic_handler(self, request: httpx2.Request) -> httpx2.Response:
        self.requests += 1
        self.bodies.append(json.loads(request.content))
        if self.transport_error is not None:
            raise self.transport_error(request)
        return httpx2.Response(self.status, json=self.body)

    def gemini_handler(self, request: httpx.Request) -> httpx.Response:
        self.requests += 1
        self.bodies.append(json.loads(request.content))
        if self.transport_error is not None:
            raise self.transport_error(request)
        return httpx.Response(self.status, json=self.body)


def _anthropic_estimator(upstream: FakeUpstream) -> AnthropicEstimator:
    estimator = AnthropicEstimator(api_key="sk-ant-not-real", model="claude-test")
    # max_retries=0：SDK 預設會對 429／5xx／連線錯誤退避重試兩次（真的 sleep）。
    # 重試與否不影響最後丟的是哪一種例外，只影響測試要等多久。
    estimator._client = AsyncAnthropic(
        api_key="sk-ant-not-real",
        max_retries=0,
        http_client=httpx2.AsyncClient(
            transport=httpx2.MockTransport(upstream.anthropic_handler)
        ),
    )
    return estimator


def _gemini_estimator(upstream: FakeUpstream, *, model: str = "gemini-test") -> GeminiEstimator:
    estimator = GeminiEstimator(api_key="not-real", model=model)
    # 沒給 retry_options 時 google-genai 只試一次（`retry_args(None)`），不用另外關。
    estimator._client = genai.Client(
        api_key="not-real",
        http_options=types.HttpOptions(
            httpx_async_client=httpx.AsyncClient(
                transport=httpx.MockTransport(upstream.gemini_handler)
            )
        ),
    )
    return estimator


def _anthropic_error(status: int, error_type: str, message: str) -> FakeUpstream:
    return FakeUpstream(
        status=status, body={"type": "error", "error": {"type": error_type, "message": message}}
    )


def _gemini_error(
    status: int, grpc_status: str, message: str, details: list[object] | None = None
) -> FakeUpstream:
    error: dict[str, object] = {"code": status, "message": message, "status": grpc_status}
    if details is not None:
        error["details"] = details
    return FakeUpstream(status=status, body={"error": error})


# ---------------------------------------------------------------------------
# estimator 層：SDK 的例外翻成哪一種
# ---------------------------------------------------------------------------

# (名稱, 假的供應商, 預期的內部例外, SDK 實際丟的例外)
_ANTHROPIC_CASES = [
    (
        "401-bad-key",
        lambda: _anthropic_error(401, "authentication_error", "invalid x-api-key"),
        EstimatorMisconfiguredError,
        anthropic.AuthenticationError,
    ),
    (
        "403-no-permission",
        lambda: _anthropic_error(
            403,
            "permission_error",
            "Your API key does not have permission to use the specified resource.",
        ),
        EstimatorMisconfiguredError,
        anthropic.PermissionDeniedError,
    ),
    (
        "404-unknown-model",
        lambda: _anthropic_error(404, "not_found_error", "model: claude-not-a-model"),
        EstimatorMisconfiguredError,
        anthropic.NotFoundError,
    ),
    (
        "400-bad-model-name",
        lambda: _anthropic_error(
            400, "invalid_request_error", "model: String should have at least 1 character"
        ),
        EstimatorMisconfiguredError,
        anthropic.BadRequestError,
    ),
    (
        "400-other",
        lambda: _anthropic_error(
            400,
            "invalid_request_error",
            "messages.0.content.0.image.source.base64: image exceeds 5 MB maximum",
        ),
        EstimatorUpstreamError,
        anthropic.BadRequestError,
    ),
    (
        "429-rate-limit",
        lambda: _anthropic_error(429, "rate_limit_error", "Number of requests has exceeded"),
        EstimatorUpstreamError,
        anthropic.RateLimitError,
    ),
    (
        "500",
        lambda: _anthropic_error(500, "api_error", "Internal server error"),
        EstimatorUpstreamError,
        anthropic.InternalServerError,
    ),
    (
        "529-overloaded",
        lambda: _anthropic_error(529, "overloaded_error", "Overloaded"),
        EstimatorUpstreamError,
        anthropic.OverloadedError,
    ),
    (
        "connect-error",
        lambda: FakeUpstream(
            transport_error=lambda request: httpx2.ConnectError("refused", request=request)
        ),
        EstimatorUpstreamError,
        anthropic.APIConnectionError,
    ),
    (
        "timeout",
        lambda: FakeUpstream(
            transport_error=lambda request: httpx2.ReadTimeout("slow", request=request)
        ),
        EstimatorUpstreamError,
        anthropic.APITimeoutError,
    ),
]

_GEMINI_CASES = [
    (
        # Gemini 的金鑰錯是 400 INVALID_ARGUMENT，不是 401。
        "400-bad-key",
        lambda: _gemini_error(
            400,
            "INVALID_ARGUMENT",
            "API key not valid. Please pass a valid API key.",
            [
                {
                    "@type": "type.googleapis.com/google.rpc.ErrorInfo",
                    "reason": "API_KEY_INVALID",
                    "domain": "googleapis.com",
                }
            ],
        ),
        EstimatorMisconfiguredError,
        genai_errors.ClientError,
    ),
    (
        "401-unauthenticated",
        lambda: _gemini_error(
            401, "UNAUTHENTICATED", "Request had invalid authentication credentials."
        ),
        EstimatorMisconfiguredError,
        genai_errors.ClientError,
    ),
    (
        "403-permission-denied",
        lambda: _gemini_error(403, "PERMISSION_DENIED", "The caller does not have permission"),
        EstimatorMisconfiguredError,
        genai_errors.ClientError,
    ),
    (
        "404-unknown-model",
        lambda: _gemini_error(
            404,
            "NOT_FOUND",
            "models/gemini-not-a-model is not found for API version v1beta, or is not "
            "supported for generateContent.",
        ),
        EstimatorMisconfiguredError,
        genai_errors.ClientError,
    ),
    (
        "400-bad-model-name",
        lambda: _gemini_error(
            400,
            "INVALID_ARGUMENT",
            "* GenerateContentRequest.model: unexpected model name format",
        ),
        EstimatorMisconfiguredError,
        genai_errors.ClientError,
    ),
    (
        "400-other",
        lambda: _gemini_error(400, "INVALID_ARGUMENT", "Request contains an invalid argument."),
        EstimatorUpstreamError,
        genai_errors.ClientError,
    ),
    (
        "429-resource-exhausted",
        lambda: _gemini_error(429, "RESOURCE_EXHAUSTED", "Resource has been exhausted"),
        EstimatorUpstreamError,
        genai_errors.ClientError,
    ),
    (
        "500",
        lambda: _gemini_error(500, "INTERNAL", "An internal error has occurred."),
        EstimatorUpstreamError,
        genai_errors.ServerError,
    ),
    (
        "503-unavailable",
        lambda: _gemini_error(503, "UNAVAILABLE", "The model is overloaded."),
        EstimatorUpstreamError,
        genai_errors.ServerError,
    ),
    (
        "connect-error",
        lambda: FakeUpstream(
            transport_error=lambda request: httpx.ConnectError("refused", request=request)
        ),
        EstimatorUpstreamError,
        httpx.ConnectError,
    ),
    (
        "timeout",
        lambda: FakeUpstream(
            transport_error=lambda request: httpx.ReadTimeout("slow", request=request)
        ),
        EstimatorUpstreamError,
        httpx.ReadTimeout,
    ),
]


@pytest.mark.parametrize(
    ("make_upstream", "expected", "sdk_error"),
    [case[1:] for case in _ANTHROPIC_CASES],
    ids=[case[0] for case in _ANTHROPIC_CASES],
)
async def test_anthropic_sdk_errors_are_classified(make_upstream, expected, sdk_error):
    upstream = make_upstream()
    estimator = _anthropic_estimator(upstream)

    with pytest.raises(expected) as excinfo:
        await estimator.estimate_text("一碗滷肉飯")

    assert upstream.requests == 1
    # 原本的 SDK 例外留在 __cause__，log 才看得到供應商說了什麼。
    assert type(excinfo.value.__cause__) is sdk_error


@pytest.mark.parametrize(
    ("make_upstream", "expected", "sdk_error"),
    [case[1:] for case in _GEMINI_CASES],
    ids=[case[0] for case in _GEMINI_CASES],
)
async def test_gemini_sdk_errors_are_classified(make_upstream, expected, sdk_error):
    upstream = make_upstream()
    estimator = _gemini_estimator(upstream)

    with pytest.raises(expected) as excinfo:
        await estimator.estimate_text("一碗滷肉飯")

    assert upstream.requests == 1
    assert type(excinfo.value.__cause__) is sdk_error


async def test_gemini_invalid_model_name_is_misconfigured_before_any_request():
    """`AI_MODEL` 含 `?`、`&` 或 `..`：google-genai 在送出之前就自己丟
    `ValueError('invalid model parameter.')`（`_transformers.t_model`）。那是設定錯，
    不是上游錯——也不是沒分類的 500。"""
    upstream = FakeUpstream(body=_gemini_ok_body(_VALID_ESTIMATE_JSON))
    estimator = _gemini_estimator(upstream, model="bad?model")

    with pytest.raises(EstimatorMisconfiguredError) as excinfo:
        await estimator.estimate_text("一碗滷肉飯")

    # 根本沒送出去：SDK 在組網址之前就擋下來了。
    assert upstream.requests == 0
    assert type(excinfo.value.__cause__) is ValueError


async def test_gemini_other_value_errors_are_not_classified_as_misconfigured(monkeypatch):
    """只接 SDK 那一句「invalid model parameter.」——別的 ValueError 照舊往外拋。"""
    upstream = FakeUpstream(body=_gemini_ok_body(_VALID_ESTIMATE_JSON))
    estimator = _gemini_estimator(upstream)

    async def boom(**kwargs: object) -> None:
        raise ValueError("something else")

    monkeypatch.setattr(estimator._client.aio.models, "generate_content", boom)

    with pytest.raises(ValueError, match="something else"):
        await estimator.estimate_text("一碗滷肉飯")


_ANTHROPIC_OK_BODY = {
    "id": "msg_test",
    "type": "message",
    "role": "assistant",
    "model": "claude-test",
    "content": [{"type": "text", "text": _VALID_ESTIMATE_JSON}],
    "stop_reason": "end_turn",
    "stop_sequence": None,
    "usage": {"input_tokens": 1, "output_tokens": 1},
}


def _gemini_ok_body(text: str) -> dict[str, object]:
    # 真的 API（非串流）每個 candidate 都帶 finishReason；正常結束是 STOP。
    return {
        "candidates": [
            {"content": {"role": "model", "parts": [{"text": text}]}, "finishReason": "STOP"}
        ]
    }


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_a_good_response_through_the_fake_transport_still_parses(provider):
    """假的傳輸層接得上 SDK 的成功路徑——上面那些失敗案例不是因為「什麼都會失敗」。"""
    if provider == "anthropic":
        upstream = FakeUpstream(body=_ANTHROPIC_OK_BODY)
        estimator: NutritionEstimator = _anthropic_estimator(upstream)
    else:
        upstream = FakeUpstream(body=_gemini_ok_body(_VALID_ESTIMATE_JSON))
        estimator = _gemini_estimator(upstream)

    result = await estimator.estimate_text("一碗滷肉飯")

    assert result.name == "滷肉飯"
    assert upstream.requests == 1


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_garbage_from_the_provider_is_still_ai_bad_response(provider):
    """`AI_BAD_RESPONSE`（502）不變：HTTP 200 但內容不是 JSON，不是上游錯誤。"""
    if provider == "anthropic":
        body = {**_ANTHROPIC_OK_BODY, "content": [{"type": "text", "text": "不是 JSON"}]}
        upstream = FakeUpstream(body=body)
        estimator: NutritionEstimator = _anthropic_estimator(upstream)
    else:
        upstream = FakeUpstream(body=_gemini_ok_body("不是 JSON"))
        estimator = _gemini_estimator(upstream)

    with pytest.raises(BadGatewayError) as excinfo:
        await estimator.estimate_text("一碗滷肉飯")

    assert excinfo.value.code == "AI_BAD_RESPONSE"
    assert upstream.requests == 1


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_unsupported_media_type_is_still_invalid_photo(provider):
    upstream = FakeUpstream(status=500, body={})
    estimator: NutritionEstimator = (
        _anthropic_estimator(upstream) if provider == "anthropic" else _gemini_estimator(upstream)
    )

    with pytest.raises(UnprocessableEntityError) as excinfo:
        await estimator.estimate_image(b"not-an-image", "image/bmp")

    assert excinfo.value.code == "INVALID_PHOTO"
    assert upstream.requests == 0


# ---------------------------------------------------------------------------
# 一餐多樣（AI 多樣估算規格 §5）：同一套分類，另一組提示詞、schema、輸出上限
# ---------------------------------------------------------------------------

_PNG = b"\x89PNG\r\n\x1a\n"


def _estimator_for(provider: str, text: str) -> tuple[FakeUpstream, NutritionEstimator]:
    if provider == "anthropic":
        body = {**_ANTHROPIC_OK_BODY, "content": [{"type": "text", "text": text}]}
        upstream = FakeUpstream(body=body)
        return upstream, _anthropic_estimator(upstream)
    upstream = FakeUpstream(body=_gemini_ok_body(text))
    return upstream, _gemini_estimator(upstream)


def _sent(provider: str, body: dict[str, Any]) -> dict[str, Any]:
    """把兩家的請求 body 攤成同一種形狀：輸出上限、system、schema 的頂層欄位、
    使用者那一則訊息裡的文字、有沒有帶圖片。"""
    if provider == "anthropic":
        content = body["messages"][0]["content"]
        blocks = [{"type": "text", "text": content}] if isinstance(content, str) else content
        return {
            "max_tokens": body["max_tokens"],
            "system": body["system"],
            "schema_fields": set(body["output_config"]["format"]["schema"]["properties"]),
            "text": [block["text"] for block in blocks if block["type"] == "text"],
            "has_image": any(block["type"] == "image" for block in blocks),
        }
    config = body["generationConfig"]
    parts = body["contents"][0]["parts"]
    return {
        "max_tokens": config["maxOutputTokens"],
        "system": body["systemInstruction"]["parts"][0]["text"],
        "schema_fields": set(config["responseSchema"]["properties"]),
        "text": [part["text"] for part in parts if "text" in part],
        "has_image": any("inlineData" in part for part in parts),
    }


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_a_meal_text_call_sends_the_meal_prompt_schema_and_limit(provider):
    upstream, estimator = _estimator_for(provider, _VALID_MEAL_JSON)

    result = await estimator.estimate_meal_text("雞腿便當")

    assert result.description == "一碗白飯、滷雞腿一隻"
    assert [item.name for item in result.items] == ["滷肉飯", "滷雞腿"]
    assert upstream.requests == 1
    sent = _sent(provider, upstream.bodies[0])
    # 8192 寫死（第 10 種）；下一行確認常數就是它，而且跟單樣的不同。
    assert sent["max_tokens"] == 8192
    assert (MAX_MEAL_OUTPUT_TOKENS, MAX_OUTPUT_TOKENS) == (8192, 1024)
    assert sent["system"] == MEAL_SYSTEM_PROMPT
    assert sent["system"] != SYSTEM_PROMPT
    assert sent["schema_fields"] == {"description", "items"}
    assert sent["text"] == [MEAL_TEXT_INSTRUCTION.format(text="雞腿便當")]
    assert sent["has_image"] is False
    # 送給供應商的 schema 不能帶樣數的下限：有了 `minItems: 1`，模型就沒辦法照提示詞
    # 回空陣列說「看不出任何食物」（structured output 會照 schema 硬生出一樣）。
    # 「至少一樣」只在 parse_raw_meal_estimate() 事後檢查——那邊的測試守不到這裡：
    # 下限寫回 schema 上，事後的結果一樣是拒絕。
    body = upstream.bodies[0]
    items_schema = (
        body["output_config"]["format"]["schema"]["properties"]["items"]
        if provider == "anthropic"
        else body["generationConfig"]["responseSchema"]["properties"]["items"]
    )
    assert items_schema["type"].lower() == "array"
    # 兩種寫法都看：google-genai 送出去時把字典裡的 `minItems` 改寫成 `min_items`（實測）。
    assert not {"minItems", "min_items"} & set(items_schema)


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_a_meal_image_call_sends_the_image_and_the_meal_instruction(provider):
    upstream, estimator = _estimator_for(provider, _VALID_MEAL_JSON)

    result = await estimator.estimate_meal_image(_PNG, "image/png")

    assert len(result.items) == 2
    sent = _sent(provider, upstream.bodies[0])
    assert sent["max_tokens"] == 8192
    assert sent["system"] == MEAL_SYSTEM_PROMPT
    assert sent["schema_fields"] == {"description", "items"}
    assert sent["text"] == [MEAL_IMAGE_INSTRUCTION]
    assert sent["has_image"] is True


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_the_single_call_still_sends_the_single_prompt_schema_and_limit(provider):
    """抽出共用的 `_complete` 之後，單樣那一條送出去的東西一個字都沒變。"""
    upstream, estimator = _estimator_for(provider, _VALID_ESTIMATE_JSON)

    await estimator.estimate_text("一碗滷肉飯")
    await estimator.estimate_image(_PNG, "image/png")

    text_call, image_call = (_sent(provider, body) for body in upstream.bodies)
    for sent in (text_call, image_call):
        assert sent["max_tokens"] == 1024
        assert sent["system"] == SYSTEM_PROMPT
        assert "serving_grams" in sent["schema_fields"]
        assert "items" not in sent["schema_fields"]
    assert text_call["has_image"] is False
    assert image_call["has_image"] is True


@pytest.mark.parametrize(
    ("make_upstream", "expected", "sdk_error"),
    [case[1:] for case in _ANTHROPIC_CASES],
    ids=[case[0] for case in _ANTHROPIC_CASES],
)
async def test_anthropic_meal_errors_are_classified_the_same_way(
    make_upstream, expected, sdk_error
):
    upstream = make_upstream()
    estimator = _anthropic_estimator(upstream)

    with pytest.raises(expected) as excinfo:
        await estimator.estimate_meal_text("雞腿便當")

    assert upstream.requests == 1
    assert type(excinfo.value.__cause__) is sdk_error


@pytest.mark.parametrize(
    ("make_upstream", "expected", "sdk_error"),
    [case[1:] for case in _GEMINI_CASES],
    ids=[case[0] for case in _GEMINI_CASES],
)
async def test_gemini_meal_errors_are_classified_the_same_way(make_upstream, expected, sdk_error):
    upstream = make_upstream()
    estimator = _gemini_estimator(upstream)

    with pytest.raises(expected) as excinfo:
        await estimator.estimate_meal_image(_PNG, "image/png")

    assert upstream.requests == 1
    assert type(excinfo.value.__cause__) is sdk_error


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
@pytest.mark.parametrize(
    "reply",
    ["不是 JSON", json.dumps({"description": "看不出來", "items": []}), _VALID_ESTIMATE_JSON],
    ids=["not-json", "no-items", "single-estimate-shape"],
)
async def test_a_bad_meal_reply_from_the_provider_is_ai_bad_response(provider, reply):
    """HTTP 200 但內容不能用：是 `AI_BAD_RESPONSE`，不是上游錯誤——請求送到了、也計費了。"""
    upstream, estimator = _estimator_for(provider, reply)

    with pytest.raises(BadGatewayError) as excinfo:
        await estimator.estimate_meal_text("雞腿便當")

    assert excinfo.value.code == "AI_BAD_RESPONSE"
    assert upstream.requests == 1


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_an_unsupported_media_type_for_a_meal_is_invalid_photo(provider):
    upstream, estimator = _estimator_for(provider, _VALID_MEAL_JSON)

    with pytest.raises(UnprocessableEntityError) as excinfo:
        await estimator.estimate_meal_image(b"not-an-image", "image/bmp")

    assert excinfo.value.code == "INVALID_PHOTO"
    # 沒送出去：格式在打 API 之前就擋了。
    assert upstream.requests == 0


# ---------------------------------------------------------------------------
# 不正常的結束要留一行 log（審查 I1）：單樣與多樣共用 `_complete`，所以兩條都有
# ---------------------------------------------------------------------------
#
# 沒有這一行的時候，「模型把思考算進輸出上限、JSON 寫到一半被截斷」在畫面上是
# 「AI 這次的回答看不懂」、在後端什麼都沒有——每按一次吃一次額度，卻沒有任何地方說為什麼。

# 被截斷的回覆：寫到一半的 JSON。log 裡**不能**出現這段字（模型的輸出不進 log）。
_PARTIAL_TEXT = '{"description": "一碗白飯、滷雞腿", "items": [{"name": "白飯截斷"'
_PROMPT_TEXT = "雞腿便當不要進log"

_ESTIMATOR_LOGGERS = {"app.ai.anthropic_estimator", "app.ai.gemini_estimator"}


def _anthropic_body(
    *, text: str | None, stop_reason: str, input_tokens: int = 1, output_tokens: int = 1
) -> dict[str, object]:
    content = [] if text is None else [{"type": "text", "text": text}]
    return {
        **_ANTHROPIC_OK_BODY,
        "content": content,
        "stop_reason": stop_reason,
        "usage": {"input_tokens": input_tokens, "output_tokens": output_tokens},
    }


def _gemini_body(
    *,
    text: str | None,
    finish_reason: str | None,
    usage: dict[str, int] | None = None,
) -> dict[str, object]:
    candidate: dict[str, object] = {}
    if text is not None:
        candidate["content"] = {"role": "model", "parts": [{"text": text}]}
    if finish_reason is not None:
        candidate["finishReason"] = finish_reason
    body: dict[str, object] = {"candidates": [candidate]}
    if usage is not None:
        body["usageMetadata"] = usage
    return body


def _estimator_with_body(provider: str, body: object) -> tuple[FakeUpstream, NutritionEstimator]:
    upstream = FakeUpstream(body=body)
    if provider == "anthropic":
        return upstream, _anthropic_estimator(upstream)
    return upstream, _gemini_estimator(upstream)


def _estimator_warnings(caplog: pytest.LogCaptureFixture) -> list[logging.LogRecord]:
    return [
        record
        for record in caplog.records
        if record.name in _ESTIMATOR_LOGGERS and record.levelno >= logging.WARNING
    ]


# 數字刻意每個都不一樣、也不是別的地方會出現的值：斷言它們在 log 裡，才分得出
# 「記的是這一次的用量」與「記了一個寫死的數字」。
_TRUNCATED_BODIES: dict[str, object] = {
    "anthropic": _anthropic_body(
        text=_PARTIAL_TEXT, stop_reason="max_tokens", input_tokens=1873, output_tokens=7919
    ),
    "gemini": _gemini_body(
        text=_PARTIAL_TEXT,
        finish_reason="MAX_TOKENS",
        usage={
            "promptTokenCount": 1873,
            "candidatesTokenCount": 46,
            "thoughtsTokenCount": 7919,
            "totalTokenCount": 9838,
        },
    ),
}
_TRUNCATED_EXPECTED = {
    "anthropic": ["max_tokens", "1873", "7919"],
    "gemini": ["MAX_TOKENS", "1873", "46", "7919", "9838"],
}


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
@pytest.mark.parametrize("method", ["estimate_meal_text", "estimate_text"])
async def test_a_truncated_reply_logs_the_stop_reason_and_the_token_counts(
    provider, method, caplog
):
    """寫到上限被截斷：照舊是 `AI_BAD_RESPONSE`，但多一行 WARNING 說為什麼。"""
    upstream, estimator = _estimator_with_body(provider, _TRUNCATED_BODIES[provider])

    with pytest.raises(BadGatewayError) as excinfo:
        await getattr(estimator, method)(_PROMPT_TEXT)

    assert excinfo.value.code == "AI_BAD_RESPONSE"
    assert upstream.requests == 1
    warnings = _estimator_warnings(caplog)
    assert len(warnings) == 1
    assert warnings[0].levelno == logging.WARNING
    assert warnings[0].name == f"app.ai.{provider}_estimator"
    message = warnings[0].getMessage()
    for expected in _TRUNCATED_EXPECTED[provider]:
        assert expected in message
    # 哪個模型、上限設多少：看 log 的人要拿這兩個去對。
    assert estimator.model in message
    assert ("8192" if method == "estimate_meal_text" else "1024") in message


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_the_warning_never_contains_the_prompt_or_the_reply(provider, caplog):
    """log 只有原因與用量。使用者輸入的字、照片、模型的輸出都不進 log——那是別人吃了
    什麼，而且模型的輸出是不可信的文字（可以帶換行偽造 log）。"""
    upstream, estimator = _estimator_with_body(provider, _TRUNCATED_BODIES[provider])

    with pytest.raises(BadGatewayError):
        await estimator.estimate_meal_text(_PROMPT_TEXT)
    with pytest.raises(BadGatewayError):
        await estimator.estimate_meal_image(_PNG, "image/png")

    assert upstream.requests == 2
    # 兩次都記了——下面的「沒有出現」不是因為根本沒有 log。
    assert len(_estimator_warnings(caplog)) == 2
    for record in _estimator_warnings(caplog):
        message = record.getMessage()
        assert "白飯" not in message
        assert "description" not in message
        assert _PROMPT_TEXT not in message
        assert "便當" not in message
        # 照片的 base64（`_PNG` 編碼後的開頭）與提示詞本身。
        assert "iVBOR" not in message
        assert "營養分析助手" not in message


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
@pytest.mark.parametrize("method", ["estimate_meal_text", "estimate_text"])
async def test_a_normal_reply_logs_nothing(provider, method, caplog):
    text = _VALID_MEAL_JSON if method == "estimate_meal_text" else _VALID_ESTIMATE_JSON
    upstream, estimator = _estimator_for(provider, text)

    await getattr(estimator, method)("雞腿便當")

    assert upstream.requests == 1
    assert _estimator_warnings(caplog) == []


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_an_abnormal_stop_is_logged_even_when_the_reply_happens_to_parse(provider, caplog):
    """看的是「怎麼停的」，不是「解析有沒有過」：碰巧寫完才撞到上限的那一次也要記——
    那代表下一次多一樣就會被截斷。"""
    body = (
        _anthropic_body(text=_VALID_MEAL_JSON, stop_reason="max_tokens")
        if provider == "anthropic"
        else _gemini_body(text=_VALID_MEAL_JSON, finish_reason="MAX_TOKENS")
    )
    upstream, estimator = _estimator_with_body(provider, body)

    result = await estimator.estimate_meal_text("雞腿便當")

    assert len(result.items) == 2
    warnings = _estimator_warnings(caplog)
    assert len(warnings) == 1
    assert "max_tokens" in warnings[0].getMessage().lower()


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_a_reply_with_no_text_is_logged_even_when_the_stop_looks_normal(provider, caplog):
    """正常結束卻沒有字（例如整段輸出都是思考）：一樣是 `AI_BAD_RESPONSE`，一樣要記。"""
    body = (
        _anthropic_body(text=None, stop_reason="end_turn", output_tokens=4711)
        if provider == "anthropic"
        else _gemini_body(
            text=None, finish_reason="STOP", usage={"promptTokenCount": 9, "totalTokenCount": 4711}
        )
    )
    upstream, estimator = _estimator_with_body(provider, body)

    with pytest.raises(BadGatewayError) as excinfo:
        await estimator.estimate_meal_text("雞腿便當")

    assert excinfo.value.code == "AI_BAD_RESPONSE"
    warnings = _estimator_warnings(caplog)
    assert len(warnings) == 1
    assert "4711" in warnings[0].getMessage()


async def test_an_anthropic_refusal_is_logged_with_its_stop_reason(caplog):
    upstream, estimator = _estimator_with_body(
        "anthropic", _anthropic_body(text=None, stop_reason="refusal", output_tokens=3)
    )

    with pytest.raises(BadGatewayError):
        await estimator.estimate_meal_image(_PNG, "image/png")

    warnings = _estimator_warnings(caplog)
    assert len(warnings) == 1
    assert "refusal" in warnings[0].getMessage()


async def test_a_gemini_blocked_prompt_is_logged_with_its_block_reason(caplog):
    """提示被擋：沒有 candidate，原因在 `promptFeedback.blockReason`。"""
    body = {
        "promptFeedback": {"blockReason": "PROHIBITED_CONTENT"},
        "usageMetadata": {"promptTokenCount": 263, "totalTokenCount": 263},
    }
    upstream, estimator = _estimator_with_body("gemini", body)

    with pytest.raises(BadGatewayError) as excinfo:
        await estimator.estimate_meal_image(_PNG, "image/png")

    assert excinfo.value.code == "AI_BAD_RESPONSE"
    warnings = _estimator_warnings(caplog)
    assert len(warnings) == 1
    assert "PROHIBITED_CONTENT" in warnings[0].getMessage()
    assert "263" in warnings[0].getMessage()


async def test_a_gemini_reply_without_a_finish_reason_but_with_text_is_not_logged(caplog):
    """沒帶 `finishReason` 不等於不正常：有字就照常解析，不多一行 log。沒有字的那種
    由「沒有文字」那一條接住。"""
    upstream, estimator = _estimator_with_body(
        "gemini", _gemini_body(text=_VALID_MEAL_JSON, finish_reason=None)
    )

    await estimator.estimate_meal_text("雞腿便當")

    assert upstream.requests == 1
    assert _estimator_warnings(caplog) == []


# ---------------------------------------------------------------------------
# 路由層：503 不記列、502 記一列、額度
# ---------------------------------------------------------------------------


def _auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _inject(*estimators: NutritionEstimator) -> None:
    """依序回傳給定的實作——每次請求建一個（路由先查食物庫，要呼叫 AI 才建）。"""
    queue = list(estimators)
    app.dependency_overrides[get_estimator_factory] = lambda: lambda: queue.pop(0)


def _misconfigured(provider: str) -> tuple[FakeUpstream, NutritionEstimator]:
    if provider == "anthropic":
        upstream = _anthropic_error(401, "authentication_error", "invalid x-api-key")
        return upstream, _anthropic_estimator(upstream)
    upstream = _gemini_error(404, "NOT_FOUND", "models/gemini-not-a-model is not found")
    return upstream, _gemini_estimator(upstream)


def _upstream_failure(provider: str) -> tuple[FakeUpstream, NutritionEstimator]:
    if provider == "anthropic":
        upstream = _anthropic_error(529, "overloaded_error", "Overloaded")
        return upstream, _anthropic_estimator(upstream)
    upstream = _gemini_error(503, "UNAVAILABLE", "The model is overloaded.")
    return upstream, _gemini_estimator(upstream)


async def _rows(db_session, user_id: int):
    """rollback 之後才讀——只讀得到真的 commit 過的列（handover §6 第 11 種）。"""
    await db_session.rollback()
    return (
        await db_session.execute(
            select(AiAnalysis.succeeded, AiAnalysis.kind, AiAnalysis.model).where(
                AiAnalysis.user_id == user_id
            )
        )
    ).all()


async def _seed_analyses(db_session, user, count: int) -> None:
    for _ in range(count):
        db_session.add(
            AiAnalysis(
                user_id=user.id,
                kind=AnalysisKind.TEXT,
                model="seed-model",
                input_hash="seed",
                succeeded=True,
            )
        )
    await db_session.commit()


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_misconfigured_provider_is_503_and_not_recorded(client, db_session, provider):
    user = await create_user(db_session)
    # rollback() 會讓 user 過期，之後讀 user.id 會炸 MissingGreenlet（handover §6 第 28 種）。
    user_id = user.id
    upstream, estimator = _misconfigured(provider)
    _inject(estimator)

    response = await client.post(
        "/api/ai/analyze", headers=_auth(user), json={"kind": "text", "text": "一段描述"}
    )

    assert upstream.requests == 1
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_MISCONFIGURED"
    assert response.json()["error"]["message"] == _MISCONFIGURED_MESSAGE
    assert await _rows(db_session, user_id) == []


async def test_gemini_invalid_model_name_is_503_and_not_recorded(client, db_session):
    user = await create_user(db_session)
    user_id = user.id
    upstream = FakeUpstream(body=_gemini_ok_body(_VALID_ESTIMATE_JSON))
    _inject(_gemini_estimator(upstream, model="bad?model"))

    response = await client.post(
        "/api/ai/analyze", headers=_auth(user), json={"kind": "text", "text": "一段描述"}
    )

    assert upstream.requests == 0
    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_MISCONFIGURED"
    assert response.json()["error"]["message"] == _MISCONFIGURED_MESSAGE
    assert await _rows(db_session, user_id) == []


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_upstream_failure_is_502_and_recorded(client, db_session, provider):
    user = await create_user(db_session)
    user_id = user.id
    upstream, estimator = _upstream_failure(provider)
    _inject(estimator)

    response = await client.post(
        "/api/ai/analyze", headers=_auth(user), json={"kind": "text", "text": "一段描述"}
    )

    assert upstream.requests == 1
    assert response.status_code == 502
    assert response.json()["error"]["code"] == "AI_UPSTREAM_ERROR"
    assert response.json()["error"]["message"] == _UPSTREAM_MESSAGE
    rows = await _rows(db_session, user_id)
    assert len(rows) == 1
    assert rows[0].succeeded is False
    assert rows[0].kind is AnalysisKind.TEXT
    assert rows[0].model == estimator.model


@pytest.mark.parametrize("provider", ["anthropic", "gemini"])
async def test_misconfiguration_does_not_use_up_the_quota(client, db_session, provider):
    """只剩最後一次時設定錯了：修好之後那一次還在。

    記了一列的話第二次會是 429 AI_DAILY_LIMIT，而不是 200。
    """
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit - 1)
    misconfigured_upstream, misconfigured = _misconfigured(provider)
    if provider == "anthropic":
        ok_upstream = FakeUpstream(body=_ANTHROPIC_OK_BODY)
        fixed: NutritionEstimator = _anthropic_estimator(ok_upstream)
    else:
        ok_upstream = FakeUpstream(body=_gemini_ok_body(_VALID_ESTIMATE_JSON))
        fixed = _gemini_estimator(ok_upstream)
    _inject(misconfigured, fixed)

    first = await client.post(
        "/api/ai/analyze", headers=_auth(user), json={"kind": "text", "text": "一段描述"}
    )
    second = await client.post(
        "/api/ai/analyze", headers=_auth(user), json={"kind": "text", "text": "一段描述"}
    )

    assert misconfigured_upstream.requests == 1
    assert first.status_code == 503
    assert second.status_code == 200
    assert ok_upstream.requests == 1
    assert second.json()["remaining_today"] == 0


class _ExplodingEstimator:
    model = "exploding-model"

    async def estimate_text(self, text: str):
        raise RuntimeError("沒有分類的例外")

    async def estimate_image(self, image: bytes, media_type: str):
        raise RuntimeError("沒有分類的例外")


async def test_an_unclassified_exception_is_still_recorded_and_reraised(client, db_session):
    """沒分類的例外照舊：記一列、往外拋（回 500）。"""
    user = await create_user(db_session)
    user_id = user.id
    _inject(_ExplodingEstimator())

    # ASGITransport 預設把應用程式沒接住的例外直接拋給測試。
    with pytest.raises(RuntimeError):
        await client.post(
            "/api/ai/analyze", headers=_auth(user), json={"kind": "text", "text": "一段描述"}
        )

    rows = await _rows(db_session, user_id)
    assert len(rows) == 1
    assert rows[0].succeeded is False
