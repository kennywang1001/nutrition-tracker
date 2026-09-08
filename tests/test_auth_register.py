from sqlalchemy import select

from app.models.user import User, UserRole
from tests.factories import create_user


async def test_register_creates_a_user(client, db_session):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["email"] == "new@example.com"
    assert body["display_name"] == "阿明"
    assert body["role"] == "user"

    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.role is UserRole.USER


async def test_register_never_returns_the_password(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert "password" not in response.text
    assert "password_hash" not in response.json()


async def test_register_stores_a_hash_not_the_plain_password(client, db_session):
    await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.password_hash != "a-good-password"


async def test_register_rejects_a_duplicate_email(client, db_session):
    await create_user(db_session, email="taken@example.com")

    response = await client.post(
        "/api/auth/register",
        json={"email": "taken@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EMAIL_TAKEN"


async def test_register_treats_email_case_insensitively(client, db_session):
    """citext 讓 Taken@example.com 與 taken@example.com 視為同一個帳號。"""
    await create_user(db_session, email="taken@example.com")

    response = await client.post(
        "/api/auth/register",
        json={"email": "TAKEN@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 409


async def test_register_rejects_a_short_password(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "zqxjv", "display_name": "阿明"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    # 錯誤回應不能把使用者送進來的密碼回吐 —— 4xx 的 body 會進到反向代理的存取紀錄、
    # 瀏覽器開發者工具、前端的錯誤回報服務。Task 10 的 handler 會把 input 欄位拿掉。
    assert "zqxjv" not in response.text


async def test_register_rejects_an_invalid_email(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "not-an-email", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 422


async def test_register_rejects_a_nul_byte_in_display_name(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "A\x00B"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_register_rejects_a_whitespace_only_display_name(client):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "   "},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_register_strips_surrounding_whitespace_from_display_name(client):
    response = await client.post(
        "/api/auth/register",
        json={
            "email": "new@example.com",
            "password": "a-good-password",
            "display_name": "  阿明  ",
        },
    )

    assert response.status_code == 201
    assert response.json()["display_name"] == "阿明"


async def test_register_normalises_email_to_lowercase(client, db_session):
    response = await client.post(
        "/api/auth/register",
        json={"email": "NEW@Example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 201
    assert response.json()["email"] == "new@example.com"

    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.email == "new@example.com"


async def test_register_defaults_timezone_to_asia_taipei(client, db_session):
    response = await client.post(
        "/api/auth/register",
        json={"email": "new@example.com", "password": "a-good-password", "display_name": "阿明"},
    )

    assert response.status_code == 201
    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.timezone == "Asia/Taipei"


async def test_register_accepts_an_explicit_timezone(client, db_session):
    response = await client.post(
        "/api/auth/register",
        json={
            "email": "new@example.com",
            "password": "a-good-password",
            "display_name": "阿明",
            "timezone": "America/New_York",
        },
    )

    assert response.status_code == 201
    user = await db_session.scalar(select(User).where(User.email == "new@example.com"))
    assert user is not None
    assert user.timezone == "America/New_York"


async def test_register_rejects_an_unknown_timezone(client):
    response = await client.post(
        "/api/auth/register",
        json={
            "email": "new@example.com",
            "password": "a-good-password",
            "display_name": "阿明",
            "timezone": "Mars/Olympus",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_register_rejects_a_path_traversal_shaped_timezone(client):
    """ZoneInfo("../../etc/passwd") 走的是 ValueError，不是 ZoneInfoNotFoundError ——
    只接後者的話，這個輸入會變成未處理的 500 而不是乾淨的 422。"""
    response = await client.post(
        "/api/auth/register",
        json={
            "email": "new@example.com",
            "password": "a-good-password",
            "display_name": "阿明",
            "timezone": "../../etc/passwd",
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
