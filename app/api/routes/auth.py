import logging

from fastapi import APIRouter, Depends, status
from sqlalchemy import select, update
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import ConflictError, ForbiddenError, UnauthorizedError
from app.invites import INVITE_INVALID_MESSAGE, find_usable_invite, redeem_invite
from app.models.user import User
from app.password_resets import RESET_INVALID_MESSAGE, find_usable_reset, redeem_reset
from app.ratelimit import login_rate_limiter, session_rate_limiter
from app.schemas.auth import (
    LoginRequest,
    LogoutRequest,
    RefreshRequest,
    RegisterRequest,
    TokenResponse,
    UserResponse,
)
from app.schemas.invite import InviteStatusRequest, InviteStatusResponse
from app.schemas.password_reset import (
    PasswordResetRequest,
    PasswordResetStatusRequest,
    PasswordResetStatusResponse,
)
from app.security.password import DUMMY_PASSWORD_HASH, hash_password, verify_password
from app.security.sessions import (
    ReuseDetectedError,
    revoke_all_for_user,
    revoke_session,
    rotate_session,
    start_session,
)
from app.security.tokens import TokenError, decode_refresh_token

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/auth", tags=["auth"])


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=UserResponse)
async def register(payload: RegisterRequest, db: AsyncSession = Depends(get_db)) -> User:
    # 1. 先查邀請，**在 Argon2 之前**：拿亂碼或用過的連結打這個端點，花的只是一次
    #    SHA-256 與一次索引查詢，打不出 70ms 的 CPU（規格 §3.4）。四種失效（不存在、
    #    用過、過期、撤銷）回同一個錯誤——對方能做的事都一樣：要一個新的。
    invite = await find_usable_invite(db, payload.invite_token)
    if invite is None:
        raise ForbiddenError("INVITE_INVALID", INVITE_INVALID_MESSAGE)

    # 2. email 撞名同樣在 Argon2 之前，而且**邀請不被用掉**——改個 email 再送就好。
    existing = await db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了")

    # 3. hash_password 是跟 verify_password 一樣同步、CPU 密集的 Argon2 呼叫，寫在
    #    async def 裡一樣會把 event loop 卡住（P4 Task 3 陷阱 1）——用
    #    run_in_threadpool 搬進執行緒池，理由跟下面 login 的 verify_password 相同，
    #    見那邊的註解。
    password_hash = await run_in_threadpool(hash_password, payload.password)

    # 4. 建立使用者與兌換邀請在同一個交易：兌換落空（被別人搶先、或剛被撤銷）
    #    就整個 rollback，不會留下一個沒有邀請的帳號。
    user = User(
        email=payload.email,
        password_hash=password_hash,
        display_name=payload.display_name,
        timezone=payload.timezone,
    )
    db.add(user)
    try:
        await db.flush()
    except IntegrityError:
        # 兩個請求同時用同一個 email：步驟 2 都沒看到對方。
        await db.rollback()
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了") from None

    if not await redeem_invite(db, invite.id, user.id):
        await db.rollback()
        raise ForbiddenError("INVITE_INVALID", INVITE_INVALID_MESSAGE)

    await db.commit()
    await db.refresh(user)
    return user


@router.post("/invite-status", response_model=InviteStatusResponse)
async def invite_status(
    payload: InviteStatusRequest, db: AsyncSession = Depends(get_db)
) -> InviteStatusResponse:
    """註冊畫面一打開就先問（規格 §4.1），失效的連結不用填完表單才知道。
    邀請碼放在 body，不放網址——不進存取紀錄。"""
    return InviteStatusResponse(valid=await find_usable_invite(db, payload.token) is not None)


@router.post("/password-reset-status", response_model=PasswordResetStatusResponse)
async def password_reset_status(
    payload: PasswordResetStatusRequest, db: AsyncSession = Depends(get_db)
) -> PasswordResetStatusResponse:
    """重設密碼頁一打開就先問（帳號設定規格 §3.5），同 invite-status。
    碼放在 body，不放網址——不進存取紀錄。不限速：一次 SHA-256 加一次索引查詢。"""
    return PasswordResetStatusResponse(
        valid=await find_usable_reset(db, payload.token) is not None
    )


@router.post("/password-reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(payload: PasswordResetRequest, db: AsyncSession = Depends(get_db)) -> None:
    """用管理員產生的一次性連結設新密碼（帳號設定規格 §3.6）。不自動登入。"""
    # 1. 先查連結，**在 Argon2 之前**（同 register 查邀請）：亂碼或用過的連結只花一次
    #    SHA-256 與一次索引查詢。四種失效同一個錯誤——對方能做的事都一樣：要一個新的。
    reset = await find_usable_reset(db, payload.token)
    if reset is None:
        raise ForbiddenError("RESET_LINK_INVALID", RESET_INVALID_MESSAGE)
    reset_id = reset.id

    password_hash = await run_in_threadpool(hash_password, payload.new_password)

    # 2. 同一個交易：兌換（條件式 UPDATE）→ 新雜湊 → 撤銷所有 session。
    #    revoke_all_for_user 取 advisory lock 之後**自己 commit**——它的 commit 就是這個
    #    交易的 commit；前兩個寫入都還沒 commit，所以三件事一起進去或一起不進去
    #    （test_a_failure_after_redeeming_rolls_back_the_password_and_the_link）。
    #    不要在中間加 commit。
    user_id = await redeem_reset(db, reset_id)
    if user_id is None:
        # 查的時候還能用、兌換時已經被別人用掉或撤銷（兩個請求同時用同一條連結）。
        await db.rollback()
        raise ForbiddenError("RESET_LINK_INVALID", RESET_INVALID_MESSAGE)
    email = await db.scalar(
        update(User)
        .where(User.id == user_id)
        .values(password_hash=password_hash)
        .returning(User.email)
    )
    await revoke_all_for_user(db, user_id)

    # 3. 之前猜錯被限速的人，不用再等一分鐘才能用新密碼登入。鍵要跟 login 的一樣
    #    （LoginRequest 正規化成小寫；change_password 也用 email.lower()）。
    if email is not None:
        login_rate_limiter.record_success(email.lower())
    # 稽核：只寫 id（規格 §6）——不寫碼、不寫密碼、不寫 email。
    logger.info("使用者 %s 用重設連結重設了密碼（reset_id=%s）", user_id, reset_id)


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

    對無效、過期、已經登出過的 token 回 204——這個端點本來就是冪等的。**例外是 429**：
    簽章對的票（包括早就撤銷的）同一張一分鐘內超過 `SESSION_LIMIT` 次，回
    `429 TOO_MANY_SESSION_REQUESTS`；簽章不對的票不計數，永遠是 204。

    **先驗簽、再限速、最後才碰資料庫**（安全補強規格 §3.1）：簽章不對的票不計數
    （驗簽不碰資料庫、不取鎖，本來就便宜）；簽章對的票每張（鍵是它的 `jti`）每分鐘
    最多 `SESSION_LIMIT` 次走到 `revoke_session` 的 advisory lock。為什麼鍵是 `jti`
    不是 `sub`，見 `app/ratelimit.py` 的 `session_rate_limiter`。
    """
    try:
        claims = decode_refresh_token(payload.refresh_token)
    except TokenError:
        return
    session_rate_limiter.hit(str(claims.jti))
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
    # 先驗簽取 jti、再限速，最後才進 rotate_session 的資料庫與 advisory lock
    # （安全補強規格 §3.1；同 logout）。簽章不對 → 跟原本一樣的 401，不計數。
    # 鍵是這張票自己的 jti、不是 sub：舊票被重放只燒掉那張票的額度，正常輪替每次
    # 都拿新的 jti、不會被擋（理由見 app/ratelimit.py 的 session_rate_limiter）。
    try:
        claims = decode_refresh_token(payload.refresh_token)
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc
    session_rate_limiter.hit(str(claims.jti))

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
