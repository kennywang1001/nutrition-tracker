"""商品條碼的正規化與檢查碼（掃條碼規格 §3）。純函式，不碰資料庫。

存進 `foods.barcode` 的、拿去查的、送給 Open Food Facts 的，一律是 `normalize_barcode()` 的輸出：
8 位（EAN-8）或 13 位（EAN-13；UPC-A 與 UPC-E 都換成這個）。同一個商品掃成 UPC-A 或 EAN-13、
手打 UPC-E 或展開後的 UPC-A，都會是同一個字串——不然查不到自己建過的那一筆。

**檢查碼只在這裡驗**（規格 D3）：前端只去分隔符號、看長度。
"""

import re
import unicodedata

# 空白（含全形空白，`\s` 認 Unicode 的空白）與「-」。
_SEPARATORS = re.compile(r"[\s\-]+")
# NFKC 之後只收 ASCII 數字：`str.isdigit()` 還認其他文字的數字，那些不是條碼。
# （上標數字 NFKC 會折成一般數字——沒有人會那樣打條碼，折了也無害。）
_DIGITS = re.compile(r"[0-9]+")


class InvalidBarcodeError(ValueError):
    """不是 EAN-13／EAN-8／UPC-A／UPC-E，或檢查碼不對。訊息直接給人看（422 的欄位錯誤）。"""


def gtin_check_digit(body: str) -> int:
    """GS1 的 mod-10：不含檢查碼的那幾位，**從右邊數**，第 1、3、5…位 ×3，其餘 ×1；
    檢查碼＝(10 − 總和 mod 10) mod 10。EAN-13、EAN-8、UPC-A 都是這一條。

    `body` 只能是 ASCII 數字（呼叫端驗過）。`"471008843209"` → 4。
    """
    total = 0
    for index, char in enumerate(reversed(body)):
        digit = ord(char) - 48
        total += digit * 3 if index % 2 == 0 else digit
    return (10 - total % 10) % 10


def _has_valid_check_digit(code: str) -> bool:
    return gtin_check_digit(code[:-1]) == ord(code[-1]) - 48


def expand_upc_e(code: str) -> str:
    """8 位的 UPC-E（數字系統＋6 位＋檢查碼）→ 12 位的 UPC-A。不驗檢查碼。

    看第 6 位（`d[5]`）：0～2 → 製造商 `d0 d1 d[5] 0 0`、商品 `0 0 d2 d3 d4`；3 → `d0 d1 d2 0 0`、
    `0 0 0 d3 d4`；4 → `d0 d1 d2 d3 0`、`0 0 0 0 d4`；5～9 → `d0 d1 d2 d3 d4`、`0 0 0 0 d[5]`。
    `"04252614"` → `"042100005264"`。
    """
    system, d, check = code[0], code[1:7], code[7]
    last = d[5]
    if last in "012":
        body = d[0:2] + last + "0000" + d[2:5]
    elif last == "3":
        body = d[0:3] + "00000" + d[3:5]
    elif last == "4":
        body = d[0:4] + "00000" + d[4]
    else:
        body = d[0:5] + "0000" + last
    return system + body + check


def normalize_barcode(raw: str) -> str:
    """去掉空白與「-」、驗檢查碼，回標準形式（規格 §3.2）：

    - 13 位：EAN-13，原樣。
    - 12 位：UPC-A，前面補 0 成 13 位（UPC-A 就是第一位是 0 的 EAN-13）。
    - 8 位、0 開頭：先當 UPC-E（展開成 UPC-A、驗它的檢查碼、補 0 成 13 位）；不合格才當 EAN-8。
    - 其餘 8 位：EAN-8，原樣。

    同樣 8 位永遠得到同樣的結果——掃描器回報 `upc_e` 或 `ean_8`、手動輸入，存的跟查的一定一致。
    不合格丟 `InvalidBarcodeError`。
    """
    # NFKC 先把全形數字（「５９０１…」，中文輸入法常見）與全形的「－」折成 ASCII（審查 M6）。
    # 其他文字的數字（例如阿拉伯－印度數字）NFKC 不折，照舊被下面的 `_DIGITS` 拒絕。
    code = _SEPARATORS.sub("", unicodedata.normalize("NFKC", raw))
    if not _DIGITS.fullmatch(code):
        raise InvalidBarcodeError("條碼只能是數字")
    if len(code) == 13:
        if _has_valid_check_digit(code):
            return code
    elif len(code) == 12:
        if _has_valid_check_digit(code):
            return "0" + code
    elif len(code) == 8:
        if code[0] == "0":
            upc_a = expand_upc_e(code)
            if _has_valid_check_digit(upc_a):
                return "0" + upc_a
        if _has_valid_check_digit(code):
            return code
    else:
        raise InvalidBarcodeError("條碼要是 8、12 或 13 位數字")
    raise InvalidBarcodeError("條碼的檢查碼不對，請再確認一次")
