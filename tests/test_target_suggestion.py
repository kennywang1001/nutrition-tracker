"""`GET /api/me/target-suggestion`（身體資料規格 §5.2）與套用（§5.2、D15）。

「今天」monkeypatch `app.api.routes.body.today_in_timezone`，固定 2026-10-14、記下時區。
預設的 `create_profile` 配上 80 kg 就是規格 §3.2 那一組：2110／144／59／251。
"""

from datetime import date
from decimal import Decimal

import pytest

from app.security.tokens import create_access_token
from tests.factories import create_profile, create_user, create_weight

TODAY = date(2026, 10, 14)
SUGGESTION = "/api/me/target-suggestion"
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
