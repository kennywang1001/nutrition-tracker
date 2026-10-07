from pydantic import BaseModel


class FriendCodeResponse(BaseModel):
    code: str
