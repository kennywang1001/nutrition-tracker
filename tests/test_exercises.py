"""運動紀錄的新增、讀取、修改、刪除（運動規格 §6、D4、D5、D7、D10、D18–D22）。

「今天」monkeypatch `app.api.routes.exercises.today_in_timezone`（記下收到的時區）、「現在」
monkeypatch `utc_now`。使用者的時區是 `America/New_York`——傳錯時區才測得出來。

資料庫裡的值用「選欄位」讀（`_rows`），不靠 identity map 裡的物件（handover §6 第 49 種）。
體重用 `"70.00"` 這種兩位小數的字串建，理由同 `test_exercise_estimate.py`。
"""

from datetime import UTC, date, datetime, timedelta

import pytest
from sqlalchemy import event, select

from app.exercise import ActivityCode, KcalSource
from app.models.exercise import ExerciseEntry
from app.models.user import User
from app.security.tokens import create_access_token
from tests.factories import create_exercise, create_user, create_weight

TODAY = date(2026, 10, 14)
# America/New_York 的 2026-10-14 12:00（EDT，UTC−4）＝ 16:00Z。
NOON = datetime(2026, 10, 14, 16, 0, tzinfo=UTC)
URL = "/api/exercises"
RUNNING = {"activity": "running", "minutes": 30}


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


def iso(instant: datetime) -> str:
    return instant.isoformat().replace("+00:00", "Z")


def item(exercise_id: int) -> str:
    return f"{URL}/{exercise_id}"


@pytest.fixture
def clock(monkeypatch) -> list[str]:
    """「現在」固定在 NOON（UTC），「今天」固定在 TODAY 並記下收到的時區。"""
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.exercises.today_in_timezone", fake_today)
    monkeypatch.setattr("app.api.routes.exercises.utc_now", lambda: NOON)
    return seen


async def _user(db_session) -> User:
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def _rows(db_session, user_id: int) -> list[dict]:
    rows = await db_session.execute(
        select(
            ExerciseEntry.id,
            ExerciseEntry.performed_at,
            ExerciseEntry.activity,
            ExerciseEntry.name,
            ExerciseEntry.minutes,
            ExerciseEntry.kcal,
            ExerciseEntry.kcal_source,
            ExerciseEntry.note,
        )
        .where(ExerciseEntry.user_id == user_id)
        .order_by(ExerciseEntry.id)
    )
    return [dict(row._mapping) for row in rows]


async def _post(client, user_id: int, **body):
    payload = {**RUNNING, "performed_at": iso(NOON), **body}
    return await client.post(URL, headers=auth(user_id), json=payload)


def _code(response) -> str:
    return response.json()["error"]["code"]


# ---------------------------------------------------------------------------
# POST
# ---------------------------------------------------------------------------


async def test_post_estimates_from_the_weight(client, db_session, clock):
    user = await _user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _post(client, user_id)

    assert response.status_code == 201
    body = response.json()
    assert body["kcal"] == "343.00"
    assert body["kcal_source"] == "estimated"
    assert body["label"] == "跑步（約 10 km/h）"
    assert body["name"] is None
    assert body["activity"] == "running"
    assert body["minutes"] == 30
    assert body["note"] is None
    assert datetime.fromisoformat(body["performed_at"]) == NOON
    assert {"id", "created_at", "updated_at"} <= body.keys()
    rows = await _rows(db_session, user_id)
    assert len(rows) == 1
    assert rows[0]["id"] == body["id"]
    assert rows[0]["kcal"] == 343
    assert rows[0]["kcal_source"] is KcalSource.ESTIMATED


async def test_post_with_kcal_is_manual_and_needs_no_weight(client, db_session, clock):
    user = await _user(db_session)
    user_id = user.id

    response = await _post(client, user_id, kcal="250", note="晨跑")

    assert response.status_code == 201
    assert response.json()["kcal"] == "250.00"
    assert response.json()["kcal_source"] == "manual"
    assert response.json()["note"] == "晨跑"
    assert (await _rows(db_session, user_id))[0]["kcal_source"] is KcalSource.MANUAL


async def test_post_without_a_weight_or_kcal_is_422(client, db_session, clock):
    """D8：不給預設體重。"""
    user = await _user(db_session)
    user_id = user.id

    response = await _post(client, user_id)

    assert response.status_code == 422
    assert _code(response) == "EXERCISE_NEEDS_WEIGHT"
    assert await _rows(db_session, user_id) == []


async def test_post_uses_the_weight_on_or_before_that_day(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg="60.00")
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _post(
        client, user.id, performed_at=iso(datetime(2026, 10, 12, 16, 0, tzinfo=UTC))
    )

    assert response.status_code == 201
    assert response.json()["kcal"] == "294.00"  # 9.8 × 60 × 30 / 60


async def test_post_other_with_a_name_and_kcal(client, db_session, clock):
    user = await _user(db_session)

    response = await _post(client, user.id, activity="other", name="划船", kcal="300")

    assert response.status_code == 201
    body = response.json()
    assert body["label"] == "划船"
    assert body["name"] == "划船"
    assert body["kcal_source"] == "manual"
    assert body["kcal"] == "300.00"


@pytest.mark.parametrize(
    "body",
    [
        {"activity": "other", "kcal": "300"},  # 沒有名稱
        {"activity": "other", "name": "划船"},  # 沒有熱量
        # 清完是空的：零寬空白＋一個空白。
        {"activity": "other", "name": "\u200b ", "kcal": "300"},
    ],
)
async def test_post_other_without_a_name_or_kcal_is_422(client, db_session, clock, body):
    user = await _user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    response = await _post(client, user_id, **body)

    assert response.status_code == 422
    assert _code(response) == "VALIDATION_ERROR"
    assert await _rows(db_session, user_id) == []


async def test_a_name_on_a_fixed_activity_is_stored_as_null(client, db_session, clock):
    user = await _user(db_session)
    user_id = user.id

    response = await _post(client, user_id, name="晨跑", kcal="250")

    assert response.status_code == 201
    assert response.json()["name"] is None
    assert (await _rows(db_session, user_id))[0]["name"] is None


@pytest.mark.parametrize("raw", ["晨\n跑", "晨\x00跑", " 晨 \t 跑 "])
async def test_the_name_is_cleaned_into_one_line(client, db_session, clock, raw):
    user = await _user(db_session)

    response = await _post(client, user.id, activity="other", name=raw, kcal="250")

    assert response.status_code == 201
    assert response.json()["name"] == "晨 跑"


@pytest.mark.parametrize(
    ("body", "status"),
    [
        ({"minutes": 0, "kcal": "100"}, 422),
        ({"minutes": 1, "kcal": "100"}, 201),
        ({"minutes": 600, "kcal": "100"}, 201),
        ({"minutes": 601, "kcal": "100"}, 422),
        ({"kcal": "0.99"}, 422),
        ({"kcal": "1"}, 201),
        ({"kcal": "5000"}, 201),
        ({"kcal": "5000.01"}, 422),
        ({"kcal": "1.001"}, 422),
        ({"kcal": "100", "note": "x" * 200}, 201),
        ({"kcal": "100", "note": "x" * 201}, 422),
        ({"activity": "other", "kcal": "100", "name": "x" * 50}, 201),
        ({"activity": "other", "kcal": "100", "name": "x" * 51}, 422),
        ({"activity": "swim", "kcal": "100"}, 422),
    ],
)
async def test_the_ranges(client, db_session, clock, body, status):
    user = await _user(db_session)

    response = await _post(client, user.id, **body)

    assert response.status_code == status
    if status == 422:
        assert _code(response) == "VALIDATION_ERROR"


@pytest.mark.parametrize(
    ("performed_at", "status"),
    [
        (iso(NOON + timedelta(minutes=5)), 201),
        (iso(NOON + timedelta(minutes=5, seconds=1)), 422),
        ("2026-10-14T12:00:00", 422),  # naive
    ],
)
async def test_post_refuses_the_future_and_naive_times(
    client, db_session, clock, performed_at, status
):
    user = await _user(db_session)
    user_id = user.id

    response = await _post(client, user_id, kcal="100", performed_at=performed_at)

    assert response.status_code == status
    if status == 422:
        assert await _rows(db_session, user_id) == []
    if performed_at.endswith("01Z"):
        assert _code(response) == "EXERCISE_IN_FUTURE"


async def test_a_too_high_estimate_is_422_but_the_same_minutes_by_hand_are_fine(
    client, db_session, clock
):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="350.00")

    estimated = await _post(client, user.id, activity="jump_rope", minutes=80)
    by_hand = await _post(client, user.id, activity="jump_rope", minutes=80, kcal="4999")

    assert estimated.status_code == 422
    assert _code(estimated) == "EXERCISE_ESTIMATE_TOO_HIGH"
    assert by_hand.status_code == 201
    assert by_hand.json()["kcal"] == "4999.00"


async def test_post_requires_a_token(client):
    response = await client.post(URL, json={**RUNNING, "performed_at": iso(NOON)})

    assert response.status_code == 401


# ---------------------------------------------------------------------------
# GET 清單與單筆
# ---------------------------------------------------------------------------


async def test_the_list_is_one_local_day_oldest_first_with_a_total(client, db_session, clock):
    """紐約的 10/14 是 [10/14 04:00Z, 10/15 04:00Z)。"""
    user = await _user(db_session)
    outside_before = datetime(2026, 10, 14, 3, 59, tzinfo=UTC)
    first = datetime(2026, 10, 14, 4, 0, tzinfo=UTC)
    last = datetime(2026, 10, 15, 3, 59, tzinfo=UTC)
    outside_after = datetime(2026, 10, 15, 4, 0, tzinfo=UTC)
    # 先建晚的：由舊到新是排序排出來的，不是剛好照建立的順序。
    await create_exercise(db_session, user=user, performed_at=last, kcal=200)
    await create_exercise(db_session, user=user, performed_at=outside_after, kcal=1000)
    await create_exercise(db_session, user=user, performed_at=first, kcal=100)
    await create_exercise(db_session, user=user, performed_at=outside_before, kcal=2000)

    response = await client.get(URL, headers=auth(user.id), params={"date": "2026-10-14"})

    assert response.status_code == 200
    body = response.json()
    assert body["date"] == "2026-10-14"
    assert [datetime.fromisoformat(e["performed_at"]) for e in body["entries"]] == [first, last]
    assert [e["kcal"] for e in body["entries"]] == ["100.00", "200.00"]
    assert body["total_kcal"] == "300.00"


async def test_a_day_without_exercise_has_a_zero_total(client, db_session, clock):
    user = await _user(db_session)
    await create_exercise(db_session, user=user, performed_at=NOON)

    response = await client.get(URL, headers=auth(user.id), params={"date": "2026-10-01"})

    assert response.json() == {"date": "2026-10-01", "total_kcal": "0.00", "entries": []}


async def test_the_list_defaults_to_today_in_the_users_timezone(client, db_session, clock):
    user = await _user(db_session)
    await create_exercise(db_session, user=user, performed_at=NOON)

    response = await client.get(URL, headers=auth(user.id))

    assert response.status_code == 200
    assert response.json()["date"] == "2026-10-14"
    assert len(response.json()["entries"]) == 1
    assert clock == ["America/New_York"]


async def test_the_list_only_has_the_callers_own(client, db_session, clock):
    owner = await _user(db_session)
    stranger = await _user(db_session)
    await create_exercise(db_session, user=owner, performed_at=NOON, kcal=100)
    await create_exercise(db_session, user=stranger, performed_at=NOON, kcal=900)

    response = await client.get(URL, headers=auth(owner.id), params={"date": "2026-10-14"})

    assert [e["kcal"] for e in response.json()["entries"]] == ["100.00"]
    assert response.json()["total_kcal"] == "100.00"


async def test_get_one_is_only_for_the_owner(client, db_session, clock):
    owner = await _user(db_session)
    stranger = await _user(db_session)
    entry = await create_exercise(db_session, user=owner, performed_at=NOON, note="晨跑")
    entry_id = entry.id

    mine = await client.get(item(entry_id), headers=auth(owner.id))
    theirs = await client.get(item(entry_id), headers=auth(stranger.id))
    missing = await client.get(item(entry_id + 1000), headers=auth(owner.id))

    assert mine.status_code == 200
    assert mine.json()["id"] == entry_id
    assert mine.json()["kcal"] == "343.00"
    assert mine.json()["note"] == "晨跑"
    assert theirs.status_code == 404
    assert _code(theirs) == "EXERCISE_NOT_FOUND"
    # 別人的跟不存在的同一個回應。
    assert missing.status_code == 404
    assert missing.json() == theirs.json()


@pytest.mark.parametrize("bad", ["0", "abc"])
async def test_a_bad_id_is_422(client, db_session, bad):
    user = await _user(db_session)

    response = await client.get(f"{URL}/{bad}", headers=auth(user.id))

    assert response.status_code == 422


# ---------------------------------------------------------------------------
# PATCH
# ---------------------------------------------------------------------------


async def _patch(client, user_id: int, entry_id: int, **body):
    return await client.patch(item(entry_id), headers=auth(user_id), json=body)


async def test_changing_only_the_note_does_not_re_estimate(client, db_session, clock):
    """D22：體重後來改成 80（重估會是 392），只改備註的熱量仍是 343。"""
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="80.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)
    entry_id = entry.id

    noted = await _patch(client, user.id, entry_id, note="晨跑")
    cleared = await _patch(client, user.id, entry_id, note=None)

    assert noted.status_code == 200
    assert noted.json()["kcal"] == "343.00"
    assert noted.json()["kcal_source"] == "estimated"
    assert noted.json()["note"] == "晨跑"
    assert cleared.json()["note"] is None
    assert (await _rows(db_session, user.id))[0]["note"] is None


async def test_changing_the_minutes_re_estimates(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)

    response = await _patch(client, user.id, entry.id, minutes=60)

    assert response.status_code == 200
    assert response.json()["kcal"] == "686.00"
    assert response.json()["kcal_source"] == "estimated"
    assert (await _rows(db_session, user.id))[0]["kcal"] == 686


async def test_changing_the_activity_re_estimates(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)

    response = await _patch(client, user.id, entry.id, activity="walking")

    assert response.json()["kcal"] == "123.00"  # 3.5 × 70 × 30 / 60 = 122.5 → 123
    assert response.json()["label"] == "走路"


async def test_moving_to_another_day_uses_that_days_weight(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=date(2026, 10, 10), weight_kg="60.00")
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)
    entry_id = entry.id

    moved = await _patch(
        client, user.id, entry_id, performed_at=iso(datetime(2026, 10, 12, 16, 0, tzinfo=UTC))
    )
    future = await _patch(
        client, user.id, entry_id, performed_at=iso(NOON + timedelta(minutes=5, seconds=1))
    )

    assert moved.status_code == 200
    assert moved.json()["kcal"] == "294.00"
    assert future.status_code == 422
    assert _code(future) == "EXERCISE_IN_FUTURE"
    assert (await _rows(db_session, user.id))[0]["kcal"] == 294


async def test_kcal_switches_between_manual_and_estimated(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)
    entry_id = entry.id

    manual = await _patch(client, user.id, entry_id, kcal="500")
    back = await _patch(client, user.id, entry_id, kcal=None)

    assert manual.json()["kcal"] == "500.00"
    assert manual.json()["kcal_source"] == "manual"
    assert back.status_code == 200
    assert back.json()["kcal"] == "343.00"
    assert back.json()["kcal_source"] == "estimated"


async def test_a_manual_entry_keeps_its_kcal_when_the_minutes_change(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(
        db_session, user=user, performed_at=NOON, kcal=250, kcal_source=KcalSource.MANUAL
    )

    response = await _patch(client, user.id, entry.id, minutes=60)

    assert response.status_code == 200
    assert response.json()["minutes"] == 60
    assert response.json()["kcal"] == "250.00"
    assert response.json()["kcal_source"] == "manual"


async def test_becoming_other_needs_a_name_and_kcal(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)
    entry_id = entry.id

    no_kcal = await _patch(client, user.id, entry_id, activity="other", name="划船")
    no_name = await _patch(client, user.id, entry_id, activity="other", kcal="300")
    both = await _patch(client, user.id, entry_id, activity="other", name="划船", kcal="300")

    assert no_kcal.status_code == 422
    assert _code(no_kcal) == "EXERCISE_NEEDS_KCAL"
    assert no_name.status_code == 422
    assert _code(no_name) == "EXERCISE_NEEDS_NAME"
    assert both.status_code == 200
    assert both.json()["label"] == "划船"
    assert both.json()["kcal_source"] == "manual"
    assert both.json()["kcal"] == "300.00"


async def test_other_cannot_lose_its_name_or_go_back_to_estimated(client, db_session, clock):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(
        db_session,
        user=user,
        performed_at=NOON,
        activity=ActivityCode.OTHER,
        name="划船",
        kcal=300,
        kcal_source=KcalSource.MANUAL,
    )
    entry_id = entry.id

    no_name = await _patch(client, user.id, entry_id, name=None)
    estimated = await _patch(client, user.id, entry_id, kcal=None)
    renamed = await _patch(client, user.id, entry_id, name="獨木舟", minutes=45)

    assert _code(no_name) == "EXERCISE_NEEDS_NAME"
    assert _code(estimated) == "EXERCISE_NEEDS_KCAL"
    assert renamed.status_code == 200
    assert renamed.json()["label"] == "獨木舟"
    assert renamed.json()["kcal"] == "300.00"


async def test_other_becoming_a_fixed_activity_drops_the_name_and_keeps_the_kcal(
    client, db_session, clock
):
    user = await _user(db_session)
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(
        db_session,
        user=user,
        performed_at=NOON,
        activity=ActivityCode.OTHER,
        name="划船",
        kcal=300,
        kcal_source=KcalSource.MANUAL,
    )

    response = await _patch(client, user.id, entry.id, activity="running")

    assert response.status_code == 200
    body = response.json()
    assert body["name"] is None
    assert body["label"] == "跑步（約 10 km/h）"
    assert body["kcal"] == "300.00"
    assert body["kcal_source"] == "manual"
    assert (await _rows(db_session, user.id))[0]["name"] is None


async def test_back_to_estimated_without_a_weight_is_422_and_nothing_changes(
    client, db_session, clock
):
    user = await _user(db_session)
    entry = await create_exercise(
        db_session, user=user, performed_at=NOON, kcal=250, kcal_source=KcalSource.MANUAL
    )

    response = await _patch(client, user.id, entry.id, kcal=None, note="改了")

    assert response.status_code == 422
    assert _code(response) == "EXERCISE_NEEDS_WEIGHT"
    row = (await _rows(db_session, user.id))[0]
    assert (row["kcal"], row["kcal_source"], row["note"]) == (250, KcalSource.MANUAL, None)


@pytest.mark.parametrize("field", ["activity", "minutes", "performed_at"])
async def test_explicit_nulls_on_required_fields_are_422(client, db_session, clock, field):
    user = await _user(db_session)
    entry = await create_exercise(db_session, user=user, performed_at=NOON)

    response = await _patch(client, user.id, entry.id, **{field: None})

    assert response.status_code == 422
    assert _code(response) == "VALIDATION_ERROR"


async def test_patching_someone_elses_is_404_and_changes_nothing(client, db_session, clock):
    owner = await _user(db_session)
    stranger = await _user(db_session)
    entry = await create_exercise(db_session, user=owner, performed_at=NOON)
    entry_id = entry.id

    theirs = await _patch(client, stranger.id, entry_id, note="不是我的", kcal="1")
    mine = await client.get(item(entry_id), headers=auth(owner.id))

    assert theirs.status_code == 404
    assert _code(theirs) == "EXERCISE_NOT_FOUND"
    assert mine.status_code == 200
    row = (await _rows(db_session, owner.id))[0]
    assert (row["kcal"], row["note"]) == (343, None)


# ---------------------------------------------------------------------------
# DELETE
# ---------------------------------------------------------------------------


async def test_delete(client, db_session, clock):
    owner = await _user(db_session)
    stranger = await _user(db_session)
    entry = await create_exercise(db_session, user=owner, performed_at=NOON)
    other = await create_exercise(db_session, user=owner, performed_at=NOON)
    entry_id, other_id = entry.id, other.id

    # 先確認主人看得到另一筆：不然「別人刪不掉」可能只是路徑打錯。
    assert (await client.get(item(other_id), headers=auth(owner.id))).status_code == 200
    theirs = await client.delete(item(other_id), headers=auth(stranger.id))
    deleted = await client.delete(item(entry_id), headers=auth(owner.id))
    again = await client.delete(item(entry_id), headers=auth(owner.id))

    assert theirs.status_code == 404
    assert _code(theirs) == "EXERCISE_NOT_FOUND"
    assert deleted.status_code == 204
    assert again.status_code == 404
    assert [row["id"] for row in await _rows(db_session, owner.id)] == [other_id]


# ---------------------------------------------------------------------------
# 回應在 commit 之前組好（D21）
# ---------------------------------------------------------------------------


async def _statements_after_commit(db_session, db_connection, request) -> tuple[int, list[str]]:
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
        response = await request()
    finally:
        event.remove(db_connection.sync_connection, "before_cursor_execute", record)
        event.remove(db_session.sync_session, "after_commit", on_commit)
    assert committed  # 真的有 commit（不然「之後」是空的沒有意義）
    return response.status_code, [sql for after, sql in statements if after]


async def test_post_reads_nothing_back_after_the_commit(
    client, db_session, db_connection, clock
):
    user = await _user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")

    status, after = await _statements_after_commit(
        db_session, db_connection, lambda: _post(client, user_id)
    )

    assert status == 201
    assert after == []


async def test_patch_reads_nothing_back_after_the_commit(
    client, db_session, db_connection, clock
):
    user = await _user(db_session)
    user_id = user.id
    await create_weight(db_session, user=user, day=TODAY, weight_kg="70.00")
    entry = await create_exercise(db_session, user=user, performed_at=NOON)
    entry_id = entry.id

    status, after = await _statements_after_commit(
        db_session, db_connection, lambda: _patch(client, user_id, entry_id, minutes=60)
    )

    assert status == 200
    assert after == []
