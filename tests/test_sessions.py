from datetime import UTC, datetime, timedelta
from uuid import uuid4

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.session import RefreshSession
from tests.factories import create_user


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
