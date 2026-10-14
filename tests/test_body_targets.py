"""建議目標的公式（身體資料規格 §3）。全部是手算得出來的數字；年齡用固定的今天。"""

from datetime import date
from decimal import Decimal

import pytest

from app.body_targets import BodyInputs, Suggestion, round_half_up, suggest
from app.models.body import ActivityLevel, Goal, Sex

TODAY = date(2026, 10, 14)
D = Decimal


def inputs(**overrides) -> BodyInputs:
    base = {
        "sex": Sex.MALE,
        "birth_year": 1990,
        "height_cm": D(175),
        "activity_level": ActivityLevel.MODERATE,
        "goal": Goal.LOSE,
        "rate_kg_per_week": D("0.5"),
        "weight_kg": D(80),
    }
    return BodyInputs(**{**base, **overrides})


def macros(result: Suggestion | list) -> tuple:
    assert isinstance(result, Suggestion)
    return (result.kcal, result.protein_g, result.fat_g, result.carb_g)


def test_case_a_the_worked_example():
    result = suggest(inputs(), TODAY)

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1719), D(2664), D(-550))
    assert result.floor_applied is False
    assert result.floor_kcal == D(1500)
    assert macros(result) == (D(2110), D(144), D(59), D(251))


def test_case_b_the_floor_applies():
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1960,
            height_cm=D(155),
            weight_kg=D(50),
            activity_level=ActivityLevel.SEDENTARY,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee) == (D(978), D(1173))
    assert result.floor_applied is True
    assert result.floor_kcal == D(1200)
    assert macros(result) == (D(1200), D(90), D(33), D(136))


def test_case_c_gain_adds():
    result = suggest(
        inputs(
            birth_year=2000,
            height_cm=D(180),
            weight_kg=D(70),
            activity_level=ActivityLevel.ACTIVE,
            goal=Goal.GAIN,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1700), D(2933), D(275))
    assert macros(result) == (D(3210), D(140), D(89), D(462))


def test_case_d_maintain_ignores_the_rate():
    """速度是 0.5，但目標是維持：調整是 0。"""
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1985,
            height_cm=D(165),
            weight_kg=D(60),
            activity_level=ActivityLevel.LIGHT,
            goal=Goal.MAINTAIN,
            rate_kg_per_week=D("0.5"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee, result.adjustment_kcal) == (D(1265), D(1740), D(0))
    assert macros(result) == (D(1740), D(96), D(48), D(231))


def test_case_e_carbs_are_clamped_at_zero():
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1926,
            height_cm=D(100),
            weight_kg=D(150),
            activity_level=ActivityLevel.SEDENTARY,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert result.floor_applied is False
    assert macros(result) == (D(1210), D(270), D(34), D(0))


def test_the_floor_is_judged_on_the_raw_value_not_the_rounded_one():
    """原始 1499.2：四捨五入到 10 是 1500、不低於下限；但原始值低於下限——下限有套用（D8）。
    男、40 歲、170 cm、61.1 kg、久坐、減 0.25：BMR 611 + 1062.5 − 200 + 5 = 1478.5；
    TDEE 1774.2；原始 1499.2。"""
    result = suggest(
        inputs(
            birth_year=1986,
            height_cm=D(170),
            weight_kg=D("61.1"),
            activity_level=ActivityLevel.SEDENTARY,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert result.floor_applied is True
    assert result.kcal == D(1500)


def test_a_raw_value_exactly_at_the_floor_does_not_count_as_floored():
    """規格：「原始熱量 < 下限」才算套用下限——剛好等於不算（`<=` 的突變會說有套用）。
    女、39 歲、160 cm、35.6 kg、久坐、維持：BMR 356 + 1000 − 195 − 161 = 1000；TDEE 1200.0。"""
    result = suggest(
        inputs(
            sex=Sex.FEMALE,
            birth_year=1987,
            height_cm=D(160),
            weight_kg=D("35.6"),
            activity_level=ActivityLevel.SEDENTARY,
            goal=Goal.MAINTAIN,
        ),
        TODAY,
    )

    assert isinstance(result, Suggestion)
    assert (result.bmr, result.tdee) == (D(1000), D(1200))
    assert result.floor_applied is False
    # 蛋白質 1.6 × 35.6 = 56.96 → 57；脂肪 300 / 9 = 33.3 → 33；
    # 碳水 (1200 − 228 − 297) / 4 = 168.75 → 169。
    assert macros(result) == (D(1200), D(57), D(33), D(169))


def test_case_f_carbs_use_the_rounded_protein():
    """蛋白質有小數（1.8 × 68.4 = 123.12）：碳水要用四捨五入後的 123 算，四個數字才自洽。
    男、30 歲、172.5 cm、非常高、減 0.25 → 原始 2797.5375 → 2800；
    (2800 − 492 − 702) / 4 = 401.5 → 402（用 123.12 算是 401.38 → 401）。"""
    result = suggest(
        inputs(
            birth_year=1996,
            height_cm=D("172.5"),
            weight_kg=D("68.4"),
            activity_level=ActivityLevel.VERY_ACTIVE,
            rate_kg_per_week=D("0.25"),
        ),
        TODAY,
    )

    assert macros(result) == (D(2800), D(123), D(78), D(402))


def test_age_comes_from_the_year_of_today_that_was_passed_in():
    """同一份資料，今天換成隔年：年齡多一歲，BMR 少 5。"""
    this_year = suggest(inputs(), TODAY)
    next_year = suggest(inputs(), date(2027, 1, 1))

    assert isinstance(this_year, Suggestion) and isinstance(next_year, Suggestion)
    assert this_year.bmr - next_year.bmr == D(5)


@pytest.mark.parametrize(
    ("value", "step", "expected"),
    [
        (D("2105"), D(10), D(2110)),  # 銀行家捨入會給 2100
        (D("400.5"), D(1), D(401)),  # 銀行家捨入會給 400
        (D("58.49"), D(1), D(58)),
        (D("-550"), D(1), D(-550)),
    ],
)
def test_round_half_up(value, step, expected):
    assert round_half_up(value, step) == expected


ALL_MISSING = [
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "weight",
]


def test_everything_missing_is_listed_in_order():
    empty = BodyInputs(None, None, None, None, None, None, None)

    # 目標沒填時速度也算缺：不知道要不要速度，就先要。
    assert suggest(empty, TODAY) == ALL_MISSING


@pytest.mark.parametrize(
    ("field", "name"),
    [
        ("sex", "sex"),
        ("birth_year", "birth_year"),
        ("height_cm", "height_cm"),
        ("activity_level", "activity_level"),
        ("goal", "goal"),
        ("rate_kg_per_week", "rate_kg_per_week"),
        ("weight_kg", "weight"),
    ],
)
def test_each_single_missing_input_is_named(field, name):
    assert suggest(inputs(**{field: None}), TODAY) == [name]


def test_maintain_does_not_need_a_rate():
    result = suggest(inputs(goal=Goal.MAINTAIN, rate_kg_per_week=None), TODAY)

    assert isinstance(result, Suggestion)
    assert result.adjustment_kcal == D(0)
