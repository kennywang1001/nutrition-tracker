"""營養標示的文字 → 每 100 的營養素（標示 OCR 規格 §4）。確定性、不呼叫 AI、不碰資料庫。

文字來自手機上的 OCR（Tesseract.js）或使用者貼上的原況文字。**換算與合理性檢查跟 AI 讀標示同一份**
（`app/nutrition_units.py`）：同一張標示走哪一條路都該得到同一組數字（規格 D8）。

讀不完整不是錯誤：回 `LabelText(complete=False, …)`，說讀到什麼、缺什麼、為什麼（規格 D5）。
**不寫 log**：這個模組沒有 logger，例外訊息也不帶文字（規格 D7）。
"""

import re
import unicodedata
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal
from enum import StrEnum
from typing import Literal

from app.models.food import BaseUnit
from app.nutrition_units import (
    MAX_EXTERNAL_NUMBER,
    MAX_KCAL_PER_100,
    kj_to_kcal,
    per_100_from_serving,
    plausible_per_100,
    round_cents,
)

Nutrient = Literal["kcal", "protein_g", "fat_g", "carb_g"]
NUTRIENTS: tuple[Nutrient, ...] = ("kcal", "protein_g", "fat_g", "carb_g")
Reason = Literal[
    "no_values", "columns_unknown", "needs_serving_size", "implausible", "missing_fields"
]
Basis = Literal["per_100", "per_serving"]

# 單一營養素每 100 的上限（不完整時的 `found` 用；完整的一組走 `plausible_per_100`）。
MAX_MACRO_PER_100 = Decimal(100)
MAX_SERVING_SIZE = Decimal(10000)  # 同 DefaultPortionInput.grams
MAX_SERVINGS = Decimal(1000)


class Column(StrEnum):
    SERVING = "serving"
    PER_100 = "per_100"


# ---- 正規化（規格 §4.1）----

_BORDERS = re.compile(r"[|\[\]]")
_SPACE_BEFORE_POINT = re.compile(r"(?<=\d)[ \t]+(?=\.\d)")
_SPACE_AFTER_POINT = re.compile(r"(?<=\d\.)[ \t]+(?=\d)")
_THOUSANDS = re.compile(r"(?<=\d),(?=\d{3}(?!\d))")
_DECIMAL_COMMA = re.compile(r"(?<=\d),(?=\d{1,2}(?!\d))")
_NUMBERISH = re.compile(r"[0-9OoIl.]+")
_LOOKALIKES = str.maketrans({"O": "0", "o": "0", "I": "1", "l": "1"})


def _fix_numberish(match: re.Match[str]) -> str:
    run = match.group()
    # 沒有真的數字的片段是字（Oil、Information），不動。
    if not any("0" <= char <= "9" for char in run):
        return run
    return run.translate(_LOOKALIKES)


def normalize(text: str) -> str:
    """全形 → 半形、表格線 → 空白、小數點兩邊的空白、逗號、數字裡的 O／l。少了小數點不猜。"""
    text = unicodedata.normalize("NFKC", text)  # ｜ 也在這裡變成 |
    text = _BORDERS.sub(" ", text)
    text = _SPACE_BEFORE_POINT.sub("", text)
    text = _SPACE_AFTER_POINT.sub("", text)
    text = _THOUSANDS.sub("", text)
    text = _DECIMAL_COMMA.sub(".", text)
    return _NUMBERISH.sub(_fix_numberish, text)


# ---- 一行裡的數字（規格 §4.2、§4.3）----

Unit = Literal["kcal", "kj", "g", "mg", "ml", "pct"]
_UNITS: dict[str, Unit] = {
    "大卡": "kcal",
    "千卡": "kcal",
    "kcal": "kcal",
    "cal": "kcal",
    "千焦": "kj",
    "kj": "kj",
    "公克": "g",
    "克": "g",
    "g": "g",
    "毫克": "mg",
    "mg": "mg",
    "毫升": "ml",
    "ml": "ml",
    "%": "pct",
}
# 數字前面不能是數字或單獨一個小數點（「1.2.3」的 3、「.5」都不算）；點線（「熱量......514」）
# 可以（審查 M2）。
_VALUE = re.compile(
    r"(?:(?<![\d.])|(?<=\.\.))(\d+(?:\.\d+)?)\s*"
    r"(大卡|千卡|kcal|cal|千焦|kj|公克|克|g|毫克|mg|毫升|ml|%)?",
    re.IGNORECASE,
)


def _bounded(digits: str) -> Decimal | None:
    """一段數字 → Decimal；超過 `MAX_EXTERNAL_NUMBER`（1e6）的是垃圾，不是數字（審查 I2：30 位數的
    數字在 `round_cents` 丟 `InvalidOperation`，端點變成 500）。每一個讀數字的地方都先經過這裡。"""
    value = Decimal(digits)
    return value if value <= MAX_EXTERNAL_NUMBER else None


@dataclass(frozen=True)
class _Token:
    value: Decimal
    unit: Unit | None


def _tokens(line: str) -> list[_Token]:
    tokens: list[_Token] = []
    for match in _VALUE.finditer(line):
        value = _bounded(match.group(1))
        if value is not None:
            unit = None if match.group(2) is None else _UNITS[match.group(2).lower()]
            tokens.append(_Token(value, unit))
    return tokens


_KEYWORDS: dict[Nutrient, re.Pattern[str]] = {
    "kcal": re.compile(r"熱量|能量|熱|energy|calories", re.IGNORECASE),
    "protein_g": re.compile(r"蛋白質|蛋白|白質|protein", re.IGNORECASE),
    "fat_g": re.compile(r"脂肪|脂|fat", re.IGNORECASE),
    "carb_g": re.compile(r"碳水化合物|碳水|水化合物|化合物|carbohydrate|carbs?\b", re.IGNORECASE),
}
_FAT_QUALIFIERS = re.compile(r"飽和|反式|不飽和|saturated|trans|mono|poly", re.IGNORECASE)
# 不是這四種的列：糖、鈉、膳食纖維、每日參考值的說明。帶著它們的行不當成營養素那一列，
# 也不讓「名稱與數字在相鄰兩行」借走它們的數字。
_OTHER_ROWS = re.compile(
    r"鈉|糖|纖維|參考值|sodium|salt|sugar|fib(?:re|er)|daily\s*value", re.IGNORECASE
)
_ENERGY_IN_KCAL = re.compile(r"大卡|千卡|kcal", re.IGNORECASE)
_ENERGY_IN_KJ = re.compile(r"千焦|kj", re.IGNORECASE)


def _nutrients_in(line: str) -> list[Nutrient]:
    found: list[Nutrient] = []
    for nutrient, pattern in _KEYWORDS.items():
        if not pattern.search(line):
            continue
        if nutrient == "fat_g" and _FAT_QUALIFIERS.search(line):
            continue
        found.append(nutrient)
    return found


def _is_row_label(line: str) -> bool:
    return (
        bool(_nutrients_in(line))
        or bool(_OTHER_ROWS.search(line))
        or bool(_FAT_QUALIFIERS.search(line))
    )


@dataclass(frozen=True)
class _Row:
    nutrient: Nutrient
    label: str  # 第一個數字之前的字（`熱量(大卡)` 的單位在這裡）
    tokens: list[_Token]
    line: int  # 名稱那一行是第幾行（找表頭用）


def _rows(lines: list[str]) -> list[_Row]:
    """營養素的每一個候選列，照出現的順序。"""
    rows: list[_Row] = []
    for index, line in enumerate(lines):
        nutrients = _nutrients_in(line)
        # 兩種營養素在同一行（OCR 把兩列併在一起、或每日參考值的說明）→ 不用。
        if len(nutrients) != 1 or _OTHER_ROWS.search(line):
            continue
        first_number = _VALUE.search(line)
        label = line if first_number is None else line[: first_number.start()]
        tokens = _tokens(line)
        # 名稱與數字在相鄰兩行（規格 §4.3）。這一行有數字、只是太大不算數的，不去借下一行的。
        if first_number is None and index + 1 < len(lines) and _lends(lines[index + 1]):
            tokens = _tokens(lines[index + 1])
        if tokens:
            rows.append(_Row(nutrients[0], label, tokens, index))
    return rows


def _lends(line: str) -> bool:
    """這一行的數字能不能借給上一行的名稱：別的列不行；每一份量、份數、表頭也不行（「高蛋白燕麥」
    底下的「每一份量 35 公克」不是蛋白質 35，第二輪審查 I2）。"""
    return not (
        _is_row_label(line)
        or _SERVING_SIZE.search(line)
        or _SERVINGS.search(line)
        or _is_header_line(line)
    )


# ---- 欄（規格 §4.2）----

# 每份那一欄。「每份量」「每一份量」是每一份量（§4.4），不是表頭；`Per 45g bar`、`per 30 g serving`
# 是每份那一欄，也帶著一份的量（審查 C1）。`per 100 g` 在 `_serving_header` 裡跳過。
_HEADER_SERVING = re.compile(
    r"每份(?!量)|每一份(?!量)|per\s*(?:serving|bar|portion)\b|per\s*(\d+(?:\.\d+)?)\s*(g|ml)\b",
    re.IGNORECASE,
)
_HEADER_PER_100 = re.compile(r"每\s*100\s*(公克|克|毫升|g|ml)|per\s*100\s*(g|ml)", re.IGNORECASE)
_HEADER_DV = re.compile(r"參考值|%\s*dv|daily\s*value", re.IGNORECASE)
# 表頭的字後面直接是量（「每份 35 公克」）：那是每一份量。數字後面要有單位：
# 「每份0 每日參考值百分比」的 0 是雜訊，那一行還是表頭（第二輪審查）。
# 用 `\s*(?::\s*)?`、不用 `\s*:?\s*`（一長串空白上是平方時間，審查 M1）。
_AN_AMOUNT = re.compile(r"\s*(?::\s*)?\d+(?:\.\d+)?\s*(?:公克|克|g|毫升|ml)", re.IGNORECASE)
# 只認得一個表頭時，同一行另一邊「像表頭的字」：讀錯的「每份」（`每仿`）、英文的 `per …`。
_HEADER_LIKE = re.compile(r"每|\bper(?![a-z])", re.IGNORECASE)
_STANDARD = [Column.SERVING, Column.PER_100]  # 衛福部的格式：每份、每 100
_PER_100_FIRST = [Column.PER_100, Column.SERVING]


def _plain_values(row: _Row) -> list[Decimal]:
    """不是熱量的那三種：克或沒單位（讀錯的單位也是沒單位）；% 與 mg、ml 不要。"""
    return [token.value for token in row.tokens if token.unit in ("g", None)]


def _serving_header(line: str) -> re.Match[str] | None:
    """一行裡第一個每份那一欄的表頭；`per 100 g` 與後面直接是量的（每一份量）不算。"""
    for match in _HEADER_SERVING.finditer(line):
        if match.group(1) is not None and _bounded(match.group(1)) == 100:
            continue
        if _AN_AMOUNT.match(line, match.end()):
            continue
        return match
    return None


def _is_header_line(line: str) -> bool:
    """有欄的表頭（每份、每 100、每日參考值），而且一個營養素都沒提：不是列，也不是底下的
    「每日參考值：熱量2000大卡…」。"""
    if any(pattern.search(line) for pattern in _KEYWORDS.values()):
        return False
    return bool(_serving_header(line) or _HEADER_PER_100.search(line) or _HEADER_DV.search(line))


@dataclass(frozen=True)
class _Header:
    line: str | None  # 每份／每 100 的表頭在的那一行
    dv: bool  # 表頭有每日參考值那一欄


def _header(lines: list[str], first_row: int) -> _Header:
    """表頭是第一列之前的表頭行（審查 C1、I3）；第一列之前沒有，就用全文的第一個表頭行。
    欄的順序只看其中最後一個有每份／每 100 的那一行，不看整段文字裡第一次出現的位置：
    上面的「每份 35 公克」、說明文字裡的「per serving and per 100 g」都不算。
    每日參考值也只看表頭，不看底下的說明。"""
    headers = [index for index, line in enumerate(lines) if _is_header_line(line)]
    above = [index for index in headers if index < first_row] or headers[:1]
    with_columns = [
        index
        for index in above
        if _serving_header(lines[index]) or _HEADER_PER_100.search(lines[index])
    ]
    return _Header(
        line=lines[with_columns[-1]] if with_columns else None,
        dv=any(_HEADER_DV.search(lines[index]) for index in above),
    )


def _beside(line: str, known: re.Match[str], kind: Column) -> list[Column] | None:
    """只認得一個表頭：同一行只有一邊還有像表頭的字（讀錯的那一個）→ 另一欄在那一邊。
    兩邊都有、都沒有 → 看不出來（審查 C1）。"""
    other = Column.PER_100 if kind is Column.SERVING else Column.SERVING
    before = _HEADER_LIKE.search(line[: known.start()]) is not None
    after = _HEADER_LIKE.search(line[known.end() :]) is not None
    if after and not before:
        return [kind, other]
    if before and not after:
        return [other, kind]
    return None


# 欄的順序從哪裡來：兩個表頭都在表頭那一行（`read`，交叉檢查不換）、從單獨一個表頭推的
# （`inferred`）、讀不到（`unknown`）。後兩種由交叉檢查定（第二輪審查 I1）。
Order = Literal["read", "inferred", "unknown"]


def _columns(header: _Header, rows: list[_Row]) -> tuple[list[Column] | None, Order]:
    """(欄, 順序從哪裡來)。讀不到順序的兩欄先排成衛福部的「每份、每 100」，
    要靠每一份量交叉檢查才定得下來（`parse_label_text`）。一欄的不用排，算 `read`。"""
    line = header.line
    serving = None if line is None else _serving_header(line)
    per_100 = None if line is None else _HEADER_PER_100.search(line)
    if serving and per_100:
        return (_STANDARD if serving.start() < per_100.start() else _PER_100_FIRST), "read"
    # 只讀到一個（或零個）表頭：至少兩列剛好兩個數字、而且沒有每日參考值那一欄，才是兩欄。
    # 有每日參考值時第二個數字可能是讀丟了 % 的百分比，不能猜。
    two_values = sum(1 for row in rows if row.nutrient != "kcal" and len(_plain_values(row)) == 2)
    if not header.dv and two_values >= 2:
        known = serving or per_100
        if line is not None and known is not None:
            beside = _beside(line, known, Column.SERVING if serving else Column.PER_100)
            if beside is not None:
                return beside, "inferred"
        return _STANDARD, "unknown"
    if serving:
        return [Column.SERVING], "read"
    if per_100:
        return [Column.PER_100], "read"
    return None, "unknown"


def _fit(values: list[Decimal], width: int, cut: bool) -> list[Decimal] | None:
    """`cut`：表頭有每日參考值那一欄、而且這一列自己沒有帶 % 的數字——剛好多一個時，多的那個
    是讀丟了 % 的百分比（它在最後面）。帶著 % 的列多出來的是拆開的數字（「1 9.0」），不砍
    （審查 I3）。"""
    if len(values) == width:
        return values
    if cut and len(values) == width + 1:
        return values[:width]
    return None


def _energy(row: _Row, width: int, cut: bool) -> list[Decimal] | None:
    kcal = [token.value for token in row.tokens if token.unit == "kcal"]
    kj = [token.value for token in row.tokens if token.unit == "kj"]
    if len(kcal) == width:
        return kcal
    if len(kj) == width:
        return [kj_to_kcal(value) for value in kj]
    bare = [token.value for token in row.tokens if token.unit is None]
    if _ENERGY_IN_KCAL.search(row.label):
        return _fit(bare, width, cut)
    if _ENERGY_IN_KJ.search(row.label):
        fitted = _fit(bare, width, cut)
        return None if fitted is None else [kj_to_kcal(value) for value in fitted]
    return None  # 熱量沒有單位：不猜是 kcal 還是 kJ


def _read_columns(
    rows: list[_Row], columns: list[Column], dv: bool
) -> dict[Column, dict[Nutrient, Decimal]]:
    result: dict[Column, dict[Nutrient, Decimal]] = {column: {} for column in columns}
    done: set[Nutrient] = set()
    for row in rows:
        if row.nutrient in done:
            continue  # 同一種有好幾行：用第一行分得出欄的
        cut = dv and not any(token.unit == "pct" for token in row.tokens)
        if row.nutrient == "kcal":
            values = _energy(row, len(columns), cut)
        else:
            values = _fit(_plain_values(row), len(columns), cut)
        if values is None:
            continue
        done.add(row.nutrient)
        for column, value in zip(columns, values, strict=True):
            result[column][row.nutrient] = round_cents(value)
    return result


# ---- 每一份量、份數、單位（規格 §4.4）----

# 冒號前後的空白是 `\s*(?::\s*)?`：`\s*:?\s*` 在一長串空白上是平方時間（審查 M1）。
_SERVING_SIZE = re.compile(
    r"(?:每一?份量?|serving\s*size)\s*(?::\s*)?(\d+(?:\.\d+)?)\s*(公克|克|g|毫升|ml)",
    re.IGNORECASE,
)
_SERVINGS = re.compile(
    r"本包.{0,3}?(\d+(?:\.\d+)?)\s*份"
    r"|servings?\s*per\s*(?:package|container|pack)\s*(?::\s*)?(?:about\s*)?(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def _unit_of(word: str) -> BaseUnit:
    return BaseUnit.ML if word.lower() in ("毫升", "ml") else BaseUnit.G


def _size(digits: str, unit: str) -> tuple[Decimal, BaseUnit] | None:
    value = _bounded(digits)
    if value is None:
        return None
    size = round_cents(value)
    if not Decimal(0) < size <= MAX_SERVING_SIZE:
        return None
    return size, _unit_of(unit)


def _serving_size(text: str, header: str | None) -> tuple[Decimal, BaseUnit] | None:
    """「每一份量 35 公克」；沒有的話，表頭裡的量（`Per 45g bar`，審查 C1）。"""
    match = _SERVING_SIZE.search(text)
    if match is not None:
        return _size(match.group(1), match.group(2))
    serving = None if header is None else _serving_header(header)
    if serving is not None and serving.group(1) is not None:
        return _size(serving.group(1), serving.group(2))
    return None


def _servings(text: str) -> Decimal | None:
    match = _SERVINGS.search(text)
    if match is None:
        return None
    value = _bounded(match.group(1) or match.group(2))
    if value is None:
        return None
    count = round_cents(value)
    return count if Decimal(0) < count <= MAX_SERVINGS else None


# ---- 兩欄的交叉檢查（審查 C1）----

_HUNDRED = Decimal(100)
# 容許差＝兩邊各自印出來的半格（每份那一邊乘上 100 ÷ 一份）＋ 兩者較大的 3%（第二輪審查改過）：
# - 半格：熱量印成整數的是 0.5，其他（一位小數）是 0.05。
# - 「可以標 0」（衛福部「包裝食品營養標示應遵行事項」附表二，門檻是每 100 公克／毫升）：熱量
#   ≤ 4 大卡、蛋白質／脂肪／碳水化合物 ≤ 0.5 公克。**只在有一邊印成 0 時**才加這個寬容。
# - 3%：兩欄各自從沒進位的數字算；歐盟 10 公克以上印整數（17 公克以上半公克就在 3% 內）。
#   每 100 是 6.8 時是 0.20，加上半格（一份 35 公克）0.40——6.0 讀成 6.8 擋得住。
# 排反的兩欄差 (100 ÷ 一份)² 倍（35 公克是 8 倍、90 公克也還有 23%），遠在這之外。
_HALF_STEP_WHOLE = Decimal("0.5")
_HALF_STEP_TENTH = Decimal("0.05")
_PRINTED_AS_ZERO: dict[Nutrient, Decimal] = {
    "kcal": Decimal(4),
    "protein_g": Decimal("0.5"),
    "fat_g": Decimal("0.5"),
    "carb_g": Decimal("0.5"),
}
_RELATIVE = Decimal("0.03")
# 一種排法要至少兩項對得起來才算數：一項可能是碰巧（每一份量讀錯時的蛋白質，第二輪審查 I1）。
_MIN_AGREEING = 2


def _half_step(nutrient: Nutrient, value: Decimal) -> Decimal:
    """印出來的那個數字的半格：整數的熱量 0.5，其他 0.05（營養素一律當成印到一位小數）。"""
    if nutrient == "kcal" and value == value.to_integral_value():
        return _HALF_STEP_WHOLE
    return _HALF_STEP_TENTH


def _agrees(nutrient: Nutrient, per_100: Decimal, per_serving: Decimal, size: Decimal) -> bool:
    """每 100 ≈ 每份 × 100 ÷ 一份。"""
    scale = _HUNDRED / size
    expected = per_serving * scale
    tolerance = (
        _half_step(nutrient, per_serving) * scale
        + _half_step(nutrient, per_100)
        + _RELATIVE * max(per_100, expected)
    )
    if per_100.is_zero() or per_serving.is_zero():
        tolerance += _PRINTED_AS_ZERO[nutrient]
    return abs(per_100 - expected) <= tolerance


def _agreeing(
    per_100: Mapping[Nutrient, Decimal], per_serving: Mapping[Nutrient, Decimal], size: Decimal
) -> frozenset[Nutrient]:
    """對得起來的項目；不到 `_MIN_AGREEING` 項就當成一項都沒有。"""
    common = per_100.keys() & per_serving.keys()
    agree = frozenset(n for n in common if _agrees(n, per_100[n], per_serving[n], size))
    return agree if len(agree) >= _MIN_AGREEING else frozenset()


# ---- 結果 ----


@dataclass(frozen=True)
class LabelText:
    """`found` 是**每 100**（g 或 ml，看 `base_unit`），讀不到的是 None；`complete` 時四個都有、
    驗過範圍與物理上限。`serving_size` 只在它的單位跟 `base_unit` 一樣時才有。"""

    complete: bool
    base_unit: BaseUnit
    found: Mapping[Nutrient, Decimal | None]
    missing: tuple[Nutrient, ...]
    reason: Reason | None
    basis: Basis | None
    serving_size: Decimal | None
    servings_per_package: Decimal | None


def _sane(nutrient: Nutrient, value: Decimal) -> bool:
    limit = MAX_KCAL_PER_100 if nutrient == "kcal" else MAX_MACRO_PER_100
    return value <= limit


def parse_label_text(text: str) -> LabelText:
    """營養標示的文字 → `LabelText`。純函式；任何輸入都不丟例外。"""
    normalized = normalize(text)
    lines = [line.strip() for line in normalized.split("\n") if line.strip()]
    rows = _rows(lines)
    header = _header(lines, rows[0].line if rows else len(lines))
    columns, order = _columns(header, rows)
    read = _read_columns(rows, columns, header.dv) if columns is not None else {}

    serving = _serving_size(normalized, header.line)
    # 單位先看表頭那一行；它沒有每 100 才看全文（上面一句「每100毫升含…」的說明不算，第二輪審查）。
    per_100_header = (
        None if header.line is None else _HEADER_PER_100.search(header.line)
    ) or _HEADER_PER_100.search(normalized)
    if per_100_header is not None:
        base_unit = _unit_of(per_100_header.group(1) or per_100_header.group(2))
    elif serving is not None:
        base_unit = serving[1]
    else:
        base_unit = BaseUnit.G
    size = serving[0] if serving is not None and serving[1] == base_unit else None
    servings = _servings(normalized)

    per_100 = read.get(Column.PER_100, {})
    per_serving = read.get(Column.SERVING, {})

    def result(
        found: Mapping[Nutrient, Decimal | None], reason: Reason | None, basis: Basis | None
    ) -> LabelText:
        missing = tuple(nutrient for nutrient in NUTRIENTS if found.get(nutrient) is None)
        return LabelText(
            complete=reason is None,
            base_unit=base_unit,
            found={nutrient: found.get(nutrient) for nutrient in NUTRIENTS},
            missing=missing,
            reason=reason,
            basis=basis,
            serving_size=size,
            servings_per_package=servings,
        )

    # 交叉檢查（審查 C1、第二輪 I1）：兩欄都有、知道一份多少 → 每 100 ≈ 每份 × 100 ÷ 一份。
    # 兩個表頭都讀到（`read`）就照表頭、不換；順序是推的或讀不到，對得起來的項目比較多的那一種
    # 排法就是順序。對得起來的不到兩項 → 哪一欄都不信。兩欄、順序讀不到、又不能交叉檢查 → 不猜。
    contradicted: frozenset[Nutrient] = frozenset()
    if per_100 and per_serving and size is not None:
        agree = _agreeing(per_100, per_serving, size)
        if order != "read":
            swapped = _agreeing(per_serving, per_100, size)
            if len(swapped) > len(agree):
                per_100, per_serving, agree = per_serving, per_100, swapped
        if not agree:
            return result({}, "columns_unknown" if order == "unknown" else "implausible", None)
        contradicted = frozenset(per_100.keys() - agree)
    elif columns is not None and order == "unknown":
        return result({}, "columns_unknown", None)

    converted = (
        {nutrient: per_100_from_serving(value, size) for nutrient, value in per_serving.items()}
        if size is not None
        else {}
    )

    def side(nutrient: Nutrient) -> Basis | None:
        """對不起來的那一項：只有一邊在物理上限內 → 那一邊；不然分不出哪一欄錯。"""
        # 不變式：兩欄的每一列都是一起讀的（`_read_columns` 的 zip），所以 per_100、per_serving
        # 與 converted 的 key 一樣；contradicted 只在有一份的量時非空，converted 一定有這一項。
        in_per_100 = _sane(nutrient, per_100[nutrient])
        in_converted = _sane(nutrient, converted[nutrient])
        if in_per_100 == in_converted:
            return None
        return "per_100" if in_per_100 else "per_serving"

    # 選欄（規格 D9）：完整而且合理的每 100 → 完整而且合理的每份（換算過）→ 不完整。對不起來的
    # 項目要每一項都是這一欄贏（另一欄的值超過物理上限），這一欄才能用。
    implausible = blocked = False
    candidates: list[tuple[Basis, dict[Nutrient, Decimal]]] = [
        ("per_100", per_100),
        ("per_serving", converted),
    ]
    for basis, values in candidates:
        if len(values) != len(NUTRIENTS):
            continue
        checked = plausible_per_100(
            base_unit, values["kcal"], values["protein_g"], values["fat_g"], values["carb_g"]
        )
        if checked is None:
            implausible = True
            continue
        if any(side(nutrient) != basis for nutrient in contradicted):
            blocked = True
            continue
        return result(
            {
                "kcal": checked.kcal,
                "protein_g": checked.protein_g,
                "fat_g": checked.fat_g,
                "carb_g": checked.carb_g,
            },
            None,
            basis,
        )

    if implausible and not blocked:
        return result({}, "implausible", None)
    if columns is None:
        return result({}, "columns_unknown" if rows else "no_values", None)
    if not per_100 and not per_serving:
        return result({}, "no_values", None)
    if len(per_serving) > len(per_100) and size is None:
        return result({}, "needs_serving_size", None)
    best_basis: Basis = "per_100" if len(per_100) >= len(converted) else "per_serving"
    best = per_100 if best_basis == "per_100" else converted
    sane = {
        nutrient: value
        for nutrient, value in best.items()
        if _sane(nutrient, value) and (nutrient not in contradicted or side(nutrient) == best_basis)
    }
    return result(sane, "missing_fields", None)
