"""Open Food Facts：回應 → 預填建議（純函式）、用戶端的快取與失敗（假 fetcher）、真的 httpx 那一層
（`httpx.MockTransport`，不打網路）。掃條碼規格 §6。"""

import asyncio
import logging
import time
from decimal import Decimal

import httpx
import pytest

from app import off
from app.models.food import BaseUnit
from app.off import FetchResult, OpenFoodFacts, prefill_from_product

CODE = "5449000000996"


def product(**overrides):
    base = {
        "product_name": "Coca-Cola",
        "product_name_zh": "可口可樂",
        "brands": "Coca-Cola, The Coca-Cola Company",
        "product_quantity_unit": "ml",
        "serving_size": "330 ml",
        "nutriments": {
            "energy-kcal_100g": 42,
            "proteins_100g": 0,
            "fat_100g": 0,
            "carbohydrates_100g": 10.6,
        },
    }
    base.update(overrides)
    return {"status": 1, "product": base}


def nutriments(**values):
    full = {"energy-kcal_100g": 42, "proteins_100g": 0, "fat_100g": 0, "carbohydrates_100g": 10.6}
    full.update(values)
    return {key: value for key, value in full.items() if value is not None}


# ---- 預設的測試設定打不到網路（規格 D14） ----


async def test_the_default_test_setup_cannot_reach_the_network():
    """conftest 的 autouse 守衛：模組裡的 `_http_get` 被換成會丟 AssertionError 的，所以
    正式的 `product_lookup`（路由在 OFF_ENABLED 開著時用的那一個）打不出去。"""
    assert off._http_get is not off._real_http_get
    with pytest.raises(AssertionError, match="測試不能打外部網路"):
        await off._default_fetch(off.OFF_PRODUCT_URL.format(code=CODE))
    with pytest.raises(AssertionError, match="測試不能打外部網路"):
        await off.product_lookup.lookup(CODE)


# ---- prefill_from_product ----


def test_a_full_product_becomes_a_prefill():
    prefill = prefill_from_product(product())
    assert prefill is not None
    assert (prefill.name, prefill.brand) == ("可口可樂", "Coca-Cola")
    assert prefill.base_unit is BaseUnit.ML
    assert prefill.per100.kcal == Decimal("42.00")
    assert prefill.per100.carb_g == Decimal("10.60")
    assert prefill.serving is not None
    assert (prefill.serving.amount, prefill.serving.unit) == (Decimal("330.00"), BaseUnit.ML)
    assert prefill.source == "openfoodfacts"


def test_the_plain_name_when_there_is_no_chinese_one():
    assert prefill_from_product(product(product_name_zh="  ")).name == "Coca-Cola"


def test_no_name_at_all_is_still_a_prefill():
    """沒有名稱也給數字：使用者自己填名稱。"""
    prefill = prefill_from_product(product(product_name_zh=None, product_name=None, brands=None))
    assert prefill is not None
    assert (prefill.name, prefill.brand) == (None, None)


def test_grams_unless_the_quantity_unit_is_ml():
    assert prefill_from_product(product(product_quantity_unit="g")).base_unit is BaseUnit.G
    assert prefill_from_product(product(product_quantity_unit=None)).base_unit is BaseUnit.G


@pytest.mark.parametrize("key", ["energy-kj_100g", "energy_100g"])
def test_kilojoules_are_converted(key):
    """`energy_100g` 在 OFF 裡就是 kJ。"""
    p = product(nutriments=nutriments(**{"energy-kcal_100g": None, key: 180}))
    assert prefill_from_product(p).per100.kcal == Decimal("43.02")


def test_numbers_may_be_strings():
    p = product(nutriments=nutriments(proteins_100g="0.5", fat_100g="1"))
    assert prefill_from_product(p).per100.protein_g == Decimal("0.50")


@pytest.mark.parametrize(
    "broken",
    [
        {"energy-kcal_100g": None},
        {"proteins_100g": None},
        {"fat_100g": None},
        {"carbohydrates_100g": None},
        {"fat_100g": "很多"},
        {"carbohydrates_100g": True},
        {"energy-kcal_100g": 10001},  # 超出 NutritionInput（kcal ≤ 10000）
        {"proteins_100g": -1},
    ],
)
def test_a_missing_or_bad_number_means_no_prefill(broken):
    assert prefill_from_product(product(nutriments=nutriments(**broken))) is None


# 審查 I1：大到 `quantize` 放不下（約 1e26 以上）的數字以前丟 InvalidOperation → 端點 500，
# 而且錯誤不快取、每次掃都重試。現在跟其他壞數字一樣是「沒有預填」。
ABSURD = [
    {"proteins_100g": 1e40},
    {"proteins_100g": "1e30"},
    {"proteins_100g": 10**30},
    {"energy-kcal_100g": None, "energy-kj_100g": "1e40"},
    {"fat_100g": 1_000_001},  # 超過 to_decimal 的上限（1e6），還沒到 quantize 放不下
]


@pytest.mark.parametrize("broken", ABSURD)
def test_absurd_numbers_mean_no_prefill(broken):
    assert prefill_from_product(product(nutriments=nutriments(**broken))) is None


@pytest.mark.parametrize(
    "impossible",
    [
        # 審查 M3：每一項都在 NutritionInput 的範圍裡，但物理上不可能——熱量超過純脂肪（945 是
        # 900 多 5% 給四捨五入）、或每 100 g 裡三大營養素加起來超過 105 g。
        # OFF 常見的是 kJ 填進 kcal。
        {"energy-kcal_100g": 945.01},
        {"energy-kcal_100g": 2000},
        {"proteins_100g": 50, "fat_100g": 5, "carbohydrates_100g": 50.01},
    ],
)
def test_physically_impossible_numbers_mean_no_prefill(impossible):
    assert prefill_from_product(product(nutriments=nutriments(**impossible))) is None


@pytest.mark.parametrize(
    "extreme",
    [
        {"energy-kcal_100g": 945, "fat_100g": 100, "carbohydrates_100g": 5},
        {"energy-kcal_100g": 884, "fat_100g": 100, "carbohydrates_100g": 0},
    ],
)
def test_physically_possible_extremes_are_a_prefill(extreme):
    assert prefill_from_product(product(nutriments=nutriments(**extreme))) is not None


def test_the_bound_is_inclusive_of_a_million():
    """上限是 `abs(n) > 1e6` 才拒絕；1e6 本身照樣轉成 Decimal（再交給 NutritionInput 擋範圍）。"""
    assert off.to_decimal(1_000_000) == Decimal(1_000_000)
    assert off.to_decimal(-1_000_000) == Decimal(-1_000_000)
    assert off.to_decimal("1000000.01") is None
    assert off.to_decimal(-1_000_001) is None


def test_prefill_survives_an_invalid_operation_anyway(monkeypatch):
    """第二道防線：就算哪天有一個沒被上限擋到的值讓 quantize 丟 InvalidOperation，也是 None
    （規格 D9：每一種失敗都是沒有建議），不是 500。"""
    monkeypatch.setattr(off, "to_decimal", lambda value: Decimal("1e40"))
    assert prefill_from_product(product()) is None


@pytest.mark.parametrize(
    "payload",
    [
        {"status": 0},
        {"status": 1},
        {"status": 1, "product": []},
        [],
        None,
        "x",
        {"status": 1, "product": {"nutriments": "x"}},
    ],
)
def test_odd_shapes_mean_no_prefill(payload):
    assert prefill_from_product(payload) is None


@pytest.mark.parametrize(
    ("serving_size", "unit", "expected"),
    [
        ("30 g", "g", "30.00"),
        ("33,5g", "g", "33.50"),
        ("250 ML", "ml", "250.00"),
        ("1 piece (30 g)", "g", None),
        ("330 ml", "g", None),
        ("", "g", None),
        (None, "g", None),
    ],
)
def test_serving_size_parsing(serving_size, unit, expected):
    p = product(serving_size=serving_size, product_quantity_unit=unit)
    serving = prefill_from_product(p).serving
    assert (None if serving is None else str(serving.amount)) == expected


def test_names_are_cleaned_and_truncated():
    name = "可口" + chr(0x200B) + "可樂" + chr(10) + "x" * 200
    prefill = prefill_from_product(product(product_name_zh=name))
    assert chr(0x200B) not in prefill.name and chr(10) not in prefill.name
    assert len(prefill.name) <= 100


# ---- OpenFoodFacts（假 fetcher） ----


class Recorder:
    def __init__(self, *results):
        self.results = list(results)
        self.urls: list[str] = []

    async def __call__(self, url):
        self.urls.append(url)
        result = self.results.pop(0)
        if isinstance(result, Exception):
            raise result
        return result


async def test_found_is_cached():
    fetch = Recorder(FetchResult(200, product()))
    client = OpenFoodFacts(fetch=fetch)

    first, second = await client.lookup(CODE), await client.lookup(CODE)

    assert first is not None and first == second
    assert fetch.urls == [f"https://world.openfoodfacts.org/api/v2/product/{CODE}.json"]


async def test_not_found_is_cached_too():
    fetch = Recorder(FetchResult(404, {"status": 0}))
    client = OpenFoodFacts(fetch=fetch)
    assert await client.lookup(CODE) is None
    assert await client.lookup(CODE) is None
    assert len(fetch.urls) == 1


@pytest.mark.parametrize(
    "failure",
    [
        httpx.ConnectTimeout("t"),
        httpx.ConnectError("c"),
        FetchResult(500, None),
        FetchResult(200, None),
        FetchResult(429, {"status": 0}),
    ],
)
async def test_failures_are_not_cached(failure):
    fetch = Recorder(failure, FetchResult(200, product()))
    client = OpenFoodFacts(fetch=fetch)
    assert await client.lookup(CODE) is None
    assert await client.lookup(CODE) is not None
    assert len(fetch.urls) == 2


async def test_entries_expire_after_the_ttl():
    now = [0.0]
    fetch = Recorder(FetchResult(200, product()), FetchResult(404, None))
    client = OpenFoodFacts(fetch=fetch, ttl_seconds=10, clock=lambda: now[0])
    assert await client.lookup(CODE) is not None
    now[0] = 9.9
    assert await client.lookup(CODE) is not None
    now[0] = 10.0
    assert await client.lookup(CODE) is None
    assert len(fetch.urls) == 2


async def test_the_least_recently_used_entry_is_evicted():
    fetch = Recorder(*[FetchResult(200, product()) for _ in range(4)])
    client = OpenFoodFacts(fetch=fetch, max_entries=2)
    await client.lookup("1")
    await client.lookup("2")
    await client.lookup("1")  # 1 變成最近用過的
    await client.lookup("3")  # 擠掉 2
    await client.lookup("1")  # 還在
    assert [url.split("/")[-1] for url in fetch.urls] == ["1.json", "2.json", "3.json"]
    await client.lookup("2")
    assert len(fetch.urls) == 4


async def test_the_failure_log_does_not_contain_the_barcode(caplog):
    caplog.set_level(logging.WARNING, logger="app.off")
    client = OpenFoodFacts(fetch=Recorder(httpx.ConnectError("boom " + CODE)))
    await client.lookup(CODE)
    assert caplog.records and CODE not in caplog.text


# ---- 真的 httpx 那一層 ----


async def test_the_http_request(monkeypatch):
    """網址、fields、User-Agent、逾時、不跟隨轉址——用 MockTransport，不打網路。
    conftest 把 `off._http_get` 換掉了，這裡拿回原本的那一個（`off._real_http_get`）。"""
    seen = {}

    def handler(request):
        seen["url"] = str(request.url)
        seen["ua"] = request.headers["user-agent"]
        seen["timeout"] = request.extensions["timeout"]
        return httpx.Response(200, json=product())

    real_client = httpx.AsyncClient

    def client_with_mock(**kwargs):
        seen["follow_redirects"] = kwargs.get("follow_redirects")
        return real_client(transport=httpx.MockTransport(handler), **kwargs)

    monkeypatch.setattr(off.httpx, "AsyncClient", client_with_mock)
    result = await off._real_http_get(off.OFF_PRODUCT_URL.format(code=CODE))

    assert result.status == 200 and result.body == product()
    assert seen["url"].startswith(f"https://world.openfoodfacts.org/api/v2/product/{CODE}.json?")
    assert "fields=product_name%2Cproduct_name_zh%2Cbrands%2Cnutriments" in seen["url"]
    assert seen["ua"].startswith("nutrition-tracker/1.0")
    assert seen["timeout"]["read"] == 4.0
    assert seen["follow_redirects"] is False


async def test_a_too_large_or_non_json_body_has_no_body(monkeypatch):
    bodies = iter([b"x" * 1_000_001, b"<html>"])

    def handler(request):
        return httpx.Response(200, content=next(bodies))

    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        off.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )
    assert (await off._real_http_get("https://example.invalid/x")).body is None
    assert (await off._real_http_get("https://example.invalid/x")).body is None


def _mock_client(monkeypatch, handler):
    real_client = httpx.AsyncClient
    monkeypatch.setattr(
        off.httpx,
        "AsyncClient",
        lambda **kw: real_client(transport=httpx.MockTransport(handler), **kw),
    )


async def test_an_oversized_body_stops_reading_at_the_cap(monkeypatch):
    """審查 M4：以前 `client.get` 先把整個回應讀進記憶體，才看有沒有超過 1 MB。現在邊讀邊數，
    超過就停——後面的 chunk 不會被要。50 個 100 KB 的 chunk（5 MB）只讀到第 11 個左右。"""
    produced = [0]

    async def endless():
        for _ in range(50):
            produced[0] += 1
            yield b"x" * 100_000

    _mock_client(monkeypatch, lambda request: httpx.Response(200, content=endless()))

    result = await off._real_http_get("https://example.invalid/x")

    assert (result.status, result.body) == (200, None)
    assert produced[0] <= 12


async def test_a_body_of_exactly_the_cap_is_read(monkeypatch):
    head, tail = b'{"status": 0, "pad": "', b'"}'
    body = head + b"x" * (off.MAX_RESPONSE_BYTES - len(head) - len(tail)) + tail
    assert len(body) == off.MAX_RESPONSE_BYTES

    async def chunks():
        for start in range(0, len(body), 64_000):
            yield body[start : start + 64_000]

    _mock_client(monkeypatch, lambda request: httpx.Response(200, content=chunks()))

    assert (await off._real_http_get("https://example.invalid/x")).body["status"] == 0


async def test_a_slow_body_times_out_as_a_whole(monkeypatch):
    """審查 M4：`httpx.Timeout(4)` 是每一個階段各 4 秒——一個每 3 秒滴一個位元組的回應永遠不會
    逾時。現在整個請求包在一個總的期限裡（`asyncio.timeout`）。測試把期限縮成 0.2 秒；
    MockTransport 不管 httpx 的逾時，擋下來的只會是總期限。"""
    monkeypatch.setattr(off, "TIMEOUT_SECONDS", 0.2)

    async def trickle():
        for _ in range(100):
            yield b" "
            await asyncio.sleep(0.05)
        yield b'{"status": 0}'

    _mock_client(monkeypatch, lambda request: httpx.Response(200, content=trickle()))

    started = time.monotonic()
    with pytest.raises(TimeoutError):
        await off._real_http_get("https://example.invalid/x")
    assert time.monotonic() - started < 2


async def test_a_timeout_through_the_client_is_no_prefill_and_not_cached(monkeypatch):
    """總期限到了 → `lookup` 回 None（使用者只看到「找不到」）、不快取（下一次再問）。"""
    monkeypatch.setattr(off, "TIMEOUT_SECONDS", 0.2)
    calls = [0]

    async def stall():
        await asyncio.sleep(5)
        yield b"{}"

    def handler(request):
        calls[0] += 1
        return httpx.Response(200, content=stall())

    _mock_client(monkeypatch, handler)
    client = OpenFoodFacts(fetch=off._real_http_get)

    assert await client.lookup(CODE) is None
    assert await client.lookup(CODE) is None
    assert calls[0] == 2
