from datetime import date
from decimal import Decimal

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    Date,
    ForeignKey,
    Identity,
    Index,
    Numeric,
    Text,
    text,
)
from sqlalchemy.dialects.postgresql import ExcludeConstraint
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserTarget(Base):
    __tablename__ = "user_targets"
    __table_args__ = (
        # 規格第 6.5 節 + 陷阱 3：四個營養素欄位皆可為 NULL —— 允許使用者只設
        # 熱量目標、不設三大營養素。CHECK 必須是 "X IS NULL OR X >= 0"，不能只
        # 寫 "X >= 0"（NULL >= 0 求值為 NULL，CHECK 對 NULL 也會通過，所以兩種
        # 寫法在「允許 NULL」這件事上其實等價——但 IS NULL OR 把這個意圖寫明，
        # 不用依賴 SQL 三值邏輯的隱含行為）。
        CheckConstraint("kcal IS NULL OR kcal >= 0", name="kcal_non_negative"),
        CheckConstraint(
            "protein_g IS NULL OR protein_g >= 0", name="protein_non_negative"
        ),
        CheckConstraint("fat_g IS NULL OR fat_g >= 0", name="fat_non_negative"),
        CheckConstraint("carb_g IS NULL OR carb_g >= 0", name="carb_non_negative"),
        CheckConstraint(
            "effective_to IS NULL OR effective_to > effective_from",
            name="effective_range",
        ),
        # 決定 1：跟計畫 4a 的 supplement_plans 同構 —— 同一個使用者的目標期間
        # 不能重疊。已實測（計畫 4a）：字串欄位名 + text() 運算式的組合編譯出
        # 正確的 DDL。命名慣例不會替 ExcludeConstraint 加前綴（app/models/base.py
        # 的 NAMING_CONVENTION 沒有 "ex" 這個 key），所以 ex_ 前綴自己寫進 name=。
        #
        # 這裡的鍵只有 (user_id, daterange) 兩項，不像 supplement_plans 還有
        # time_of_day —— 同一個人在同一天只能有一組目標，沒有「早晚各一」這個軸。
        ExcludeConstraint(
            ("user_id", "="),
            (text("daterange(effective_from, effective_to, '[)')"), "&&"),
            name="ex_user_targets_no_overlap",
            using="gist",
        ),
        Index(
            "ix_user_targets_user_id_effective",
            "user_id",
            "effective_from",
            "effective_to",
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    kcal: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    protein_g: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    fat_g: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    carb_g: Mapped[Decimal | None] = mapped_column(Numeric(8, 2))
    # '減脂期'、'增肌期' 之類的使用者自訂標籤，純顯示用。
    label: Mapped[str | None] = mapped_column(Text)
    effective_from: Mapped[date] = mapped_column(Date, nullable=False)
    effective_to: Mapped[date | None] = mapped_column(Date)
