"""`parse_raw_estimate()` 是 app/ai/estimator.py 裡唯一不需要打網路就能測的部分。

Task 4 計畫寫「這個 task 不獨立測（真實作要打網路），由 Task 5 的假實作間接
驗證」——那句話說的是 AnthropicEstimator 本身（打真的 Anthropic API）。
但 LLM 回傳的 JSON 怎麼被驗證、缺欄位/負數/超出範圍/不是 JSON 怎麼被擋下來，
是一個純函式，不需要網路就測得到，而且正是規格 §8.2 那條保證真正落地的地方。
"""

import json
from decimal import Decimal

import pytest

from app.ai.estimator import (
    MAX_MEAL_ITEMS,
    RawEstimate,
    RawMealEstimate,
    parse_raw_estimate,
    parse_raw_meal_estimate,
)
from app.errors import BadGatewayError

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


def test_name_over_100_chars_is_rejected():
    """`FoodCreateRequest` 的 name 上限是 100——AI 給更長的，「確認」會 422。"""
    raw_text = _VALID_JSON.replace('"name": "滷肉飯"', '"name": "' + "飯" * 101 + '"')

    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_brand_over_100_chars_is_rejected():
    raw_text = _VALID_JSON.replace('"brand": null', '"brand": "' + "牌" * 101 + '"')

    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_name_of_exactly_100_chars_is_accepted():
    raw_text = _VALID_JSON.replace('"name": "滷肉飯"', '"name": "' + "飯" * 100 + '"')

    assert len(parse_raw_estimate(raw_text).name) == 100


def test_not_json_is_rejected():
    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate("這不是 JSON，只是模型跑題說的一段話。")

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_json_array_at_top_level_is_rejected():
    """規格 §9：這一版只回一樣食物，不回陣列。模型如果不聽話回了陣列，也要擋下來。"""
    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate("[" + _VALID_JSON + "]")

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_missing_field_is_rejected():
    raw_text = _VALID_JSON.replace('"serving_grams": 250,', "")

    with pytest.raises(BadGatewayError) as exc_info:
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

    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_serving_grams_zero_is_rejected():
    """serving_grams 是換算每 100g 的除數，0 會讓後續換算除以零。"""
    raw_text = _VALID_JSON.replace('"serving_grams": 250,', '"serving_grams": 0,')

    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_confidence_above_one_is_rejected():
    raw_text = _VALID_JSON.replace('"confidence": 0.7', '"confidence": 1.5')

    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_absurdly_large_serving_grams_is_rejected():
    """「生理上不可能的值」防呆，跟 app/schemas/food.py 的 NutritionInput 同一種風格。"""
    raw_text = _VALID_JSON.replace('"serving_grams": 250,', '"serving_grams": 999999,')

    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate(raw_text)

    assert exc_info.value.code == "AI_BAD_RESPONSE"


def test_bad_response_maps_to_502_not_422():
    """**AI_BAD_RESPONSE 必須是 502，不是 422。**

    422 的意思是「**你**送的東西有問題」。LLM 回了不能解析的 JSON 時，
    使用者送的請求完全沒問題 —— 回 422 等於把上游的失敗算在使用者頭上，
    而使用者會去改一個沒有錯的輸入。

    P2 計畫一 Task 4 的指示原本寫 `UnprocessableEntityError`（422），
    而規格 §4.1 與 Task 5 的驗收條件都寫 502。計畫自己內部矛盾，規格是對的。

    **只斷言例外類別不夠** —— 那只證明「拋的是我們選的那個類別」，
    沒有證明那個類別真的對應到 502。這裡直接讀 `status_code`。
    """
    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_estimate("這不是 JSON")

    assert exc_info.value.status_code == 502
    assert exc_info.value.code == "AI_BAD_RESPONSE"


# ---------------------------------------------------------------------------
# parse_raw_meal_estimate()：一餐多樣（AI 多樣估算規格 §5.1）
# ---------------------------------------------------------------------------


def _item(**overrides: object) -> dict[str, object]:
    item: dict[str, object] = {
        "name": "白飯",
        "brand": None,
        "serving_grams": 200,
        "serving_kcal": 280,
        "serving_protein_g": 5,
        "serving_fat_g": 0.5,
        "serving_carb_g": 62,
        "confidence": 0.8,
    }
    item.update(overrides)
    return item


def _meal_json(*items: dict[str, object], description: object = "一碗白飯、滷雞腿一隻") -> str:
    return json.dumps({"description": description, "items": list(items)}, ensure_ascii=False)


def _rejected(text: str) -> BadGatewayError:
    with pytest.raises(BadGatewayError) as exc_info:
        parse_raw_meal_estimate(text)
    assert exc_info.value.code == "AI_BAD_RESPONSE"
    return exc_info.value


def test_parses_a_meal_with_several_items():
    leg = _item(name="滷雞腿", brand="阿嬤的店", serving_grams=150, serving_kcal=300)

    result = parse_raw_meal_estimate(_meal_json(_item(), leg))

    assert isinstance(result, RawMealEstimate)
    assert result.description == "一碗白飯、滷雞腿一隻"
    # 順序是模型給的順序。
    assert [(item.name, item.brand) for item in result.items] == [
        ("白飯", None),
        ("滷雞腿", "阿嬤的店"),
    ]
    assert result.items[1] == RawEstimate(
        name="滷雞腿",
        brand="阿嬤的店",
        serving_grams=Decimal("150"),
        serving_kcal=Decimal("300"),
        serving_protein_g=Decimal("5"),
        serving_fat_g=Decimal("0.5"),
        serving_carb_g=Decimal("62"),
        confidence=Decimal("0.8"),
        raw=leg,
    )


def test_each_item_keeps_its_own_original_dict_and_the_meal_keeps_the_whole_reply():
    """`raw` 是模型原本說的（規格 §5.1）：清理、型別轉換之前的那一份。"""
    dirty = _item(name="白\n飯")

    result = parse_raw_meal_estimate(_meal_json(dirty, _item(name="湯")))

    assert result.items[0].name == "白 飯"
    assert result.items[0].raw == dirty
    assert result.items[1].raw["name"] == "湯"
    assert result.raw == {"description": "一碗白飯、滷雞腿一隻", "items": [dirty, _item(name="湯")]}


def test_a_meal_of_exactly_the_maximum_number_of_items_is_accepted():
    # 寫死 8，不是讀常數（第 10 種：拿它自己比自己）。下一行確認常數就是 8。
    items = [_item(name=f"菜{index}") for index in range(8)]

    assert len(parse_raw_meal_estimate(_meal_json(*items)).items) == 8
    assert MAX_MEAL_ITEMS == 8


def test_a_meal_of_9_items_is_rejected():
    _rejected(_meal_json(*[_item(name=f"菜{index}") for index in range(9)]))


def test_a_meal_with_no_items_is_rejected():
    """模型看不出任何食物時回空陣列（提示詞這樣要求）——跟單樣流程認不出食物時
    一樣是 AI_BAD_RESPONSE（規格 D9）。"""
    _rejected(_meal_json())


@pytest.mark.parametrize(
    "broken",
    [{"serving_kcal": -1}, {"serving_grams": 0}, {"confidence": 2}, {"name": "x" * 101}],
    ids=["negative-kcal", "zero-grams", "confidence-above-one", "name-too-long"],
)
def test_one_bad_item_rejects_the_whole_meal(broken: dict[str, object]):
    """第二樣壞掉：不是「留下好的那一樣」——使用者會以為那就是全部（規格 D9）。"""
    _rejected(_meal_json(_item(), _item(**broken)))


def test_item_names_are_cleaned_to_a_single_line():
    result = parse_raw_meal_estimate(_meal_json(_item(name="  白\n飯\x00\u202e（大）  ")))

    assert result.items[0].name == "白 飯 （大）"


def test_an_item_name_that_is_only_control_characters_is_rejected():
    _rejected(_meal_json(_item(name="\n\x00\t")))


def test_a_blank_brand_becomes_none_and_a_dirty_one_is_cleaned():
    result = parse_raw_meal_estimate(
        _meal_json(_item(brand=" \n"), _item(name="茶", brand="茶\x00裏王"))
    )

    assert [item.brand for item in result.items] == [None, "茶 裏王"]


def test_the_description_is_cleaned_and_cut_at_500_characters():
    result = parse_raw_meal_estimate(
        _meal_json(_item(), description="第一行\n第二行\x00" + "長" * 600)
    )

    assert result.description.startswith("第一行 第二行 長")
    assert len(result.description) == 500


def test_a_description_cut_right_after_a_space_has_no_trailing_space():
    """截斷的位置剛好落在空白後面：留下的那個空白要去掉——存進 `meals.description`
    時會再清一次（去頭尾），那時前端預填的字跟存下來的字就差一個字元。"""
    result = parse_raw_meal_estimate(
        _meal_json(_item(), description="長" * 499 + " 後面被截掉的字")
    )

    assert result.description == "長" * 499


def test_a_blank_description_falls_back_to_the_item_names():
    result = parse_raw_meal_estimate(
        _meal_json(_item(), _item(name="滷雞腿"), description=" \n ")
    )

    assert result.description == "白飯、滷雞腿"


def test_the_fallback_description_is_also_cut_at_500_characters():
    """8 樣、每樣名稱 100 字：以「、」相連是 807 字，超過 `meals.description` 的上限。
    前端拿它預填描述——不截斷的話，那一餐一按「記錄」就是 422。"""
    items = [_item(name=f"{index}" + "菜" * 99) for index in range(8)]

    result = parse_raw_meal_estimate(_meal_json(*items, description=""))

    assert len(result.description) == 500
    assert result.description.startswith("0" + "菜" * 99 + "、1")


@pytest.mark.parametrize(
    "text",
    [
        "這不是 JSON",
        json.dumps([{"description": "x", "items": []}]),
        json.dumps({"items": [_item()]}),
        json.dumps({"description": None, "items": [_item()]}),
        json.dumps({"description": "x", "items": "白飯"}),
        # 單樣估算的形狀：沒有 items。
        json.dumps(_item()),
    ],
    ids=[
        "not-json",
        "top-level-array",
        "no-description",
        "null-description",
        "items-not-a-list",
        "single-estimate-shape",
    ],
)
def test_malformed_meal_replies_are_rejected(text: str):
    _rejected(text)


def test_a_bad_meal_reply_is_502():
    assert _rejected("這不是 JSON").status_code == 502
