import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import NoReturn

from sqlalchemy import select, update
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
    從回應分辨出「我被偵測到了」**。分成兩個類別純粹是為了讓伺服器端
    的日誌能區分「票過期了」與「有人在重放」。
    """


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
        raise ReuseDetectedError("refresh token 被重複使用")

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
