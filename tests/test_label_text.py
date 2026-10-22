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


# ---- 審查後的修正：欄的順序看表頭那一行、兩欄交叉檢查（規格 §4.2、§4.4）----

PER_100_FIRST = _text(
    "{size}",
    "{header}",
    "熱量 514 大卡 180 大卡",
    "蛋白質 6.0 公克 2.1 公克",
    "脂肪 28.0 公克 9.8 公克",
    "碳水化合物 60.9 公克 21.3 公克",
)
SERVING_FIRST = _text(
    "{size}",
    "{header}",
    "熱量 180 大卡 514 大卡",
    "蛋白質 2.1 公克 6.0 公克",
    "脂肪 9.8 公克 28.0 公克",
    "碳水化合物 21.3 公克 60.9 公克",
)
RIGHT = "514.00/6.00/28.00/60.90"


def test_uk_per_100_first_and_a_bar_column():
    # 「Per 45g bar」是每份那一欄、也是一份的量；每 100 在前面。
    text = _text(
        "Nutrition",
        "Typical values  Per 100g  Per 45g bar  %RI*",
        "Energy  2151kJ  968kJ",
        "        514kcal  231kcal  12%",
        "Fat  28.0g  12.6g  18%",
        "of which saturates  9.1g  4.1g  21%",
        "Carbohydrate  60.9g  27.4g",
        "of which sugars  3.4g  1.5g  2%",
        "Fibre  2.0g  0.9g",
        "Protein  6.0g  2.7g  5%",
        "Salt  0.86g  0.39g  7%",
    )
    assert _summary(parse_label_text(text)) == "complete per_100 g 45.00 - 514.10/6.00/28.00/60.90"


def test_per_100_first_and_a_gram_serving_header():
    text = _text(
        "Per 100g  Per 30g serving",
        "Energy  2151kJ/514kcal  645kJ/154kcal",
        "Fat  28.0g  8.4g",
        "Carbohydrate  60.9g  18.3g",
        "Protein  6.0g  1.8g",
    )
    assert _summary(parse_label_text(text)) == f"complete per_100 g 30.00 - {RIGHT}"


@pytest.mark.parametrize("size", ["每一份量 35 公克", ""], ids=["with_size", "without_size"])
def test_a_misread_serving_header_after_per_100(size):
    # 只讀到「每100公克」、它後面還有像表頭的字（讀錯的「每份」）→ 每 100 在前面。
    # 沒有每一份量（不能交叉檢查）也一樣。
    text = PER_100_FIRST.format(size=size, header="每100公克 每仿")
    expected_size = "35.00" if size else "-"
    assert _summary(parse_label_text(text)) == f"complete per_100 g {expected_size} - {RIGHT}"


def test_a_misread_serving_header_before_per_100_without_a_size():
    text = SERVING_FIRST.format(size="", header="每仿 每100公克")
    assert _summary(parse_label_text(text)) == f"complete per_100 g - - {RIGHT}"


def test_a_serving_size_line_above_the_header():
    # 「每份 35 公克」是每一份量，不是表頭：欄的順序看「每100公克 每份」那一行。
    text = PER_100_FIRST.format(size="每份 35 公克", header="每100公克 每份")
    assert _summary(parse_label_text(text)) == f"complete per_100 g 35.00 - {RIGHT}"


@pytest.mark.parametrize("line", ["每份 35 公克", "每份量 35 公克"])
def test_a_serving_size_line_below_the_header_is_not_a_header(line):
    text = _text(
        "營養標示",
        "每100公克",
        line,
        "熱量 514 大卡",
        "蛋白質 6.0 公克",
        "脂肪 28.0 公克",
        "碳水化合物 60.9 公克",
    )
    assert _summary(parse_label_text(text)) == f"complete per_100 g 35.00 - {RIGHT}"


@pytest.mark.parametrize(
    ("size", "expected_size"),
    [("Serving size 30 g", "30.00"), ("", "-")],
    ids=["with_size", "without_size"],
)
def test_prose_above_the_header(size, expected_size):
    # 說明文字裡的「per serving and per 100 g」不是表頭。
    # 沒有一份的量（不能交叉檢查）時只靠表頭那一行。
    text = _text(
        "Nutrition information (per serving and per 100 g)",
        size,
        "per 100 g   per serving",
        "Energy 2151 kJ 645 kJ",
        "Protein 6.0 g 1.8 g",
        "Fat 28.0 g 8.4 g",
        "Carbohydrate 60.9 g 18.3 g",
    )
    expected = f"complete per_100 g {expected_size} - 514.10/6.00/28.00/60.90"
    assert _summary(parse_label_text(text)) == expected


def test_columns_in_the_wrong_order_are_swapped():
    # 表頭說每 100 在前，數字說每份在前（514 ÷ 180 ≈ 100 ÷ 35）：照數字。
    text = SERVING_FIRST.format(size="每一份量 35 公克", header="每100公克 每份")
    assert _summary(parse_label_text(text)) == f"complete per_100 g 35.00 - {RIGHT}"


def test_columns_that_cannot_be_reconciled_are_not_complete():
    # 每一份量讀成 3.5、欄又排反：兩種排法都對不起來 → 哪一欄都不信。
    text = PER_100_FIRST.format(size="每一份量 3.5 公克", header="每份 每100公克")
    assert _summary(parse_label_text(text)) == "implausible - g 3.50 - -/-/-/-"


@pytest.mark.parametrize(
    "table", [PER_100_FIRST, SERVING_FIRST], ids=["per_100_first", "serving_first"]
)
def test_without_headers_the_serving_size_settles_the_order(table):
    text = table.format(size="每一份量 35 公克", header="營養標示")
    assert _summary(parse_label_text(text)) == f"complete per_100 g 35.00 - {RIGHT}"


@pytest.mark.parametrize("header", ["營養標示", "每100公克", "營養標示 每100公克"])
def test_an_order_that_cannot_be_read_or_checked_is_not_guessed(header):
    # 沒有表頭、只有一個單獨的表頭、或旁邊的字不像表頭；又沒有每一份量可以交叉檢查 → 不猜。
    text = SERVING_FIRST.format(size="", header=header)
    assert _summary(parse_label_text(text)) == "columns_unknown - g - - -/-/-/-"


def test_without_headers_or_a_size_that_fits_the_order_is_unknown():
    text = SERVING_FIRST.format(size="每一份量 50 公克", header="營養標示")
    assert parse_label_text(text).reason == "columns_unknown"


def test_one_nutrient_that_contradicts_the_other_column_is_dropped():
    # 脂肪 9.8 ÷ 35 × 100 = 28，不是 2.0；兩個都在範圍內、分不出哪一個錯 → 那一項讀不到。
    result = parse_label_text(TABLE.format(fat="脂肪 9.8 公克 2.0 公克"))
    assert _summary(result) == "missing_fields - g 35.00 4.00 514.00/6.00/-/60.90"


def test_a_contradicted_value_beyond_the_physical_limit_loses():
    # 每份那一欄的脂肪少了小數點（98 → 每 100 是 280，不可能）：每 100 那一欄的 28.0 照用。
    result = parse_label_text(TABLE.format(fat="脂肪 98 公克 28.0 公克"))
    assert _summary(result) == f"complete per_100 g 35.00 4.00 {RIGHT}"


def test_a_broken_column_and_a_contradiction_keep_what_agrees():
    # 每 100 的脂肪少了小數點（不合理），蛋白質兩欄又對不起來（都在範圍內）：每份那一欄也不能用。
    # 結果是不完整、留下兩欄對得起來的項目，不是整個「不合理」。
    text = TABLE.format(fat="脂肪 9.8 公克 2809").replace(
        "蛋白質 2.1 公克 6.0 公克", "蛋白質 2.1 公克 9.0 公克"
    )
    assert _summary(parse_label_text(text)) == "missing_fields - g 35.00 4.00 514.00/-/-/60.90"


def test_the_tolerance_is_not_wider_than_the_rounding():
    # 9.8 ÷ 35 × 100 = 28.0，30.5 差 9%：不是進位的差。
    result = parse_label_text(TABLE.format(fat="脂肪 9.8 公克 30.5 公克"))
    assert _summary(result) == "missing_fields - g 35.00 4.00 514.00/6.00/-/60.90"


def test_the_tolerance_covers_a_small_value_labelled_zero():
    # 每 100 不超過 0.5 公克可以標 0；每份 0.1 → 每 100 是 0.29。
    result = parse_label_text(TABLE.format(fat="脂肪 0.1 公克 0 公克"))
    assert _summary(result) == "complete per_100 g 35.00 4.00 514.00/6.00/0.00/60.90"


def test_the_tolerance_covers_whole_kcal_on_a_small_serving():
    # 一份 10 公克：4.4 大卡印成 4，每 100 是 44。
    text = _text(
        "每一份量 10 公克",
        "每份 每100公克",
        "熱量 4 大卡 44 大卡",
        "蛋白質 0.1 公克 1.2 公克",
        "脂肪 0 公克 0 公克",
        "碳水化合物 1.0 公克 10.4 公克",
    )
    assert _summary(parse_label_text(text)) == "complete per_100 g 10.00 - 44.00/1.20/0.00/10.40"


def test_the_tolerance_covers_whole_grams():
    # 歐盟的進位：10 公克以上印整數（18.27 → 18、60.9 → 61）。
    text = KJ_ONLY.replace("18.3 g 60.9 g", "18 g 61 g")
    assert _summary(parse_label_text(text)) == "complete per_100 g 30.00 - 514.10/6.00/28.00/61.00"


# ---- 審查後的修正：很長的數字不丟例外（規格 §4.2）----


@pytest.mark.parametrize(
    ("text", "expected"),
    [
        (
            "每100公克\n熱量 514 大卡\n蛋白質 " + "1" * 30 + " 公克\n",
            "missing_fields - g - - 514.00/-/-/-",
        ),
        # 那一行有數字（只是不算數）：不去借下一行的。
        (
            "每100公克\n熱量 514 大卡\n蛋白質 " + "1" * 30 + " 公克\n6.0 公克\n",
            "missing_fields - g - - 514.00/-/-/-",
        ),
        ("每一份量 " + "9" * 30 + " 公克\n", "no_values - g - - -/-/-/-"),
        ("本包裝含" + "9" * 30 + "份\n", "no_values - g - - -/-/-/-"),
        ("每100公克\n熱量 " + "l" * 30 + "8 大卡\n", "no_values - g - - -/-/-/-"),
        ("per 100 g\nEnergy " + "9" * 30 + " kJ\n", "no_values - g - - -/-/-/-"),
        # 表頭裡的量讀不出來：還是每份那一欄，只是沒有一份的量。
        (
            "Per 100g  Per " + "9" * 30 + "g bar\nFat 28.0 g 1.0 g\n",
            "missing_fields - g - - -/-/28.00/-",
        ),
    ],
    ids=["row", "row_no_borrow", "serving_size", "servings", "lookalikes", "kj", "header_size"],
)
def test_a_long_digit_run_is_not_a_number(text, expected):
    assert _summary(parse_label_text(text)) == expected


# ---- 審查後的修正：每日參考值那一欄的截斷（規格 §4.2）----


def test_a_split_number_beside_its_own_percent_is_not_cut():
    # 「19.0」讀成「1 9.0」：% 還在，多出來的不是讀丟了 % 的百分比 → 這一列讀不到。
    text = _text(
        "每一份量 250 毫升",
        "每份 每日參考值百分比",
        "熱量 135 大卡 7%",
        "蛋白質 8.0 公克 13%",
        "脂肪 7.5 公克 13%",
        "碳水化合物 1 9.0 公克 6%",
    )
    assert _summary(parse_label_text(text)) == "missing_fields - ml 250.00 - 54.00/3.20/3.00/-"


def test_two_extra_values_are_not_cut():
    text = _text(
        "每一份量 250 毫升",
        "每份 每日參考值百分比",
        "熱量 135 大卡 7",
        "蛋白質 8.0 公克 13",
        "脂肪 7 5 公克 13",
        "碳水化合物 9.0 公克 3",
    )
    assert _summary(parse_label_text(text)) == "missing_fields - ml 250.00 - 54.00/3.20/-/3.60"


def test_the_reference_footnote_does_not_turn_on_the_cut():
    text = _text(
        "每一份量 35 公克",
        "每份 每100公克",
        "熱量 180 大卡 514 大卡",
        "蛋白質 2.1 公克 6.0 公克",
        "脂肪 9.8 公克 2 8.0 公克",
        "碳水化合物 21.3 公克 60.9 公克",
        "每日參考值：熱量2000大卡、蛋白質60公克、脂肪60公克",
    )
    assert _summary(parse_label_text(text)) == "missing_fields - g 35.00 - 514.00/6.00/-/60.90"


@pytest.mark.parametrize(
    ("top", "bottom"),
    [("每日參考值：熱量2000大卡、脂肪60公克", ""), ("", "＊參考值未訂定")],
    ids=["note_with_nutrients_on_top", "note_below_the_table"],
)
def test_a_reference_note_outside_the_header_does_not_turn_on_the_cut(top, bottom):
    # 只有每 100 一欄，脂肪的「28.0」拆成「2 8.0」：說明行不是表頭，不砍成 2。
    text = _text(
        top,
        "每100公克",
        "熱量 514 大卡",
        "蛋白質 6.0 公克",
        "脂肪 2 8.0 公克",
        "碳水化合物 60.9 公克",
        bottom,
    )
    assert _summary(parse_label_text(text)) == "missing_fields - g - - 514.00/6.00/-/60.90"


# ---- 審查後的修正：每一份量與份數的冒號、點線（規格 §4.1、§4.4）----


@pytest.mark.parametrize(
    "line", ["每一份量：35 公克", "每一份量 : 35公克", "Serving size: 35 g", "serving size35g"]
)
def test_serving_size_with_or_without_a_colon(line):
    assert parse_label_text(line + "\n").serving_size == D("35.00")


@pytest.mark.parametrize(
    "line",
    [
        "本包裝含：4 份",
        "Servings per container: about 4",
        "servings per pack : 4",
        "Servings per package 4",
    ],
)
def test_servings_with_or_without_a_colon(line):
    assert parse_label_text(line + "\n").servings_per_package == D("4.00")


def test_dot_leaders():
    text = _text(
        "每100公克",
        "熱量......514大卡",
        "蛋白質……6.0公克",  # NFKC：… → ...
        "脂肪......28.0公克",
        "碳水化合物......60.9公克",
    )
    assert _summary(parse_label_text(text)) == f"complete per_100 g - - {RIGHT}"


def test_a_lone_point_before_a_number_is_not_a_leader():
    # 「.5」多半是「0.5」讀丟了 0：不當成 5。
    text = _text(
        "每100公克", "熱量 514 大卡", "蛋白質 .5 公克", "脂肪 28.0 公克", "碳水化合物 60.9 公克"
    )
    assert _summary(parse_label_text(text)) == "missing_fields - g - - 514.00/-/28.00/60.90"
