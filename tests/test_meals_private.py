from sqlalchemy import select

from app.models.food import FoodRevision
from app.models.meal import Meal
from app.security.tokens import create_access_token
from tests.factories import create_food, create_meal, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _food_id(db_session, user) -> int:
    food = await create_food(db_session, created_by=user, name="測試便當")
    return food.id


async def test_a_new_meal_is_shared_by_default(client, db_session):
    user = await create_user(db_session)
    food_id = await _food_id(db_session, user)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-10-07T04:00:00Z",
            "meal_type": "lunch",
            "items": [{"food_id": food_id, "quantity": "100"}],
        },
    )

    assert response.status_code == 201
    assert response.json()["is_private"] is False


async def test_a_meal_can_be_created_private(client, db_session):
    user = await create_user(db_session)
    food_id = await _food_id(db_session, user)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-10-07T04:00:00Z",
            "meal_type": "lunch",
            "items": [{"food_id": food_id, "quantity": "100"}],
            "is_private": True,
        },
    )

    assert response.status_code == 201
    assert response.json()["is_private"] is True
    meal_id = response.json()["id"]
    await db_session.rollback()
    stored = await db_session.scalar(select(Meal.is_private).where(Meal.id == meal_id))
    assert stored is True


async def test_switching_a_meal_private_and_back(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    meal_id = meal.id

    private = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"is_private": True}
    )
    listed = await client.get("/api/meals", headers=auth(user), params={"date": "2026-01-01"})
    shared = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"is_private": False}
    )

    assert private.json()["is_private"] is True
    assert [m["is_private"] for m in listed.json() if m["id"] == meal_id] == [True]
    assert shared.json()["is_private"] is False
    await db_session.rollback()
    stored = await db_session.scalar(select(Meal.is_private).where(Meal.id == meal_id))
    assert stored is False


async def test_an_explicit_null_is_rejected(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(user), json={"is_private": None}
    )

    assert response.status_code == 422


async def test_reading_one_meal_shows_the_flag(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    meal = await create_meal(db_session, user=user, items=[(revision, 100)])
    meal_id = meal.id
    await client.patch(f"/api/meals/{meal_id}", headers=auth(user), json={"is_private": True})

    response = await client.get(f"/api/meals/{meal_id}", headers=auth(user))

    assert response.json()["is_private"] is True
