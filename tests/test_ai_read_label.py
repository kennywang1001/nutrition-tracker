"""`POST /api/ai/read-label`（掃條碼規格 §8.4、D24–D27）。

LLM 一律是假的（`FakeLabelEstimator`）。額度、記錄、錯誤分類跟其他 AI 端點是同一批函式——
這裡守的是：記成 'label'、雜湊的是解碼後的圖片、讀不出來照樣記一列算額度、順序（沒設定 503
在額度之前、照片錯在呼叫之前而且免費）、回應的形狀與 commit 之後不再讀資料庫。
"""

import base64
import hashlib
import io
from decimal import Decimal

from PIL import Image
from sqlalchemy import event, select

from app.ai.estimator import EstimatorMisconfiguredError, EstimatorUpstreamError
from app.ai.label import RawLabel
from app.api.deps import get_estimator_factory
from app.config import settings
from app.errors import BadGatewayError
from app.main import app
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.models.food import BaseUnit
from app.security.tokens import create_access_token
from tests.factories import create_user

URL = "/api/ai/read-label"
UNREADABLE_MESSAGE = (
    "AI 讀不出這張營養標示的數字，換一張清楚一點、整個表格都在畫面裡的照片再試"
    "（這一次也算在今天的次數裡）"
)


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _tiny_png_bytes() -> bytes:
    # 同 tests/test_ai_analyze.py：真的 PNG，過得了 _decode_photo 的 Pillow 解碼。
    buf = io.BytesIO()
    Image.new("RGB", (2, 2), color=(255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


PNG = _tiny_png_bytes()
BODY = {"image_base64": base64.b64encode(PNG).decode()}


def _label(**overrides) -> RawLabel:
    """規格 §8.3 那一張：35 g 一份、4 份；每份換算的每 100 是 514.29／6.00／28.00／60.86。"""
    values: dict[str, object] = {
        "name": "海苔洋芋片",
        "base_unit": BaseUnit.G,
        "kcal": Decimal("514.29"),
        "protein_g": Decimal("6.00"),
        "fat_g": Decimal("28.00"),
        "carb_g": Decimal("60.86"),
        "serving_size": Decimal("35.00"),
        "servings_per_package": Decimal("4.00"),
        "basis": "per_serving",
        "confidence": Decimal("0.80"),
        "raw": {},
    }
    values.update(overrides)
    return RawLabel(**values)  # type: ignore[arg-type]


class FakeLabelEstimator:
    model = "fake-label-model"

    def __init__(self, result: RawLabel | Exception):
        self.result = result
        self.calls: list[tuple[bytes, str]] = []

    async def read_label(self, image: bytes, media_type: str) -> RawLabel:
        self.calls.append((image, media_type))
        if isinstance(self.result, Exception):
            raise self.result
        return self.result


def _inject(fake: FakeLabelEstimator) -> None:
    app.dependency_overrides[get_estimator_factory] = lambda: lambda: fake


async def _rows(db_session, user_id: int):
    """資料庫裡真的有幾列。先 rollback，選欄位不拿物件（同 test_ai_suggest_meal.py）。"""
    await db_session.rollback()
    return (
        await db_session.execute(
            select(AiAnalysis.succeeded, AiAnalysis.kind, AiAnalysis.input_hash)
            .where(AiAnalysis.user_id == user_id)
            .order_by(AiAnalysis.id)
        )
    ).all()


async def _seed_analyses(db_session, user, count: int) -> None:
    for _ in range(count):
        db_session.add(
            AiAnalysis(
                user_id=user.id,
                kind=AnalysisKind.TEXT,
                model="seed-model",
                input_hash="seed",
                succeeded=True,
            )
        )
    await db_session.commit()


async def test_a_label_is_read(client, db_session):
    user = await create_user(db_session)
    user_id, headers = user.id, auth(user)
    fake = FakeLabelEstimator(_label())
    _inject(fake)

    response = await client.post(URL, headers=headers, json=BODY)

    assert response.status_code == 200
    body = response.json()
    assert isinstance(body["analysis_id"], int)
    assert body["name"] == "海苔洋芋片"
    assert body["nutrition"] == {
        "base_unit": "g",
        "kcal": "514.29",
        "protein_g": "6.00",
        "fat_g": "28.00",
        "carb_g": "60.86",
    }
    assert body["serving"] == {"amount": "35.00", "unit": "g"}
    assert body["servings_per_package"] == "4.00"
    assert body["basis"] == "per_serving"
    assert body["confidence"] == "0.80"
    # 6.00×4 + 60.86×4 + 28.00×9 = 519.44；差 5.15 < 128.57 → 不標記（規格 §8.3）
    assert body["consistency"] == {"atwater_kcal": "519.44", "deviation": "5.15", "flagged": False}
    assert body["remaining_today"] == settings.ai_daily_limit - 1
    # 假的收到的是解碼後的位元組
    assert fake.calls == [(PNG, "image/png")]
    rows = await _rows(db_session, user_id)
    assert rows == [(True, AnalysisKind.LABEL, hashlib.sha256(PNG).hexdigest())]
    assert body["analysis_id"] == (
        await db_session.scalar(select(AiAnalysis.id).where(AiAnalysis.user_id == user_id))
    )


async def test_ml_serving(client, db_session):
    user = await create_user(db_session)
    _inject(FakeLabelEstimator(_label(base_unit=BaseUnit.ML, serving_size=Decimal("250.00"))))

    body = (await client.post(URL, headers=auth(user), json=BODY)).json()

    assert body["serving"] == {"amount": "250.00", "unit": "ml"}
    assert body["nutrition"]["base_unit"] == "ml"


async def test_no_serving_size_means_no_serving(client, db_session):
    """每 100 那一欄讀到、每一份量沒讀到：沒有「一份」，幾份照樣回。"""
    user = await create_user(db_session)
    _inject(FakeLabelEstimator(_label(serving_size=None, basis="per_100")))

    body = (await client.post(URL, headers=auth(user), json=BODY)).json()

    assert body["serving"] is None
    assert body["servings_per_package"] == "4.00"
    assert body["basis"] == "per_100"


async def test_unreadable_is_502_recorded_and_counted(client, db_session):
    user = await create_user(db_session)
    user_id, headers = user.id, auth(user)
    _inject(FakeLabelEstimator(BadGatewayError("AI_LABEL_UNREADABLE", UNREADABLE_MESSAGE)))

    response = await client.post(URL, headers=headers, json=BODY)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "AI_LABEL_UNREADABLE"
    assert response.json()["error"]["message"] == UNREADABLE_MESSAGE
    assert await _rows(db_session, user_id) == [
        (False, AnalysisKind.LABEL, hashlib.sha256(PNG).hexdigest())
    ]

    # 那一次也算：下一次成功的 remaining_today 少 2
    _inject(FakeLabelEstimator(_label()))
    again = await client.post(URL, headers=headers, json=BODY)
    assert again.json()["remaining_today"] == settings.ai_daily_limit - 2


async def test_upstream_error_is_502_and_recorded(client, db_session):
    user = await create_user(db_session)
    user_id = user.id
    _inject(FakeLabelEstimator(EstimatorUpstreamError("boom")))

    response = await client.post(URL, headers=auth(user), json=BODY)

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "AI_UPSTREAM_ERROR"
    rows = await _rows(db_session, user_id)
    assert [(row.succeeded, row.kind) for row in rows] == [(False, AnalysisKind.LABEL)]


async def test_misconfigured_is_503_and_not_recorded(client, db_session):
    user = await create_user(db_session)
    user_id = user.id
    _inject(FakeLabelEstimator(EstimatorMisconfiguredError("bad key")))

    response = await client.post(URL, headers=auth(user), json=BODY)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_MISCONFIGURED"
    assert await _rows(db_session, user_id) == []


async def test_not_configured_is_503_before_quota(client, db_session, monkeypatch):
    """沒設定 AI 時就算額度已滿也是 503（不是 429）：先建實作，再看額度（同 /analyze）。"""
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit)

    response = await client.post(URL, headers=auth(user), json=BODY)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"


async def test_the_daily_limit(client, db_session):
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit)
    fake = FakeLabelEstimator(_label())
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json=BODY)

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "AI_DAILY_LIMIT"
    assert fake.calls == []


async def test_a_bad_photo_is_422_free(client, db_session):
    user = await create_user(db_session)
    user_id = user.id
    fake = FakeLabelEstimator(_label())
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json={"image_base64": "not base64!"})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_PHOTO"
    assert fake.calls == []
    assert await _rows(db_session, user_id) == []


async def test_the_body_needs_an_image(client, db_session):
    user = await create_user(db_session)
    _inject(FakeLabelEstimator(_label()))

    response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_needs_login(client):
    assert (await client.post(URL, json=BODY)).status_code == 401


async def test_the_response_is_built_before_the_commit(client, db_session, db_connection):
    """commit 之後不再送任何 SQL（身體資料審查 M6，同 suggest_meal）：回應在 commit 之前組好。"""
    user = await create_user(db_session)
    headers = auth(user)
    _inject(FakeLabelEstimator(_label()))
    statements: list[tuple[bool, str]] = []
    committed = False

    def on_commit(session) -> None:
        nonlocal committed
        committed = True

    def record(conn, cursor, statement, parameters, context, executemany) -> None:
        statements.append((committed, " ".join(statement.split())))

    event.listen(db_session.sync_session, "after_commit", on_commit)
    event.listen(db_connection.sync_connection, "before_cursor_execute", record)
    try:
        response = await client.post(URL, headers=headers, json=BODY)
    finally:
        event.remove(db_connection.sync_connection, "before_cursor_execute", record)
        event.remove(db_session.sync_session, "after_commit", on_commit)

    assert response.status_code == 200
    assert committed
    assert [sql for after, sql in statements if after] == []
