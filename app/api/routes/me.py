from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.models.user import User
from app.schemas.auth import UserResponse
from app.schemas.user import UpdateMeRequest

router = APIRouter(tags=["me"])


@router.get("/me", response_model=UserResponse)
async def read_me(user: User = Depends(get_current_user)) -> User:
    return user


@router.patch("/me", response_model=UserResponse)
async def update_me(
    payload: UpdateMeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> User:
    """超出規格第 7.1 節的新增（計畫 3 Task 3）：時區設定進去卻改不掉是 bug。

    範圍嚴格限制在 display_name / timezone。沒有路徑參數 —— 這個端點改的
    永遠是 token 解出來的那個使用者，`user` 本身就是 `get_current_user`
    已經驗證過的那一列，這裡不再另外做一次「擁有權」查詢。

    用 exclude_unset 而不是 exclude_none：兩個欄位在資料庫都是 NOT NULL，
    這個區別今天不可見，但這是為了以後加可為 null 的欄位時養成的習慣。
    """
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(user, field, value)

    await db.commit()
    await db.refresh(user)
    return user
