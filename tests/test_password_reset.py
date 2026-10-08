"""`POST /api/auth/password-reset-status`、`POST /api/auth/password-reset`（規格 §3.5、§3.6）。"""

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.password_resets import RESET_INVALID_MESSAGE, new_reset_token
from app.ratelimit import PER_EMAIL_LIMIT
from app.security.password import hash_password
from tests.factories import DEFAULT_PASSWORD, create_password_reset, create_user

NEW_PASSWORD = "reset-new-password"
DEAD_KINDS = ["unknown", "expired", "revoked", "used"]


async def _dead_token(db_session, kind: str) -> str:
    """四種不能用的連結。**過期用時間造**（不是撤銷）：拿掉 `expires_at > now()` 時只有它會紅。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    now = datetime.now(UTC)
    if kind == "unknown":
        return new_reset_token()
    if kind == "expired":
        _, token = await create_password_reset(
            db_session, user=user, created_by=admin,
            created_at=now - timedelta(days=2), expires_at=now - timedelta(seconds=1),
        )
        return token
    if kind == "revoked":
        _, token = await create_password_reset(
            db_session, user=user, created_by=admin, revoked=True
        )
        return token
    if kind == "used":
        _, token = await create_password_reset(db_session, user=user, created_by=admin, used=True)
        return token
    raise AssertionError(kind)


async def _live(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    reset, token = await create_password_reset(db_session, user=user, created_by=admin)
    return user.id, user.email, reset.id, token


async def _reset(client, token: str, new_password: str = NEW_PASSWORD):
    return await client.post(
        "/api/auth/password-reset", json={"token": token, "new_password": new_password}
    )


async def _login(client, email: str, password: str):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def test_a_reset_sets_the_password_uses_the_link_and_logs_out_everywhere(client, db_session):
    user_id, email, reset_id, token = await _live(db_session)
    phone = (await _login(client, email, DEFAULT_PASSWORD)).json()
    laptop = (await _login(client, email, DEFAULT_PASSWORD)).json()

    response = await _reset(client, token)

    assert response.status_code == 204
    await db_session.rollback()  # 第 11 種
    assert (await _login(client, email, DEFAULT_PASSWORD)).status_code == 401
    assert (await _login(client, email, NEW_PASSWORD)).status_code == 200
    stored = await db_session.scalar(
        select(PasswordResetToken).where(PasswordResetToken.id == reset_id)
    )
    assert stored is not None and stored.used_at is not None
    for old in (phone, laptop):
        replay = await client.post(
            "/api/auth/refresh", json={"refresh_token": old["refresh_token"]}
        )
        assert replay.status_code == 401


async def test_a_link_works_only_once(client, db_session):
    _, _, _, token = await _live(db_session)
    assert (await _reset(client, token)).status_code == 204
    again = await _reset(client, token, "yet-another-password")
    assert again.status_code == 403
    assert again.json()["error"]["code"] == "RESET_LINK_INVALID"


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_a_dead_link_is_403_with_one_message(client, db_session, kind):
    token = await _dead_token(db_session, kind)

    response = await _reset(client, token)

    assert response.status_code == 403
    assert response.json()["error"] == {
        "code": "RESET_LINK_INVALID", "message": RESET_INVALID_MESSAGE, "details": {},
    }


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_a_dead_link_never_reaches_argon2(client, db_session, monkeypatch, kind):
    token = await _dead_token(db_session, kind)
    calls: list[str] = []

    def spy(password: str) -> str:
        calls.append(password)
        return hash_password(password)

    monkeypatch.setattr("app.api.routes.auth.hash_password", spy)

    await _reset(client, token)

    assert calls == []


async def test_losing_the_redeem_race_is_403_and_changes_nothing(client, db_session, monkeypatch):
    """查的時候還能用、兌換時已經被別人用掉（或剛被撤銷）。真的並行在 concurrency 檔。"""
    _, email, _, token = await _live(db_session)

    async def lost(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.api.routes.auth.redeem_reset", lost)

    response = await _reset(client, token)

    assert response.status_code == 403
    await db_session.rollback()
    assert (await _login(client, email, DEFAULT_PASSWORD)).status_code == 200


async def test_a_failure_after_redeeming_rolls_back_the_password_and_the_link(
    client, db_session, monkeypatch
):
    """兌換、改密碼、撤銷 session 是同一個交易（規格「差異」第 6 點）：撤銷之前出事，
    前兩件也不能留下來。"""
    _, email, reset_id, token = await _live(db_session)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("撤銷失敗")

    monkeypatch.setattr("app.api.routes.auth.revoke_all_for_user", boom)

    with pytest.raises(RuntimeError):  # 第 31 種：例外直接冒出來，不是 500 的 response
        await _reset(client, token)

    await db_session.rollback()
    stored = await db_session.scalar(
        select(PasswordResetToken).where(PasswordResetToken.id == reset_id)
    )
    assert stored is not None and stored.used_at is None
    assert (await _login(client, email, DEFAULT_PASSWORD)).status_code == 200


async def test_a_successful_reset_clears_the_login_lockout(client, db_session):
    _, email, _, token = await _live(db_session)
    for _ in range(PER_EMAIL_LIMIT):
        await _login(client, email, "wrong-password")
    assert (await _login(client, email, "wrong-password")).status_code == 429

    await _reset(client, token)

    assert (await _login(client, email, NEW_PASSWORD)).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"token": "x", "new_password": "short7!"},
        {"token": "", "new_password": NEW_PASSWORD},
        {"token": "x" * 101, "new_password": NEW_PASSWORD},
        {"new_password": NEW_PASSWORD},
    ],
)
async def test_bad_bodies_are_422(client, body):
    response = await client.post("/api/auth/password-reset", json=body)
    assert response.status_code == 422


async def test_status_is_true_for_a_usable_link_and_does_not_use_it(client, db_session):
    _, _, _, token = await _live(db_session)

    response = await client.post("/api/auth/password-reset-status", json={"token": token})

    assert response.status_code == 200
    assert response.json() == {"valid": True}
    assert (await _reset(client, token)).status_code == 204  # 問過之後還能用


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_status_is_false_for_a_dead_link(client, db_session, kind):
    token = await _dead_token(db_session, kind)
    response = await client.post("/api/auth/password-reset-status", json={"token": token})
    assert response.status_code == 200
    assert response.json() == {"valid": False}


async def test_the_reset_is_audited_without_secrets(client, db_session, caplog):
    user_id, email, reset_id, token = await _live(db_session)
    caplog.set_level(logging.INFO, logger="app")

    await _reset(client, token)

    assert f"使用者 {user_id} 用重設連結重設了密碼（reset_id={reset_id}）" in caplog.text
    for secret in (token, NEW_PASSWORD, email):
        assert secret not in caplog.text
