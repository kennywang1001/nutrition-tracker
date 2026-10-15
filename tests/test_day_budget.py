"""`load_day_budget`（營養素配餐規格 D1）：某一天的實際、生效的目標、運動、熱量額度。
`/stats/daily` 與營養素配餐共用它；端點的行為由 tests/test_stats_daily.py 守著。"""

from datetime import UTC, date, datetime
from decimal import Decimal

from app.day_budget import load_day_budget, target_on
from app.models.food import FoodRevision
from tests.factories import (
    create_exercise,
    create_food,
    create_intake,
    create_meal,
    create_supplement,
    create_target,
    create_user,
)

DAY = date(2026, 10, 14)
# 紐約 10/14 12:00（EDT）。
NOON = datetime(2026, 10, 14, 16, 0, tzinfo=UTC)


async def _new_yorker(db_session):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def test_the_budget_adds_the_days_exercise_and_actual_includes_supplements(db_session):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000, protein_g=90)
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=10, fat_g=5, carb_g=20
    )
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(db_session, user=user, eaten_at=NOON, items=[(revision, Decimal("150"))])
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(db_session, user=user, supplement=supplement, taken_at=NOON, kcal=20)
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=user.id, tz_name="America/New_York", adds_exercise=True, day=DAY
    )

    assert budget.macros.actual.kcal == Decimal("320.00")  # 300 食物 + 20 補劑
    assert budget.target is not None and budget.target.protein_g == Decimal("90.00")
    assert budget.exercise_kcal == Decimal("343.00")
    assert budget.kcal_budget == Decimal("2343.00")


async def test_with_the_setting_off_the_budget_is_the_target(db_session):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000)
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=user.id, tz_name="America/New_York", adds_exercise=False, day=DAY
    )

    assert budget.exercise_kcal == Decimal("343.00")
    assert budget.kcal_budget == Decimal("2000.00")


async def test_without_a_target_there_is_no_budget(db_session):
    user = await _new_yorker(db_session)
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=user.id, tz_name="America/New_York", adds_exercise=True, day=DAY
    )

    assert budget.target is None
    assert budget.kcal_budget is None


async def test_the_target_is_the_one_in_effect_that_day(db_session):
    """半開區間：effective_to 那一天已經是下一筆。"""
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=1800,
        effective_from=date(2026, 1, 1), effective_to=DAY,
    )  # fmt: skip
    await create_target(db_session, user=user, kcal=2200, effective_from=DAY)

    on_the_day = await target_on(db_session, user.id, DAY)
    the_day_before = await target_on(db_session, user.id, date(2026, 10, 13))

    assert on_the_day is not None and on_the_day.kcal == Decimal("2200.00")
    assert the_day_before is not None and the_day_before.kcal == Decimal("1800.00")


async def test_another_users_data_is_not_counted(db_session):
    me = await create_user(db_session)
    other = await create_user(db_session)
    await create_target(db_session, user=other, kcal=2000)
    await create_exercise(db_session, user=other, performed_at=NOON, kcal=343)

    budget = await load_day_budget(
        db_session, user_id=me.id, tz_name="Asia/Taipei", adds_exercise=True, day=DAY
    )

    assert budget.target is None
    assert budget.exercise_kcal == Decimal("0.00")
