import logging

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError, UnauthorizedError
from app.models.user import User
from app.ratelimit import login_rate_limiter
from app.schemas.auth import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.security.password import DUMMY_PASSWORD_HASH, hash_password, verify_password
from app.security.sessions import (
    ReuseDetectedError,
    revoke_all_for_user,
    revoke_session,
    rotate_session,
    start_session,
)
from app.security.tokens import TokenError

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> User:
    existing = await db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了")

    # hash_password 是跟 verify_password 一樣同步、CPU 密集的 Argon2 呼叫，寫在
    # async def 裡一樣會把 event loop 卡住（P4 Task 3 陷阱 1）——用
    # run_in_threadpool 搬進執行緒池，理由跟下面 login 的 verify_password 相同，
    # 見那邊的註解。
    password_hash = await run_in_threadpool(hash_password, payload.password)

    user = User(
        email=payload.email,
        password_hash=password_hash,
        display_name=payload.display_name,
        timezone=payload.timezone,
    )
    db.add(user)
    await db.commit()
    await db.refresh(user)
    return user


@router.post("/login", response_model=TokenResponse)
async def login(payload: LoginRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    # 決定 2：限速用的鍵是「送進來的」email 字串本身，不是「存在的帳號」。
    # 這一步完全在查資料庫之前，所以不存在的 email 跟存在的 email 在這裡走的
    # 是同一段程式碼——如果只對「存在的帳號」限速，攻擊者送 11 次就能問出
    # 這個 email 有沒有註冊過，那是跟計畫 1 的 DUMMY_PASSWORD_HASH 要擋的
    # 時序側通道同一類洩漏。被擋下來的請求直接 429，不會再往下跑 Argon2。
    login_rate_limiter.check(payload.email)

    user = await db.scalar(select(User).where(User.email == payload.email))

    # 帳號不存在時，拿假雜湊跑一次驗證。
    # 不能寫成 `user is None or not verify_password(...)` —— Python 會短路，
    # 帳號不存在的請求根本不會跑 Argon2，回應快 70 毫秒（實測 0.0002ms vs 73.8ms）。
    # 那個時間差就能測出哪些 email 註冊過，而這正是下面「回相同錯誤」要防的事。
    password_hash = user.password_hash if user is not None else DUMMY_PASSWORD_HASH
    # verify_password 是同步、CPU 密集的 Argon2 呼叫。寫在 async def 裡直接呼叫
    # 會讓 event loop 整個被卡住——單一容器對外只有一個 event loop，一次登入
    # 嘗試在跑 Argon2 的那 50 幾毫秒，其他所有 request（包含 /api/health）都
    # 只能排隊（P4 Task 3 陷阱 1，實測 /api/health 在並發登入下最高
    # 1094.66ms）。用 run_in_threadpool（Starlette 提供，FastAPI 本身呼叫
    # 同步 path operation 就是走這個執行緒池）搬到另一個執行緒跑，
    # event loop 才能繼續處理其他 request。
    password_ok = await run_in_threadpool(verify_password, payload.password, password_hash)

    # 帳號不存在與密碼錯誤回相同的錯誤，避免洩漏哪些 email 註冊過
    if user is None or not password_ok:
        # 決定 2：不管帳號存不存在，都用送進來的 email 字串記一次失敗——
        # 這一行在 user is None 與密碼錯誤兩種情況都會跑到，是同一行程式碼，
        # 不是兩個分支各寫一次，行為不可能因為忘記改其中一支而漂移。
        login_rate_limiter.record_failure(payload.email)
        raise UnauthorizedError("INVALID_CREDENTIALS", "email 或密碼不正確")

    # 決定 1：成功登入立刻重置該 email 的計數——不鎖帳號，只延遲。
    login_rate_limiter.record_success(payload.email)

    issued = await start_session(db, user.id)
    return TokenResponse(
        access_token=issued.access_token,
        refresh_token=issued.refresh_token,
    )


# 刻意**不需要** access token，理由只給看程式碼的人看，不對外發佈：
# 使用者要登出的時刻，手上的 access token 很可能已經過期了——那正是他想
# 登出的原因之一。要求 access token 會讓「票過期的裝置反而登不出去」。
# 而呼叫者手上已經有那張 refresh token 了，能做的事遠比登出多——這不是
# 額外開放的權限。
@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: LogoutRequest, db: AsyncSession = Depends(get_db)) -> None:
    """登出這一台裝置：這張 refresh token 所屬的整條鏈立刻失效，不能再換發新票。

    對無效、過期、已經登出過的 token 一律回 204——這個端點本來就是冪等的。
    """
    await revoke_session(db, payload.refresh_token)


@router.post("/logout-all", status_code=status.HTTP_204_NO_CONTENT)
async def logout_all(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> None:
    """登出所有裝置：這個帳號名下每一條 refresh token 鏈立刻失效，不能再換發新票。

    **請注意：已經發出去的 access token 不受影響，最多還能繼續用到它自己的
    到期時間（目前 15 分鐘）。** 這個端點擋得住的是「換新票」，擋不住
    「手上這張還沒過期的票」——如果懷疑帳號被盜用，這 15 分鐘的空窗期
    是目前系統的已知限制，不是這個端點沒做好。
    """
    await revoke_all_for_user(db, user.id)


@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    try:
        issued = await rotate_session(db, payload.refresh_token)
    except ReuseDetectedError as exc:
        # 順序不能反：ReuseDetectedError 是 TokenError 的子類別，這個
        # except 必須排在前面，否則下面那個父類別的 except 會先接走，
        # 這筆日誌永遠不會被記錄。回應內容跟下面完全一樣——攻擊者仍然
        # 分辨不出「我被偵測到了」，這筆 log 只在伺服器端看得到。
        logger.warning(
            "refresh token 重用偵測，已撤銷整個 family（user_id=%s）", exc.user_id
        )
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    return TokenResponse(
        access_token=issued.access_token,
        refresh_token=issued.refresh_token,
    )
