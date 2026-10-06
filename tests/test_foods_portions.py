from sqlalchemy import select

from app.models.food import FoodPortion
from app.models.user import UserRole
from app.security.tokens import create_access_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_anyone_can_add_a_personal_portion_to_a_global_food(client, db_session):
    """「一碗」因人而異 —— 任何人都可以在任何食物上加自己的份量。"""
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "我的碗", "grams": "230"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["is_global"] is False
    assert body["grams"] == "230.00"


async def test_listing_portions_shows_global_and_own_but_not_others(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="1 碗", grams=200)
    await create_portion(db_session, food=food, label="愛麗絲的碗", grams=180, owner=alice)
    await create_portion(db_session, food=food, label="鮑伯的碗", grams=260, owner=bob)

    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(alice))

    labels = {item["label"] for item in response.json()}
    assert labels == {"1 碗", "愛麗絲的碗"}


async def test_a_normal_user_cannot_create_a_global_portion(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "1 碗", "grams": "200", "is_global": True},
    )

    assert response.status_code == 403
    assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_an_admin_can_create_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(admin),
        json={"label": "1 碗", "grams": "200", "is_global": True},
    )

    assert response.status_code == 201
    assert response.json()["is_global"] is True


async def test_duplicate_label_for_the_same_owner_is_rejected(client, db_session):
    """Task 11（計畫 4a）跨端點的 rollback 稽核發現：這個路徑的
    `await db.rollback()` 拿掉之後，全部既有測試照樣通過 —— 跟計畫 4a
    Task 5 在 `supplement_plans.py` 踩到的坑同一個形狀：測試在拿到 409
    之後就結束，沒有人在**同一個 session** 上再做一次資料庫操作。

    補法比照 Task 5 之後那些接了 rollback 的測試：409 之後用同一個
    client（背後是同一個 db_session）再打一次列表端點，證明它還能正常用。
    這是在稽核發現存活之後才補上的斷言。
    """
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="我的碗", owner=user)
    headers = auth(user)
    food_id = food.id

    response = await client.post(
        f"/api/foods/{food_id}/portions",
        headers=headers,
        json={"label": "我的碗", "grams": "999"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PORTION_EXISTS"

    # rollback 是否必要，要靠「同一個 session 之後還能用」來驗證：漏掉的話
    # 這裡會拋 PendingRollbackError，而不是單純讓上面的斷言變紅。
    listing = await client.get(f"/api/foods/{food_id}/portions", headers=headers)
    assert listing.status_code == 200
    assert len(listing.json()) == 1


async def test_two_users_can_use_the_same_label(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="1 碗", owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(bob),
        json={"label": "1 碗", "grams": "260"},
    )

    assert response.status_code == 201


async def test_adding_a_portion_to_another_users_food_returns_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(bob),
        json={"label": "1 碗", "grams": "200"},
    )

    assert response.status_code == 404


async def test_grams_must_be_positive(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": "空碗", "grams": "0"},
    )

    assert response.status_code == 422


async def _post_portion(client, user, food, label, *, is_default, is_global=False):
    response = await client.post(
        f"/api/foods/{food.id}/portions",
        headers=auth(user),
        json={"label": label, "grams": "200", "is_default": is_default, "is_global": is_global},
    )
    assert response.status_code == 201
    return response.json()


async def _defaults(client, user, food):
    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(user))
    return {item["label"] for item in response.json() if item["is_default"]}


async def test_a_second_own_default_replaces_the_first(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)

    await _post_portion(client, user, food, "小碗", is_default=True)
    await _post_portion(client, user, food, "大碗", is_default=True)

    assert await _defaults(client, user, food) == {"大碗"}


async def test_a_new_default_does_not_touch_other_owners_defaults(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="公開碗", is_default=True)
    await create_portion(db_session, food=food, label="鮑伯碗", owner=bob, is_default=True)

    await _post_portion(client, alice, food, "愛麗絲碗", is_default=True)

    assert await _defaults(client, alice, food) == {"公開碗", "愛麗絲碗"}
    assert await _defaults(client, bob, food) == {"公開碗", "鮑伯碗"}


async def test_a_new_global_default_replaces_only_the_global_default(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="舊公開", is_default=True)
    await create_portion(db_session, food=food, label="我的碗", owner=user, is_default=True)

    await _post_portion(client, admin, food, "新公開", is_default=True, is_global=True)

    assert await _defaults(client, user, food) == {"新公開", "我的碗"}


async def test_a_non_default_portion_leaves_the_existing_default_alone(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await _post_portion(client, user, food, "小碗", is_default=True)

    await _post_portion(client, user, food, "大碗", is_default=False)

    assert await _defaults(client, user, food) == {"小碗"}


async def _meal_with_portion(client, user, food, portion) -> int:
    """用這個份量記一份，回傳那一餐的 id。"""
    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-12-15T12:00:00+08:00",
            "meal_type": "lunch",
            "items": [{"food_id": food.id, "quantity": "1", "portion_id": portion.id}],
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


async def test_owner_can_rename_a_portion_and_other_fields_stay(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}",
        headers=auth(user),
        json={"label": "大碗"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "大碗"
    assert body["grams"] == "200.00"
    assert body["is_default"] is False


async def test_changing_grams_does_not_touch_meals_already_recorded(client, db_session):
    """凍結歷史（handover §4.3）：改的是之後要記的，不是已經記下的。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)
    meal_id = await _meal_with_portion(client, user, food, portion)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}",
        headers=auth(user),
        json={"grams": "300"},
    )
    assert patched.json()["grams"] == "300.00"

    meal = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert meal.json()["items"][0]["quantity_g"] == "200.00"


async def test_making_a_portion_default_unsets_only_the_same_owners_default(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)  # 全域食物
    public_default = await create_portion(
        db_session, food=food, label="公開碗", grams=150, owner=None, is_default=True
    )
    own_default = await create_portion(
        db_session, food=food, label="我的碗", grams=200, owner=user, is_default=True
    )
    other = await create_portion(db_session, food=food, label="我的盤", grams=300, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{other.id}",
        headers=auth(user),
        json={"is_default": True},
    )

    assert response.status_code == 200
    await db_session.refresh(own_default)
    await db_session.refresh(public_default)
    assert own_default.is_default is False
    assert public_default.is_default is True


async def test_deleting_a_portion_keeps_recorded_grams(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)
    meal_id = await _meal_with_portion(client, user, food, portion)

    response = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user)
    )

    assert response.status_code == 204
    item = (await client.get(f"/api/meals/{meal_id}", headers=auth(user))).json()["items"][0]
    assert item["portion_id"] is None
    assert item["quantity_g"] == "200.00"


async def test_someone_elses_private_portion_is_404_and_unchanged(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice)  # 全域食物：Bob 看得到食物本身
    portion = await create_portion(
        db_session, food=food, label="Alice 的碗", grams=200, owner=alice
    )

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(bob), json={"grams": "1"}
    )
    deleted = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(bob)
    )

    assert patched.status_code == 404
    assert deleted.status_code == 404
    await db_session.refresh(portion)
    assert str(portion.grams) == "200.00"


async def test_a_normal_user_cannot_change_or_delete_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=None)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user), json={"grams": "1"}
    )
    deleted = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user)
    )

    assert patched.status_code == 403
    assert deleted.status_code == 403


async def test_an_admin_can_change_and_delete_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=admin)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=None)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(admin), json={"grams": "250"}
    )
    deleted = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(admin)
    )

    assert patched.status_code == 200
    assert deleted.status_code == 204


async def test_a_portion_of_another_food_in_the_path_is_404(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    other_food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=other_food, label="碗", grams=200, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user), json={"grams": "1"}
    )

    assert response.status_code == 404


async def test_renaming_to_an_existing_label_is_409(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    await create_portion(db_session, food=food, label="碗", grams=200, owner=user)
    plate = await create_portion(db_session, food=food, label="盤", grams=300, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{plate.id}", headers=auth(user), json={"label": "碗"}
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PORTION_EXISTS"


async def test_explicit_null_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user), json={"grams": None}
    )

    assert response.status_code == 422


async def test_a_portion_on_an_invisible_food_is_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)  # Alice 的私人食物
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=alice)

    response = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(bob)
    )

    assert response.status_code == 404
    assert await db_session.scalar(select(FoodPortion).where(FoodPortion.id == portion.id))
