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
from typing import Annotated
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import AfterValidator

# C0 控制字元 + DEL + C1。顯示用名稱裡不該出現任何一個。
# 其中 \x00 特別重要：它通得過 Pydantic，然後被 PostgreSQL 拒收，
# 變成一個未經認證就能觸發的 500。
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")

# 會顯示給別人（好友）、寫進 CSV 的單行文字裡不該留下的字元：C0／DEL／C1 控制字元
# （含換行與 Tab）、行／段分隔（U+2028、U+2029）、雙向控制字元（U+202A～U+202E、
# U+2066～U+2069——它們能讓一段文字在畫面上倒著顯示）。
# **不含 ZWJ（U+200D）**：表情符號的組合序列靠它。
_UNSAFE_FOR_DISPLAY = re.compile(
    r"[\x00-\x1f\x7f-\x9f\u2028\u2029\u202a-\u202e\u2066-\u2069]"
)


def single_line(value: str) -> str:
    """把一段不可信的文字變成一行：不安全的字元換成空白、連續空白併成一個、去頭尾。

    用在兩種來源：模型輸出（AI 多樣估算的名稱與描述，`app/ai/estimator.py`）、
    以及會給好友看的使用者輸入（`meals.description`）。**換掉而不是拒絕**：
    模型輸出被拒絕等於一次已經付費的估算作廢；使用者貼上的文字帶換行也不該是 422。
    清完可能是空字串，由呼叫端決定那代表什麼。
    """
    return " ".join(_UNSAFE_FOR_DISPLAY.sub(" ", value).split())


def _clean_optional_single_line(value: str | None) -> str | None:
    if value is None:
        return None
    # 清完是空的＝沒有內容。存 NULL，不存 ""——畫面與 CSV 只需要分「有」與「沒有」。
    return single_line(value) or None


def _clean_display_name(value: str) -> str:
    value = value.strip()
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


DisplayName = Annotated[str, AfterValidator(_clean_display_name)]
IanaTimezone = Annotated[str, AfterValidator(_must_be_real_timezone)]
# `X | None` 的欄位：`None` 與清完是空的都變成 `None`。AfterValidator 綁在整個
# 聯集上，所以函式自己處理 `None`（跟上面 `DisplayName` 綁在 `str` 分支不同——
# 這裡要的正是「空字串也變成 None」）。
OptionalSingleLine = Annotated[str | None, AfterValidator(_clean_optional_single_line)]
