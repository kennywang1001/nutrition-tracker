from uuid import uuid4

from app.security.tokens import create_access_token, create_refresh_token, decode_access_token
from tests.factories import create_user


async def test_refresh_returns_a_new_access_token(client, db_session):
    user = await create_user(db_session)
    refresh_token = create_refresh_token(user.id, uuid4())

    response = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})

    assert response.status_code == 200
    body = response.json()
    assert decode_access_token(body["access_token"]) == user.id


async def test_refresh_rejects_an_access_token(client, db_session):
    """拿 access token 來換發，必須被擋下。"""
    user = await create_user(db_session)
    access_token = create_access_token(user.id)

    response = await client.post("/api/auth/refresh", json={"refresh_token": access_token})

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_TOKEN"


async def test_refresh_rejects_garbage(client):
    response = await client.post("/api/auth/refresh", json={"refresh_token": "nope"})

    assert response.status_code == 401


async def test_refresh_rejects_a_token_for_a_deleted_user(client):
    refresh_token = create_refresh_token(999_999, uuid4())

    response = await client.post("/api/auth/refresh", json={"refresh_token": refresh_token})

    assert response.status_code == 401
