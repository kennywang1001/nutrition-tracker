"""`GET /api/planner/library-suggestions`（營養素配餐規格 §4、D12–D14）。

「今天」一律 monkeypatch（`app.api.routes.planner.today_in_timezone`），記下收到的時區；
使用者時區 America/New_York。解題器本身由 tests/test_planner_solver.py 守；這裡守接線：
候選從哪裡來、預設份量怎麼挑、剩下的怎麼算、五種 status、回應的形狀。
"""

from datetime import UTC, date, datetime, timedelta
from decimal import Decimal

import pytest
from sqlalchemy import event

from app.models.food import FoodRevision
from app.planner_data import load_candidates
from app.security.tokens import create_access_token
from tests.factories import (
    create_exercise,
    create_food,
    create_meal,
    create_portion,
    create_target,
    create_user,
)

URL = "/api/planner/library-suggestions"
TODAY = date(2026, 10, 14)
NOON = datetime(2026, 10, 14, 16, 0, tzinfo=UTC)  # 紐約 10/14 12:00
LAST_WEEK = datetime(2026, 10, 7, 16, 0, tzinfo=UTC)


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


@pytest.fixture
def today(monkeypatch):
    seen: list[str] = []

    def fake(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.planner.today_in_timezone", fake)
    return seen


async def _new_yorker(db_session):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    return user


async def _eaten(db_session, user, food, *, at=LAST_WEEK, grams="100"):
    """記一餐讓這個食物變成「吃過」（上週：不佔今天的額度）。"""
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    await create_meal(db_session, user=user, eaten_at=at, items=[(revision, Decimal(grams))])


async def _chicken_and_rice(db_session, user):
    """規格 §4.5 的 e2e 那一組：雞胸（沒有份量）、白飯（預設 1 碗 200 g）。"""
    chicken = await create_food(
        db_session, created_by=user, owner=user, name="雞胸",
        kcal=110, protein_g=23, fat_g=Decimal("1.5"), carb_g=0,
    )  # fmt: skip
    rice = await create_food(
        db_session, created_by=user, owner=user, name="白飯",
        kcal=180, protein_g=3, fat_g=Decimal("0.5"), carb_g=40,
    )  # fmt: skip
    portion = await create_portion(
        db_session, food=rice, owner=user, label="1 碗", grams=200, is_default=True
    )
    await _eaten(db_session, user, chicken)
    await _eaten(db_session, user, chicken)  # 雞胸吃兩次：常吃的排第一（候選順序決定平手）
    await _eaten(db_session, user, rice)
    return chicken, rice, portion


def _food_ids(body) -> set[int]:
    return {item["food"]["id"] for combo in body["combos"] for item in combo["items"]}


async def test_the_e2e_pair_end_to_end(client, db_session, today):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=700, protein_g=50)
    chicken, _rice, portion = await _chicken_and_rice(db_session, user)
    chicken_id, portion_id = chicken.id, portion.id

    response = await client.get(URL, headers=auth(user))

    assert response.status_code == 200
    assert today == ["America/New_York"]
    body = response.json()
    assert body["date"] == "2026-10-14"
    assert body["status"] == "ok"
    assert body["remaining"] == {
        "kcal": "700.00", "protein_g": "50.00", "fat_g": None, "carb_g": None,
    }  # fmt: skip
    first = body["combos"][0]
    chicken_item, rice_item = first["items"]
    assert chicken_item["food"]["id"] == chicken_id
    assert chicken_item["food"]["nutrition"]["kcal"] == "110.00"
    assert chicken_item["portion"] is None
    assert (chicken_item["quantity"], chicken_item["quantity_g"]) == ("175", "175.00")
    assert chicken_item["nutrition"] == {
        "kcal": "192.50", "protein_g": "40.25", "fat_g": "2.63", "carb_g": "0.00",
    }  # fmt: skip
    assert rice_item["portion"] == {"id": portion_id, "label": "1 碗", "grams": "200.00"}
    assert (rice_item["quantity"], rice_item["quantity_g"]) == ("1.5", "300.00")
    assert first["total"] == {
        "kcal": "732.50", "protein_g": "49.25", "fat_g": "4.13", "carb_g": "120.00",
    }  # fmt: skip
    # 732.50 / 700 = 1.0464… → 1.05；49.25 / 50 = 0.985 → 0.99（HALF_UP）；不考慮的是 null。
    assert first["fill"] == {"kcal": "1.05", "protein_g": "0.99", "fat_g": None, "carb_g": None}
    assert len(body["combos"]) == 3


async def test_what_was_eaten_today_and_exercise_change_the_remaining(client, db_session, today):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000, protein_g=90)
    chicken = await create_food(
        db_session, created_by=user, owner=user, name="雞胸",
        kcal=110, protein_g=23, fat_g=Decimal("1.5"), carb_g=0,
    )  # fmt: skip
    await _eaten(db_session, user, chicken, at=NOON, grams="500")  # 550 kcal、115 g
    await create_exercise(db_session, user=user, performed_at=NOON, kcal=343)

    with_exercise = (await client.get(URL, headers=auth(user))).json()

    assert with_exercise["remaining"] == {
        "kcal": "1793.00", "protein_g": "0.00", "fat_g": None, "carb_g": None,
    }  # fmt: skip
    assert with_exercise["status"] == "ok"
    # 蛋白質剩 0：仍然考慮（解題器用 10 g 的分母），但「佔剩下的幾成」沒有意義 → null。
    assert all(combo["fill"]["protein_g"] is None for combo in with_exercise["combos"])
    assert all(combo["fill"]["kcal"] is not None for combo in with_exercise["combos"])

    user.exercise_adds_to_budget = False
    await db_session.commit()
    without = (await client.get(URL, headers=auth(user))).json()

    assert without["remaining"]["kcal"] == "1450.00"


@pytest.mark.parametrize("target", [None, "protein_only"])
async def test_no_kcal_target_is_no_target(client, db_session, today, target):
    user = await _new_yorker(db_session)
    if target == "protein_only":
        await create_target(db_session, user=user, kcal=None, protein_g=90)
    food = await create_food(db_session, created_by=user, owner=user)
    await _eaten(db_session, user, food)

    response = await client.get(URL, headers=auth(user))

    assert response.status_code == 200
    body = response.json()
    assert (body["status"], body["remaining"], body["combos"]) == ("no_target", None, [])


async def test_full_below_fifty_kcal(client, db_session, today):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=700)
    food = await create_food(db_session, created_by=user, owner=user, kcal=655)
    await _eaten(db_session, user, food, at=NOON)

    body = (await client.get(URL, headers=auth(user))).json()

    assert body["status"] == "full"
    assert body["remaining"]["kcal"] == "45.00"
    assert body["combos"] == []


async def test_no_candidates_for_a_new_account(client, db_session, today):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000)

    body = (await client.get(URL, headers=auth(user))).json()

    assert body["status"] == "no_candidates"
    assert body["remaining"]["kcal"] == "2000.00"
    assert body["combos"] == []


async def test_no_fit_when_every_food_is_too_big(client, db_session, today):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=100)
    # 最小的量 25 g＝150 kcal，超過 100 × 1.05。
    food = await create_food(db_session, created_by=user, owner=user, kcal=600)
    await _eaten(db_session, user, food)

    body = (await client.get(URL, headers=auth(user))).json()

    assert body["status"] == "no_fit"
    assert body["remaining"]["kcal"] == "100.00"
    assert body["combos"] == []


async def test_candidates_are_only_my_recorded_foods_with_an_active_revision(
    client, db_session, today
):
    me = await _new_yorker(db_session)
    other = await create_user(db_session)
    await create_target(db_session, user=me, kcal=2000)
    mine = await create_food(db_session, created_by=me, owner=me, name="我的")
    others_private = await create_food(db_session, created_by=other, owner=other, name="別人的")
    # 全域、只有別人吃過：看得到（可見性放行），所以只有「只看自己的餐」擋得住它。
    global_others_ate = await create_food(db_session, created_by=other, name="別人吃的全域")
    never_eaten = await create_food(db_session, created_by=other, name="沒人吃過的全域")
    retired = await create_food(db_session, created_by=me, owner=me, name="沒有生效版本")
    await _eaten(db_session, me, mine)
    await _eaten(db_session, me, retired)
    await _eaten(db_session, other, others_private)
    await _eaten(db_session, other, global_others_ate)
    ids = {
        "mine": mine.id,
        "others_private": others_private.id,
        "global_others_ate": global_others_ate.id,
        "never_eaten": never_eaten.id,
        "retired": retired.id,
    }
    retired.current_revision_id = None
    await db_session.commit()

    body = (await client.get(URL, headers=auth(me))).json()

    assert body["status"] == "ok"
    seen = _food_ids(body)
    assert ids["mine"] in seen  # 看得到的那一個真的出現了
    assert seen == {ids["mine"]}


async def test_the_default_portion_prefers_my_own(db_session):
    """直接看 `load_candidates`：四種份量的情形各一個食物
    （都進得了候選，不受解題器挑哪幾組影響）。"""
    me = await create_user(db_session)
    other = await create_user(db_session)
    both = await create_food(db_session, created_by=other, name="兩種預設")
    # 公開的先建（id 比較小）：只靠 id 排序的話會挑到它。
    await create_portion(db_session, food=both, label="公開的一份", is_default=True)
    my_portion = await create_portion(
        db_session, food=both, owner=me, label="我的一份", is_default=True
    )
    public_only = await create_food(db_session, created_by=other, name="只有公開預設")
    public_portion = await create_portion(
        db_session, food=public_only, label="公開的一份", is_default=True
    )
    not_default = await create_food(db_session, created_by=other, name="不是預設")
    await create_portion(db_session, food=not_default, owner=me, label="一盤", is_default=False)
    others_default = await create_food(db_session, created_by=other, name="別人的預設")
    await create_portion(
        db_session, food=others_default, owner=other, label="別人的一份", is_default=True
    )
    for food in (both, public_only, not_default, others_default):
        await _eaten(db_session, me, food)
    expected = {
        both.id: my_portion.id,
        public_only.id: public_portion.id,
        not_default.id: None,
        others_default.id: None,
    }

    candidates = await load_candidates(db_session, me)

    got = {c.food.id: (c.portion.id if c.portion is not None else None) for c in candidates}
    assert got == expected
    # 交給解題器的是那個份量的 g（create_portion 預設 200 g）；沒有預設份量的是 None。
    portion_grams = {c.food.id: c.candidate().portion_grams for c in candidates}
    assert portion_grams[both.id] == Decimal("200.00")
    assert portion_grams[not_default.id] is None


async def test_frequent_foods_come_first_then_recent_ones_and_the_list_is_capped_at_thirty(
    db_session,
):
    """32 個食物各吃一次（時間遞增），第 0 個多吃兩次、其中一次是最後吃的。
    常吃的前 20 個在前（次數多到少、同次數用 id），最近吃的補滿 30（去重）——
    所以第 20、21 個（只吃過一次、不夠新）不在裡面。"""
    me = await create_user(db_session)
    foods = [
        await create_food(db_session, created_by=me, owner=me, name=f"食物{i}") for i in range(32)
    ]
    for i, food in enumerate(foods):
        await _eaten(db_session, me, food, at=LAST_WEEK + timedelta(minutes=i))
    await _eaten(db_session, me, foods[0], at=LAST_WEEK - timedelta(days=1))
    await _eaten(db_session, me, foods[0], at=LAST_WEEK + timedelta(hours=5))  # 最近吃的也是它
    ids = [food.id for food in foods]

    candidates = await load_candidates(db_session, me)

    got = [c.food.id for c in candidates]
    assert len(got) == 30
    assert len(set(got)) == 30
    assert got[:20] == ids[:20]
    assert got[20:] == ids[31:21:-1]  # 最近吃的：第 31、30……22 個


async def test_requires_login(client):
    response = await client.get(URL)
    assert response.status_code == 401


@pytest.mark.parametrize("count", [3, 5])
async def test_query_count_is_fixed(client, db_session, today, count):
    user = await _new_yorker(db_session)
    await create_target(db_session, user=user, kcal=2000, protein_g=90)
    for i in range(count):
        food = await create_food(db_session, created_by=user, owner=user, name=f"食物{i}")
        await create_portion(db_session, food=food, owner=user, is_default=True)
        await _eaten(db_session, user, food)

    sync_engine = db_session.bind.sync_engine
    statements = 0

    def _count(*_args, **_kwargs):
        nonlocal statements
        statements += 1

    event.listen(sync_engine, "before_cursor_execute", _count)
    try:
        response = await client.get(URL, headers=auth(user))
    finally:
        event.remove(sync_engine, "before_cursor_execute", _count)

    assert response.status_code == 200
    assert response.json()["status"] == "ok"
    # 額度 4（食物、補劑、目標、運動）＋常吃 1＋最近 1＋份量 1，跟候選幾個無關。
    assert statements == 7


async def test_planner_reads_nothing_of_another_user(client, db_session, today):
    me = await _new_yorker(db_session)
    other = await _new_yorker(db_session)
    await create_target(db_session, user=me, kcal=2000)
    await create_target(db_session, user=other, kcal=3000, protein_g=200)
    food = await create_food(db_session, created_by=other, owner=other, kcal=500)
    await _eaten(db_session, other, food, at=NOON)
    await create_exercise(db_session, user=other, performed_at=NOON, kcal=343)

    body = (await client.get(URL, headers=auth(me))).json()

    assert body["remaining"] == {
        "kcal": "2000.00", "protein_g": None, "fat_g": None, "carb_g": None,
    }  # fmt: skip
    assert body["status"] == "no_candidates"
