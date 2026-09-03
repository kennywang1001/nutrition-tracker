import re

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserRole

# C0 控制字元 + DEL + C1。顯示用名稱裡不該出現任何一個。
# 其中 \x00 特別重要：它通得過 Pydantic，然後被 PostgreSQL 拒收，
# 變成一個未經認證就能觸發的 500。
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class RegisterRequest(BaseModel):
    email: EmailStr
    # 上限跟 Argon2 無關 —— 實測雜湊耗時與輸入長度無關（8 字元與 100 萬字元都約 70ms），
    # 因為 Argon2 會先把輸入吸收成固定大小再進記憶體硬化階段。
    # 這個上限單純是請求體衛生：限制客戶端能讓伺服器解析與複製多少資料。
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=50)

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("display_name")
    @classmethod
    def _clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("顯示名稱不能只有空白")
        if _CONTROL_CHARACTERS.search(value):
            raise ValueError("顯示名稱不能包含控制字元")
        return value


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


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
