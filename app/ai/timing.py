"""AI 的計時 log（照片說明規格 §7）。

給管理員從 `docker compose logs api` 看「一次估算的 20 秒花在哪裡」：供應商那一次呼叫多久、
用了多少 token（含思考）。**只記列舉名稱、整數、我們自己的設定**——提示詞、使用者的字
（說明、偏好）、照片、模型的輸出、供應商的錯誤訊息一律不記（同兩家 estimator 的 WARNING）：
那是別人吃了什麼，而且模型的輸出是不可信的文字（可以帶換行偽造 log 行）。
"""

import asyncio
import logging
from collections.abc import Mapping
from typing import Literal

from app.ai.estimator import EstimatorMisconfiguredError, EstimatorUpstreamError

Source = Literal["text", "image"]
Outcome = Literal["ok", "misconfigured", "upstream", "cancelled", "error"]


def outcome_of(exc: BaseException) -> Outcome:
    """`_complete` 丟出去的例外 → log 上的 outcome（分類跟路由的錯誤碼同一套）。"""
    if isinstance(exc, EstimatorMisconfiguredError):
        return "misconfigured"
    if isinstance(exc, EstimatorUpstreamError):
        return "upstream"
    if isinstance(exc, asyncio.CancelledError):
        # 等供應商的那個 task 被取消（審查 M3）：不是錯誤，但花掉的秒數照樣要看得到。
        return "cancelled"
    return "error"


def log_provider_call(
    log: logging.Logger,
    *,
    kind: str,
    source: Source,
    model: str,
    effort: str | None,
    elapsed: float,
    outcome: Outcome,
    usage: Mapping[str, object] | None = None,
) -> None:
    """一次供應商呼叫一行 INFO（照片說明規格 §7.1）。

    `usage` 是那一家 SDK 給的用量與停下來的原因（列舉名稱、整數）；失敗時沒有，就不印。名稱
    沿用兩家既有 WARNING 的（規格「與原始決定的差異」第 4 點）：Anthropic 的 `output_tokens`
    **含**思考、Gemini 的 `candidates_tokens` **不含**，湊成同一個名字反而誤導。

    `outcome=ok` 只表示供應商回了；回覆看不懂是路由那一行的 `status=502`。"""
    details = "".join(f", {name}={value}" for name, value in (usage or {}).items())
    log.info(
        "AI 呼叫（kind=%s, input=%s, model=%s, effort=%s, outcome=%s, elapsed=%.2fs%s）",
        kind,
        source,
        model,
        effort or "-",
        outcome,
        elapsed,
        details,
    )
