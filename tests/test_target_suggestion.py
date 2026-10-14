"""`GET /api/me/target-suggestion`（身體資料規格 §5.2）與套用（§5.2、D15）。

「今天」monkeypatch `app.api.routes.body.today_in_timezone`，固定 2026-10-14、記下時區。
預設的 `create_profile` 配上 80 kg 就是規格 §3.2 那一組：2110／144／59／251。
"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.body import ActivityLevel, Goal, Sex, UserProfile
from app.models.target import UserTarget
from app.security.tokens import create_access_token
from tests.factories import create_profile, create_target, create_user, create_weight

TODAY = date(2026, 10, 14)
SUGGESTION = "/api/me/target-suggestion"
APPLY = "/api/me/target-suggestion/apply"
# 預設的 create_profile 配 80 kg：畫面上看到的四個數字（規格 §3.2）。
SHOWN = {"kcal": "2110", "protein_g": "144", "fat_g": "59", "carb_g": "251"}
ALL_MISSING = [
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "weight",
]
WORKED_EXAMPLE = {
    "ready": True,
    "kcal": "2110",
    "protein_g": "144",
    "fat_g": "59",
    "carb_g": "251",
    "bmr": "1719",
    "tdee": "2664",
    "adjustment_kcal": "-550",
    "floor_applied": False,
    "floor_kcal": "1500",
    "weight_kg": "80.00",
    "based_on_date": "2026-10-10",
    "applied_weight_kg": None,
    "weight_change_kg": None,
    "resuggest": False,
}
NUMERIC = {
    "kcal",
    "protein_g",
    "fat_g",
    "carb_g",
    "bmr",
    "tdee",
    "adjustment_kcal",
    "floor_kcal",
    "weight_kg",
    "applied_weight_kg",
    "weight_change_kg",
}


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


@pytest.fixture
def seen_timezones(monkeypatch) -> list[str]:
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.body.today_in_timezone", fake_today)
    return seen


async def _user(db_session):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


def _normalized(body: dict) -> dict:
    """數字欄位換成 Decimal：比的是數值，不是字串的小數位數。"""
    return {
        key: Decimal(value) if key in NUMERIC and value is not None else value
        for key, value in body.items()
    }


async def test_the_worked_example(client, db_session, seen_timezones):
    user = await _user(db_session)
    await create_profile(db_session, user=user)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=80)

    response = await client.get(SUGGESTION, headers=auth(user.id))

    assert response.status_code == 200
    assert _normalized(response.json()) == _normalized(WORKED_EXAMPLE)


async def test_the_latest_weight_is_by_date_not_by_insertion(client, db_session, seen_timezones):
    """補記上週的體重不會變成「目前體重」。"""
    user = await _user(db_session)
    await create_profile(db_session, user=user)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=80)
    await create_weight(db_session, user=user, day=date(2026, 10, 1), weight_kg=90)

    body = (await client.get(SUGGESTION, headers=auth(user.id))).json()

    assert Decimal(body["weight_kg"]) == Decimal(80)
    assert body["based_on_date"] == "2026-10-10"


async def test_nothing_set_lists_everything_missing(client, db_session, seen_timezones):
    user = await _user(db_session)

    response = await client.get(SUGGESTION, headers=auth(user.id))

    assert response.status_code == 200
    assert response.json() == {"ready": False, "missing": ALL_MISSING}


async def test_a_profile_without_a_weight_is_missing_only_the_weight(
    client, db_session, seen_timezones
):
    user = await _user(db_session)
    await create_profile(db_session, user=user)

    response = await client.get(SUGGESTION, headers=auth(user.id))

    assert response.json() == {"ready": False, "missing": ["weight"]}


@pytest.mark.parametrize(
    ("applied", "latest", "change", "resuggest"),
    [
        ("80", "79.01", "-0.99", False),
        ("80", "79", "-1.00", True),
        ("80", "81", "1.00", True),
        ("80", "80.99", "0.99", False),
        (None, "81", None, False),
    ],
)
async def test_resuggest_threshold(
    client, db_session, seen_timezones, applied, latest, change, resuggest
):
    """D17：|最新 − 套用時| ≥ 1 才提示；從沒套用過（null）不提示。"""
    user = await _user(db_session)
    await create_profile(db_session, user=user, targets_applied_weight_kg=applied)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=latest)

    body = (await client.get(SUGGESTION, headers=auth(user.id))).json()

    assert body["ready"] is True
    expected_applied = None if applied is None else Decimal(applied)
    assert (None if body["applied_weight_kg"] is None else Decimal(body["applied_weight_kg"])) == (
        expected_applied
    )
    if change is None:
        assert body["weight_change_kg"] is None
    else:
        assert Decimal(body["weight_change_kg"]) == Decimal(change)
    assert body["resuggest"] is resuggest


async def test_someone_elses_weight_does_not_count(client, db_session, seen_timezones):
    owner, other = await _user(db_session), await _user(db_session)
    await create_profile(db_session, user=owner)
    await create_weight(db_session, user=owner, day=date(2026, 10, 10), weight_kg=80)
    await create_profile(db_session, user=other)
    # 先證明 A 是 ready：B 缺體重才有意義。
    assert (await client.get(SUGGESTION, headers=auth(owner.id))).json()["ready"] is True

    response = await client.get(SUGGESTION, headers=auth(other.id))

    assert response.json() == {"ready": False, "missing": ["weight"]}


async def test_it_uses_the_users_timezone(client, db_session, seen_timezones):
    user = await _user(db_session)
    await create_profile(db_session, user=user)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=80)

    await client.get(SUGGESTION, headers=auth(user.id))

    assert seen_timezones == ["America/New_York"]


async def test_age_comes_from_the_users_today(client, db_session, monkeypatch):
    """年齡＝「端點拿到的今天」的年份 − 出生年：今天換成 2027 年，BMR 少 5。"""
    monkeypatch.setattr("app.api.routes.body.today_in_timezone", lambda _tz: date(2027, 1, 1))
    user = await _user(db_session)
    await create_profile(db_session, user=user)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=80)

    body = (await client.get(SUGGESTION, headers=auth(user.id))).json()

    assert Decimal(body["bmr"]) == Decimal(1714)


async def test_suggestion_needs_a_login(client):
    assert (await client.get(SUGGESTION)).status_code == 401


# ── 套用（D15） ──────────────────────────────────────────────────────────────


async def _ready_user(db_session):
    user = await _user(db_session)
    await create_profile(db_session, user=user)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=80)
    return user


async def _targets(db_session, user_id: int) -> list[tuple]:
    rows = await db_session.execute(
        select(
            UserTarget.effective_from,
            UserTarget.effective_to,
            UserTarget.kcal,
            UserTarget.protein_g,
            UserTarget.fat_g,
            UserTarget.carb_g,
        )
        .where(UserTarget.user_id == user_id)
        .order_by(UserTarget.effective_from)
    )
    return [tuple(row) for row in rows]


async def _applied(db_session, user_id: int):
    return await db_session.scalar(
        select(UserProfile.targets_applied_weight_kg).where(UserProfile.user_id == user_id)
    )


async def test_apply_saves_the_suggestion_from_today_and_remembers_the_weight(
    client, db_session, seen_timezones
):
    user = await _ready_user(db_session)
    user_id = user.id

    response = await client.post(APPLY, headers=auth(user_id), json=SHOWN)

    assert response.status_code == 200
    body = response.json()
    assert (body["effective_from"], body["effective_to"]) == ("2026-10-14", None)
    assert {key: Decimal(body[key]) for key in SHOWN} == {
        key: Decimal(value) for key, value in SHOWN.items()
    }
    assert seen_timezones == ["America/New_York"]
    await db_session.rollback()  # 第 11 種：真的 commit 了
    assert await _targets(db_session, user_id) == [
        (TODAY, None, Decimal(2110), Decimal(144), Decimal(59), Decimal(251))
    ]
    assert await _applied(db_session, user_id) == Decimal("80.00")
    after = (await client.get(SUGGESTION, headers=auth(user_id))).json()
    assert Decimal(after["applied_weight_kg"]) == Decimal(80)
    assert after["resuggest"] is False


async def test_apply_closes_the_previous_target(client, db_session, seen_timezones):
    """沿用帳號設定的規則（只驗一次接得上）：舊的那筆關在今天、數值不變。"""
    user = await _ready_user(db_session)
    await create_target(db_session, user=user, kcal=1800, effective_from=date(2026, 10, 1))
    user_id = user.id

    response = await client.post(APPLY, headers=auth(user_id), json=SHOWN)

    assert response.status_code == 200
    await db_session.rollback()
    rows = await _targets(db_session, user_id)
    assert rows[0] == (date(2026, 10, 1), TODAY, Decimal(1800), None, None, None)
    assert rows[1][:3] == (TODAY, None, Decimal(2110))


@pytest.mark.parametrize("field", list(SHOWN))
async def test_numbers_that_differ_from_the_suggestion_are_409_and_write_nothing(
    client, db_session, seen_timezones, field
):
    user = await _ready_user(db_session)
    user_id = user.id
    shown = {**SHOWN, field: str(Decimal(SHOWN[field]) + 1)}

    response = await client.post(APPLY, headers=auth(user_id), json=shown)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "SUGGESTION_CHANGED"
    await db_session.rollback()
    assert await _targets(db_session, user_id) == []
    assert await _applied(db_session, user_id) is None


async def test_trailing_zeros_are_the_same_number(client, db_session, seen_timezones):
    """比的是 Decimal，不是字串：2110.00 就是 2110。"""
    user = await _ready_user(db_session)
    shown = {"kcal": "2110.00", "protein_g": "144.0", "fat_g": "59", "carb_g": "251.00"}

    response = await client.post(APPLY, headers=auth(user.id), json=shown)

    assert response.status_code == 200


async def test_an_incomplete_profile_is_422_with_what_is_missing(
    client, db_session, seen_timezones
):
    user = await _user(db_session)
    await create_profile(db_session, user=user)
    user_id = user.id

    response = await client.post(APPLY, headers=auth(user_id), json=SHOWN)

    assert response.status_code == 422
    error = response.json()["error"]
    assert error["code"] == "PROFILE_INCOMPLETE"
    assert error["details"]["missing"] == ["weight"]
    await db_session.rollback()
    assert await _targets(db_session, user_id) == []
    assert await _applied(db_session, user_id) is None


async def test_a_zero_carb_suggestion_is_saved_as_unset(client, db_session, seen_timezones):
    """D9：規格 §3.3 的 E——碳水被擠到 0，存「未設定」（0 的目標算不出比例）。"""
    user = await _user(db_session)
    await create_profile(
        db_session,
        user=user,
        sex=Sex.FEMALE,
        birth_year=1926,
        height_cm=100,
        activity_level=ActivityLevel.SEDENTARY,
        goal=Goal.LOSE,
        rate_kg_per_week="0.5",
    )
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg=150)
    user_id = user.id
    shown = {"kcal": "1210", "protein_g": "270", "fat_g": "34", "carb_g": "0"}

    response = await client.post(APPLY, headers=auth(user_id), json=shown)

    assert response.status_code == 200
    assert response.json()["carb_g"] is None
    await db_session.rollback()
    assert await _targets(db_session, user_id) == [
        (TODAY, None, Decimal(1210), Decimal(270), Decimal(34), None)
    ]


async def test_a_target_clash_is_409_and_the_weight_is_not_remembered(
    client, db_session, seen_timezones, monkeypatch
):
    """並行時才會撞期（同 `test_targets_today.py` 的接縫）：目標沒寫進去，套用時的體重也不記。"""
    user = await _ready_user(db_session)
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2026, 11, 1))
    user_id = user.id

    async def never_ends(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.api.routes.targets._new_period_end", never_ends)

    response = await client.post(APPLY, headers=auth(user_id), json=SHOWN)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TARGET_CONFLICT"
    await db_session.rollback()
    assert await _applied(db_session, user_id) is None
    assert [row[0] for row in await _targets(db_session, user_id)] == [date(2026, 11, 1)]


async def test_after_the_weight_moves_a_kilo_the_suggestion_says_so(
    client, db_session, seen_timezones
):
    user = await _ready_user(db_session)
    user_id = user.id
    assert (await client.post(APPLY, headers=auth(user_id), json=SHOWN)).status_code == 200

    await create_weight(db_session, user=user, day=TODAY, weight_kg="78.5")
    body = (await client.get(SUGGESTION, headers=auth(user_id))).json()

    assert Decimal(body["weight_change_kg"]) == Decimal("-1.5")
    assert body["resuggest"] is True


async def test_apply_needs_a_login(client):
    assert (await client.post(APPLY, json=SHOWN)).status_code == 401
