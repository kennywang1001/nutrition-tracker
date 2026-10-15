"""活動清單與估算預覽（運動規格 §4.3、§6、D7、D8、D9、D11、D18）。

「現在」monkeypatch `app.api.routes.exercises.utc_now`（計畫「開工前必讀」第 3 點；這兩個端點
不用「今天」）。使用者的時區是 `America/New_York`——不是預設的
Asia/Taipei，用錯時區算「哪一天」才測得出來。

體重用字串 `"70.00"` 建：資料庫的 `Numeric(5,2)` 讀回來就是兩位小數，而共用 session 的
identity map 會把工廠建的那個物件原樣還回來（handover §6 第 49 種）。
"""

from datetime import UTC, date, datetime, timedelta

import pytest

from app.exercise import ACTIVITIES
from app.models.user import User
from app.security.tokens import create_access_token
from tests.factories import create_user, create_weight

TODAY = date(2026, 10, 14)
# America/New_York 的 2026-10-14 12:00（EDT，UTC−4）＝ 16:00Z。
NOON = datetime(2026, 10, 14, 16, 0, tzinfo=UTC)
ACTIVITIES_URL = "/api/exercise/activities"
ESTIMATE = "/api/exercise/estimate"


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


def iso(instant: datetime) -> str:
    return instant.isoformat().replace("+00:00", "Z")


@pytest.fixture
def clock(monkeypatch) -> None:
    """「現在」固定在 NOON（UTC）。"""
    monkeypatch.setattr("app.api.routes.exercises.utc_now", lambda: NOON)


async def _user(db_session) -> User:
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def _estimate(client, user_id: int, **params):
    query = {"activity": "running", "minutes": 30, **params}
    return await client.get(ESTIMATE, headers=auth(user_id), params=query)


# ---------------------------------------------------------------------------
# 活動清單
# ---------------------------------------------------------------------------


async def test_the_activity_list_comes_from_the_backend(client, db_session):
    user = await _user(db_session)

    response = await client.get(ACTIVITIES_URL, headers=auth(user.id))

    assert response.status_code == 200
    body = response.json()
    assert len(body) == 19
    assert [item["code"] for item in body] == [a.code.value for a in ACTIVITIES]
    by_code = {item["code"]: item for item in body}
    assert by_code["running"] == {"code": "running", "label": "跑步（約 10 km/h）", "met": "9.8"}
    assert by_code["other"] == {"code": "other", "label": "其他", "met": None}
    assert by_code["yoga"]["label"] == "瑜伽"


async def test_the_activity_list_requires_a_token(client):
    response = await client.get(ACTIVITIES_URL)

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# 估算的兩種形狀
# ---------------------------------------------------------------------------


async def test_an_estimate_with_a_weight_on_that_day(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _estimate(client, user.id, performed_at=iso(NOON))

    assert response.status_code == 200
    assert response.json() == {
        "ready": True,
        "kcal": "343",
        "met": "9.8",
        "weight_kg": "70.00",
        "weight_date": "2026-10-14",
    }


async def test_performed_at_defaults_to_now(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    # 「現在」之後一天的體重：省略 performed_at 如果被當成別的時刻（例如明天），會用到它。
    await create_weight(db_session, user=user, day=TODAY + timedelta(days=1), weight_kg="90.00")

    response = await _estimate(client, user.id)

    assert response.status_code == 200
    assert response.json()["kcal"] == "343"
    assert response.json()["weight_date"] == "2026-10-14"


async def test_the_weight_on_or_before_that_day_is_used(client, db_session, clock):
    """D7：補記 10/12 的運動用 10/10 的體重，不是後來 10/14 的。"""
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg="60.00")
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    earlier = await _estimate(
        client, user.id, performed_at=iso(datetime(2026, 10, 12, 16, 0, tzinfo=UTC))
    )
    same_day = await _estimate(client, user.id, performed_at=iso(NOON))

    assert earlier.status_code == 200
    assert earlier.json()["kcal"] == "294"  # 9.8 × 60 × 30 / 60
    assert earlier.json()["weight_kg"] == "60.00"
    assert earlier.json()["weight_date"] == "2026-10-10"
    # 剛好在那一天的體重也算（<=，不是 <）。
    assert same_day.json()["kcal"] == "343"
    assert same_day.json()["weight_date"] == "2026-10-14"


async def test_a_later_weight_does_not_count(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _estimate(
        client, user.id, performed_at=iso(datetime(2026, 10, 13, 16, 0, tzinfo=UTC))
    )

    assert response.status_code == 200
    assert response.json() == {"ready": False, "missing": "weight"}


async def test_the_users_timezone_decides_which_day(client, db_session, clock):
    """體重只有 10/14。03:30Z 是紐約的 10/13 23:30、04:30Z 是 10/14 00:30。
    用 UTC 算日期的話兩個都是 10/14，第一個會錯成 ready。"""
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    before = await _estimate(
        client, user.id, performed_at=iso(datetime(2026, 10, 14, 3, 30, tzinfo=UTC))
    )
    after = await _estimate(
        client, user.id, performed_at=iso(datetime(2026, 10, 14, 4, 30, tzinfo=UTC))
    )

    assert before.json() == {"ready": False, "missing": "weight"}
    assert after.json()["ready"] is True


async def test_no_weight_at_all_is_not_ready(client, db_session, clock):
    user = await _user(db_session)

    response = await _estimate(client, user.id, performed_at=iso(NOON))

    assert response.status_code == 200
    assert response.json() == {"ready": False, "missing": "weight"}


# ---------------------------------------------------------------------------
# 錯誤
# ---------------------------------------------------------------------------


async def test_other_cannot_be_estimated(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _estimate(client, user.id, activity="other", performed_at=iso(NOON))

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "EXERCISE_NOT_ESTIMABLE"


@pytest.mark.parametrize(
    ("activity", "kg", "minutes", "status", "kcal"),
    [
        ("jump_rope", "350.00", 80, 422, None),  # H：5507
        ("jump_rope", "300.00", 80, 200, "4720"),  # I
        ("weight_training_vigorous", "250.00", 200, 200, "5000"),  # 剛好在上限上
    ],
)
async def test_an_estimate_above_5000_is_refused_not_clamped(
    client, db_session, clock, activity, kg, minutes, status, kcal
):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg=kg)

    response = await _estimate(
        client, user.id, activity=activity, minutes=minutes, performed_at=iso(NOON)
    )

    assert response.status_code == status
    if kcal is None:
        assert response.json()["error"]["code"] == "EXERCISE_ESTIMATE_TOO_HIGH"
    else:
        assert response.json()["kcal"] == kcal


@pytest.mark.parametrize(
    ("offset", "status"),
    [(timedelta(minutes=5), 200), (timedelta(minutes=5, seconds=1), 422)],
)
async def test_the_future_is_refused_after_five_minutes(
    client, db_session, clock, offset, status
):
    """D18：給裝置時鐘五分鐘的誤差。"""
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _estimate(client, user.id, performed_at=iso(NOON + offset))

    assert response.status_code == status
    if status == 422:
        assert response.json()["error"]["code"] == "EXERCISE_IN_FUTURE"


@pytest.mark.parametrize(
    "params",
    [
        {"minutes": 0},
        {"minutes": 601},
        {"minutes": "1.5"},
        {"activity": "swim"},
        {"performed_at": "2026-10-14T12:00:00"},  # naive：沒有時區
        # 審查 M1：換到使用者時區會超出 datetime 的範圍（原本是 500 OverflowError）。
        {"performed_at": "0001-01-01T00:00:00+14:00"},
        {"performed_at": "1899-12-31T23:59:59Z"},
    ],
)
async def test_bad_parameters_are_422(client, db_session, clock, params):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _estimate(client, user.id, **params)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_the_earliest_accepted_time_is_1900_utc(client, db_session, clock):
    """審查 M1 的邊界：1900-01-01 00:00 UTC 收（那天以前沒有體重，所以是 ready: false）。"""
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _estimate(client, user.id, performed_at="1900-01-01T00:00:00Z")

    assert response.status_code == 200
    assert response.json() == {"ready": False, "missing": "weight"}


async def test_minutes_is_required(client, db_session, clock):
    user = await _user(db_session)

    response = await client.get(ESTIMATE, headers=auth(user.id), params={"activity": "running"})

    assert response.status_code == 422


async def test_the_edges_of_minutes_are_accepted(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    shortest = await _estimate(client, user.id, minutes=1)
    # 跑步 600 分鐘是 6860，會撞上限；用瑜伽量「600 分鐘收得下」。
    longest = await _estimate(client, user.id, activity="yoga", minutes=600)

    assert shortest.json()["kcal"] == "11"  # 9.8 × 70 / 60 = 11.43
    assert longest.json()["kcal"] == "1750"  # 2.5 × 70 × 10


async def test_the_estimate_requires_a_token(client):
    response = await client.get(ESTIMATE, params={"activity": "running", "minutes": 30})

    assert response.status_code == 401


async def test_only_the_callers_own_weight_is_used(client, db_session, clock):
    owner = await _user(db_session)
    stranger = await _user(db_session)
    await create_weight(db_session, user=owner, day=TODAY, weight_kg="70.00")

    # 先確認有體重的那個人自己估得出來：不然「另一個人估不出來」可能只是端點壞了。
    mine = await _estimate(client, owner.id, performed_at=iso(NOON))
    theirs = await _estimate(client, stranger.id, performed_at=iso(NOON))

    assert mine.json()["ready"] is True
    assert theirs.json() == {"ready": False, "missing": "weight"}
