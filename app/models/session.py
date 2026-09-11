import uuid
from datetime import datetime

from sqlalchemy import BigInteger, CheckConstraint, DateTime, ForeignKey, Identity, Index, text
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RefreshSession(Base):
    """一張 refresh token 對應一列。

    `family_id` 是一次登入衍生出的整條鏈：登入開一個新 family，之後每次輪替
    都在同一個 family 裡長出下一列。撤銷的單位是 family 而不是單一列 ——
    攻擊者手上那張票換出來的後續票也必須一起死。

    `used_at` 與 `revoked_at` 刻意分開，不合併成一個 status 欄位：
    「已經被拿去換過」是正常流程的終點，「被撤銷」是安全事件或使用者登出。
    合併之後就再也分不出「這條鏈正常輪替到底」與「這條鏈被判定外洩」。

    這裡只存 `jti`，不存 token 字串本身 —— token 進資料庫等於把一份可直接
    使用的憑證留在備份裡，而 jti 已經足夠做撤銷判斷。
    """

    __tablename__ = "refresh_sessions"
    __table_args__ = (
        # **核心不變量：一個 family 最多只有一張活票。**
        # 鏈分岔就是這張表要防的那個 bug。Task 4 的條件式 UPDATE 保證了它，
        # 但那是程式碼 —— WHERE 被改弱、或有人沒先作廢前一張就簽發，
        # 鏈會**安靜地**分岔。這個部分唯一索引讓資料庫也保證一次，
        # 真的發生時是一個大聲的 IntegrityError，不是兩張沒人發現的活票。
        Index(
            "uq_refresh_sessions_one_live_per_family",
            "family_id",
            unique=True,
            postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"),
        ),
        # 撤銷整個 family 時走這個索引。
        Index("ix_refresh_sessions_family_id", "family_id"),
        # logout-all：撈某個使用者所有還沒撤銷的列。user_id 當前導欄位同時也
        # 服務 ON DELETE CASCADE —— PostgreSQL 不會自動幫外鍵來源欄位建索引。
        Index("ix_refresh_sessions_user_id_revoked_at", "user_id", "revoked_at"),
        # Task 4 刻意不在換發時檢查 expires_at（理由見 app/security/sessions.py
        # 的 rotate_session），所以一個亂掉的 expires_at 不會在任何地方報錯 ——
        # 使用者只會莫名其妙被登出。由資料庫擋住它。
        # 注意：CheckConstraint 的 name= 是命名慣例的**輸入**不是最終名稱，
        # 最終會是 ck_refresh_sessions_expires_after_issued（陷阱表第 1 條）。
        CheckConstraint("expires_at > issued_at", name="expires_after_issued"),
    )
    # expires_at 刻意**不**建索引：唯一的消費者是每天跑一次的 cleanup-sessions，
    # 而那是會掃掉表中數 % 列的 bulk DELETE，規劃器本來就會選 seq scan。
    # 這張表是整個 app 寫入率最高的（每台活躍裝置每天約 100 列），
    # 不為一個量不到的節省在最熱的寫入路徑上多維護一棵 btree。等量到再加。

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # unique=True 會依 NAMING_CONVENTION 產生 uq_refresh_sessions_jti ——
    # 手寫的 migration 必須用一模一樣的名字，否則 alembic check 紅。
    jti: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), unique=True, nullable=False)
    family_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    issued_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    # 只給 cleanup-sessions 用。**過期判斷本身由 JWT 的 exp 負責**，這個欄位
    # 刻意不參與換發時的條件判斷 —— 理由寫在 app/security/sessions.py 的
    # rotate_session 裡：兩個地方都擋的話，突變掉任一個都不會有測試變紅。
    #
    # 這四個時間戳（issued_at / expires_at / used_at / revoked_at）都由
    # **應用程式的時鐘**寫入，不像這個 schema 其他表用 server_default=func.now()。
    # 這是刻意的：issued_at 與 expires_at 必須來自同一個 now，TTL 才精確。
    # 因此拿它們做比較時也一律用 datetime.now(UTC)，不要用 SQL 的 now() ——
    # 混用的話，容器時鐘與 PostgreSQL 時鐘一旦漂移，session 會提早或延後
    # 過期，而且沒有任何東西指得出原因。
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
