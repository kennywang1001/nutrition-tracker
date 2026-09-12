"""三個端點對「同一天」的判斷必須完全一致（計畫 4b Task 9、陷阱 1）。

| 端點 | 誰決定「這一天」 |
|---|---|
| `GET /api/meals?date=` | 計畫 3 的 `day_bounds()` |
| `GET /api/supplements/today` | 計畫 4a 的 `day_bounds()` + `today_in_timezone()` |
| `GET /api/stats/daily?date=` | 計畫 4b |

三者不一致的話，使用者會看到「今天吃了 3 餐」但統計只算了 2 餐的熱量 ——
而且**每一個端點各自看起來都是對的**，不會有任何東西報錯。
這種缺陷沒有徵狀，只能靠一個同時打三個端點的測試守住。

本檔案不新增任何正式程式碼，只新增測試。

## 為什麼是這幾個時刻

日界線的錯誤只在「兩種算法的結果不同」的那段時間才看得出來。
**兩個視窗的重疊區間就是零鑑別力的區間**（計畫 4a Task 10 實測結論）：
UTC 以東 +N 的時區，只有當地 `00:00` 到 `N:00` 之間的時刻能鑑別
「用當地時區」與「用 UTC」的差別；以西 −N 則只有當地 `(24−N):00` 到午夜。

所以這裡一律把資料放在**當地午夜那一刻**與**隔天當地午夜那一刻** ——
前者必然落在有鑑別力的帶裡（任何時區的 00:00 都是），
後者同時是「這一天的結束」與「隔天的開始」，用來釘住半開區間。
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal
from zoneinfo import ZoneInfo

import pytest

from app.days import day_bounds
from app.models.food import FoodRevision
from app.security.tokens import create_access_token
from tests.factories import (
    create_food,
    create_intake,
    create_meal,
    create_supplement,
    create_user,
)

# (時區, 那一天) —— 三種形狀：一般、DST 切換日、當地午夜不存在的日子
BOUNDARY_CASES = [
    pytest.param("Asia/Taipei", date(2026, 9, 8), id="taipei-normal"),
    pytest.param("America/New_York", date(2026, 3, 8), id="ny-spring-forward-23h"),
    pytest.param("America/Havana", date(2026, 3, 8), id="havana-no-local-midnight"),
]


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _revision(db_session, food):
    return await db_session.get(FoodRevision, food.current_revision_id)


def discriminating_instant(day: date, tz_name: str) -> datetime:
    """回傳一個「換算成 UTC 之後會落到不同日期」的當地時刻。

    這是整個檔案裡最容易寫錯的一件事，而且寫錯不會有徵狀 ——
    測試照樣全綠，只是什麼都沒驗到。實測踩過：本檔案第一版對三個時區
    一律用「當地午夜」，結果 UTC 以西的兩個案例（New York、Havana）
    對「改用 UTC」的突變**完全沒有反應**：

        NY 2026-03-08 當地 00:00 (EST) = 同一天 05:00 UTC   <- 同一個 UTC 日，零鑑別力
        台北 2026-09-08 當地 00:00     = 前一天 16:00 UTC   <- 不同 UTC 日，有鑑別力

    通則（計畫 4a Task 10 的實測結論）：**兩個視窗的重疊區間就是零鑑別力的
    區間。** UTC 以東 +N 只有當地 `00:00`~`N:00` 有鑑別力；
    以西 −N 只有當地 `(24−N):00`~午夜有鑑別力。

    所以：東邊取當地午夜之後一點，西邊取隔天午夜之前一點。
    """
    start, end = day_bounds(day, tz_name)
    offset = datetime(day.year, day.month, day.day, 12, tzinfo=ZoneInfo(tz_name)).utcoffset()
    assert offset is not None
    half_hour = timedelta(minutes=30)
    instant = start + half_hour if offset > timedelta(0) else end - half_hour
    assert instant.astimezone(UTC).date() != day, (
        f"{tz_name} {day}：挑到的時刻換算 UTC 仍是同一天，沒有鑑別力"
    )
    return instant


async def _user_in(db_session, client, tz_name: str):
    """建立使用者並把時區設成 tz_name（走 PATCH /api/me，跟正式路徑一致）。"""
    user = await create_user(db_session)
    await db_session.commit()
    response = await client.patch("/api/me", headers=auth(user), json={"timezone": tz_name})
    assert response.status_code == 200
    await db_session.refresh(user)
    return user


@pytest.mark.parametrize(("tz_name", "day"), BOUNDARY_CASES)
async def test_meals_and_stats_agree_on_a_meal_at_the_local_day_boundary(
    client, db_session, tz_name, day
):
    """恰好落在當地午夜的一餐，`/api/meals?date=` 與 `/api/stats/daily?date=`
    必須把它歸到同一天；落在隔天午夜的那一餐則必須同時被兩者歸到隔天。
    """
    user = await _user_in(db_session, client, tz_name)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    revision = await _revision(db_session, food)
    start, end = day_bounds(day, tz_name)

    await create_meal(db_session, user=user, eaten_at=start, items=[(revision, Decimal("100"))])
    await create_meal(db_session, user=user, eaten_at=end, items=[(revision, Decimal("100"))])
    await db_session.commit()

    next_day = day + timedelta(days=1)
    for target_day, expected_kcal in ((day, "100.00"), (next_day, "100.00")):
        meals = await client.get(
            "/api/meals", headers=auth(user), params={"date": target_day.isoformat()}
        )
        stats = await client.get(
            "/api/stats/daily", headers=auth(user), params={"date": target_day.isoformat()}
        )
        assert meals.status_code == 200
        assert stats.status_code == 200
        assert len(meals.json()) == 1, f"{target_day} 應該只有一餐"
        assert stats.json()["actual"]["kcal"] == expected_kcal, (
            f"{target_day}：/meals 說有 {len(meals.json())} 餐，"
            f"但 /stats/daily 算出 {stats.json()['actual']['kcal']} kcal —— 兩者對不起來"
        )


@pytest.mark.parametrize(("tz_name", "day"), BOUNDARY_CASES)
async def test_the_boundary_instant_belongs_to_the_next_day_in_both_endpoints(
    client, db_session, tz_name, day
):
    """`end` 那一刻同時是「這一天的結束」與「隔天的開始」——
    半開區間 `[start, end)` 代表它只屬於隔天。兩個端點都要這樣認定。
    """
    user = await _user_in(db_session, client, tz_name)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    revision = await _revision(db_session, food)
    _, end = day_bounds(day, tz_name)

    await create_meal(db_session, user=user, eaten_at=end, items=[(revision, Decimal("100"))])
    await db_session.commit()

    meals_today = await client.get(
        "/api/meals", headers=auth(user), params={"date": day.isoformat()}
    )
    stats_today = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": day.isoformat()}
    )

    assert meals_today.json() == [], "邊界那一刻不屬於這一天"
    assert stats_today.json()["actual"]["kcal"] == "0.00", "統計也不能把它算進這一天"


@pytest.mark.parametrize(("tz_name", "day"), BOUNDARY_CASES)
async def test_todays_supplement_list_and_stats_agree_on_a_boundary_intake(
    client, db_session, monkeypatch, tz_name, day
):
    """`/api/supplements/today` 與 `/api/stats/daily?date=` 對同一筆
    落在日界線上的打卡，必須歸到同一天。

    `/supplements/today` 的「今天」來自 `today_in_timezone()`，
    這裡 monkeypatch 它把「今天」釘在 `day`，讓測試不依賴真實時鐘。
    """
    user = await _user_in(db_session, client, tz_name)
    supplement = await create_supplement(db_session, created_by=user, owner=user, kcal=40)
    start, end = day_bounds(day, tz_name)

    # 一筆在當地午夜（屬於 day），一筆在隔天午夜（屬於 day+1）
    await create_intake(
        db_session, user=user, supplement=supplement, taken_at=start, kcal=40
    )
    await create_intake(
        db_session, user=user, supplement=supplement, taken_at=end, kcal=40
    )
    await db_session.commit()

    monkeypatch.setattr("app.api.routes.supplements.today_in_timezone", lambda _tz: day)

    today_list = await client.get("/api/supplements/today", headers=auth(user))
    stats = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": day.isoformat()}
    )

    assert today_list.status_code == 200
    assert stats.status_code == 200
    assert len(today_list.json()) == 1, "只有落在當地午夜那一筆屬於今天"
    assert stats.json()["breakdown"]["supplement"]["kcal"] == "40.00", (
        f"/supplements/today 列出 {len(today_list.json())} 筆，"
        f"但 /stats/daily 只算了 {stats.json()['breakdown']['supplement']['kcal']} kcal"
    )


async def test_range_and_daily_agree_on_the_same_day(client, db_session):
    """`/stats/range` 趨勢裡的一天，跟單獨查 `/stats/daily` 必須完全一致。

    兩個端點各自算目標與比例（`_target_and_ratio()` 是共用的），
    但分桶路徑不同（`daily_macros()` vs `bucket_daily_macros()`）——
    同一個日期從兩邊拿到不同答案的話，使用者無法信任其中任何一個。
    """
    tz_name = "Asia/Taipei"
    day = date(2026, 9, 8)
    user = await _user_in(db_session, client, tz_name)
    food = await create_food(db_session, created_by=user, owner=user, kcal=250)
    revision = await _revision(db_session, food)
    start, _ = day_bounds(day, tz_name)
    await create_meal(db_session, user=user, eaten_at=start, items=[(revision, Decimal("100"))])
    await db_session.commit()

    daily = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": day.isoformat()}
    )
    ranged = await client.get(
        "/api/stats/range",
        headers=auth(user),
        params={"from": day.isoformat(), "to": day.isoformat()},
    )

    assert daily.status_code == 200
    assert ranged.status_code == 200
    day_in_trend = ranged.json()["trend"][0]
    assert day_in_trend["date"] == daily.json()["date"]
    assert day_in_trend["actual"] == daily.json()["actual"]
    assert day_in_trend["target"] == daily.json()["target"]
    assert day_in_trend["ratio"] == daily.json()["ratio"]


@pytest.mark.parametrize(("tz_name", "day"), BOUNDARY_CASES)
async def test_stats_uses_the_users_timezone_not_utc(client, db_session, tz_name, day):
    """時區一致性：`/api/meals?date=` 與 `/api/stats/daily?date=` 都必須用
    **使用者的**時區，不是 UTC。

    跟上面那兩個測試分開，是因為它們測的是不同的東西：
    上面測「半開區間的邊界歸屬」（需要午夜那一刻），
    這裡測「用誰的時區」（需要落在鑑別帶裡的時刻，見
    `discriminating_instant()` 的說明）。第一版把兩件事壓在同一組資料上，
    結果三個時區裡有兩個對「改用 UTC」的突變毫無反應。
    """
    user = await _user_in(db_session, client, tz_name)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    revision = await _revision(db_session, food)
    instant = discriminating_instant(day, tz_name)

    await create_meal(db_session, user=user, eaten_at=instant, items=[(revision, Decimal("100"))])
    await db_session.commit()

    meals = await client.get(
        "/api/meals", headers=auth(user), params={"date": day.isoformat()}
    )
    stats = await client.get(
        "/api/stats/daily", headers=auth(user), params={"date": day.isoformat()}
    )

    assert len(meals.json()) == 1, "這一餐屬於使用者當地的這一天"
    assert stats.json()["actual"]["kcal"] == "100.00", (
        f"{tz_name}：/meals 認得這一餐，但 /stats/daily 算出 "
        f"{stats.json()['actual']['kcal']} kcal —— 兩者用了不同的時區"
    )


@pytest.mark.parametrize(("tz_name", "day"), BOUNDARY_CASES)
async def test_range_uses_the_users_timezone_not_utc(client, db_session, tz_name, day):
    """`/stats/range` 也要用使用者時區 —— 它跟 `/stats/daily` 是不同的分桶路徑
    （`bucket_daily_macros()` vs `daily_macros()`），要各自釘住。
    """
    user = await _user_in(db_session, client, tz_name)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    revision = await _revision(db_session, food)
    instant = discriminating_instant(day, tz_name)

    await create_meal(db_session, user=user, eaten_at=instant, items=[(revision, Decimal("100"))])
    await db_session.commit()

    ranged = await client.get(
        "/api/stats/range",
        headers=auth(user),
        params={"from": day.isoformat(), "to": day.isoformat()},
    )

    assert ranged.status_code == 200
    assert ranged.json()["trend"][0]["actual"]["kcal"] == "100.00"
