import logging
from typing import Any

from fastapi import FastAPI, Request, status
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from starlette.exceptions import HTTPException as StarletteHTTPException

logger = logging.getLogger(__name__)


class AppError(Exception):
    def __init__(
        self,
        code: str,
        message: str,
        status_code: int,
        details: dict[str, Any] | None = None,
    ) -> None:
        self.code = code
        self.message = message
        self.status_code = status_code
        self.details = details or {}
        super().__init__(message)


class NotFoundError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_404_NOT_FOUND, details)


class ConflictError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_409_CONFLICT, details)


class UnauthorizedError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_401_UNAUTHORIZED, details)


class ForbiddenError(AppError):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_403_FORBIDDEN, details)


class UnprocessableEntityError(AppError):
    """用於「看得到但不能用」這種業務規則違反 —— 跟看不到（404）是不同的錯誤。

    例：份量存在、也看得到，但屬於另一個食物（計畫 3 Task 7 陷阱 2）。
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_422_UNPROCESSABLE_CONTENT, details)


class ServiceUnavailableError(AppError):
    """用於「應用程式本身沒問題，但它依賴的東西暫時不可用」。

    目前唯一的用途是 `GET /api/health/ready`（決定 3）：資料庫連不上時要回
    503，不是 500——503 才能讓呼叫端分辨「這是暫時性的依賴問題」，
    跟「應用程式本身出了未預期的錯誤」（那個情況本來就會走
    handle_unexpected_error，回 500）是不同的意思。
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_503_SERVICE_UNAVAILABLE, details)


class PayloadTooLargeError(AppError):
    """上傳內容超過大小上限（計畫 3 Task 14：照片上傳）。

    在讀進記憶體的過程中一邊累計一邊比對就中止，不是等整個 body 收完才算 ——
    見 `app/api/routes/meals.py` 的 `_read_upload_within_limit`。
    """

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(code, message, status.HTTP_413_CONTENT_TOO_LARGE, details)


def _envelope(code: str, message: str, details: dict[str, Any]) -> dict[str, Any]:
    return {"error": {"code": code, "message": message, "details": details}}


def _sanitize_validation_errors(errors: list[Any]) -> list[Any]:
    """移除 Pydantic 回傳的 input 欄位。

    Pydantic v2 預設會把使用者送進來的原始值一起放進錯誤裡，而 FastAPI 沒有提供
    關掉它的設定。密碼太短時，那個密碼就會出現在 422 的回應 body 裡 ——
    而 4xx 的 body 會進到反向代理的存取紀錄、瀏覽器開發者工具、
    以及前端的錯誤回報服務。
    loc / type / msg 都保留，診斷資訊已經足夠。
    """
    return [{key: value for key, value in error.items() if key != "input"} for error in errors]


def register_error_handlers(app: FastAPI) -> None:
    @app.exception_handler(AppError)
    async def handle_app_error(_: Request, exc: AppError) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=jsonable_encoder(_envelope(exc.code, exc.message, exc.details)),
        )

    @app.exception_handler(RequestValidationError)
    async def handle_validation_error(_: Request, exc: RequestValidationError) -> JSONResponse:
        return JSONResponse(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT,
            content=_envelope(
                "VALIDATION_ERROR",
                "輸入資料格式錯誤",
                {"errors": _sanitize_validation_errors(jsonable_encoder(exc.errors()))},
            ),
        )

    @app.exception_handler(StarletteHTTPException)
    async def handle_http_exception(_: Request, exc: StarletteHTTPException) -> JSONResponse:
        return JSONResponse(
            status_code=exc.status_code,
            content=_envelope("HTTP_ERROR", str(exc.detail), {}),
            headers=exc.headers,
        )

    @app.exception_handler(Exception)
    async def handle_unexpected_error(_: Request, exc: Exception) -> JSONResponse:
        logger.exception("未預期的錯誤")
        return JSONResponse(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            content=_envelope("INTERNAL_ERROR", "系統發生未預期的錯誤", {}),
        )
