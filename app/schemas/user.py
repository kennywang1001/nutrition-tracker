from typing import Annotated

from pydantic import BaseModel, Field

from app.schemas.validators import DisplayName, IanaTimezone


class UpdateMeRequest(BaseModel):
    """`PATCH /api/me` 的請求 —— 超出規格第 7.1 節的新增（見計畫 3 Task 3）。

    範圍嚴格限制在 `display_name` 與 `timezone`：沒有 email、密碼、角色、
    刪除帳號，也沒有 `relationship()`。

    兩個欄位都是 `X | None = None`：`None` 代表「這次請求沒帶這個欄位」，
    路由層用 `model_dump(exclude_unset=True)` 決定要更新哪些欄位 ——
    不能用 `exclude_none`，兩者只在「client 明確送 null」時行為不同
    （`exclude_unset` 會保留、視為要求設成 null；`exclude_none` 會悄悄丟掉）。
    這兩個欄位在資料庫裡都是 NOT NULL，這個區別今天不可見，但這是為了
    日後加上可為 null 的欄位時不要踩到這個習慣養成的坑。
    """

    display_name: Annotated[DisplayName, Field(min_length=1, max_length=50)] | None = None
    timezone: IanaTimezone | None = None
