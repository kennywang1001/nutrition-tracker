from datetime import UTC, date, datetime, timedelta

from app.days import day_bounds
from app.security.tokens import create_token
from tests.factories import create_intake, create_plan, create_supplement, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


# ---------------------------------------------------------------------------
# Task 10: GET /api/supplements/today —— 計畫 vs 實際（陷阱 2）
# ---------------------------------------------------------------------------


async def test_todays_list_includes_a_plan_effective_today(client, db_session, monkeypatch):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session,
        user=user,
        supplement=supplement,
        effective_from=date(2026, 1, 1),
        effective_to=None,
    )
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: date(2026, 6, 1)
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["plan_id"] == plan.id
    assert body[0]["supplement_id"] == supplement.id
    assert body[0]["done"] is False
    assert body[0]["intake_id"] is None


async def test_todays_list_excludes_an_expired_plan(client, db_session, monkeypatch):
    """effective_to 是昨天（相對「今天」）的計畫已經過期，不該出現。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_plan(
        db_session,
        user=user,
        supplement=supplement,
        effective_from=date(2026, 1, 1),
        effective_to=date(2026, 5, 31),
    )
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: date(2026, 6, 1)
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == []


async def test_todays_list_excludes_a_plan_not_yet_effective(client, db_session, monkeypatch):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_plan(
        db_session,
        user=user,
        supplement=supplement,
        effective_from=date(2026, 6, 2),
        effective_to=None,
    )
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: date(2026, 6, 1)
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == []


async def test_todays_list_marks_a_taken_plan_as_done(client, db_session, monkeypatch):
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 1, 1)
    )
    fixed_today = date(2026, 6, 1)
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: fixed_today
    )
    start, _end = day_bounds(fixed_today, user.timezone)
    intake = await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        plan=plan,
        taken_at=start + timedelta(hours=1),
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["plan_id"] == plan.id
    assert body[0]["done"] is True
    assert body[0]["intake_id"] == intake.id


async def test_todays_list_includes_an_ad_hoc_intake(client, db_session, monkeypatch):
    """臨時記錄（plan_id 是 NULL）也要出現在清單裡。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    fixed_today = date(2026, 6, 1)
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: fixed_today
    )
    start, _end = day_bounds(fixed_today, user.timezone)
    intake = await create_intake(
        db_session, user=user, supplement=supplement, taken_at=start + timedelta(hours=2)
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 1
    assert body[0]["plan_id"] is None
    assert body[0]["supplement_id"] == supplement.id
    assert body[0]["intake_id"] == intake.id
    assert body[0]["done"] is True


async def test_todays_list_excludes_other_users_plans_and_intakes(
    client, db_session, monkeypatch
):
    """用**全域**補劑（owner=None）：bob 的計畫與打卡都能看得到這個補劑本身，
    所以如果 user_id 過濾被拿掉，補劑可見性擋不住 bob 的資料流進 alice 的清單
    —— 才是真正在驗證 user_id 過濾，不是被可見性先擋下來
    （計畫 3 Task 17 的教訓：私人補劑會讓兩個過濾器互相掩護）。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    global_supplement = await create_supplement(db_session, created_by=alice)
    await create_plan(db_session, user=bob, supplement=global_supplement)
    await create_intake(db_session, user=bob, supplement=global_supplement)
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: date(2026, 1, 1)
    )

    response = await client.get("/api/supplements/today", headers=auth(alice))

    assert response.status_code == 200
    assert response.json() == []


async def test_todays_list_requires_authentication(client):
    response = await client.get("/api/supplements/today")

    assert response.status_code == 401


async def test_late_night_intake_in_new_york_counts_as_local_today(
    client, db_session, monkeypatch
):
    """陷阱 2 的時區測試：UTC 以西的時區才有鑑別力（計畫 3 Task 9 的教訓 ——
    UTC 以東的時區只有清晨有鑑別力，用台北深夜寫的話，寫死 UTC 的實作
    照樣通過）。紐約當地 23:30 打卡，UTC 已經是隔天，若實作誤用 UTC 的
    今天，這筆打卡會被排除在清單外。
    """
    user = await create_user(db_session)
    patch_response = await client.patch(
        "/api/me", headers=auth(user), json={"timezone": "America/New_York"}
    )
    assert patch_response.status_code == 200
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    fixed_today = date(2026, 9, 4)
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: fixed_today
    )
    # 2026-09-04 23:30 紐約（夏令時 UTC-4）== 2026-09-05 03:30 UTC（隔天）
    intake = await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        taken_at=datetime(2026, 9, 5, 3, 30, tzinfo=UTC),
    )

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert [item["intake_id"] for item in body] == [intake.id]


async def test_an_intake_at_exactly_midnight_belongs_to_the_next_day_not_today(
    client, db_session, monkeypatch
):
    """日界線是半開區間 [start, end)：`end` 同時是「今天的結束」與「隔天的
    開始」，必須只屬於隔天。用 `<=` 而不是 `<` 的話，這筆打卡會同時出現在
    兩天的清單裡 —— 到了計畫 4b，那一次攝取的熱量會被計入兩次
    （計畫 3 Task 9 同一個坑）。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    fixed_today = date(2026, 6, 1)
    monkeypatch.setattr(
        "app.api.routes.supplements.today_in_timezone", lambda _tz: fixed_today
    )
    _start, end = day_bounds(fixed_today, user.timezone)
    await create_intake(db_session, user=user, supplement=supplement, taken_at=end)

    response = await client.get("/api/supplements/today", headers=auth(user))

    assert response.status_code == 200
    assert response.json() == [], "邊界那一刻屬於隔天，不能出現在今天"
