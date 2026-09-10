from typing import Annotated

from fastapi import APIRouter, Depends
from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.db import get_db
from app.errors import ServiceUnavailableError

router = APIRouter(tags=["health"])


@router.get("/health")
async def health() -> dict[str, str]:
    """liveness：只證明「這個 process 還活著、能回應 HTTP」。

    決定 3：刻意不碰資料庫。Docker healthcheck 打的是這一個端點——
    如果這裡查資料庫，資料庫短暫抖動就會讓容器被判定不健康而重啟，
    但重啟並不能解決資料庫的問題，只會在資料庫恢復期間把 API 也弄掉。
    要看資料庫通不通，打 /api/health/ready。
    """
    return {"status": "ok"}


@router.get("/health/ready")
async def health_ready(db: Annotated[AsyncSession, Depends(get_db)]) -> dict[str, str]:
    """readiness：資料庫連不上時回 503（不是 500），給人／腳本判斷
    「現在能不能服務」用。決定 3：這個端點不接到 Docker 的自動重啟上。

    try 只包住真的會拋例外的那一行（SELECT 1）：資料庫連線失敗或查詢失敗
    都是從 db.execute 拋出來的，包更大範圍只會讓「這個 500 到底是資料庫
    的問題還是別的東西壞了」變得看不出來。
    """
    try:
        await db.execute(text("SELECT 1"))
    except SQLAlchemyError as exc:
        raise ServiceUnavailableError(
            "DATABASE_UNAVAILABLE", "資料庫目前無法連線"
        ) from exc
    return {"status": "ok"}
