import asyncio
import os
import subprocess
import sys
from collections.abc import AsyncIterator

import asyncpg
import pytest
import pytest_asyncio
from httpx import ASGITransport, AsyncClient
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession, create_async_engine

from app.db import get_db
from app.main import app

TEST_DATABASE_URL = os.environ.get(
    "TEST_DATABASE_URL",
    "postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test",
)

# 這組 fixture 有四個已知邊界，之後的 task 要記得：
#
# 1. `client` 只覆寫 `get_db`。之後如果有哪個依賴自己另外開資料庫連線
#    （沒有走 `get_db`），它的寫入就跑在交易隔離外面，測試之間會互相污染。
#    所有資料庫存取都必須經過 `get_db`。
# 2. `app.dependency_overrides.clear()` 會清掉全部覆寫，不只 `get_db`。
#    目前只有一個覆寫所以沒差；哪天有 fixture 想在 `client` 之上再疊一層覆寫，
#    要記得這件事。
# 3. 每個測試都會新建一個 engine。正確但不省，測試數量長到幾百個時
#    會感覺得出來。那時再改成 session 級 engine，現在不用。
# 4. 任何 route 如果接住了 `db.commit()` 丟出來的例外（例如 IntegrityError），
#    一定要 `await db.rollback()` 才能再用這個 session——不然接下來不管是
#    同一個測試裡的下一次 `client` 呼叫，還是直接查 `db_session`，都會炸
#    `PendingRollbackError`，而且看起來跟真正的原因完全無關。production 的
#    SessionLocal 是 per-request 的，這個副作用不會累積；測試的 session 是
#    整個測試共用，一次沒 rollback 就會拖垮同一個測試後面所有的資料庫操作。


async def _ensure_test_database_exists() -> None:
    """連到 postgres 這個預設資料庫，建立測試資料庫（若不存在）。"""
    base, db_name = TEST_DATABASE_URL.rsplit("/", 1)
    admin_dsn = base.replace("postgresql+asyncpg://", "postgresql://") + "/postgres"

    connection = await asyncpg.connect(admin_dsn)
    try:
        exists = await connection.fetchval(
            "SELECT 1 FROM pg_database WHERE datname = $1", db_name
        )
        if not exists:
            await connection.execute(f'CREATE DATABASE "{db_name}"')
    finally:
        await connection.close()


@pytest.fixture(scope="session")
def migrated_database() -> None:
    """整個測試 session 只跑一次：建立測試資料庫並套用所有 migration。"""
    asyncio.run(_ensure_test_database_exists())
    env = {**os.environ, "DATABASE_URL": TEST_DATABASE_URL}

    # 用 [sys.executable, "-m", "alembic", ...] 而不是規格裡的 "alembic"：
    # venv 沒有被 activate，PATH 上不一定找得到 alembic 這個指令本身，
    # 但 sys.executable 一定是目前這個 venv 的 python.exe，"-m alembic"
    # 保證用的是同一個環境裝的 alembic。Linux CI 上 venv 在 PATH 上，
    # 這個寫法一樣成立，所以不影響 Task 17 的可攜性。
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        check=True,
        env=env,
    )

    # upgrade head 只看 revision id，不看內容。
    # 如果某個 migration 檔案被原地改過（開發中很常見——0001 本身就已經被
    # 原地改過兩次），revision id 沒變，upgrade head 就什麼都不做、直接成功，
    # 然後整套測試在舊 schema 上跑，而且完全沒有跡象。alembic check 比對的是
    # 「實際 schema vs Base.metadata」，所以抓得到這種漂移，並且在 session
    # 一開始就大聲失敗，而不是讓測試在錯的 schema 上悄悄跑完。
    subprocess.run(
        [sys.executable, "-m", "alembic", "check"],
        check=True,
        env=env,
    )


@pytest_asyncio.fixture
async def db_connection(migrated_database: None) -> AsyncIterator[AsyncConnection]:
    """每個測試開一個外層交易，測試結束整個 rollback。

    這就是測試隔離的核心：測試裡即使呼叫了 commit，也只是 commit 到
    savepoint，最外層交易一 rollback，資料庫就回到測試開始前的狀態。
    因此測試之間互不干擾，也完全不需要手動清資料。
    """
    engine = create_async_engine(TEST_DATABASE_URL)
    async with engine.connect() as connection:
        transaction = await connection.begin()
        try:
            yield connection
        finally:
            await transaction.rollback()
    await engine.dispose()


@pytest_asyncio.fixture
async def db_session(db_connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    session = AsyncSession(
        bind=db_connection,
        join_transaction_mode="create_savepoint",
        # 跟 app/db.py 的 SessionLocal 一致。少了這個，commit 之後物件屬性會過期，
        # 下次同步存取就炸 MissingGreenlet，而錯誤訊息完全看不出是這個原因。
        expire_on_commit=False,
    )
    try:
        yield session
    finally:
        await session.close()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """讓 API 使用測試的 session，這樣 API 寫入的資料也會被 rollback。"""

    # 這裡刻意不模仿 app/db.py 的 `async with SessionLocal() as session: yield session`
    # 寫法。那個 session 是 request 範圍的，request 結束（不管成功還失敗）關掉它是對的。
    # 這裡的 db_session 是「整個測試」範圍的，是 db_session fixture 擁有、要活過
    # 這一次 request 的——如果改成 async with 或加 .close()，FastAPI 每次 request
    # 結束（包含錯誤路徑）都會把它關掉，下一次在同一個測試裡再用 db_session 就會爆炸。
    # Task 11 測重複 email 的錯誤路徑就是靠這個行為才能過，不要「順手修正」。
    async def override_get_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    try:
        async with AsyncClient(transport=transport, base_url="http://test") as async_client:
            yield async_client
    finally:
        # 用 try/finally 而不是只放在 async with 後面：就算 __aexit__ 本身丟例外，
        # override 也一定會被清掉，不會漏到下一個測試。目前沒有證據這會發生，
        # 純粹是防禦性寫法。
        app.dependency_overrides.clear()
