from typing import Annotated

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserRole
from app.schemas.validators import DisplayName, IanaTimezone


class RegisterRequest(BaseModel):
    email: EmailStr
    # 上限跟 Argon2 無關 —— 實測雜湊耗時與輸入長度無關（8 字元與 100 萬字元都約 70ms），
    # 因為 Argon2 會先把輸入吸收成固定大小再進記憶體硬化階段。
    # 這個上限單純是請求體衛生：限制客戶端能讓伺服器解析與複製多少資料。
    password: str = Field(min_length=8, max_length=128)
    # 控制字元檢查與 IANA 時區檢查抽在 app/schemas/validators.py，
    # PATCH /api/me（計畫 3 Task 3）重用同一套邏輯，不重寫。
    display_name: Annotated[DisplayName, Field(min_length=1, max_length=50)]
    timezone: IanaTimezone = "Asia/Taipei"

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    display_name: str
    role: UserRole
    # 加入時區：PATCH /api/me（計畫 3 Task 3）讓時區可以改，若 response 不回傳，
    # 使用者沒有任何方式讀回自己剛設定的值。GET /api/me 也一併補上，兩個端點
    # 用同一個 response model，答案本該一致。
    timezone: str


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
