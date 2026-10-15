"""`app/nutrition_units.py`：kJ → kcal、每份 → 每 100（掃條碼規格 §6.3、§8.3）。純函式。"""

from decimal import Decimal

import pytest

from app.nutrition_units import kj_to_kcal, per_100_from_serving, round_cents, to_decimal


@pytest.mark.parametrize(
    ("kj", "kcal"),
    [("1000", "239.01"), ("2151", "514.10"), ("180", "43.02"), ("0", "0.00"), ("4.184", "1.00")],
)
def test_kj_to_kcal(kj, kcal):
    assert kj_to_kcal(Decimal(kj)) == Decimal(kcal)


@pytest.mark.parametrize(
    ("value", "size", "per100"),
    [
        ("180", "35", "514.29"),  # 規格 §8.3
        ("2.1", "35", "6.00"),
        ("9.8", "35", "28.00"),
        ("21.3", "35", "60.86"),
        ("1", "3", "33.33"),
        ("2", "3", "66.67"),  # half-up
        ("0.005", "100", "0.01"),  # 0.005 → half-up 進位，不是銀行家捨入的 0.00
    ],
)
def test_per_100_from_serving(value, size, per100):
    assert per_100_from_serving(Decimal(value), Decimal(size)) == Decimal(per100)


def test_round_cents_drops_the_negative_zero():
    assert str(round_cents(Decimal("-0.004"))) == "0.00"


@pytest.mark.parametrize(
    ("value", "expected"),
    [(12, "12"), (1.1, "1.1"), ("3.5", "3.5"), (" 7 ", "7"), (Decimal("2"), "2")],
)
def test_to_decimal_accepts_finite_numbers(value, expected):
    assert to_decimal(value) == Decimal(expected)


@pytest.mark.parametrize("value", [True, None, "abc", "", "1,5", "NaN", "Infinity", [], {}])
def test_to_decimal_rejects_everything_else(value):
    assert to_decimal(value) is None
