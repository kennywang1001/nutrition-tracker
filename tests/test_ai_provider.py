"""`build_estimator()`：依 `AI_PROVIDER` 建對應的實作，設定不完整就 503。

建實作不打網路（`AsyncAnthropic(...)`、`genai.Client(...)` 只是建 client），
所以這裡直接斷言型別，不需要假實作。
"""

import pytest

from app.ai.anthropic_estimator import AnthropicEstimator
from app.ai.gemini_estimator import GeminiEstimator
from app.api.deps import build_estimator
from app.config import settings
from app.errors import ServiceUnavailableError


def _configure(monkeypatch, *, provider, anthropic=None, gemini=None, model="some-model"):
    monkeypatch.setattr(settings, "ai_provider", provider)
    monkeypatch.setattr(settings, "anthropic_api_key", anthropic)
    monkeypatch.setattr(settings, "gemini_api_key", gemini)
    monkeypatch.setattr(settings, "ai_model", model)


def test_anthropic_provider_builds_the_anthropic_estimator(monkeypatch):
    _configure(monkeypatch, provider="anthropic", anthropic="sk-ant-not-real")

    estimator = build_estimator()

    assert isinstance(estimator, AnthropicEstimator)
    assert estimator.model == "some-model"


def test_gemini_provider_builds_the_gemini_estimator(monkeypatch):
    _configure(monkeypatch, provider="gemini", gemini="not-real")

    estimator = build_estimator()

    assert isinstance(estimator, GeminiEstimator)
    assert estimator.model == "some-model"


def test_no_provider_means_ai_is_off_even_with_keys(monkeypatch):
    """兩把金鑰都有、沒選供應商：仍然是關閉的——選一家是明確的設定。"""
    _configure(monkeypatch, provider=None, anthropic="a", gemini="b")

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert excinfo.value.code == "AI_NOT_CONFIGURED"


def test_the_other_providers_key_does_not_count(monkeypatch):
    """選了 Gemini、只有 Anthropic 的金鑰：503，訊息說缺的是 GEMINI_API_KEY。"""
    _configure(monkeypatch, provider="gemini", anthropic="sk-ant-not-real")

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert excinfo.value.code == "AI_NOT_CONFIGURED"
    assert "GEMINI_API_KEY" in excinfo.value.message


def test_missing_anthropic_key_is_named(monkeypatch):
    _configure(monkeypatch, provider="anthropic", gemini="not-real")

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert "ANTHROPIC_API_KEY" in excinfo.value.message


def test_missing_model_is_named(monkeypatch):
    _configure(monkeypatch, provider="gemini", gemini="not-real", model=None)

    with pytest.raises(ServiceUnavailableError) as excinfo:
        build_estimator()

    assert "AI_MODEL" in excinfo.value.message
