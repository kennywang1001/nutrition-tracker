"""AI 端點的計時（照片說明規格 §7.2）：每一個請求一行 INFO，狀態碼對、不帶內容。

估算一律是假的（`_Fake`，注入 `get_estimator_factory`），不打網路。供應商那一行（§7.1）由
`tests/test_ai_provider_errors.py` 用假傳輸層測。
"""

import base64
import io
import logging
import re
from decimal import Decimal

import pytest
from PIL import Image

from app.ai.estimator import EstimatorUpstreamError, RawEstimate, RawMealEstimate
from app.ai.label import RawLabel
from app.api.deps import get_estimator_factory
from app.config import settings
from app.main import app
from app.models.food import BaseUnit
from app.security.tokens import create_access_token
from tests.factories import create_user

_ESTIMATE = RawEstimate(
    name="測試食物",
    brand=None,
    serving_grams=Decimal("200"),
    serving_kcal=Decimal("300"),
    serving_protein_g=Decimal("10"),
    serving_fat_g=Decimal("10"),
    serving_carb_g=Decimal("40"),
    confidence=Decimal("0.70"),
    raw={},
)
_MEAL = RawMealEstimate(description="測試食物一份", items=(_ESTIMATE,), raw={})
_LABEL = RawLabel(
    name="洋芋片",
    base_unit=BaseUnit.G,
    kcal=Decimal("514.29"),
    protein_g=Decimal("6.00"),
    fat_g=Decimal("28.00"),
    carb_g=Decimal("60.86"),
    serving_size=Decimal("35.00"),
    servings_per_package=Decimal("4.00"),
    basis="per_serving",
    confidence=Decimal("0.80"),
    raw={},
)
# 一個不會在別處出現的字串：斷言它不在 log 裡才有鑑別力。
_HINT = "雞皮沒吃不要進log"


class _Fake:
    model = "fake-model"

    def __init__(self, error: Exception | None = None) -> None:
        self.error = error

    async def estimate_text(self, text: str) -> RawEstimate:
        return self._answer(_ESTIMATE)

    async def estimate_image(
        self, image: bytes, media_type: str, hint: str | None = None
    ) -> RawEstimate:
        return self._answer(_ESTIMATE)

    async def estimate_meal_image(
        self, image: bytes, media_type: str, hint: str | None = None
    ) -> RawMealEstimate:
        return self._answer(_MEAL)

    async def read_label(self, image: bytes, media_type: str, hint: str | None = None) -> RawLabel:
        return self._answer(_LABEL)

    def _answer[T](self, value: T) -> T:
        if self.error is not None:
            raise self.error
        return value


def _inject(fake: _Fake) -> None:
    app.dependency_overrides[get_estimator_factory] = lambda: lambda: fake


def _auth(user) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _png_b64() -> str:
    buf = io.BytesIO()
    Image.new("RGB", (2, 2), color=(255, 0, 0)).save(buf, format="PNG")
    return base64.b64encode(buf.getvalue()).decode()


def _route_lines(caplog: pytest.LogCaptureFixture) -> list[str]:
    return [
        r.getMessage()
        for r in caplog.records
        if r.name == "app.api.routes.ai"
        and r.levelno == logging.INFO
        and r.getMessage().startswith("AI 端點")
    ]


_SECONDS = r"\d+\.\d{2}s"


async def test_a_photo_with_a_hint_logs_route_input_hint_status_decode_and_total(
    client, db_session, caplog
):
    caplog.set_level(logging.DEBUG)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/analyze",
        headers=_auth(user),
        json={"kind": "image", "image_base64": _png_b64(), "hint": _HINT},
    )

    assert response.status_code == 200
    (line,) = _route_lines(caplog)
    assert "route=analyze," in line
    assert "input=image" in line
    assert "hint=yes" in line
    assert "status=200" in line
    assert re.search(rf"decode={_SECONDS}", line)
    assert re.search(rf"total={_SECONDS}", line)
    # 說明的內容不在任何一行（只記有沒有），照片也不在。
    assert all("雞皮沒吃" not in r.getMessage() for r in caplog.records)
    assert all("iVBOR" not in r.getMessage() for r in caplog.records)


async def test_a_text_estimate_logs_text_and_no_decode(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/analyze",
        headers=_auth(user),
        # 食物庫裡沒有這個名字：真的走到 AI。
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 200
    (line,) = _route_lines(caplog)
    assert "input=text" in line
    assert "hint=-" in line
    assert "decode=-" in line
    assert "status=200" in line
    assert "食物庫裡找不到" not in line


async def test_a_photo_without_a_hint_logs_hint_no(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/analyze", headers=_auth(user), json={"kind": "image", "image_base64": _png_b64()}
    )

    assert response.status_code == 200
    (line,) = _route_lines(caplog)
    assert "hint=no" in line


async def test_the_daily_limit_logs_429(client, db_session, caplog, monkeypatch):
    caplog.set_level(logging.INFO)
    monkeypatch.setattr(settings, "ai_daily_limit", 1)
    user = await create_user(db_session)
    headers = _auth(user)
    _inject(_Fake())
    body = {"kind": "image", "image_base64": _png_b64()}

    first = await client.post("/api/ai/analyze", headers=headers, json=body)
    second = await client.post("/api/ai/analyze", headers=headers, json=body)

    assert (first.status_code, second.status_code) == (200, 429)
    lines = _route_lines(caplog)
    assert len(lines) == 2
    assert "status=200" in lines[0]
    assert "status=429" in lines[1]
    # 額度在解碼之前就擋了：沒有解碼的秒數。
    assert "decode=-" in lines[1]


async def test_a_bad_photo_logs_422_with_the_decode_time(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/analyze",
        headers=_auth(user),
        json={"kind": "image", "image_base64": base64.b64encode(b"not an image").decode()},
    )

    assert response.status_code == 422
    (line,) = _route_lines(caplog)
    assert "status=422" in line
    assert "input=image" in line
    # 解碼丟例外時 decoding() 的 finally 照樣記下花了多久。
    assert re.search(rf"decode={_SECONDS}", line)


async def test_an_upstream_error_logs_502(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake(EstimatorUpstreamError("x")))

    response = await client.post(
        "/api/ai/analyze",
        headers=_auth(user),
        json={"kind": "image", "image_base64": _png_b64(), "hint": _HINT},
    )

    assert response.status_code == 502
    (line,) = _route_lines(caplog)
    assert "status=502" in line
    assert "hint=yes" in line
    assert all("雞皮沒吃" not in r.getMessage() for r in caplog.records)


async def test_a_body_that_fails_the_schema_logs_422_without_an_input(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post("/api/ai/analyze", headers=_auth(user), json={"kind": "image"})

    assert response.status_code == 422
    (line,) = _route_lines(caplog)
    assert "status=422" in line
    # 端點沒跑：不知道是文字還是照片。
    assert "input=-" in line
    assert "hint=-" in line


async def test_a_request_without_login_logs_401(client, caplog):
    """計時是第一個依賴：驗證身分失敗也有一行（在知道是文字還是照片之前就失敗，input=-）。"""
    caplog.set_level(logging.INFO)

    response = await client.post(
        "/api/ai/analyze", json={"kind": "image", "image_base64": _png_b64()}
    )

    assert response.status_code == 401
    (line,) = _route_lines(caplog)
    assert "status=401" in line
    assert "input=-" in line


async def test_the_meal_endpoint_is_named(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/analyze-meal",
        headers=_auth(user),
        json={"kind": "image", "image_base64": _png_b64(), "hint": _HINT},
    )

    assert response.status_code == 200
    (line,) = _route_lines(caplog)
    assert "route=analyze-meal," in line
    assert "input=image" in line
    assert "hint=yes" in line
    assert re.search(rf"decode={_SECONDS}", line)


async def test_the_label_endpoint_is_named(client, db_session, caplog):
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/read-label", headers=_auth(user), json={"image_base64": _png_b64()}
    )

    assert response.status_code == 200
    (line,) = _route_lines(caplog)
    assert "route=read-label," in line
    assert "input=image" in line
    assert "hint=no" in line
    assert re.search(rf"decode={_SECONDS}", line)


async def test_the_suggest_endpoint_is_named(client, db_session, caplog):
    """配餐沒有照片也沒有說明：input、hint、decode 都是 -。沒有熱量目標是 422（不呼叫 AI）。"""
    caplog.set_level(logging.INFO)
    user = await create_user(db_session)
    _inject(_Fake())

    response = await client.post(
        "/api/ai/suggest-meal", headers=_auth(user), json={"preference": "不吃牛不要進log"}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "NO_KCAL_TARGET"
    (line,) = _route_lines(caplog)
    assert "route=suggest-meal," in line
    assert "input=-" in line
    assert "hint=-" in line
    assert "decode=-" in line
    assert "status=422" in line
    assert all("不吃牛" not in r.getMessage() for r in caplog.records)
