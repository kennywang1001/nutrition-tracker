"""匯出自己的資料成 CSV（報表月份與匯出規格 §3）。

三個端點共用一個限速額度、同一種回應：`text/csv; charset=utf-8`、開頭有 BOM、
`Content-Disposition: attachment`，檔名帶使用者時區的今天。內容在 `app/export.py`，
CSV 的寫法在 `app/csv_export.py`。

**讀的人不讀了，伺服器就卡在「送」上**（uvicorn 的寫入緩衝滿了就等）——而且可以一直卡著。
這個模組為此做了兩件事（規格 §8 第 10 點）：

1. **送的時候不握著資料庫連線**（`_csv_response`、`_release_between_chunks`）：每一次交給
   Starlette 去送之前先把交易結束掉，連線回到池子；下一塊要查的時候再借。
2. **一個人同時只能有一個匯出在跑**（`export_slot`）：卡住的串流不佔連線了，但還佔著
   一個 task 與一塊緩衝——不讓同一個人疊很多個。
"""

from collections.abc import AsyncIterator
from typing import Any

import anyio
from fastapi import APIRouter, Depends
from fastapi.responses import StreamingResponse
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.days import today_in_timezone
from app.db import get_db
from app.export import expense_csv, meal_csv, supplement_csv
from app.models.user import User
from app.ratelimit import export_in_flight, export_rate_limiter


async def export_slot(user: User = Depends(get_current_user)) -> AsyncIterator[None]:
    """限速，然後佔住「這個人正在匯出」的位子，**回應整個結束之後**才放掉。

    **為什麼是 `yield` 的依賴，不是寫在串流的 generator 裡的 `try/finally`。**
    位子要在碰到 handler 之前就佔好（被擋的人要拿到 429，而 generator 開始跑的時候
    200 的標頭已經送出去了），所以「佔」不可能在 generator 裡；而「放」寫在 generator 的
    `finally` 裡會漏掉兩條路：

    - **標頭就送不出去**（用戶端已經走了）：generator 建了、從來沒被迭代，裡面的
      `finally` 永遠不會跑——那個人從此不能匯出，直到容器重啟。
    - **卡在送的時候斷線**：Starlette 取消的是卡在 `send` 的那個 task；generator 停在
      `yield` 上，沒有人去關它，`finally` 要等垃圾回收。

    FastAPI（≥ 0.118）在回應送完、失敗、或被取消之後一定會把 `yield` 的依賴收尾——跟
    `get_db` 的 session 靠的是同一件事（`_csv_response` 的說明），`tests/test_export.py`
    把這幾條路都走過。`StreamingResponse(background=…)` 不行：它只在送**成功**之後才跑。

    **先算次數、再看有沒有在跑**：被「已經有一個在跑」擋下來的也算進每分鐘的額度，
    對著進行中的匯出狂打的迴圈一樣會被限速擋下來。兩個都在碰匯出的查詢之前；鍵都是
    這個使用者（`str(user.id)`），三個端點共用。

    **「回應結束之後才放掉」管不到不結束的回應**：不讀、也不斷線的用戶端讓這個依賴一直
    停在 `yield`。位子因此有時間上限（`app/ratelimit.py` 的 `EXPORT_MAX_HOLD_SECONDS`）——
    超過了，同一個人的下一次匯出直接接手；卡住的那一個還掛著，等它自己的連線結束。
    """
    key = str(user.id)
    export_rate_limiter.hit(key)
    # 這一行丟 429 的話什麼都沒有佔到——所以在 try 外面：被擋的請求不能去放別人的位子。
    hold = export_in_flight.acquire(key)
    try:
        yield
    finally:
        # 帶著自己佔的那一次的憑證去放：這一個如果卡了超過 `EXPORT_MAX_HOLD_SECONDS`、位子
        # 已經被同一個人的下一次匯出接手，這裡不能把**那一個**的位子放掉。
        export_in_flight.release(key, hold)


# 掛在 router 上：之後加第四個匯出端點，不會忘了限速與「一次一個」。
router = APIRouter(prefix="/export", tags=["export"], dependencies=[Depends(export_slot)])

# OpenAPI 上寫明回的是 CSV（預設會寫成 application/json）。
_CSV_RESPONSES: dict[int | str, dict[str, Any]] = {
    200: {
        "description": "CSV（UTF-8，開頭有 BOM）",
        "content": {"text/csv": {"schema": {"type": "string"}}},
    }
}


async def _release_between_chunks(
    db: AsyncSession, body: AsyncIterator[bytes]
) -> AsyncIterator[bytes]:
    """`body` 的每一塊交出去之前，先把這一塊的交易結束掉。

    `yield` 之後 Starlette 才去送；送多久由用戶端決定。交易結束＝連線回到池子，下一塊的
    查詢會自己再借一條（keyset 分塊本來就不靠同一個交易、同一條連線——`app/export.py`）。
    這時候 `chunk` 已經是位元組，資料庫的東西一樣都沒帶出來。

    **`commit()`，不是 `rollback()` 或 `close()`**——只讀，對資料庫三個都一樣（沒有東西
    可以提交）。差別在 session 裡的物件：`rollback()` 會讓它們全部過期（之後一碰屬性就是
    一次沒有 await 的查詢，`MissingGreenlet`），`close()` 會把它們全部踢出 session；
    `commit()` 在這個專案的 `expire_on_commit=False` 底下兩件事都不做。正式環境現在沒有人
    在串流開始之後還碰那些物件（`user` 的欄位在這之前就讀成純值了），但測試共用一個
    session、手上握著自己建的物件，之後加的程式碼也不該因為這裡而踩到。

    最後一塊之後還有一次查詢（查不到東西、generator 才結束），結尾那個空的 body 一樣是
    「送」——所以 generator 結束的那一次也要結束交易，然後才 return。

    **「借連線 → 查 → 結束交易」這一段擋住取消（shield），做完才輪到它。** 用戶端斷線時
    Starlette 用 anyio 的 cancel scope 取消串流；每一塊都重新借連線之後，取消可能落在這一段
    的任何一步中間。被打斷的資料庫操作，SQLAlchemy 只能把那條連線作廢，而在被取消的 scope
    裡連關都關不掉（log 一個 `Exception terminating connection` 的 traceback）；落在「借」
    （pre-ping）的中間更糟：那條連線一直記在「借出去了」，要等垃圾回收才回到池子——修掉
    「卡住的下載佔著連線」卻換來「斷線的下載漏掉連線」。擋住的時間最多是一塊的查詢
    （`EXPORT_CHUNK_ROWS` 列）。擋不住直接對 task 的 `cancel()`（伺服器關機）——那跟
    以前一樣。

    **擋完要自己問一次「被取消了嗎」（`checkpoint_if_cancelled`）。** `body` 在兩個 `yield`
    之間做的事全部在 shield 裡面，外面只剩 `yield`——而斷線之後 uvicorn 的 `send` 馬上就
    回來、不等任何東西，取消永遠沒有地方可以送達：串流會把剩下的整段歷史讀完、對著一條
    已經關掉的連線送完（位子也一直佔著）。沒有被取消的時候這一行什麼都不做。
    """
    chunks = aiter(body)
    while True:
        with anyio.CancelScope(shield=True):
            chunk = await anext(chunks, None)
            await db.commit()
        await anyio.lowlevel.checkpoint_if_cancelled()
        if chunk is None:
            return
        yield chunk


async def _csv_response(
    db: AsyncSession, body: AsyncIterator[bytes], *, name: str, user: User
) -> StreamingResponse:
    """`body` 這時候還沒開始跑：generator 要等 Starlette 送出標頭之後才被迭代。

    **`db` 一定要是預設（request）範圍的依賴**：FastAPI 0.118 起，`yield` 的依賴在回應
    **送完之後**才收尾，串流到一半 session 還開著。改成 `Depends(get_db, scope="function")`
    或退回 0.118 之前，session 會在第一塊送出之前就被關掉（`tests/test_export.py` 有一條守著）。

    標頭也是「送」：認證那一次查詢開的交易在回傳之前就結束，理由同 `_release_between_chunks`。
    `user` 的欄位先讀完才結束交易（現在的 `commit()` 不會讓它過期，順序不靠這件事）。
    """
    today = today_in_timezone(user.timezone)
    await db.commit()
    return StreamingResponse(
        _release_between_chunks(db, body),
        media_type="text/csv; charset=utf-8",
        headers={
            "Content-Disposition": f'attachment; filename="{name}-{today.isoformat()}.csv"',
            # 個人資料：不要留在任何中間的快取裡。
            "Cache-Control": "no-store",
        },
    )


@router.get("/meals.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_meals(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的餐點：一個項目一列，由舊到新。"""
    return await _csv_response(
        db, meal_csv(db, user_id=user.id, tz_name=user.timezone), name="meals", user=user
    )


@router.get("/expenses.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_expenses(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的花費：一筆一列，由舊到新。"""
    return await _csv_response(
        db, expense_csv(db, user_id=user.id, tz_name=user.timezone), name="expenses", user=user
    )


@router.get("/supplements.csv", response_class=StreamingResponse, responses=_CSV_RESPONSES)
async def export_supplements(
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> StreamingResponse:
    """自己全部的補劑打卡：一次一列，由舊到新。"""
    return await _csv_response(
        db,
        supplement_csv(db, user_id=user.id, tz_name=user.timezone),
        name="supplements",
        user=user,
    )
