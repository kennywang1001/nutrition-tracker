import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.user import User
from app.password_resets import revoke_live_resets
from app.ratelimit import login_rate_limiter
from app.schemas.auth import TokenResponse, UserResponse
from app.schemas.user import ChangePasswordRequest, UpdateMeRequest
from app.security.password import hash_password, verify_password
from app.security.sessions import revoke_all_for_user, start_session

logger = logging.getLogger(__name__)

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


@router.post("/me/password", response_model=TokenResponse)
async def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """改自己的密碼（帳號設定規格 §3.2）。成功後**所有**裝置的 refresh token 失效，
    這台拿到一組新的——已經發出去的 access token 最多還能用 15 分鐘（handover §8.1）。

    錯誤一律不是 401：前端對 401 會換票並重送一次，錯的密碼會被驗兩次、算兩次失敗。
    """
    # 1. 便宜的檢查先做。目前的密碼稍後會被驗證，所以「新＝目前」等價於兩個字串相同；
    #    兩個字串都是呼叫者自己送的，回這個錯誤不洩漏任何東西。
    if payload.new_password == payload.current_password:
        raise UnprocessableEntityError("PASSWORD_UNCHANGED", "新密碼不能跟目前的密碼一樣")

    # 2. 跟登入共用同一份額度（規格決定 9）：偷到 access token 的人不能多一扇猜密碼的門。
    #    鍵是帳號的 email（小寫，同 LoginRequest 的正規化）。被擋的請求不跑 Argon2。
    limiter_key = user.email.lower()
    login_rate_limiter.check(limiter_key)

    # 3. Argon2 在執行緒池（理由見 auth.login 的註解）。
    if not await run_in_threadpool(verify_password, payload.current_password, user.password_hash):
        login_rate_limiter.record_failure(limiter_key)
        raise UnprocessableEntityError("CURRENT_PASSWORD_INCORRECT", "目前的密碼不正確")
    login_rate_limiter.record_success(limiter_key)

    new_hash = await run_in_threadpool(hash_password, payload.new_password)

    # 4. 同一個交易：新雜湊、撤銷還沒用的重設連結、撤銷所有 refresh session。
    #    revoke_all_for_user 會取 advisory lock 並 **commit**——前兩個寫入在它之前、
    #    都還沒 commit，所以三件事一起進去。
    #
    #    鎖的順序跟 `auth.reset_password` 一樣：`users` 列 → 連結列 → advisory lock
    #    （理由在那邊）。明確 flush，不靠「下一個 execute 會 autoflush」來排這個順序。
    user_id = user.id
    user.password_hash = new_hash
    await db.flush()
    await revoke_live_resets(db, user_id)
    await revoke_all_for_user(db, user_id)

    # 5. **撤銷之後**才開新的：順序反過來，這一條也會被撤銷。
    issued = await start_session(db, user_id)
    logger.info("使用者 %s 修改了密碼，所有其他 session 已撤銷", user_id)
    return TokenResponse(access_token=issued.access_token, refresh_token=issued.refresh_token)
