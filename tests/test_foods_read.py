from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_read_own_private_food(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="自助餐便當", kcal=250)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["name"] == "自助餐便當"
    assert body["is_global"] is False
    assert body["nutrition"]["kcal"] == "250.00"


async def test_read_a_global_food(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, name="7-11 茶葉蛋", kcal=70)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(user))

    assert response.status_code == 200
    assert response.json()["is_global"] is True


async def test_another_users_private_food_returns_404(client, db_session):
    """不是 403 —— 403 等於承認這個 ID 存在。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(bob))

    assert response.status_code == 404


async def test_a_nonexistent_food_returns_the_same_404(client, db_session):
    bob = await create_user(db_session)
    alice = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    not_yours = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    missing = await client.get("/api/foods/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code
    assert not_yours.json() == missing.json()


async def test_pending_revisions_do_not_leak_into_the_response(client, db_session):
    """待審的編輯不能出現在正式查詢結果裡。

    這靠的是 current_revision_id 指標 —— 只有核准才會更新它，
    所以未審核的資料在結構上就查不到，不依賴任何人記得寫 WHERE status = 'approved'。
    """
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin, kcal=70)
    await create_pending_revision(db_session, food=food, created_by=user, kcal=700)

    response = await client.get(f"/api/foods/{food.id}", headers=auth(user))

    assert response.json()["nutrition"]["kcal"] == "70.00"


async def test_read_requires_authentication(client, db_session):
    admin = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.get(f"/api/foods/{food.id}")

    assert response.status_code == 401
