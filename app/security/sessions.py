import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import RefreshSession
from app.security.tokens import create_access_token, create_refresh_token


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str


def _add_row(db: AsyncSession, *, user_id: int, family_id: uuid.UUID) -> uuid.UUID:
    jti = uuid.uuid4()
    now = datetime.now(UTC)
    db.add(
        RefreshSession(
            user_id=user_id,
            jti=jti,
            family_id=family_id,
            issued_at=now,
            # 這個值只給 cleanup-sessions 用。過期判斷本身由 JWT 的 exp 負責，
            # 所以這裡跟 token 的 exp 之間幾微秒的差距沒有任何影響。
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    return jti


def _tokens_for(user_id: int, jti: uuid.UUID) -> IssuedTokens:
    return IssuedTokens(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id, jti),
    )


async def start_session(db: AsyncSession, user_id: int) -> IssuedTokens:
    """登入：開一條全新的 family。

    每次登入都是獨立的一條鏈，所以在手機上登出不會動到桌機 —— 那是規格 §1
    整個要解決的問題（今天唯一的止血手段是換 JWT_SECRET，會把所有人一起登出）。
    """
    jti = _add_row(db, user_id=user_id, family_id=uuid.uuid4())
    await db.commit()
    return _tokens_for(user_id, jti)
