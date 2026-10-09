"""`POST /api/ai/analyze-meal`（AI 多樣估算規格 §3.1）：一次呼叫估出一餐的每一樣。

LLM 一律是假的（`FakeMealEstimator`，注入 `get_estimator_factory`）。額度、記錄、錯誤分類
跟 `/api/ai/analyze` 是同一批函式——這裡守的是「新端點真的接上了它們」，以及只有這個
端點才有的東西：一次呼叫只算一次、每一樣各自比對食物庫、單樣的方法沒被呼叫。
"""

import base64
import hashlib
import io
from decimal import Decimal
from pathlib import Path

import pytest
from PIL import Image
from sqlalchemy import select

from app.ai.estimator import (
    EstimatorMisconfiguredError,
    EstimatorUpstreamError,
    RawEstimate,
    RawMealEstimate,
)
from app.api.deps import get_estimator_factory
from app.config import settings
from app.errors import BadGatewayError
from app.main import app
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.models.food import BaseUnit, Food
from app.security.tokens import create_access_token
from tests.factories import create_food, create_pending_revision, create_user

URL = "/api/ai/analyze-meal"
# 食物庫裡不會有叫這個名字的食物——文字不會被短路。
TEXT = {"kind": "text", "text": "今天中午的雞腿便當"}


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _raw(name: str, grams: str, kcal: str, protein: str, fat: str, carb: str) -> RawEstimate:
    return RawEstimate(
        name=name,
        brand=None,
        serving_grams=Decimal(grams),
        serving_kcal=Decimal(kcal),
        serving_protein_g=Decimal(protein),
        serving_fat_g=Decimal(fat),
        serving_carb_g=Decimal(carb),
        confidence=Decimal("0.80"),
        raw={"name": name},
    )


RICE = _raw("白飯", "200.00", "280.00", "5.00", "0.50", "62.00")
CHICKEN = _raw("滷雞腿", "150.00", "300.00", "27.00", "20.00", "3.00")
_DEFAULT_MEAL = RawMealEstimate(
    description="一碗白飯、滷雞腿一隻", items=(RICE, CHICKEN), raw={"description": "…"}
)


class FakeMealEstimator:
    """假的 estimator：數每一種方法被呼叫幾次、記下收到什麼。

    單樣的兩個方法也在——多樣端點呼叫到它們的話，`single_calls` 不是 0。
    """

    model = "fake-meal-model"

    def __init__(
        self, *, meal: RawMealEstimate | None = None, error: Exception | None = None
    ) -> None:
        self._meal = meal or _DEFAULT_MEAL
        self._error = error
        self.single_calls = 0
        self.texts: list[str] = []
        self.images: list[tuple[bytes, str]] = []

    async def estimate_text(self, text: str) -> RawEstimate:
        self.single_calls += 1
        return RICE

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        self.single_calls += 1
        return RICE

    async def estimate_meal_text(self, text: str) -> RawMealEstimate:
        self.texts.append(text)
        if self._error is not None:
            raise self._error
        return self._meal

    async def estimate_meal_image(self, image: bytes, media_type: str) -> RawMealEstimate:
        self.images.append((image, media_type))
        if self._error is not None:
            raise self._error
        return self._meal

    @property
    def meal_calls(self) -> int:
        return len(self.texts) + len(self.images)


def _inject(fake: FakeMealEstimator) -> None:
    app.dependency_overrides[get_estimator_factory] = lambda: lambda: fake


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


async def _rows(db_session, user_id: int):
    """資料庫裡真的有幾列。先 rollback（第 11 種），選欄位不拿物件（第 30 種）。"""
    await db_session.rollback()
    return (
        await db_session.execute(
            select(
                AiAnalysis.succeeded, AiAnalysis.kind, AiAnalysis.model, AiAnalysis.input_hash
            )
            .where(AiAnalysis.user_id == user_id)
            .order_by(AiAnalysis.id)
        )
    ).all()


def _png() -> bytes:
    buffer = io.BytesIO()
    Image.new("RGB", (2, 2), color=(255, 0, 0)).save(buffer, format="PNG")
    return buffer.getvalue()


def _photo_files(photo_dir: Path) -> list[Path]:
    return sorted(path for path in photo_dir.rglob("*") if path.is_file())


# ── 成功 ──────────────────────────────────────────────────────────────────────


async def test_a_text_estimate_returns_the_description_and_every_item(client, db_session):
    user = await create_user(db_session)
    fake = FakeMealEstimator()
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "一碗白飯、滷雞腿一隻"
    assert body["analysis_id"] is not None
    assert body["remaining_today"] == settings.ai_daily_limit - 1
    assert [item["name"] for item in body["items"]] == ["白飯", "滷雞腿"]
    rice, chicken = body["items"]
    # 每 100g 與一份：跟單樣端點同一個算法（280 kcal／200 g → 140／100 g）。
    assert rice["nutrition"] == {
        "base_unit": "g",
        "serving_grams": "200.00",
        "kcal": "140.00",
        "protein_g": "2.50",
        "fat_g": "0.25",
        "carb_g": "31.00",
        "serving_kcal": "280.00",
        "serving_protein_g": "5.00",
        "serving_fat_g": "0.50",
        "serving_carb_g": "62.00",
    }
    assert chicken["nutrition"]["serving_grams"] == "150.00"
    assert chicken["nutrition"]["kcal"] == "200.00"
    assert rice["confidence"] == "0.80"
    assert rice["brand"] is None
    # 食物庫裡沒有同名的。
    assert rice["library_food"] is None
    assert chicken["library_food"] is None
    assert set(rice) == {
        "name", "brand", "nutrition", "confidence", "consistency", "library_food",
    }  # fmt: skip
    # 呼叫的是多樣的方法，一次；單樣的沒被碰到。
    assert fake.texts == ["今天中午的雞腿便當"]
    assert fake.meal_calls == 1
    assert fake.single_calls == 0


async def test_an_image_estimate_passes_the_decoded_photo_and_does_not_write_to_disk(
    client, db_session
):
    user = await create_user(db_session)
    fake = FakeMealEstimator()
    _inject(fake)
    photo = _png()
    photo_dir = Path(settings.photo_dir)
    before = _photo_files(photo_dir)

    response = await client.post(
        URL,
        headers=auth(user),
        json={"kind": "image", "image_base64": base64.b64encode(photo).decode()},
    )

    assert response.status_code == 200
    assert len(response.json()["items"]) == 2
    assert fake.images == [(photo, "image/png")]
    assert fake.single_calls == 0
    assert _photo_files(photo_dir) == before
    [row] = await _rows(db_session, user.id)
    assert row.kind is AnalysisKind.IMAGE
    assert row.input_hash == hashlib.sha256(photo).hexdigest()


async def test_a_bad_photo_is_rejected_before_the_llm_is_called(client, db_session):
    user = await create_user(db_session)
    fake = FakeMealEstimator()
    _inject(fake)

    response = await client.post(
        URL, headers=auth(user), json={"kind": "image", "image_base64": "不是 base64"}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "INVALID_PHOTO"
    assert fake.meal_calls == 0
    assert await _rows(db_session, user.id) == []


async def test_a_flagged_item_is_still_returned(client, db_session):
    """一致性的標記不擋人（P2 規格 §2.2），一樣一個、各算各的。"""
    odd = _raw("怪東西", "100.00", "900.00", "1.00", "1.00", "1.00")
    user = await create_user(db_session)
    _inject(FakeMealEstimator(meal=RawMealEstimate("怪東西與白飯", (odd, RICE), {})))

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert response.status_code == 200
    flags = [item["consistency"]["flagged"] for item in response.json()["items"]]
    assert flags == [True, False]


async def test_the_endpoint_requires_login(client, db_session):
    _inject(FakeMealEstimator())

    response = await client.post(URL, json=TEXT)

    assert response.status_code == 401


# ── 一次呼叫算一次 ─────────────────────────────────────────────────────────────


async def test_one_call_writes_one_row_no_matter_how_many_items(client, db_session):
    user = await create_user(db_session)
    user_id = user.id
    _inject(FakeMealEstimator())

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert len(response.json()["items"]) == 2
    rows = await _rows(db_session, user_id)
    assert len(rows) == 1
    assert rows[0].succeeded is True
    assert rows[0].kind is AnalysisKind.TEXT
    assert rows[0].model == "fake-meal-model"
    assert rows[0].input_hash == hashlib.sha256("今天中午的雞腿便當".encode()).hexdigest()


async def test_the_last_allowed_call_goes_through_and_the_next_one_is_blocked(
    client, db_session
):
    user = await create_user(db_session)
    user_id = user.id
    await _seed_analyses(db_session, user, settings.ai_daily_limit - 1)
    fake = FakeMealEstimator()
    _inject(fake)

    last = await client.post(URL, headers=auth(user), json=TEXT)
    blocked = await client.post(URL, headers=auth(user), json=TEXT)

    assert last.status_code == 200
    assert last.json()["remaining_today"] == 0
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "AI_DAILY_LIMIT"
    assert "retry-after" in blocked.headers
    # 被擋下來的那一次沒有呼叫 LLM，也沒有多一列。
    assert fake.meal_calls == 1
    assert len(await _rows(db_session, user_id)) == settings.ai_daily_limit


async def test_the_single_and_meal_endpoints_share_one_quota(client, db_session):
    """額度是同一張表數出來的：多樣用掉的，單樣也看得到。"""
    user = await create_user(db_session)
    _inject(FakeMealEstimator())

    meal = await client.post(URL, headers=auth(user), json=TEXT)
    single = await client.post("/api/ai/analyze", headers=auth(user), json=TEXT)

    assert meal.json()["remaining_today"] == settings.ai_daily_limit - 1
    assert single.json()["remaining_today"] == settings.ai_daily_limit - 2


# ── 失敗 ──────────────────────────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("error", "status", "code", "recorded"),
    [
        (EstimatorUpstreamError("overloaded"), 502, "AI_UPSTREAM_ERROR", True),
        (
            BadGatewayError("AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON"),
            502,
            "AI_BAD_RESPONSE",
            True,
        ),
        # 看不出任何食物（審查 M6）：自己的錯誤碼，但一樣記一列失敗——供應商收了錢。
        (
            BadGatewayError("AI_NO_FOOD_FOUND", "AI 看不出這一餐有什麼食物"),
            502,
            "AI_NO_FOOD_FOUND",
            True,
        ),
        (EstimatorMisconfiguredError("bad key"), 503, "AI_MISCONFIGURED", False),
    ],
    ids=["upstream", "bad-response", "no-food-found", "misconfigured"],
)
async def test_failures_are_classified_and_recorded_like_the_single_endpoint(
    client, db_session, error, status, code, recorded
):
    user = await create_user(db_session)
    user_id = user.id
    fake = FakeMealEstimator(error=error)
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    assert fake.meal_calls == 1
    rows = await _rows(db_session, user_id)
    assert [row.succeeded for row in rows] == ([False] if recorded else [])


async def test_a_failed_call_uses_up_the_quota(client, db_session):
    user = await create_user(db_session)
    _inject(FakeMealEstimator(error=EstimatorUpstreamError("overloaded")))
    await client.post(URL, headers=auth(user), json=TEXT)
    _inject(FakeMealEstimator())

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert response.json()["remaining_today"] == settings.ai_daily_limit - 2


async def test_not_configured_is_503_and_wins_over_the_quota(client, db_session, monkeypatch):
    """刻意不注入假的：走真的 `build_estimator()`。額度用完時也要說「未設定」。"""
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit)

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"


async def test_the_quota_is_checked_before_the_photo_is_decoded(client, db_session):
    """順序是行為的一部分（規格 §3.1 第 3、4 步）：額度用完時，一張壞掉的照片得到的
    也是「今天用完了」，不是「照片有問題」——後者會讓人換一張再試，而那一次一樣會被擋。"""
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit)
    fake = FakeMealEstimator()
    _inject(fake)

    response = await client.post(
        URL, headers=auth(user), json={"kind": "image", "image_base64": "不是 base64"}
    )

    assert response.status_code == 429
    assert response.json()["error"]["code"] == "AI_DAILY_LIMIT"
    assert fake.meal_calls == 0


# ── 每一樣各自比對食物庫 ───────────────────────────────────────────────────────


async def test_an_item_with_the_same_name_as_a_library_food_reports_it(client, db_session):
    """`library_food.serving_kcal` 是**食物庫**的每 100 × **AI** 估的量；`nutrition` 仍是
    AI 的數字。兩個熱量刻意不同（130 對 140／100 g）——寫反了看得出來。"""
    user = await create_user(db_session)
    mine = await create_food(
        db_session, created_by=user, owner=user, name="白飯", kcal=130, base_unit=BaseUnit.G
    )
    _inject(FakeMealEstimator())

    response = await client.post(URL, headers=auth(user), json=TEXT)

    rice, chicken = response.json()["items"]
    assert rice["library_food"] == {
        "food_id": mine.id,
        "name": "白飯",
        "base_unit": "g",
        "serving_kcal": "260.00",
    }
    assert rice["nutrition"]["serving_kcal"] == "280.00"
    assert rice["nutrition"]["kcal"] == "140.00"
    assert chicken["library_food"] is None


async def test_the_match_ignores_case_and_prefers_my_own_food(client, db_session):
    user = await create_user(db_session)
    admin = await create_user(db_session)
    await create_food(db_session, created_by=admin, owner=None, name="Latte", kcal=60)
    mine = await create_food(
        db_session, created_by=user, owner=user, name="LATTE", kcal=45, base_unit=BaseUnit.ML
    )
    latte = _raw("latte", "300.00", "150.00", "8.00", "8.00", "12.00")
    _inject(FakeMealEstimator(meal=RawMealEstimate("一杯拿鐵", (latte,), {})))

    response = await client.post(URL, headers=auth(user), json=TEXT)

    [item] = response.json()["items"]
    # 名稱與單位是食物庫那一筆的；45 × 300 / 100。
    assert item["library_food"] == {
        "food_id": mine.id,
        "name": "LATTE",
        "base_unit": "ml",
        "serving_kcal": "135.00",
    }
    assert item["name"] == "latte"


async def test_someone_elses_private_food_is_never_a_match(client, db_session):
    user = await create_user(db_session)
    stranger = await create_user(db_session)
    await create_food(db_session, created_by=stranger, owner=stranger, name="白飯")
    await create_food(db_session, created_by=stranger, owner=stranger, name="滷雞腿")
    _inject(FakeMealEstimator())

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert [item["library_food"] for item in response.json()["items"]] == [None, None]


async def test_a_food_without_an_active_revision_is_never_a_match(client, db_session):
    """只有一版還在審核中的食物（`current_revision_id` 是 NULL）沒有營養素可以拿來算
    「用食物庫的話會記成多少」——等同沒有同名的（規格 D5）。食物刻意是自己的、
    名稱完全相同、而且真的有一版營養素：擋下它的只有「那一版不是生效的」這一層。"""
    user = await create_user(db_session)
    pending_only = Food(name="白飯", owner_id=user.id, created_by=user.id)
    db_session.add(pending_only)
    await db_session.commit()
    await create_pending_revision(db_session, food=pending_only, created_by=user)
    _inject(FakeMealEstimator())

    response = await client.post(URL, headers=auth(user), json=TEXT)

    assert response.status_code == 200
    assert [item["library_food"] for item in response.json()["items"]] == [None, None]


# ── 文字剛好是食物庫裡的名稱：不呼叫 LLM ────────────────────────────────────────


async def test_text_that_is_exactly_a_library_food_never_reaches_the_llm(client, db_session):
    user = await create_user(db_session)
    user_id = user.id
    food = await create_food(db_session, created_by=user, owner=user, name="牛肉麵", kcal=113)
    await _seed_analyses(db_session, user, 3)
    built = {"n": 0}

    def factory():
        built["n"] += 1
        return FakeMealEstimator()

    app.dependency_overrides[get_estimator_factory] = lambda: factory

    response = await client.post(
        URL, headers=auth(user), json={"kind": "text", "text": " 牛肉麵 "}
    )

    assert response.status_code == 200
    body = response.json()
    assert body["analysis_id"] is None
    assert body["description"] == "牛肉麵"
    [item] = body["items"]
    assert item["name"] == "牛肉麵"
    assert item["library_food"] == {
        "food_id": food.id,
        "name": "牛肉麵",
        "base_unit": "g",
        "serving_kcal": "113.00",
    }
    assert item["nutrition"]["kcal"] == "113.00"
    assert item["nutrition"]["serving_grams"] == "100"
    # 連建實作的函式都沒被呼叫；沒有多一列；額度沒少。
    assert built["n"] == 0
    assert body["remaining_today"] == settings.ai_daily_limit - 3
    assert len(await _rows(db_session, user_id)) == 3


async def test_the_library_shortcut_works_without_ai_configured(client, db_session, monkeypatch):
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="牛肉麵")

    response = await client.post(
        URL, headers=auth(user), json={"kind": "text", "text": "牛肉麵"}
    )

    assert response.status_code == 200
    assert response.json()["analysis_id"] is None
