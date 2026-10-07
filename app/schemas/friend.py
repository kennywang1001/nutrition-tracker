from datetime import datetime
from typing import Literal

from pydantic import BaseModel, Field


class FriendCodeResponse(BaseModel):
    code: str


class FriendRequestCreate(BaseModel):
    code: str = Field(min_length=1, max_length=32)


class PersonResponse(BaseModel):
    """好友看到的身分：只有 id 與名字，**沒有 email**（規格 §2）。"""

    id: int
    display_name: str


class FriendRequestResult(BaseModel):
    status: Literal["pending", "accepted"]
    person: PersonResponse


class FriendRequestItem(BaseModel):
    id: int
    person: PersonResponse
    created_at: datetime


class FriendRequestsResponse(BaseModel):
    incoming: list[FriendRequestItem]
    outgoing: list[FriendRequestItem]


class FriendResponse(BaseModel):
    id: int
    display_name: str
    since: datetime
