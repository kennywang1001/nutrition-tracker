"""一次性邀請連結的規則（邀請規格 §3）。

邀請碼只在產生的當下以明碼存在；資料庫只存 SHA-256。

**用 SHA-256 而不是 Argon2：** 邀請碼是 256 位元的亂數，不是人想出來的密碼——
慢雜湊防的是對低熵輸入的字典攻擊，這裡沒有字典可用。而且查詢要拿雜湊值
走唯一索引；加鹽的慢雜湊做不到「用輸入找那一列」。
"""

import hashlib
import secrets
from datetime import timedelta

INVITE_LIFETIME = timedelta(days=7)

INVITE_INVALID_MESSAGE = "這個邀請連結已經失效，請跟邀請你的人要一個新的"


def new_invite_token() -> str:
    """256 位元的亂數，URL 安全（放在 `/join#` 後面）。"""
    return secrets.token_urlsafe(32)


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()
