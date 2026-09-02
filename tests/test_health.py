# 這裡刻意不用 conftest.py 的 client fixture，自己組一個 ASGITransport/AsyncClient。
# 這是整個測試套件裡唯一一個不需要任何基礎設施（不連資料庫、不跑 migration）就能跑的測試，
# 用來證明「FastAPI 本身是活的」——就算資料庫掛了，這個測試也該過。
# 之後不要為了消除重複把它改成用 client fixture，那會讓它悄悄變成需要資料庫才能跑。
from httpx import ASGITransport, AsyncClient

from app.main import app


async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}
