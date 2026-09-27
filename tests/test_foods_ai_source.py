"""規格 §5：「有沒有改」是資料，不只是操作。

| 路徑 | source | ai_confidence | ai_raw_response |
|---|---|---|---|
| 直接按「確認」 | 'ai' | AI 給的 | LLM 原始回覆 |
| 「需要修改」後確認 | 'user' | AI 給的 | 仍然存 |

兩條路徑都會成功存出一個食物，`FoodResponse` 沒有這三個欄位，回應看起來
一模一樣。**斷言要讀資料庫，不是讀回應。**
"""

from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.food import Food, FoodRevision
from app.security.tokens import create_access_token
from tests.factories import create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _revision_for(db_session, food_id: int) -> FoodRevision:
    food = await db_session.scalar(select(Food).where(Food.id == food_id))
    assert food is not None
    assert food.current_revision_id is not None
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    return revision


async def test_create_food_without_ai_fields_defaults_to_user_source_and_null_ai_fields(
    client, db_session
):
    """既有行為不能壞：不帶那三個欄位時，source 是預設的 'user'、另外兩個是 NULL。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "手動輸入的食物",
            "nutrition": {"kcal": "100", "protein_g": "10", "fat_g": "5", "carb_g": "20"},
        },
    )

    assert response.status_code == 201
    revision = await _revision_for(db_session, response.json()["id"])
    assert revision.source == "user"
    assert revision.ai_confidence is None
    assert revision.ai_raw_response is None


async def test_create_food_with_source_ai_persists_it_in_food_revisions(client, db_session):
    """直接按「確認」那條路徑：source='ai'，confidence 與原始回覆都存下來。"""
    user = await create_user(db_session)
    raw_response = {"name": "滷肉飯", "serving_kcal": "450.00"}

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "AI 估算的滷肉飯",
            "nutrition": {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"},
            "source": "ai",
            "ai_confidence": "0.85",
            "ai_raw_response": raw_response,
        },
    )

    assert response.status_code == 201
    # FoodResponse 沒有這三個欄位——回應看起來跟不帶欄位時一模一樣，
    # 這正是這個 task 存在的理由（只有讀資料庫才驗得到）。
    assert "source" not in response.json()

    revision = await _revision_for(db_session, response.json()["id"])
    assert revision.source == "ai"
    assert revision.ai_confidence == Decimal("0.85")
    assert revision.ai_raw_response == raw_response


async def test_create_food_with_source_user_and_ai_raw_response_persists_both(
    client, db_session
):
    """「需要修改」後確認那條路徑：source='user'，但 AI 原本的數字仍然存著。

    這是關鍵那一條——改過之後 ai_raw_response 不能被丟掉，否則「AI 常常錯
    很多嗎？」這個問題之後永遠答不出來。
    """
    user = await create_user(db_session)
    raw_response = {"name": "滷肉飯", "serving_kcal": "450.00"}

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "改過的滷肉飯",
            "nutrition": {"kcal": "200", "protein_g": "8", "fat_g": "9", "carb_g": "25"},
            "source": "user",
            "ai_confidence": "0.60",
            "ai_raw_response": raw_response,
        },
    )

    assert response.status_code == 201
    revision = await _revision_for(db_session, response.json()["id"])
    assert revision.source == "user"
    assert revision.ai_confidence == Decimal("0.60")
    assert revision.ai_raw_response == raw_response


async def test_create_food_rejects_a_source_outside_the_allowed_values(client, db_session):
    """API 層先擋一次：前端不能送任意字串進 source（Task 6 判斷：加 Pydantic 驗證）。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "亂填來源的食物",
            "nutrition": {"kcal": "100", "protein_g": "10", "fat_g": "5", "carb_g": "20"},
            "source": "not-a-real-source",
        },
    )

    assert response.status_code == 422


async def test_food_revisions_source_check_constraint_rejects_an_invalid_value(db_session):
    """DB 層也擋一次（migrations/0009）：`source` 欄位從第一版 migration 就存在，
    但一直沒有 CheckConstraint——直接對 ORM 塞一個不合法的值，繞過 Pydantic，
    證明約束是資料庫在守，不是只靠 API 層的 Literal。

    照抄 tests/test_ai_analysis_model.py 的 test_kind_rejects_a_value_outside_text_or_image
    同一個作法：native_enum 完全沒用在這一欄（它從頭到尾就是 Text），
    綁定參數不會做任何檢查，約束完全是資料庫的 CheckConstraint 在把關。
    """
    user = await create_user(db_session)
    food = Food(name="測試食物", owner_id=user.id, created_by=user.id)
    db_session.add(food)
    await db_session.flush()

    revision = FoodRevision(
        food_id=food.id,
        kcal=Decimal(100),
        protein_g=Decimal(10),
        fat_g=Decimal(5),
        carb_g=Decimal(20),
        created_by=user.id,
        source="not-a-real-source",
    )
    db_session.add(revision)

    with pytest.raises(IntegrityError) as exc:
        await db_session.commit()
    assert "source_valid" in str(exc.value)
    # conftest 開頭列的已知邊界 4：接住 commit 丟出的例外之後一定要 rollback，
    # 否則同一個測試後續所有資料庫操作都會炸 PendingRollbackError。
    await db_session.rollback()
