"""`POST /api/foods/parse-label-text`（標示 OCR 規格 §5）：形狀、401／422／429、不碰 AI。"""

import logging
from pathlib import Path

from sqlalchemy import func, select

from app.api.deps import get_estimator_factory
from app.main import app
from app.models.ai_analysis import AiAnalysis
from app.security.tokens import create_access_token
from tests.factories import create_user

URL = "/api/foods/parse-label-text"
FIXTURES = Path(__file__).parent / "fixtures" / "label_text"
BOTH = (FIXTURES / "both_photo.txt").read_text(encoding="utf-8")


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_a_complete_label(client, db_session):
    user = await create_user(db_session)
    response = await client.post(URL, headers=auth(user), json={"text": BOTH})

    assert response.status_code == 200
    assert response.json() == {
        "complete": True,
        "base_unit": "g",
        "nutrition": {
            "base_unit": "g",
            "kcal": "514.00",
            "protein_g": "6.00",
            "fat_g": "28.00",
            "carb_g": "60.90",
        },
        "found": {"kcal": "514.00", "protein_g": "6.00", "fat_g": "28.00", "carb_g": "60.90"},
        "missing": [],
        "reason": None,
        "serving": {"amount": "35.00", "unit": "g"},
        "servings_per_package": "4.00",
        "basis": "per_100",
        "consistency": {"atwater_kcal": "519.60", "deviation": "5.60", "flagged": False},
    }


async def test_no_ai_no_quota(client, db_session):
    """不呼叫 estimator（建它就丟）、不寫 ai_analyses。"""
    user = await create_user(db_session)
    user_id = user.id

    def explode():
        raise AssertionError("parse-label-text 不該碰 AI")

    app.dependency_overrides[get_estimator_factory] = lambda: explode
    response = await client.post(URL, headers=auth(user), json={"text": BOTH})

    assert response.status_code == 200
    await db_session.rollback()
    rows = await db_session.scalar(
        select(func.count()).select_from(AiAnalysis).where(AiAnalysis.user_id == user_id)
    )
    assert rows == 0


async def test_per_serving_in_ml(client, db_session):
    user = await create_user(db_session)
    text = (FIXTURES / "serving_photo.txt").read_text(encoding="utf-8")

    body = (await client.post(URL, headers=auth(user), json={"text": text})).json()

    assert body["complete"] is True
    assert body["basis"] == "per_serving"
    assert body["nutrition"] == {
        "base_unit": "ml",
        "kcal": "54.00",
        "protein_g": "3.20",
        "fat_g": "3.00",
        "carb_g": "3.60",
    }
    assert body["serving"] == {"amount": "250.00", "unit": "ml"}


async def test_incomplete_is_200_with_what_was_found(client, db_session):
    user = await create_user(db_session)
    text = (FIXTURES / "kj_photo.txt").read_text(encoding="utf-8")

    response = await client.post(URL, headers=auth(user), json={"text": text})

    assert response.status_code == 200
    body = response.json()
    assert body["complete"] is False
    assert body["nutrition"] is None
    assert body["basis"] is None
    assert body["consistency"] is None
    assert body["found"] == {
        "kcal": None,
        "protein_g": "6.00",
        "fat_g": "28.00",
        "carb_g": "60.90",
    }
    assert body["missing"] == ["kcal"]
    assert body["reason"] == "missing_fields"
    assert body["serving"] == {"amount": "30.00", "unit": "g"}


async def test_needs_login(client):
    response = await client.post(URL, json={"text": BOTH})

    assert response.status_code == 401


async def test_text_length(client, db_session):
    headers = auth(await create_user(db_session))

    assert (await client.post(URL, headers=headers, json={"text": ""})).status_code == 422
    assert (await client.post(URL, headers=headers, json={"text": "字" * 4001})).status_code == 422
    assert (await client.post(URL, headers=headers, json={"text": "字" * 4000})).status_code == 200


async def test_the_31st_in_a_minute_is_429(client, db_session):
    user, other = await create_user(db_session), await create_user(db_session)
    headers = auth(user)

    for _ in range(30):
        ok = await client.post(URL, headers=headers, json={"text": "x"})
        assert ok.status_code == 200
    blocked = await client.post(URL, headers=headers, json={"text": "x"})

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_LABEL_PARSES"
    assert "retry-after" in blocked.headers
    # 鍵是使用者：別人照樣讀得到
    others = await client.post(URL, headers=auth(other), json={"text": "x"})
    assert others.status_code == 200


async def test_the_text_never_reaches_the_log(client, db_session, caplog):
    # root 設成 DEBUG、掃每一個 record：不是只看某一個 logger。
    caplog.set_level(logging.DEBUG)
    headers = auth(await create_user(db_session))
    secret = "雞皮洋芋片的祕密配方"

    ok = await client.post(URL, headers=headers, json={"text": f"{secret}\n{BOTH}"})
    rejected = await client.post(URL, headers=headers, json={"text": secret * 401})

    assert ok.status_code == 200
    assert rejected.status_code == 422
    assert not any(secret in record.getMessage() for record in caplog.records)
