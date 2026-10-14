"""建議目標的公式（身體資料規格 §3）。純函式：不碰資料庫，「今天」由呼叫端給。

**全程 Decimal、ROUND_HALF_UP。** 浮點的 1.55 × 1718.75 不是 2664.0625；Python 內建的
`round()` 是銀行家捨入（2105 → 2100、400.5 → 400），跟手算、跟使用者的直覺都不一樣。

公式（Mifflin-St Jeor）：
    男 BMR = 10·kg + 6.25·cm − 5·歲 + 5；女 BMR = 10·kg + 6.25·cm − 5·歲 − 161
    TDEE = BMR × 活動係數；熱量 = TDEE ∓ 每週速度 × 7700 / 7
    下限：女 1200、男 1500（看**原始值**，D8）；否則四捨五入到 10
    蛋白質 = g/kg × 目前體重；脂肪 = 熱量 25% / 9；碳水 = 剩下的 / 4，不小於 0
"""

from dataclasses import dataclass
from datetime import date
from decimal import ROUND_HALF_UP, Decimal
from typing import Literal

from app.models.body import ActivityLevel, Goal, Sex

ACTIVITY_FACTORS: dict[ActivityLevel, Decimal] = {
    ActivityLevel.SEDENTARY: Decimal("1.2"),
    ActivityLevel.LIGHT: Decimal("1.375"),
    ActivityLevel.MODERATE: Decimal("1.55"),
    ActivityLevel.ACTIVE: Decimal("1.725"),
    ActivityLevel.VERY_ACTIVE: Decimal("1.9"),
}
PROTEIN_PER_KG: dict[Goal, Decimal] = {
    Goal.LOSE: Decimal("1.8"),
    Goal.MAINTAIN: Decimal("1.6"),
    Goal.GAIN: Decimal("2.0"),
}
KCAL_FLOOR: dict[Sex, Decimal] = {Sex.FEMALE: Decimal(1200), Sex.MALE: Decimal(1500)}
KCAL_PER_KG_BODY_WEIGHT = Decimal(7700)
FAT_SHARE = Decimal("0.25")
# 最新體重跟套用時差這麼多（含）就提示重算（D17）。
RESUGGEST_THRESHOLD_KG = Decimal(1)

MissingInput = Literal[
    "sex", "birth_year", "height_cm", "activity_level", "goal", "rate_kg_per_week", "weight"
]


@dataclass(frozen=True)
class BodyInputs:
    sex: Sex | None
    birth_year: int | None
    height_cm: Decimal | None
    activity_level: ActivityLevel | None
    goal: Goal | None
    rate_kg_per_week: Decimal | None
    weight_kg: Decimal | None


@dataclass(frozen=True)
class Suggestion:
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal
    bmr: Decimal
    tdee: Decimal
    adjustment_kcal: Decimal
    floor_applied: bool
    floor_kcal: Decimal


def round_half_up(value: Decimal, step: Decimal = Decimal(1)) -> Decimal:
    """四捨五入到 `step` 的倍數（`step=10`：2105 → 2110）。"""
    return (value / step).quantize(Decimal(1), rounding=ROUND_HALF_UP) * step


def missing_inputs(inputs: BodyInputs) -> list[MissingInput]:
    """缺什麼（D11 的固定順序）。速度只有減重、增重要；目標還沒填時也算缺。"""
    missing: list[MissingInput] = []
    if inputs.sex is None:
        missing.append("sex")
    if inputs.birth_year is None:
        missing.append("birth_year")
    if inputs.height_cm is None:
        missing.append("height_cm")
    if inputs.activity_level is None:
        missing.append("activity_level")
    if inputs.goal is None:
        missing.append("goal")
    if inputs.goal is not Goal.MAINTAIN and inputs.rate_kg_per_week is None:
        missing.append("rate_kg_per_week")
    if inputs.weight_kg is None:
        missing.append("weight")
    return missing


def suggest(inputs: BodyInputs, today: date) -> Suggestion | list[MissingInput]:
    """完整就回建議，不完整就回缺什麼（D11）。"""
    sex, birth_year, height = inputs.sex, inputs.birth_year, inputs.height_cm
    activity, goal, weight = inputs.activity_level, inputs.goal, inputs.weight_kg
    rate = Decimal(0) if goal is Goal.MAINTAIN else inputs.rate_kg_per_week
    if (
        sex is None
        or birth_year is None
        or height is None
        or activity is None
        or goal is None
        or rate is None
        or weight is None
    ):
        # 跟 missing_inputs 是同一組條件；兩邊漂移由「每一種單獨缺」的測試抓。
        return missing_inputs(inputs)

    age = today.year - birth_year  # D7：只有出生年
    bmr = (
        Decimal(10) * weight
        + Decimal("6.25") * height
        - Decimal(5) * age
        + (Decimal(5) if sex is Sex.MALE else Decimal(-161))
    )
    tdee = bmr * ACTIVITY_FACTORS[activity]
    step = rate * KCAL_PER_KG_BODY_WEIGHT / Decimal(7)
    adjustment = {Goal.LOSE: -step, Goal.MAINTAIN: Decimal(0), Goal.GAIN: step}[goal]
    raw = tdee + adjustment

    floor = KCAL_FLOOR[sex]
    floor_applied = raw < floor  # D8：看原始值
    kcal = floor if floor_applied else round_half_up(raw, Decimal(10))

    protein = round_half_up(PROTEIN_PER_KG[goal] * weight)
    fat = round_half_up(kcal * FAT_SHARE / Decimal(9))
    # 用已經四捨五入的蛋白質與脂肪：四個數字加起來對得上熱量（誤差在四捨五入內）。
    carb = max(Decimal(0), round_half_up((kcal - protein * 4 - fat * 9) / Decimal(4)))

    return Suggestion(
        kcal=kcal,
        protein_g=protein,
        fat_g=fat,
        carb_g=carb,
        bmr=round_half_up(bmr),
        tdee=round_half_up(tdee),
        adjustment_kcal=round_half_up(adjustment),
        floor_applied=floor_applied,
        floor_kcal=floor,
    )
