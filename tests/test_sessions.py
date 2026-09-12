from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.session import RefreshSession
from app.security.sessions import start_session
from app.security.tokens import decode_access_token, decode_refresh_token
from tests.factories import DEFAULT_PASSWORD, create_user


def _session_row(user_id: int, *, jti=None, family_id=None) -> RefreshSession:
    now = datetime.now(UTC)
    return RefreshSession(
        user_id=user_id,
        jti=jti or uuid4(),
        family_id=family_id or uuid4(),
        issued_at=now,
        expires_at=now + timedelta(days=14),
    )


async def test_a_session_row_can_be_stored_and_read_back(db_session):
    user = await create_user(db_session)
    row = _session_row(user.id)

    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.id is not None
    assert row.used_at is None
    assert row.revoked_at is None
    # DateTime(timezone=True) 必須回 aware 的 datetime —— Task 6 的比較
    # （Python 時鐘 vs 這個欄位）建立在這上面，naive 的話會直接 TypeError。
    assert row.issued_at.tzinfo is not None
    assert row.expires_at.tzinfo is not None


async def test_jti_is_unique(db_session):
    """jti 是查詢的鍵。重複的 jti 代表兩條不同的鏈共用一個識別，撤銷其中一條
    會誤傷另一條 —— 這要由資料庫擋，不是靠「uuid4 不會碰撞」這個假設。
    """
    user = await create_user(db_session)
    jti = uuid4()
    db_session.add(_session_row(user.id, jti=jti))
    await db_session.commit()

    db_session.add(_session_row(user.id, jti=jti))
    with pytest.raises(IntegrityError):
        await db_session.commit()
    # conftest 開頭列的已知邊界 4：接住 commit 丟出的例外之後一定要 rollback，
    # 否則同一個測試後續所有資料庫操作都會炸 PendingRollbackError，
    # 而且錯誤訊息看起來跟真正的原因完全無關。
    await db_session.rollback()


async def test_sessions_are_deleted_when_the_user_is_deleted(db_session):
    """ON DELETE CASCADE —— 不留孤兒列。"""
    user = await create_user(db_session)
    db_session.add(_session_row(user.id))
    await db_session.commit()

    await db_session.delete(user)
    await db_session.commit()

    remaining = (await db_session.scalars(select(RefreshSession))).all()
    assert remaining == []


async def test_a_family_cannot_have_two_live_tokens(db_session):
    """鏈分岔就是這張表要防的 bug（規格 §3.1）。Task 4 的條件式 UPDATE 保證了它，
    但那是程式碼；這條測試證明資料庫也擋。

    **沒有這條測試，把部分唯一索引從 model 與 migration 同時刪掉，
    `alembic check` 乾淨、整套測試全綠、不變量安靜消失。**
    alembic check 抓的是「模型與 migration 不一致」，兩邊一起刪它看不見。
    """
    user = await create_user(db_session)
    family_id = uuid4()
    db_session.add(_session_row(user.id, family_id=family_id))
    await db_session.commit()

    db_session.add(_session_row(user.id, family_id=family_id))
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "one_live_per_family" in str(exc.value)
    await db_session.rollback()


async def test_used_and_revoked_rows_free_the_family_slot(db_session):
    """索引只約束**活**票 —— 否則輪替會在第二次換發就炸。

    這條跟上面那條是一對：上面證明它會擋，這條證明它擋對了東西。
    只有上面那條的話，把述詞寫成「family_id 唯一」也是綠的。
    """
    user = await create_user(db_session)
    family_id = uuid4()
    spent = _session_row(user.id, family_id=family_id)
    spent.used_at = datetime.now(UTC)
    db_session.add(spent)
    await db_session.commit()

    db_session.add(_session_row(user.id, family_id=family_id))
    await db_session.commit()  # 不該炸


async def test_expires_at_must_be_after_issued_at(db_session):
    """Task 4 刻意不檢查 expires_at，所以壞掉的值在程式碼裡不會報錯 ——
    使用者只會莫名被登出。由 CHECK 擋住。

    用 expires_at == issued_at 這個邊界值，不是明顯更小的值：
    `>=` 與 `>` 的差別只有這個輸入分得出來。
    """
    user = await create_user(db_session)
    row = _session_row(user.id)
    row.expires_at = row.issued_at
    db_session.add(row)
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "expires_after_issued" in str(exc.value)
    await db_session.rollback()


async def test_start_session_writes_a_row_matching_the_issued_token(db_session):
    user = await create_user(db_session)

    issued = await start_session(db_session, user.id)

    claims = decode_refresh_token(issued.refresh_token)
    assert decode_access_token(issued.access_token) == user.id

    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
    assert row.user_id == user.id
    assert row.used_at is None
    assert row.revoked_at is None


async def test_two_logins_start_two_separate_families(db_session):
    """每次登入是獨立的一條鏈 —— 否則在手機上登出會把桌機也一起登出，
    而規格 §1 的整個出發點就是要能只撤銷一台裝置。

    如果 `start_session` 改成每次都用同一個固定 family_id，第二次
    `start_session` 會先在 Task 1 那個部分唯一索引撞
    `IntegrityError`（一個 family 最多一張活票）——最下面那行
    assertion 其實根本跑不到。這條測試仍然值得留著（它釘住的是
    「這裡呼叫的是 start_session，行為應該是兩條獨立的鏈」這個意圖），
    但如果日後有人弱化那個索引，讓它不再擋，這行 assertion 才是
    真正在守這個不變量的最後一道防線。
    """
    user = await create_user(db_session)

    first = await start_session(db_session, user.id)
    second = await start_session(db_session, user.id)

    first_family = (
        await db_session.scalar(
            select(RefreshSession).where(
                RefreshSession.jti == decode_refresh_token(first.refresh_token).jti
            )
        )
    ).family_id
    second_family = (
        await db_session.scalar(
            select(RefreshSession).where(
                RefreshSession.jti == decode_refresh_token(second.refresh_token).jti
            )
        )
    ).family_id

    assert first_family != second_family


async def test_login_endpoint_creates_a_session_row(client, db_session):
    """端點層：登入回的 refresh token 必須真的對應到一列。

    只測 start_session 不夠 —— login() 有可能繞過它自己簽一張票，
    那樣所有 sessions.py 的單元測試都還是綠的。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/auth/login",
        json={"email": user.email, "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
    claims = decode_refresh_token(response.json()["refresh_token"])
    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
    assert row.user_id == user.id


async def test_start_session_commits_the_row(db_session):
    """**這條測試守的是這個 task 唯一真正的決定：sessions.py 自己管交易。**

    `commit` 不能弱化成 `flush`，也不能省略 —— production 的 `get_db` 是
    per-request，session 一關就把沒 commit 的 INSERT 丟掉，登入會發出一張
    沒有對應資料列的票，Task 4 之後每一次換發都 401。

    而預設情況下這件事**測不出來**：測試的 `db_session` 用 create_savepoint，
    `commit()` 只是 RELEASE SAVEPOINT，對同一個 session 來說「有沒有 commit」
    不可觀察（實測：把 commit 整行刪掉，476 個測試全綠）。

    下面那行 `rollback()` 就是把它變成可觀察的：沒 commit 的話那一列還在
    savepoint 裡，rollback 會把它抹掉；commit 過的不會。
    """
    user = await create_user(db_session)
    issued = await start_session(db_session, user.id)

    await db_session.rollback()

    claims = decode_refresh_token(issued.refresh_token)
    row = await db_session.scalar(
        select(RefreshSession).where(RefreshSession.jti == claims.jti)
    )
    assert row is not None
