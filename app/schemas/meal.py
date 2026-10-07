from datetime import datetime
from decimal import Decimal

from pydantic import AwareDatetime, BaseModel, Field, model_validator

from app.models.meal import MealType

# `eaten_at` 一律要帶時區偏移，naive 的一律 422。
#
# P5 之前這個欄位只決定「這一餐算哪一天」；加了 `cost` 之後它同時決定
# **那筆錢算哪個月**，所以它繼承了 `expenses.spent_at` 的同一個風險
# （見 `app/schemas/expense.py` 檔頭）：naive datetime 會被 asyncpg
# 用執行程序的本機時區解釋，而開發機是 Asia/Taipei、容器沒設 TZ 等於 UTC。
#
# 收緊它不會影響現有前端：`frontend/src/screens/LogMeal.tsx` 送的是
# `new Date().toISOString()`，永遠帶 `Z`。
AwareInstant = AwareDatetime

# PostgreSQL 的 BIGINT 上限，同 app/api/params.py 的 ResourceId ——
# 但這裡是 request body 的欄位，不是路徑參數，ResourceId（Annotated[int, Path(...)]）
# 用不上，所以照抄同樣的邊界值。超過的話 asyncpg 會拋 DataError 變成未處理的 500。
_MAX_BIGINT = 2**63 - 1


class MealItemCreateRequest(BaseModel):
    # 只收 food_id，永遠不收 food_revision_id —— 見計畫陷阱 2：
    # 讓呼叫端指定版本，等於開一條繞過審核流程去讀未審核營養素的路。
    food_id: int = Field(gt=0, le=_MAX_BIGINT)
    quantity: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
    portion_id: int | None = Field(default=None, gt=0, le=_MAX_BIGINT)


class MealItemUpdateRequest(BaseModel):
    """`PATCH /api/meals/{id}/items/{item_id}`（編輯餐點規格 §3.1）：只改
    「吃了多少」。

    **不收 `food_id`**——換食物是刪掉再加一項。`portion_id` 的顯式 null 合法
    （改回直接輸入數量）；`quantity` 是 NOT NULL，顯式 null 擋在這裡
    （跟 `MealUpdateRequest` 同一個坑：不擋會一路流到 asyncpg 變成 500）。

    **換份量（送了 `portion_id`，含 null）時必須一起給 `quantity`**：同一個數字
    在不同份量下意思不一樣——只送 `{"portion_id": null}` 會把「2 份」變成
    2 g，只送 `{"portion_id": X}` 會把「200 g」變成 200 份。
    """

    quantity: Decimal | None = Field(
        default=None, gt=0, le=10000, max_digits=8, decimal_places=2
    )
    portion_id: int | None = Field(default=None, gt=0, le=_MAX_BIGINT)

    @model_validator(mode="after")
    def _reject_explicit_null_quantity(self) -> "MealItemUpdateRequest":
        if "quantity" in self.model_fields_set and self.quantity is None:
            raise ValueError("quantity 可以省略，但不接受 null")
        if "portion_id" in self.model_fields_set and "quantity" not in self.model_fields_set:
            raise ValueError("換份量時要一起給 quantity——同一個數字在不同份量下意思不一樣")
        return self


class MealCreateRequest(BaseModel):
    eaten_at: AwareInstant
    meal_type: MealType
    note: str | None = Field(default=None, max_length=500)
    # 好友規格 §2：預設給好友看。
    is_private: bool = False
    # 允許空清單是刻意的：P2 的流程是先拍照、之後才落項目（見計畫本文）。
    items: list[MealItemCreateRequest] = Field(default_factory=list)
    # 選填的餐費（P5 規格 §4.1）。有值時，POST /api/meals 會在**同一個交易裡**
    # 建一筆 category=food、meal_id 指過來的支出。
    #
    # **不做成兩次 API 呼叫**：那有一個半成功狀態——餐點記起來了、支出沒有，
    # 而使用者完全不會知道。在手機上、網路不穩的情況下這不是理論風險。
    #
    # gt=0 / max_digits / decimal_places 對齊 expenses.amount 的
    # numeric(10,2) 與 ck_expenses_amount_positive。不對齊的話，
    # 超出範圍的值會走到 asyncpg 變成 500 而不是 422。
    cost: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)


class MealUpdateRequest(BaseModel):
    """`PATCH /api/meals/{id}` 的請求（計畫 3 決定 2）：只改餐點本身，
    項目的增刪走另外兩個端點（Task 12），這裡不收 `items`。

    跟 `UpdateMeRequest` 同一種哨兵寫法：四個欄位都是 `X | None = None`，
    `None` 代表「這次請求沒帶這個欄位」，路由層用
    `model_dump(exclude_unset=True)` 決定要更新哪些。

    但跟 `UpdateMeRequest` 不同的是，這裡四個欄位對 NOT NULL 的態度不一樣：
    `eaten_at` 與 `meal_type` 是 NOT NULL，顯式 `null` 必須擋在這裡 ——
    否則會一路流到 `setattr`，撞上 `asyncpg.NotNullViolationError` 變成
    已認證使用者就能觸發的 500（`UpdateMeRequest` 踩過的同一個坑）。
    `note` 是 nullable，`{"note": null}` 是合法輸入、必須放行到底。
    `cost` 也是：`null` 代表刪掉這一餐的餐費。
    """

    eaten_at: AwareInstant | None = None
    meal_type: MealType | None = None
    note: str | None = Field(default=None, max_length=500)
    is_private: bool | None = None
    # 編輯餐點規格 §3.2：不帶＝不動；數字＝改那筆餐費或補一筆；null＝刪掉餐費。
    # null 是合法的（「拿掉金額」），所以不在下面驗證器的 non_nullable 集合裡。
    # 限制同 MealCreateRequest.cost。
    cost: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)

    @model_validator(mode="after")
    def _reject_explicit_nulls_on_non_nullable_fields(self) -> "MealUpdateRequest":
        # note 刻意不在這個集合裡：它在資料庫是 nullable，顯式 null 是
        # 合法的「清空備註」語意，不該被擋下來。
        non_nullable = {"eaten_at", "meal_type", "is_private"}
        nulls = sorted(
            field
            for field in self.model_fields_set
            if field in non_nullable and getattr(self, field) is None
        )
        if nulls:
            raise ValueError(f"這些欄位可以省略，但不接受 null：{', '.join(nulls)}")
        return self


class MealItemResponse(BaseModel):
    id: int
    food_id: int
    # 顯示用：client 不用為了畫面上的食物名稱另外查一次 GET /api/foods/{id}。
    # 建立與讀取兩個端點共用同一個 response schema（計畫 3 Task 8）。
    food_name: str
    portion_id: int | None
    # quantity + portion_id 只用於顯示；quantity_g 才是所有計算的依據，
    # 寫入時（建立或 PATCH 這一項時）就換算好——讀取時不重算，所以份量後來
    # 改了重量，舊的紀錄不跟著變（見計畫陷阱 1）。
    quantity: Decimal
    quantity_g: Decimal
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


class MealResponse(BaseModel):
    id: int
    # 回應刻意維持 `datetime`：這個 bug 是**輸入**的問題，而回應的值來自
    # timestamptz 欄位，本來就一定帶時區。收緊它只會擴大這次改動的範圍。
    eaten_at: datetime
    meal_type: MealType
    note: str | None
    is_private: bool
    # 相對於 photo_dir 的路徑；沒有照片是 None。計畫 3 Task 14：上傳成功後
    # 這個端點自己回的、以及之後 GET /api/meals/{id} 回的都要看得到同一個值。
    photo_path: str | None
    # 這一餐的餐費（`expenses.meal_id` 指過來的那一筆）；沒有就是 None。
    # 編輯餐點規格 §3.3：**每一條回 MealResponse 的路徑都要帶**——
    # 只有建立時有值、讀取時永遠 null 的欄位比沒有這個欄位更糟。
    cost: Decimal | None
    items: list[MealItemResponse]
    # 營養素總計：各項已四捨五入後的和，不是精確總和再四捨五入
    # （見 app/nutrition.py 的 total()）。
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
