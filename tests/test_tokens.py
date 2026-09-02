import pytest

from app.security.tokens import TokenError, create_token, decode_token


def test_access_token_round_trip():
    token = create_token(user_id=42, token_type="access")
    assert decode_token(token, expected_type="access") == 42


def test_refresh_token_round_trip():
    token = create_token(user_id=7, token_type="refresh")
    assert decode_token(token, expected_type="refresh") == 7


def test_refresh_token_is_rejected_where_an_access_token_is_expected():
    """這是重要的安全性質：長效的 refresh token 不可以拿來直接存取 API。"""
    token = create_token(user_id=1, token_type="refresh")
    with pytest.raises(TokenError):
        decode_token(token, expected_type="access")


def test_access_token_is_rejected_where_a_refresh_token_is_expected():
    token = create_token(user_id=1, token_type="access")
    with pytest.raises(TokenError):
        decode_token(token, expected_type="refresh")


def test_tampered_token_is_rejected():
    token = create_token(user_id=1, token_type="access")
    tampered = token[:-4] + "AAAA"
    with pytest.raises(TokenError):
        decode_token(tampered, expected_type="access")


def test_garbage_is_rejected():
    with pytest.raises(TokenError):
        decode_token("this-is-not-a-token", expected_type="access")


def test_expired_token_is_rejected(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "access_token_ttl_minutes", -1)
    token = create_token(user_id=1, token_type="access")

    with pytest.raises(TokenError):
        decode_token(token, expected_type="access")
