"""重設密碼連結的資料庫保證（規格 §4.1）與密碼長度常數（規格決定 20）。"""

import ast
import inspect
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

import app.cli
import app.security.password
from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.password_resets import RESET_LIFETIME, hash_reset_token, new_reset_token
from tests.factories import create_password_reset, create_user


def test_the_minimum_password_length_has_one_definition():
    """cli 仍然叫得到這個名字（既有的引用不變），但它是從 security.password import 來的。

    不能只斷言 `app.cli.MIN_PASSWORD_LENGTH is app.security.password.MIN_PASSWORD_LENGTH`：
    CPython 快取 -5～256 的小整數，cli 自己再寫一行 `MIN_PASSWORD_LENGTH = 8` 也是同一個
    物件——實測那個突變下 `is` 照樣成立。所以直接看 cli 的原始碼：沒有自己賦值，而是 import。"""
    assert app.cli.MIN_PASSWORD_LENGTH == app.security.password.MIN_PASSWORD_LENGTH == 8

    tree = ast.parse(inspect.getsource(app.cli))
    assigned = {
        target.id
        for node in ast.walk(tree)
        if isinstance(node, ast.Assign | ast.AnnAssign)
        for target in (node.targets if isinstance(node, ast.Assign) else [node.target])
        if isinstance(target, ast.Name)
    }
    imported = {
        alias.asname or alias.name
        for node in ast.walk(tree)
        if isinstance(node, ast.ImportFrom) and node.module == "app.security.password"
        for alias in node.names
    }
    assert "MIN_PASSWORD_LENGTH" not in assigned
    assert "MIN_PASSWORD_LENGTH" in imported


def test_a_reset_token_is_random_and_only_its_hash_is_kept():
    first, second = new_reset_token(), new_reset_token()
    assert first != second
    assert len(first) >= 43  # token_urlsafe(32)
    assert hash_reset_token(first) != first
    assert len(hash_reset_token(first)) == 64  # SHA-256 hex


def test_a_link_lives_for_24_hours():
    assert timedelta(hours=24) == RESET_LIFETIME


async def test_the_database_refuses_two_live_links_for_one_user(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    await create_password_reset(db_session, user=user, created_by=admin)

    with pytest.raises(IntegrityError, match="uq_password_reset_tokens_one_live_per_user"):
        await create_password_reset(db_session, user=user, created_by=admin)
    await db_session.rollback()


async def test_used_and_revoked_links_do_not_count_as_live(db_session):
    """部分唯一索引的述詞要兩個條件都在：只寫 `used_at IS NULL` 的話，撤銷過的那條
    會擋住新的（產生新連結的流程就是「先撤銷、再插入」）。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    await create_password_reset(db_session, user=user, created_by=admin, used=True)
    await create_password_reset(db_session, user=user, created_by=admin, revoked=True)
    live, _ = await create_password_reset(db_session, user=user, created_by=admin)
    assert live.id is not None


async def test_the_database_refuses_a_link_both_used_and_revoked(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    now = datetime.now(UTC)
    db_session.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=hash_reset_token(new_reset_token()),
            created_by=admin.id,
            created_at=now,
            expires_at=now + RESET_LIFETIME,
            used_at=now,
            revoked_at=now,
        )
    )
    with pytest.raises(IntegrityError, match="not_both_used_and_revoked"):
        await db_session.commit()
    await db_session.rollback()


async def test_the_database_refuses_a_link_that_expires_before_it_was_created(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    now = datetime.now(UTC)
    with pytest.raises(IntegrityError, match="expires_after_created"):
        await create_password_reset(
            db_session, user=user, created_by=admin, created_at=now, expires_at=now
        )
    await db_session.rollback()
