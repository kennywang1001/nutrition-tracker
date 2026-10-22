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
_VALUE = re.compile(
    r"(?<![\d.])(\d+(?:\.\d+)?)\s*(大卡|千卡|kcal|cal|千焦|kj|公克|克|g|毫克|mg|毫升|ml|%)?",
    re.IGNORECASE,
)


@dataclass(frozen=True)
class _Token:
    value: Decimal
    unit: Unit | None


def _tokens(line: str) -> list[_Token]:
    return [
        _Token(
            Decimal(match.group(1)),
            None if match.group(2) is None else _UNITS[match.group(2).lower()],
        )
        for match in _VALUE.finditer(line)
    ]


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
        if not tokens and index + 1 < len(lines) and not _is_row_label(lines[index + 1]):
            # 名稱與數字在相鄰兩行（規格 §4.3）。
            tokens = _tokens(lines[index + 1])
        if tokens:
            rows.append(_Row(nutrients[0], label, tokens))
    return rows


# ---- 欄（規格 §4.2）----

_HEADER_SERVING = re.compile(r"每份|每一份(?!量)|per\s*serving", re.IGNORECASE)
_HEADER_PER_100 = re.compile(r"每\s*100\s*(公克|克|毫升|g|ml)|per\s*100\s*(g|ml)", re.IGNORECASE)
_HEADER_DV = re.compile(r"參考值|%\s*dv|daily\s*value", re.IGNORECASE)
_STANDARD = [Column.SERVING, Column.PER_100]  # 衛福部的格式：每份、每 100


def _plain_values(row: _Row) -> list[Decimal]:
    """不是熱量的那三種：克或沒單位（讀錯的單位也是沒單位）；% 與 mg、ml 不要。"""
    return [token.value for token in row.tokens if token.unit in ("g", None)]


def _columns(text: str, rows: list[_Row]) -> list[Column] | None:
    serving = _HEADER_SERVING.search(text)
    per_100 = _HEADER_PER_100.search(text)
    if serving and per_100:
        return _STANDARD if serving.start() < per_100.start() else [Column.PER_100, Column.SERVING]
    dv = _HEADER_DV.search(text) is not None
    # 只讀到一個（或零個）表頭：至少兩列剛好兩個數字、而且沒有每日參考值那一欄，才照衛福部的
    # 順序當成「每份、每 100」。有每日參考值時第二個數字可能是讀丟了 % 的百分比，不能猜。
    two_values = sum(1 for row in rows if row.nutrient != "kcal" and len(_plain_values(row)) == 2)
    if not dv and two_values >= 2:
        return _STANDARD
    if serving:
        return [Column.SERVING]
    if per_100:
        return [Column.PER_100]
    return None


def _fit(values: list[Decimal], width: int, dv: bool) -> list[Decimal] | None:
    if len(values) == width:
        return values
    if len(values) > width and dv:
        return values[:width]  # 每日參考值那一欄讀丟了 %：它在最後面
    return None


def _energy(row: _Row, width: int, dv: bool) -> list[Decimal] | None:
    kcal = [token.value for token in row.tokens if token.unit == "kcal"]
    kj = [token.value for token in row.tokens if token.unit == "kj"]
    if len(kcal) == width:
        return kcal
    if len(kj) == width:
        return [kj_to_kcal(value) for value in kj]
    bare = [token.value for token in row.tokens if token.unit is None]
    if _ENERGY_IN_KCAL.search(row.label):
        return _fit(bare, width, dv)
    if _ENERGY_IN_KJ.search(row.label):
        fitted = _fit(bare, width, dv)
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
        if row.nutrient == "kcal":
            values = _energy(row, len(columns), dv)
        else:
            values = _fit(_plain_values(row), len(columns), dv)
        if values is None:
            continue
        done.add(row.nutrient)
        for column, value in zip(columns, values, strict=True):
            result[column][row.nutrient] = round_cents(value)
    return result


# ---- 每一份量、份數、單位（規格 §4.4）----

_SERVING_SIZE = re.compile(
    r"(?:每一?份量?|serving\s*size)\s*:?\s*(\d+(?:\.\d+)?)\s*(公克|克|g|毫升|ml)", re.IGNORECASE
)
_SERVINGS = re.compile(
    r"本包.{0,3}?(\d+(?:\.\d+)?)\s*份"
    r"|servings?\s*per\s*(?:package|container|pack)\s*:?\s*(?:about\s*)?(\d+(?:\.\d+)?)",
    re.IGNORECASE,
)


def _unit_of(word: str) -> BaseUnit:
    return BaseUnit.ML if word.lower() in ("毫升", "ml") else BaseUnit.G


def _serving_size(text: str) -> tuple[Decimal, BaseUnit] | None:
    match = _SERVING_SIZE.search(text)
    if match is None:
        return None
    size = round_cents(Decimal(match.group(1)))
    if not Decimal(0) < size <= MAX_SERVING_SIZE:
        return None
    return size, _unit_of(match.group(2))


def _servings(text: str) -> Decimal | None:
    match = _SERVINGS.search(text)
    if match is None:
        return None
    count = round_cents(Decimal(match.group(1) or match.group(2)))
    return count if Decimal(0) < count <= MAX_SERVINGS else None


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
    columns = _columns(normalized, rows)
    dv = _HEADER_DV.search(normalized) is not None
    read = _read_columns(rows, columns, dv) if columns is not None else {}

    serving = _serving_size(normalized)
    per_100_header = _HEADER_PER_100.search(normalized)
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
    converted = (
        {nutrient: per_100_from_serving(value, size) for nutrient, value in per_serving.items()}
        if size is not None
        else {}
    )

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

    # 選欄（規格 D9）：完整而且合理的每 100 → 完整而且合理的每份（換算過）→ 不完整。
    implausible = False
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

    if implausible:
        return result({}, "implausible", None)
    if columns is None:
        return result({}, "columns_unknown" if rows else "no_values", None)
    if not per_100 and not per_serving:
        return result({}, "no_values", None)
    if len(per_serving) > len(per_100) and size is None:
        return result({}, "needs_serving_size", None)
    best = per_100 if len(per_100) >= len(converted) else converted
    sane = {nutrient: value for nutrient, value in best.items() if _sane(nutrient, value)}
    return result(sane, "missing_fields", None)
