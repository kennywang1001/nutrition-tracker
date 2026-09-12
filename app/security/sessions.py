import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NoReturn

from sqlalchemy import BigInteger, cast, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import RefreshSession
from app.security.tokens import (
    RefreshClaims,
    TokenError,
    create_access_token,
    create_refresh_token,
    decode_refresh_token,
)


@dataclass(frozen=True)
class IssuedTokens:
    access_token: str
    refresh_token: str


def _issue(db: AsyncSession, *, user_id: int, family_id: uuid.UUID) -> IssuedTokens:
    """寫一列，並簽出對應那一列的一組票。

    **寫列與簽票刻意綁在同一個函式裡，`jti` 不外流。** 拆成
    「`_add_row` 回傳 jti」+「`_tokens_for(jti)`」的話，呼叫端就有可能
    把兩者配錯 —— 而那個 bug 的後果是資料列與票上的 jti 不一致，
    每一次換發都 401（突變 11 已驗證這一類的破壞力）。綁在一起之後，
    配錯這件事在結構上不可表達。

    不在這裡 commit：呼叫端可能還要在同一個交易裡做別的事（Task 4 的輪替
    就是先 UPDATE 舊列再呼叫這裡），交易邊界交給呼叫端決定。
    """
    jti = uuid.uuid4()
    now = datetime.now(UTC)
    db.add(
        RefreshSession(
            user_id=user_id,
            jti=jti,
            family_id=family_id,
            issued_at=now,
            # 這個值只給 cleanup-sessions 用；過期判斷本身由 JWT 的 exp 負責。
            #
            # 它跟 token 的 exp 不是同一個時刻算出來的，實測差距約 150 毫秒
            # （主因是 JWT 的 exp 是整數秒的 NumericDate，PyJWT 會截斷；
            # 其次是兩次 datetime.now() 之間隔著一次資料庫往返）。
            # 截斷通常讓資料列比票晚過期（安全的方向），但**方向不保證** ——
            # 往返時間超過截斷餘數時會反過來。在 14 天的尾巴上差幾百毫秒，
            # 後果可以忽略，但不要以為這兩個值相等。
            expires_at=now + timedelta(days=settings.refresh_token_ttl_days),
        )
    )
    return IssuedTokens(
        access_token=create_access_token(user_id),
        refresh_token=create_refresh_token(user_id, jti),
    )


async def start_session(db: AsyncSession, user_id: int) -> IssuedTokens:
    """登入：開一條全新的 family。

    每次登入都是獨立的一條鏈，所以在手機上登出不會動到桌機 —— 那是規格 §1
    整個要解決的問題（今天唯一的止血手段是換 JWT_SECRET，會把所有人一起登出）。

    **這個模組自己管交易，不把 commit 留給路由** —— 這違反了這個 codebase
    其他地方的慣例（交易邊界一律在 `app/api/routes/` 裡），所以理由寫在這裡：

    Task 4 的重用偵測必須**先把整個 family 的撤銷寫進資料庫、再拋例外**。
    例外一拋，路由層就不會 commit 了，撤銷會跟著被 rollback —— 結果是
    「回了 401、但票其實還活著」的靜默失效。既然那條路徑非自己 commit 不可，
    整個模組就統一自己管，不要一半一半。

    **代價：呼叫端不可以在呼叫這裡之前留下不相關的待寫入資料**，
    那些東西會被這裡的 commit 一起帶進去。今天的 `login()` 在這之前
    只有一次 SELECT，沒有寫入。
    """
    issued = _issue(db, user_id=user_id, family_id=uuid.uuid4())
    await db.commit()
    return issued


class ReuseDetectedError(TokenError):
    """一張已經被換發過的 refresh token 又被拿來使用。

    繼承 TokenError，所以路由層只要接 TokenError 就同時涵蓋兩者 ——
    對呼叫端來說回應完全一樣（401 INVALID_TOKEN），**刻意不讓攻擊者
    從回應分辨出「我被偵測到了」**。分成兩個類別是為了讓伺服器端的日誌
    能區分「票過期了」與「有人在重放」——`user_id` 是這筆日誌要用的，
    不是給呼叫端看的，路由層絕對不能把它放進回應內容。
    """

    def __init__(self, message: str, *, user_id: int) -> None:
        super().__init__(message)
        self.user_id = user_id


async def _lock_user_sessions(db: AsyncSession, user_id: int) -> None:
    """把「同一個使用者的 session 變更」序列化。

    **為什麼需要（實測發現，不是理論）：** `_revoke_family` 是一個 bulk
    UPDATE，在 READ COMMITTED 下它的快照固定在 statement 開始的那一刻。
    同時間另一個交易 INSERT 進來的新列**完全不在它的視野裡** ——
    EvalPlanQual 只會重新檢查被鎖住的既有列，不會看見新插入的列。

    後果：攻擊者同時送出「已用過的 A」與「還活著的 B」，A 觸發重用偵測、
    撤銷整個 family，但 B 那條交易剛插入的 C 沒被撤銷到 —— 系統回報
    「已撤銷」、使用者被登出，而攻擊者手上握著一張活票。
    **60 次並行試驗重現 59 次**，這是主流結果不是罕見競態。

    **鎖的粒度是使用者而不是 family：** logout-all 一次要處理多個 family，
    用 family 當鍵的話它跟輪替不會互斥，同一個洞會從登出那條路再開一次。
    使用者層級讓輪替、登出、全部登出三條路徑共用同一個鍵空間。

    `user_id` 直接當鍵，不需要額外查詢 —— 它來自已驗簽的 JWT。
    代價可以忽略：一台裝置每 15 分鐘才換發一次票。

    這個 codebase 目前沒有其他地方用 advisory lock，所以不需要命名空間；
    日後若有，要改用有命名空間的雙參數形式。

    **必須明確 cast 成 BigInteger。** `pg_advisory_xact_lock` 有 int4 與
    int8 兩個重載，SQLAlchemy 對 Python `int` 預設綁成 `INTEGER`（int4）。
    `users.id` 是 `BigInteger`，今天 id 從 1 開始、都是個位數所以測不出來，
    但 id 一旦超過 2³¹，不 cast 就會在這裡直接撞 `NumericValueOutOfRange`
    ——而且撞到的不只是登出，換發、登入全部共用這個函式，會一起壞掉。
    """
    await db.execute(select(func.pg_advisory_xact_lock(cast(user_id, BigInteger))))


async def _revoke_family(db: AsyncSession, family_id: uuid.UUID) -> None:
    await db.execute(
        update(RefreshSession)
        .where(
            RefreshSession.family_id == family_id,
            RefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )


async def _reject(db: AsyncSession, claims: RefreshClaims) -> NoReturn:
    """搶不到那一列，判斷是哪一種失敗。"""
    row = await db.scalar(select(RefreshSession).where(RefreshSession.jti == claims.jti))

    if row is not None and row.revoked_at is None and row.used_at is not None:
        # 這張票已經被換發過了。兩種可能：(a) 攻擊者拿到舊票，
        # (b) 合法 client 因網路重試送了兩次。**伺服器無法區分這兩者**，
        # 而猜錯的代價不對稱 —— 把重試誤判為外洩的代價是使用者重新登入一次；
        # 把外洩誤判為重試的代價是攻擊者得到一條永久有效的鏈。所以一律撤銷。
        #
        # 這個決定把一個約束推給前端：同一時間只能有一個 refresh 在飛
        # （P3-A 規格 §6.4 的 single-flight 鎖）。後端刻意不做寬限期，
        # 寬限期會直接稀釋這個偵測的鑑別力。
        await _revoke_family(db, row.family_id)
        # 必須在拋例外前 commit：例外一拋，路由層就不會 commit 了。
        await db.commit()
        raise ReuseDetectedError("refresh token 被重複使用", user_id=claims.user_id)

    raise TokenError("token 無效或已過期")


async def rotate_session(db: AsyncSession, refresh_token: str) -> IssuedTokens:
    """換發：舊票當場失效，新票長在同一條 family 上。"""
    # **呼叫前不可以在 session 上留著沒 commit 的 RefreshSession。**
    # SQLAlchemy 的 autoflush 會讓下面那個 db.execute() 先把待寫入的 INSERT
    # 送出去，順序就反過來 —— 新列在舊列被標 used_at 之前就進了部分唯一索引，
    # 直接撞 uq_refresh_sessions_one_live_per_family。目前所有呼叫路徑都安全
    # （get_db 是 per-request，start_session / rotate_session 都自己 commit），
    # 但下一個寫這張表的人不會知道，所以寫在這裡。
    claims = decode_refresh_token(refresh_token)

    # **必須在條件式 UPDATE 之前取得。** 見 _lock_user_sessions 的說明 ——
    # 少了這一行，重用偵測在並行下有 59/60 的機率留下一張活票。
    await _lock_user_sessions(db, claims.user_id)

    # 條件式 UPDATE ... RETURNING，不是「先 SELECT 判斷再 UPDATE」：
    # 兩個並行的換發請求都會通過 SELECT 的檢查，然後兩個都發出新票，
    # 而且誰都不會被判定成重用。把條件寫進 UPDATE 的 WHERE，
    # 由資料庫保證只有一個搶得到那一列。
    claimed = (
        await db.execute(
            update(RefreshSession)
            .where(
                RefreshSession.jti == claims.jti,
                RefreshSession.used_at.is_(None),
                RefreshSession.revoked_at.is_(None),
            )
            .values(used_at=datetime.now(UTC))
            .returning(RefreshSession.user_id, RefreshSession.family_id)
        )
    ).one_or_none()

    # 這裡刻意**不**檢查 expires_at —— 過期由 decode_refresh_token 的
    # JWT exp 負責，而且已經有測試釘住（test_expired_refresh_token_is_rejected）。
    # 兩個地方都擋的話，突變掉任何一個都不會有測試變紅，兩道防線互相掩護
    # （§6 第 5 種）。expires_at 欄位只服務 cleanup-sessions。
    if claimed is None:
        # _reject 的回傳型別是 NoReturn，mypy 據此知道這一行之後 claimed
        # 一定不是 None。若你的 mypy 版本沒有做這個收窄，把下一行改成
        # `user_id, family_id = claimed  # type: ignore[misc]` 之前，
        # 先確認 _reject 的簽章真的寫了 `-> NoReturn`。
        await _reject(db, claims)

    user_id, family_id = claimed
    issued = _issue(db, user_id=user_id, family_id=family_id)
    await db.commit()
    return issued


async def revoke_session(db: AsyncSession, refresh_token: str) -> None:
    """登出單一裝置：撤銷這張票所屬的整條 family。

    **這裡也要先取 `_lock_user_sessions`**（規格 §3.2）：`_revoke_family`
    是 bulk UPDATE，在 READ COMMITTED 下快照固定在 statement 開始那一刻，
    並行交易剛 INSERT 的列完全不在它的視野裡 —— 所以「登出的同時另一個
    分頁正在輪替」會留下一張活票，跟重用偵測那個洞是同一個，只是從登出
    這條路進來。鎖的粒度是使用者，讓輪替、登出、全部登出三條路徑互斥。

    **先 SELECT 拿到那一列、再取鎖，順序不能反。** 呼叫這個函式不需要
    通過身分驗證，只需要一張簽章有效的 refresh token——如果先取鎖，
    任何一張簽章有效但列已經被清掉的 token（過期太久被 Task 6 的
    cleanup 清掉、或使用者本尊早就登出過）都能讓沒有通過任何驗證的
    呼叫者，拿到那個使用者的 advisory lock。反過來先 SELECT：鎖只在
    真的找到列、真的要撤銷時才取，而且用**列上的** `user_id`（資料庫
    裡的事實），不是 token 聲稱的那個。這同時也修掉了另一個問題——
    原本 `row is None` 的提早 return 會在已經取到鎖之後才發生，
    離開時沒有 commit 也沒有 rollback，鎖只能等交易結束才釋放；
    先 SELECT 的話那個分支根本還沒碰過鎖。

    `family_id` 不會因為輪替而改變，所以先取到的值在拿鎖前後仍然有效；
    列在這段空窗期被刪除，代表對應的 family 早就因為使用者被刪除而
    整條消失，撤銷一個不存在的 family 是安全的空操作。

    **一律靜默成功。** 無效、過期、偽造、已經撤銷過的 token 都不回錯誤 ——
    回錯誤等於提供一個「這張票還活著嗎」的探針，而登出本來就是冪等的。
    """
    try:
        claims = decode_refresh_token(refresh_token)
    except TokenError:
        return

    row = await db.scalar(select(RefreshSession).where(RefreshSession.jti == claims.jti))
    if row is None:
        return

    await _lock_user_sessions(db, row.user_id)

    await _revoke_family(db, row.family_id)
    await db.commit()


async def revoke_all_for_user(db: AsyncSession, user_id: int) -> None:
    """登出所有裝置。`user_id` 來自已驗證的 access token，不是使用者輸入。

    同樣要先取 `_lock_user_sessions`。這也正是鎖的粒度選使用者而不是 family
    的原因：這個函式一次要處理多個 family，用 family 當鍵它跟輪替不會互斥。
    """
    await _lock_user_sessions(db, user_id)

    await db.execute(
        update(RefreshSession)
        .where(
            RefreshSession.user_id == user_id,
            RefreshSession.revoked_at.is_(None),
        )
        .values(revoked_at=datetime.now(UTC))
    )
    await db.commit()
