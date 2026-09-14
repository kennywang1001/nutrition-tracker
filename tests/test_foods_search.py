from app.security.tokens import create_access_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_search_returns_both_global_and_own_foods(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="全域滷肉飯")
    await create_food(db_session, created_by=user, owner=user, name="我的滷肉飯")

    response = await client.get("/api/foods", params={"q": "滷肉"}, headers=auth(user))

    assert response.status_code == 200
    names = {item["name"] for item in response.json()}
    assert names == {"全域滷肉飯", "我的滷肉飯"}


async def test_search_never_returns_another_users_food(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的滷肉飯")

    response = await client.get("/api/foods", params={"q": "滷肉"}, headers=auth(bob))

    assert response.json() == []


async def test_scope_global_excludes_own_foods(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="全域滷肉飯")
    await create_food(db_session, created_by=user, owner=user, name="我的滷肉飯")

    response = await client.get(
        "/api/foods", params={"q": "滷肉", "scope": "global"}, headers=auth(user)
    )

    names = {item["name"] for item in response.json()}
    assert names == {"全域滷肉飯"}


async def test_scope_mine_excludes_global_foods(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="全域滷肉飯")
    await create_food(db_session, created_by=user, owner=user, name="我的滷肉飯")

    response = await client.get(
        "/api/foods", params={"q": "滷肉", "scope": "mine"}, headers=auth(user)
    )

    names = {item["name"] for item in response.json()}
    assert names == {"我的滷肉飯"}


async def test_search_without_a_query_returns_everything_visible(client, db_session):
    admin = await create_user(db_session)
    user = await create_user(db_session)
    await create_food(db_session, created_by=admin, name="茶葉蛋")
    await create_food(db_session, created_by=user, owner=user, name="便當")

    response = await client.get("/api/foods", headers=auth(user))

    assert len(response.json()) == 2


async def test_search_is_case_insensitive_and_partial(client, db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="Chicken Breast")

    response = await client.get("/api/foods", params={"q": "chick"}, headers=auth(user))

    assert len(response.json()) == 1


async def test_search_rejects_an_unknown_scope(client, db_session):
    user = await create_user(db_session)

    response = await client.get("/api/foods", params={"scope": "everything"}, headers=auth(user))

    assert response.status_code == 422
