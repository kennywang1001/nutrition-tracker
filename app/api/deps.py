from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase

from app.db import get_db
from app.errors import ForbiddenError, NotFoundError, UnauthorizedError
from app.models.user import User, UserRole
from app.security.tokens import TokenError, decode_token

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise UnauthorizedError("NOT_AUTHENTICATED", "需要登入")

    try:
        user_id = decode_token(credentials.credentials, expected_type="access")
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    user = await db.get(User, user_id)
    if user is None:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期")

    return user


async def require_admin(user: User = Depends(get_current_user)) -> User:
    if user.role is not UserRole.ADMIN:
        raise ForbiddenError("FORBIDDEN", "需要管理員權限")
    return user


async def get_owned_or_404[Model: DeclarativeBase](
    db: AsyncSession,
    model: type[Model],
    resource_id: int,
    *,
    owner_id: int,
    owner_field: str = "owner_id",
) -> Model:
    """取出資源，若不存在或不屬於 owner_id 則拋 NotFoundError。

    規格第 9 節：存取他人資源要回 404 而非 403 —— 403 等於告訴對方
    「這個 ID 存在，只是你不能看」，攻擊者可以據此列舉系統裡有哪些資源。

    兩種失敗必須拋出一模一樣的錯誤，否則差異本身就是洩漏。
    """
    resource = await db.get(model, resource_id)
    if resource is None or getattr(resource, owner_field) != owner_id:
        raise NotFoundError("NOT_FOUND", "找不到該資源")
    return resource
