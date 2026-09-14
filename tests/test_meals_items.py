from decimal import Decimal

from sqlalchemy import func, select

from app.models.meal import MealItem
from app.security.tokens import create_access_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _create_payload(**overrides):
    payload = {
        "eaten_at": "2026-09-04T12:30:00+08:00",
        "meal_type": "lunch",
        "note": "測試用的一餐",
        "items": [],
    }
    payload.update(overrides)
    return payload


# ---------------------------------------------------------------------------
# Task 12: POST /api/meals/{id}/items、DELETE /api/meals/{id}/items/{item_id}
#
# 食物解析與 quantity_g 換算重用 Task 7 抽出來的 _resolve_item /
# _load_visible_portion，不重新驗證那套安全邏輯 —— 這裡的測試專注在
# 「加/刪一個項目」這個動作本身：擁有權、總計跟著變、以及項目層級的隔離。
# ---------------------------------------------------------------------------


async def test_adding_an_item_returns_201_and_updates_totals(client, db_session):
    user = await create_user(db_session)
    food_a = await create_food(
        db_session, created_by=user, owner=user, kcal=100, protein_g=1, fat_g=1, carb_g=1
    )
    food_b = await create_food(
        db_session, created_by=user, owner=user, kcal=50, protein_g=2, fat_g=2, carb_g=2
    )
    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food_a.id, "quantity": "100"}]),
    )
    meal_id = create_response.json()["id"]
    assert create_response.json()["kcal"] == "100.00"

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(user),
        json={"food_id": food_b.id, "quantity": "100"},
    )

    assert response.status_code == 201
    body = response.json()
    assert len(body["items"]) == 2
    assert body["kcal"] == "150.00"
    assert body["protein_g"] == "3.00"
    # 各項相加必須「恰好」等於總計（總計取各項四捨五入後的和，不是精確和再四捨五入）。
    item_kcal_sum = sum(Decimal(i["kcal"]) for i in body["items"])
    assert item_kcal_sum == Decimal(body["kcal"])

    # 透過另一次 GET 確認變更真的落地，不是只有這次回應算出來的暫態值。
    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.json()["kcal"] == "150.00"
    assert len(reread.json()["items"]) == 2


async def test_adding_an_item_with_portion_uses_resolved_quantity_g(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    portion = await create_portion(db_session, food=food, grams=200)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(user),
        json={"food_id": food.id, "quantity": "1.5", "portion_id": portion.id},
    )

    assert response.status_code == 201
    item = response.json()["items"][0]
    assert item["quantity_g"] == "300.00"
    assert item["kcal"] == "300.00"


async def test_adding_an_item_to_someone_elses_meal_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=bob, owner=bob)
    create_response = await client.post("/api/meals", headers=auth(alice), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(bob),
        json={"food_id": food.id, "quantity": "100"},
    )

    assert response.status_code == 404

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(alice))
    assert reread.json()["items"] == []


async def test_adding_someone_elses_private_food_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    alices_food = await create_food(db_session, created_by=alice, owner=alice)
    create_response = await client.post("/api/meals", headers=auth(bob), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(bob),
        json={"food_id": alices_food.id, "quantity": "100"},
    )

    assert response.status_code == 404

    item_count = await db_session.scalar(
        select(func.count()).select_from(MealItem).where(MealItem.meal_id == meal_id)
    )
    assert item_count == 0


async def test_add_item_requires_authentication(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.post(
        f"/api/meals/{meal_id}/items", json={"food_id": food.id, "quantity": "100"}
    )

    assert response.status_code == 401


async def test_deleting_an_item_returns_204_and_updates_totals(client, db_session):
    user = await create_user(db_session)
    food_a = await create_food(db_session, created_by=user, owner=user, kcal=100)
    food_b = await create_food(db_session, created_by=user, owner=user, kcal=50)
    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(
            items=[
                {"food_id": food_a.id, "quantity": "100"},
                {"food_id": food_b.id, "quantity": "100"},
            ]
        ),
    )
    meal_id = create_response.json()["id"]
    items = create_response.json()["items"]
    assert create_response.json()["kcal"] == "150.00"
    item_to_delete = next(i["id"] for i in items if i["food_id"] == food_b.id)

    response = await client.delete(
        f"/api/meals/{meal_id}/items/{item_to_delete}", headers=auth(user)
    )

    assert response.status_code == 204

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert reread.json()["kcal"] == "100.00"
    assert len(reread.json()["items"]) == 1


async def test_deleting_an_item_from_someone_elses_meal_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)
    create_response = await client.post(
        "/api/meals",
        headers=auth(alice),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    meal_id = create_response.json()["id"]
    item_id = create_response.json()["items"][0]["id"]

    response = await client.delete(f"/api/meals/{meal_id}/items/{item_id}", headers=auth(bob))

    assert response.status_code == 404


async def test_deleting_an_item_from_someone_elses_meal_leaves_it_intact(client, db_session):
    """「回 404」跟「沒有真的刪掉」是兩件事，跟 Task 11 的 DELETE 一樣要真的重查。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)
    create_response = await client.post(
        "/api/meals",
        headers=auth(alice),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    meal_id = create_response.json()["id"]
    item_id = create_response.json()["items"][0]["id"]

    response = await client.delete(f"/api/meals/{meal_id}/items/{item_id}", headers=auth(bob))
    assert response.status_code == 404

    reread = await client.get(f"/api/meals/{meal_id}", headers=auth(alice))
    assert len(reread.json()["items"]) == 1
    assert reread.json()["items"][0]["id"] == item_id


async def test_deleting_a_nonexistent_item_is_not_found(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    meal_id = create_response.json()["id"]

    response = await client.delete(f"/api/meals/{meal_id}/items/999999", headers=auth(user))

    assert response.status_code == 404


async def test_deleting_an_item_using_the_wrong_meal_id_is_not_found(client, db_session):
    """item_id 的擁有權要沿著 meal_items.meal_id -> meals.user_id 檢查，不能只檢查
    item_id 本身存在 —— 這裡額外驗證：即使 item_id 正確，用一個不是它所屬的
    meal_id（即使那個 meal 也是自己的）去刪，一樣要 404，不能『反正是自己的
    某一餐就放行』。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    meal_1 = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    meal_2 = await client.post("/api/meals", headers=auth(user), json=_create_payload())
    other_meal_id = meal_2.json()["id"]
    item_id = meal_1.json()["items"][0]["id"]

    response = await client.delete(
        f"/api/meals/{other_meal_id}/items/{item_id}", headers=auth(user)
    )

    assert response.status_code == 404


async def test_delete_item_requires_authentication(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    meal_id = create_response.json()["id"]
    item_id = create_response.json()["items"][0]["id"]

    response = await client.delete(f"/api/meals/{meal_id}/items/{item_id}")

    assert response.status_code == 401
