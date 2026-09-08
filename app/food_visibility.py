"""食物可見性判斷：全域的，或自己的。

從 `app/api/routes/foods.py` 抽出來，讓 `app/api/routes/meals.py`（計畫 3
Task 7）能重用同一套邏輯，不重新發明一份 —— 兩處對「看不到」的定義
必須永遠一致，複製一份的話，日後修一個安全性 bug 只會修到一邊。
"""

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.models.food import Food, FoodPortion, FoodRevision
from app.models.user import User


async def assert_food_visible(db: AsyncSession, food_id: int, user: User) -> Food:
    """取出使用者看得到的食物本身：全域的，或自己的。

    跟 `load_visible_food` 的差別只在不 join 目前版本 —— 給不需要營養素的呼叫端用。
    可見性判斷完全來自 WHERE 條件，那個 outer join 對它沒有任何影響。
    """
    food = await db.scalar(
        select(Food).where(
            Food.id == food_id,
            or_(Food.owner_id.is_(None), Food.owner_id == user.id),
        )
    )
    if food is None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")
    return food


async def load_visible_food(
    db: AsyncSession, food_id: int, user: User
) -> tuple[Food, FoodRevision | None]:
    """取出使用者看得到的食物：全域的，或自己的。

    看不到的一律 404 —— 「不存在」與「不屬於你」必須無法區分。
    """
    row = (
        await db.execute(
            select(Food, FoodRevision)
            .outerjoin(FoodRevision, Food.current_revision_id == FoodRevision.id)
            .where(
                Food.id == food_id,
                or_(Food.owner_id.is_(None), Food.owner_id == user.id),
            )
        )
    ).first()
    if row is None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")
    food, revision = row
    return food, revision


async def load_visible_portion(db: AsyncSession, portion_id: int, user: User) -> FoodPortion:
    """取出使用者看得到的份量：全域的，或自己的。

    原本留在 `app/api/routes/meals.py`（計畫 3 Task 7）裡，當時只有一個
    呼叫者，計畫刻意記下「等第二個呼叫者出現再提升到共用模組」（見 Task 7
    實測發現第 4 點）。Task 12 的 `POST /api/meals/{id}/items` 就是那個第二個
    呼叫者：兩處都要驗證「份量看得到」，複製一份的話，日後修一個安全性 bug
    只會修到一邊 —— 跟 `load_visible_food` 抽出來的理由一模一樣。

    份量沒有 revision 那一層，所以跟 `load_visible_food` 不共用同一個函式，
    但共用同一個模組、同一種可見性判斷方式。
    """
    portion = await db.scalar(
        select(FoodPortion).where(
            FoodPortion.id == portion_id,
            or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user.id),
        )
    )
    if portion is None:
        raise NotFoundError("PORTION_NOT_FOUND", "找不到該份量")
    return portion
