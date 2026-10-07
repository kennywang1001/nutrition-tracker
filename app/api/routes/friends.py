"""好友（好友規格）。

**好友的讀取全部在這個檔案，經過 `app/friend_visibility.py`。** 既有的端點
（`/api/meals`、`/api/expenses`…）一行都不改——它們照舊只回自己的資料
（規格 §1.2：放寬舊規則會讓好友看到生活花費與目標，而既有的 38 條隔離測試
照樣全綠）。`tests/test_friend_meals.py` 的掃描測試守著這件事。
"""

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.db import get_db
from app.friend_codes import format_friend_code, new_friend_code
from app.models.user import User
from app.schemas.friend import FriendCodeResponse

router = APIRouter(prefix="/friends", tags=["friends"])


@router.get("/me/code", response_model=FriendCodeResponse)
async def read_my_code(user: User = Depends(get_current_user)) -> FriendCodeResponse:
    return FriendCodeResponse(code=format_friend_code(user.friend_code))


@router.post("/me/code/reset", response_model=FriendCodeResponse)
async def reset_my_code(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> FriendCodeResponse:
    # 舊碼立刻失效：users 只有這一個欄位，沒有舊碼可查。已經成立的好友關係
    # 與還在等的邀請不受影響（它們存的是使用者 id，不是碼）。
    user.friend_code = new_friend_code()
    await db.commit()
    return FriendCodeResponse(code=format_friend_code(user.friend_code))
