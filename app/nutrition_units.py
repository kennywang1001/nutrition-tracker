"""營養素的單位換算：kJ → kcal、每份 → 每 100。純函式，不碰資料庫。

Open Food Facts 的預填（`app/off.py`）與營養標示的解析（`app/ai/label.py`）共用——兩處對
「只有 kJ」「只有每份」的算法只有這一份。結果一律四捨五入到兩位（half-up），同食物庫的精度。
"""

from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

# 熱化學卡：1 kcal = 4.184 kJ。營養標示與 OFF 用的都是這一個。
KJ_PER_KCAL = Decimal("4.184")
_HUNDRED = Decimal(100)
_CENTS = Decimal("0.01")
# `to_decimal` 收的最大絕對值。kcal 的上限是 10000（kJ 約 41840），1e6 給足餘裕。
MAX_EXTERNAL_NUMBER = Decimal(1_000_000)


def round_cents(value: Decimal) -> Decimal:
    """四捨五入到兩位（half-up）。-0.00 變成 0.00：負號不要一路寫進回應的字串。"""
    rounded = value.quantize(_CENTS, rounding=ROUND_HALF_UP)
    return abs(rounded) if rounded.is_zero() else rounded


def kj_to_kcal(kj: Decimal) -> Decimal:
    """`2151 kJ → 514.10 kcal`。"""
    return round_cents(kj / KJ_PER_KCAL)


def per_100_from_serving(value: Decimal, serving_size: Decimal) -> Decimal:
    """每份的值 → 每 100（g 或 ml）。`serving_size` 必須大於 0（呼叫端驗過）。

    `180 kcal／35 g → 514.29`。先乘再除：`value / serving_size * 100` 會在除的那一步
    先用掉 28 位有效數字的精度，結果一樣、但多一次捨入的機會。
    """
    return round_cents(value * _HUNDRED / serving_size)


def to_decimal(value: object) -> Decimal | None:
    """外部來的數字（JSON 的 int／float／字串）→ 有限、`abs(n) ≤ 1e6` 的 `Decimal`；不是就 None。

    bool 不算（`True` 是 int 的子類別）。float 經過 `str()`：`Decimal(0.1)` 是二進位誤差
    展開的那一長串。

    **上限（審查 I1）**：`quantize(0.01)` 對大約 1e26 以上的值丟 `InvalidOperation`（放不進
    28 位有效數字）。外部資料裡的 `1e40` 以前一路丟到端點、變成 500。營養素的任何一個數字
    （連 kJ）都遠小於 1e6，超過的一定是垃圾——在這裡就當成「不是數字」。
    """
    if isinstance(value, bool) or not isinstance(value, (int, float, str, Decimal)):
        return None
    try:
        number = Decimal(str(value)) if isinstance(value, float) else Decimal(value)
    except InvalidOperation:
        return None
    if not number.is_finite() or abs(number) > MAX_EXTERNAL_NUMBER:
        return None
    return number
