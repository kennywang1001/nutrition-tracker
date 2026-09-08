from decimal import Decimal

from app.models.user import UserRole
from app.security.tokens import create_token
from tests.factories import create_food, create_pending_revision, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


def _create_payload(**overrides):
    payload = {
        "eaten_at": "2026-09-04T12:30:00+08:00",
        "meal_type": "lunch",
        "note": "測試用的一餐",
        "items": [],
    }
    payload.update(overrides)
    return payload


async def test_read_own_meal_returns_items_food_name_and_totals(client, db_session):
    user = await create_user(db_session)
    food = await create_food(
        db_session,
        created_by=user,
        owner=user,
        name="測試雞胸肉",
        kcal=200,
        protein_g=10,
        fat_g=5,
        carb_g=20,
    )

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["id"] == meal_id
    assert body["meal_type"] == "lunch"
    assert body["note"] == "測試用的一餐"
    assert len(body["items"]) == 1
    item = body["items"][0]
    assert item["food_id"] == food.id
    assert item["food_name"] == "測試雞胸肉"
    assert item["quantity_g"] == "100.00"
    assert item["kcal"] == "200.00"
    assert body["kcal"] == "200.00"
    assert body["protein_g"] == "10.00"
    assert body["fat_g"] == "5.00"
    assert body["carb_g"] == "20.00"


async def test_reading_someone_elses_meal_is_not_found(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(alice), json=_create_payload()
    )
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(bob))

    assert response.status_code == 404


async def test_reading_a_nonexistent_meal_is_not_found(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/meals/999999", headers=auth(user))

    assert response.status_code == 404


async def test_isolation_failure_and_missing_meal_return_identical_bodies(client, db_session):
    """跟計畫 2 的 test_every_isolation_failure_looks_identical 同一種守則：
    「不是你的」跟「不存在」對呼叫端必須無法區分。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(alice), json=_create_payload()
    )
    meal_id = create_response.json()["id"]

    not_yours = await client.get(f"/api/meals/{meal_id}", headers=auth(bob))
    missing = await client.get("/api/meals/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code == 404
    assert not_yours.json() == missing.json()


async def test_reading_a_meal_with_no_items_returns_zero_totals(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(items=[])
    )
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["items"] == []
    assert body["kcal"] == "0.00"
    assert body["protein_g"] == "0.00"
    assert body["fat_g"] == "0.00"
    assert body["carb_g"] == "0.00"


async def test_read_meal_requires_authentication(client, db_session):
    user = await create_user(db_session)
    create_response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload()
    )
    meal_id = create_response.json()["id"]

    response = await client.get(f"/api/meals/{meal_id}")

    assert response.status_code == 401


async def test_get_meal_uses_frozen_quantity_g_not_live_portion_grams(client, db_session):
    """讀取端的凍結測試 —— Task 7 實測發現明確留下的缺口，本 task 最重要的斷言。

    Task 7 只證明了「寫入的 quantity_g 欄位不會動」，但當時沒有 GET 端點，
    測不到真正危險的形狀：GET handler 去 join 即時的份量資料重算，而不是信任
    寫入時就凍結好的 quantity_g。這裡把兩件事串起來：用 200g 的份量記一餐，
    把份量改成 250g，再用 GET /api/meals/{id} 讀回來 —— quantity_g 與 kcal
    都必須還是舊值（200.00 / 400.00），不能變成用 250g 重算出來的數字。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=200)
    portion = await create_portion(db_session, food=food, grams=200)

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(
            items=[{"food_id": food.id, "quantity": "1", "portion_id": portion.id}]
        ),
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]
    original_item = create_response.json()["items"][0]
    assert original_item["quantity_g"] == "200.00"
    assert original_item["kcal"] == "400.00"

    portion.grams = Decimal("250")
    await db_session.commit()

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    item = response.json()["items"][0]
    assert item["quantity_g"] == "200.00"
    assert item["kcal"] == "400.00"


async def test_get_meal_uses_pinned_revision_not_foods_current_revision(client, db_session):
    """版本化的重點：GET 用項目當時釘住的 food_revision_id，不是食物現在的版本。

    記一餐之後，管理員審核通過一筆全新的營養素版本（kcal 從 200 改成 999），
    food.current_revision_id 因此往前移動 —— 但這一餐的數字必須完全不動，
    因為 meal_items.food_revision_id 釘住的是審核前那一版。
    """
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    # 全域食物（owner=None）：admin 審核流程只對全域食物有意義，
    # 私人食物的編輯是直接生效的（見 app/api/routes/foods.py propose_revision）。
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=10, fat_g=5, carb_g=20
    )

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json=_create_payload(items=[{"food_id": food.id, "quantity": "100"}]),
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]
    assert create_response.json()["items"][0]["kcal"] == "200.00"

    pending = await create_pending_revision(db_session, food=food, created_by=admin, kcal=999)
    approve_response = await client.post(
        f"/api/admin/food-revisions/{pending.id}/approve", headers=auth(admin)
    )
    assert approve_response.status_code == 200

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert body["items"][0]["kcal"] == "200.00"
    assert body["kcal"] == "200.00"
