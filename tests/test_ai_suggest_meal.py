"""`POST /api/ai/suggest-meal`（營養素配餐規格 §5、D15–D21）。

LLM 一律是假的（`FakeSuggestEstimator`）。額度、記錄、錯誤分類跟 analyze-meal 是同一批函式——
這裡守的是：剩下的額度怎麼進到給模型的訊息、兩種 422 在 AI 之前、記成 'suggest'、0 樣的錯誤碼、
偏好不進 log。

**「今天」不 monkeypatch**（計畫「開工前必讀」第 3 點）：同一個函式決定額度數哪一天。
所以只用「沒有餐」或「現在吃的一餐」；跨午夜的那一秒可能誤判（已知限制）。
"""

import hashlib
import json
import logging
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.ai.estimator import (
    EstimatorMisconfiguredError,
    EstimatorUpstreamError,
    RawEstimate,
    RawMealEstimate,
    parse_raw_meal_suggestion,
    suggestion_request,
)
from app.api.deps import get_estimator_factory
from app.config import settings
from app.errors import BadGatewayError
from app.main import app
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.models.food import FoodRevision
from app.planner import Remaining
from app.security.tokens import create_access_token
from tests.factories import create_exercise, create_food, create_meal, create_target, create_user

URL = "/api/ai/suggest-meal"
NO_PREFERENCE = "使用者沒有特別的偏好。"


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


def _raw(name: str, grams: str, kcal: str, protein: str) -> RawEstimate:
    return RawEstimate(
        name=name,
        brand=None,
        serving_grams=Decimal(grams),
        serving_kcal=Decimal(kcal),
        serving_protein_g=Decimal(protein),
        serving_fat_g=Decimal("5.00"),
        serving_carb_g=Decimal("10.00"),
        confidence=Decimal("0.60"),
        raw={"name": name},
    )


_SUGGESTION = RawMealEstimate(
    description="便利商店：雞胸肉沙拉、茶葉蛋兩顆",
    items=(
        _raw("雞胸肉沙拉", "250.00", "230.00", "25.00"),
        _raw("茶葉蛋", "110.00", "150.00", "13.00"),
    ),
    raw={"description": "…"},
)


class FakeSuggestEstimator:
    """記下 `suggest_meal` 收到的訊息；估算的四個方法被呼叫就記一筆（不該被呼叫）。"""

    model = "fake-suggest-model"

    def __init__(self, *, error: Exception | None = None) -> None:
        self._error = error
        self.requests: list[str] = []
        self.other_calls = 0

    async def suggest_meal(self, request: str) -> RawMealEstimate:
        self.requests.append(request)
        if self._error is not None:
            raise self._error
        return _SUGGESTION

    async def estimate_text(self, *_args):
        self.other_calls += 1
        raise AssertionError("不該呼叫")

    estimate_image = estimate_meal_text = estimate_meal_image = estimate_text


def _inject(fake: FakeSuggestEstimator) -> None:
    app.dependency_overrides[get_estimator_factory] = lambda: lambda: fake


async def _rows(db_session, user_id: int):
    """資料庫裡真的有幾列。先 rollback，選欄位不拿物件（同 test_ai_analyze_meal.py）。"""
    await db_session.rollback()
    return (
        await db_session.execute(
            select(AiAnalysis.succeeded, AiAnalysis.kind, AiAnalysis.input_hash)
            .where(AiAnalysis.user_id == user_id)
            .order_by(AiAnalysis.id)
        )
    ).all()


async def _ate_now(db_session, user, kcal: int) -> None:
    """現在吃了 kcal 大卡（一個每 100 g＝kcal 的食物，100 g）。"""
    food = await create_food(db_session, created_by=user, owner=user, kcal=kcal, protein_g=0,
                             fat_g=0, carb_g=0)  # fmt: skip
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(
        db_session, user=user, eaten_at=datetime.now(UTC), items=[(revision, Decimal("100"))]
    )


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


def _error_from_parsing(reply: str) -> BadGatewayError:
    with pytest.raises(BadGatewayError) as raised:
        parse_raw_meal_suggestion(reply)
    return raised.value


async def test_a_suggestion_uses_the_remaining_budget_and_records_a_suggest_row(
    client, db_session
):
    user = await create_user(db_session)
    user_id = user.id
    await create_target(db_session, user=user, kcal=2000, protein_g=90)
    await _ate_now(db_session, user, 500)
    fake = FakeSuggestEstimator()
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json={"preference": "不吃牛"})

    assert response.status_code == 200
    body = response.json()
    assert body["description"] == "便利商店：雞胸肉沙拉、茶葉蛋兩顆"
    assert [item["name"] for item in body["items"]] == ["雞胸肉沙拉", "茶葉蛋"]
    assert body["items"][0]["nutrition"]["kcal"] == "92.00"  # 230 / 250 g × 100
    assert body["analysis_id"] is not None
    assert body["remaining_today"] == settings.ai_daily_limit - 1
    expected = suggestion_request(
        Remaining(kcal=Decimal("1500.00"), protein_g=Decimal("90.00"), fat_g=None, carb_g=None),
        "不吃牛",
    )
    assert fake.requests == [expected]
    assert "- 熱量：1500 大卡" in expected
    assert fake.other_calls == 0
    rows = await _rows(db_session, user_id)
    assert [(r.succeeded, r.kind) for r in rows] == [(True, AnalysisKind.SUGGEST)]
    assert rows[0].input_hash == hashlib.sha256(expected.encode()).hexdigest()


async def test_the_budget_includes_todays_exercise(client, db_session):
    """熱量用今天的額度（運動設定開：目標＋運動），不是目標本身（規格 §3）。"""
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000)
    await create_exercise(db_session, user=user, performed_at=datetime.now(UTC), kcal=343)
    fake = FakeSuggestEstimator()
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == 200
    assert "- 熱量：2343 大卡" in fake.requests[0]


async def test_the_preference_is_cleaned_to_one_line_and_blank_means_none(client, db_session):
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000)
    fake = FakeSuggestEstimator()
    _inject(fake)
    # 換行與零寬空白（用 chr 組：原始碼裡不放看不見的字）。
    messy = "  不吃牛" + chr(10) + "想吃" + chr(0x200B) + "便當 "

    for payload in ({"preference": messy}, {"preference": "   "}, {"preference": None}, {}):
        response = await client.post(URL, headers=auth(user), json=payload)
        assert response.status_code == 200, payload

    assert "「不吃牛 想吃便當」" in fake.requests[0]
    assert all(NO_PREFERENCE in request for request in fake.requests[1:])
    assert len(fake.requests) == 4


async def test_a_preference_over_100_characters_is_422_before_anything(client, db_session):
    user = await create_user(db_session)
    user_id, headers = user.id, auth(user)  # _rows() 會 rollback，之後 user 就過期了
    await create_target(db_session, user=user, kcal=2000)
    fake = FakeSuggestEstimator()
    _inject(fake)

    too_long = await client.post(URL, headers=headers, json={"preference": "飯" * 101})

    assert too_long.status_code == 422
    assert too_long.json()["error"]["code"] == "VALIDATION_ERROR"
    assert fake.requests == []
    assert await _rows(db_session, user_id) == []

    just_right = await client.post(URL, headers=headers, json={"preference": "飯" * 100})

    assert just_right.status_code == 200
    assert len(fake.requests) == 1


@pytest.mark.parametrize("target", [None, "protein_only"])
async def test_no_kcal_target_is_422_and_free(client, db_session, target):
    user = await create_user(db_session)
    user_id = user.id
    if target == "protein_only":
        await create_target(db_session, user=user, kcal=None, protein_g=90)
    fake = FakeSuggestEstimator()
    _inject(fake)

    response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "NO_KCAL_TARGET"
    assert fake.requests == []
    assert await _rows(db_session, user_id) == []


async def test_no_kcal_target_is_422_even_when_ai_is_not_configured(
    client, db_session, monkeypatch
):
    """規格 D17：使用者自己能處理的狀態先說，不先說「AI 沒設定」。"""
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)

    response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "NO_KCAL_TARGET"


async def test_a_full_day_is_422_and_free(client, db_session, monkeypatch):
    user = await create_user(db_session)
    user_id, headers = user.id, auth(user)  # _rows() 會 rollback，之後 user 就過期了
    await create_target(db_session, user=user, kcal=700)
    await _ate_now(db_session, user, 680)
    fake = FakeSuggestEstimator()
    _inject(fake)

    response = await client.post(URL, headers=headers, json={})

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "DAY_ALREADY_FULL"
    assert fake.requests == []
    assert await _rows(db_session, user_id) == []

    # AI 沒設定時也一樣是 422（規格 D17 的順序）。
    app.dependency_overrides.pop(get_estimator_factory)
    monkeypatch.setattr(settings, "ai_provider", None)
    unconfigured = await client.post(URL, headers=headers, json={})
    assert unconfigured.json()["error"]["code"] == "DAY_ALREADY_FULL"


async def test_not_configured_is_503_when_there_is_something_to_plan(
    client, db_session, monkeypatch
):
    monkeypatch.setattr(settings, "ai_provider", None)
    user = await create_user(db_session)
    user_id = user.id
    await create_target(db_session, user=user, kcal=2000)

    response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"
    assert await _rows(db_session, user_id) == []


async def test_the_quota_is_shared_with_the_estimates(client, db_session):
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000)
    await _seed_analyses(db_session, user, settings.ai_daily_limit - 1)
    fake = FakeSuggestEstimator()
    _inject(fake)

    first = await client.post(URL, headers=auth(user), json={})
    second = await client.post(URL, headers=auth(user), json={})

    assert first.status_code == 200
    assert first.json()["remaining_today"] == 0
    assert second.status_code == 429
    assert second.json()["error"]["code"] == "AI_DAILY_LIMIT"
    assert len(fake.requests) == 1


@pytest.mark.parametrize(
    ("make_error", "status", "code", "recorded"),
    [
        (lambda: EstimatorUpstreamError("boom"), 502, "AI_UPSTREAM_ERROR", True),
        (lambda: EstimatorMisconfiguredError("bad key"), 503, "AI_MISCONFIGURED", False),
        (lambda: _error_from_parsing("不是 JSON"), 502, "AI_BAD_RESPONSE", True),
    ],
    ids=["upstream", "misconfigured", "bad-response"],
)
async def test_failures_are_classified_and_recorded_like_analyze_meal(
    client, db_session, make_error, status, code, recorded
):
    user = await create_user(db_session)
    user_id = user.id
    await create_target(db_session, user=user, kcal=2000)
    _inject(FakeSuggestEstimator(error=make_error()))

    response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == status
    assert response.json()["error"]["code"] == code
    rows = await _rows(db_session, user_id)
    expected = [(False, AnalysisKind.SUGGEST)] if recorded else []
    assert [(r.succeeded, r.kind) for r in rows] == expected


async def test_no_suggestion_is_502_with_its_own_code_and_uses_the_quota(
    client, db_session, caplog
):
    user = await create_user(db_session)
    user_id = user.id
    await create_target(db_session, user=user, kcal=2000)
    _inject(
        FakeSuggestEstimator(error=_error_from_parsing('{"description": "", "items": []}'))
    )

    with caplog.at_level(logging.WARNING, logger="app"):
        response = await client.post(URL, headers=auth(user), json={})

    assert response.status_code == 502
    error = response.json()["error"]
    assert error["code"] == "AI_NO_SUGGESTION"
    assert "換個偏好" in error["message"]
    rows = await _rows(db_session, user_id)
    assert [(r.succeeded, r.kind) for r in rows] == [(False, AnalysisKind.SUGGEST)]
    assert "AI_NO_SUGGESTION" in caplog.text


async def test_the_preference_never_reaches_the_log(client, db_session, caplog):
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000)
    reply = json.dumps(
        {
            "description": "秘密的描述",
            "items": [
                {"name": "秘密的食物", "brand": None, "serving_grams": 100, "serving_kcal": -5,
                 "serving_protein_g": 1, "serving_fat_g": 1, "serving_carb_g": 1,
                 "confidence": 0.5},
            ],
        },
        ensure_ascii=False,
    )  # fmt: skip
    _inject(FakeSuggestEstimator(error=_error_from_parsing(reply)))

    with caplog.at_level(logging.DEBUG, logger="app"):
        failed = await client.post(URL, headers=auth(user), json={"preference": "秘密偏好"})
        _inject(FakeSuggestEstimator())
        succeeded = await client.post(URL, headers=auth(user), json={"preference": "秘密偏好"})

    assert failed.status_code == 502
    assert failed.json()["error"]["code"] == "AI_BAD_RESPONSE"
    assert succeeded.status_code == 200
    # 先證明 log 有東西（失敗那一次的位置與種類）：只斷言「沒有」的話，log 沒接上也會綠。
    assert "items.0.serving_kcal" in caplog.text
    assert "秘密偏好" not in caplog.text


async def test_an_item_with_the_same_name_as_my_food_reports_it(client, db_session):
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000)
    egg = await create_food(db_session, created_by=user, owner=user, name="茶葉蛋")
    egg_id = egg.id
    _inject(FakeSuggestEstimator())

    body = (await client.post(URL, headers=auth(user), json={})).json()

    assert body["items"][0]["library_food"] is None
    assert body["items"][1]["library_food"]["food_id"] == egg_id


async def test_requires_login(client):
    response = await client.post(URL, json={})
    assert response.status_code == 401
