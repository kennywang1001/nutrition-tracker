from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.expense import Expense, ExpenseCategory
from app.models.meal import Meal
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_meal, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_the_database_refuses_a_second_expense_for_the_same_meal(db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    await create_expense(db_session, user=user, amount=100, meal=meal)

    db_session.add(
        Expense(
            user_id=user.id,
            meal_id=meal.id,
            category=ExpenseCategory.FOOD,
            amount=Decimal("50"),
            spent_at=datetime(2026, 1, 1, 12, tzinfo=UTC),
        )
    )
    with pytest.raises(IntegrityError, match="uq_expenses_meal_id"):
        await db_session.flush()


async def test_expenses_without_a_meal_are_unrestricted(db_session):
    user = await create_user(db_session)

    await create_expense(db_session, user=user, amount=100)
    await create_expense(db_session, user=user, amount=200)


async def test_adding_a_cost_that_someone_else_just_added_is_409_and_saves_nothing(
    client, db_session, monkeypatch
):
    """「同時補金額」：查的時候還沒有餐費，送出時另一個請求剛補了一筆。
    用 `_existing_meal_expense` 回 None 模擬「沒看到對方那一筆」。"""
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, note="原本的備註")
    await create_expense(db_session, user=user, amount=50, meal=meal)
    meal_id = meal.id

    async def did_not_see_it(db, meal_id):
        return None

    monkeypatch.setattr("app.api.routes.meals._existing_meal_expense", did_not_see_it)

    response = await client.patch(
        f"/api/meals/{meal_id}",
        headers=auth(user),
        json={"cost": "80", "note": "新的備註"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "MEAL_COST_CONFLICT"
    await db_session.rollback()
    amounts = (
        await db_session.scalars(select(Expense.amount).where(Expense.meal_id == meal_id))
    ).all()
    assert amounts == [Decimal("50.00")]
    note = await db_session.scalar(select(Meal.note).where(Meal.id == meal_id))
    assert note == "原本的備註"
