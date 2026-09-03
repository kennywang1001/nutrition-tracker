from fastapi import Depends, FastAPI
from httpx import ASGITransport, AsyncClient

from app.api.deps import require_admin
from app.db import get_db
from app.errors import register_error_handlers
from app.models.user import User, UserRole
from app.security.tokens import create_token
from tests.factories import create_user


def build_admin_app(db_session) -> FastAPI:
    test_app = FastAPI()
    register_error_handlers(test_app)

    @test_app.get("/admin-only")
    async def admin_only(user: User = Depends(require_admin)) -> dict[str, int]:
        return {"user_id": user.id}

    async def override_get_db():
        yield db_session

    test_app.dependency_overrides[get_db] = override_get_db
    return test_app


async def call_admin_endpoint(db_session, token: str | None):
    headers = {"Authorization": f"Bearer {token}"} if token else {}
    transport = ASGITransport(app=build_admin_app(db_session))
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.get("/admin-only", headers=headers)


async def test_admin_can_access(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await call_admin_endpoint(db_session, create_token(admin.id, "access"))

    assert response.status_code == 200
    assert response.json() == {"user_id": admin.id}


async def test_normal_user_is_forbidden(db_session):
    user = await create_user(db_session, role=UserRole.USER)

    response = await call_admin_endpoint(db_session, create_token(user.id, "access"))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_anonymous_is_unauthenticated(db_session):
    response = await call_admin_endpoint(db_session, token=None)

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"
