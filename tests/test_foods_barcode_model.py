"""`foods.barcode` 的資料庫約束（掃條碼規格 D1、D4、§10.1）。

ORM 寫入一律走工廠；違規的寫法用 raw SQL 包在 begin_nested 裡（tests/test_body_model.py 的寫法），
接住之後 session 還能用。
"""

import pytest
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError

from app.models.user import UserRole
from tests.factories import create_food, create_user

CODE = "4710088432094"


async def _set_barcode(db_session, food_id: int, barcode: str | None) -> None:
    async with db_session.begin_nested():
        await db_session.execute(
            text("UPDATE foods SET barcode = :b WHERE id = :id"), {"b": barcode, "id": food_id}
        )


async def test_eight_and_thirteen_digits_are_stored(db_session):
    user = await create_user(db_session)
    eight = await create_food(db_session, created_by=user, owner=user, barcode="96385074")
    thirteen = await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    assert (eight.barcode, thirteen.barcode) == ("96385074", CODE)


@pytest.mark.parametrize("bad", ["12345", "036000291452", "47100884320941", "471008843209x", ""])
async def test_the_check_only_allows_eight_or_thirteen_digits(db_session, bad):
    """12 位（UPC-A）也不行：存的一定是標準形式（規格 §3.2）。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    food_id = food.id

    with pytest.raises(IntegrityError) as caught:
        await _set_barcode(db_session, food_id, bad)
    assert "ck_foods_barcode_digits" in str(caught.value.orig)


async def test_one_owner_cannot_use_a_barcode_twice(db_session):
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, barcode=CODE)
    second = await create_food(db_session, created_by=user, owner=user)
    second_id = second.id

    with pytest.raises(IntegrityError) as caught:
        await _set_barcode(db_session, second_id, CODE)
    assert "uq_foods_owner_id_barcode" in str(caught.value.orig)


async def test_two_public_foods_cannot_share_a_barcode(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    await create_food(db_session, created_by=admin, barcode=CODE)
    second = await create_food(db_session, created_by=admin)
    second_id = second.id

    with pytest.raises(IntegrityError) as caught:
        await _set_barcode(db_session, second_id, CODE)
    assert "uq_foods_global_barcode" in str(caught.value.orig)


async def test_private_and_public_and_other_owners_may_share(db_session):
    """規格 §4 的表：私人＋公開、兩個人各自的私人——都可以。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    first, second = await create_user(db_session), await create_user(db_session)
    await create_food(db_session, created_by=admin, barcode=CODE)
    await create_food(db_session, created_by=first, owner=first, barcode=CODE)
    await create_food(db_session, created_by=second, owner=second, barcode=CODE)

    count = await db_session.scalar(
        text("SELECT count(*) FROM foods WHERE barcode = :b"), {"b": CODE}
    )
    assert count == 3


async def test_many_foods_without_a_barcode(db_session):
    """NULL 在唯一索引裡互不相等：既有的食物全部是 NULL。"""
    user = await create_user(db_session)
    admin = await create_user(db_session, role=UserRole.ADMIN)
    for _ in range(2):
        await create_food(db_session, created_by=user, owner=user)
        await create_food(db_session, created_by=admin)
    count = await db_session.scalar(text("SELECT count(*) FROM foods WHERE barcode IS NULL"))
    assert count >= 4
