from fastapi import FastAPI
from httpx import ASGITransport, AsyncClient
from pydantic import BaseModel

from app.errors import ConflictError, NotFoundError, register_error_handlers


class Payload(BaseModel):
    count: int


def build_app() -> FastAPI:
    test_app = FastAPI()
    register_error_handlers(test_app)

    @test_app.get("/missing")
    async def missing() -> None:
        raise NotFoundError("FOOD_NOT_FOUND", "找不到該食物")

    @test_app.post("/conflict")
    async def conflict(payload: Payload) -> None:
        raise ConflictError("EMAIL_TAKEN", "這個 email 已經註冊過了")

    return test_app


async def request(method: str, path: str, **kwargs):
    transport = ASGITransport(app=build_app())
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
