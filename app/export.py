"""匯出自己的資料（報表月份與匯出規格 §3）：三支 async generator，一塊一塊地讀、
一塊一塊地吐，交給 `StreamingResponse`。

**記憶體不隨資料量長。** 每一塊是一次 keyset 查詢（`(時間, id) > 上一塊的最後一列`、
`LIMIT`），寫成 CSV 位元組就交出去，下一塊才讀。不用 OFFSET：越後面越慢，而且匯出到
一半有人新增一筆，後面每一列都會位移。排序鍵帶 `id`：同一個時刻的兩列不會被跳過或重複。

**每一塊各是一個交易、各借一次連線。** 端點那一層（`app/api/routes/export.py` 的
`_release_between_chunks`）在每一塊交出去之前把交易結束掉，連線回到池子——讀得很慢的
用戶端卡住的是「送」，那時候不該握著連線。所以這裡的 generator 不能靠「整個匯出是同一個
交易」（keyset 游標本來就不靠），`yield` 出去的也只能是位元組。

**只讀自己的。** 每個查詢都從 `user_id == 呼叫者` 出發；餐點的項目用上一步查到的
`meal_id` 去拿。`photo_path` 從頭到尾沒有被 SELECT。

**時間是帳號時區（`users.timezone`）的當地時間**，跟報表、今日總覽算「哪一天」用的
同一個時區（`app/days.py`）；跟伺服器所在的時區無關。

**數字跟 app 裡看到的一樣。** 餐點的營養素用 `item_join_query()`（項目釘住的那一版）
與 `scale()`（同一套四捨五入）——跟 `GET /api/meals` 同一份實作，不是另外算一次。
"""

from collections import defaultdict
from collections.abc import AsyncIterator, Sequence
from datetime import datetime
from zoneinfo import ZoneInfo

from sqlalchemy import Row, select, tuple_
from sqlalchemy.ext.asyncio import AsyncSession

from app.csv_export import Cell, encode_header, encode_rows
from app.meal_reads import item_join_query
from app.models.expense import Expense, ExpenseCategory
from app.models.food import Food, FoodRevision
from app.models.meal import Meal, MealItem, MealType
from app.models.supplement import Supplement, SupplementIntake
from app.nutrition import scale

# 一塊讀幾列。花費與補劑一列約一兩百個位元組；餐點一塊是 200 餐（各帶自己的項目）。
# 測試用 monkeypatch 把它們調小——函式每次呼叫才讀這兩個值。
EXPORT_CHUNK_ROWS = 500
EXPORT_CHUNK_MEALS = 200

MEAL_COLUMNS = (
    "餐點編號",
    "日期",
    "時間",
    "餐別",
    "食物",
    "品牌",
    "份量",
    "單位",
    "熱量(kcal)",
    "蛋白質(g)",
    "脂肪(g)",
    "碳水(g)",
    "描述",
    "備註",
    "只有我看得到",
)
EXPENSE_COLUMNS = ("日期", "時間", "分類", "金額", "備註", "是否餐費")
SUPPLEMENT_COLUMNS = (
    "日期",
    "時間",
    "補劑",
    "品牌",
    "份數",
    "熱量(kcal)",
    "蛋白質(g)",
    "脂肪(g)",
    "碳水(g)",
)

# 中文標籤。前端也有一份（`frontend/src/api/meals.ts`、`api/expenses.ts`）；
# `dict[Enum, str]` 加上 `tests/test_export.py` 的「每個成員都有標籤」——
# 加了分類而忘了這裡，是測試紅，不是匯出到一半 KeyError。
MEAL_TYPE_LABELS: dict[MealType, str] = {
    MealType.BREAKFAST: "早餐",
    MealType.LUNCH: "午餐",
    MealType.DINNER: "晚餐",
    MealType.SNACK: "點心",
}
EXPENSE_CATEGORY_LABELS: dict[ExpenseCategory, str] = {
    ExpenseCategory.FOOD: "飲食",
    ExpenseCategory.TRANSPORT: "交通",
    ExpenseCategory.DAILY: "日用",
    ExpenseCategory.ENTERTAINMENT: "娛樂",
    ExpenseCategory.MEDICAL: "醫療",
    ExpenseCategory.HOUSING: "居住",
    ExpenseCategory.OTHER: "其他",
}

_YES, _NO = "是", "否"

# 沒有項目的一餐：食物、品牌、份量、單位、四個營養素都空著。
_NO_FOOD: tuple[Cell, ...] = (None,) * 8


def _local(instant: datetime, tz: ZoneInfo) -> tuple[str, str]:
    """一個時刻在帳號時區的日期（`YYYY-MM-DD`）與時間（`HH:MM`）。"""
    local = instant.astimezone(tz)
    return local.strftime("%Y-%m-%d"), local.strftime("%H:%M")


async def expense_csv(db: AsyncSession, *, user_id: int, tz_name: str) -> AsyncIterator[bytes]:
    """花費：一筆一列，由舊到新。"""
    tz = ZoneInfo(tz_name)
    yield encode_header(EXPENSE_COLUMNS)
    after: tuple[datetime, int] | None = None
    while True:
        # 選欄位而不是整個 ORM 物件：不經過 identity map，拿到的一定是資料庫裡的值
        # （`Numeric(10,2)` 的 "100.00"，不是記憶體裡使用者送來的 "100"——handover §6 第 49 種）。
        query = (
            select(
                Expense.id,
                Expense.spent_at,
                Expense.category,
                Expense.amount,
                Expense.note,
                Expense.meal_id,
            )
            .where(Expense.user_id == user_id)
            .order_by(Expense.spent_at, Expense.id)
            .limit(EXPORT_CHUNK_ROWS)
        )
        if after is not None:
            query = query.where(tuple_(Expense.spent_at, Expense.id) > after)
        rows = (await db.execute(query)).all()
        if not rows:
            return
        lines: list[Sequence[Cell]] = []
        for row in rows:
            day, clock = _local(row.spent_at, tz)
            lines.append(
                (
                    day,
                    clock,
                    EXPENSE_CATEGORY_LABELS[row.category],
                    row.amount,
                    row.note,
                    # 現在還掛在一餐上才算。那一餐被刪掉（SET NULL）之後就是「否」。
                    _YES if row.meal_id is not None else _NO,
                )
            )
        yield encode_rows(lines)
        after = (rows[-1].spent_at, rows[-1].id)


async def supplement_csv(
    db: AsyncSession, *, user_id: int, tz_name: str
) -> AsyncIterator[bytes]:
    """補劑的打卡：一次一列，由舊到新。

    份數與四個營養素是打卡當時寫死的快照（已經乘過份數）；名稱與品牌是補劑**現在**的
    （打卡紀錄只存 `supplement_id`）。
    """
    tz = ZoneInfo(tz_name)
    yield encode_header(SUPPLEMENT_COLUMNS)
    after: tuple[datetime, int] | None = None
    while True:
        query = (
            select(
                SupplementIntake.id,
                SupplementIntake.taken_at,
                Supplement.name,
                Supplement.brand,
                SupplementIntake.dose,
                SupplementIntake.kcal,
                SupplementIntake.protein_g,
                SupplementIntake.fat_g,
                SupplementIntake.carb_g,
            )
            .join(Supplement, SupplementIntake.supplement_id == Supplement.id)
            .where(SupplementIntake.user_id == user_id)
            .order_by(SupplementIntake.taken_at, SupplementIntake.id)
            .limit(EXPORT_CHUNK_ROWS)
        )
        if after is not None:
            query = query.where(
                tuple_(SupplementIntake.taken_at, SupplementIntake.id) > after
            )
        rows = (await db.execute(query)).all()
        if not rows:
            return
        lines: list[Sequence[Cell]] = []
        for row in rows:
            day, clock = _local(row.taken_at, tz)
            lines.append(
                (
                    day,
                    clock,
                    row.name,
                    row.brand,
                    row.dose,
                    row.kcal,
                    row.protein_g,
                    row.fat_g,
                    row.carb_g,
                )
            )
        yield encode_rows(lines)
        after = (rows[-1].taken_at, rows[-1].id)


async def meal_csv(db: AsyncSession, *, user_id: int, tz_name: str) -> AsyncIterator[bytes]:
    """餐點：一個項目一列，由舊到新；同一餐的幾列有同一個「餐點編號」。
    沒有項目的一餐也有一列（食物那幾欄空著）。"""
    tz = ZoneInfo(tz_name)
    yield encode_header(MEAL_COLUMNS)
    after: tuple[datetime, int] | None = None
    while True:
        query = (
            select(
                Meal.id, Meal.eaten_at, Meal.meal_type, Meal.description, Meal.note, Meal.is_private
            )
            .where(Meal.user_id == user_id)
            .order_by(Meal.eaten_at, Meal.id)
            .limit(EXPORT_CHUNK_MEALS)
        )
        if after is not None:
            query = query.where(tuple_(Meal.eaten_at, Meal.id) > after)
        meals = (await db.execute(query)).all()
        if not meals:
            return

        # 項目用 `GET /api/meals` 的同一份 join（項目釘住的那一版食物），一次把這一塊的
        # 餐的項目都帶回來——查詢次數跟餐數、項目數無關。
        item_rows = (
            await db.execute(
                item_join_query()
                .where(MealItem.meal_id.in_([meal.id for meal in meals]))
                .order_by(MealItem.id)
            )
        ).all()
        items_by_meal: dict[int, list[Row[tuple[MealItem, FoodRevision, Food]]]] = defaultdict(
            list
        )
        for item_row in item_rows:
            items_by_meal[item_row[0].meal_id].append(item_row)

        lines: list[Sequence[Cell]] = []
        for meal in meals:
            day, clock = _local(meal.eaten_at, tz)
            head: tuple[Cell, ...] = (
                str(meal.id),
                day,
                clock,
                MEAL_TYPE_LABELS[meal.meal_type],
            )
            # 描述在備註前面（AI 多樣估算規格 §3.2）。兩格都是 str，走 encode_rows 的
            # guard_text——公式字元的處理只有那一條路。
            tail: tuple[Cell, ...] = (
                meal.description,
                meal.note,
                _YES if meal.is_private else _NO,
            )
            items = items_by_meal.get(meal.id)
            if not items:
                lines.append((*head, *_NO_FOOD, *tail))
                continue
            for item, revision, food in items:
                macros = scale(revision, item.quantity_g)
                lines.append(
                    (
                        *head,
                        food.name,
                        food.brand,
                        # 換算後的量（g 或 ml），記錄當時就凍結了。不匯出「幾份」：
                        # 份量可以事後改名、改重量、刪掉，那不是歷史。
                        item.quantity_g,
                        revision.base_unit.value,
                        macros.kcal,
                        macros.protein_g,
                        macros.fat_g,
                        macros.carb_g,
                        *tail,
                    )
                )
        yield encode_rows(lines)
        after = (meals[-1].eaten_at, meals[-1].id)
