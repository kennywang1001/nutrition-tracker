"""統計彙總的核心邏輯（計畫 4b Task 6）。

把「一段期間內、按使用者當地日期分桶的食物與補劑攝取」抽成這個模組，
路由層（`app/api/routes/stats.py`）只負責呼叫這裡、組裝 HTTP 回應——
分桶與換算的正確性因此可以脫離 HTTP 獨立測試（見 tests/test_stats_core.py）。

陷阱 4（來源不對稱，刻意如此）：
- 食物：`meal_items.quantity_g` + 釘住的 `food_revisions`，加總前要換算
  （`kcal × quantity_g / 100`），重用 `app/nutrition.py` 的 `scale()`。
- 補劑：`supplement_intakes` 的四個快照欄位已經是這次攝取的總量
  （計畫 4a 決定 3），加總前不需要再乘一次 dose。

陷阱 2（一次查詢分桶，不要每天查一次）：
`bucket_daily_macros()` 用一次查詢把整段期間的食物（另一次查詢補劑）都撈出來，
SQL 用 `timezone(:tz, 欄位)::date`（跟 `col AT TIME ZONE :tz` 是同一件事，
PostgreSQL 文件明講這兩種寫法等價）幫每一列算出它屬於哪個當地日期，
再用 Python 依這個值分組——不是對每一天各發一次查詢（那是跨日期的 N+1）。

但 `timezone()` 用的是 PostgreSQL 自己的時區資料庫，`app.days.day_bounds()`
用的是 Python 的 zoneinfo；兩者是兩套獨立實作，見 `local_day_expr()` 的說明
與 tests/test_stats_core.py 的一致性測試。
"""

from collections import defaultdict
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from sqlalchemy import ColumnElement, Date, cast, func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.days import day_bounds
from app.models.food import FoodRevision
from app.models.meal import Meal, MealItem
from app.models.supplement import SupplementIntake, SupplementPlan
from app.nutrition import Macros, scale, total


@dataclass(frozen=True)
class DayMacros:
    """一天份的巨量營養素，食物與補劑分項，外加合計。"""

    food: Macros
    supplement: Macros

    @property
    def actual(self) -> Macros:
        return self.food + self.supplement


def local_day_expr(
    tz_name: str, timestamp_expr: InstrumentedAttribute[datetime]
) -> ColumnElement[date]:
    """`(timestamp_expr AT TIME ZONE tz_name)::date` 的 SQLAlchemy 版本。

    用 `timezone(zone, timestamp)` 函式形式而不是 `AT TIME ZONE` 中綴語法，
    純粹是 SQLAlchemy 表達式組裝上比較方便；PostgreSQL 文件明講兩者等價。
    `tz_name` 是一般 Python 字串，會被 SQLAlchemy 自動綁成參數，不是字串
    拼接進 SQL（沒有 SQL injection 疑慮）。

    這個函式故意公開（不是模組私有）：tests/test_stats_core.py 的
    「AT TIME ZONE 對 day_bounds() 一致性」測試要用**跟正式程式碼完全相同**的
    這一段表達式去核對，而不是自己另外寫一份可能悄悄跟正式邏輯分岔的版本。
    """
    return cast(func.timezone(tz_name, timestamp_expr), Date)


async def bucket_daily_macros(
    db: AsyncSession,
    *,
    user_id: int,
    tz_name: str,
    start: date,
    end: date,
) -> dict[date, DayMacros]:
    """回傳 `[start, end)` 這段當地日期範圍內，這個使用者依當地日期分桶的
    食物 + 補劑巨量營養素。`end` 是不含的上界，跟 `day_bounds()` 的半開區間
    同一個慣例（`end` 那一天本身不算在範圍內）。

    只有真的有資料的那幾天才會出現在回傳的 dict 裡——沒有資料的日子留給
    呼叫端決定要不要補 0（`GET /api/stats/daily` 補 0，因為「今天沒吃」
    也是一個有意義的答案；未來的 `/stats/range` 畫圖要連續也需要補 0，
    但那是它自己的事，這裡不預設）。

    只發兩次查詢（食物一次、補劑一次），跟 `[start, end)` 涵蓋幾天、
    每天有幾筆紀錄都無關——不是對每一天各發一次查詢。
    """
    if end <= start:
        return {}

    utc_start, _ = day_bounds(start, tz_name)
    utc_end, _ = day_bounds(end, tz_name)

    food_local_day = local_day_expr(tz_name, Meal.eaten_at).label("local_day")
    food_rows = (
        await db.execute(
            select(FoodRevision, MealItem.quantity_g, food_local_day)
            .select_from(MealItem)
            .join(Meal, MealItem.meal_id == Meal.id)
            .join(FoodRevision, MealItem.food_revision_id == FoodRevision.id)
            .where(
                Meal.user_id == user_id,
                Meal.eaten_at >= utc_start,
                Meal.eaten_at < utc_end,
            )
        )
    ).all()

    supplement_local_day = local_day_expr(tz_name, SupplementIntake.taken_at).label("local_day")
    supplement_rows = (
        await db.execute(
            select(
                SupplementIntake.kcal,
                SupplementIntake.protein_g,
                SupplementIntake.fat_g,
                SupplementIntake.carb_g,
                supplement_local_day,
            ).where(
                SupplementIntake.user_id == user_id,
                SupplementIntake.taken_at >= utc_start,
                SupplementIntake.taken_at < utc_end,
            )
        )
    ).all()

    food_by_day: dict[date, list[Macros]] = defaultdict(list)
    for revision, quantity_g, local_day in food_rows:
        food_by_day[local_day].append(scale(revision, quantity_g))

    supplement_by_day: dict[date, list[Macros]] = defaultdict(list)
    for kcal, protein_g, fat_g, carb_g, local_day in supplement_rows:
        supplement_by_day[local_day].append(
            Macros(kcal=kcal, protein_g=protein_g, fat_g=fat_g, carb_g=carb_g)
        )

    days = set(food_by_day) | set(supplement_by_day)
    return {
        day: DayMacros(
            food=total(food_by_day.get(day, [])),
            supplement=total(supplement_by_day.get(day, [])),
        )
        for day in days
    }


async def daily_macros(
    db: AsyncSession, *, user_id: int, tz_name: str, day: date
) -> DayMacros:
    """單一天的版本——`GET /api/stats/daily`（Task 7）用這個。

    底層一樣走 `bucket_daily_macros()`，範圍只有一天；跟未來的
    `/stats/range`（Task 8）共用同一套分桶邏輯與四捨五入規則，不會有兩份
    「食物要不要換算、補劑要不要再乘一次」各自維護、容易漂移的程式碼。
    沒有資料時回傳全 0（不是拋例外、也不是回傳 None）——「今天沒有攝取任何
    東西」是統計上合法且常見的答案。
    """
    buckets = await bucket_daily_macros(
        db, user_id=user_id, tz_name=tz_name, start=day, end=day + timedelta(days=1)
    )
    return buckets.get(day, DayMacros(food=Macros.zero(), supplement=Macros.zero()))


async def adherence_rate(
    db: AsyncSession,
    *,
    user_id: int,
    tz_name: str,
    start: date,
    end: date,
) -> tuple[int, int]:
    """回傳 `(有打卡的配對數, 應該有的配對數)`，範圍是 `[start, end)`。

    決定 3 的定義：

        應吃 = 期間內每一天 × 當天生效的每一筆計畫  -> (plan, day) 配對
        實吃 = 上述配對中「當天至少有一筆對應打卡」的數量

    **分子是「配對」不是「打卡筆數」**，所以同一天同一計畫吃兩次只算一次。
    不設這個上限的話，某天多吃一顆會讓依從率超過 100%，
    而且可以用連吃三天補回漏掉的兩天 —— 那衡量的就不是「有沒有按計畫吃」了。

    分子只計入「計畫當天真的生效」的配對：對著一筆當天沒生效的計畫打卡
    （資料上做得到）不會讓分子超過分母。這是結構上保證 `分子 <= 分母`，
    而不是事後夾住。

    臨時打卡（`plan_id IS NULL`）不會進分子 —— 它不對應任何計畫。
    但它仍然計入營養素總攝取，那是 `bucket_daily_macros()` 的事。

    兩次查詢（計畫一次、打卡一次），跟期間有幾天無關。
    """
    if end <= start:
        return (0, 0)

    # 期間內曾經生效過的計畫：effective_from 在 end 之前，
    # 且 effective_to 為 NULL 或落在 start 之後（半開區間）。
    plans = (
        await db.execute(
            select(
                SupplementPlan.id,
                SupplementPlan.effective_from,
                SupplementPlan.effective_to,
            ).where(
                SupplementPlan.user_id == user_id,
                SupplementPlan.effective_from < end,
                or_(
                    SupplementPlan.effective_to.is_(None),
                    SupplementPlan.effective_to > start,
                ),
            )
        )
    ).all()

    utc_start, _ = day_bounds(start, tz_name)
    utc_end, _ = day_bounds(end, tz_name)
    intake_local_day = local_day_expr(tz_name, SupplementIntake.taken_at).label("local_day")
    taken_pairs = {
        (plan_id, local_day)
        for plan_id, local_day in (
            await db.execute(
                select(SupplementIntake.plan_id, intake_local_day)
                .where(
                    SupplementIntake.user_id == user_id,
                    SupplementIntake.plan_id.is_not(None),
                    SupplementIntake.taken_at >= utc_start,
                    SupplementIntake.taken_at < utc_end,
                )
                .distinct()
            )
        ).all()
    }

    expected = 0
    taken = 0
    for plan_id, effective_from, effective_to in plans:
        day = max(start, effective_from)
        last = end if effective_to is None else min(end, effective_to)
        while day < last:
            expected += 1
            if (plan_id, day) in taken_pairs:
                taken += 1
            day += timedelta(days=1)

    return (taken, expected)
