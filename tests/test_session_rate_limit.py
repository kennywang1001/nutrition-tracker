import pytest

from app.errors import TooManyRequestsError
from app.ratelimit import SESSION_LIMIT, KeyedRateLimiter
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


async def test_logout_and_refresh_with_the_same_token_share_one_budget(client, db_session):
    token = await _tokens(db_session)

    logouts = [
        await client.post("/api/auth/logout", json={"refresh_token": token})
        for _ in range(SESSION_LIMIT)
    ]
    blocked = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert [r.status_code for r in logouts] == [204] * SESSION_LIMIT
    # 這張票第一次登出就已經撤銷了——超過額度的那一次不是 401，是 429：限速在碰資料庫之前。
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_SESSION_REQUESTS"
    assert int(blocked.headers["Retry-After"]) >= 1


async def test_spamming_an_old_token_does_not_lock_out_the_same_users_fresh_token(
    client, db_session
):
    # 鍵是每張票的 jti，不是 sub：拿到某個使用者一張舊票（撤銷了也一樣驗得過簽章，
    # 14 天內都解得開）的人，狂打只會燒掉那張票自己的額度，不能讓本人換不了票。
    user = await create_user(db_session)
    old = (await start_session(db_session, user.id)).refresh_token
    fresh = (await start_session(db_session, user.id)).refresh_token  # 另一條 family
    spam = [
        await client.post("/api/auth/refresh", json={"refresh_token": old})
        for _ in range(SESSION_LIMIT + 1)
    ]

    response = await client.post("/api/auth/refresh", json={"refresh_token": fresh})

    assert spam[-1].status_code == 429  # 舊票的額度確實用完了
    assert response.status_code == 200


async def test_garbage_tokens_are_not_counted(client, db_session):
    token = await _tokens(db_session)
    # 超過額度的次數：只要亂碼在驗簽之前被算進任何一個鍵（例如「先一律記一次再驗簽」），
    # 第 SESSION_LIMIT + 1 次就會是 429 而不是 401。
    garbage = [
        await client.post("/api/auth/refresh", json={"refresh_token": "not-a-token"})
        for _ in range(SESSION_LIMIT + 1)
    ]

    response = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert [r.status_code for r in garbage] == [401] * (SESSION_LIMIT + 1)
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
    for _ in range(SESSION_LIMIT):
        await client.post("/api/auth/logout", json={"refresh_token": token})

    blocked_logout = await client.post("/api/auth/logout", json={"refresh_token": token})
    blocked_refresh = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert blocked_logout.status_code == 429
    assert blocked_refresh.status_code == 429
    assert calls == ["revoke"] * SESSION_LIMIT
