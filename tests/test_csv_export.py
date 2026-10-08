"""`app/csv_export.py`：CSV 的寫法只有一份（規格 §3.3）。純函式，不碰資料庫。"""

import csv
import io
from decimal import Decimal

import pytest

from app.csv_export import FORMULA_TRIGGERS, UTF8_BOM, encode_header, encode_rows, guard_text


def _parse(raw: bytes) -> list[list[str]]:
    """照試算表的讀法讀回來。`newline=""`：儲存格裡的 CR／LF 要原樣留著。"""
    return list(csv.reader(io.StringIO(raw.decode("utf-8"), newline="")))


@pytest.mark.parametrize(
    "text",
    [
        '=HYPERLINK("http://evil.example","點我")',
        "+886912345678",
        "-5",
        "@SUM(A1:A9)",
        "\t=1+1",
        "\r=1+1",
        "\n=1+1",
    ],
)
def test_text_that_starts_like_a_formula_gets_a_leading_quote(text):
    assert guard_text(text) == "'" + text


@pytest.mark.parametrize(
    "text",
    ["便當", "", "100", "a=b", "3-1", "滷肉飯🍚", " =1+1", "'=1+1", "＝全形等號"],
)
def test_other_text_is_left_alone(text):
    # 只看第一個字元：中間的 = 不是公式；開頭是空白的 Excel 不會當公式。
    assert guard_text(text) == text


def test_every_trigger_character_is_covered_by_the_tests_above():
    # 清單多加一個字元而沒有補測試 → 這裡紅（第 44 種：先確定清單不是空的）。
    assert set(FORMULA_TRIGGERS) == {"=", "+", "-", "@", "\t", "\r", "\n"}


def test_commas_quotes_and_newlines_survive_a_round_trip():
    rows = [
        ("便當, 加蛋", '他說 "好吃"'),
        ("第一行\n第二行", "第一行\r\n第二行"),
        ("滷肉飯🍚", ""),
    ]

    raw = encode_rows(rows)

    assert _parse(raw) == [list(row) for row in rows]
    # 不只是「讀得回來」：真的照 RFC 4180 加了引號、雙引號變兩個、每列 CRLF 結尾。
    text = raw.decode("utf-8")
    assert '"便當, 加蛋","他說 ""好吃"""\r\n' in text
    assert text.endswith("滷肉飯🍚,\r\n")


def test_a_formula_inside_quotes_is_still_guarded():
    raw = encode_rows([('=HYPERLINK("http://evil.example","x")', "ok")])

    assert raw.decode("utf-8") == '"\'=HYPERLINK(""http://evil.example"",""x"")",ok\r\n'


def test_decimals_are_written_plainly_and_never_guarded():
    raw = encode_rows(
        [(Decimal("180.50"), Decimal("1E+2"), Decimal("0.00"), Decimal("-5.00"))]
    )

    # 1E+2 不能寫成科學記號；負數是數字不是公式——加了單引號，試算表就不能加總了。
    assert raw == b"180.50,100,0.00,-5.00\r\n"


def test_none_is_an_empty_cell():
    assert encode_rows([("a", None, "c")]) == b"a,,c\r\n"


def test_the_header_starts_with_a_utf8_bom():
    raw = encode_header(["日期", "熱量(kcal)"])

    assert UTF8_BOM == b"\xef\xbb\xbf"
    assert raw == b"\xef\xbb\xbf" + "日期,熱量(kcal)\r\n".encode()


def test_only_the_header_carries_the_bom():
    assert not encode_rows([("日期",)]).startswith(UTF8_BOM)
