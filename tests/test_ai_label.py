"""營養標示的解析（掃條碼規格 §8.2、§8.3）。純函式，不打 API。"""

import json
from decimal import Decimal

import pytest

from app.ai.label import LLMLabelSchema, parse_raw_label
from app.errors import BadGatewayError
from app.models.food import BaseUnit

PER_SERVING = {
    "name": "海苔洋芋片",
    "base_unit": "g",
    "serving_size": 35,
    "servings_per_package": 4,
    "serving_kcal": 180,
    "serving_kj": None,
    "serving_protein_g": 2.1,
    "serving_fat_g": 9.8,
    "serving_carb_g": 21.3,
    "per_100_kcal": None,
    "per_100_kj": None,
    "per_100_protein_g": None,
    "per_100_fat_g": None,
    "per_100_carb_g": None,
    "confidence": 0.8,
}


def reply(**overrides):
    return json.dumps({**PER_SERVING, **overrides})


def test_per_serving_is_converted_in_the_backend():
    """規格 §8.3 算一次的那一張。"""
    label = parse_raw_label(reply())
    assert label.basis == "per_serving"
    assert (label.kcal, label.protein_g, label.fat_g, label.carb_g) == (
        Decimal("514.29"),
        Decimal("6.00"),
        Decimal("28.00"),
        Decimal("60.86"),
    )
    assert (label.serving_size, label.servings_per_package) == (Decimal("35.00"), Decimal("4.00"))
    assert (label.name, label.base_unit) == ("海苔洋芋片", BaseUnit.G)


def test_the_printed_per_100_column_wins():
    label = parse_raw_label(
        reply(per_100_kcal=520, per_100_protein_g=6, per_100_fat_g=28, per_100_carb_g=61)
    )
    assert label.basis == "per_100"
    assert (label.kcal, label.carb_g) == (Decimal("520.00"), Decimal("61.00"))


def test_kilojoules_only():
    label = parse_raw_label(
        reply(
            serving_kcal=None,
            per_100_kj=2151,
            per_100_protein_g=6,
            per_100_fat_g=28,
            per_100_carb_g=60.86,
        )
    )
    assert label.kcal == Decimal("514.10")


def test_kilojoules_in_the_serving_column():
    label = parse_raw_label(reply(serving_kcal=None, serving_kj=753))
    # 753 / 4.184 = 179.97 → 每 100：179.97 × 100 / 35 = 514.20
    assert label.kcal == Decimal("514.20")


def test_ml_labels():
    assert parse_raw_label(reply(base_unit="ml", serving_size=250)).base_unit is BaseUnit.ML


def test_an_incomplete_per_100_column_falls_back_to_per_serving():
    label = parse_raw_label(reply(per_100_kcal=520, per_100_protein_g=6))
    assert label.basis == "per_serving"


@pytest.mark.parametrize(
    "overrides",
    [
        {"serving_size": None},
        {"serving_fat_g": None},
        {"serving_kcal": None},
        {key: None for key in PER_SERVING if key not in ("name", "base_unit", "confidence")},
        {"serving_size": 0.05},  # 換算後熱量 360000 → 超出新增食物的範圍
        {"serving_size": 3.5, "serving_kcal": 900},  # 每 100：25714 kcal
    ],
)
def test_unreadable_labels(overrides):
    with pytest.raises(BadGatewayError) as caught:
        parse_raw_label(reply(**overrides))
    assert caught.value.code == "AI_LABEL_UNREADABLE"
    assert "這一次也算在今天的次數裡" in caught.value.message


@pytest.mark.parametrize(
    "text",
    [
        "not json",
        "[]",
        reply(base_unit="kg"),
        reply(serving_kcal=-1),
        reply(serving_size=0),
        reply(confidence=2),
        reply(serving_protein_g="很多"),
        reply(serving_fat_g=True),
        json.dumps({k: v for k, v in PER_SERVING.items() if k != "per_100_kcal"}),
    ],
)
def test_malformed_replies_are_ai_bad_response(text):
    with pytest.raises(BadGatewayError) as caught:
        parse_raw_label(text)
    assert caught.value.code == "AI_BAD_RESPONSE"


@pytest.mark.parametrize(
    "overrides",
    [
        {"serving_protein_g": 1e40},
        {"serving_protein_g": "1e30"},
        {"per_100_kj": "1e40"},
        {"serving_size": 10**30},
    ],
)
def test_numbers_too_large_to_quantize_are_ai_bad_response(overrides):
    """審查 I1 的同一種輸入在營養標示這條路：`_round_to_cents` 的 quantize 丟 InvalidOperation
    時原樣交回去，由 schema 的上限拒絕——是 502 `AI_BAD_RESPONSE`，不是 500。"""
    with pytest.raises(BadGatewayError) as caught:
        parse_raw_label(reply(**overrides))
    assert caught.value.code == "AI_BAD_RESPONSE"


def test_numbers_are_rounded_before_the_range_checks():
    """I2：三位小數不是垃圾回覆。0.004 捨成 0.00、不是負的。"""
    label = parse_raw_label(reply(serving_fat_g=9.8049, serving_protein_g=-0.004))
    assert label.fat_g == Decimal("28.00")
    assert label.protein_g == Decimal("0.00")


def test_the_name_is_cleaned_truncated_or_dropped():
    long = "洋芋片" + chr(0x200B) + chr(10) + "x" * 200
    assert len(parse_raw_label(reply(name=long)).name) <= 100
    assert chr(0x200B) not in parse_raw_label(reply(name=long)).name
    assert parse_raw_label(reply(name="   ")).name is None


def test_the_raw_reply_is_kept():
    assert parse_raw_label(reply()).raw == PER_SERVING


def test_the_schema_class_has_no_docstring():
    """transform_schema() 會把 docstring 送給模型（handover §7）。"""
    assert LLMLabelSchema.__doc__ is None
