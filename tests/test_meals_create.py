from decimal import Decimal

from sqlalchemy import func, select

from app.models.food import FoodRevision
from app.models.meal import Meal, MealItem
from app.nutrition import scale
from app.security.tokens import create_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


def _payload(**overrides):
    payload = {
        "eaten_at": "2026-09-04T12:30:00+08:00",
        "meal_type": "lunch",
        "note": "測試用的一餐",
        "items": [],
    }
    payload.update(overrides)
    return payload


async def test_create_meal_with_one_item_returns_the_item_and_totals(client, db_session):
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, owner=user, kcal=200, protein_g=10, fat_g=5, carb_g=20
    )

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )

    assert response.status_code == 201
    body = response.json()
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["food_id"] == food.id
    assert item["quantity"] == "100.00"
    assert item["quantity_g"] == "100.00"
    assert item["kcal"] == "200.00"
    assert body["kcal"] == "200.00"
    assert body["protein_g"] == "10.00"
    assert body["fat_g"] == "5.00"
    assert body["carb_g"] == "20.00"


async def test_totals_are_the_sum_of_multiple_items(client, db_session):
    user = await create_user(db_session)
    food_a = await create_food(
        db_session, created_by=user, owner=user, kcal=100, protein_g=1, fat_g=1, carb_g=1
    )
    food_b = await create_food(
        db_session, created_by=user, owner=user, kcal=50, protein_g=2, fat_g=2, carb_g=2
    )

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(
            items=[
                {"food_id": food_a.id, "quantity": "100"},
                {"food_id": food_b.id, "quantity": "100"},
            ]
        ),
    )

    assert response.status_code == 201
    body = response.json()
    assert len(body["items"]) == 2
    # 各項相加必須「恰好」等於總計 —— 這是刻意的取捨（總計取各項四捨五入後的和）。
    item_kcal_sum = sum(Decimal(i["kcal"]) for i in body["items"])
    assert item_kcal_sum == Decimal(body["kcal"])
    assert body["kcal"] == "150.00"
    assert body["protein_g"] == "3.00"


async def test_quantity_g_is_portion_grams_times_quantity(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    portion = await create_portion(db_session, food=food, grams=200)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(items=[{"food_id": food.id, "quantity": "1.5", "portion_id": portion.id}]),
    )

    assert response.status_code == 201
    item = response.json()["items"][0]
    assert item["quantity"] == "1.50"
    assert item["quantity_g"] == "300.00"
    assert item["kcal"] == "300.00"


async def test_quantity_g_equals_quantity_when_no_portion_given(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(items=[{"food_id": food.id, "quantity": "80"}]),
    )

    assert response.status_code == 201
    item = response.json()["items"][0]
    assert item["portion_id"] is None
    assert item["quantity"] == "80.00"
    assert item["quantity_g"] == "80.00"


async def test_meal_with_empty_items_list_is_created(client, db_session):
    user = await create_user(db_session)

    response = await client.post("/api/meals", headers=auth(user), json=_payload(items=[]))

    assert response.status_code == 201
    body = response.json()
    assert body["items"] == []
    assert body["kcal"] == "0.00"
    assert body["protein_g"] == "0.00"
    assert body["fat_g"] == "0.00"
    assert body["carb_g"] == "0.00"


async def test_referencing_someone_elses_private_food_is_not_found_and_creates_nothing(
    client, db_session
):
    """也是本檔案的原子性測試：第三個項目失敗時，前兩個項目必須沒有留下任何痕跡。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    own_food_1 = await create_food(db_session, created_by=bob, owner=bob)
    own_food_2 = await create_food(db_session, created_by=bob, owner=bob)
    alices_food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.post(
        "/api/meals",
        headers=auth(bob),
        json=_payload(
            items=[
                {"food_id": own_food_1.id, "quantity": "100"},
                {"food_id": own_food_2.id, "quantity": "100"},
                {"food_id": alices_food.id, "quantity": "100"},
            ]
        ),
    )

    assert response.status_code == 404

    meal_count = await db_session.scalar(select(func.count()).select_from(Meal))
    item_count = await db_session.scalar(select(func.count()).select_from(MealItem))
    assert meal_count == 0
    assert item_count == 0


async def test_referencing_someone_elses_private_portion_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice)  # 全域食物，兩人都看得到
    alices_portion = await create_portion(db_session, food=food, owner=alice)

    response = await client.post(
        "/api/meals",
        headers=auth(bob),
        json=_payload(
            items=[{"food_id": food.id, "quantity": "1", "portion_id": alices_portion.id}]
        ),
    )

    assert response.status_code == 404


async def test_referencing_a_portion_that_belongs_to_a_different_food_is_rejected(
    client, db_session
):
    user = await create_user(db_session)
    food_a = await create_food(db_session, created_by=user, owner=user)
    food_b = await create_food(db_session, created_by=user, owner=user)
    portion_of_b = await create_portion(db_session, food=food_b)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(
            items=[{"food_id": food_a.id, "quantity": "1", "portion_id": portion_of_b.id}]
        ),
    )

    assert response.status_code == 422


async def test_zero_or_negative_quantity_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)

    for bad_quantity in ("0", "-1"):
        response = await client.post(
            "/api/meals",
            headers=auth(user),
            json=_payload(items=[{"food_id": food.id, "quantity": bad_quantity}]),
        )
        assert response.status_code == 422, bad_quantity


async def test_invalid_meal_type_is_rejected(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/meals", headers=auth(user), json=_payload(meal_type="brunch")
    )

    assert response.status_code == 422


async def test_create_meal_requires_authentication(client):
    response = await client.post("/api/meals", json=_payload())

    assert response.status_code == 401


async def test_changing_a_portions_grams_does_not_change_an_already_recorded_meal(
    client, db_session
):
    """凍結歷史：計畫 2「指標移動」測試的同構物。

    份量沒有版本化，所以 meal_items.quantity_g 必須在寫入當下就凍結，
    之後份量被改掉也不能連動。這裡沒有 GET /api/meals/{id}（Task 8，
    範圍之外），「重讀」用直接查資料庫代替 —— 效果相同：都是繞過任何
    可能被快取污染的物件，看資料庫實際存的值。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=200)
    portion = await create_portion(db_session, food=food, grams=200)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_payload(items=[{"food_id": food.id, "quantity": "1", "portion_id": portion.id}]),
    )
    assert response.status_code == 201
    body = response.json()
    item_id = body["items"][0]["id"]
    original_quantity_g = body["items"][0]["quantity_g"]
    original_kcal = body["items"][0]["kcal"]
    assert original_quantity_g == "200.00"
    assert original_kcal == "400.00"

    new_grams = Decimal("250")
    portion.grams = new_grams
    await db_session.commit()

    # 強制丟掉 identity map 的快取，確保下面查到的是資料庫裡真正的值，
    # 不是測試自己手上那個沒被動過的 Python 物件（也包含 portion 自己 ——
    # 之後不能再直接讀 portion.grams，那會觸發一次過期後的同步 lazy load）。
    db_session.expire_all()

    reloaded_item = await db_session.get(MealItem, item_id)
    assert reloaded_item is not None
    assert str(reloaded_item.quantity_g) == "200.00"

    revision = await db_session.get(FoodRevision, reloaded_item.food_revision_id)
    macros = scale(revision, reloaded_item.quantity_g)
    assert str(macros.kcal) == original_kcal

    # 對照組：如果有人「順手」把換算邏輯改成用現在的份量重算，
    # 這裡會是 500.00（250g 換算），而不是凍結住的 400.00。
    # 這行不是在測 production code，是在證明「重算」跟「凍結」數字真的不同，
    # 不是巧合地相等。
    naively_recomputed = scale(revision, new_grams * reloaded_item.quantity)
    assert str(naively_recomputed.kcal) != original_kcal
