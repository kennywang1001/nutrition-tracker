"""`parse_raw_estimate()` 是 app/ai/estimator.py 裡唯一不需要打網路就能測的部分。

Task 4 計畫寫「這個 task 不獨立測（真實作要打網路），由 Task 5 的假實作間接
驗證」——那句話說的是 AnthropicEstimator 本身（打真的 Anthropic API）。
但 LLM 回傳的 JSON 怎麼被驗證、缺欄位/負數/超出範圍/不是 JSON 怎麼被擋下來，
是一個純函式，不需要網路就測得到，而且正是規格 §8.2 那條保證真正落地的地方。
"""

from decimal import Decimal

import pytest

from app.ai.estimator import RawEstimate, parse_raw_estimate
from app.errors import UnprocessableEntityError

_VALID_JSON = """
{
  "name": "滷肉飯",
  "brand": null,
  "serving_grams": 250,
  "serving_kcal": 480,
  "serving_protein_g": 14,
  "serving_fat_g": 18,
  "serving_carb_g": 62,
  "confidence": 0.7
}
"""


def test_parses_a_well_formed_response():
    result = parse_raw_estimate(_VALID_JSON)

    assert result == RawEstimate(
        name="滷肉飯",
        brand=None,
        serving_grams=Decimal("250"),
        serving_kcal=Decimal("480"),
        serving_protein_g=Decimal("14"),
        serving_fat_g=Decimal("18"),
        serving_carb_g=Decimal("62"),
        confidence=Decimal("0.7"),
        raw={
            "name": "滷肉飯",
            "brand": None,
            "serving_grams": 250,
            "serving_kcal": 480,
            "serving_protein_g": 14,
            "serving_fat_g": 18,
            "serving_carb_g": 62,
            "confidence": 0.7,
        },
    )


def test_raw_field_is_the_original_json_not_the_validated_object():
    """規格 §5：`raw` 要能回答「AI 常常錯很多嗎」，所以它必須是 LLM 原始說的話。

    這裡刻意送一個 serving_grams 是字串 "250"（LLM 有時候會把數字包成字串）
    而不是數字 250 —— `raw["serving_grams"]` 應該還是那個字串，不是 pydantic
    驗證後轉換出來的 Decimal。
    """
    raw_text = _VALID_JSON.replace('"serving_grams": 250', '"serving_grams": "250"')

    result = parse_raw_estimate(raw_text)

    assert result.raw["serving_grams"] == "250"
    assert result.serving_grams == Decimal("250")


def test_brand_can_be_a_string():
    raw_text = _VALID_JSON.replace('"brand": null', '"brand": "麥當勞"')

    result = parse_raw_estimate(raw_text)

    assert result.brand == "麥當勞"


def test_not_json_is_rejected():
    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate("這不是 JSON，只是模型跑題說的一段話。")

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_json_array_at_top_level_is_rejected():
    """規格 §9：這一版只回一樣食物，不回陣列。模型如果不聽話回了陣列，也要擋下來。"""
    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate("[" + _VALID_JSON + "]")

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_missing_field_is_rejected():
    raw_text = _VALID_JSON.replace('"serving_grams": 250,', "")

    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


@pytest.mark.parametrize(
    "broken_field",
    [
        '"serving_kcal": -10',
        '"serving_protein_g": -1',
        '"serving_fat_g": -1',
        '"serving_carb_g": -1',
        '"confidence": -0.1',
    ],
)
def test_negative_values_are_rejected(broken_field: str):
    field_name = broken_field.split(":")[0]
    original = next(
        line.strip().rstrip(",")
        for line in _VALID_JSON.splitlines()
        if line.strip().startswith(field_name)
    )
    raw_text = _VALID_JSON.replace(original, broken_field)

    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_serving_grams_zero_is_rejected():
    """serving_grams 是換算每 100g 的除數，0 會讓後續換算除以零。"""
    raw_text = _VALID_JSON.replace('"serving_grams": 250,', '"serving_grams": 0,')

    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_confidence_above_one_is_rejected():
    raw_text = _VALID_JSON.replace('"confidence": 0.7', '"confidence": 1.5')

    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_absurdly_large_serving_grams_is_rejected():
    """「生理上不可能的值」防呆，跟 app/schemas/food.py 的 NutritionInput 同一種風格。"""
    raw_text = _VALID_JSON.replace('"serving_grams": 250,', '"serving_grams": 999999,')

    with pytest.raises(UnprocessableEntityError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"
