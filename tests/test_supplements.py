from app.security.tokens import create_token
from tests.factories import create_supplement, create_user

NUTRITION = {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_create_supplement_returns_the_supplement(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/supplements",
        headers=auth(user),
        json={
            "name": "魚油",
            "brand": "牌子A",
            "serving_unit": "capsule",
            "serving_size": "1",
            **NUTRITION,
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "魚油"
    assert body["brand"] == "牌子A"
    assert body["is_global"] is False
    assert body["serving_unit"] == "capsule"
    assert body["serving_size"] == "1.00"
    assert body["kcal"] == "1.00"


async def test_create_supplement_requires_authentication(client):
    response = await client.post(
        "/api/supplements",
        json={"name": "魚油", "serving_unit": "capsule", "serving_size": "1", **NUTRITION},
    )

    assert response.status_code == 401


async def test_create_supplement_rejects_a_duplicate_name_and_brand_for_the_same_owner(
    client, db_session
):
    user = await create_user(db_session)
    await create_supplement(db_session, created_by=user, owner=user, name="魚油", brand="牌子A")

    response = await client.post(
        "/api/supplements",
        headers=auth(user),
        json={
            "name": "魚油",
            "brand": "牌子A",
            "serving_unit": "capsule",
            "serving_size": "1",
            **NUTRITION,
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SUPPLEMENT_EXISTS"


async def test_two_users_can_each_have_a_supplement_with_the_same_name_and_brand(
    client, db_session
):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_supplement(db_session, created_by=alice, owner=alice, name="魚油", brand="牌子A")

    response = await client.post(
        "/api/supplements",
        headers=auth(bob),
        json={
            "name": "魚油",
            "brand": "牌子A",
            "serving_unit": "capsule",
            "serving_size": "1",
            **NUTRITION,
        },
    )

    assert response.status_code == 201


async def test_create_supplement_rejects_a_non_positive_serving_size(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/supplements",
        headers=auth(user),
        json={"name": "魚油", "serving_unit": "capsule", "serving_size": "0", **NUTRITION},
    )

    assert response.status_code == 422


async def test_create_supplement_rejects_negative_macros(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/supplements",
        headers=auth(user),
        json={
            "name": "魚油",
            "serving_unit": "capsule",
            "serving_size": "1",
            "kcal": "-1",
            "protein_g": "1",
            "fat_g": "1",
            "carb_g": "1",
        },
    )

    assert response.status_code == 422


async def test_create_supplement_defaults_macros_to_zero(client, db_session):
    """魚油那種只記錄吃了沒、不記熱量的補劑（計畫決定 1 附帶的情境）。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/supplements",
        headers=auth(user),
        json={"name": "維生素D", "serving_unit": "capsule", "serving_size": "1"},
    )

    assert response.status_code == 201
    body = response.json()
    assert body["kcal"] == "0.00"
    assert body["protein_g"] == "0.00"
    assert body["fat_g"] == "0.00"
    assert body["carb_g"] == "0.00"


async def test_search_returns_both_global_and_own_supplements(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_supplement(db_session, created_by=admin, name="全域魚油")
    await create_supplement(db_session, created_by=user, owner=user, name="我的魚油")

    response = await client.get("/api/supplements", params={"q": "魚油"}, headers=auth(user))

    assert response.status_code == 200
    names = {item["name"] for item in response.json()}
    assert names == {"全域魚油", "我的魚油"}


async def test_search_never_returns_another_users_supplement(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_supplement(db_session, created_by=alice, owner=alice, name="愛麗絲的魚油")

    response = await client.get("/api/supplements", params={"q": "魚油"}, headers=auth(bob))

    assert response.json() == []


async def test_scope_global_excludes_own_supplements(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_supplement(db_session, created_by=admin, name="全域魚油")
    await create_supplement(db_session, created_by=user, owner=user, name="我的魚油")

    response = await client.get(
        "/api/supplements", params={"q": "魚油", "scope": "global"}, headers=auth(user)
    )

    names = {item["name"] for item in response.json()}
    assert names == {"全域魚油"}


async def test_scope_mine_excludes_global_supplements(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_supplement(db_session, created_by=admin, name="全域魚油")
    await create_supplement(db_session, created_by=user, owner=user, name="我的魚油")

    response = await client.get(
        "/api/supplements", params={"q": "魚油", "scope": "mine"}, headers=auth(user)
    )

    names = {item["name"] for item in response.json()}
    assert names == {"我的魚油"}


async def test_search_requires_authentication(client):
    response = await client.get("/api/supplements")

    assert response.status_code == 401
