import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any, Literal

import jwt

from app.config import settings


class TokenError(Exception):
    """token 無效、過期，或類型不符。"""


@dataclass(frozen=True)
class RefreshClaims:
    """decode_refresh_token 的結果。

    回 dataclass 而不是 tuple：呼叫端寫 `claims.jti` 讀得出意圖，寫
    `claims[1]` 讀不出來 —— 而 int 與 UUID 位置寫反了，型別檢查抓得到，
    但如果兩個都是 tuple 索引就沒人擋。
    """

    user_id: int
    jti: uuid.UUID


def _encode(payload: dict[str, Any]) -> str:
    return jwt.encode(payload, settings.jwt_secret, algorithm=settings.jwt_algorithm)


def _decode(token: str, *, require: list[str]) -> dict[str, Any]:
    try:
        payload: dict[str, Any] = jwt.decode(
            token,
            settings.jwt_secret,
            algorithms=[settings.jwt_algorithm],
            # 預設只在 exp 存在時才驗證它 —— 少了 exp 的偽造 token 會永遠有效。
            options={"require": require},
        )
    except jwt.PyJWTError as exc:
        raise TokenError("token 無效或已過期") from exc
    return payload


# 保留這個 Literal：expected_type 打錯字（"acess"）要在 mypy 就爆掉 ——
# 這個 task 的整個論點就是「讓錯誤的選擇由型別擋住」。
TokenType = Literal["access", "refresh"]


def _user_id_from(payload: dict[str, Any], *, expected_type: TokenType) -> int:
    if payload.get("type") != expected_type:
        raise TokenError("token 類型不正確")
    try:
        return int(payload["sub"])
    except (KeyError, ValueError, TypeError) as exc:
        raise TokenError("token payload 格式不正確") from exc


def create_access_token(user_id: int) -> str:
    """短效票，**不帶 jti、不對應任何資料列**（規格 §4）。"""
    now = datetime.now(UTC)
    return _encode(
        {
            "sub": str(user_id),
            "type": "access",
            "iat": now,
            "exp": now + timedelta(minutes=settings.access_token_ttl_minutes),
        }
    )


def create_refresh_token(user_id: int, jti: uuid.UUID) -> str:
    """長效票。**`jti` 是必填參數，沒有預設值。**

    這是刻意的：一張沒有 jti 的 refresh token 在 `refresh_sessions` 裡沒有
    對應的列，因此永遠撤銷不掉。把 jti 做成必填，讓那種票在型別層就造不
    出來，而不是靠註解提醒。
    """
    now = datetime.now(UTC)
    return _encode(
        {
            "sub": str(user_id),
            "type": "refresh",
            "jti": str(jti),
            "iat": now,
            "exp": now + timedelta(days=settings.refresh_token_ttl_days),
        }
    )


def decode_access_token(token: str) -> int:
    payload = _decode(token, require=["exp", "iat", "sub", "type"])
    return _user_id_from(payload, expected_type="access")


def decode_refresh_token(token: str) -> RefreshClaims:
    """`require` 比 access 多一個 `jti`（規格 §7）。

    部署當下所有已發出的 refresh token 都沒有 jti，會在這裡被拒絕 ——
    後果是全員重新登入一次，這是刻意的，不做向後相容。
    """
    payload = _decode(token, require=["exp", "iat", "sub", "type", "jti"])
    user_id = _user_id_from(payload, expected_type="refresh")

    # **這裡刻意只接 ValueError，不接 KeyError。**
    # 「jti 存不存在」是上面 require 清單的責任，這個 except 只負責
    # 「值的格式對不對」。兩者都接的話就是兩道防線互相掩護（§6 第 5 種）：
    # 把 require 裡的 jti 拿掉，KeyError 會被接住、拋出同一個 TokenError，
    # 測試全綠 —— 這個性質就從來沒有被任何單一守衛釘住過
    # （Task 2 品質審查實測驗證，不是推論）。
    #
    # 也刻意不先套 str()：str() 會讓一個 32 位十進位整數也變成合法 UUID。
    raw_jti = payload["jti"]
    if not isinstance(raw_jti, str):
        raise TokenError("token payload 格式不正確")
    try:
        jti = uuid.UUID(raw_jti)
    except ValueError as exc:
        raise TokenError("token payload 格式不正確") from exc
    return RefreshClaims(user_id=user_id, jti=jti)
