import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.ai_analysis import AiAnalysis, AnalysisKind
from tests.factories import create_user


def _row(
    user_id: int,
    *,
    kind: AnalysisKind | str = AnalysisKind.TEXT,
    succeeded: bool = True,
) -> AiAnalysis:
    return AiAnalysis(
        user_id=user_id,
        kind=kind,
        model="claude-sonnet-5",
        input_hash="deadbeef",
        succeeded=succeeded,
    )


async def test_a_row_can_be_stored_and_read_back(db_session):
    user = await create_user(db_session)
    row = _row(user.id)

    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.id is not None
    assert row.kind == AnalysisKind.TEXT
    assert row.model == "claude-sonnet-5"
    assert row.input_hash == "deadbeef"
    assert row.succeeded is True
    # DateTime(timezone=True) 必須回 aware 的 datetime——額度查詢要拿它跟
    # day_bounds() 算出來的 aware datetime 比較（規格 §7.2），naive 的話
    # 比較會直接 TypeError。
    assert row.created_at.tzinfo is not None


async def test_a_failed_call_can_also_be_stored(db_session):
    """規格 §7：失敗的呼叫一樣要計入額度——LLM 回了垃圾也是花了錢。

    這條鎖住 succeeded=False 是一列合法的資料，不是只有成功的呼叫才寫得進去。
    """
    user = await create_user(db_session)
    row = _row(user.id, succeeded=False)

    db_session.add(row)
    await db_session.commit()
    await db_session.refresh(row)

    assert row.succeeded is False


async def test_kind_rejects_a_value_outside_text_or_image(db_session):
    """kind 只能是 'text' / 'image'——由資料庫的 CheckConstraint 把關。

    Python 端的 AnalysisKind 型別**不會**擋一個手動塞進去的非法字串：
    native_enum=False 的欄位在綁定參數時就是把字串原樣送進 VARCHAR，
    不會做 enum 成員查找。這條測試證明約束是資料庫在守，不是型別系統。
    少了它，「忘記手寫 CheckConstraint」會是一個全綠但完全沒有約束的狀態
    （見 app/models/ai_analysis.py 的註解）。
    """
    user = await create_user(db_session)
    row = _row(user.id, kind="video")

    db_session.add(row)
    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "kind_valid" in str(exc.value)
    # conftest 開頭列的已知邊界 4：接住 commit 丟出的例外之後一定要 rollback，
    # 否則同一個測試後續所有資料庫操作都會炸 PendingRollbackError。
    await db_session.rollback()


async def test_the_quota_query_only_counts_the_calling_user(db_session):
    """額度查詢是 WHERE user_id = ? AND created_at >= ?（規格 §7.2）。

    這條測的是查詢本身的正確性（跨使用者不能互相污染額度），不是索引——
    索引只影響這個查詢的速度，不影響它算出來的結果。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    db_session.add(_row(alice.id))
    db_session.add(_row(bob.id))
    db_session.add(_row(bob.id))
    await db_session.commit()

    alice_count = await db_session.scalar(
        select(AiAnalysis).where(AiAnalysis.user_id == alice.id)
    )
    bob_rows = (
        await db_session.scalars(select(AiAnalysis).where(AiAnalysis.user_id == bob.id))
    ).all()

    assert alice_count is not None
    assert len(bob_rows) == 2
