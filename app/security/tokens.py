from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt

from app.config import settings

TokenType = Literal["access", "refresh"]


class TokenError(Exception):
    """token 無效、過期，或類型不符。"""


def create_token(user_id: int, token_type: TokenType) -> str:
    now = datetime.now(UTC)
    ttl = (
        timedelta(minutes=settings.access_token_ttl_minutes)
        if token_type == "access"
        else timedelta(days=settings.refresh_token_ttl_days)
    )
    payload = {
        "sub": str(user_id),
        "type": token_type,
        "iat": now,
        "exp": now + ttl,
    }
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def decode_token(token: str, expected_type: TokenType) -> int:
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            # 預設只在 exp 存在時才驗證它 —— 少了 exp 的偽造 token 會永遠有效。
            options={"require": ["exp", "iat", "sub", "type"]},
        )
    except jwt.PyJWTError as exc:
        raise TokenError("token 無效或已過期") from exc

    if payload.get("type") != expected_type:
        raise TokenError("token 類型不正確")

    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise TokenError("token payload 格式不正確") from exc
