"""某一天的「吃了多少、生效的目標、運動、熱量額度」（營養素配餐規格 D1）。

`GET /api/stats/daily` 與營養素配餐（`/api/planner/...`、`/api/ai/suggest-meal`）共用：
「額度」只有這一份定義（運動規格 D15）。查詢固定 4 次：食物、補劑（`daily_macros`）、
目標、運動的 SUM——跟筆數無關（tests/test_stats_daily.py 數著）。

只用呼叫端給的 user_id。健康相關：這個模組不寫 log（tests/test_planner_privacy.py 掃）。
"""

from dataclasses import dataclass
from datetime import date
from decimal import Decimal

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.exercise import kcal_budget
from app.exercise_data import exercise_kcal_on
from app.models.target import UserTarget
from app.stats import DayMacros, daily_macros


@dataclass(frozen=True)
class DayBudget:
    macros: DayMacros
    target: UserTarget | None
    exercise_kcal: Decimal
    # 沒有目標、或目標沒設熱量：None（「沒有目標」不會變成「額度＝運動」，運動 D15）。
    kcal_budget: Decimal | None


async def target_on(db: AsyncSession, user_id: int, day: date) -> UserTarget | None:
    """那一天生效的目標：effective_from <= day < effective_to（NULL＝無窮遠）。
    跟 `GET /api/targets?date=` 同一條規則，兩處不能有一處用 <=。"""
    target: UserTarget | None = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user_id,
            UserTarget.effective_from <= day,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > day),
        )
    )
    return target


async def load_day_budget(
    db: AsyncSession, *, user_id: int, tz_name: str, adds_exercise: bool, day: date
) -> DayBudget:
    macros = await daily_macros(db, user_id=user_id, tz_name=tz_name, day=day)
    target = await target_on(db, user_id, day)
    exercise = await exercise_kcal_on(db, user_id=user_id, tz_name=tz_name, day=day)
    target_kcal = target.kcal if target is not None else None
    return DayBudget(
        macros=macros,
        target=target,
        exercise_kcal=exercise,
        kcal_budget=kcal_budget(target_kcal, exercise, adds_exercise),
    )
