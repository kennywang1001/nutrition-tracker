"""營養素換算：每 100g / 100ml 為基準的 revision，換算成實際吃下的份量。

`BASE_AMOUNT` 是整個系統裡「分母是 100」這件事唯一出現的地方（計畫 3 陷阱 3）。
散在各處的話，之後做統計很容易漏改一處，而且症狀是數字有點怪，不會炸。

注意：`quantity_g` 對 `base_unit == 'ml'` 的食物（飲料）裝的其實是毫升，
命名是個已知的瑕疵，但數學完全一樣，`scale()` 不需要知道單位是什麼。
"""

from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal

from app.models.food import FoodRevision

BASE_AMOUNT = Decimal(100)
_CENTS = Decimal("0.01")


@dataclass(frozen=True)
class Macros:
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal

    def __add__(self, other: "Macros") -> "Macros":
        return Macros(
            kcal=self.kcal + other.kcal,
            protein_g=self.protein_g + other.protein_g,
            fat_g=self.fat_g + other.fat_g,
            carb_g=self.carb_g + other.carb_g,
        )

    @classmethod
    def zero(cls) -> "Macros":
        return cls(
            kcal=Decimal("0.00"),
            protein_g=Decimal("0.00"),
            fat_g=Decimal("0.00"),
            carb_g=Decimal("0.00"),
        )


def _round(value: Decimal) -> Decimal:
    return value.quantize(_CENTS, rounding=ROUND_HALF_UP)


def scale(revision: FoodRevision, quantity_g: Decimal) -> Macros:
    """依 revision 每 100 單位的營養素，換算成 quantity_g 份量的實際數值。

    每個欄位各自四捨五入到分（小數點後兩位）。加總多個項目時要用
    `total()`，把「各項先四捨五入」的結果相加 —— 不是先加總再四捨五入。
    兩者可能差一分，但前者才能保證使用者看到的每一項加起來等於總計。
    """
    factor = quantity_g / BASE_AMOUNT
    return Macros(
        kcal=_round(revision.kcal * factor),
        protein_g=_round(revision.protein_g * factor),
        fat_g=_round(revision.fat_g * factor),
        carb_g=_round(revision.carb_g * factor),
    )


def total(items: list[Macros]) -> Macros:
    """各項（已各自四捨五入）相加的總計 —— 刻意不是精確總和再四捨五入。"""
    result = Macros.zero()
    for item in items:
        result = result + item
    return result
