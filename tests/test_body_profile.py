"""`GET`／`PUT /api/me/body-profile`（身體資料規格 §5.1）。

「今天」一律 monkeypatch `app.api.routes.body.today_in_timezone`：固定日期，並記下它收到的
時區（handover §6 第 2、22 種）。使用者的時區設成**不是預設的** `America/New_York`——
用預設的 Asia/Taipei 的話，端點傳錯時區也測不出來。
"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import func, select

from app.models.body import UserProfile
from app.security.tokens import create_access_token
from tests.factories import create_profile, create_user

TODAY = date(2026, 10, 14)
PROFILE = "/api/me/body-profile"
NUMERIC = ("height_cm", "rate_kg_per_week", "target_weight_kg")
FULL = {
    "sex": "female",
    "birth_year": 1990,
    "height_cm": "162.5",
    "activity_level": "light",
    "goal": "lose",
    "rate_kg_per_week": "0.25",
    "target_weight_kg": "55",
}
OTHER = {
    "sex": "male",
    "birth_year": 1980,
    "height_cm": "180",
    "activity_level": "very_active",
    "goal": "gain",
    "rate_kg_per_week": "0.5",
    "target_weight_kg": None,
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


def _same(body: dict, expected: dict) -> bool:
    """數字欄位比 Decimal（"55" 與 "55.00" 是同一個數），其他比原值。"""
    if body.keys() != expected.keys():
        return False
    for key, value in expected.items():
        if key in NUMERIC and value is not None:
            if body[key] is None or Decimal(body[key]) != Decimal(value):
                return False
        elif body[key] != value:
            return False
    return True


async def _row(db_session, user_id: int) -> dict:
    # 選欄位而不是選實體：identity map 裡的舊物件不會蓋掉資料庫的新值。
    row = (
        await db_session.execute(
            select(
                UserProfile.sex,
                UserProfile.birth_year,
                UserProfile.height_cm,
                UserProfile.activity_level,
                UserProfile.goal,
                UserProfile.rate_kg_per_week,
                UserProfile.target_weight_kg,
                UserProfile.targets_applied_weight_kg,
                UserProfile.created_at,
            ).where(UserProfile.user_id == user_id)
        )
    ).one()
    return row._asdict()


async def test_an_empty_profile_is_all_nulls_not_404(client, db_session, seen_timezones):
    user = await _user(db_session)

    response = await client.get(PROFILE, headers=auth(user.id))

    assert response.status_code == 200
    assert response.json() == dict.fromkeys(FULL)
    assert "targets_applied_weight_kg" not in response.json()


async def test_put_saves_the_whole_profile_and_get_reads_it_back(
    client, db_session, seen_timezones
):
    user = await _user(db_session)
    user_id = user.id

    saved = await client.put(PROFILE, headers=auth(user_id), json=FULL)
    read = await client.get(PROFILE, headers=auth(user_id))

    assert saved.status_code == 200
    assert _same(saved.json(), FULL)
    assert _same(read.json(), FULL)
    await db_session.rollback()  # 第 11 種：真的 commit 了
    count = await db_session.scalar(
        select(func.count()).select_from(UserProfile).where(UserProfile.user_id == user_id)
    )
    assert count == 1


async def test_a_second_put_replaces_every_field(client, db_session, seen_timezones):
    user = await _user(db_session)
    user_id = user.id
    await client.put(PROFILE, headers=auth(user_id), json=FULL)
    await db_session.rollback()
    first_created = (await _row(db_session, user_id))["created_at"]

    response = await client.put(PROFILE, headers=auth(user_id), json=OTHER)

    assert response.status_code == 200
    assert _same(response.json(), OTHER)
    await db_session.rollback()
    row = await _row(db_session, user_id)
    assert (row["sex"], row["birth_year"], row["height_cm"]) == ("male", 1980, Decimal("180.0"))
    assert (row["activity_level"], row["goal"]) == ("very_active", "gain")
    assert row["rate_kg_per_week"] == Decimal("0.50")
    assert row["target_weight_kg"] is None
    assert row["created_at"] == first_created


async def test_put_does_not_touch_the_applied_weight(client, db_session, seen_timezones):
    user = await _user(db_session)
    user_id = user.id
    await create_profile(db_session, user=user, targets_applied_weight_kg=80)

    response = await client.put(PROFILE, headers=auth(user_id), json=FULL)

    assert response.status_code == 200
    await db_session.rollback()
    row = await _row(db_session, user_id)
    assert row["targets_applied_weight_kg"] == Decimal("80.00")
    assert row["sex"] == "female"  # 其他欄位確實換掉了：不是整個 PUT 沒生效


@pytest.mark.parametrize("key", list(FULL))
async def test_every_key_is_required(client, db_session, seen_timezones, key):
    user = await _user(db_session)
    body = {k: v for k, v in FULL.items() if k != key}

    response = await client.put(PROFILE, headers=auth(user.id), json=body)

    assert response.status_code == 422


@pytest.mark.parametrize(
    ("key", "value", "status"),
    [
        ("height_cm", "99.9", 422),
        ("height_cm", "250.1", 422),
        ("height_cm", "170.25", 422),
        ("target_weight_kg", "24.99", 422),
        ("target_weight_kg", "350.01", 422),
        ("target_weight_kg", "60.125", 422),
        ("rate_kg_per_week", "0.3", 422),
        ("rate_kg_per_week", "1", 422),
        ("sex", "other", 422),
        ("activity_level", "extreme", 422),
        ("goal", "bulk", 422),
        ("height_cm", "100", 200),
        ("height_cm", "250", 200),
        ("target_weight_kg", "25", 200),
        ("target_weight_kg", "350", 200),
        ("rate_kg_per_week", "0.50", 200),
        ("rate_kg_per_week", None, 200),
    ],
)
async def test_out_of_range_values_are_422(client, db_session, seen_timezones, key, value, status):
    user = await _user(db_session)

    response = await client.put(PROFILE, headers=auth(user.id), json={**FULL, key: value})

    assert response.status_code == status
    if status == 422:
        assert response.json()["error"]["code"] == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("birth_year", "status"), [(1926, 200), (1925, 422), (2013, 200), (2014, 422)]
)
async def test_birth_year_is_judged_by_the_users_today(
    client, db_session, seen_timezones, birth_year, status
):
    """今天 2026（使用者時區）：1926（100 歲）到 2013（13 歲）。"""
    user = await _user(db_session)

    response = await client.put(
        PROFILE, headers=auth(user.id), json={**FULL, "birth_year": birth_year}
    )

    assert response.status_code == status
    if status == 422:
        error = response.json()["error"]
        assert error["code"] == "BIRTH_YEAR_OUT_OF_RANGE"
        assert "1926" in error["message"] and "2013" in error["message"]
    assert seen_timezones == ["America/New_York"]


async def test_a_null_birth_year_skips_the_range_check(client, db_session, seen_timezones):
    user = await _user(db_session)

    response = await client.put(PROFILE, headers=auth(user.id), json={**FULL, "birth_year": None})

    assert response.status_code == 200
    assert response.json()["birth_year"] is None


async def test_maintain_keeps_whatever_rate_was_sent(client, db_session, seen_timezones):
    """D3：維持時速度照存——切回減重時還在。"""
    user = await _user(db_session)
    user_id = user.id

    response = await client.put(
        PROFILE,
        headers=auth(user_id),
        json={**FULL, "goal": "maintain", "rate_kg_per_week": "0.5"},
    )

    assert response.status_code == 200
    await db_session.rollback()
    row = await _row(db_session, user_id)
    assert (row["goal"], row["rate_kg_per_week"]) == ("maintain", Decimal("0.50"))


async def test_someone_elses_profile_is_untouched(client, db_session, seen_timezones):
    owner, intruder = await _user(db_session), await _user(db_session)
    owner_id, intruder_id = owner.id, intruder.id
    await client.put(PROFILE, headers=auth(owner_id), json=FULL)
    # 先證明 A 讀得到自己的：B 讀不到才有意義。
    assert _same((await client.get(PROFILE, headers=auth(owner_id))).json(), FULL)

    seen_by_intruder = await client.get(PROFILE, headers=auth(intruder_id))
    await client.put(PROFILE, headers=auth(intruder_id), json=OTHER)

    assert seen_by_intruder.json() == dict.fromkeys(FULL)
    assert _same((await client.get(PROFILE, headers=auth(owner_id))).json(), FULL)
    assert _same((await client.get(PROFILE, headers=auth(intruder_id))).json(), OTHER)


async def test_it_needs_a_login(client):
    assert (await client.get(PROFILE)).status_code == 401
    assert (await client.put(PROFILE, json=FULL)).status_code == 401
