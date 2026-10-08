"""稽核紀錄寫 INFO（規格決定 17）。uvicorn 的預設設定只替 uvicorn.* 掛 handler——
`app.*` 的 INFO 會落到 Python 的 lastResort（只輸出 WARNING 以上），寫了等於沒寫。"""

import logging

import app.main  # noqa: F401 — 設定在 import app.main 時發生


def test_app_loggers_emit_info():
    logger = logging.getLogger("app.api.routes.me")
    assert logger.isEnabledFor(logging.INFO)


def test_the_app_logger_has_its_own_handler():
    # 沒有 handler 的話，INFO 一路往上找不到任何 handler，最後交給 lastResort（WARNING）。
    assert logging.getLogger("app").handlers
