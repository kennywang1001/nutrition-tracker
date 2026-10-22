"""營養標示的文字（標示 OCR 規格 §4）。fixture 是真的 OCR 輸出（規格 §6.3），其餘是手寫的小段落。"""

from decimal import Decimal
from pathlib import Path

import pytest

from app.label_text import normalize, parse_label_text
from app.models.food import BaseUnit

FIXTURES = Path(__file__).parent / "fixtures" / "label_text"
D = Decimal


def _values(result):
    return tuple(None if v is None else str(v) for v in result.found.values())


def _summary(result):
    """一行看完：狀態、欄、單位、一份、份數、四個數字（讀不到是 -）。"""
    found = "/".join("-" if v is None else str(v) for v in result.found.values())
    head = "complete" if result.complete else result.reason
    size = result.serving_size or "-"
    servings = result.servings_per_package or "-"
    return f"{head} {result.basis or '-'} {result.base_unit.value} {size} {servings} {found}"


@pytest.mark.parametrize(
    ("name", "expected"),
    [
        ("both_photo", "complete per_100 g 35.00 4.00 514.00/6.00/28.00/60.90"),
        ("both_4000", "complete per_100 g 35.00 - 514.00/6.00/28.00/60.90"),
        ("both_psm4", "missing_fields - g 35.00 4.00 514.00/6.00/-/-"),
        ("serving_photo", "complete per_serving ml 250.00 1.00 54.00/3.20/3.00/3.60"),
        ("serving_photo_unrotated", "columns_unknown - ml 250.00 - -/-/-/-"),
        ("kj_photo", "missing_fields - g 30.00 10.00 -/6.00/28.00/60.90"),
        ("kj_photo_with_eng", "implausible - g 30.00 10.00 -/-/-/-"),
    ],
)
def test_real_ocr_output(name, expected):
    result = parse_label_text((FIXTURES / f"{name}.txt").read_text(encoding="utf-8"))
    assert _summary(result) == expected
    assert result.missing == tuple(k for k, v in result.found.items() if v is None)


# ---- 正規化（§4.1）----


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("熱量　１８０．５大卡", "熱量 180.5大卡"),  # NFKC：全形數字、全形空白
        ("｜脂肪｜9.8 公克｜", " 脂肪 9.8 公克 "),  # 表格線
        ("21 .3 公克", "21.3 公克"),
        ("21. 3 公克", "21.3 公克"),
        ("180 514", "180 514"),  # 欄的分隔不合併
        ("2,151 kJ", "2151 kJ"),
        ("21,3 g", "21.3 g"),
        ("1O.5 g", "10.5 g"),
        ("l2.3 g", "12.3 g"),
        ("O.5 g", "0.5 g"),
        ("Oil Information", "Oil Information"),  # 沒有數字的字不動
        ("2809", "2809"),  # 少了小數點不猜
    ],
)
def test_normalize(raw, expected):
    assert normalize(raw) == expected


# ---- 手寫的段落（規格 §4.2–§4.5）----


def _text(*rows):
    return "\n".join(rows) + "\n"


KJ_ONLY = _text(
    "Serving size 30 g",
    "per serving   per 100 g",
    "Energy 645 kJ 2151 kJ",
    "Protein 1.8 g 6.0 g",
    "Fat 8.4 g 28.0 g",
    "Carbohydrate 18.3 g 60.9 g",
)
TABLE = _text(
    "每一份量 35 公克",
    "本包裝含 4 份",
    "每份 每100公克",
    "熱量 180 大卡 514 大卡",
    "蛋白質 2.1 公克 6.0 公克",
    "{fat}",
    "碳水化合物 21.3 公克 60.9 公克",
)


def test_kj_only_is_converted():
    result = parse_label_text(KJ_ONLY)
    assert result.complete and result.basis == "per_100"
    assert _values(result) == ("514.10", "6.00", "28.00", "60.90")  # 2151 ÷ 4.184


def test_both_energies_prefer_kcal():
    text = KJ_ONLY.replace("Energy 645 kJ 2151 kJ", "Energy 645 kJ / 154 kcal 2151 kJ / 514 kcal")
    assert _values(parse_label_text(text))[0] == "514.00"


def test_energy_without_a_unit_is_not_guessed():
    result = parse_label_text(KJ_ONLY.replace("645 kJ 2151 kJ", "645 2151"))
    assert result.missing == ("kcal",)


def test_energy_unit_in_the_row_name():
    result = parse_label_text(KJ_ONLY.replace("Energy 645 kJ 2151 kJ", "熱量(大卡) 154 514"))
    assert _values(result)[0] == "514.00"


def test_saturated_fat_is_not_fat():
    result = parse_label_text(TABLE.format(fat="飽和脂肪 3.2 公克 9.1 公克"))
    assert result.missing == ("fat_g",)  # 只有飽和脂肪那一列：脂肪讀不到


def test_the_first_usable_row_wins_and_sub_rows_are_skipped():
    text = TABLE.format(
        fat="脂肪 9.8 公克 28.0 公克\n飽和脂肪 3.2 公克 9.1 公克\n反式脂肪 0 公克 0 公克"
    )
    assert _values(parse_label_text(text)) == ("514.00", "6.00", "28.00", "60.90")


def test_the_reference_footnote_is_not_a_row():
    # 只有一個營養素、數字個數又剛好合欄數的說明行：沒有「參考值」那一條規則，脂肪就是 60。
    text = _text(
        "每日參考值：脂肪60公克",
        "每100公克",
        "熱量 514 大卡",
        "蛋白質 6.0 公克",
        "脂肪 28.0 公克",
        "碳水化合物 60.9 公克",
    )
    assert _values(parse_label_text(text)) == ("514.00", "6.00", "28.00", "60.90")


def test_name_and_value_on_adjacent_lines():
    text = _text(
        "每100公克",
        "熱量",
        "514 大卡",
        "蛋白質",
        "6.0 公克",
        "脂肪",
        "28.0 公克",
        "碳水化合物",
        "60.9 公克",
    )
    assert _values(parse_label_text(text)) == ("514.00", "6.00", "28.00", "60.90")


def test_the_next_line_of_another_row_is_not_borrowed():
    # 蛋白質那一行沒有數字，下一行是糖：不能把糖的 3.4 當成蛋白質。
    text = _text(
        "每100公克",
        "熱量 514 大卡",
        "蛋白質",
        "糖 3.4 公克",
        "脂肪 28.0 公克",
        "碳水化合物 60.9 公克",
    )
    assert parse_label_text(text).missing == ("protein_g",)


def test_the_per_100_column_can_come_first():
    text = TABLE.replace("每份 每100公克", "每100公克 每份").replace(
        "180 大卡 514 大卡", "514 大卡 180 大卡"
    )
    text = text.replace("2.1 公克 6.0 公克", "6.0 公克 2.1 公克").replace(
        "21.3 公克 60.9 公克", "60.9 公克 21.3 公克"
    )
    result = parse_label_text(text.format(fat="脂肪 28.0 公克 9.8 公克"))
    assert _values(result) == ("514.00", "6.00", "28.00", "60.90")


def test_a_lost_percent_sign_is_cut_when_there_is_a_reference_column():
    text = _text(
        "每一份量 250 毫升",
        "每份 每日參考值百分比",
        "熱量 135 大卡 7",
        "蛋白質 8.0 公克 13",
        "脂肪 7.5 公克 13",
        "碳水化合物 9.0 公克 3",
    )
    result = parse_label_text(text)
    assert result.basis == "per_serving"
    assert _values(result) == ("54.00", "3.20", "3.00", "3.60")


def test_two_values_are_not_read_as_per_100_when_there_is_a_reference_column():
    # 「每份」讀錯、只剩參考值的表頭：第二個數字可能是百分比，不能當成每 100（規格 §4.2）。
    text = _text(
        "每仿 每日參考值百分比",
        "熱量 135 大卡 7",
        "蛋白質 8.0 公克 13",
        "脂肪 7.5 公克 13",
        "碳水化合物 9.0 公克 3",
    )
    assert parse_label_text(text).reason == "columns_unknown"


def test_one_row_with_two_values_is_not_enough_to_assume_the_columns():
    assert parse_label_text("脂肪 75 公克 3\n").reason == "columns_unknown"


def test_per_100_implausible_falls_back_to_per_serving():
    text = TABLE.format(fat="脂肪 9.8 公克 2809")  # 每 100 少了小數點
    result = parse_label_text(text)
    assert result.complete and result.basis == "per_serving"
    assert _values(result) == ("514.29", "6.00", "28.00", "60.86")  # 每份 ÷ 35 × 100


def test_per_serving_without_a_size():
    text = _text("每份", "熱量 135 大卡", "蛋白質 8.0 公克", "脂肪 7.5 公克", "碳水化合物 9.0 公克")
    result = parse_label_text(text)
    assert result.reason == "needs_serving_size"
    assert _values(result) == (None, None, None, None)


def test_a_serving_in_another_unit_is_not_used():
    text = _text(
        "每一份量 30 公克",
        "每100毫升",
        "熱量 40 大卡",
        "蛋白質 1.2 公克",
        "脂肪 1.5 公克",
        "碳水化合物 5.3 公克",
    )
    result = parse_label_text(text)
    assert result.complete and result.base_unit is BaseUnit.ML
    assert result.serving_size is None


def test_a_single_impossible_value_is_dropped_from_found():
    text = _text("每100公克", "熱量 514 大卡", "蛋白質 600 公克", "脂肪 28.0 公克")
    result = parse_label_text(text)
    assert result.reason == "missing_fields"
    assert _values(result) == ("514.00", None, "28.00", None)


def test_nothing_readable():
    for text in ("", "隨便一段字", "每100公克\n514 大卡\n6.0 公克\n"):
        assert parse_label_text(text).reason == "no_values"


def test_full_width_pasted_table():
    text = _text(
        "營養標示",
        "每一份量　３５公克",
        "本包裝含　４　份",
        "｜　　｜每份｜每１００公克｜",
        "｜熱量｜１８０大卡｜５１４大卡｜",
        "｜蛋白質｜２．１公克｜６．０公克｜",
        "｜脂肪｜９．８公克｜２８．０公克｜",
        "｜碳水化合物｜２１．３公克｜６０．９公克｜",
    )
    result = parse_label_text(text)
    assert (
        result.complete
        and result.serving_size == D("35.00")
        and result.servings_per_package == D("4.00")
    )
    assert _values(result) == ("514.00", "6.00", "28.00", "60.90")


def test_huge_input_does_not_raise():
    parse_label_text("熱量 9" * 2000)  # 端點的上限是 4000 字，解析器本身不該因為長而出錯
