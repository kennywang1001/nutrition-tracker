from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest

from app.security.tokens import (
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_access_token,
    decode_refresh_token,
)


def test_access_token_round_trip():
    token = create_access_token(user_id=42)
    assert decode_access_token(token) == 42


def test_refresh_token_round_trip_carries_the_jti():
    jti = uuid4()
    token = create_refresh_token(user_id=7, jti=jti)

    claims = decode_refresh_token(token)

    assert claims.user_id == 7
    assert claims.jti == jti


def test_refresh_token_is_rejected_where_an_access_token_is_expected():
    """這是重要的安全性質：長效的 refresh token 不可以拿來直接存取 API。"""
    token = create_refresh_token(user_id=1, jti=uuid4())
    with pytest.raises(TokenError):
        decode_access_token(token)


def test_access_token_is_rejected_where_a_refresh_token_is_expected():
    token = create_access_token(user_id=1)
    with pytest.raises(TokenError):
        decode_refresh_token(token)


def test_tampered_token_is_rejected():
    token = create_access_token(user_id=1)
    tampered = token[:-4] + "AAAA"
    with pytest.raises(TokenError):
        decode_access_token(tampered)


def test_garbage_is_rejected():
    with pytest.raises(TokenError):
        decode_access_token("this-is-not-a-token")


def test_expired_access_token_is_rejected(monkeypatch):
    from app.config import settings

    monkeypatch.setattr(settings, "access_token_ttl_minutes", -1)
    token = create_access_token(user_id=1)

    with pytest.raises(TokenError):
        decode_access_token(token)


def test_expired_refresh_token_is_rejected(monkeypatch):
    """兩條路徑現在真的是兩段不同的程式碼（require 清單不同），
    所以這個測試不再只是形式上的重複 —— 它是唯一會發現 refresh 路徑
    的過期驗證壞掉的東西。
    """
    from app.config import settings

    monkeypatch.setattr(settings, "refresh_token_ttl_days", -1)
    token = create_refresh_token(user_id=1, jti=uuid4())

    with pytest.raises(TokenError):
        decode_refresh_token(token)


def _forge(payload: dict[str, object]) -> str:
    """繞過 create_*_token，直接用同一把密鑰簽一個任意 payload 的 token。"""
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
        decode_access_token(forged)


def test_forged_token_without_sub_raises_token_error():
    now = datetime.now(UTC)
    forged = _forge({"type": "access", "iat": now, "exp": now + timedelta(minutes=15)})
    with pytest.raises(TokenError):
        decode_access_token(forged)


def test_forged_token_without_exp_is_rejected():
    """沒有 exp 的 token 不能被接受 —— 否則它永遠不會過期。"""
    forged = _forge({"sub": "1", "type": "access", "iat": datetime.now(UTC)})
    with pytest.raises(TokenError):
        decode_access_token(forged)


def test_refresh_token_without_jti_is_rejected():
    """**上線相容性的關鍵測試（規格 §7）。**

    部署當下所有已發出的 refresh token 都長這個樣子（沒有 jti）。
    它們必須被明確拒絕，而不是被當成「舊格式」放行 —— 放行等於這個缺陷
    還開著，而那段相容邏輯忘記拿掉就是一個永久的後門。
    """
    now = datetime.now(UTC)
    forged = _forge({"sub": "1", "type": "refresh", "iat": now, "exp": now + timedelta(days=14)})
    with pytest.raises(TokenError):
        decode_refresh_token(forged)


def test_refresh_token_with_a_malformed_jti_raises_token_error():
    """jti 不是合法 UUID 時要是 TokenError，不能讓 ValueError 漏出去變成 500。"""
    now = datetime.now(UTC)
    forged = _forge(
        {
            "sub": "1",
            "type": "refresh",
            "jti": "not-a-uuid",
            "iat": now,
            "exp": now + timedelta(days=14),
        }
    )
    with pytest.raises(TokenError):
        decode_refresh_token(forged)


def test_access_token_does_not_carry_a_jti():
    """access token 刻意沒有 jti：它不對應任何一列，也不查資料庫（規格 §4）。

    如果哪天有人幫它加上 jti，那多半意味著他正打算讓 access token 也查表 ——
    這個測試會讓那個決定停下來被討論，而不是安靜地發生。
    """
    import jwt as pyjwt

    from app.config import settings

    token = create_access_token(user_id=1)
    payload = pyjwt.decode(token, settings.jwt_secret, algorithms=[settings.jwt_algorithm])

    assert "jti" not in payload
