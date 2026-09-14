"""並行行為的測試 —— 開真實的第二條連線。

`tests/conftest.py` 讓所有測試共用一個交易（外層 rollback 做隔離）。
那個設計是對的，但它有一個結構性的後果：**「兩個交易互相看不見對方」
這件事在那套夾具裡無法被觀察**，而這個模組所有的並行保證都活在那個維度上
（規格 §6 陷阱 5）。

所以這個檔案不用 `db_session`，自己開連線，而且寫進去的資料是**真的會
commit** 的 —— 必須自己清乾淨。
"""

import asyncio
import uuid
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import asyncpg
import pytest_asyncio
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.models.session import RefreshSession
from app.models.user import User
from app.security.password import hash_password
from app.security.sessions import (
    ReuseDetectedError,
    revoke_session,
    rotate_session,
    start_session,
)
from app.security.tokens import decode_refresh_token
from tests.conftest import TEST_DATABASE_URL

# 給下面的 pg_stat_activity 輪詢用——asyncpg 的原生連線不吃 SQLAlchemy 的
# "+asyncpg" 這段方言標記。
_RAW_DSN = TEST_DATABASE_URL.replace("postgresql+asyncpg://", "postgresql://")


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


async def _wait_until_someone_else_is_lock_waiting(exclude_pid: int) -> None:
    """輪詢 `pg_stat_activity`，直到有一條不是 `exclude_pid` 的連線卡在 Lock 上。

    **為什麼是輪詢，不是 `sleep(常數)`。** 一般測試裡的 sleep 是在
    「等一段時間、希望某件事已經發生」——那正是規格文件列進「綠燈說謊」
    清單的那種 sleep，它掩蓋不確定性，不是消除它。這裡不一樣：我們要的
    不是「大概過了夠久」，而是**直接觀察到**另一條連線真的被鎖卡住了。
    這是一個可以直接查詢的事實（`wait_event_type = 'Lock'`），不需要用
    時間去猜要等多久；輪詢間隔只影響多等幾毫秒，不影響正確性。

    呼叫端用 `asyncio.timeout()` 包住這個函式，不是自己收一個 `timeout`
    參數（ruff ASYNC109）——逾時策略是呼叫端的事，這個函式只負責
    「這件事發生了嗎」。
    """
    raw = await asyncpg.connect(_RAW_DSN)
    try:
        while True:
            row = await raw.fetchrow(
                "SELECT 1 FROM pg_stat_activity "
                "WHERE datname = current_database() "
                "AND pid != $1 AND wait_event_type = 'Lock'",
                exclude_pid,
            )
            if row is not None:
                return
            await asyncio.sleep(0.005)
    finally:
        await raw.close()


async def _perform_interfering_rotation(
    independent_sessions: async_sessionmaker[AsyncSession],
    *,
    user_id: int,
    jti: uuid.UUID,
    rotation_ready: asyncio.Event,
) -> None:
    """手動重現一次真正輪替的資料庫動作（UPDATE 舊列、INSERT 新列），
    卡在 commit 之前不放，等到另一側真的被鎖卡住了才放行。

    兩條並行測試（重用偵測 vs 輪替、登出 vs 輪替）都需要這個「干擾側」，
    抽成一個共用函式，而不是各自複製一份。

    **耦合說明（刻意的取捨，不是缺點）：** 這裡手寫了 `rotate_session`
    內部「先 UPDATE 舊列、再 INSERT 新列」的操作順序，而不是直接呼叫
    `rotate_session` 本身——因為我們需要在這兩步之後、commit 之前暫停，
    那個暫停點在 `rotate_session` 函式內部，外面插不進去。如果那個順序
    日後改變，這個函式要跟著調整。**這是唯一的耦合入口**：兩條測試共用
    同一份，順序一旦改變，只有一個地方需要修，也只有這一個地方的註解
    會提醒你這件事——不是各自一份、只有其中一份記得寫警告。
    """
    async with independent_sessions() as s:
        # 這一側也要拿鎖——它在模擬一次真正的輪替，而真正的輪替會拿。
        # 少了它，這條測試在「鎖被拿掉」時就抓不到問題：另一側不會等它，
        # 兩邊會各走各的，永遠不會卡在同一列上。
        await s.execute(select(func.pg_advisory_xact_lock(user_id)))
        own_pid = await s.scalar(select(func.pg_backend_pid()))

        family_id = (
            await s.execute(
                update(RefreshSession)
                .where(
                    RefreshSession.jti == jti,
                    RefreshSession.used_at.is_(None),
                    RefreshSession.revoked_at.is_(None),
                )
                .values(used_at=datetime.now(UTC))
                .returning(RefreshSession.family_id)
            )
        ).scalar_one()

        now = datetime.now(UTC)
        s.add(
            RefreshSession(
                user_id=user_id,
                jti=uuid.uuid4(),
                family_id=family_id,
                issued_at=now,
                expires_at=now + timedelta(days=14),
            )
        )

        rotation_ready.set()
        # 等到另一側真的卡住了（不管是卡在上面那個 advisory lock，
        # 還是——如果鎖被拿掉——卡在想鎖這裡剛剛更新的那一列），
        # 才放行 commit。逾時兜底不是這個等待的本體，只是避免測試在
        # 環境異常時無限卡住。
        try:
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(own_pid)
        except TimeoutError as exc:
            raise AssertionError(
                "等不到另一側卡進 Lock 等待狀態——如果這裡逾時，"
                "代表這個 PostgreSQL 環境的鎖等待行為跟預期不同，"
                "不要調鬆 timeout 蓋過去，先確認 pg_stat_activity "
                "的假設還成不成立。"
            ) from exc
        await s.commit()


async def test_reuse_detection_revokes_the_family_even_under_concurrent_rotation(
    independent_sessions,
):
    """**規格 §3.2：這是整個功能唯一真正要保證的性質。**

    攻擊形狀：攻擊者握有一份儲存傾印，裡面有已用過的 A 與還活著的 B，
    同時送出兩個 refresh。A 觸發重用偵測、撤銷整個 family；B 同時在輪替，
    剛插入的 C 若不在撤銷的視野裡，攻擊者就帶著一張活票走人 ——
    **在一個所有人都認為已經撤銷的 family 裡**。

    **這條測試曾經是 `asyncio.gather` 自然競速版本，被品質審查擋下。**
    規格 §6 規矩 1：「綠燈在被觀察到失敗之前不算證據，每個守衛都要突變
    過。」拿掉 `_lock_user_sessions` 之後，那個版本在某台機器
    （Windows + Docker Desktop）上連跑 25 次，一次都沒有變紅——不是因為
    這個性質成立，是因為那台機器上兩條連線的自然交錯穩定地落在安全的
    方向。那條測試從頭到尾沒有真的被突變觀察過，等於沒有守衛。

    這裡改成手動、確定性地建構規格 §3.2 描述的那個交錯，不依賴任何自然
    時序：「干擾側」（`_perform_interfering_rotation`）手動重現一次真正
    輪替 B 的資料庫動作，卡在 commit 之前不放，直到輪詢 `pg_stat_activity`
    確認 replay 側真的被鎖卡住了才放行；replay 側呼叫的是**真正的**
    `rotate_session`——它才是被測的對象。交錯建構的耦合說明見
    `_perform_interfering_rotation` 的 docstring，不在這裡重複一份。
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

        claims_b = decode_refresh_token(b.refresh_token)
        rotation_ready = asyncio.Event()

        async def interfering_rotation() -> None:
            await _perform_interfering_rotation(
                independent_sessions,
                user_id=user_id,
                jti=claims_b.jti,
                rotation_ready=rotation_ready,
            )

        async def replay_rotation() -> Exception | None:
            await rotation_ready.wait()
            async with independent_sessions() as s:
                try:
                    await rotate_session(s, a.refresh_token)
                except Exception as exc:
                    return exc
                return None

        _, replay_error = await asyncio.gather(
            interfering_rotation(),
            replay_rotation(),
        )

        assert isinstance(replay_error, ReuseDetectedError), (
            f"重放已用的 A 應該要被判定成重用，實際結果：{replay_error!r}"
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


async def test_logout_revokes_the_family_even_under_concurrent_rotation(
    independent_sessions,
):
    """**規格 §3.2 的另一條路徑：登出 vs 輪替，跟重用偵測是同一個洞。**

    `revoke_session` 呼叫的是同一個 `_revoke_family`——一個 bulk UPDATE，
    在 READ COMMITTED 下快照固定在 statement 開始那一刻，並行交易剛
    INSERT 的新列完全不在它的視野裡。上面那條測試釘住的是「重用偵測 vs
    輪替」；這條走的是完全不同的呼叫路徑（使用者主動登出，不是重放判斷）
    ——Task 5 之前這條路徑上完全沒有測試看得見它。

    攻擊/意外形狀：裝置手上握著 A，使用者按下登出的同時，另一個分頁
    （或背景自動換發）剛好在輪替 A -> C。登出讀到 A 對應的 family_id，
    去撤銷整個 family，但如果撤銷發生在 C 被 INSERT 之後、卻在同一個
    bulk UPDATE 的快照之外，C 就會活下來——使用者以為登出了，
    但那張新票還能繼續換發。

    交錯的建構方式跟上面那條同構（同樣是實測驗證過、不依賴自然時序的
    確定性版本，見 `_perform_interfering_rotation`）：有鎖時 replay 側卡在
    `_lock_user_sessions` 的 advisory lock；鎖被拿掉時卡在 `_revoke_family`
    想鎖干擾側剛更新的 A 那一列（兩者的 `wait_event_type` 都是 'Lock'，
    所以同一個輪詢函式兩種情況都認得出來）。replay 側呼叫的是**真正的**
    `revoke_session`——它才是被測的對象。
    """
    async with independent_sessions() as setup:
        user = User(
            email="logout-concurrency-probe@example.com",
            password_hash=hash_password("correct-horse-battery"),
            display_name="登出並行測試",
        )
        setup.add(user)
        await setup.commit()
        user_id = user.id

    try:
        async with independent_sessions() as s:
            a = await start_session(s, user_id)

        claims_a = decode_refresh_token(a.refresh_token)
        rotation_ready = asyncio.Event()

        async def interfering_rotation() -> None:
            await _perform_interfering_rotation(
                independent_sessions,
                user_id=user_id,
                jti=claims_a.jti,
                rotation_ready=rotation_ready,
            )

        async def replay_logout() -> None:
            await rotation_ready.wait()
            async with independent_sessions() as s:
                await revoke_session(s, a.refresh_token)

        await asyncio.gather(interfering_rotation(), replay_logout())

        # **這才是重點：登出回報完成之後，這個使用者名下不可以留下任何活票。**
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
            f"登出應該撤銷整個 family，但還有 {live} 張活票 —— "
            "使用者以為登出了，輪替出的新票卻還活著（規格 §3.2 的另一條路徑）"
        )
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id == user_id))
            await cleanup.commit()
