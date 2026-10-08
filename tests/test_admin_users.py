"""`GET /api/admin/users`、`POST /api/admin/users/{id}/password-reset`（規格 §3.3、§3.4）。"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.password_resets import find_usable_reset, hash_reset_token
from app.security.tokens import create_access_token
from tests.factories import create_password_reset, create_user


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


async def _links(db_session, user_id: int) -> list[PasswordResetToken]:
    return list(
        (
            await db_session.scalars(
                select(PasswordResetToken)
                .where(PasswordResetToken.user_id == user_id)
                .order_by(PasswordResetToken.id)
            )
        ).all()
    )


async def test_regular_users_get_403_on_both(client, db_session):
    member = await create_user(db_session)
    other = await create_user(db_session)

    listed = await client.get("/api/admin/users", headers=auth(member.id))
    created = await client.post(
        f"/api/admin/users/{other.id}/password-reset", headers=auth(member.id)
    )

    for response in (listed, created):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_the_list_has_every_account_in_id_order(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN, display_name="管理員")
    friend = await create_user(db_session, display_name="小明")

    response = await client.get("/api/admin/users", headers=auth(admin.id))

    assert response.status_code == 200
    items = response.json()
    assert len(items) >= 2
    ids = [item["id"] for item in items]
    assert ids == sorted(ids)
    mine = {item["id"]: item for item in items}
    assert mine[friend.id] == {
        "id": friend.id, "email": friend.email, "display_name": "小明", "role": "user",
    }
    assert mine[admin.id]["role"] == "admin"


async def test_creating_a_link_returns_the_token_once_and_stores_only_its_hash(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    admin_id, friend_id = admin.id, friend.id

    response = await client.post(
        f"/api/admin/users/{friend_id}/password-reset", headers=auth(admin_id)
    )

    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"token", "expires_at"}
    token = body["token"]
    await db_session.rollback()  # 第 11 種
    (stored,) = await _links(db_session, friend_id)
    assert stored.token_hash == hash_reset_token(token) != token
    assert stored.created_by == admin_id
    assert stored.expires_at - stored.created_at == timedelta(hours=24)
    assert await find_usable_reset(db_session, token) is not None


async def test_a_new_link_revokes_the_previous_one(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    admin_id, friend_id = admin.id, friend.id

    url = f"/api/admin/users/{friend_id}/password-reset"
    first = await client.post(url, headers=auth(admin_id))
    second = await client.post(url, headers=auth(admin_id))

    assert (first.status_code, second.status_code) == (201, 201)
    await db_session.rollback()
    assert await find_usable_reset(db_session, first.json()["token"]) is None
    assert await find_usable_reset(db_session, second.json()["token"]) is not None


async def test_an_expired_unrevoked_link_does_not_block_a_new_one(client, db_session):
    """過期但沒撤銷的那條仍然算「活的」（部分唯一索引不看時間）——要先被撤銷掉。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    now = datetime.now(UTC)
    await create_password_reset(
        db_session, user=friend, created_by=admin,
        created_at=now - timedelta(days=2), expires_at=now - timedelta(days=1),
    )

    response = await client.post(
        f"/api/admin/users/{friend.id}/password-reset", headers=auth(admin.id)
    )

    assert response.status_code == 201


async def test_no_links_for_admin_accounts_including_your_own(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    other_admin = await create_user(db_session, role=UserRole.ADMIN)
    admin_id, other_admin_id = admin.id, other_admin.id

    for target_id in (admin_id, other_admin_id):
        response = await client.post(
            f"/api/admin/users/{target_id}/password-reset", headers=auth(admin_id)
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "RESET_NOT_FOR_ADMINS"
    await db_session.rollback()
    assert await _links(db_session, admin_id) == []
    assert await _links(db_session, other_admin_id) == []


async def test_an_unknown_user_is_404_with_its_own_code(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await client.post(
        "/api/admin/users/999999999/password-reset", headers=auth(admin.id)
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "USER_NOT_FOUND"  # 第 32 種：不是路由不存在


async def test_creating_a_link_is_audited_without_the_token(client, db_session, caplog):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    admin_id, friend_id, email = admin.id, friend.id, friend.email
    caplog.set_level(logging.INFO, logger="app")

    response = await client.post(
        f"/api/admin/users/{friend_id}/password-reset", headers=auth(admin_id)
    )

    assert f"管理員 {admin_id} 產生了使用者 {friend_id} 的重設密碼連結" in caplog.text
    assert response.json()["token"] not in caplog.text
    assert email not in caplog.text
