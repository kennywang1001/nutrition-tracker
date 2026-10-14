"""兩張表的約束與 cascade（身體資料規格 §4）。每一條「擋下來」都斷言是**哪一個**約束
（handover §6 第 13 種：別的約束先擋也是 IntegrityError）。"""

from datetime import date

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.models.body import UserProfile, WeightEntry
from app.models.user import User
from tests.factories import create_profile, create_user, create_weight

PROFILE_INSERT = (
    "INSERT INTO user_profiles (user_id, sex, birth_year, height_cm, activity_level, goal,"
    " rate_kg_per_week, target_weight_kg, targets_applied_weight_kg)"
    " VALUES (:user_id, :sex, :birth_year, :height_cm, :activity_level, :goal,"
    " :rate, :target, :applied)"
)
VALID = {
    "sex": "female",
    "birth_year": 1990,
    "height_cm": 160,
    "activity_level": "light",
    "goal": "gain",
    "rate": 0.25,
    "target": 60,
    "applied": 55,
}


async def _insert_profile(db_session, user_id: int, **overrides) -> None:
    async with db_session.begin_nested():
        await db_session.execute(text(PROFILE_INSERT), {**VALID, "user_id": user_id, **overrides})


async def test_a_valid_profile_and_an_all_null_profile_both_insert(db_session):
    first, second = await create_user(db_session), await create_user(db_session)
    first_id, second_id = first.id, second.id

    await _insert_profile(db_session, first_id)
    await _insert_profile(
        db_session,
        second_id,
        sex=None,
        birth_year=None,
        height_cm=None,
        activity_level=None,
        goal=None,
        rate=None,
        target=None,
        applied=None,
    )

    count = await db_session.scalar(
        select(func.count())
        .select_from(UserProfile)
        .where(UserProfile.user_id.in_([first_id, second_id]))
    )
    assert count == 2


@pytest.mark.parametrize(
    ("field", "value", "constraint"),
    [
        ("sex", "other", "ck_user_profiles_sex_valid"),
        ("birth_year", 1899, "ck_user_profiles_birth_year_sane"),
        ("height_cm", 99.9, "ck_user_profiles_height_range"),
        ("height_cm", 250.1, "ck_user_profiles_height_range"),
        ("activity_level", "extreme", "ck_user_profiles_activity_level_valid"),
        ("goal", "bulk", "ck_user_profiles_goal_valid"),
        ("rate", 0.3, "ck_user_profiles_rate_valid"),
        ("target", 24.99, "ck_user_profiles_target_weight_range"),
        ("applied", 350.01, "ck_user_profiles_applied_weight_range"),
    ],
)
async def test_each_profile_check_rejects_its_own_bad_value(db_session, field, value, constraint):
    """只改一個欄位，其他都是 VALID——擋下來的一定是那個欄位的約束。"""
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        await _insert_profile(db_session, user_id, **{field: value})

    assert constraint in str(caught.value.orig)


@pytest.mark.parametrize(
    ("field", "value"), [("height_cm", 100), ("height_cm", 250), ("target", 25), ("target", 350)]
)
async def test_the_range_edges_are_inclusive(db_session, field, value):
    user = await create_user(db_session)
    user_id = user.id

    await _insert_profile(db_session, user_id, **{field: value})


async def test_one_weight_per_user_per_day(db_session):
    user = await create_user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=date(2026, 10, 1), weight_kg=70)

    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (:u, :d, 71)"),
                {"u": user_id, "d": date(2026, 10, 1)},
            )

    assert "pk_weight_entries" in str(caught.value.orig)


@pytest.mark.parametrize("weight", [24.99, 350.01])
async def test_a_weight_out_of_range_is_rejected(db_session, weight):
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        async with db_session.begin_nested():
            await db_session.execute(
                text("INSERT INTO weight_entries (user_id, date, weight_kg) VALUES (:u, :d, :w)"),
                {"u": user_id, "d": date(2026, 10, 1), "w": weight},
            )

    assert "ck_weight_entries_weight_range" in str(caught.value.orig)


async def test_deleting_a_user_takes_the_profile_and_the_weights(db_session):
    user = await create_user(db_session)
    other = await create_user(db_session)
    await create_profile(db_session, user=user)
    await create_profile(db_session, user=other)
    await create_weight(db_session, user=user, day=date(2026, 10, 1))
    await create_weight(db_session, user=other, day=date(2026, 10, 1))
    user_id, other_id = user.id, other.id

    await db_session.execute(delete(User).where(User.id == user_id))
    await db_session.commit()

    profiles = (await db_session.scalars(select(UserProfile.user_id))).all()
    weights = (await db_session.scalars(select(WeightEntry.user_id))).all()
    assert user_id not in profiles and user_id not in weights
    # 別人的還在：cascade 沒有多刪。
    assert other_id in profiles and other_id in weights
