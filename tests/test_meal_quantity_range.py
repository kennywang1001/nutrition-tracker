import pytest
from sqlalchemy import func, select

from app.models.food import FoodRevision
from app.models.meal import Meal, MealItem
from app.security.tokens import create_access_token
from tests.factories import create_food, create_meal, create_portion, create_user

# (份量的公克數, 數量)：一個換算後超過 Numeric(8,2)，一個四捨五入成 0。
OUT_OF_RANGE = [("10000", "10000"), ("0.01", "0.01")]


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _setup(db_session, grams: str):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, name="大鍋飯")
    portion = await create_portion(db_session, food=food, label="鍋", grams=grams, owner=user)
    return user, food, portion


@pytest.mark.parametrize(("grams", "quantity"), OUT_OF_RANGE)
async def test_creating_a_meal_is_422_and_saves_nothing(client, db_session, grams, quantity):
    user, food, portion = await _setup(db_session, grams)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-10-07T04:00:00Z",
            "meal_type": "lunch",
            "items": [{"food_id": food.id, "portion_id": portion.id, "quantity": quantity}],
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "QUANTITY_OUT_OF_RANGE"
    await db_session.rollback()
    assert await db_session.scalar(select(func.count()).select_from(Meal)) == 0


@pytest.mark.parametrize(("grams", "quantity"), OUT_OF_RANGE)
async def test_adding_an_item_is_422_and_saves_nothing(client, db_session, grams, quantity):
    user, food, portion = await _setup(db_session, grams)
    meal = await create_meal(db_session, user=user)
    meal_id = meal.id

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(user),
        json={"food_id": food.id, "portion_id": portion.id, "quantity": quantity},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "QUANTITY_OUT_OF_RANGE"
    await db_session.rollback()
    count = await db_session.scalar(
        select(func.count()).select_from(MealItem).where(MealItem.meal_id == meal_id)
    )
    assert count == 0


@pytest.mark.parametrize(("grams", "quantity"), OUT_OF_RANGE)
async def test_changing_an_item_is_422_and_keeps_the_old_grams(
    client, db_session, grams, quantity
):
    user, food, portion = await _setup(db_session, grams)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    meal = await create_meal(db_session, user=user, items=[(revision, 100)])
    item = await db_session.scalar(select(MealItem).where(MealItem.meal_id == meal.id))
    assert item is not None
    meal_id, item_id = meal.id, item.id

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": portion.id, "quantity": quantity},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "QUANTITY_OUT_OF_RANGE"
    await db_session.rollback()
    stored = await db_session.scalar(select(MealItem.quantity_g).where(MealItem.id == item_id))
    assert str(stored) == "100.00"


async def test_the_largest_and_smallest_valid_grams_still_work(client, db_session):
    """範圍的兩端都要能存，而且剛好落在端點上：
    399.96 g × 2500.25 = 999,999.9900（四捨五入到分仍是 999,999.99 g，正好是上限）；
    1 g × 0.01 = 0.01 g（正好是下限）。"""
    user, food, big = await _setup(db_session, "399.96")
    small = await create_portion(db_session, food=food, label="匙", grams="1", owner=user)

    responses = [
        await client.post(
            "/api/meals",
            headers=auth(user),
            json={
                "eaten_at": "2026-10-07T04:00:00Z",
                "meal_type": "lunch",
                "items": [{"food_id": food.id, "portion_id": portion.id, "quantity": quantity}],
            },
        )
        for portion, quantity in ((big, "2500.25"), (small, "0.01"))
    ]

    assert [r.status_code for r in responses] == [201, 201]
    assert [r.json()["items"][0]["quantity_g"] for r in responses] == ["999999.99", "0.01"]
