import uuid

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.db import get_db
from app.errors import ConflictError, UnauthorizedError
from app.models.user import User
from app.ratelimit import login_rate_limiter
from app.schemas.auth import (
    LoginRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.security.password import DUMMY_PASSWORD_HASH, hash_password, verify_password
from app.security.sessions import start_session
from app.security.tokens import (
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
)

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


@router.post("/refresh", response_model=TokenResponse)
async def refresh(payload: RefreshRequest, db: AsyncSession = Depends(get_db)) -> TokenResponse:
    try:
        claims = decode_refresh_token(payload.refresh_token)
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc

    user = await db.get(User, claims.user_id)
    if user is None:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期")

    return TokenResponse(
        access_token=create_access_token(user.id),
        refresh_token=create_refresh_token(user.id, uuid.uuid4()),
    )
