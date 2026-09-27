import pytest
from pydantic import ValidationError

from app.config import Settings


def test_settings_have_sensible_defaults():
    """jwt_secret 沒有預設值了，所以這裡明確帶一個值，
    不依賴 pytest 環境（根目錄 conftest.py 會 setdefault 一個測試用密鑰）——
    這個測試要測的是「其他欄位」的預設值，不是 jwt_secret 有沒有被灌進來。"""
    settings = Settings(jwt_secret="just-for-this-test")

    assert settings.jwt_algorithm == "HS256"
    assert settings.access_token_ttl_minutes == 15
    assert settings.refresh_token_ttl_days == 14


def test_settings_can_be_overridden():
    settings = Settings(jwt_secret="from-test", access_token_ttl_minutes=1)

    assert settings.jwt_secret == "from-test"
    assert settings.access_token_ttl_minutes == 1


def test_settings_raise_when_jwt_secret_missing(monkeypatch):
    """fail closed：沒有 JWT_SECRET 就不准啟動，不准退回任何預設值。

    `monkeypatch.delenv` 把根目錄 conftest.py 灌的測試用密鑰拿掉；
    `_env_file=None` 把 `.env` 檔案也關掉，否則本機開發者自己的 `.env`
    會讓這個測試在「有沒有設環境變數」之外多一個變因。"""
    monkeypatch.delenv("JWT_SECRET", raising=False)

    with pytest.raises(ValidationError):
        Settings(_env_file=None)


def test_settings_reject_known_placeholder_secret():
    """陷阱 2 / 決定：那個字面字串在公開的 GitHub repo 裡，
    等於沒有密鑰——擋掉它，不要讓它被誤用在真正的部署上。

    明確傳入 jwt_secret 這個關鍵字參數，優先權高於環境變數，
    所以不需要管環境變數目前是什麼值。"""
    with pytest.raises(ValidationError):
        Settings(jwt_secret="dev-secret-change-me-in-production")


def test_settings_accept_a_real_looking_secret():
    """對照組：不是所有字串都被擋，只有那一個字面字串被擋。"""
    settings = Settings(jwt_secret="a-secret-that-is-not-the-placeholder")

    assert settings.jwt_secret == "a-secret-that-is-not-the-placeholder"


def test_anthropic_key_defaults_to_none():
    """沒設 AI key 不該讓整個 app 起不來——它是選配功能，不是安全性設定。

    跟 jwt_secret 刻意相反：那個沒有預設值（fail closed），因為「沒有密鑰」
    等於「任何人都能偽造 token」。少一個 AI 功能不會讓系統變得不安全。
    """
    settings = Settings(jwt_secret="x" * 32)

    assert settings.anthropic_api_key is None
    assert settings.ai_daily_limit == 20
    assert settings.ai_model == "claude-sonnet-5"


def test_ai_daily_limit_must_be_positive():
    """0 或負數會讓每日上限的比較變成一個永遠成立或永遠不成立的條件——
    兩種都不是「關閉 AI」的正確表達方式（那是不設 key）。
    """
    with pytest.raises(ValueError):
        Settings(jwt_secret="x" * 32, ai_daily_limit=0)


def test_empty_anthropic_key_is_treated_as_no_key(monkeypatch):
    """空字串等於沒有金鑰 —— 這一條守的是一個部署層的細節。

    `docker-compose.yml` 用 `${ANTHROPIC_API_KEY:-}` 傳這個變數（`:-` 而不是
    `:?`，因為它是選配的）。實測 `docker compose config` 的輸出確認：沒設值時
    容器收到的是 `ANTHROPIC_API_KEY: ""`，**不是「沒有這個變數」**。

    少了正規化，`settings.anthropic_api_key is None` 會是 `False`，於是
    `get_estimator()` 不會拋 `AI_NOT_CONFIGURED`，而是拿一把空字串金鑰去建
    client —— 使用者看到的是來自 Anthropic 的認證錯誤，而不是「你沒設定 AI」。
    **看起來是開著的比明確關閉更糟。**

    這個缺陷在單純讀 `.env` 的本機環境下不會出現（那裡沒有這個變數），
    只有在 compose 起的容器裡才會 —— 是「只有部署環境看得到」的那一類。
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "")
    assert Settings(jwt_secret="x" * 32).anthropic_api_key is None

    monkeypatch.setenv("ANTHROPIC_API_KEY", "   ")
    assert Settings(jwt_secret="x" * 32).anthropic_api_key is None


def test_a_real_anthropic_key_survives_normalisation(monkeypatch):
    """跟上一條成對：正規化不能把真的金鑰也吃掉。

    只有上一條的話，一個「永遠回 None」的 validator 也會全綠 ——
    而那會讓 AI 功能永遠開不了。
    """
    monkeypatch.setenv("ANTHROPIC_API_KEY", "sk-ant-not-a-real-key")
    assert Settings(jwt_secret="x" * 32).anthropic_api_key == "sk-ant-not-a-real-key"
