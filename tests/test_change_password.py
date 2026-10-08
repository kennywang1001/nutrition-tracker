"""`POST /api/me/password`（規格 §3.2）。"""

import logging
import threading

import pytest
from sqlalchemy import select

from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.ratelimit import PER_EMAIL_LIMIT
from app.security.password import hash_password, verify_password
from tests.factories import DEFAULT_PASSWORD, create_password_reset, create_user

NEW_PASSWORD = "a-brand-new-password"


async def _login(client, email: str, password: str = DEFAULT_PASSWORD):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def _tokens(client, email: str) -> dict[str, str]:
    response = await _login(client, email)
    assert response.status_code == 200
    return response.json()


def _bearer(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _change(
    client, access_token: str, current: str = DEFAULT_PASSWORD, new: str = NEW_PASSWORD
):
    return await client.post(
        "/api/me/password",
        headers=_bearer(access_token),
        json={"current_password": current, "new_password": new},
    )


async def test_every_other_device_is_logged_out_and_this_one_gets_new_tokens(
    client, db_session
):
    user = await create_user(db_session)
    email = user.email
    phone = await _tokens(client, email)
    laptop = await _tokens(client, email)

    response = await _change(client, phone["access_token"])

    assert response.status_code == 200
    fresh = response.json()
    assert fresh["refresh_token"] not in (phone["refresh_token"], laptop["refresh_token"])
    # 第 11 種：撤銷與新 session 都必須真的 commit 了。
    await db_session.rollback()
    for old in (phone, laptop):
        replay = await client.post(
            "/api/auth/refresh", json={"refresh_token": old["refresh_token"]}
        )
        assert replay.status_code == 401
    renewed = await client.post(
        "/api/auth/refresh", json={"refresh_token": fresh["refresh_token"]}
    )
    assert renewed.status_code == 200


async def test_only_the_new_password_works_afterwards(client, db_session):
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)

    await _change(client, tokens["access_token"])
    await db_session.rollback()

    assert (await _login(client, email)).status_code == 401
    assert (await _login(client, email, NEW_PASSWORD)).status_code == 200


async def test_a_wrong_current_password_is_422_and_changes_nothing(client, db_session):
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)

    response = await _change(client, tokens["access_token"], current="not-my-password")

    # **不是 401**：client.ts 對 401 會換票並重送一次——錯的密碼會被驗兩次、算兩次失敗。
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CURRENT_PASSWORD_INCORRECT"
    await db_session.rollback()
    assert (await _login(client, email)).status_code == 200
    still = await client.post(
        "/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]}
    )
    assert still.status_code == 200


async def test_the_same_password_is_422_without_running_argon2(client, db_session, monkeypatch):
    user = await create_user(db_session)
    tokens = await _tokens(client, user.email)
    calls: list[str] = []

    def spy(password: str, password_hash: str) -> bool:
        calls.append(password)
        return verify_password(password, password_hash)

    monkeypatch.setattr("app.api.routes.me.verify_password", spy)

    response = await _change(client, tokens["access_token"], new=DEFAULT_PASSWORD)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PASSWORD_UNCHANGED"
    assert calls == []


async def test_change_password_and_login_share_one_guessing_budget(
    client, db_session, monkeypatch
):
    """偷到 access token 的人不能多一扇猜密碼的門（規格決定 9）。"""
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)  # 成功登入會重置計數，所以先登入
    for _ in range(PER_EMAIL_LIMIT - 2):
        assert (await _login(client, email, "wrong-password")).status_code == 401
    for _ in range(2):
        assert (await _change(client, tokens["access_token"], current="wrong")).status_code == 422

    calls: list[str] = []

    def spy(password: str, password_hash: str) -> bool:
        calls.append(password)
        return verify_password(password, password_hash)

    monkeypatch.setattr("app.api.routes.me.verify_password", spy)

    blocked = await _change(client, tokens["access_token"])

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_LOGIN_ATTEMPTS"
    assert blocked.headers["retry-after"]
    assert calls == []  # 被擋的請求不跑 Argon2
    # 反方向也共用：改密碼的失敗讓登入也被擋。
    assert (await _login(client, email)).status_code == 429


async def test_a_correct_current_password_resets_the_budget(client, db_session):
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)
    for _ in range(PER_EMAIL_LIMIT - 1):
        await _change(client, tokens["access_token"], current="wrong")

    assert (await _change(client, tokens["access_token"])).status_code == 200
    await db_session.rollback()
    for _ in range(PER_EMAIL_LIMIT - 1):
        assert (await _login(client, email, "wrong-password")).status_code == 401


async def test_unused_reset_links_are_revoked(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    reset, _ = await create_password_reset(db_session, user=user, created_by=admin)
    reset_id = reset.id
    tokens = await _tokens(client, user.email)

    await _change(client, tokens["access_token"])
    await db_session.rollback()

    stored = await db_session.scalar(
        select(PasswordResetToken).where(PasswordResetToken.id == reset_id)
    )
    assert stored is not None and stored.revoked_at is not None


async def test_argon2_runs_in_the_threadpool(client, db_session, monkeypatch):
    user = await create_user(db_session)
    tokens = await _tokens(client, user.email)
    main_thread = threading.get_ident()
    seen: list[int] = []

    def verify_spy(password: str, password_hash: str) -> bool:
        seen.append(threading.get_ident())
        return verify_password(password, password_hash)

    def hash_spy(password: str) -> str:
        seen.append(threading.get_ident())
        return hash_password(password)

    monkeypatch.setattr("app.api.routes.me.verify_password", verify_spy)
    monkeypatch.setattr("app.api.routes.me.hash_password", hash_spy)

    assert (await _change(client, tokens["access_token"])).status_code == 200
    assert len(seen) == 2
    assert main_thread not in seen


@pytest.mark.parametrize(
    "body",
    [
        {"current_password": DEFAULT_PASSWORD, "new_password": "short7!"},
        {"current_password": DEFAULT_PASSWORD, "new_password": "x" * 129},
        {"current_password": "", "new_password": NEW_PASSWORD},
        {"new_password": NEW_PASSWORD},
    ],
)
async def test_bad_bodies_are_422(client, db_session, body):
    user = await create_user(db_session)
    tokens = await _tokens(client, user.email)
    response = await client.post(
        "/api/me/password", headers=_bearer(tokens["access_token"]), json=body
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_requires_authentication(client):
    response = await client.post(
        "/api/me/password",
        json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD},
    )
    assert response.status_code == 401


async def test_the_change_is_audited_without_secrets(client, db_session, caplog):
    user = await create_user(db_session)
    user_id, email = user.id, user.email
    tokens = await _tokens(client, email)
    caplog.set_level(logging.INFO, logger="app")

    await _change(client, tokens["access_token"])

    assert f"使用者 {user_id} 修改了密碼" in caplog.text
    for secret in (DEFAULT_PASSWORD, NEW_PASSWORD, email):
        assert secret not in caplog.text
