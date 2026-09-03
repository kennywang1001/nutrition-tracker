from datetime import UTC, datetime, timedelta

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


def test_expired_refresh_token_is_rejected(monkeypatch):
    """test_expired_token_is_rejected 只涵蓋 access token。

    兩種型別走的是同一個 jwt.decode，所以今天不可能只有一邊壞掉 ——
    但「session 撤銷」那個後續任務會把 iat 比對加進 decode_token，
    那時就會有分支，這個測試才是唯一會發現 refresh 路徑壞掉的東西。
    """
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_token_ttl_days", -1)
    token = create_token(user_id=1, token_type="refresh")

    with pytest.raises(TokenError):
        decode_token(token, expected_type="refresh")


def _forge(payload: dict[str, object]) -> str:
    """繞過 create_token，直接用同一把密鑰簽一個任意 payload 的 token。"""
    import jwt as pyjwt

    from app.config import settings

    return pyjwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def test_forged_token_with_non_numeric_sub_raises_token_error():
    """簽章有效但 payload 形狀不對，也必須是 TokenError，不能是 ValueError。

    呼叫端（get_current_user）只接 TokenError，其他例外會變成 500。
    """
    now = datetime.now(UTC)
    forged = _forge(
        {"sub": "not-a-number", "type": "access", "iat": now, "exp": now + timedelta(minutes=15)}
    )
    with pytest.raises(TokenError):
        decode_token(forged, expected_type="access")


def test_forged_token_without_sub_raises_token_error():
    now = datetime.now(UTC)
    forged = _forge({"type": "access", "iat": now, "exp": now + timedelta(minutes=15)})
    with pytest.raises(TokenError):
        decode_token(forged, expected_type="access")


def test_forged_token_without_exp_is_rejected():
    """沒有 exp 的 token 不能被接受 —— 否則它永遠不會過期。"""
    forged = _forge({"sub": "1", "type": "access", "iat": datetime.now(UTC)})
    with pytest.raises(TokenError):
        decode_token(forged, expected_type="access")
