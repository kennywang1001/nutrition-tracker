from datetime import date
from decimal import Decimal

from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel, Field

from app.errors import ConflictError, NotFoundError, register_error_handlers


class Payload(BaseModel):
    count: int


class RegisterPayload(BaseModel):
    password: str = Field(min_length=8)


def build_app() -> FastAPI:
    test_app = FastAPI()
    register_error_handlers(test_app)

    @test_app.get("/missing")
    async def missing() -> None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")

    @test_app.post("/conflict")
    async def conflict(payload: Payload) -> None:
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了")

    @test_app.post("/conflict-with-details")
    async def conflict_with_details() -> None:
        raise ConflictError(
            "PERIOD_OVERLAP",
            "目標期間重疊",
            details={
                "conflicting_period": {"start": date(2026, 1, 1), "end": date(2026, 1, 31)},
                "amount": Decimal("12.50"),
            },
        )

    @test_app.post("/register")
    async def register(payload: RegisterPayload) -> None:
        return None

    @test_app.get("/crash")
    async def crash() -> None:
        raise RuntimeError("boom")

    return test_app


async def request(method: str, path: str, **kwargs):
    transport = ASGITransport(app=build_app())
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


async def request_allowing_server_errors(method: str, path: str, **kwargs):
    """給會炸 500 的路徑用：raise_app_exceptions=False 才會拿到真正的 HTTP 回應，
    而不是讓例外直接從 client 呼叫傳出來（那是 ASGITransport 預設的行為，
    模擬的是測試框架，不是真正掛在 uvicorn 後面的 client）。"""
    transport = ASGITransport(app=build_app(), raise_app_exceptions=False)
    async with AsyncClient(transport=transport, base_url="http://test") as client:
        return await client.request(method, path, **kwargs)


async def test_app_error_uses_the_standard_envelope():
    response = await request("GET", "/missing")

    assert response.status_code == 404
    assert response.json() == {
        "error": {"code": "FOOD_NOT_FOUND", "message": "找不到該食物", "details": {}}
    }


async def test_conflict_error_returns_409():
    response = await request("POST", "/conflict", json={"count": 1})

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "EMAIL_TAKEN"


async def test_validation_error_uses_the_same_envelope():
    response = await request("POST", "/conflict", json={"count": "not-a-number"})

    assert response.status_code == 422
    body = response.json()
    assert body["error"]["code"] == "VALIDATION_ERROR"
    assert "errors" in body["error"]["details"]


async def test_non_primitive_details_survive_as_409():
    response = await request("POST", "/conflict-with-details")

    assert response.status_code == 409
    body = response.json()
    assert body["error"]["code"] == "PERIOD_OVERLAP"
    assert body["error"]["details"]["conflicting_period"] == {
        "start": "2026-01-01",
        "end": "2026-01-31",
    }
    assert body["error"]["details"]["amount"] == 12.5


async def test_validation_error_does_not_echo_the_submitted_password():
    # 密碼刻意選一個不會跟 Pydantic 錯誤訊息本身撞字的值（例如 "short" 剛好是
    # "string_too_short" 這個 type 的子字串，會讓這個斷言在沒有真的洩漏時也失敗）。
    response = await request("POST", "/register", json={"password": "zqxjv"})

    assert response.status_code == 422
    assert "zqxjv" not in response.text


async def test_unknown_path_returns_the_standard_envelope():
    response = await request("GET", "/does-not-exist")

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "HTTP_ERROR"


async def test_unexpected_exception_returns_500_with_the_envelope():
    response = await request_allowing_server_errors("GET", "/crash")

    assert response.status_code == 500
    assert response.json() == {
        "error": {"code": "INTERNAL_ERROR", "message": "系統發生未預期的錯誤", "details": {}}
    }
