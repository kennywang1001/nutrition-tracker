"""`PUT /api/targets/today`：從使用者的今天起生效，過去的日子不變（規格 §3.1）。

「今天」一律 monkeypatch `app.api.routes.targets.today_in_timezone`：
固定日期（不是執行日——handover §6 第 22 種），並記下它收到的時區（第 2 種）。
"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.target import UserTarget
from app.security.tokens import create_access_token
from tests.factories import create_target, create_user

TODAY = date(2019, 7, 4)
YESTERDAY = date(2019, 7, 3)
BODY = {"kcal": "1800", "protein_g": "120", "fat_g": None, "carb_g": None}


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


@pytest.fixture
def seen_timezones(monkeypatch) -> list[str]:
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.targets.today_in_timezone", fake_today)
    return seen


async def _rows(db_session, user_id: int) -> list[tuple]:
    rows = (
        await db_session.scalars(
            select(UserTarget)
            .where(UserTarget.user_id == user_id)
            .order_by(UserTarget.effective_from)
        )
    ).all()
    return [
        (r.effective_from, r.effective_to, r.kcal, r.protein_g, r.fat_g, r.carb_g, r.label)
        for r in rows
    ]


async def test_an_earlier_target_is_closed_and_a_new_one_starts_today(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    await create_target(
        db_session,
        user=user,
        kcal=2000,
        protein_g=100,
        label="減脂期",
        effective_from=date(2019, 1, 1),
    )
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    body = response.json()
    assert (body["effective_from"], body["effective_to"]) == ("2019-07-04", None)
    assert (body["kcal"], body["protein_g"], body["fat_g"]) == ("1800.00", "120.00", None)
    assert body["label"] == "減脂期"  # 沿用
    await db_session.rollback()  # 第 11 種：關閉與新列都要真的 commit 了
    assert await _rows(db_session, user_id) == [
        (date(2019, 1, 1), TODAY, Decimal("2000.00"), Decimal("100.00"), None, None, "減脂期"),
        (TODAY, None, Decimal("1800.00"), Decimal("120.00"), None, None, "減脂期"),
    ]


async def test_yesterday_keeps_the_old_target_and_today_has_the_new_one(
    client, db_session, seen_timezones
):
    """規格的核心保證：趨勢與歷史用的是「那一天生效的目標」。"""
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000, effective_from=date(2019, 1, 1))
    user_id = user.id

    await client.put("/api/targets/today", headers=auth(user_id), json=BODY)
    await db_session.rollback()

    yesterday = await client.get(f"/api/stats/daily?date={YESTERDAY}", headers=auth(user_id))
    today = await client.get(f"/api/stats/daily?date={TODAY}", headers=auth(user_id))
    assert yesterday.json()["target"]["kcal"] == "2000.00"
    assert today.json()["target"]["kcal"] == "1800.00"


async def test_saving_again_on_the_same_day_edits_todays_row_in_place(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000, effective_from=date(2019, 1, 1))
    user_id = user.id

    first = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)
    second = await client.put(
        "/api/targets/today",
        headers=auth(user_id),
        json={"kcal": "1900", "protein_g": None, "fat_g": "60", "carb_g": None},
    )

    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    await db_session.rollback()
    assert await _rows(db_session, user_id) == [
        (date(2019, 1, 1), TODAY, Decimal("2000.00"), None, None, None, None),
        (TODAY, None, Decimal("1900.00"), None, Decimal("60.00"), None, None),
    ]


async def test_without_any_target_a_new_open_ended_one_starts_today(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    await db_session.rollback()
    assert await _rows(db_session, user_id) == [
        (TODAY, None, Decimal("1800.00"), Decimal("120.00"), None, None, None),
    ]


async def test_a_future_target_bounds_the_new_period(client, db_session, seen_timezones):
    """畫面造不出未來的期間，API 造得出來；不算結束日的話，存一次就撞期（規格決定 3）。"""
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2019, 8, 1))
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    assert response.json()["effective_to"] == "2019-08-01"


async def test_a_bounded_current_target_passes_its_end_to_the_new_period(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    await create_target(
        db_session,
        user=user,
        kcal=2000,
        effective_from=date(2019, 1, 1),
        effective_to=date(2019, 8, 1),
    )
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2019, 8, 1))
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    await db_session.rollback()
    assert [(r[0], r[1]) for r in await _rows(db_session, user_id)] == [
        (date(2019, 1, 1), TODAY),
        (TODAY, date(2019, 8, 1)),
        (date(2019, 8, 1), None),
    ]


async def test_today_is_the_users_today_not_the_servers(client, db_session, seen_timezones):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    user_id = user.id

    await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert seen_timezones == ["America/New_York"]


@pytest.mark.parametrize(
    "patch",
    [
        {"kcal": "0"},
        {"kcal": "-1"},
        {"kcal": "20000.01"},
        {"protein_g": "2000.01"},
        {"fat_g": "12.345"},
        {"carb_g": "abc"},
    ],
)
async def test_bad_values_are_422_and_write_nothing(client, db_session, seen_timezones, patch):
    user = await create_user(db_session)
    user_id = user.id

    response = await client.put(
        "/api/targets/today", headers=auth(user_id), json={**BODY, **patch}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    await db_session.rollback()
    assert await _rows(db_session, user_id) == []


@pytest.mark.parametrize("missing", ["kcal", "protein_g", "fat_g", "carb_g"])
async def test_every_key_must_be_sent(client, db_session, seen_timezones, missing):
    """PUT＝整組取代：省略不能悄悄變成「沿用」（規格決定 4）。"""
    user = await create_user(db_session)
    body = {k: v for k, v in BODY.items() if k != missing}

    response = await client.put("/api/targets/today", headers=auth(user.id), json=body)

    assert response.status_code == 422


async def test_the_upper_bounds_themselves_are_accepted(client, db_session, seen_timezones):
    user = await create_user(db_session)
    response = await client.put(
        "/api/targets/today",
        headers=auth(user.id),
        json={"kcal": "20000", "protein_g": "2000", "fat_g": "0.01", "carb_g": "2000.00"},
    )
    assert response.status_code == 200


async def test_requires_authentication(client):
    response = await client.put("/api/targets/today", json=BODY)
    assert response.status_code == 401


@pytest.mark.parametrize("with_current", [True, False])
async def test_a_clash_is_409_and_writes_nothing(
    client, db_session, seen_timezones, monkeypatch, with_current
):
    """並行時才會發生的撞期，用接縫造出來：讓新期間「不結束」，插入就撞上後面那筆。
    有目前的期間時，**關閉也必須一起 rollback**——否則留下「舊的關了、新的沒開」。"""
    user = await create_user(db_session)
    if with_current:
        await create_target(
            db_session,
            user=user,
            kcal=2000,
            effective_from=date(2019, 1, 1),
            effective_to=date(2019, 8, 1),
        )
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2019, 8, 1))
    user_id = user.id
    await db_session.rollback()
    before = await _rows(db_session, user_id)

    async def never_ends(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.api.routes.targets._new_period_end", never_ends)

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TARGET_CONFLICT"
    await db_session.rollback()
    assert await _rows(db_session, user_id) == before
