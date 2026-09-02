from sqlalchemy.ext.asyncio import AsyncSession

from app.models.user import User, UserRole
from app.security.password import hash_password

DEFAULT_PASSWORD = "correct-horse-battery"

_counter = {"n": 0}


def _next_email() -> str:
    _counter["n"] += 1
    return f"user{_counter['n']}@example.com"


async def create_user(
    db_session: AsyncSession,
    *,
    email: str | None = None,
    password: str = DEFAULT_PASSWORD,
    display_name: str = "測試使用者",
    role: UserRole = UserRole.USER,
) -> User:
    user = User(
        email=email or _next_email(),
        password_hash=hash_password(password),
        display_name=display_name,
        role=role,
    )
    db_session.add(user)
    await db_session.commit()
    # 嚴格來說這行是多餘的：測試 session 設了 expire_on_commit=False，屬性不會過期，
    # 而 PostgreSQL 的 INSERT 走 RETURNING，id / created_at 在 commit 當下就填好了。
    # 保留是為了穩健 —— 日後若有欄位是靠 trigger 或 generated column 產生的，
    # RETURNING 不一定涵蓋得到，那時這行就有意義了。測試工廠寧可多一次查詢。
    await db_session.refresh(user)
    return user
