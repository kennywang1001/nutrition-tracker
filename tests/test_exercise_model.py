"""運動紀錄的約束、cascade 與 users 的新欄位（運動規格 §5）。每一條「擋下來」都斷言是
**哪一個**約束（handover §6 第 13 種：別的約束先擋也是 IntegrityError）。"""

from datetime import UTC, datetime

import pytest
from sqlalchemy import delete, func, select, text
from sqlalchemy.exc import IntegrityError

from app.exercise import ActivityCode
from app.models.exercise import ExerciseEntry
from app.models.user import User
from tests.factories import create_exercise, create_user

EXERCISE_INSERT = (
    "INSERT INTO exercise_entries (user_id, performed_at, activity, name, minutes, kcal,"
    " kcal_source, note)"
    " VALUES (:user_id, :performed_at, :activity, :name, :minutes, :kcal, :kcal_source, :note)"
)
# 規格 §4.1 那一筆：跑步 30 分鐘、343 kcal、估算的。
VALID = {
    "performed_at": datetime(2026, 10, 14, 0, 0, tzinfo=UTC),
    "activity": "running",
    "name": None,
    "minutes": 30,
    "kcal": 343,
    "kcal_source": "estimated",
    "note": None,
}
# 「其他」合法的那一組：有名稱、手動的熱量。
OTHER = {"activity": "other", "name": "划船", "kcal_source": "manual"}


async def _insert(db_session, user_id: int, **overrides) -> None:
    async with db_session.begin_nested():
        await db_session.execute(text(EXERCISE_INSERT), {**VALID, "user_id": user_id, **overrides})


async def _count(db_session, user_id: int) -> int:
    total: int = await db_session.scalar(
        select(func.count()).select_from(ExerciseEntry).where(ExerciseEntry.user_id == user_id)
    )
    return total


async def test_the_default_row_and_a_valid_other_row_insert(db_session):
    user = await create_user(db_session)
    user_id = user.id

    await _insert(db_session, user_id)
    await _insert(db_session, user_id, **OTHER)

    assert await _count(db_session, user_id) == 2


@pytest.mark.parametrize(
    ("overrides", "constraint"),
    [
        ({"activity": "swim"}, "ck_exercise_entries_activity_valid"),
        ({"kcal_source": "guess"}, "ck_exercise_entries_kcal_source_valid"),
        ({**OTHER, "name": None}, "ck_exercise_entries_other_has_name"),
        ({"name": "晨跑"}, "ck_exercise_entries_other_has_name"),
        ({**OTHER, "kcal_source": "estimated"}, "ck_exercise_entries_other_is_manual"),
        ({**OTHER, "name": ""}, "ck_exercise_entries_name_length"),
        ({**OTHER, "name": "x" * 51}, "ck_exercise_entries_name_length"),
        ({"minutes": 0}, "ck_exercise_entries_minutes_range"),
        ({"minutes": 601}, "ck_exercise_entries_minutes_range"),
        ({"kcal": 0.99}, "ck_exercise_entries_kcal_range"),
        ({"kcal": 5000.01}, "ck_exercise_entries_kcal_range"),
        ({"note": "x" * 201}, "ck_exercise_entries_note_length"),
    ],
)
async def test_each_check_rejects_its_own_bad_value(db_session, overrides, constraint):
    """其他欄位都是 VALID（或 OTHER）——擋下來的一定是那個欄位的約束。"""
    user = await create_user(db_session)
    user_id = user.id

    with pytest.raises(IntegrityError) as caught:
        await _insert(db_session, user_id, **overrides)

    assert constraint in str(caught.value.orig)


@pytest.mark.parametrize(
    "overrides",
    [
        {"minutes": 1},
        {"minutes": 600},
        {"kcal": 1},
        {"kcal": 5000},
        {**OTHER, "name": "x" * 50},
        {"note": "x" * 200},
    ],
)
async def test_the_range_edges_are_inclusive(db_session, overrides):
    user = await create_user(db_session)
    user_id = user.id

    await _insert(db_session, user_id, **overrides)

    assert await _count(db_session, user_id) == 1


async def test_deleting_a_user_takes_their_exercises(db_session):
    user = await create_user(db_session)
    other = await create_user(db_session)
    when = VALID["performed_at"]
    await create_exercise(db_session, user=user, performed_at=when)
    await create_exercise(db_session, user=other, performed_at=when)
    user_id, other_id = user.id, other.id

    await db_session.execute(delete(User).where(User.id == user_id))
    await db_session.commit()

    owners = (await db_session.scalars(select(ExerciseEntry.user_id))).all()
    assert user_id not in owners
    # 別人的還在：cascade 沒有多刪。
    assert other_id in owners


async def test_a_raw_user_insert_gets_exercise_adds_to_budget_true(db_session):
    """直接下 SQL、不提新欄位（舊版程式的 INSERT）也是 true——靠的是 server_default。"""
    user_id = await db_session.scalar(
        text(
            "INSERT INTO users (email, password_hash, display_name, role, friend_code)"
            " VALUES ('raw-exercise@example.com', 'x', '直接寫', 'user', 'RAWEXERCISE1')"
            " RETURNING id"
        )
    )

    adds = await db_session.scalar(
        text("SELECT exercise_adds_to_budget FROM users WHERE id = :id"), {"id": user_id}
    )
    assert adds is True


async def test_the_activity_check_lists_every_code(db_session):
    """alembic check 不比 CHECK 的文字（計畫「寫計畫時實測過的事」第 5 點）：模型的 ActivityCode
    多了一個代碼而 migration 沒跟上，只有這條會紅。"""
    definition = await db_session.scalar(
        text(
            "SELECT pg_get_constraintdef(oid) FROM pg_constraint "
            "WHERE conname = 'ck_exercise_entries_activity_valid'"
        )
    )
    assert definition is not None
    for code in ActivityCode:
        assert f"'{code.value}'" in definition
