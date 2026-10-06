"""一次性邀請連結的規則（邀請規格 §3）。

邀請碼只在產生的當下以明碼存在；資料庫只存 SHA-256。

**用 SHA-256 而不是 Argon2：** 邀請碼是 256 位元的亂數，不是人想出來的密碼——
慢雜湊防的是對低熵輸入的字典攻擊，這裡沒有字典可用。而且查詢要拿雜湊值
走唯一索引；加鹽的慢雜湊做不到「用輸入找那一列」。
"""

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.invite import Invite

INVITE_LIFETIME = timedelta(days=7)

INVITE_INVALID_MESSAGE = "這個邀請連結已經失效，請跟邀請你的人要一個新的"


def new_invite_token() -> str:
    """256 位元的亂數，URL 安全（放在 `/join#` 後面）。"""
    return secrets.token_urlsafe(32)


def hash_invite_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _still_usable() -> tuple[ColumnElement[bool], ...]:
    """「還能用」的三個條件。查詢與條件式 UPDATE 共用這一份——各寫一次的話，哪天只改了
    一邊，就會出現「查得到卻用不掉」（或反過來）的邀請。

    `func.now()` 是交易開始的時間：同一個註冊交易裡，查與兌換用的是同一個「現在」。"""
    return (
        Invite.used_at.is_(None),
        Invite.revoked_at.is_(None),
        Invite.expires_at > func.now(),
    )


async def find_usable_invite(db: AsyncSession, token: str) -> Invite | None:
    invite: Invite | None = await db.scalar(
        select(Invite).where(Invite.token_hash == hash_invite_token(token), *_still_usable())
    )
    return invite


async def redeem_invite(db: AsyncSession, invite_id: int, user_id: int) -> bool:
    """把邀請標成已使用；沒有標到（已經不能用了）回 False。**不 commit**——
    跟建立使用者在同一個交易裡（規格 §3.3 步驟 4）。

    **條件寫在 UPDATE 的 WHERE 裡，不是先 SELECT 再 UPDATE。** 兩個請求同時用同一張
    邀請時，第二個的 UPDATE 會等第一個的列鎖；第一個 commit 之後 PostgreSQL 重新評估
    WHERE，`used_at IS NULL` 不再成立 → 0 列。先查再改的話，兩邊都會在對方 commit
    之前查到「還沒用」（`tests/test_invites_concurrency.py`）。"""
    redeemed = await db.scalar(
        update(Invite)
        .where(Invite.id == invite_id, *_still_usable())
        .values(used_at=func.now(), used_by=user_id)
        .returning(Invite.id)
    )
    return redeemed is not None
