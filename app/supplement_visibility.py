"""補劑可見性判斷：全域的，或自己的。

比照 `app/food_visibility.py`：`owner_id IS NULL` 是全域，否則私人於該
owner。Task 5（建立計畫時驗證引用的補劑看得到）與 Task 8（打卡時驗證
引用的補劑看得到）都需要同一套「看不到就 404」邏輯 —— 寫成共用模組，
不要塞進各自的路由檔裡各複製一份，否則日後修一個安全性 bug 只會修到一邊。
"""

from sqlalchemy import or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.errors import NotFoundError
from app.models.supplement import Supplement
from app.models.user import User


async def assert_supplement_visible(
    db: AsyncSession, supplement_id: int, user: User
) -> Supplement:
    """取出使用者看得到的補劑：全域的，或自己的。看不到的一律 404。"""
    supplement = await db.scalar(
        select(Supplement).where(
            Supplement.id == supplement_id,
            or_(Supplement.owner_id.is_(None), Supplement.owner_id == user.id),
        )
    )
    if supplement is None:
        raise NotFoundError("SUPPLEMENT_NOT_FOUND", "找不到該補劑")
    return supplement
