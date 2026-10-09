"""`app/schemas/validators.py` 的 `single_line`：會顯示給別人、寫進 CSV 的單行文字。"""

import pytest

from app.schemas.validators import single_line


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("一碗白飯、滷雞腿", "一碗白飯、滷雞腿"),
        ("  前後空白  ", "前後空白"),
        ("第一行\n第二行\r\n第三行", "第一行 第二行 第三行"),
        ("有\tTab", "有 Tab"),
        ("NUL\x00在中間", "NUL 在中間"),
        ("C1\x85控制", "C1 控制"),
        # 雙向控制字元：U+202E 會讓後面的字在畫面上倒過來。
        ("abc\u202edef", "abc def"),
        ("\u2066隔離\u2069", "隔離"),
        ("行分隔\u2028段分隔\u2029", "行分隔 段分隔"),
        ("連續   空白", "連續 空白"),
        ("\n\t \x00", ""),
        # ZWJ（U+200D）不動：表情符號的組合序列靠它。
        ("\U0001f468\u200d\U0001f373 主廚沙拉", "\U0001f468\u200d\U0001f373 主廚沙拉"),
    ],
)
def test_single_line(raw: str, cleaned: str) -> None:
    assert single_line(raw) == cleaned
