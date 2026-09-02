from sqlalchemy import select

from app.models.user import User


async def test_db_session_works(db_session):
    user = User(email="infra@example.com", password_hash="x", display_name="Infra")
    db_session.add(user)
    await db_session.commit()

    found = await db_session.scalar(select(User).where(User.email == "infra@example.com"))
    assert found is not None
    assert found.display_name == "Infra"


async def test_each_test_starts_with_a_clean_database(db_session):
    """上一個測試 commit 了一個使用者，這個測試不該看到它。"""
    found = await db_session.scalar(select(User).where(User.email == "infra@example.com"))
    assert found is None


async def test_client_can_reach_the_api(client):
    response = await client.get("/api/health")
    assert response.status_code == 200
