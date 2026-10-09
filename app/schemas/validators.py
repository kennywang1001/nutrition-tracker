"""共用的 Pydantic 驗證邏輯：控制字元檢查、IANA 時區檢查。

計畫 1 的註冊請求已經寫過、也已經用真實攻擊向度驗證過這兩段邏輯：
NUL byte 讓 `display_name` 通過 Pydantic 又被 PostgreSQL 拒收，變成一個
未認證就能觸發的 500；`ZoneInfoNotFoundError`／`ValueError` 兩種例外
分別對應「查無此時區」與「key 本身不合法（路徑穿越）」兩種輸入，
只接其中一種都會留下一個洞（見 `_must_be_real_timezone` 的說明）。

計畫 3 的 `PATCH /api/me` 需要重用同一套邏輯，抽出來是為了不重寫 ——
重寫等於把這兩個已經踩過的坑，各挖一次新的機會。

用 `Annotated[str, AfterValidator(...)]` 而不是
`field_validator("field")(shared_func)` 的原因：`PATCH /api/me` 的欄位型別是
`X | None`（`None` 表示「沒帶這個欄位」）。`field_validator` 是綁在欄位上的 ——
即使實際值命中的是 Union 裡的 `None` 分支，還是會被呼叫，這裡的兩個函式都預期
收到 `str`，傳進 `None` 會直接讓 `.strip()` / `ZoneInfo(None)` 炸開一個
跟驗證邏輯無關的例外。`Annotated` 上的 metadata 則是綁在「`str`」這個分支
本身：Pydantic 驗證 `None` 時走的是 Union 的 `None` 分支，根本不會進到
這段邏輯，不需要額外寫 `if value is None: return None` 去繞。
（已用 spike 腳本實測：`Req(display_name=None)` 不會呼叫 `clean()`。）
"""

import re
import unicodedata
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator

# C0 控制字元 + DEL + C1。顯示用名稱裡不該出現任何一個。
# 其中 \x00 特別重要：它通得過 Pydantic，然後被 PostgreSQL 拒收，
# 變成一個未經認證就能觸發的 500。
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# 會顯示給別人（好友）、寫進 CSV 的單行文字裡要**換成空白**的字元：C0／DEL／C1 控制字元
# （含換行與 Tab）、行／段分隔（U+2028、U+2029）。它們本來就佔一個位置（或是斷行），
# 直接拿掉會把前後兩個詞黏在一起。
# （U+2028、U+2029 與換行、Tab 其實 `str.split()` 本來就當空白——把它們從這裡拿掉，
# 測試照樣綠。寫著是讓這張清單自己說得完整；真正靠這一條的是 NUL 這類不是空白的。）
_BECOMES_A_SPACE = re.compile(r"[\x00-\x1f\x7f-\x9f\u2028\u2029]")

# ZWJ（U+200D，零寬連接符）：格式字元裡唯一留著的。表情符號的組合序列靠它
# （一家三口、主廚、彩虹旗）。
_ZWJ = "\N{ZERO WIDTH JOINER}"
# 沒有被兩個「看得見的字」夾在中間的 ZWJ：開頭、結尾、空白旁邊、另一個 ZWJ 旁邊。
# 組合序列裡的 ZWJ 兩邊一定各有一個字，所以這些都是多的——而且只留它們的話，
# 一串 ZWJ 就是一則「不是空的、但什麼都看不到」的留言。
_STRAY_ZWJ = re.compile(rf"(?<![^\s{_ZWJ}]){_ZWJ}|{_ZWJ}(?![^\s{_ZWJ}])")


def _drop_format_characters(value: str) -> str:
    """拿掉看不見的格式字元：Unicode 類別 `Cf` 整類，夾在兩個字中間的 ZWJ 除外。

    `Cf` 包含：零寬空白與零寬不連字（U+200B、U+200C）、詞連接符（U+2060）、BOM（U+FEFF）、
    軟連字號（U+00AD）、**雙向控制字元**（U+202A～U+202E、U+2066～U+2069、U+200E、U+200F、
    U+061C——U+202E 能讓它後面的字在畫面上倒著顯示；名字會被放進通知的句子裡、給共同好友看）、
    標籤字元（U+E0001、U+E0020～U+E007F，可以藏一段看不見的字）。

    **整類拿掉，不是一張「想得到的」清單**：清單永遠少一個，而且 Unicode 每一版都會加。
    **拿掉而不是換成空白**：它們沒有寬度，換成空白會把一個詞切成兩個。

    已知的代價（社群規格「審查後的修正」）：
    - 靠標籤字元組成的「子區域旗」（英格蘭、蘇格蘭、威爾斯）會只剩一面黑旗。
    - 波斯文、印度諸語言用 U+200C 控制連字的寫法會被改掉。這個 app 的介面只有中文。
    - **看不見的字不只 `Cf`**：變體選擇符（U+FE0F，`Mn`——表情符號的呈現靠它，所以不動）、
      韓文填充字（U+3164，`Lo`）、點字空白（U+2800，`So`）都不在這一類裡，只用它們
      仍然寫得出一則看起來是空的留言。那是另一張沒有盡頭的清單，這裡不追。
    """
    kept = "".join(ch for ch in value if ch == _ZWJ or unicodedata.category(ch) != "Cf")
    return _STRAY_ZWJ.sub("", kept)


def single_line(value: str) -> str:
    """把一段不可信的文字變成一行：控制字元與行分隔換成空白、看不見的格式字元拿掉
    （`_drop_format_characters`）、連續空白併成一個、去頭尾。

    用在三種來源：模型輸出（AI 多樣估算的名稱與描述，`app/ai/estimator.py`）、
    會給好友看的使用者輸入（`meals.description`）、留言（`app/schemas/social.py`）。
    **清掉而不是拒絕**：模型輸出被拒絕等於一次已經付費的估算作廢；使用者貼上的文字
    帶換行也不該是 422。清完可能是空字串，由呼叫端決定那代表什麼（留言是 422、
    描述是 NULL）。

    **順序有意義**：控制字元先變成空白，才看 ZWJ 的兩邊——反過來的話，被兩個 NUL 夾住的
    ZWJ 會被當成「夾在兩個字中間」留下來，清完是一個看不見、但不是空的字串。
    """
    return " ".join(_drop_format_characters(_BECOMES_A_SPACE.sub(" ", value)).split())


def _clean_optional_single_line(value: str | None) -> str | None:
    if value is None:
        return None
    # 清完是空的＝沒有內容。存 NULL，不存 ""——畫面與 CSV 只需要分「有」與「沒有」。
    return single_line(value) or None


def clean_display_name(value: str) -> str:
    """顯示名稱：看不見的格式字元拿掉、去頭尾空白；清完是空的、或裡面有控制字元就拒絕。

    **先拿掉格式字元才去頭尾**：反過來的話，「零寬空白＋空白＋阿明」會留下開頭那個空白，
    而只有零寬字的名字會通過「不能只有空白」。

    格式字元是**拿掉**（貼上的文字裡帶一個 BOM 或零寬空白，不該是 422）；控制字元照舊是
    **拒絕**（名字裡出現換行或 NUL 不是手滑貼上的）。跟 `single_line` 不同的地方：
    不併中間的空白——名字是使用者自己打的，不是一段要壓成一行的文字。

    用在註冊、`PATCH /api/me`、邀請的備註（`DisplayName`），以及 CLI 的
    `create-admin`／`create-user`（`app/cli.py`）。**既有的名字不會回頭清**：只有
    下一次寫入才經過這裡。
    """
    value = _drop_format_characters(value).strip()
    if not value:
        raise ValueError("顯示名稱不能只有空白")
    if _CONTROL_CHARACTERS.search(value):
        raise ValueError("顯示名稱不能包含控制字元")
    return value


def _must_be_real_timezone(value: str) -> str:
    # 兩種例外都要接：ZoneInfoNotFoundError 是查無此時區；ValueError 是
    # key 本身不合法 —— ZoneInfo("../../etc/passwd") 走的是這條，因為
    # zoneinfo 自己會擋含 ".." 或以 "/" 開頭的 key。
    #
    # 實測澄清兩者的風險方向（不對稱，而且跟直覺相反）：
    # ZoneInfoNotFoundError 繼承自 KeyError/LookupError，不是 ValueError；
    # 而 Pydantic v2 的 field_validator 會自動把驗證函式內部「任何」逃逸的
    # ValueError/TypeError/AssertionError 轉成乾淨的 422 —— 不限於我們自己
    # raise 的那個。所以只接 ZoneInfoNotFoundError（漏接 ValueError）時，
    # "../../etc/passwd" 的原始 ValueError 仍會被 Pydantic 接住變成 422，
    # 只是 response body 的 msg 會外洩 zoneinfo 內部訊息
    # （"ZoneInfo keys must refer to subdirectories of TZPATH..."）而不是
    # 這裡的中文訊息。真正會變成未處理 500 的是反過來：只接 ValueError、
    # 漏接 ZoneInfoNotFoundError 時，"Mars/Olympus" 這類格式合法但查無
    # 此時區的輸入會直接讓 ZoneInfoNotFoundError 逃出去。兩種都要接，
    # 理由不只一個。
    try:
        ZoneInfo(value)
    except (ZoneInfoNotFoundError, ValueError) as exc:
        raise ValueError("不是合法的 IANA 時區名稱") from exc
    return value


DisplayName = Annotated[str, AfterValidator(clean_display_name)]
IanaTimezone = Annotated[str, AfterValidator(_must_be_real_timezone)]
# `X | None` 的欄位：`None` 與清完是空的都變成 `None`。AfterValidator 綁在整個
# 聯集上，所以函式自己處理 `None`（跟上面 `DisplayName` 綁在 `str` 分支不同——
# 這裡要的正是「空字串也變成 None」）。
OptionalSingleLine = Annotated[str | None, AfterValidator(_clean_optional_single_line)]
