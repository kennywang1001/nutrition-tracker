from decimal import Decimal

from sqlalchemy import func, select

from app.models.meal import MealItem
from app.models.user import UserRole
from app.security.tokens import create_access_token
from tests.factories import create_food, create_pending_revision, create_portion, create_user


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


async def _meal_with_one_item(client, user, food, quantity="100", portion_id=None):
    item = {"food_id": food.id, "quantity": quantity}
    if portion_id is not None:
        item["portion_id"] = portion_id
    response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(items=[item])
    )
    body = response.json()
    return body["id"], body["items"][0]["id"]


async def test_patching_quantity_recomputes_grams_and_totals(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "250"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["items"][0]["quantity_g"] == "250.00"
    assert body["kcal"] == "250.00"


async def test_switching_to_a_portion_uses_its_grams(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": portion.id, "quantity": "2"},
    )

    assert response.json()["items"][0]["quantity_g"] == "300.00"
    assert response.json()["items"][0]["portion_id"] == portion.id


async def test_patching_only_quantity_keeps_the_existing_portion(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(
        client, user, food, quantity="1", portion_id=portion.id
    )

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "2"},
    )

    assert response.json()["items"][0]["quantity_g"] == "300.00"


async def test_explicit_null_portion_switches_back_to_grams(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(
        client, user, food, quantity="1", portion_id=portion.id
    )

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": None, "quantity": "80"},
    )

    item = response.json()["items"][0]
    assert item["portion_id"] is None
    assert item["quantity_g"] == "80.00"


async def test_a_portion_of_another_food_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    other_food = await create_food(db_session, created_by=user, owner=user)
    other_portion = await create_portion(db_session, food=other_food, label="盤", grams=300)
    meal_id, item_id = await _meal_with_one_item(client, user, food)

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": other_portion.id},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PORTION_FOOD_MISMATCH"


async def test_portion_without_quantity_is_rejected_and_changes_nothing(client, db_session):
    """同一個數字在不同份量下意思不一樣：200 g 不能默默變成 200 份。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="200")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": portion.id},
    )

    assert response.status_code == 422
    item = await db_session.get(MealItem, item_id)
    assert item is not None
    await db_session.refresh(item)
    assert str(item.quantity_g) == "200.00"
    assert item.portion_id is None


async def test_null_portion_without_quantity_is_rejected(client, db_session):
    """「2 份」不能默默變成 2 g。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(
        client, user, food, quantity="2", portion_id=portion.id
    )

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": None},
    )

    assert response.status_code == 422
    item = await db_session.get(MealItem, item_id)
    assert item is not None
    await db_session.refresh(item)
    assert str(item.quantity_g) == "300.00"
    assert item.portion_id == portion.id


async def test_explicit_null_quantity_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    meal_id, item_id = await _meal_with_one_item(client, user, food)

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": None},
    )

    assert response.status_code == 422


async def test_patching_someone_elses_item_is_404_and_changes_nothing(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)
    meal_id, item_id = await _meal_with_one_item(client, alice, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(bob),
        json={"quantity": "999"},
    )

    assert response.status_code == 404
    item = await db_session.get(MealItem, item_id)
    assert item is not None
    assert str(item.quantity_g) == "100.00"


async def test_patching_an_item_through_another_meal_is_404(client, db_session):
    """擁有權沿著 meal_items.meal_id 檢查：item 要屬於「這一餐」，
    不能只因為兩餐都是自己的就放行。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    _, item_id = await _meal_with_one_item(client, user, food)
    other_meal_id, _ = await _meal_with_one_item(client, user, food)

    response = await client.patch(
        f"/api/meals/{other_meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "999"},
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEAL_ITEM_NOT_FOUND"


async def test_patching_keeps_the_pinned_revision(client, db_session):
    """凍結歷史（handover §4.3）：改的是「吃了多少」，不是「用哪一版營養素」。
    食物後來有了新版本，改數量時仍然用記錄當下那一版。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, kcal=200)  # 全域食物
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="100")
    pending = await create_pending_revision(db_session, food=food, created_by=admin, kcal=999)
    approve = await client.post(
        f"/api/admin/food-revisions/{pending.id}/approve", headers=auth(admin)
    )
    assert approve.status_code == 200

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "50"},
    )

    assert response.json()["items"][0]["kcal"] == "100.00"  # 200 × 0.5，不是 999 × 0.5


async def test_patching_to_someone_elses_private_portion_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice)  # 全域食物，兩人都看得到
    bobs_portion = await create_portion(db_session, food=food, owner=bob, grams=500)
    meal_id, item_id = await _meal_with_one_item(client, alice, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(alice),
        json={"portion_id": bobs_portion.id, "quantity": "2"},
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "PORTION_NOT_FOUND"
    item = await db_session.get(MealItem, item_id)
    assert item is not None
    await db_session.refresh(item)
    assert str(item.quantity_g) == "100.00"
    assert item.portion_id is None


async def test_added_item_comes_back_with_stored_precision(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    meal_id, _ = await _meal_with_one_item(client, user, food, quantity="50")

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(user),
        json={"food_id": food.id, "quantity": "100"},
    )

    added = response.json()["items"][-1]
    assert added["quantity"] == "100.00"
    assert added["quantity_g"] == "100.00"
