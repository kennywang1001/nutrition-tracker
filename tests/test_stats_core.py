"""Task 6：`app/stats.py` 的核心彙總邏輯。

路由層（Task 7 的 `GET /api/stats/daily`）不在這裡測——這裡只測「把一段期間
內、按使用者當地日期分桶的食物與補劑攝取」這件事本身，跟 HTTP 完全無關。
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import Date, cast, func, select

from app.days import day_bounds
from app.models.food import FoodRevision
from app.nutrition import Macros
from app.stats import bucket_daily_macros, daily_macros
from tests.factories import create_food, create_intake, create_meal, create_supplement, create_user


async def _revision(db_session, food):
    return await db_session.get(FoodRevision, food.current_revision_id)


# ---------------------------------------------------------------------------
# 陷阱 4：食物要換算（kcal × quantity_g / 100），補劑不用（快照已是總量）。
# ---------------------------------------------------------------------------


async def test_food_macros_are_converted_by_quantity_over_100(db_session):
    """重用 app/nutrition.py 的 scale() —— 那個 100 只能出現在一個地方。"""
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, kcal=200, protein_g=20, fat_g=10, carb_g=30
    )
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 12, 0, tzinfo=UTC),
        items=[(revision, Decimal("150"))],
    )

    result = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 1)
    )

    assert result.food == Macros(
        kcal=Decimal("300.00"),
        protein_g=Decimal("30.00"),
        fat_g=Decimal("15.00"),
        carb_g=Decimal("45.00"),
    )
    assert result.supplement == Macros.zero()
    assert result.actual == result.food


async def test_supplement_snapshot_is_summed_without_multiplying_dose_again(db_session):
    """決定 3：supplement_intakes 的四個欄位已經是「這次攝取的總量」。
    這裡故意給一個跟快照數字對不上的 dose（3），如果實作又乘了一次 dose，
    kcal 會變成 450 而不是 150 —— 這個測試就是用來抓那個錯誤的。
    """
    user = await create_user(db_session)
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        dose=3,
        taken_at=datetime(2026, 1, 1, 1, 0, tzinfo=UTC),
        kcal=150,
        protein_g=32,
        fat_g=2,
        carb_g=2,
    )

    result = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 1)
    )

    assert result.supplement == Macros(
        kcal=Decimal("150.00"),
        protein_g=Decimal("32.00"),
        fat_g=Decimal("2.00"),
        carb_g=Decimal("2.00"),
    )
    assert result.food == Macros.zero()


async def test_food_and_supplement_totals_are_summed(db_session):
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, kcal=100, protein_g=10, fat_g=5, carb_g=20
    )
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )
    supplement = await create_supplement(db_session, created_by=user, owner=user)
    await create_intake(
        db_session,
        user=user,
        supplement=supplement,
        taken_at=datetime(2026, 1, 1, 5, 0, tzinfo=UTC),
        kcal=50,
        protein_g=10,
        fat_g=2,
        carb_g=3,
    )

    result = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 1)
    )

    assert result.actual == Macros(
        kcal=Decimal("150.00"),
        protein_g=Decimal("20.00"),
        fat_g=Decimal("7.00"),
        carb_g=Decimal("23.00"),
    )


async def test_food_totals_round_each_item_before_summing_not_after(db_session):
    """nutrition.py 的 total() 是「各項先四捨五入再加總」，不是「加總後才四捨
    五入」——兩者可能差一分（見 app/nutrition.py 的說明）。這裡選的數字刻意
    讓兩條路徑分出勝負：quantity_g=50.50 讓每項換算出 0.505，
    ROUND_HALF_UP 無條件進位成 0.51；兩項先各自四捨五入再加總是 1.02。
    如果實作在 SQL 裡直接 SUM(kcal * quantity_g / 100) 不透過 scale()，
    會拿到未四捨五入的 1.01（或型別不同的東西），這個測試會抓到。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, kcal=1, protein_g=0, fat_g=0, carb_g=0)
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=user,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("50.50")), (revision, Decimal("50.50"))],
    )

    result = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 1)
    )

    assert result.food.kcal == Decimal("1.02")


# ---------------------------------------------------------------------------
# 空區間 / 沒有資料
# ---------------------------------------------------------------------------


async def test_bucket_daily_macros_returns_empty_dict_for_no_data(db_session):
    user = await create_user(db_session)

    result = await bucket_daily_macros(
        db_session,
        user_id=user.id,
        tz_name=user.timezone,
        start=date(2026, 1, 1),
        end=date(2026, 1, 8),
    )

    assert result == {}


async def test_daily_macros_returns_zero_when_no_data(db_session):
    user = await create_user(db_session)

    result = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 1)
    )

    assert result.food == Macros.zero()
    assert result.supplement == Macros.zero()
    assert result.actual == Macros.zero()


# ---------------------------------------------------------------------------
# 跨日分桶：一次查詢，不是每天一次查詢（陷阱 2）
# ---------------------------------------------------------------------------


async def test_bucket_daily_macros_assigns_items_to_their_own_local_day(db_session):
    """一次查詢涵蓋 3 天，SQL 必須把每一列分進正確的當地日期。用
    day_bounds() 算出的當地午夜 + 30 分鐘下手——這正是東 +8 時區裡
    UTC-vs-local 錯誤唯一鑑別得出來的窗口（00:00~08:00 本地時間）。
    """
    user = await create_user(db_session)  # Asia/Taipei，UTC+8
    food = await create_food(
        db_session, created_by=user, kcal=100, protein_g=10, fat_g=5, carb_g=20
    )
    revision = await _revision(db_session, food)
    day1_start, _ = day_bounds(date(2026, 1, 1), user.timezone)
    await create_meal(
        db_session,
        user=user,
        eaten_at=day1_start + timedelta(minutes=30),
        items=[(revision, Decimal("100"))],
    )
    day3_start, _ = day_bounds(date(2026, 1, 3), user.timezone)
    await create_meal(
        db_session,
        user=user,
        eaten_at=day3_start + timedelta(minutes=30),
        items=[(revision, Decimal("200"))],
    )

    result = await bucket_daily_macros(
        db_session,
        user_id=user.id,
        tz_name=user.timezone,
        start=date(2026, 1, 1),
        end=date(2026, 1, 4),
    )

    assert set(result.keys()) == {date(2026, 1, 1), date(2026, 1, 3)}
    assert result[date(2026, 1, 1)].food.kcal == Decimal("100.00")
    assert result[date(2026, 1, 3)].food.kcal == Decimal("200.00")


async def test_local_midnight_boundary_belongs_to_the_next_day_not_the_previous(db_session):
    """半開區間 [start, end)：恰好落在當地午夜的一筆，屬於新的一天，不是
    前一天（跟 day_bounds()、meals.py、supplements.py 同一條規則）。
    """
    user = await create_user(db_session)
    food = await create_food(
        db_session, created_by=user, kcal=100, protein_g=10, fat_g=5, carb_g=20
    )
    revision = await _revision(db_session, food)
    _start, midnight = day_bounds(date(2026, 1, 1), user.timezone)  # == start of Jan 2
    await create_meal(
        db_session, user=user, eaten_at=midnight, items=[(revision, Decimal("100"))]
    )

    day1 = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 1)
    )
    day2 = await daily_macros(
        db_session, user_id=user.id, tz_name=user.timezone, day=date(2026, 1, 2)
    )

    assert day1.food == Macros.zero()
    assert day2.food.kcal == Decimal("100.00")


# ---------------------------------------------------------------------------
# 只算自己的資料
# ---------------------------------------------------------------------------


async def test_bucket_daily_macros_only_includes_the_given_user(db_session):
    """用全域食物/補劑（owner=None）：可見性不會先擋住 bob 的資料，
    這裡測的才是真正的 user_id 過濾（計畫 3 Task 17 的教訓）。
    """
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(
        db_session, created_by=alice, kcal=100, protein_g=10, fat_g=5, carb_g=20
    )
    revision = await _revision(db_session, food)
    await create_meal(
        db_session,
        user=bob,
        eaten_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        items=[(revision, Decimal("100"))],
    )
    supplement = await create_supplement(db_session, created_by=alice)
    await create_intake(
        db_session,
        user=bob,
        supplement=supplement,
        taken_at=datetime(2026, 1, 1, 4, 0, tzinfo=UTC),
        kcal=50,
    )

    result = await daily_macros(
        db_session, user_id=alice.id, tz_name=alice.timezone, day=date(2026, 1, 1)
    )

    assert result.actual == Macros.zero()


# ---------------------------------------------------------------------------
# 陷阱 2：PostgreSQL 的 AT TIME ZONE 與 Python 的 day_bounds() 是兩套獨立實作
# ---------------------------------------------------------------------------

_DST_TEST_CASES = [
    ("Asia/Taipei", date(2026, 3, 8)),  # 沒有日光節約，當對照組
    ("America/New_York", date(2026, 3, 8)),  # 春天切換：這天少一小時
    ("America/New_York", date(2026, 11, 1)),  # 秋天切換：這天多一小時
    ("America/Havana", date(2026, 3, 8)),  # 當地午夜不存在的時區（計畫 3 實測）
]


@pytest.mark.parametrize(("tz_name", "day"), _DST_TEST_CASES)
async def test_sql_at_time_zone_agrees_with_python_day_bounds_across_dst(db_session, tz_name, day):
    """陷阱 2 的一致性釘子——不是用來抓「今天」的 bug。

    PostgreSQL 的 `AT TIME ZONE`（這裡用等義的 `timezone(zone, ts)` 函式形式）
    使用它自己內建的時區資料庫；Python 的 `day_bounds()` 用 zoneinfo
    （Windows 上是 PyPI 的 tzdata 套件、Docker 裡是 /usr/share/zoneinfo）。
    三個獨立更新的來源。

    寫這個計畫時已經手動核對過：PostgreSQL 16.15 對 tzdata 2026.3，
    三個時區的 DST 切換日各 10 個時刻，共 90 個，0 個不一致 —— 所以這個測試
    **今天**必然是綠的。它的價值在未來：某天某個國家改了日光節約規則，
    兩邊資料庫更新的時間點沒有同步（PostgreSQL 版本升級了、但執行測試的
    機器上 zoneinfo 資料庫還沒跟上，或反過來），這個測試就會變紅——
    那才是它真正要抓的東西。請不要因為它「看起來沒做事」就刪掉它。

    做法：對這一天前後各 12 小時、每小時一個時刻（共 48 個，涵蓋切換的那一刻
    附近），用 SQL 算出 local_day，再用 Python 的 day_bounds() 驗證
    這個時刻真的落在 [start, end) 裡——兩邊只要有一絲不一致，
    `start <= instant < end` 就會是 False。
    """
    day_start_utc, _ = day_bounds(day, "UTC")
    instants = [day_start_utc - timedelta(hours=12) + timedelta(hours=h) for h in range(48)]

    for instant in instants:
        sql_local_day = await db_session.scalar(select(cast(func.timezone(tz_name, instant), Date)))
        start, end = day_bounds(sql_local_day, tz_name)
        assert start <= instant < end, (
            f"{instant} 被 SQL AT TIME ZONE 分到 {sql_local_day}，"
            f"但 Python day_bounds({sql_local_day!r}, {tz_name!r}) = "
            f"[{start}, {end}) 不包含這個時刻 —— 兩套時區資料庫已經漂移。"
        )
