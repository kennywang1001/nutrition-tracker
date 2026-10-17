"""`app/barcode.py`：正規化與檢查碼（掃條碼規格 §3）。純函式。"""

import pytest

from app.barcode import (
    InvalidBarcodeError,
    expand_upc_e,
    gtin_check_digit,
    normalize_barcode,
)

# 全形空白（U+3000）。用 chr() 組：原始碼裡不放看不見或像空白的字（handover §7）。
FULL_WIDTH_SPACE = chr(0x3000)
# 全形的「４」（U+FF14）：`\d` 與 str.isdigit() 都認它，但它不是條碼的數字。
FULL_WIDTH_FOUR = chr(0xFF14)


@pytest.mark.parametrize(
    ("body", "digit"),
    [
        ("471008843209", 4),  # 規格 §3.2 算一次的那一個
        ("03600029145", 2),  # UPC-A 036000291452
        ("9638507", 4),  # EAN-8 96385074
        ("04210000526", 4),  # UPC-E 04252614 展開後
        ("000000000000", 0),
        # 真實商品：可口可樂 330 ml 的 EAN-13 5449000000996（OFF 上常見的例子）。
        ("544900000099", 6),
        ("471008843001", 4),  # 4710088430014
    ],
)
def test_the_gs1_check_digit(body, digit):
    assert gtin_check_digit(body) == digit


@pytest.mark.parametrize(
    ("upc_e", "upc_a"),
    [
        ("04252614", "042100005264"),  # 第 6 位 0～2
        ("01234565", "012345000065"),  # 5～9
    ],
)
def test_upc_e_expands_to_upc_a(upc_e, upc_a):
    assert expand_upc_e(upc_e) == upc_a


@pytest.mark.parametrize(
    ("upc_e", "upc_a"),
    [
        ("0ABCDE3C", "0ABC00000DEC"),
        ("0ABCDE4C", "0ABCD00000EC"),
        ("0ABCDE0C", "0AB00000CDEC"),
        ("0ABCDE1C", "0AB10000CDEC"),
        ("0ABCDE2C", "0AB20000CDEC"),
        ("0ABCDE9C", "0ABCDE00009C"),
    ],
)
def test_upc_e_expansion_follows_the_sixth_digit(upc_e, upc_a):
    """用字母標位置：每一種「第 6 位」各一條，看每一位搬到哪裡（規格 §3.3 的表）。"""
    assert expand_upc_e(upc_e) == upc_a


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        ("4710088432094", "4710088432094"),
        ("4 710088 43209 4", "4710088432094"),
        ("4710088-432094", "4710088432094"),
        (FULL_WIDTH_SPACE + "4710088432094" + FULL_WIDTH_SPACE, "4710088432094"),
        ("036000291452", "0036000291452"),  # UPC-A 補 0
        ("036000-291452", "0036000291452"),
        ("0036000291452", "0036000291452"),  # 同一個商品的 EAN-13 寫法
        ("04252614", "0042100005264"),  # UPC-E → UPC-A → 補 0
        ("042100005264", "0042100005264"),  # 上一列展開後
        ("96385074", "96385074"),  # EAN-8
        ("5449000000996", "5449000000996"),  # 真實商品（可口可樂）
        ("4710088430014", "4710088430014"),
    ],
)
def test_normalize_returns_the_standard_form(raw, expected):
    assert normalize_barcode(raw) == expected


def test_an_eight_digit_code_starting_with_zero_that_is_not_upc_e_is_ean_8():
    """0 開頭、UPC-E 的檢查碼不對、EAN-8 的對 → EAN-8（第二條路要真的走得到）。"""
    code = "07654329"
    assert gtin_check_digit(code[:-1]) == 9  # 前提：合格的 EAN-8
    upc_a = expand_upc_e(code)  # 076200005439
    assert gtin_check_digit(upc_a[:-1]) != int(upc_a[-1])  # 前提：不是合格的 UPC-E
    assert normalize_barcode(code) == code


def test_an_eight_digit_code_valid_both_ways_is_upc_e():
    """兩種檢查碼都對（寫計畫時找到的 01234565）→ 0 開頭的先當 UPC-E（規格 §3.3）。"""
    assert gtin_check_digit("0123456") == 5
    assert normalize_barcode("01234565") == "0012345000065"


@pytest.mark.parametrize(
    ("raw", "message"),
    [
        ("4710088432096", "檢查碼"),
        ("5449000000995", "檢查碼"),
        ("036000291453", "檢查碼"),
        ("96385075", "檢查碼"),
        ("12345", "8、12 或 13"),
        ("04210000526", "8、12 或 13"),
        ("47100884320941", "8、12 或 13"),
        ("", "只能是數字"),
        ("abc", "只能是數字"),
        ("4710088.432094", "只能是數字"),
        # NFKC 不會把其他文字的數字（阿拉伯－印度數字 ٣，U+0663）折成 ASCII：照舊拒絕。
        ("4710088" + chr(0x0663) + "32094", "只能是數字"),
    ],
)
def test_invalid_codes_are_rejected_with_a_readable_message(raw, message):
    with pytest.raises(InvalidBarcodeError, match=message):
        normalize_barcode(raw)


def _full_width(text):
    """ASCII 數字與「-」→ 全形（U+FF10～U+FF19、U+FF0D）。用 chr() 組：原始碼裡不放全形字。"""
    return "".join(chr(ord(ch) - 0x30 + 0xFF10) if ch.isdigit() else chr(0xFF0D) for ch in text)


@pytest.mark.parametrize(
    ("raw", "expected"),
    [
        # 審查 M6：中文輸入法打出來的全形數字（「５９０１２３４１２３４５７」）
        # 先用 NFKC 折成 ASCII。
        (_full_width("5901234123457"), "5901234123457"),
        ("4710088" + FULL_WIDTH_FOUR + "32094", "4710088432094"),  # 混了一個全形數字
        (_full_width("036000-291452"), "0036000291452"),  # 全形的「－」也是分隔符號
        (FULL_WIDTH_SPACE + _full_width("96385074"), "96385074"),
    ],
)
def test_full_width_digits_are_folded(raw, expected):
    assert normalize_barcode(raw) == expected
