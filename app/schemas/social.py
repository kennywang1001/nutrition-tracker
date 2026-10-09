"""讚與留言的回應（社群規格 §5）。**沒有 email、沒有作者的 user id**（D9）：
「是不是我」「能不能刪」由伺服器算好。"""

from datetime import datetime
from typing import Annotated

from pydantic import AfterValidator, BaseModel, Field

from app.schemas.friend import FriendMeal
from app.schemas.validators import single_line

COMMENT_MAX_LENGTH = 200


class LikerResponse(BaseModel):
    display_name: str
    is_me: bool


class CommentResponse(BaseModel):
    id: int
    display_name: str
    is_me: bool
    # 我是作者，或我是這一餐的主人。
    can_delete: bool
    body: str
    created_at: datetime


class SocialMealResponse(BaseModel):
    """一餐與它上面的讚、留言。`meal` 是好友看的那個白名單——主人看自己的餐也是
    （沒有餐費與備註；要看那些去編輯畫面）。"""

    meal: FriendMeal
    is_mine: bool
    likes: list[LikerResponse]
    comments: list[CommentResponse]
    comments_truncated: bool


class LikeState(BaseModel):
    """按讚與收回都回這個：過濾後的數字，前端拿它對帳（規格 D19）。"""

    like_count: int
    liked_by_me: bool


def _clean_comment(value: str) -> str:
    """留言是不可信的文字、會顯示給別人：先清成一行，**清完之後**才量長度。"""
    cleaned = single_line(value)
    if not cleaned:
        raise ValueError("留言不能是空的")
    if len(cleaned) > COMMENT_MAX_LENGTH:
        raise ValueError(f"留言最多 {COMMENT_MAX_LENGTH} 個字")
    return cleaned


class CommentCreate(BaseModel):
    # 1000 是清理**之前**的長度（同 MealCreateRequest.description 的寫法）：擋掉超大的 body，
    # 又不會因為貼上的文字多了幾個換行就 422。
    body: Annotated[str, AfterValidator(_clean_comment)] = Field(max_length=1000)
