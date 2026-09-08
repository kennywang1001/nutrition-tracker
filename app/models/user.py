import enum
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Enum, Identity, Text, func
from sqlalchemy.dialects.postgresql import CITEXT
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class UserRole(enum.StrEnum):
    USER = "user"
    ADMIN = "admin"


class User(Base):
    __tablename__ = "users"

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    email: Mapped[str] = mapped_column(CITEXT(), unique=True, nullable=False)
    password_hash: Mapped[str] = mapped_column(Text, nullable=False)
    display_name: Mapped[str] = mapped_column(Text, nullable=False)
    role: Mapped[UserRole] = mapped_column(
        Enum(UserRole, name="user_role", values_callable=lambda e: [m.value for m in e]),
        nullable=False,
        default=UserRole.USER,
    )
    # IANA 時區名稱，決定「一天」的起訖（見計畫 3 決定 1）。用 server_default
    # 而不是 SQLAlchemy 的 default=：既有資料列要能就地補值，直接下 SQL 的
    # insert 也拿得到預設值 —— default= 只在經過 ORM 的 INSERT 才會生效。
    timezone: Mapped[str] = mapped_column(Text, nullable=False, server_default="Asia/Taipei")
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )
