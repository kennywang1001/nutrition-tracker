from collections.abc import Callable

from fastapi import Depends
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import DeclarativeBase

from app.ai.anthropic_estimator import AnthropicEstimator
from app.ai.estimator import NutritionEstimator
from app.ai.gemini_estimator import GeminiEstimator
from app.config import settings
from app.db import get_db
from app.errors import ForbiddenError, NotFoundError, ServiceUnavailableError, UnauthorizedError
from app.models.user import User, UserRole
from app.security.tokens import TokenError, decode_access_token

_bearer = HTTPBearer(auto_error=False)


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    db: AsyncSession = Depends(get_db),
) -> User:
    if credentials is None:
        raise UnauthorizedError("NOT_AUTHENTICATED", "需要登入")

    try:
        user_id = decode_access_token(credentials.credentials)
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


def build_estimator() -> NutritionEstimator:
    """依 `AI_PROVIDER` 建對應的實作；設定不完整就 503——關閉必須是明講的，
    不是一個看起來壞掉的樣子（跟 `jwt_secret` 刻意相反：見 app/config.py）。

    **訊息說出缺的是哪一個**：部署的人看到「AI 分析未設定：缺 GEMINI_API_KEY」
    就知道要補什麼，不用去讀程式碼。

    每次呼叫都建一個新的實作（等同新的 client）——沒有需要跨請求共用的
    狀態，跟 `get_current_user` 每次重查一次使用者是同一種簡單優先的取捨。
    """
    provider = settings.ai_provider
    if provider is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定")
    if settings.ai_model is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定：缺 AI_MODEL")
    if provider == "anthropic":
        if settings.anthropic_api_key is None:
            raise ServiceUnavailableError(
                "AI_NOT_CONFIGURED", "AI 分析未設定：缺 ANTHROPIC_API_KEY"
            )
        return AnthropicEstimator(api_key=settings.anthropic_api_key, model=settings.ai_model)
    if settings.gemini_api_key is None:
        raise ServiceUnavailableError("AI_NOT_CONFIGURED", "AI 分析未設定：缺 GEMINI_API_KEY")
    return GeminiEstimator(api_key=settings.gemini_api_key, model=settings.ai_model)


EstimatorFactory = Callable[[], NutritionEstimator]


async def get_estimator_factory() -> EstimatorFactory:
    """路由拿的是「建實作的函式」，不是實作本身。

    FastAPI 在進 handler 之前就解析依賴——如果依賴本身就是實作，AI 沒設定時
    連「食物庫命中、根本不用呼叫 AI」的請求也會 503。拿函式的話，路由可以
    決定什麼時候才真的需要它（AI 估算前端規格 §3.3）。

    測試用 `app.dependency_overrides[get_estimator_factory]` 換成回傳假實作的函式。
    """
    return build_estimator


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
