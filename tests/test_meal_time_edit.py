from datetime import UTC, datetime

from sqlalchemy import select

from app.models.expense import Expense, ExpenseCategory
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_meal, create_user

OCT_3 = datetime(2026, 10, 3, 4, tzinfo=UTC)  # 台北 10/3 中午
SEP_28 = datetime(2026, 9, 28, 11, tzinfo=UTC)  # 台北 9/28 晚上 7 點


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _meal_with_cost(db_session, user):
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)
    expense = await create_expense(
        db_session,
        user=user,
        amount=120,
        category=ExpenseCategory.FOOD,
        spent_at=OCT_3,
        meal=meal,
    )
    return meal.id, expense.id


async def test_moving_a_meal_moves_its_cost(client, db_session):
    user = await create_user(db_session)
    meal_id, expense_id = await _meal_with_cost(db_session, user)

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"eaten_at": "2026-09-28T11:00:00Z"}
    )

    assert response.status_code == 200
    await db_session.rollback()
    spent_at = await db_session.scalar(select(Expense.spent_at).where(Expense.id == expense_id))
    assert spent_at == SEP_28


async def test_the_cost_moves_to_the_new_month_in_the_report(client, db_session):
    user = await create_user(db_session)
    meal_id, expense_id = await _meal_with_cost(db_session, user)

    await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"eaten_at": "2026-09-28T11:00:00Z"}
    )
    september = await client.get("/api/expenses", headers=auth(user), params={"month": "2026-09"})
    october = await client.get("/api/expenses", headers=auth(user), params={"month": "2026-10"})

    assert expense_id in [e["id"] for e in september.json()]
    assert expense_id not in [e["id"] for e in october.json()]


async def test_a_meal_without_a_cost_just_moves(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)

    response = await client.patch(
        f"/api/meals/{meal.id}", headers=auth(user), json={"eaten_at": "2026-09-28T11:00:00Z"}
    )

    assert response.status_code == 200
    assert response.json()["eaten_at"].startswith("2026-09-28T11:00:00")
    assert response.json()["cost"] is None


async def test_moving_and_adding_a_cost_at_once_uses_the_new_time(client, db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)
    meal_id = meal.id

    response = await client.patch(
        f"/api/meals/{meal_id}",
        headers=auth(user),
        json={"eaten_at": "2026-09-28T11:00:00Z", "cost": "90"},
    )

    assert response.status_code == 200
    await db_session.rollback()
    spent_at = await db_session.scalar(select(Expense.spent_at).where(Expense.meal_id == meal_id))
    assert spent_at == SEP_28


async def _meal_whose_cost_is_on_another_day(db_session, user):
    """餐費的 `spent_at` 跟 `eaten_at` 不一樣（例如改時間功能之前記的、或報表的
    `PATCH /api/expenses/{id}` 改過）。只有改 `eaten_at` 才把它拉回來。"""
    meal = await create_meal(db_session, user=user, eaten_at=OCT_3)
    expense = await create_expense(
        db_session,
        user=user,
        amount=120,
        category=ExpenseCategory.FOOD,
        spent_at=SEP_28,
        meal=meal,
    )
    return meal.id, expense.id


async def test_editing_only_the_note_leaves_the_cost_date_alone(client, db_session):
    user = await create_user(db_session)
    meal_id, expense_id = await _meal_whose_cost_is_on_another_day(db_session, user)

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"note": "加蛋"}
    )

    assert response.status_code == 200
    await db_session.rollback()
    spent_at = await db_session.scalar(select(Expense.spent_at).where(Expense.id == expense_id))
    assert spent_at == SEP_28


async def test_editing_only_the_cost_leaves_the_cost_date_alone(client, db_session):
    """改金額會讀出既有的餐費——那時 `spent_at` 也不能被順手改成 `eaten_at`。"""
    user = await create_user(db_session)
    meal_id, expense_id = await _meal_whose_cost_is_on_another_day(db_session, user)

    response = await client.patch(f"/api/meals/{meal_id}", headers=auth(user), json={"cost": "150"})

    assert response.status_code == 200
    await db_session.rollback()
    spent_at = await db_session.scalar(select(Expense.spent_at).where(Expense.id == expense_id))
    assert spent_at == SEP_28
