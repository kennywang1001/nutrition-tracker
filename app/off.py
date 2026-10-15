"""Open Food Facts：條碼查不到看得到的食物時，問公開的食品資料庫要一份**預填建議**（規格 §6）。

**只讀、不建任何東西。** 回的是給新增食物預填的名稱、品牌、單位、每 100 的營養素、一份；
使用者確認之後才會變成他自己的食物。

- 授權：OFF 的資料庫是 ODbL。畫面上有這些資料的地方都標「資料來源：Open Food Facts（ODbL）」
  （規格 §6.4）。
- 隱私：條碼會從伺服器送到 OFF（第三方）。這個模組**不記條碼**（log 只記失敗的種類）；
  `OFF_ENABLED=false` 整個關掉（`app/api/routes/foods.py` 的 `get_product_lookup`）。
- 失敗一律是「沒有建議」：連不上、逾時、非 200、看不懂、缺欄位、數字超出新增食物的範圍。
- 測試不打網路：路由用 `get_product_lookup` 注入假的；conftest 把 `_http_get` 換成會丟
  `AssertionError` 的（漏了覆寫的測試會紅，不會安靜地打出去）。
"""

import json
import logging
import re
import time
from collections import OrderedDict
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from decimal import Decimal
from typing import Literal, Protocol

import httpx
from pydantic import ValidationError

from app.models.food import BaseUnit
from app.nutrition_units import kj_to_kcal, round_cents, to_decimal
from app.schemas.food import NutritionInput
from app.schemas.validators import single_line

logger = logging.getLogger(__name__)

OFF_PRODUCT_URL = "https://world.openfoodfacts.org/api/v2/product/{code}.json"
# 只要這幾個欄位（規格 §6.2）。少拿＝回應小、OFF 那邊省事。
OFF_FIELDS = "product_name,product_name_zh,brands,nutriments,serving_size,product_quantity_unit"
# OFF 要 API 使用者表明身分（名稱／版本＋聯絡方式）。聯絡方式是 repo，不放任何人的 email。
USER_AGENT = "nutrition-tracker/1.0 (+https://github.com/kennywang1001/nutrition-tracker)"
TIMEOUT_SECONDS = 4.0
# 這幾個欄位的回應只有幾 KB；超過 1 MB 一定不對，不解析。
MAX_RESPONSE_BYTES = 1_000_000

CACHE_SIZE = 500
CACHE_TTL_SECONDS = 24 * 60 * 60.0

_MAX_TEXT = 100
# "30 g"、"250ml"、"33,5 g"；"1 piece (30 g)" 不算（開頭不是「數字＋單位」）。
_SERVING = re.compile(r"^\s*(\d+(?:[.,]\d+)?)\s*(g|ml)\b", re.IGNORECASE)


@dataclass(frozen=True)
class Per100:
    kcal: Decimal
    protein_g: Decimal
    fat_g: Decimal
    carb_g: Decimal


@dataclass(frozen=True)
class Serving:
    amount: Decimal
    unit: BaseUnit


@dataclass(frozen=True)
class ProductPrefill:
    """給新增食物的預填建議。`name`／`brand` 可以是 None（OFF 沒有，使用者自己填）。"""

    name: str | None
    brand: str | None
    base_unit: BaseUnit
    per100: Per100
    serving: Serving | None
    source: Literal["openfoodfacts"] = "openfoodfacts"


@dataclass(frozen=True)
class FetchResult:
    """一次 HTTP 的結果：狀態碼與已經解析的 JSON（不是 JSON、太大 → `body` 是 None）。"""

    status: int
    body: object


Fetcher = Callable[[str], Awaitable[FetchResult]]


class ProductLookup(Protocol):
    async def lookup(self, code: str) -> ProductPrefill | None: ...


def _clean_text(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    cleaned = single_line(value)[:_MAX_TEXT].rstrip()
    return cleaned or None


def _first_brand(value: object) -> str | None:
    if not isinstance(value, str):
        return None
    return _clean_text(value.split(",")[0])


def _energy_kcal(nutriments: dict[str, object]) -> Decimal | None:
    kcal = to_decimal(nutriments.get("energy-kcal_100g"))
    if kcal is not None:
        return kcal
    # `energy_100g` 在 OFF 裡就是 kJ（沒有單位後綴的那個）。
    kj = to_decimal(nutriments.get("energy-kj_100g"))
    if kj is None:
        kj = to_decimal(nutriments.get("energy_100g"))
    return None if kj is None else kj_to_kcal(kj)


def _serving(value: object, base_unit: BaseUnit) -> Serving | None:
    if not isinstance(value, str):
        return None
    match = _SERVING.match(value)
    if match is None:
        return None
    unit = BaseUnit(match.group(2).lower())
    # 單位跟食物的不一樣（例如飲料標成 g）就不預填一份：換算要密度，猜錯比不填糟。
    if unit is not base_unit:
        return None
    amount = to_decimal(match.group(1).replace(",", "."))
    if amount is None or amount <= 0 or amount > 10000:
        return None
    return Serving(amount=round_cents(amount), unit=unit)


def prefill_from_product(payload: object) -> ProductPrefill | None:
    """OFF 的回應（已經 `json.loads`）→ 預填建議；用不上就 None。純函式。

    能量（kcal，或 kJ 換算）與三大營養素**都要有**，而且四捨五入到兩位之後要過 `NutritionInput`
    （跟新增食物同一組範圍）——缺一個就整個不要（規格 D9）：半套的數字比沒有更容易被當成真的存下去。
    """
    if not isinstance(payload, dict) or payload.get("status") != 1:
        return None
    product = payload.get("product")
    if not isinstance(product, dict):
        return None
    nutriments = product.get("nutriments")
    if not isinstance(nutriments, dict):
        return None

    base_unit = BaseUnit.ML if product.get("product_quantity_unit") == "ml" else BaseUnit.G
    kcal = _energy_kcal(nutriments)
    protein = to_decimal(nutriments.get("proteins_100g"))
    fat = to_decimal(nutriments.get("fat_100g"))
    carb = to_decimal(nutriments.get("carbohydrates_100g"))
    if kcal is None or protein is None or fat is None or carb is None:
        return None
    try:
        checked = NutritionInput(
            base_unit=base_unit,
            kcal=round_cents(kcal),
            protein_g=round_cents(protein),
            fat_g=round_cents(fat),
            carb_g=round_cents(carb),
        )
    except ValidationError:
        return None

    name = _clean_text(product.get("product_name_zh")) or _clean_text(product.get("product_name"))
    return ProductPrefill(
        name=name,
        brand=_first_brand(product.get("brands")),
        base_unit=base_unit,
        per100=Per100(
            kcal=checked.kcal,
            protein_g=checked.protein_g,
            fat_g=checked.fat_g,
            carb_g=checked.carb_g,
        ),
        serving=_serving(product.get("serving_size"), base_unit),
    )


async def _http_get(url: str) -> FetchResult:
    """真的打 OFF 的那一個函式。**測試不會走到這裡**：conftest 的 autouse fixture 把它換掉。"""
    async with httpx.AsyncClient(
        timeout=httpx.Timeout(TIMEOUT_SECONDS),
        headers={"User-Agent": USER_AGENT, "Accept": "application/json"},
        follow_redirects=False,
    ) as client:
        response = await client.get(url, params={"fields": OFF_FIELDS})
    if len(response.content) > MAX_RESPONSE_BYTES:
        return FetchResult(status=response.status_code, body=None)
    try:
        body: object = json.loads(response.content)
    except ValueError:
        body = None
    return FetchResult(status=response.status_code, body=body)


# 給 tests/test_off.py 測真的 httpx 那一層用（conftest 換掉的是 `_http_get` 這個名字）。
# `_default_fetch` 呼叫的是 `_http_get`，所以留著這個別名不會讓測試繞過守衛。
_real_http_get = _http_get


async def _default_fetch(url: str) -> FetchResult:
    # 每次呼叫才查模組裡的 `_http_get`：conftest 用 monkeypatch 換掉它時，已經建好的
    # `product_lookup` 也跟著用換掉的那一個（建構時就綁住函式的話換不到）。
    return await _http_get(url)


class OpenFoodFacts:
    """問 OFF ＋ 程序內的 LRU 快取（規格 D10）。

    - 存「預填建議」與「OFF 說沒有」（404，或 200 但用不上）；**錯誤不存**（連不上、逾時、5xx、
      不是 JSON）——下一次再問。
    - 最多 `max_entries` 筆、每筆 `ttl_seconds`；時鐘可以換（測試用）。
    """

    def __init__(
        self,
        *,
        fetch: Fetcher = _default_fetch,
        max_entries: int = CACHE_SIZE,
        ttl_seconds: float = CACHE_TTL_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._fetch = fetch
        self._max_entries = max_entries
        self._ttl_seconds = ttl_seconds
        self._clock = clock
        self._cache: OrderedDict[str, tuple[float, ProductPrefill | None]] = OrderedDict()

    async def lookup(self, code: str) -> ProductPrefill | None:
        """`code` 是 `normalize_barcode()` 的輸出（只有數字）。任何失敗都回 None，不丟例外。"""
        now = self._clock()
        cached = self._cache.get(code)
        if cached is not None:
            stored_at, value = cached
            if now - stored_at < self._ttl_seconds:
                self._cache.move_to_end(code)
                return value
            del self._cache[code]

        try:
            result = await self._fetch(OFF_PRODUCT_URL.format(code=code))
        except (httpx.HTTPError, OSError) as exc:
            # 只記種類，不記條碼（規格 §6.6）：例外的訊息可能帶著網址。
            logger.warning("Open Food Facts 查詢失敗：%s", type(exc).__name__)
            return None

        if result.status == 404:
            value = None
        elif result.status == 200 and result.body is not None:
            value = prefill_from_product(result.body)
        else:
            logger.warning("Open Food Facts 回了 HTTP %d", result.status)
            return None

        self._cache[code] = (now, value)
        self._cache.move_to_end(code)
        while len(self._cache) > self._max_entries:
            self._cache.popitem(last=False)
        return value

    def clear(self) -> None:
        self._cache.clear()


class DisabledLookup:
    """`OFF_ENABLED=false`：永遠沒有建議，也不打任何網路。"""

    async def lookup(self, code: str) -> ProductPrefill | None:
        return None


# 正式的那一個（快取跟著它活）。路由經過 `get_product_lookup` 拿它。
product_lookup = OpenFoodFacts()
