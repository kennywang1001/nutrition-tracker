import pytest

from app.errors import TooManyRequestsError
from app.ratelimit import KeyedRateLimiter
from app.security.sessions import start_session
from tests.factories import create_user


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _limiter(clock: _FakeClock) -> KeyedRateLimiter:
    return KeyedRateLimiter(
        limit=3, window_seconds=60, code="SLOW_DOWN", message="慢一點", clock=clock
    )


def test_the_limit_counts_every_hit_per_key_and_resets_after_the_window():
    clock = _FakeClock()
    limiter = _limiter(clock)

    for _ in range(3):
        limiter.hit("alice")
    with pytest.raises(TooManyRequestsError) as blocked:
        limiter.hit("alice")
    limiter.hit("bob")  # 別人的額度不受影響

    assert blocked.value.code == "SLOW_DOWN"
    assert blocked.value.retry_after_seconds == 60
    clock.now = 60.0
    limiter.hit("alice")  # 視窗過了


def test_reset_clears_every_key():
    limiter = _limiter(_FakeClock())
    for _ in range(3):
        limiter.hit("alice")

    limiter.reset()

    limiter.hit("alice")


async def _tokens(db_session):
    user = await create_user(db_session)
    issued = await start_session(db_session, user.id)
    return issued.refresh_token


async def test_logout_and_refresh_share_ten_requests_per_user_a_minute(client, db_session):
    token = await _tokens(db_session)

    logouts = [
        await client.post("/api/auth/logout", json={"refresh_token": token}) for _ in range(10)
    ]
    blocked = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert [r.status_code for r in logouts] == [204] * 10
    # 這張票第一次登出就已經撤銷了——第 11 次不是 401，是 429：限速在碰資料庫之前。
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_SESSION_REQUESTS"
    assert int(blocked.headers["Retry-After"]) >= 1


async def test_another_user_is_not_affected(client, db_session):
    spammed = await _tokens(db_session)
    other = await _tokens(db_session)
    for _ in range(10):
        await client.post("/api/auth/logout", json={"refresh_token": spammed})

    response = await client.post("/api/auth/refresh", json={"refresh_token": other})

    assert response.status_code == 200


async def test_garbage_tokens_are_not_counted(client, db_session):
    token = await _tokens(db_session)
    garbage = [
        await client.post("/api/auth/refresh", json={"refresh_token": "not-a-token"})
        for _ in range(20)
    ]

    response = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert {r.status_code for r in garbage} == {401}
    assert response.status_code == 200


async def test_a_blocked_request_never_reaches_the_database(client, db_session, monkeypatch):
    token = await _tokens(db_session)
    calls: list[str] = []

    async def spy_revoke(db, refresh_token):
        calls.append("revoke")

    async def spy_rotate(db, refresh_token):
        calls.append("rotate")
        raise AssertionError("被擋的請求不該走到這裡")

    monkeypatch.setattr("app.api.routes.auth.revoke_session", spy_revoke)
    monkeypatch.setattr("app.api.routes.auth.rotate_session", spy_rotate)
    for _ in range(10):
        await client.post("/api/auth/logout", json={"refresh_token": token})

    blocked_logout = await client.post("/api/auth/logout", json={"refresh_token": token})
    blocked_refresh = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert blocked_logout.status_code == 429
    assert blocked_refresh.status_code == 429
    assert calls == ["revoke"] * 10
