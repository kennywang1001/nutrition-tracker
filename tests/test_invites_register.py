from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.invites import INVITE_INVALID_MESSAGE, new_invite_token
from app.models.user import User, UserRole
from tests.factories import create_invite, create_user

DEAD_KINDS = ["unknown", "expired", "revoked", "used"]


def _body(token: str, email: str = "friend@example.com") -> dict[str, str]:
    return {
        "email": email,
        "password": "a-good-password",
        "display_name": "小明",
        "invite_token": token,
    }


async def _user_count(db_session) -> int:
    return await db_session.scalar(select(func.count()).select_from(User))


async def _dead_token(db_session, kind: str) -> str:
    """四種不能用的邀請。**過期用時間造**（不是撤銷）：拿掉 `expires_at > now()`
    的條件時，只有這一種會變紅。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    now = datetime.now(UTC)
    if kind == "unknown":
        return new_invite_token()
    if kind == "expired":
        _, token = await create_invite(
            db_session,
            created_by=admin,
            created_at=now - timedelta(days=8),
            expires_at=now - timedelta(days=1),
        )
        return token
    if kind == "revoked":
        _, token = await create_invite(db_session, created_by=admin, revoked=True)
        return token
    if kind == "used":
        friend = await create_user(db_session)
        _, token = await create_invite(db_session, created_by=admin, used_by=friend)
        return token
    raise AssertionError(kind)


async def test_register_redeems_the_invite(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    invite, token = await create_invite(db_session, created_by=admin)

    response = await client.post("/api/auth/register", json=_body(token))

    assert response.status_code == 201
    # 第 11 種：先 rollback，證明使用者與邀請的兌換都真的 commit 了。
    await db_session.rollback()
    user = await db_session.scalar(select(User).where(User.email == "friend@example.com"))
    assert user is not None
    await db_session.refresh(invite)
    assert invite.used_by == user.id
    assert invite.used_at is not None


async def test_register_without_an_invite_is_422_and_creates_nobody(client, db_session):
    before = await _user_count(db_session)

    response = await client.post(
        "/api/auth/register",
        json={"email": "friend@example.com", "password": "a-good-password", "display_name": "小明"},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    assert await _user_count(db_session) == before


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_register_with_a_dead_invite_is_403_and_creates_nobody(client, db_session, kind):
    token = await _dead_token(db_session, kind)
    before = await _user_count(db_session)

    response = await client.post("/api/auth/register", json=_body(token))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "INVITE_INVALID"
    assert response.json()["error"]["message"] == INVITE_INVALID_MESSAGE
    await db_session.rollback()
    assert await _user_count(db_session) == before


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_a_dead_invite_never_reaches_argon2(client, db_session, monkeypatch, kind):
    token = await _dead_token(db_session, kind)
    calls: list[str] = []

    def _recording_hash(password: str) -> str:
        calls.append(password)
        return "not-a-real-hash"

    monkeypatch.setattr("app.api.routes.auth.hash_password", _recording_hash)

    response = await client.post("/api/auth/register", json=_body(token))

    assert response.status_code == 403
    assert calls == []


async def test_an_email_clash_does_not_use_up_the_invite(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    await create_user(db_session, email="taken@example.com")
    _, token = await create_invite(db_session, created_by=admin)

    clash = await client.post("/api/auth/register", json=_body(token, email="taken@example.com"))
    retry = await client.post("/api/auth/register", json=_body(token, email="fresh@example.com"))

    assert clash.status_code == 409
    assert clash.json()["error"]["code"] == "EMAIL_TAKEN"
    assert retry.status_code == 201


async def test_losing_the_redeem_race_is_403_and_creates_nobody(client, db_session, monkeypatch):
    """查的時候邀請還能用，條件式 UPDATE 卻落空（被別人搶先用掉、或剛好被撤銷）。
    `redeem_invite` 真的會落空由 `tests/test_invites_concurrency.py` 證明；這裡證明
    端點在它落空時 rollback、回 INVITE_INVALID（計畫「與規格的差異」第 1 點）。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    _, token = await create_invite(db_session, created_by=admin)
    before = await _user_count(db_session)

    async def _lost_the_race(*args: object, **kwargs: object) -> bool:
        return False

    monkeypatch.setattr("app.api.routes.auth.redeem_invite", _lost_the_race)

    response = await client.post("/api/auth/register", json=_body(token))

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "INVITE_INVALID"
    # rollback 之前先看：測試與端點共用一個 session，端點若沒有 rollback，它 flush
    # 出去的使用者在這裡看得到（下面那行 rollback 會把它一起收掉，證明不了什麼）。
    assert await db_session.scalar(select(User).where(User.email == "friend@example.com")) is None
    await db_session.rollback()
    assert await _user_count(db_session) == before


async def test_losing_the_email_race_is_409_and_does_not_use_up_the_invite(
    client, db_session, monkeypatch
):
    """兩個請求同時用同一個 email：步驟 2 都沒看到對方，另一個先 commit。不靠真的並發——
    在步驟 2 之後、flush 之前（Argon2 那一步）讓「另一個請求」把同一個 email 寫進去。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    invite, token = await create_invite(db_session, created_by=admin)

    async def _someone_else_registers_first(func, *args):
        await create_user(db_session, email="friend@example.com")
        return func(*args)

    monkeypatch.setattr("app.api.routes.auth.run_in_threadpool", _someone_else_registers_first)

    response = await client.post("/api/auth/register", json=_body(token))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EMAIL_TAKEN"
    await db_session.rollback()
    await db_session.refresh(invite)
    assert invite.used_at is None
    assert invite.used_by is None


async def test_invite_status_is_true_for_a_usable_invite_and_does_not_use_it(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    invite, token = await create_invite(db_session, created_by=admin)

    response = await client.post("/api/auth/invite-status", json={"token": token})

    assert response.status_code == 200
    assert response.json() == {"valid": True}
    await db_session.refresh(invite)
    assert invite.used_at is None


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_invite_status_is_false_for_a_dead_invite(client, db_session, kind):
    token = await _dead_token(db_session, kind)

    response = await client.post("/api/auth/invite-status", json={"token": token})

    assert response.status_code == 200
    assert response.json() == {"valid": False}
