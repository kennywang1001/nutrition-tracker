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
