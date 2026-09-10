# 這裡刻意不用 conftest.py 的 client fixture，自己組一個 ASGITransport/AsyncClient。
# 這是整個測試套件裡唯一一個不需要任何基礎設施（不連資料庫、不跑 migration）就能跑的測試，
# 用來證明「FastAPI 本身是活的」——就算資料庫掛了，這個測試也該過。
# 之後不要為了消除重複把它改成用 client fixture，那會讓它悄悄變成需要資料庫才能跑。
from httpx import ASGITransport, AsyncClient
from sqlalchemy import event
from sqlalchemy.exc import OperationalError

from app.main import app


async def test_health_returns_ok():
    transport = ASGITransport(app=app)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


# ---------------------------------------------------------------------------
# 決定 3：liveness（/api/health）與 readiness（/api/health/ready）分開。
# 下面這些測試才需要走資料庫，所以改用 conftest.py 的 client / db_session fixture。
# ---------------------------------------------------------------------------


async def test_health_does_not_touch_database(client, db_session, monkeypatch):
    """本 task 最重要的測試：守住決定 3。

    把 db_session.execute 換成一個會爆炸的假函式——如果哪天有人「順手」把
    資料庫檢查加進 /api/health（liveness），這個測試就會從 200 變成 500，
    當場抓到。目前的實作完全不碰 db，所以就算資料庫的 execute 整個報廢，
    /api/health 也應該還是 200。
    """

    async def _explode(*args, **kwargs):
        raise RuntimeError("資料庫壞掉了，但 /api/health 不應該注意到這件事")

    monkeypatch.setattr(db_session, "execute", _explode)

    response = await client.get("/api/health")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_health_ready_returns_ok_when_database_reachable(client, db_session):
    response = await client.get("/api/health/ready")

    assert response.status_code == 200
    assert response.json() == {"status": "ok"}


async def test_health_ready_returns_503_when_database_unreachable(client, db_session, monkeypatch):
    """資料庫不通要回 503，不是 500——503 才能讓呼叫端（或人）知道
    「這是暫時性的、資料庫的問題」，而不是應用程式本身壞了。

    用 OperationalError 而不是隨便一個例外型別：這是真的連不上資料庫時，
    SQLAlchemy 實際會拋出來的型別（DBAPI 連線層的錯誤，例如
    ConnectionRefusedError，會被包成 OperationalError）。健康檢查的實作
    只接 SQLAlchemyError，接住的範圍要跟「資料庫真的會怎麼壞」對得上，
    不是隨便接一個 Exception 就了事。
    """

    async def _explode(*args, **kwargs):
        raise OperationalError("SELECT 1", {}, ConnectionRefusedError("連不上資料庫"))

    monkeypatch.setattr(db_session, "execute", _explode)

    response = await client.get("/api/health/ready")

    assert response.status_code == 503
    body = response.json()
    assert body["error"]["code"] == "DATABASE_UNAVAILABLE"


async def test_health_ready_actually_executes_a_query(client, db_session):
    """確認 /api/health/ready 真的有下一次查詢（SELECT 1），
    不是隨便回個 200 就算了事——用查詢次數確認，不是用碼審讀程式碼用猜的。

    這裡比對的是「SELECT 1 出現幾次」，不是「總共送了幾條 SQL」：
    測試用的 db_session（見 tests/conftest.py）是用
    `join_transaction_mode="create_savepoint"` 疊在既有交易上做隔離，
    第一次查詢之前 SQLAlchemy 會先自己送一條 `SAVEPOINT ...`——這是測試
    基礎設施的產物，production 的 SessionLocal 沒有這個設定、不會有這條
    savepoint。比對總數會把這個測試耦合到測試夾具的實作細節上，
    比對特定敘述才是真的在確認「這支端點下了 SELECT 1」。
    """
    sync_engine = db_session.bind.sync_engine
    statements: list[str] = []

    def _record_statement(_conn, _cursor, statement, *_args, **_kwargs):
        statements.append(statement)

    event.listen(sync_engine, "before_cursor_execute", _record_statement)
    try:
        response = await client.get("/api/health/ready")
    finally:
        event.remove(sync_engine, "before_cursor_execute", _record_statement)

    assert response.status_code == 200
    assert statements.count("SELECT 1") == 1


async def test_health_endpoints_do_not_require_auth(client, db_session):
    """兩個 health 端點都不用帶 Authorization header。"""
    liveness = await client.get("/api/health")
    readiness = await client.get("/api/health/ready")

    assert liveness.status_code == 200
    assert readiness.status_code == 200
