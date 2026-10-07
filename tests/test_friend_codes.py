import re

from sqlalchemy import select

from app.cli import create_regular_user
from app.friend_codes import (
    FRIEND_CODE_ALPHABET,
    format_friend_code,
    new_friend_code,
    normalize_friend_code,
)
from app.models.user import User
from app.security.tokens import create_access_token
from tests.factories import create_user

CODE = re.compile(f"[{FRIEND_CODE_ALPHABET}]{{8}}")


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def test_a_new_code_uses_only_the_unambiguous_alphabet():
    assert not set("0O1IL") & set(FRIEND_CODE_ALPHABET)
    for _ in range(200):
        assert CODE.fullmatch(new_friend_code())


def test_codes_are_shown_in_two_groups_and_typed_back_any_way():
    assert format_friend_code("K7MXQ2PD") == "K7MX-Q2PD"
    assert normalize_friend_code(" k7mx-q2pd ") == "K7MXQ2PD"
    assert normalize_friend_code("K7MX Q2PD") == "K7MXQ2PD"


async def test_every_new_user_gets_a_unique_code(db_session):
    users = [await create_user(db_session) for _ in range(5)]

    codes = [user.friend_code for user in users]
    assert all(CODE.fullmatch(code) for code in codes)
    assert len(set(codes)) == 5


async def test_registering_and_the_cli_both_give_a_code(client, db_session, invite_token):
    response = await client.post(
        "/api/auth/register",
        json={
            "email": "coded@example.com",
            "password": "a-good-password",
            "display_name": "有碼",
            "invite_token": invite_token,
        },
    )
    assert response.status_code == 201
    registered = await db_session.scalar(select(User).where(User.email == "coded@example.com"))
    from_cli, _ = await create_regular_user(
        db_session, "cli-coded@example.com", "a-good-password", "命令列"
    )

    assert registered is not None
    assert CODE.fullmatch(registered.friend_code)
    assert CODE.fullmatch(from_cli.friend_code)


async def test_reading_my_code(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/friends/me/code", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == {"code": format_friend_code(user.friend_code)}


async def test_resetting_replaces_the_code(client, db_session):
    user = await create_user(db_session)
    user_id, old_code = user.id, user.friend_code

    response = await client.post("/api/friends/me/code/reset", headers=auth(user))

    assert response.status_code == 200
    new_code = normalize_friend_code(response.json()["code"])
    assert CODE.fullmatch(new_code)
    assert new_code != old_code
    await db_session.rollback()
    stored = await db_session.scalar(select(User.friend_code).where(User.id == user_id))
    assert stored == new_code


async def test_the_code_endpoints_need_login(client):
    assert (await client.get("/api/friends/me/code")).status_code == 401
    assert (await client.post("/api/friends/me/code/reset")).status_code == 401
