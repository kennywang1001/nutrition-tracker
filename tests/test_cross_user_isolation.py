import pytest

from app.security.tokens import create_token
from tests.factories import create_food, create_portion, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


NUTRITION = {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"}


@pytest.fixture
async def alices_food(db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice, name="愛麗絲的便當")
    return alice, bob, food


async def test_bob_cannot_read_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_list_alices_revisions(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}/revisions", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_edit_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.post(
        f"/api/foods/{food.id}/revisions", headers=auth(bob), json={"nutrition": NUTRITION}
    )
    assert response.status_code == 404


async def test_bob_cannot_list_alices_portions(client, alices_food):
    _, bob, food = alices_food
    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(bob))
    assert response.status_code == 404


async def test_bob_cannot_add_a_portion_to_alices_food(client, alices_food):
    _, bob, food = alices_food
    response = await client.post(
        f"/api/foods/{food.id}/portions", headers=auth(bob), json={"label": "1 碗", "grams": "200"}
    )
    assert response.status_code == 404


async def test_bob_cannot_find_alices_food_by_search(client, alices_food):
    _, bob, food = alices_food
    response = await client.get("/api/foods", params={"q": "愛麗絲"}, headers=auth(bob))
    assert response.json() == []


async def test_bob_cannot_see_alices_portion_on_a_global_food(client, db_session):
    admin = await create_user(db_session)
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    await create_portion(db_session, food=food, label="愛麗絲的碗", owner=alice)

    response = await client.get(f"/api/foods/{food.id}/portions", headers=auth(bob))

    assert response.json() == []


async def test_every_isolation_failure_looks_identical(client, alices_food):
    """所有「不是你的」都必須跟「不存在」長得一模一樣。"""
    _, bob, food = alices_food

    not_yours = await client.get(f"/api/foods/{food.id}", headers=auth(bob))
    missing = await client.get("/api/foods/999999", headers=auth(bob))

    assert not_yours.status_code == missing.status_code
    assert not_yours.json() == missing.json()
