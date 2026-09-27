import enum
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    Boolean,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Text,
    func,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class AnalysisKind(enum.StrEnum):
    TEXT = "text"
    IMAGE = "image"


class AiAnalysis(Base):
    """每一次真的呼叫 LLM 就寫一列 —— 成功與失敗都寫。

    **它同時是每日額度的計數器。** 規格 §7.2：額度直接數這張表今天的列數，
    不另設計數器 —— 計數器與實際紀錄不可能對不上，因為它們是同一份資料。

    既有的 `app/ratelimit.py` 是記憶體計數、重啟歸零（handover §8.2）。
    對「防濫用」可接受，對**花錢**不行：每次部署、每次 NAS 重開都會把上限
    清掉，而這個 app 的部署頻率不低。

    `input_hash` 是拿來觀察重複率的，**不是拿來還原輸入**（規格 §6：
    圖片送去辨識完就丟）。
    """

    __tablename__ = "ai_analyses"
    __table_args__ = (
        # kind 只能是 'text' / 'image'。
        #
        # native_enum=False + create_constraint=False + 這裡手寫一個一般的
        # CheckConstraint —— 跟 app/models/meal.py 的 MealType（meal_type_valid）
        # 同一個作法，不是 app/models/user.py / app/models/food.py 那種原生
        # PostgreSQL enum 型別（UserRole / RevisionStatus / BaseUnit）。
        #
        # 理由（handover §7）：create_constraint=True 產生的 CHECK 是
        #「type-bound」，alembic 的 check-constraint 比對器會把它排除在
        # 「model 這一側」之外，但套用到 DB 之後 reflection 讀回來的是一個
        # 普通 CHECK，並不知道自己是 type-bound——兩側從此永遠對不上，
        # alembic check 每次都報「偵測到被移除的 check constraint」，這個
        # 漂移永遠收斂不了（meal_type 已經踩過一次，原始碼裡的註解是實測記錄）。
        #
        # 也因此：**只寫 create_constraint=False 卻忘了在這裡手寫
        # CheckConstraint，等於完全沒有約束**——資料庫會允許任何字串，
        # 而所有靜態檢查與既有測試都是綠的，因為它們都不會去 INSERT
        # 一個非法值。
        CheckConstraint("kind IN ('text', 'image')", name="kind_valid"),
        # 額度查詢是 WHERE user_id = ? AND created_at >= ?（規格 §7.2）。
        #
        # 順序刻意是 (user_id, created_at) 不是反過來 —— 篩選力來自
        # user_id：這個查詢一次只鎖一個使用者的列，created_at 只是在那個
        # 使用者的列裡再篩一次「今天」。反過來的話 created_at 排在前面，
        # 但全部使用者的列都散在同一段時間範圍裡，這個前導欄位幾乎篩不掉
        # 任何列；user_id 要到後面才做等值比對，等於整棵樹的前段對這個
        # 查詢沒有鑑別力。（資料量還太小，這次不用實測 EXPLAIN 驗證，
        # 但順序的理由必須寫下來——P3-B 曾經因為只憑規格假設索引「就是為
        # 這個查詢而存在」，結果 EXPLAIN 顯示它根本沒被用到。）
        Index("ix_ai_analyses_user_id_created_at", "user_id", "created_at"),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id"), nullable=False
    )
    kind: Mapped[AnalysisKind] = mapped_column(
        Enum(
            AnalysisKind,
            name="analysis_kind",
            native_enum=False,
            create_constraint=False,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    model: Mapped[str] = mapped_column(Text, nullable=False)
    input_hash: Mapped[str] = mapped_column(Text, nullable=False)
    succeeded: Mapped[bool] = mapped_column(Boolean, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
