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
    # 用 [sys.executable, "-m", "alembic", ...] 而不是規格裡的 "alembic"：
    # venv 沒有被 activate，PATH 上不一定找得到 alembic 這個指令本身，
    # 但 sys.executable 一定是目前這個 venv 的 python.exe，"-m alembic"
    # 保證用的是同一個環境裝的 alembic。Linux CI 上 venv 在 PATH 上，
    # 這個寫法一樣成立，所以不影響 Task 17 的可攜性。
    subprocess.run(
        [sys.executable, "-m", "alembic", "upgrade", "head"],
        check=True,
        env={**os.environ, "DATABASE_URL": TEST_DATABASE_URL},
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
    session = AsyncSession(bind=db_connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        await session.close()


@pytest_asyncio.fixture
async def client(db_session: AsyncSession) -> AsyncIterator[AsyncClient]:
    """讓 API 使用測試的 session，這樣 API 寫入的資料也會被 rollback。"""

    async def override_get_db() -> AsyncIterator[AsyncSession]:
        yield db_session

    app.dependency_overrides[get_db] = override_get_db
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as async_client:
        yield async_client
    app.dependency_overrides.clear()
