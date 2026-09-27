"""營養素一致性檢查 —— 純函式，不碰網路也不碰資料庫。

## 為什麼這不是一個 LLM agent

P1 規格 §11 把驗證設計成 pipeline 第 ④ 步的 LLM agent，並說那是
「這個作品集最有價值的部分：展示『我知道 LLM 會胡說，所以我設計了驗證層』」。

**但它要檢查的是算術。** 用 LLM 檢查算術，等於用一個會胡說的東西檢查另一個
會胡說的東西 —— 而且貴、慢、不可重現、測試只能 mock 它。

改成純函式之後：確定性、零成本、測得密、突變得了。**而規格想展示的那句話
在這個版本反而更成立 —— 因為驗證層本身不會胡說。**
"""

from dataclasses import dataclass
from decimal import Decimal

# Atwater 係數。蛋白質與碳水 4 kcal/g、脂肪 9 kcal/g。
_KCAL_PER_G_PROTEIN = Decimal(4)
_KCAL_PER_G_CARB = Decimal(4)
_KCAL_PER_G_FAT = Decimal(9)

# 相對門檻刻意寬鬆：Atwater 是近似值，酒精（7 kcal/g）與膳食纖維都會讓它偏。
# 太嚴會讓每一筆都被標記，而每一筆都被標記等於沒有標記。
_RELATIVE_THRESHOLD = Decimal("0.25")
# 絕對下限：低熱量食物的小小絕對差會變成很大的百分比（5 vs 8 大卡是 60%），
# 但 3 大卡沒有意義。少了這一條，每一樣青菜都會被標記。
_ABSOLUTE_FLOOR_KCAL = Decimal(20)

_CENTS = Decimal("0.01")


@dataclass(frozen=True)
class Consistency:
    atwater_kcal: Decimal
    deviation: Decimal
    flagged: bool


def check_consistency(
    *, kcal: Decimal, protein_g: Decimal, fat_g: Decimal, carb_g: Decimal
) -> Consistency:
    """宣稱的熱量跟三大營養素算出來的熱量差多少。

    `flagged` 為 True **不代表數字是錯的**，只代表「這組數字值得看一眼」。
    規格 §2.2：標記不擋人 —— AI 可能是對的而係數是近似的，硬擋會讓使用者
    記不了東西。
    """
    atwater = (
        protein_g * _KCAL_PER_G_PROTEIN
        + carb_g * _KCAL_PER_G_CARB
        + fat_g * _KCAL_PER_G_FAT
    ).quantize(_CENTS)
    deviation = abs(kcal - atwater).quantize(_CENTS)
    threshold = max(kcal * _RELATIVE_THRESHOLD, _ABSOLUTE_FLOOR_KCAL)

    return Consistency(
        atwater_kcal=atwater, deviation=deviation, flagged=deviation > threshold
    )
