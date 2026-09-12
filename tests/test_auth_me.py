from uuid import uuid4

from app.security.tokens import create_access_token, create_refresh_token
from tests.factories import create_user


async def test_me_returns_the_current_user(client, db_session):
    user = await create_user(db_session, email="me@example.com", display_name="阿明")
    token = create_access_token(user.id)

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == user.id
    assert body["email"] == "me@example.com"
    assert body["display_name"] == "阿明"


async def test_me_requires_a_token(client):
    response = await client.get("/api/me")

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "NOT_AUTHENTICATED"


async def test_me_rejects_a_refresh_token(client, db_session):
    """refresh token 是長效憑證，不可以拿來直接存取 API。"""
    user = await create_user(db_session)
    token = create_refresh_token(user.id, uuid4())

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_TOKEN"


async def test_me_rejects_garbage(client):
    response = await client.get("/api/me", headers={"Authorization": "Bearer not-a-token"})

    assert response.status_code == 401


async def test_me_rejects_a_token_for_a_deleted_user(client):
    """token 簽章有效，但使用者已不存在。"""
    token = create_access_token(999_999)

    response = await client.get("/api/me", headers={"Authorization": f"Bearer {token}"})

    assert response.status_code == 401
