"""運動的公式與活動清單（運動規格 §3、§4）。數字是腳本用同一套 Decimal 運算算過的。"""

from decimal import Decimal

import pytest

from app.exercise import (
    ACTIVITIES,
    ACTIVITY_BY_CODE,
    MAX_KCAL,
    ActivityCode,
    estimate_kcal,
    label_for,
)


@pytest.mark.parametrize(
    ("code", "kg", "minutes", "expected"),
    [
        (ActivityCode.RUNNING, "70", 30, "343"),  # A：規格 §4.1
        (ActivityCode.WALKING, "62.4", 45, "164"),  # B：163.8 進位
        (ActivityCode.YOGA, "58", 61, "147"),  # C：147.41… 捨去、除不盡
        (ActivityCode.BRISK_WALKING, "50", 15, "54"),  # D：53.75
        (ActivityCode.TABLE_TENNIS, "45.5", 3, "9"),  # E：9.1
        (ActivityCode.WALKING, "60", 1, "4"),  # F：3.5
        (ActivityCode.WALKING, "66", 10, "39"),  # G：38.5——HALF_EVEN 會給 38
        (ActivityCode.JUMP_ROPE, "300", 80, "4720"),  # I：5000 以內
        (ActivityCode.WEIGHT_TRAINING_VIGOROUS, "250", 200, "5000"),  # 剛好在上限上
        (ActivityCode.YOGA, "25", 1, "1"),  # 最小：1.04，不會低於 1 kcal 的下限
    ],
)
def test_estimate(code, kg, minutes, expected):
    met = ACTIVITY_BY_CODE[code].met
    assert met is not None
    result = estimate_kcal(met, Decimal(kg), minutes)
    assert result == Decimal(expected)
    assert result == result.to_integral_value()  # 整數（D6）


def test_an_estimate_above_the_ceiling_is_returned_as_is():
    """H：5507——夾不夾、擋不擋是端點的事（D9），公式只算。"""
    met = ACTIVITY_BY_CODE[ActivityCode.JUMP_ROPE].met
    assert met is not None
    assert estimate_kcal(met, Decimal("350"), 80) == Decimal("5507")
    assert Decimal("5000") == MAX_KCAL


def test_every_code_is_listed_once_and_other_is_last():
    assert [a.code for a in ACTIVITIES] == list(ActivityCode)
    assert ACTIVITIES[-1].code is ActivityCode.OTHER


def test_mets_are_decimals_built_from_strings_and_other_has_none():
    for activity in ACTIVITIES:
        if activity.code is ActivityCode.OTHER:
            assert activity.met is None
        else:
            assert isinstance(activity.met, Decimal)
            # Decimal(9.8) 是 9.80000000000000071…：只有用字串建的才剛好是一位小數。
            assert activity.met == activity.met.quantize(Decimal("0.1"))


def test_the_table_matches_the_spec():
    """規格 §3 的表：改 MET 要同時改規格。"""
    expected = {
        "walking": "3.5",
        "brisk_walking": "4.3",
        "jogging": "7.0",
        "running": "9.8",
        "cycling": "7.5",
        "spinning": "8.5",
        "swimming": "6.0",
        "weight_training": "3.5",
        "weight_training_vigorous": "6.0",
        "yoga": "2.5",
        "pilates": "3.0",
        "hiit": "8.0",
        "hiking": "6.0",
        "stair_climbing": "8.8",
        "basketball": "6.5",
        "badminton": "5.5",
        "table_tennis": "4.0",
        "jump_rope": "11.8",
    }
    assert {a.code.value: str(a.met) for a in ACTIVITIES if a.met is not None} == expected


def test_label_for():
    assert label_for(ActivityCode.RUNNING, None) == "跑步（約 10 km/h）"
    assert label_for(ActivityCode.OTHER, "划船") == "划船"
