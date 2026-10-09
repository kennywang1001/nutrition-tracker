"""`app/schemas/validators.py` 的兩個清理函式：`single_line`（會顯示給別人、寫進 CSV 的
單行文字）與 `clean_display_name`（顯示名稱）。

**這個檔案裡看不見的字一律寫成 `\\u` 跳脫**——原樣貼進來的話，編輯器與 diff 都看不出
測的是什麼。"""

import sys
import unicodedata

import pytest

from app.schemas.validators import clean_display_name, single_line

ZWJ = "\u200d"
# 「主廚」：男人＋ZWJ＋鍋子。
COOK = "\U0001f468\u200d\U0001f373"
# 一家三口：兩個 ZWJ。
FAMILY = "\U0001f468\u200d\U0001f469\u200d\U0001f467"
# 彩虹旗：白旗＋VS16（U+FE0F，Mn，不是 Cf）＋ZWJ＋彩虹。
RAINBOW_FLAG = "\U0001f3f3\ufe0f\u200d\U0001f308"
# 紅心：U+2764＋VS16。
RED_HEART = "\u2764\ufe0f"

# 每一個格式字元（Unicode 類別 Cf），ZWJ 除外。跟著這台 Python 的 Unicode 版本走。
FORMAT_CHARACTERS = [
    chr(code)
    for code in range(sys.maxunicode + 1)
    if unicodedata.category(chr(code)) == "Cf" and chr(code) != ZWJ
]


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("一碗白飯、滷雞腿", "一碗白飯、滷雞腿"),
        ("  前後空白  ", "前後空白"),
        ("第一行\n第二行\r\n第三行", "第一行 第二行 第三行"),
        ("有\tTab", "有 Tab"),
        ("NUL\x00在中間", "NUL 在中間"),
        ("C1\x85控制", "C1 控制"),
        ("行分隔\u2028段分隔\u2029", "行分隔 段分隔"),
        ("連續   空白", "連續 空白"),
        ("\n\t \x00", ""),
        # 格式字元（Cf）是**拿掉**，不是換成空白：它們本來就沒有寬度，換成空白會把一個詞切開。
        # 雙向控制字元：U+202E 會讓後面的字在畫面上倒過來。
        ("abc\u202edef", "abcdef"),
        ("\u2066隔離\u2069", "隔離"),
        ("左\u200e右\u200f、阿拉伯\u061c字母標記", "左右、阿拉伯字母標記"),
        # 零寬的字：只有它們的話清完是空的（審查 M2：一則看起來是空的留言）。
        ("\u200b", ""),
        ("\u200b\u200c\u2060\ufeff\u00ad\u180e", ""),
        (" \u200b \u200b ", ""),
        ("零\u200b寬、軟\u00ad連字號", "零寬、軟連字號"),
        ("\ufeff開頭的 BOM", "開頭的 BOM"),
        # 被格式字元隔開的兩個空白仍然併成一個。
        ("前 \u200b 後", "前 後"),
        # ZWJ（U+200D）夾在兩個字中間就不動：表情符號的組合序列靠它。VS16 是 Mn，不受影響。
        (f"{COOK} 主廚沙拉", f"{COOK} 主廚沙拉"),
        (f"全家{FAMILY}一起吃", f"全家{FAMILY}一起吃"),
        (f"{RAINBOW_FLAG}{RED_HEART}", f"{RAINBOW_FLAG}{RED_HEART}"),
        # 沒有被夾在中間的 ZWJ 是多的：單獨的、開頭的、結尾的、空白旁邊的、連續的。
        ("\u200d", ""),
        ("\u200d\u200d\u200d", ""),
        ("\u200d開頭、結尾\u200d", "開頭、結尾"),
        ("前 \u200d 後", "前 後"),
        ("前\u200d 後 \u200d再後", "前 後 再後"),
        ("連\u200d\u200d續", "連續"),
        # 控制字元先變成空白，ZWJ 才看它的兩邊：這一個不算「夾在中間」。
        ("\x00\u200d\x00", ""),
        # 拿掉旁邊的零寬字之後才看 ZWJ 的兩邊。
        ("\u200b\u200d\u200b", ""),
        ("\U0001f468\u200b\u200d\u200b\U0001f373", COOK),
        # 已知限制：標籤字元（U+E0020～U+E007F）也是 Cf——英格蘭旗這一類「子區域旗」會只剩黑旗。
        ("\U0001f3f4\U000e0067\U000e0062\U000e0065\U000e006e\U000e0067\U000e007f", "\U0001f3f4"),
    ],
)
def test_single_line(raw: str, cleaned: str) -> None:
    assert single_line(raw) == cleaned


def test_single_line_drops_every_format_character() -> None:
    """不是一張「想得到的零寬字」的清單：整個 Cf 類別。拿掉而不是換成空白。"""
    assert len(FORMAT_CHARACTERS) > 150  # 真的有掃到東西（Unicode 15 是 170 個）
    survivors = [
        f"U+{ord(ch):04X}" for ch in FORMAT_CHARACTERS if single_line(f"前{ch}後") != "前後"
    ]
    assert survivors == []
    assert single_line("".join(FORMAT_CHARACTERS)) == ""


@pytest.mark.parametrize(
    ("raw", "cleaned"),
    [
        ("阿明", "阿明"),
        ("  阿明  ", "阿明"),
        # 名字會被放進通知的句子裡、給共同好友看：U+202E 能把那一行後面的字倒過來（審查 M2）。
        ("阿\u202e明", "阿明"),
        ("\u2067阿明\u2069", "阿明"),
        ("阿\u200b明\ufeff", "阿明"),
        # 先拿掉格式字元才去頭尾：夾在零寬字外面的空白也要去掉。
        ("\u200b  阿明  \u200b", "阿明"),
        ("\u200d 阿明 \u200d", "阿明"),
        # 表情符號照樣可以放在名字裡。
        (f"阿明{COOK}", f"阿明{COOK}"),
        (f"{RAINBOW_FLAG} 阿明 {RED_HEART}", f"{RAINBOW_FLAG} 阿明 {RED_HEART}"),
        # 名字不併空白（跟以前一樣）：中間的兩個空白留著。
        ("阿  明", "阿  明"),
    ],
)
def test_clean_display_name(raw: str, cleaned: str) -> None:
    assert clean_display_name(raw) == cleaned


@pytest.mark.parametrize(
    "raw",
    ["", "   ", "\u200b", "\u202e", " \u200b\ufeff ", "\u200d", "\u200d \u200d", "\u2066\u2069"],
    ids=["empty", "spaces", "zwsp", "rlo", "mixed", "zwj", "zwj-pair", "isolates"],
)
def test_a_display_name_with_nothing_visible_is_refused(raw: str) -> None:
    with pytest.raises(ValueError, match="顯示名稱不能只有空白"):
        clean_display_name(raw)


@pytest.mark.parametrize("raw", ["A\x00B", "阿\n明", "阿\x7f明", "阿\x85明"])
def test_a_display_name_with_control_characters_is_still_refused(raw: str) -> None:
    """控制字元是**拒絕**（跟以前一樣），格式字元是拿掉：NUL 進得了 Pydantic、進不了 PostgreSQL。"""
    with pytest.raises(ValueError, match="顯示名稱不能包含控制字元"):
        clean_display_name(raw)


def test_clean_display_name_drops_every_format_character() -> None:
    survivors = [
        f"U+{ord(ch):04X}"
        for ch in FORMAT_CHARACTERS
        if clean_display_name(f"阿{ch}明") != "阿明"
    ]
    assert survivors == []
