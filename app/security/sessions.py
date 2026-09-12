import uuid
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

from sqlalchemy.ext.asyncio import AsyncSession

from app.config import settings
from app.models.session import RefreshSession
from app.security.tokens import create_access_token, create_refresh_token


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
