from app.security.tokens import decode_access_token, decode_refresh_token
from tests.factories import DEFAULT_PASSWORD, create_user


async def test_login_returns_tokens(client, db_session):
    user = await create_user(db_session, email="me@example.com")

    response = await client.post(
        "/api/auth/login",
        json={"email": "me@example.com", "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["token_type"] == "bearer"
    assert decode_access_token(body["access_token"]) == user.id
    assert decode_refresh_token(body["refresh_token"]).user_id == user.id


async def test_login_rejects_a_wrong_password(client, db_session):
    await create_user(db_session, email="me@example.com")

    response = await client.post(
        "/api/auth/login",
        json={"email": "me@example.com", "password": "wrong-password"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


async def test_login_rejects_an_unknown_email(client):
    response = await client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "any-password"},
    )

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"


async def test_login_does_not_reveal_whether_an_email_exists(client, db_session):
    """帳號不存在與密碼錯誤必須回完全相同的訊息。

    否則攻擊者可以用不同的錯誤訊息，逐一測出系統裡有哪些 email 註冊過。
    """
    await create_user(db_session, email="me@example.com")

    wrong_password = await client.post(
        "/api/auth/login",
        json={"email": "me@example.com", "password": "wrong-password"},
    )
    unknown_email = await client.post(
        "/api/auth/login",
        json={"email": "nobody@example.com", "password": "wrong-password"},
    )

    assert wrong_password.status_code == unknown_email.status_code
    assert wrong_password.json() == unknown_email.json()


async def test_login_is_case_insensitive_on_email(client, db_session):
    await create_user(db_session, email="me@example.com")

    response = await client.post(
        "/api/auth/login",
        json={"email": "ME@EXAMPLE.COM", "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
