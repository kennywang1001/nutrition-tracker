from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.invites import INVITE_LIFETIME, hash_invite_token
from app.models.invite import Invite
from app.models.user import UserRole
from app.security.tokens import create_access_token
from tests.factories import create_invite, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_an_admin_creates_an_invite_and_sees_the_token_once(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    admin_id = admin.id  # rollback 之後 admin 會過期，不能再碰屬性

    response = await client.post(
        "/api/admin/invites", headers=auth(admin), json={"note": "給小明"}
    )

    assert response.status_code == 201
    body = response.json()
    token = body["token"]
    assert len(token) >= 40
    assert body["note"] == "給小明"

    # 第 11 種：先 rollback，證明端點真的 commit 了。
    await db_session.rollback()
    stored = await db_session.scalar(select(Invite).where(Invite.id == body["id"]))
    assert stored is not None
    assert stored.token_hash == hash_invite_token(token)
    assert token not in stored.token_hash
    assert stored.created_by == admin_id
    assert stored.expires_at - stored.created_at == INVITE_LIFETIME


async def test_each_invite_gets_its_own_token(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    first = await client.post("/api/admin/invites", headers=auth(admin), json={})
    second = await client.post("/api/admin/invites", headers=auth(admin), json={})

    assert first.json()["token"] != second.json()["token"]


async def test_the_note_is_optional_and_trimmed(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    without = await client.post("/api/admin/invites", headers=auth(admin), json={})
    trimmed = await client.post(
        "/api/admin/invites", headers=auth(admin), json={"note": "  小明  "}
    )

    assert without.status_code == 201
    assert without.json()["note"] is None
    assert trimmed.json()["note"] == "小明"


@pytest.mark.parametrize("note", ["   ", "字" * 51, "A\x00B"])
async def test_a_bad_note_is_422_and_creates_nothing(client, db_session, note):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await client.post(
        "/api/admin/invites", headers=auth(admin), json={"note": note}
    )

    assert response.status_code == 422
    assert await db_session.scalar(select(func.count()).select_from(Invite)) == 0


async def test_regular_users_cannot_create_list_or_revoke(client, db_session):
    user = await create_user(db_session)
    admin = await create_user(db_session, role=UserRole.ADMIN)
    invite, _ = await create_invite(db_session, created_by=admin)

    created = await client.post("/api/admin/invites", headers=auth(user), json={})
    listed = await client.get("/api/admin/invites", headers=auth(user))
    revoked = await client.delete(f"/api/admin/invites/{invite.id}", headers=auth(user))

    for response in (created, listed, revoked):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"
    await db_session.rollback()
    assert await db_session.scalar(select(func.count()).select_from(Invite)) == 1
    await db_session.refresh(invite)
    assert invite.revoked_at is None


async def test_the_list_shows_pending_and_used_invites_but_never_a_token(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session, display_name="小明", email="ming@example.com")
    now = datetime.now(UTC)
    _, pending_token = await create_invite(
        db_session, created_by=admin, note="給阿華", created_at=now - timedelta(hours=1)
    )
    _, used_token = await create_invite(
        db_session,
        created_by=admin,
        note="給小明",
        used_by=friend,
        created_at=now - timedelta(hours=2),
    )
    await create_invite(
        db_session,
        created_by=admin,
        note="過期的",
        created_at=now - timedelta(days=8),
        expires_at=now - timedelta(days=1),
    )
    await create_invite(db_session, created_by=admin, note="撤銷的", revoked=True)

    response = await client.get("/api/admin/invites", headers=auth(admin))

    assert response.status_code == 200
    items = response.json()
    assert [item["note"] for item in items] == ["給阿華", "給小明"]
    assert items[0]["status"] == "pending"
    assert items[0]["used_at"] is None
    assert items[0]["used_by"] is None
    assert items[1]["status"] == "used"
    assert items[1]["used_by"] == {"display_name": "小明", "email": "ming@example.com"}
    assert pending_token not in response.text
    assert used_token not in response.text
    assert all("token" not in item for item in items)


async def test_revoking_a_pending_invite(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    invite, _ = await create_invite(db_session, created_by=admin)

    response = await client.delete(f"/api/admin/invites/{invite.id}", headers=auth(admin))

    assert response.status_code == 204
    await db_session.rollback()
    await db_session.refresh(invite)
    assert invite.revoked_at is not None
    listed = await client.get("/api/admin/invites", headers=auth(admin))
    assert listed.json() == []


async def test_an_expired_unused_invite_can_still_be_revoked(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    now = datetime.now(UTC)
    invite, _ = await create_invite(
        db_session,
        created_by=admin,
        created_at=now - timedelta(days=8),
        expires_at=now - timedelta(days=1),
    )

    response = await client.delete(f"/api/admin/invites/{invite.id}", headers=auth(admin))

    assert response.status_code == 204


async def test_a_used_invite_cannot_be_revoked(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    invite, _ = await create_invite(db_session, created_by=admin, used_by=friend)

    response = await client.delete(f"/api/admin/invites/{invite.id}", headers=auth(admin))

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "INVITE_USED"
    await db_session.rollback()
    await db_session.refresh(invite)
    assert invite.revoked_at is None


async def test_revoking_an_unknown_or_already_revoked_invite_is_404(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    revoked, _ = await create_invite(db_session, created_by=admin, revoked=True)

    again = await client.delete(f"/api/admin/invites/{revoked.id}", headers=auth(admin))
    unknown = await client.delete("/api/admin/invites/999999", headers=auth(admin))

    for response in (again, unknown):
        assert response.status_code == 404
        assert response.json()["error"]["code"] == "INVITE_NOT_FOUND"
