import enum
from datetime import datetime
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    Enum,
    ForeignKey,
    Identity,
    Index,
    Numeric,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class ExpenseCategory(enum.StrEnum):
    """寫死的分類清單（規格 §3.2）。

    **不做成使用者自訂是刻意的。** 這個專案已經連續兩次踩到同一個坑：
    食物與補劑都是「後端蓋好了，但前端沒有任何地方可以新增」。分類如果
    做成使用者自訂，那會是第三次——而且更糟，因為「沒有分類可選」會讓
    記帳從第一天就不能用。

    **這份清單是猜的，一定會錯**（規格 §3.4）。改它是一行 enum + 一個
    只改 CheckConstraint 的 migration，既有資料不動。
    """

    FOOD = "food"
    TRANSPORT = "transport"
    DAILY = "daily"
    ENTERTAINMENT = "entertainment"
    MEDICAL = "medical"
    HOUSING = "housing"
    OTHER = "other"


class Expense(Base):
    """一筆花費。餐費透過 `meal_id` 掛在餐點上，但不依附於它。"""

    __tablename__ = "expenses"
    __table_args__ = (
        # native_enum=False + create_constraint=False + 這裡手寫一個一般的
        # CheckConstraint —— 跟 meal.py 的 MealType、ai_analysis.py 的
        # AnalysisKind 同一套，**不是** food.py / user.py 那種原生 PG enum。
        #
        # 兩個理由：
        # 1. handover §7：create_constraint=True 產生的是 type-bound CHECK，
        #    alembic 的比對器把它排除在 model 那一側，但 reflection 讀回來的
        #    是普通 CHECK ——兩側永遠對不上，alembic check 每次報漂移。
        # 2. **更直接**：這張表預期會改分類（規格 §3.4）。原生 PG enum 加值
        #    要 ALTER TYPE ... ADD VALUE，而那個語句不能在交易區塊內執行，
        #    alembic migration 預設就跑在交易裡。
        #
        # 也因此：**只寫 create_constraint=False 卻忘了手寫這個 CheckConstraint，
        # 等於完全沒有約束** ——資料庫會收任何字串，而所有靜態檢查與既有測試
        # 都是綠的，因為沒有一條會去 INSERT 非法值。
        CheckConstraint(
            "category IN ('food', 'transport', 'daily', 'entertainment',"
            " 'medical', 'housing', 'other')",
            name="category_valid",
        ),
        # 不收 0 也不收負數。負數等於退款/收入，那是範圍外（規格 §2.4、§8）。
        #
        # 這個約束是「範圍外」在資料庫層的具體表現：將來要做退款時它會擋住你，
        # 逼你回來重新想，而不是讓一筆負數安靜地混進月報表。
        CheckConstraint("amount > 0", name="amount_positive"),
        # 月報表唯一會用到的索引：
        # WHERE user_id = ? AND spent_at >= ? AND spent_at < ?
        #
        # 順序是 (user_id, spent_at) 不是反過來——篩選力來自 user_id，跟
        # ai_analyses 的 (user_id, created_at) 同一個理由：反過來的話，
        # 全部使用者的列都散在同一段時間範圍裡，前導欄位篩不掉任何列。
        Index("ix_expenses_user_id_spent_at", "user_id", "spent_at"),
        # 一餐最多一筆餐費（安全補強規格 §3.2）：部分唯一索引，手動記的帳
        # （meal_id 是 null）不受限制。同時服務 ON DELETE SET NULL 的查找。
        Index(
            "uq_expenses_meal_id",
            "meal_id",
            unique=True,
            postgresql_where=text("meal_id IS NOT NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    # **ON DELETE SET NULL，不是 CASCADE。** 你刪掉一筆記錯的餐點，
    # 那筆錢還是花了（規格 §2.3）。CASCADE 會讓月結算少一筆，
    # 而且不會有任何地方告訴你少了。
    meal_id: Mapped[int | None] = mapped_column(
        BigInteger, ForeignKey("meals.id", ondelete="SET NULL")
    )
    category: Mapped[ExpenseCategory] = mapped_column(
        Enum(
            ExpenseCategory,
            name="expense_category",
            native_enum=False,
            create_constraint=False,
            # **length 一定要明寫。** 不給的話 SQLAlchemy 用「目前最長的值」
            # 當長度——現在是 VARCHAR(13)（"entertainment"）。那會讓這個
            # model 的「改分類很便宜」變成謊話：加一個 14 字元的分類
            # （例如 "transportation"）而忘了一起 ALTER COLUMN TYPE，
            # 症狀是 insert 時 StringDataRightTruncation → 500，
            # 而且只有那一個新分類會爆（最終審查發現）。
            # 32 是留給未來分類的餘裕，規格 §3.4 明說這份清單預期會改。
            length=32,
            values_callable=lambda e: [m.value for m in e],
        ),
        nullable=False,
    )
    # numeric(10,2)，絕不用 float。錢跟營養素同一條規則，但更嚴格：
    # 0.1 + 0.2 != 0.3 在營養素上是四捨五入的小問題，在錢上是對不起來的帳。
    amount: Mapped[Decimal] = mapped_column(Numeric(10, 2), nullable=False)
    # timestamptz 不是 date：「這筆算哪個月」必須走使用者時區，由後端決定
    # （P1 陷阱 1）。存 date 的話時區資訊在寫入當下就永久遺失。
    spent_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    note: Mapped[str | None] = mapped_column(Text)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
