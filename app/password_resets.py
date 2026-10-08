"""管理員產生的一次性重設密碼連結（帳號設定規格 §3.4–3.6）。

跟 `app/invites.py` 同一個形狀：明碼只在產生的當下存在、資料庫只存 SHA-256；「還能用」的
條件只寫一次，查詢與條件式 UPDATE 共用。用 SHA-256 而不是 Argon2 的理由也相同：256 位元的
亂數沒有字典可查，而查詢要拿雜湊值走唯一索引。
"""

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.password_reset import PasswordResetToken

# 比邀請的 7 天短：握著這條連結就等於握著那個帳號（規格決定 13）。
RESET_LIFETIME = timedelta(hours=24)

RESET_INVALID_MESSAGE = "這個重設密碼連結已經失效，請跟管理員要一個新的"


def new_reset_token() -> str:
    """256 位元的亂數，URL 安全（放在 `/reset-password#` 後面）。"""
    return secrets.token_urlsafe(32)


def hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _still_usable() -> tuple[ColumnElement[bool], ...]:
    """查詢與條件式 UPDATE 共用（理由同 `app/invites.py` 的 `_still_usable`）。
    `func.now()` 是交易開始的時間：同一個重設交易裡，查與兌換用同一個「現在」。"""
    return (
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.revoked_at.is_(None),
        PasswordResetToken.expires_at > func.now(),
    )


async def find_usable_reset(db: AsyncSession, token: str) -> PasswordResetToken | None:
    reset: PasswordResetToken | None = await db.scalar(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == hash_reset_token(token), *_still_usable()
        )
    )
    return reset


async def redeem_reset(db: AsyncSession, reset_id: int) -> int | None:
    """把連結標成已使用，回傳那條連結的 `user_id`；已經不能用了回 None。**不 commit**——
    跟改密碼、撤銷 session 在同一個交易裡（規格 §3.6 步驟 3）。

    條件寫在 UPDATE 的 WHERE 裡（同 `redeem_invite`）：兩個請求同時用同一條連結，第二個
    等第一個的列鎖，第一個 commit 之後重新評估 WHERE → 0 列。"""
    user_id: int | None = await db.scalar(
        update(PasswordResetToken)
        .where(PasswordResetToken.id == reset_id, *_still_usable())
        .values(used_at=func.now())
        .returning(PasswordResetToken.user_id)
    )
    return user_id


async def revoke_live_resets(db: AsyncSession, user_id: int) -> None:
    """撤銷這個人所有還沒用、還沒撤銷的連結——**包括已經過期的**（部分唯一索引只看
    `used_at`／`revoked_at`，不看時間；過期沒撤銷的那條仍會擋住新的）。**不 commit。**

    兩個呼叫者：產生新連結（先撤銷再插入）、使用者自己改了密碼（管理員之前產生的連結不該還能用）。"""
    await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user_id,
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.revoked_at.is_(None),
        )
        .values(revoked_at=func.now())
    )
