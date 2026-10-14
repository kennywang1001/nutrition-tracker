"""體重紀錄的三個端點（身體資料規格 §5.3）。

「今天」monkeypatch `app.api.routes.weights.today_in_timezone`：固定 2026-10-14，並記下它收到
的時區（handover §6 第 2、22 種）。使用者的時區是 `America/New_York`——不是預設的
Asia/Taipei，端點傳錯時區才測得出來。
"""

from datetime import date, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.body import WeightEntry
from app.security.tokens import create_access_token
from tests.factories import create_user, create_weight

TODAY = date(2026, 10, 14)
WEIGHTS = "/api/weights"


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


def day_path(day: date) -> str:
    return f"{WEIGHTS}/{day.isoformat()}"


@pytest.fixture
def seen_timezones(monkeypatch) -> list[str]:
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.weights.today_in_timezone", fake_today)
    return seen


async def _user(db_session):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def _rows(db_session, user_id: int) -> list[tuple]:
    # 選欄位而不是選實體：identity map 裡的舊物件不會蓋掉 upsert 寫進去的新值。
    rows = await db_session.execute(
        select(WeightEntry.date, WeightEntry.weight_kg, WeightEntry.created_at)
        .where(WeightEntry.user_id == user_id)
        .order_by(WeightEntry.date)
    )
    return [tuple(row) for row in rows]


def _dates(body: dict) -> list[str]:
    return [entry["date"] for entry in body["entries"]]


async def test_put_creates_then_corrects_the_same_day(client, db_session, seen_timezones):
    user = await _user(db_session)
    user_id = user.id

    first = await client.put(day_path(TODAY), headers=auth(user_id), json={"weight_kg": "80.4"})
    await db_session.rollback()  # 第 11 種：真的 commit 了
    [(_, _, created_first)] = await _rows(db_session, user_id)
    second = await client.put(day_path(TODAY), headers=auth(user_id), json={"weight_kg": "79.9"})

    assert first.status_code == 200
    assert first.json() == {"date": "2026-10-14", "weight_kg": "80.40"}
    assert second.status_code == 200
    assert second.json() == {"date": "2026-10-14", "weight_kg": "79.90"}
    await db_session.rollback()
    assert await _rows(db_session, user_id) == [(TODAY, Decimal("79.90"), created_first)]


@pytest.mark.parametrize(
    ("offset", "status", "code"),
    [
        (0, 200, None),
        (1, 422, "WEIGHT_DATE_IN_FUTURE"),
        (-730, 200, None),
        (-731, 422, "WEIGHT_DATE_TOO_OLD"),
    ],
)
async def test_the_date_boundaries_follow_the_users_today(
    client, db_session, seen_timezones, offset, status, code
):
    user = await _user(db_session)
    user_id = user.id
    day = TODAY + timedelta(days=offset)

    response = await client.put(day_path(day), headers=auth(user_id), json={"weight_kg": "70"})

    assert response.status_code == status
    if code is not None:
        assert response.json()["error"]["code"] == code
        await db_session.rollback()
        assert await _rows(db_session, user_id) == []
    assert seen_timezones == ["America/New_York"]


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"weight_kg": "24.99"}, 422),
        ({"weight_kg": "350.01"}, 422),
        ({"weight_kg": "80.123"}, 422),
        ({"weight_kg": "abc"}, 422),
        ({"weight_kg": None}, 422),
        ({}, 422),
        ({"weight_kg": "25"}, 200),
        ({"weight_kg": "350"}, 200),
    ],
)
async def test_bad_weights_are_422(client, db_session, seen_timezones, body, status):
    user = await _user(db_session)

    response = await client.put(day_path(TODAY), headers=auth(user.id), json=body)

    assert response.status_code == status


@pytest.mark.parametrize("bad", ["2026-13-01", "yesterday", "2026-02-30"])
async def test_a_date_that_is_not_a_date_is_422(client, db_session, seen_timezones, bad):
    user = await _user(db_session)

    put = await client.put(f"{WEIGHTS}/{bad}", headers=auth(user.id), json={"weight_kg": "70"})
    removed = await client.delete(f"{WEIGHTS}/{bad}", headers=auth(user.id))

    assert put.status_code == 422
    assert removed.status_code == 422


async def test_list_defaults_to_the_last_800_days_oldest_first(
    client, db_session, seen_timezones
):
    user = await _user(db_session)
    for offset in (0, 799, 800, 3):
        await create_weight(db_session, user=user, day=TODAY - timedelta(days=offset))

    response = await client.get(WEIGHTS, headers=auth(user.id))

    assert response.status_code == 200
    body = response.json()
    assert body["today"] == "2026-10-14"
    assert _dates(body) == [
        (TODAY - timedelta(days=799)).isoformat(),
        (TODAY - timedelta(days=3)).isoformat(),
        TODAY.isoformat(),
    ]
    assert body["entries"][0]["weight_kg"] == "80.00"
    assert seen_timezones == ["America/New_York"]


async def test_list_with_a_range(client, db_session, seen_timezones):
    user = await _user(db_session)
    user_id = user.id
    oct_10 = date(2026, 10, 10)
    days = [
        date(2026, 9, 30),
        date(2026, 10, 1),
        oct_10,
        date(2026, 10, 11),
        TODAY,
        # 只有直接寫才會有「明天」的紀錄：證明 `to` 省略時是今天，不是「沒有上限」。
        TODAY + timedelta(days=1),
        oct_10 - timedelta(days=799),
        oct_10 - timedelta(days=800),
    ]
    for day in days:
        await create_weight(db_session, user=user, day=day)

    both = await client.get(f"{WEIGHTS}?from=2026-10-01&to=2026-10-10", headers=auth(user_id))
    only_from = await client.get(f"{WEIGHTS}?from=2026-10-10", headers=auth(user_id))
    only_to = await client.get(f"{WEIGHTS}?to=2026-10-10", headers=auth(user_id))

    assert _dates(both.json()) == ["2026-10-01", "2026-10-10"]
    assert _dates(only_from.json()) == ["2026-10-10", "2026-10-11", "2026-10-14"]
    only_to_dates = _dates(only_to.json())
    assert only_to_dates[0] == (oct_10 - timedelta(days=799)).isoformat()
    assert only_to_dates[-1] == "2026-10-10"
    assert (oct_10 - timedelta(days=800)).isoformat() not in only_to_dates
    # 有沒有給範圍，`today` 都是使用者的今天。
    assert {r.json()["today"] for r in (both, only_from, only_to)} == {"2026-10-14"}


@pytest.mark.parametrize(
    ("query", "status", "code"),
    [
        ("from=2026-10-11&to=2026-10-10", 422, "INVALID_RANGE"),
        ("from=2026-10-10&to=2026-10-10", 200, None),
        # 2024-08-06 到 2026-10-14 兩端都含是 800 天；再早一天就是 801 天。
        ("from=2024-08-05&to=2026-10-14", 422, "RANGE_TOO_LONG"),
        ("from=2024-08-06&to=2026-10-14", 200, None),
        ("from=2026-13-01", 422, "VALIDATION_ERROR"),
        # 審查 M1：`to` 太早，`from` 的預設（to − 799 天）會算到公元 1 年之前——OverflowError、500。
        # 1900-01-01 之前的日期一律 INVALID_RANGE。
        ("to=0001-01-01", 422, "INVALID_RANGE"),
        ("from=0001-01-01", 422, "INVALID_RANGE"),
        ("from=0001-01-01&to=0001-01-02", 422, "INVALID_RANGE"),
        ("to=1899-12-31", 422, "INVALID_RANGE"),
        ("from=1899-12-31&to=1900-01-10", 422, "INVALID_RANGE"),
        # 下限本身可以（`from` 的預設會早於它：夾在下限，不算錯）。
        ("from=1900-01-01&to=1900-01-10", 200, None),
        ("to=1900-01-01", 200, None),
    ],
)
async def test_list_range_errors(client, db_session, seen_timezones, query, status, code):
    user = await _user(db_session)

    response = await client.get(f"{WEIGHTS}?{query}", headers=auth(user.id))

    assert response.status_code == status
    if code is not None:
        assert response.json()["error"]["code"] == code


def test_the_800_day_fixture_dates_are_right():
    """上面那兩格的日期是手算的：這裡確認一次，免得邊界測的其實是 799 或 801。"""
    assert (date(2026, 10, 14) - date(2024, 8, 6)).days + 1 == 800


async def test_delete(client, db_session, seen_timezones):
    user = await _user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=TODAY, weight_kg=80)
    await create_weight(db_session, user=user, day=TODAY - timedelta(days=1), weight_kg=81)

    removed = await client.delete(day_path(TODAY), headers=auth(user_id))
    listed = await client.get(WEIGHTS, headers=auth(user_id))
    again = await client.delete(day_path(TODAY), headers=auth(user_id))

    assert removed.status_code == 204
    assert removed.content == b""
    assert _dates(listed.json()) == ["2026-10-13"]  # 只刪了那一天
    assert again.status_code == 404
    assert again.json()["error"]["code"] == "WEIGHT_NOT_FOUND"


async def test_someone_elses_weights(client, db_session, seen_timezones):
    owner, intruder = await _user(db_session), await _user(db_session)
    owner_id, intruder_id = owner.id, intruder.id
    await client.put(day_path(TODAY), headers=auth(owner_id), json={"weight_kg": "80"})
    # 先證明 A 讀得到自己的：B 讀不到才有意義。
    assert _dates((await client.get(WEIGHTS, headers=auth(owner_id))).json()) == ["2026-10-14"]

    seen_by_intruder = await client.get(WEIGHTS, headers=auth(intruder_id))
    removed_by_intruder = await client.delete(day_path(TODAY), headers=auth(intruder_id))
    written_by_intruder = await client.put(
        day_path(TODAY), headers=auth(intruder_id), json={"weight_kg": "99"}
    )

    assert seen_by_intruder.json()["entries"] == []
    assert removed_by_intruder.status_code == 404
    assert written_by_intruder.status_code == 200
    owners = (await client.get(WEIGHTS, headers=auth(owner_id))).json()["entries"]
    assert owners == [{"date": "2026-10-14", "weight_kg": "80.00"}]


async def test_it_needs_a_login(client):
    assert (await client.get(WEIGHTS)).status_code == 401
    assert (await client.put(day_path(TODAY), json={"weight_kg": "80"})).status_code == 401
    assert (await client.delete(day_path(TODAY))).status_code == 401
