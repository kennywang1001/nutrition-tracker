from app.security.tokens import create_access_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_revision_history_lists_all_versions_newest_first(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    await create_pending_revision(db_session, food=food, created_by=user, kcal=75)

    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 2
    assert body[0]["kcal"] == "75.00"
    assert body[0]["status"] == "pending"
    assert body[1]["status"] == "approved"
    assert body[1]["is_current"] is True
    assert body[0]["is_current"] is False


async def test_revision_history_of_another_users_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(bob))

    assert response.status_code == 404


async def test_revision_history_requires_authentication(client, db_session):
    admin = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.get(f"/api/foods/{food.id}/revisions")

    assert response.status_code == 401


NUTRITION = {"kcal": "123", "protein_g": "4", "fat_g": "5", "carb_g": "6"}


async def test_editing_own_private_food_takes_effect_immediately(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": NUTRITION, "change_note": "修正熱量"},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "approved"

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "123.00"


async def test_editing_a_global_food_goes_to_pending(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": NUTRITION, "change_note": "標示改了"},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "pending"

    read = await client.get(f"/api/foods/{food.id}", headers=auth(user))
    assert read.json()["nutrition"]["kcal"] == "70.00"


async def test_a_second_pending_edit_is_rejected(client, db_session):
    """同一個食物同時只能有一筆待審 —— 由部分唯一索引在資料庫層擋掉。"""
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_pending_revision(db_session, food=food, created_by=alice)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(bob),
        json={"nutrition": NUTRITION, "change_note": "我也想改"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "REVISION_PENDING"


async def test_the_session_still_works_after_a_rejected_second_edit(client, db_session):
    """409 之後 session 必須還能用 —— 漏掉 rollback 的話後續全部會爆。

    food_id / headers 特意在 POST 之前就算好：db.rollback() 會 expire 整個
    shared test session 裡的所有物件（不只是這次請求碰過的），POST 之後
    才去讀 food.id / bob.id 會觸發同步的 lazy load，跟這個測試真正要驗證的
    東西無關，純粹是 test session 共用造成的副作用。
    """
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_pending_revision(db_session, food=food, created_by=alice)
    food_id = food.id
    headers = auth(bob)

    await client.post(
        f"/api/foods/{food_id}/revisions",
        headers=headers,
        json={"nutrition": NUTRITION},
    )

    read = await client.get(f"/api/foods/{food_id}", headers=headers)
    assert read.status_code == 200


async def test_editing_another_users_private_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(bob),
        json={"nutrition": NUTRITION},
    )

    assert response.status_code == 404


async def test_editing_records_who_proposed_it(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={"nutrition": NUTRITION},
    )

    assert response.json()["created_by"] == user.id
