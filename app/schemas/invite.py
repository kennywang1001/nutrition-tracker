from datetime import datetime
from typing import Annotated, Literal

from pydantic import BaseModel, Field

from app.schemas.validators import DisplayName


class InviteCreateRequest(BaseModel):
    # 備註沿用顯示名稱的檢查（去頭尾空白、擋控制字元）：同樣是給人看的短字串，
    # 同樣會原樣顯示在管理員的畫面上。NUL 會讓 PostgreSQL 拒收、變成 500。
    note: Annotated[DisplayName, Field(min_length=1, max_length=50)] | None = None


class InviteCreatedResponse(BaseModel):
    id: int
    token: str
    note: str | None
    expires_at: datetime


class InviteUser(BaseModel):
    display_name: str
    email: str


class InviteListItem(BaseModel):
    id: int
    note: str | None
    status: Literal["pending", "used"]
    created_at: datetime
    expires_at: datetime
    used_at: datetime | None
    used_by: InviteUser | None


class InviteStatusRequest(BaseModel):
    token: str = Field(min_length=1, max_length=100)


class InviteStatusResponse(BaseModel):
    valid: bool
