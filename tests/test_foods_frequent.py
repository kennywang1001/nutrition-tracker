from datetime import UTC, datetime

from app.models.food import FoodRevision
from app.security.tokens import create_access_token
from tests.factories import create_food, create_meal, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _current_revision(db_session, food) -> FoodRevision:
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    return revision


async def test_frequent_orders_by_count_descending(client, db_session):
    user = await create_user(db_session)
    food_a = await create_food(db_session, created_by=user, owner=user, name="常吃的A")
    food_b = await create_food(db_session, created_by=user, owner=user, name="偶爾吃的B")
    revision_a = await _current_revision(db_session, food_a)
    revision_b = await _current_revision(db_session, food_b)

    # A 吃三次（三筆不同的餐），B 只吃一次。
    for _ in range(3):
        await create_meal(db_session, user=user, items=[(revision_a, 100)])
    await create_meal(db_session, user=user, items=[(revision_b, 100)])

    response = await client.get("/api/foods/frequent", headers=auth(user))

    assert response.status_code == 200
    names = [item["name"] for item in response.json()]
    assert names == ["常吃的A", "偶爾吃的B"]


async def test_recent_orders_by_last_eaten_descending(client, db_session):
    user = await create_user(db_session)
    food_old = await create_food(db_session, created_by=user, owner=user, name="很久以前吃的")
    food_new = await create_food(db_session, created_by=user, owner=user, name="剛剛吃的")
    revision_old = await _current_revision(db_session, food_old)
    revision_new = await _current_revision(db_session, food_new)

    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 8, 0, tzinfo=UTC),
        items=[(revision_old, 100)],
    )
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 3, 8, 0, tzinfo=UTC),
        items=[(revision_new, 100)],
    )
    # food_old 又在更晚的時間吃了一次，最後一次吃的時間應該取 MAX，
    # 而不是第一次吃的時間或建立食物的時間。
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 5, 8, 0, tzinfo=UTC),
        items=[(revision_old, 100)],
    )

    response = await client.get("/api/foods/recent", headers=auth(user))

    assert response.status_code == 200
    names = [item["name"] for item in response.json()]
    assert names == ["很久以前吃的", "剛剛吃的"]


async def test_frequent_only_counts_own_meals(client, db_session):
    """食物刻意用全域的（owner=None），Bob 看得到這個食物本身 ——
    要斷言的是「沒吃過」不會出現，不是「看不到」不會出現。用私人食物的話，
    `Food.owner_id` 那個防禦性可見性過濾就會先擋掉，測不到 `Meal.user_id`
    這個真正在做事的過濾條件（實測過：拿掉 `Meal.user_id` 過濾，用私人食物
    寫的版本一個測試都不會失敗）。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, name="全域食物只有愛麗絲吃過")
    revision = await _current_revision(db_session, food)
    await create_meal(db_session, user=alice, items=[(revision, 100)])

    response = await client.get("/api/foods/frequent", headers=auth(bob))

    assert response.status_code == 200
    assert response.json() == []


async def test_recent_only_counts_own_meals(client, db_session):
    """跟上面同一個理由：用全域食物才能真正測到 `Meal.user_id` 過濾。"""
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, name="全域食物只有愛麗絲吃過")
    revision = await _current_revision(db_session, food)
    await create_meal(db_session, user=alice, items=[(revision, 100)])

    response = await client.get("/api/foods/recent", headers=auth(bob))

    assert response.status_code == 200
    assert response.json() == []


async def test_frequent_and_recent_return_current_revision_not_pinned(client, db_session):
    """核心設計點：跟 GET /api/meals/{id} 相反 —— 這裡要回傳食物「目前」的版本，
    不是紀錄當時釘住的版本。同一個食物在兩個端點會給不同數字，這是刻意的。
    """
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, owner=user, name="會改版的食物", kcal=200
    )

    create_response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-01-01T12:00:00+08:00",
            "meal_type": "lunch",
            "items": [{"food_id": food.id, "quantity": "100"}],
        },
    )
    assert create_response.status_code == 201
    meal_id = create_response.json()["id"]
    assert create_response.json()["items"][0]["kcal"] == "200.00"

    # 核准一筆新版本（私人食物的編輯直接生效）。
    revise_response = await client.post(
        f"/api/foods/{food.id}/revisions",
        headers=auth(user),
        json={
            "nutrition": {
                "base_unit": "g",
                "kcal": "999",
                "protein_g": "10",
                "fat_g": "5",
                "carb_g": "20",
            }
        },
    )
    assert revise_response.status_code == 201

    meal_response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    frequent_response = await client.get("/api/foods/frequent", headers=auth(user))
    recent_response = await client.get("/api/foods/recent", headers=auth(user))

    # 歷史紀錄：吃的當下釘住的舊數值不變。
    assert meal_response.json()["items"][0]["kcal"] == "200.00"

    # 快速再記一筆：要用食物「現在」的營養素，不是當時釘住的。
    assert frequent_response.json()[0]["nutrition"]["kcal"] == "999.00"
    assert recent_response.json()[0]["nutrition"]["kcal"] == "999.00"


async def test_same_food_across_multiple_meals_appears_once(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, name="重複吃的食物")
    revision = await _current_revision(db_session, food)
    await create_meal(db_session, user=user, items=[(revision, 100)])
    await create_meal(db_session, user=user, items=[(revision, 150)])
    await create_meal(db_session, user=user, items=[(revision, 200)])

    frequent_response = await client.get("/api/foods/frequent", headers=auth(user))
    recent_response = await client.get("/api/foods/recent", headers=auth(user))

    assert len(frequent_response.json()) == 1
    assert len(recent_response.json()) == 1


async def test_no_meals_returns_empty_array(client, db_session):
    user = await create_user(db_session)

    frequent_response = await client.get("/api/foods/frequent", headers=auth(user))
    recent_response = await client.get("/api/foods/recent", headers=auth(user))

    assert frequent_response.status_code == 200
    assert frequent_response.json() == []
    assert recent_response.status_code == 200
    assert recent_response.json() == []


async def test_limit_parameter_caps_results(client, db_session):
    user = await create_user(db_session)
    foods = [
        await create_food(db_session, created_by=user, owner=user, name=f"食物{i}")
        for i in range(5)
    ]
    for food in foods:
        revision = await _current_revision(db_session, food)
        await create_meal(db_session, user=user, items=[(revision, 100)])

    frequent_response = await client.get(
        "/api/foods/frequent", params={"limit": 2}, headers=auth(user)
    )
    recent_response = await client.get(
        "/api/foods/recent", params={"limit": 2}, headers=auth(user)
    )

    assert len(frequent_response.json()) == 2
    assert len(recent_response.json()) == 2


async def test_frequent_and_recent_require_authentication(client, db_session):
    frequent_response = await client.get("/api/foods/frequent")
    recent_response = await client.get("/api/foods/recent")

    assert frequent_response.status_code == 401
    assert recent_response.status_code == 401
