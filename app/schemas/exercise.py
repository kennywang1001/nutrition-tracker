"""運動紀錄的請求與回應（運動規格 §6）。"""

from datetime import date
from decimal import Decimal
from typing import Literal

from pydantic import BaseModel

from app.exercise import ActivityCode


class ActivityResponse(BaseModel):
    code: ActivityCode
    label: str
    # 「其他」是 null：沒有 MET，只能手動輸入熱量。
    met: Decimal | None


class EstimateReady(BaseModel):
    """預覽（D11：跟 `EstimateMissing` 是普通聯集，不加 discriminator——同身體資料 D10）。
    `weight_kg`、`weight_date` 是估算用的那一筆體重：運動那一天（使用者時區）或之前最新的。"""

    ready: Literal[True]
    kcal: Decimal
    met: Decimal
    weight_kg: Decimal
    weight_date: date


class EstimateMissing(BaseModel):
    """運動那一天以前沒有任何體重：表單改成手動輸入（D8）。"""

    ready: Literal[False]
    missing: Literal["weight"]
