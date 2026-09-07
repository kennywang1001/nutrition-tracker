import pytest

from app.api.deps import get_owned_or_404
from app.errors import NotFoundError
from app.models.user import User
from tests.factories import create_user


async def test_returns_the_resource_when_the_owner_matches(db_session):
    user = await create_user(db_session)

    found = await get_owned_or_404(db_session, User, user.id, owner_id=user.id, owner_field="id")

    assert found.id == user.id


async def test_raises_not_found_when_the_owner_differs(db_session):
    """別人的資源要回 404，不是 403 —— 403 等於承認這個 ID 存在。"""
    owner = await create_user(db_session)
    other = await create_user(db_session)

    with pytest.raises(NotFoundError):
        await get_owned_or_404(db_session, User, owner.id, owner_id=other.id, owner_field="id")


async def test_raises_not_found_when_the_resource_does_not_exist(db_session):
    user = await create_user(db_session)

    with pytest.raises(NotFoundError):
        await get_owned_or_404(db_session, User, 999_999, owner_id=user.id, owner_field="id")


async def test_the_two_failure_modes_are_indistinguishable(db_session):
    """「不存在」跟「不屬於你」必須拋出完全一樣的錯誤。"""
    owner = await create_user(db_session)
    other = await create_user(db_session)

    with pytest.raises(NotFoundError) as not_yours:
        await get_owned_or_404(db_session, User, owner.id, owner_id=other.id, owner_field="id")
    with pytest.raises(NotFoundError) as missing:
        await get_owned_or_404(db_session, User, 999_999, owner_id=other.id, owner_field="id")

    assert not_yours.value.code == missing.value.code
    assert not_yours.value.message == missing.value.message
