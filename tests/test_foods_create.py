from sqlalchemy import select

from app.models.food import Food, FoodRevision, RevisionStatus
from app.security.tokens import create_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def test_create_food_returns_the_food_with_its_nutrition(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "brand": None,
            "nutrition": {
                "base_unit": "g",
                "kcal": "180.5",
                "protein_g": "6.2",
                "fat_g": "7.1",
                "carb_g": "22.4",
            },
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["name"] == "滷肉飯"
    assert body["is_global"] is False
    assert body["nutrition"]["kcal"] == "180.50"
    assert body["nutrition"]["base_unit"] == "g"


async def test_create_food_persists_food_and_first_revision_and_links_them(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"},
        },
    )

    food = await db_session.scalar(select(Food).where(Food.id == response.json()["id"]))
    assert food is not None
    assert food.owner_id == user.id
    assert food.current_revision_id is not None

    revision = await db_session.get(FoodRevision, food.current_revision_id)
    assert revision is not None
    assert revision.food_id == food.id
    assert revision.status is RevisionStatus.APPROVED


async def test_create_food_requires_authentication(client):
    response = await client.post(
        "/api/foods",
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 401


async def test_create_food_rejects_negative_nutrition(client, db_session):
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "-1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 422


async def test_create_food_rejects_a_duplicate_name_for_the_same_owner(client, db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="滷肉飯")

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "FOOD_EXISTS"


async def test_two_users_can_each_have_a_food_with_the_same_name(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    await create_food(db_session, created_by=alice, owner=alice, name="滷肉飯")

    response = await client.post(
        "/api/foods",
        headers=auth(bob),
        json={
            "name": "滷肉飯",
            "nutrition": {"kcal": "1", "protein_g": "1", "fat_g": "1", "carb_g": "1"},
        },
    )

    assert response.status_code == 201
