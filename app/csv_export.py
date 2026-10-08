"""CSV 的寫法只有這一份（報表月份與匯出規格 §3.3）。

三支匯出端點都經過 `encode_header` / `encode_rows`——引號、換行、公式字元的處理
不會有第二種寫法。這個模組不碰資料庫，也不知道欄位的意思。

**儲存格的型別決定它怎麼寫，不是「第幾欄」決定：**

- `str`：文字。開頭是公式字元（`FORMULA_TRIGGERS`）的前面加一個單引號——Excel、
  Numbers、Google 試算表打開 CSV 時會把 `=`、`+`、`-`、`@` 開頭的儲存格當公式算
  （CSV injection）。備註、食物名稱都是使用者自己打的字，匯出的檔案也可能轉給別人。
- `Decimal`：數字。用 `format(value, "f")` 寫成一般的小數（不會是 `1E+2`），
  **不加單引號**——它不可能是公式，加了反而讓試算表把數字當文字、不能加總。
  資料庫的 CHECK 保證金額、份量、劑量都 > 0；就算哪天出現負數，`-5.00` 也只是一個數字。
- `None`：空的儲存格。

所以呼叫端不能把使用者的文字轉成別的型別再丟進來，也不需要記得「哪幾欄要擋」。
"""

import csv
import io
from collections.abc import Iterable, Sequence
from decimal import Decimal

# Excel 靠開頭的 BOM 才知道這是 UTF-8；沒有的話中文會被當成系統的 ANSI 編碼（亂碼）。
UTF8_BOM = "\ufeff".encode()

# OWASP 的清單：= + - @、Tab、CR；LF 跟 CR 同一類（開頭的控制字元會被試算表吃掉，
# 後面的 `=` 就變成開頭），一起擋。
FORMULA_TRIGGERS = ("=", "+", "-", "@", "\t", "\r", "\n")

Cell = str | Decimal | None


def guard_text(value: str) -> str:
    """開頭是公式字元的文字，前面加一個單引號；其他原樣回傳。"""
    if value.startswith(FORMULA_TRIGGERS):
        return "'" + value
    return value


def _render(cell: Cell) -> str:
    if cell is None:
        return ""
    if isinstance(cell, Decimal):
        return format(cell, "f")
    return guard_text(cell)


def encode_rows(rows: Iterable[Sequence[Cell]]) -> bytes:
    """幾列資料 → UTF-8 的 CSV 位元組（RFC 4180：逗號分隔、CRLF 換行、必要時加雙引號）。

    引號交給標準函式庫的 `csv`：含逗號、雙引號、換行的儲存格會被包起來，
    裡面的雙引號變成兩個。
    """
    buffer = io.StringIO(newline="")
    writer = csv.writer(buffer, lineterminator="\r\n")
    for row in rows:
        writer.writerow([_render(cell) for cell in row])
    return buffer.getvalue().encode("utf-8")


def encode_header(columns: Sequence[str]) -> bytes:
    """檔案的第一塊：BOM ＋ 標題列。"""
    return UTF8_BOM + encode_rows([columns])
