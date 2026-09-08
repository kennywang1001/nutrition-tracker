from typing import Annotated

from pydantic import BaseModel, Field, model_validator

from app.schemas.validators import DisplayName, IanaTimezone


class UpdateMeRequest(BaseModel):
    """`PATCH /api/me` 的請求 —— 超出規格第 7.1 節的新增（見計畫 3 Task 3）。

    範圍嚴格限制在 `display_name` 與 `timezone`：沒有 email、密碼、角色、
    刪除帳號，也沒有 `relationship()`。

    兩個欄位都是 `X | None = None`，其中 `None` 是「這次請求沒帶這個欄位」的哨兵。
    路由層用 `model_dump(exclude_unset=True)` 決定要更新哪些欄位 ——
    不能用 `exclude_none`，兩者只在「client 明確送 null」時行為不同
    （`exclude_unset` 會保留、視為要求設成 null；`exclude_none` 會悄悄丟掉）。

    **但這個哨兵寫法本身開了一個洞，實測踩到過：** Pydantic 在型別層
    分不出「沒帶」和「明確送 null」—— `X | None` 對兩者一律放行。
    而 `exclude_unset` 正確地保留了明確的 null，於是 `None` 一路流到
    `setattr`，撞上資料庫的 NOT NULL，變成已認證使用者就能觸發的 500
    （`asyncpg.NotNullViolationError`）。

    修法不是退回 `exclude_none`（那會把明確的 null 悄悄吞掉，讓
    `{"timezone": null}` 靜默地變成 no-op），而是在這裡明講：
    **這兩個欄位可以不帶，但不接受 null。** 哨兵留給型別，語意由驗證器把關。
    """

    display_name: Annotated[DisplayName, Field(min_length=1, max_length=50)] | None = None
    timezone: IanaTimezone | None = None

    @model_validator(mode="after")
    def _reject_explicit_nulls(self) -> "UpdateMeRequest":
        # model_fields_set 只含「這次請求真的帶了」的欄位，所以沒帶的不會誤判
        nulls = sorted(f for f in self.model_fields_set if getattr(self, f) is None)
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self
