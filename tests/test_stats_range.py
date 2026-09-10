"""`GET /api/stats/range?from=&to=`（計畫 4b Task 8）。

最重要的測試是 `test_each_day_uses_the_target_in_effect_on_that_day` ——
它是有效期間制（規格決策 5、本計畫決定 1）唯一的實證。一個「永遠用最新目標」
的實作會通過這個檔案裡其他每一個測試。
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

from app.models.food import FoodRevision
from app.models.supplement import TimeOfDay
from app.security.tokens import create_token
from tests.factories import (
    create_food,
    create_intake,
    create_meal,
    create_plan,
    create_supplement,
    create_target,
    create_user,
)


# 台北 2026-09-08 12:00 -> UTC 04:00 同一天。刻意不挑清晨，
# 因為這個檔案測的不是時區鑑別力（那是 Task 9 的事）。
def _noon(day: date) -> datetime:
    return datetime(day.year, day.month, day.day, 4, 0, tzinfo=UTC)


def auth(user):
    return {"Authorization": f"Bearer {create_token(user.id, 'access')}"}


async def _revision(db_session, food):
    """create_food 回傳的是 Food，餐點項目要的是它目前生效的那一版。"""
    return await db_session.get(FoodRevision, food.current_revision_id)


async def _range(client, user, date_from: date, date_to: date):
    return await client.get(
        "/api/stats/range",
        headers=auth(user),
        params={"from": date_from.isoformat(), "to": date_to.isoformat()},
    )


# --------------------------------------------------------------------------
# 趨勢
# --------------------------------------------------------------------------


async def test_trend_includes_days_with_no_data_as_zero(client, db_session):
    """畫圖要連續：沒有資料的日子回 0，不是把那一天整個略過。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    revision = await _revision(db_session, food)
    await create_meal(
        db_session, user=user, eaten_at=_noon(date(2026, 9, 8)),
        items=[(revision, Decimal("100"))],
    )
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 7), date(2026, 9, 9))

    assert response.status_code == 200
    trend = response.json()["trend"]
    assert [d["date"] for d in trend] == ["2026-09-07", "2026-09-08", "2026-09-09"]
    assert trend[0]["actual"]["kcal"] == "0.00"
    assert trend[1]["actual"]["kcal"] == "100.00"
    assert trend[2]["actual"]["kcal"] == "0.00"


async def test_the_range_is_inclusive_on_both_ends(client, db_session):
    """使用者說「9/1 到 9/7」時預期的是 7 天，不是 6 天。"""
    user = await create_user(db_session)
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 1), date(2026, 9, 7))

    assert response.status_code == 200
    assert len(response.json()["trend"]) == 7


async def test_food_and_supplements_are_both_counted(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=200)
    revision = await _revision(db_session, food)
    supplement = await create_supplement(db_session, created_by=user, owner=user, kcal=50)
    day = date(2026, 9, 8)
    await create_meal(
        db_session, user=user, eaten_at=_noon(day), items=[(revision, Decimal("100"))]
    )
    await create_intake(
        db_session, user=user, supplement=supplement, taken_at=_noon(day), kcal=50
    )
    await db_session.commit()

    response = await _range(client, user, day, day)

    assert response.status_code == 200
    assert response.json()["trend"][0]["actual"]["kcal"] == "250.00"


async def test_another_users_data_is_not_counted(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    # 全域食物：讓「可見性過濾」無法替「user_id 過濾」擋刀
    food = await create_food(db_session, created_by=alice, kcal=500)
    revision = await _revision(db_session, food)
    day = date(2026, 9, 8)
    await create_meal(
        db_session, user=alice, eaten_at=_noon(day), items=[(revision, Decimal("100"))]
    )
    await db_session.commit()

    response = await _range(client, bob, day, day)

    assert response.status_code == 200
    assert response.json()["trend"][0]["actual"]["kcal"] == "0.00"


# --------------------------------------------------------------------------
# 目標：本檔案最重要的測試
# --------------------------------------------------------------------------


async def test_each_day_uses_the_target_in_effect_on_that_day(client, db_session):
    """期間跨越目標變更時，每一天各自對應「當天生效的」目標。

    這是有效期間制（規格決策 5、本計畫決定 1）唯一的實證：
    一個「永遠用最新目標」的實作會通過這個檔案裡其他每一個測試。

    佈置：9/1~9/5 目標 1000 kcal，9/5 起改成 2000 kcal（半開區間，
    9/5 當天屬於後者）。每天固定攝取 1000 kcal，所以：
      9/4 -> ratio 1.00（1000/1000）
      9/5 -> ratio 0.50（1000/2000）
    兩天的 ratio 不同，正是「用當天的標準算」的證據。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=1000)
    revision = await _revision(db_session, food)
    await create_target(
        db_session, user=user, kcal=1000,
        effective_from=date(2026, 9, 1), effective_to=date(2026, 9, 5),
    )
    await create_target(
        db_session, user=user, kcal=2000, effective_from=date(2026, 9, 5),
    )
    for day in (date(2026, 9, 4), date(2026, 9, 5)):
        await create_meal(
            db_session, user=user, eaten_at=_noon(day), items=[(revision, Decimal("100"))]
        )
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 4), date(2026, 9, 5))

    assert response.status_code == 200
    trend = {d["date"]: d for d in response.json()["trend"]}
    assert trend["2026-09-04"]["target"]["kcal"] == "1000.00"
    assert trend["2026-09-04"]["ratio"]["kcal"] == "1.00"
    assert trend["2026-09-05"]["target"]["kcal"] == "2000.00"
    assert trend["2026-09-05"]["ratio"]["kcal"] == "0.50"


async def test_days_without_a_target_have_null_target_and_ratio(client, db_session):
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=2000,
        effective_from=date(2026, 9, 8), effective_to=date(2026, 9, 9),
    )
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 7), date(2026, 9, 9))

    assert response.status_code == 200
    trend = {d["date"]: d for d in response.json()["trend"]}
    assert trend["2026-09-07"]["target"] is None
    assert trend["2026-09-07"]["ratio"] is None
    assert trend["2026-09-08"]["target"]["kcal"] == "2000.00"
    assert trend["2026-09-09"]["target"] is None


# --------------------------------------------------------------------------
# 依從率（決定 3）
# --------------------------------------------------------------------------


async def test_adherence_counts_plan_day_pairs(client, db_session):
    """應吃 = 期間內每一天 × 當天生效的每一筆計畫。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 9, 1)
    )
    # 三天裡吃了兩天
    for day in (date(2026, 9, 7), date(2026, 9, 8)):
        await create_intake(
            db_session, user=user, supplement=supplement, plan=plan, taken_at=_noon(day)
        )
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 7), date(2026, 9, 9))

    assert response.status_code == 200
    assert response.json()["adherence"] == "0.67"  # 2/3


async def test_taking_a_dose_twice_in_one_day_does_not_exceed_full_adherence(client, db_session):
    """每個 (計畫, 日) 配對最多算一次（決定 3）。

    不設上限的話，某天多吃一顆會讓依從率超過 100%，
    而且可以用連吃三天補回漏掉的兩天 —— 那衡量的就不是「有沒有按計畫吃」了。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 9, 1)
    )
    day = date(2026, 9, 8)
    for hour in (4, 10):
        await create_intake(
            db_session, user=user, supplement=supplement, plan=plan,
            taken_at=datetime(2026, 9, 8, hour, 0, tzinfo=UTC),
        )
    await db_session.commit()

    response = await _range(client, user, day, day)

    assert response.status_code == 200
    assert response.json()["adherence"] == "1.00"


async def test_two_plans_on_the_same_day_are_two_expected_doses(client, db_session):
    """早上一顆、睡前一顆是兩筆計畫，應吃就是 2 —— 吃了一顆是 0.50。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    morning = await create_plan(
        db_session, user=user, supplement=supplement,
        time_of_day=TimeOfDay.MORNING, effective_from=date(2026, 9, 1),
    )
    await create_plan(
        db_session, user=user, supplement=supplement,
        time_of_day=TimeOfDay.BEDTIME, effective_from=date(2026, 9, 1),
    )
    day = date(2026, 9, 8)
    await create_intake(
        db_session, user=user, supplement=supplement, plan=morning, taken_at=_noon(day)
    )
    await db_session.commit()

    response = await _range(client, user, day, day)

    assert response.status_code == 200
    assert response.json()["adherence"] == "0.50"


async def test_an_ad_hoc_intake_does_not_count_toward_adherence(client, db_session):
    """臨時打卡不對應任何計畫，不計入依從率的分子 —— 但要計入營養素總攝取。

    這兩件事是不同的問題（決定 3）。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user, kcal=40)
    await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 9, 1)
    )
    day = date(2026, 9, 8)
    await create_intake(
        db_session, user=user, supplement=supplement, plan=None, taken_at=_noon(day), kcal=40
    )
    await db_session.commit()

    response = await _range(client, user, day, day)

    assert response.status_code == 200
    body = response.json()
    assert body["adherence"] == "0.00", "臨時打卡不能算進分子"
    assert body["trend"][0]["actual"]["kcal"] == "40.00", "但要算進總攝取"


async def test_adherence_is_null_when_there_are_no_plans(client, db_session):
    """分母為 0 時回 null，不是 0 也不是 1。"""
    user = await create_user(db_session)
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 7), date(2026, 9, 9))

    assert response.status_code == 200
    assert response.json()["adherence"] is None


async def test_a_plan_only_counts_on_days_it_was_in_effect(client, db_session):
    """計畫 9/8 才開始，9/7 那天不該算進應吃。"""
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    plan = await create_plan(
        db_session, user=user, supplement=supplement, effective_from=date(2026, 9, 8)
    )
    await create_intake(
        db_session, user=user, supplement=supplement, plan=plan,
        taken_at=_noon(date(2026, 9, 8)),
    )
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 7), date(2026, 9, 8))

    # 應吃只有 9/8 那一天的 1 筆，實吃 1 筆 -> 1.00
    assert response.json()["adherence"] == "1.00"


async def test_another_users_plans_are_not_counted(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    # 全域補劑：避免可見性過濾替 user_id 過濾擋刀
    supplement = await create_supplement(db_session, created_by=alice)
    await create_plan(
        db_session, user=alice, supplement=supplement, effective_from=date(2026, 9, 1)
    )
    await db_session.commit()

    response = await _range(client, bob, date(2026, 9, 8), date(2026, 9, 8))

    assert response.status_code == 200
    assert response.json()["adherence"] is None, "Bob 沒有計畫，分母應該是 0"


# --------------------------------------------------------------------------
# 參數驗證（決定 4）
# --------------------------------------------------------------------------


async def test_a_range_longer_than_366_days_is_rejected(client, db_session):
    user = await create_user(db_session)
    await db_session.commit()

    start = date(2026, 1, 1)
    ok = await _range(client, user, start, start + timedelta(days=365))
    too_long = await _range(client, user, start, start + timedelta(days=366))

    assert ok.status_code == 200
    assert too_long.status_code == 422


async def test_to_before_from_is_rejected(client, db_session):
    user = await create_user(db_session)
    await db_session.commit()

    response = await _range(client, user, date(2026, 9, 9), date(2026, 9, 7))

    assert response.status_code == 422


async def test_range_stats_requires_authentication(client, db_session):
    response = await client.get(
        "/api/stats/range", params={"from": "2026-09-07", "to": "2026-09-09"}
    )
    assert response.status_code == 401
