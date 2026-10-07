from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel, Field

from app.models.meal import MealType


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


class FriendMealItem(BaseModel):
    food_name: str
    quantity_g: Decimal
    kcal: Decimal


class FriendMeal(BaseModel):
    """好友看得到的一餐（規格 §4.3）。**白名單**——不是從 `MealResponse` 刪欄位：
    `MealResponse` 以後多了欄位，這裡不會跟著多。沒有餐費、備註、照片路徑、
    食物與份量的 id。"""

    id: int
    user: PersonResponse
    eaten_at: datetime
    meal_type: MealType
    items: list[FriendMealItem]
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    has_photo: bool


class FriendFeedResponse(BaseModel):
    meals: list[FriendMeal]
    next_cursor: str | None


class FriendDayResponse(BaseModel):
    friend: PersonResponse
    # 叫 day 不叫 date：Pydantic 的欄位名 date 會遮住 datetime.date 型別。
    day: date
    meals: list[FriendMeal]
