from datetime import datetime

from pydantic import BaseModel, Field

from app.security.password import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH


class PasswordResetCreatedResponse(BaseModel):
    # 明碼只在這個回應出現一次；資料庫只有雜湊（規格 §3.4）。
    token: str
    expires_at: datetime


class PasswordResetStatusRequest(BaseModel):
    # 上限是請求體衛生（真的碼是 43 字），同 InviteStatusRequest。
    token: str = Field(min_length=1, max_length=100)


class PasswordResetStatusResponse(BaseModel):
    valid: bool


class PasswordResetRequest(BaseModel):
    token: str = Field(min_length=1, max_length=100)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)
