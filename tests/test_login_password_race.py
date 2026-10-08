"""登入進行到一半，密碼被換掉了（帳號設定審查 I1）。

`login` 讀雜湊 → 在執行緒池跑 Argon2（幾十毫秒）→ 開 session。改密碼、重設連結、CLI 重設
都會「換雜湊＋撤銷這個人所有 session」，但 `revoke_all_for_user` 只撤銷**當下存在**的列：
一個在撤銷之前就驗完**舊**密碼的登入，撤銷之後才插入它的 session——舊密碼換到了一張活票。

**這個檔案不用 `client`／`db_session`，每個請求一條真的連線**（跟正式環境的 `get_db` 一樣）：

- 共用一個 session 時，`login` 手上的 `user` 跟改密碼那個請求改的是 identity map 裡的**同一個
  物件**——「重讀雜湊」寫成讀 `user.password_hash` 也會看到新的值，測試照樣綠；正式環境兩個
  請求各有各的 session，那個寫法讀到的永遠是舊的（handover §6 第 30 種）。
- 鎖的互斥在共用一個交易的夾具裡不存在（第 14 種）。

交錯都是**確定性地建構**的（第 15 種）：用事件把登入停在指定的位置，另一側做完（或直接從
`pg_stat_activity` 看到它卡在鎖上）才放行，不靠自然時序。寫進去的資料是真的 commit 的，
`finally` 自己清（刪使用者會 CASCADE 掉 session 與重設連結）。
"""

import asyncio
import contextlib
import threading
import uuid
from collections.abc import AsyncIterator, Awaitable, Callable
from datetime import UTC, datetime

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient, Response
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.api.routes import auth as auth_routes
from app.cli import create_regular_user
from app.db import get_db
from app.main import app
from app.models.password_reset import PasswordResetToken
from app.models.session import RefreshSession
from app.models.user import User, UserRole
from app.password_resets import RESET_LIFETIME, hash_reset_token, new_reset_token
from app.ratelimit import PER_EMAIL_LIMIT
from app.security.password import hash_password, verify_password
from app.security.tokens import decode_refresh_token
from tests.conftest import TEST_DATABASE_URL
from tests.factories import DEFAULT_PASSWORD

NEW_PASSWORD = "a-brand-new-password"

_RAW_DSN = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")

Sessions = async_sessionmaker[AsyncSession]


@pytest_asyncio.fixture
async def independent_sessions(migrated_database: None) -> AsyncIterator[Sessions]:
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


@pytest_asyncio.fixture
async def real_client(independent_sessions: Sessions) -> AsyncIterator[AsyncClient]:
    """每個請求自己開一個 session、自己的連線與交易——跟 `app/db.py` 的 `get_db` 同一個形狀。"""

    async def per_request_db() -> AsyncIterator[AsyncSession]:
        async with independent_sessions() as session:
            yield session

    app.dependency_overrides[get_db] = per_request_db
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as c:
            yield c
    finally:
        app.dependency_overrides.clear()


class Account:
    def __init__(self, user_id: int, email: str, admin_id: int) -> None:
        self.user_id = user_id
        self.email = email
        self.admin_id = admin_id


@pytest_asyncio.fixture
async def account(independent_sessions: Sessions) -> AsyncIterator[Account]:
    """一個一般使用者（密碼是 `DEFAULT_PASSWORD`）與一個管理員（重設連結的 `created_by`）。"""
    tag = uuid.uuid4().hex
    user = User(
        email=f"login-race-{tag}@example.com",
        password_hash=hash_password(DEFAULT_PASSWORD),
        display_name="登入競態",
    )
    admin = User(
        email=f"login-race-admin-{tag}@example.com",
        password_hash="not-a-real-hash",
        display_name="管理員",
        role=UserRole.ADMIN,
    )
    async with independent_sessions() as setup:
        setup.add_all([user, admin])
        await setup.commit()
    try:
        yield Account(user.id, user.email, admin.id)
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id.in_([user.id, admin.id])))
            await cleanup.commit()


async def _login(client: AsyncClient, email: str, password: str = DEFAULT_PASSWORD) -> Response:
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def _session_rows(sessions: Sessions, user_id: int) -> dict[uuid.UUID, bool]:
    """這個人的每一列 session：`jti` → 還活著嗎（沒用過、沒撤銷）。"""
    async with sessions() as s:
        rows = (
            await s.scalars(select(RefreshSession).where(RefreshSession.user_id == user_id))
        ).all()
    return {row.jti: row.used_at is None and row.revoked_at is None for row in rows}


# --- 三種「密碼被換掉」的路，每一種都回傳「做完之後應該還活著的 jti」 -------------------


async def _change_password(client: AsyncClient, sessions: Sessions, account: Account) -> None:
    tokens = (await _login(client, account.email)).json()
    response = await client.post(
        "/api/me/password",
        headers={"Authorization": f"Bearer {tokens['access_token']}"},
        json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD},
    )
    assert response.status_code == 200


async def _reset_with_a_link(client: AsyncClient, sessions: Sessions, account: Account) -> None:
    token = new_reset_token()
    now = datetime.now(UTC)
    async with sessions() as s:
        s.add(
            PasswordResetToken(
                user_id=account.user_id,
                token_hash=hash_reset_token(token),
                created_by=account.admin_id,
                created_at=now,
                expires_at=now + RESET_LIFETIME,
            )
        )
        await s.commit()
    response = await client.post(
        "/api/auth/password-reset", json={"token": token, "new_password": NEW_PASSWORD}
    )
    assert response.status_code == 204


async def _reset_from_the_cli(client: AsyncClient, sessions: Sessions, account: Account) -> None:
    async with sessions() as s:
        _, created = await create_regular_user(s, account.email, NEW_PASSWORD, "登入競態")
    assert created is False


PasswordChanger = Callable[[AsyncClient, Sessions, Account], Awaitable[None]]
CHANGERS: list[PasswordChanger] = [_change_password, _reset_with_a_link, _reset_from_the_cli]


@contextlib.asynccontextmanager
async def _login_paused_after_verifying(
    client: AsyncClient, monkeypatch: pytest.MonkeyPatch, email: str
) -> AsyncIterator["asyncio.Task[Response]"]:
    """用**舊**密碼送出一個登入，把它停在「Argon2 驗完了、還沒往下走」的位置；離開這個
    區塊時放行。只擋第一次呼叫——區塊裡的改密碼自己也要先登入一次。"""
    loop = asyncio.get_running_loop()
    # `verify_password` 在執行緒池裡跑：「走到了」要丟回 event loop 才能 await，
    # 「可以走了」是那條執行緒自己在等的。
    entered, gate = asyncio.Event(), threading.Event()
    first_call = threading.Lock()

    def slow_verify(password: str, password_hash: str) -> bool:
        ok = verify_password(password, password_hash)
        if first_call.acquire(blocking=False):
            loop.call_soon_threadsafe(entered.set)
            gate.wait(15)
        return ok

    monkeypatch.setattr(auth_routes, "verify_password", slow_verify)
    login = asyncio.create_task(_login(client, email))
    try:
        async with asyncio.timeout(10):
            # 等的是一個事實（那條執行緒真的驗完了），不是 sleep 一段時間用猜的。
            await entered.wait()
        yield login
    finally:
        gate.set()


@pytest.mark.parametrize("change", CHANGERS, ids=lambda f: f.__name__.strip("_"))
async def test_a_login_verified_against_the_old_password_gets_no_session_once_it_changed(
    real_client, independent_sessions, account, monkeypatch, change
):
    async with _login_paused_after_verifying(real_client, monkeypatch, account.email) as login:
        await change(real_client, independent_sessions, account)
        before = await _session_rows(independent_sessions, account.user_id)

    response = await login

    # 跟密碼打錯一模一樣的回應——送出這個請求的人分不出「舊密碼剛剛還是對的」。
    assert response.status_code == 401
    assert response.json()["error"] == {
        "code": "INVALID_CREDENTIALS",
        "message": "email 或密碼不正確",
        "details": {},
    }
    # 那個登入**一列都沒有留下**（連「插了又被撤銷」都沒有），活著的只有改密碼自己開的那一條。
    assert await _session_rows(independent_sessions, account.user_id) == before
    # 新密碼登得進去：換雜湊那一邊沒有被這個登入拖累。
    assert (await _login(real_client, account.email, NEW_PASSWORD)).status_code == 200


async def test_the_overtaken_login_counts_as_a_failed_attempt(
    real_client, independent_sessions, account, monkeypatch
):
    """**刻意的決定**：驗完才發現密碼已經換掉的登入，在限速器眼裡就是一次密碼錯誤。

    它送的密碼在回應的那一刻已經不是這個帳號的密碼；不算失敗的話，「401 但沒有扣額度」本身
    就是一個訊號（剛剛那個舊密碼是對的），而拿著外洩的舊密碼搶時間的人正好不該多拿到額度。
    重設成功會清掉這個 email 的計數，所以這裡從 0 開始數：這一次＋(上限−1) 次真的打錯，
    下一次就該被擋。不算的話，下一次還是 401。
    """
    async with _login_paused_after_verifying(real_client, monkeypatch, account.email) as login:
        await _reset_with_a_link(real_client, independent_sessions, account)
    assert (await login).status_code == 401

    for _ in range(PER_EMAIL_LIMIT - 1):
        assert (await _login(real_client, account.email, "not-the-password")).status_code == 401

    assert (await _login(real_client, account.email, "not-the-password")).status_code == 429


async def _until_done_or_waiting_on_a_lock(task: "asyncio.Task[Response]") -> None:
    """等到 `task` 做完，或者資料庫裡有一條連線卡在鎖上——哪一個先發生都算（直接觀察
    `pg_stat_activity`，同 `tests/test_sessions_concurrency.py`；這個檔案的測試一次只跑一個，
    卡住的只可能是自己開的連線）。"""
    raw = await asyncpg.connect(_RAW_DSN)
    try:
        async with asyncio.timeout(10):
            while not task.done():
                waiting = await raw.fetchrow(
                    "SELECT 1 FROM pg_stat_activity "
                    "WHERE datname = current_database() AND wait_event_type = 'Lock'"
                )
                if waiting is not None:
                    return
                await asyncio.sleep(0.005)
    finally:
        await raw.close()


async def _change_password_with(client: AsyncClient, access_token: str) -> Response:
    return await client.post(
        "/api/me/password",
        headers={"Authorization": f"Bearer {access_token}"},
        json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD},
    )


async def test_the_hash_is_reread_only_after_the_lock_is_held(
    real_client, independent_sessions, account, monkeypatch
):
    """順序是「取鎖 → 重讀雜湊」，不能反過來。

    反過來的話：重讀（還是舊的）→ 改密碼整個做完（換雜湊、撤銷、commit）→ 取鎖 → 插入——
    鎖拿到了，但它保護的那個判斷是拿鎖之前做的。這裡把登入停在**取鎖的前一刻**，等改密碼
    整個做完才放行：正確的順序會讀到新的雜湊 → 401。
    """
    tokens = (await _login(real_client, account.email)).json()
    real_lock = auth_routes.lock_user_sessions
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused_lock(db: AsyncSession, user_id: int) -> None:
        reached.set()
        await release.wait()
        await real_lock(db, user_id)

    monkeypatch.setattr(auth_routes, "lock_user_sessions", paused_lock)
    login = asyncio.create_task(_login(real_client, account.email))
    arrived = asyncio.create_task(reached.wait())
    try:
        # 登入先做完了（沒有走到取鎖那一行）也要醒來，不然少了鎖的時候這裡只會逾時。
        await asyncio.wait({login, arrived}, timeout=10, return_when=asyncio.FIRST_COMPLETED)
        arrived.cancel()
        assert reached.is_set(), "login 驗完密碼之後沒有取每使用者的 session 鎖"
        changed = await _change_password_with(real_client, tokens["access_token"])
        assert changed.status_code == 200
        before = await _session_rows(independent_sessions, account.user_id)
    finally:
        release.set()

    response = await login

    assert response.status_code == 401
    assert response.json()["error"]["code"] == "INVALID_CREDENTIALS"
    assert await _session_rows(independent_sessions, account.user_id) == before


async def test_a_login_that_won_the_lock_is_revoked_by_the_password_change_behind_it(
    real_client, independent_sessions, account, monkeypatch
):
    """另一個方向：登入先拿到鎖、重讀時密碼還沒換（它是合法的），改密碼排在它後面。

    登入握著鎖直到它的 session commit，改密碼的撤銷在鎖上等它——等到之後那一列已經看得見，
    一起被撤銷。少了鎖（或鎖在插入之前就放掉）：改密碼不用等，撤銷時那一列還不存在；登入
    之後才插入，舊密碼換到的票就活下來了。

    把登入停在**重讀之後、開 session 之前**，等到改密碼做完（沒有鎖）或真的卡在鎖上（有鎖）
    才放行。
    """
    tokens = (await _login(real_client, account.email)).json()
    real_start_session = auth_routes.start_session
    reached, release = asyncio.Event(), asyncio.Event()

    async def paused_start_session(db: AsyncSession, user_id: int):  # type: ignore[no-untyped-def]
        reached.set()
        await release.wait()
        return await real_start_session(db, user_id)

    monkeypatch.setattr(auth_routes, "start_session", paused_start_session)
    login = asyncio.create_task(_login(real_client, account.email))
    try:
        async with asyncio.timeout(10):
            await reached.wait()
        change = asyncio.create_task(_change_password_with(real_client, tokens["access_token"]))
        await _until_done_or_waiting_on_a_lock(change)
    finally:
        release.set()

    logged_in, changed = await asyncio.gather(login, change)

    # 這個登入是合法的：它重讀的時候密碼還是舊的。
    assert logged_in.status_code == 200
    assert changed.status_code == 200
    # **重點**：它拿到的那張票，改密碼之後不能還活著。
    overtaken = decode_refresh_token(logged_in.json()["refresh_token"]).jti
    survivor = decode_refresh_token(changed.json()["refresh_token"]).jti
    rows = await _session_rows(independent_sessions, account.user_id)
    assert rows[overtaken] is False, "舊密碼登入的 session 逃過了改密碼的撤銷"
    assert [jti for jti, live in rows.items() if live] == [survivor]
