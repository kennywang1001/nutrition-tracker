"""並行行為的測試 —— 開真實的第二條連線。

`tests/conftest.py` 讓所有測試共用一個交易（外層 rollback 做隔離）。
那個設計是對的，但它有一個結構性的後果：**「兩個交易互相看不見對方」
這件事在那套夾具裡無法被觀察**，而這個模組所有的並行保證都活在那個維度上
（規格 §6 陷阱 5）。

所以這個檔案不用 `db_session`，自己開連線，而且寫進去的資料是**真的會
commit** 的 —— 必須自己清乾淨。
"""

import asyncio
from collections.abc import AsyncIterator

import pytest_asyncio
from sqlalchemy import delete, func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.session import RefreshSession
from app.models.user import User
from app.security.password import hash_password
from app.security.sessions import ReuseDetectedError, rotate_session, start_session
from tests.conftest import TEST_DATABASE_URL


@pytest_asyncio.fixture
async def independent_sessions(
    migrated_database: None,
) -> AsyncIterator[async_sessionmaker[AsyncSession]]:
    """一個可以開出多條互相獨立連線的 sessionmaker。

    每條連線各自有自己的交易，commit 是真的 commit —— 這正是重點。
    """
    engine = create_async_engine(TEST_DATABASE_URL)
    try:
        yield async_sessionmaker(engine, expire_on_commit=False)
    finally:
        await engine.dispose()


async def test_reuse_detection_revokes_the_family_even_under_concurrent_rotation(
    independent_sessions,
):
    """**規格 §3.2：這是整個功能唯一真正要保證的性質，而且只有這條測試看得見。**

    攻擊形狀：攻擊者握有一份儲存傾印，裡面有已用過的 A 與還活著的 B，
    同時送出兩個 refresh。A 觸發重用偵測、撤銷整個 family；B 同時在輪替，
    剛插入的 C 若不在撤銷的視野裡，攻擊者就帶著一張活票走人 ——
    **在一個所有人都認為已經撤銷的 family 裡**。

    沒有 `_lock_user_sessions` 的話，這裡有 59/60 的機率留下一張活票
    （實測，不是估計）。

    這條測試寫進資料庫的東西是真的 commit 的，所以結尾要自己清掉。
    """
    async with independent_sessions() as setup:
        user = User(
            email="concurrency-probe@example.com",
            password_hash=hash_password("correct-horse-battery"),
            display_name="並行測試",
        )
        setup.add(user)
        await setup.commit()
        user_id = user.id

    try:
        async with independent_sessions() as s:
            a = await start_session(s, user_id)
            b = await rotate_session(s, a.refresh_token)

        # 兩條各自獨立的連線，真的同時跑
        async with independent_sessions() as s1, independent_sessions() as s2:
            results = await asyncio.gather(
                rotate_session(s1, a.refresh_token),  # 重放已用的 A
                rotate_session(s2, b.refresh_token),  # 合法輪替 B
                return_exceptions=True,
            )

        # 至少有一邊要被判定成重用（順序不保證，所以不斷言是哪一邊）
        assert any(isinstance(r, ReuseDetectedError) for r in results), (
            f"重用偵測沒有觸發：{results}"
        )

        # **這才是重點：整個 family 不可以留下任何一張活票。**
        async with independent_sessions() as check:
            live = await check.scalar(
                select(func.count())
                .select_from(RefreshSession)
                .where(
                    RefreshSession.user_id == user_id,
                    RefreshSession.used_at.is_(None),
                    RefreshSession.revoked_at.is_(None),
                )
            )
        assert live == 0, (
            f"重用偵測回報已撤銷，但還有 {live} 張活票 —— "
            "攻擊者可以在一個所有人都認為已撤銷的 family 裡繼續換發（規格 §3.2）"
        )
    finally:
        async with independent_sessions() as cleanup:
            # ON DELETE CASCADE 會把 refresh_sessions 一起帶走
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
