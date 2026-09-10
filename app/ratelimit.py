"""登入速率限制（P4 Task 3）。

見計畫 `docs/superpowers/plans/2026-09-10-p4-deployment.md` 的決定 1、決定 2、
陷阱 1。三句話講完設計：

1. **兩層**：每個「提交的 email 字串」一層、全域一層。前者擋針對單一帳號的
   密碼猜測，後者擋橫向掃過大量帳號的攻擊。兩層都不是永久鎖定，只是延遲。
2. **鍵是使用者送進來的 email 字串本身，不是「存在的帳號」**。呼叫端
   （`app/api/routes/auth.py`）必須讓「email 不存在」與「email 存在但密碼錯」
   走完全相同的程式碼路徑——包含要不要記一次失敗、要不要被擋。這個模組本身
   從頭到尾不查資料庫、不知道帳號存不存在，所以「行為由帳號存在與否決定」
   這種洩漏在這一層是結構性地不可能發生，不是靠呼叫端小心。
3. **計數器放在這個模組的一個全域 instance 裡，純記憶體，沒有任何持久化**。
   這個專案目前是單一容器，重啟後計數歸零在這個規模下可以接受；但這是這個
   實作的既知限制，不是「反正資料本來就不重要」——換成多容器、或需要
   「重啟也不能讓攻擊者的計數歸零」的場景，這裡要換成 Redis 之類的共用
   儲存，不能想成現在這樣就已經涵蓋了那個需求。
"""

import time
from collections.abc import Callable
from dataclasses import dataclass

from app.errors import TooManyRequestsError

# 基準：對跑起來的容器實測，失敗登入（帳號存在但密碼錯）序列約 19.37 次/秒，
# 20 並發與 50 並發都落在 18–19 次/秒——因為 Argon2 驗證是同步、CPU 密集的
# 呼叫，並發連線數對攻擊者的總吞吐量幾乎沒有幫助（陷阱 1）。
#
# 每帳號 5 次／60 秒：把針對單一帳號的密碼猜測，從「60 秒內上千次」壓到
# 「60 秒內 5 次」，同時給打錯密碼的真人留 4 次重試空間（見決定 1：只延遲，
# 不鎖帳號）——OWASP 對線上密碼猜測的建議上限也落在 3–5 次這個範圍。
PER_EMAIL_LIMIT = 5
PER_EMAIL_WINDOW_SECONDS = 60.0

# 全域 20 次／60 秒：擋的是「橫向掃過大量帳號、每個帳號只試一兩次」這種攻擊
# ——那種攻擊不會被每帳號的限制擋下，因為每個帳號都沒有超過 5 次。20/60 秒
# 遠低於基準的 19.37 次/秒（超過 99% 的降幅），但仍然遠高於這個專案實際的
# 合理使用量：單一容器、tailnet 上只有少數幾個人，不可能有人一分鐘內
# 合法登入 20 次。
GLOBAL_LIMIT = 20
GLOBAL_WINDOW_SECONDS = 60.0


@dataclass
class _Window:
    count: int
    started_at: float


class LoginRateLimiter:
    """固定視窗計數器，兩層：每個 email 字串一層、一個全域。

    為什麼是固定視窗而不是滑動視窗或 token bucket：這個規模（單一容器、
    tailnet 上少數使用者）不需要滑動視窗的精確度，固定視窗只是兩個
    `dict[str, _Window]`／一個 `_Window`，足夠簡單、足夠正確。代價是視窗
    邊界會有「雙倍突發」（視窗剛重置的瞬間，前一個視窗的上限 + 新視窗的
    上限可能在很短時間內都被打滿）——對「擋暴力破解」這個目的，這個代價
    可以接受，換取的是不需要記錄每一次請求的時間戳。
    """

    def __init__(
        self,
        *,
        per_email_limit: int = PER_EMAIL_LIMIT,
        per_email_window_seconds: float = PER_EMAIL_WINDOW_SECONDS,
        global_limit: int = GLOBAL_LIMIT,
        global_window_seconds: float = GLOBAL_WINDOW_SECONDS,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._per_email_limit = per_email_limit
        self._per_email_window_seconds = per_email_window_seconds
        self._global_limit = global_limit
        self._global_window_seconds = global_window_seconds
        self._clock = clock
        self._per_email: dict[str, _Window] = {}
        self._global: _Window | None = None

    def check(self, email: str) -> None:
        """在驗證密碼之前呼叫。任一層超過上限就丟 `TooManyRequestsError`。

        這裡只讀取狀態、不修改——真正記一次嘗試是 `record_failure` /
        `record_success` 的事。分開兩個方法，是為了讓呼叫端能夠「先擋，
        擋不下來才真的去跑 Argon2」：被擋的請求完全不用付驗證的 CPU 成本，
        這在攻擊流量大的時候本身就是一種保護。
        """
        now = self._clock()
        per_email_retry_after = self._retry_after(
            self._per_email.get(email),
            self._per_email_limit,
            self._per_email_window_seconds,
            now,
        )
        global_retry_after = self._retry_after(
            self._global, self._global_limit, self._global_window_seconds, now
        )
        candidates = [per_email_retry_after, global_retry_after]
        blocking = [seconds for seconds in candidates if seconds is not None]
        if blocking:
            raise TooManyRequestsError(
                "TOO_MANY_LOGIN_ATTEMPTS",
                "登入嘗試次數過多，請稍後再試",
                retry_after_seconds=max(blocking),
            )

    def record_failure(self, email: str) -> None:
        """帳號不存在或密碼錯誤都要呼叫這個——鍵是 email 字串本身（決定 2），
        呼叫端不能只在「帳號存在」時才呼叫。
        """
        now = self._clock()
        self._per_email[email] = self._advance(
            self._per_email.get(email), self._per_email_window_seconds, now
        )
        self._global = self._advance(self._global, self._global_window_seconds, now)

    def record_success(self, email: str) -> None:
        """成功登入立刻重置該 email 的計數（決定 1：不鎖帳號，只延遲）。

        不動全域計數器：全域上限量的是「這段時間裡有多少次失敗嘗試」，
        跟單一使用者這次登入成不成功無關——重置它會讓橫向掃描攻擊者只要
        混一次成功登入（例如用自己的帳號）就能把全域計數洗掉，那正是
        全域上限要擋的行為。
        """
        self._per_email.pop(email, None)

    def reset(self) -> None:
        """清空所有計數。目前只有測試會呼叫（見 tests/conftest.py 的
        autouse fixture），確保每個測試都是乾淨狀態、不會被前一個測試
        用過的 email 殘留的計數影響。
        """
        self._per_email.clear()
        self._global = None

    def _retry_after(
        self, window: _Window | None, limit: int, window_seconds: float, now: float
    ) -> float | None:
        if window is None:
            return None
        elapsed = now - window.started_at
        if elapsed >= window_seconds:
            return None
        if window.count < limit:
            return None
        return window_seconds - elapsed

    def _advance(self, window: _Window | None, window_seconds: float, now: float) -> _Window:
        if window is None or now - window.started_at >= window_seconds:
            return _Window(count=1, started_at=now)
        window.count += 1
        return window


# app/api/routes/auth.py 用的正式 instance。測試需要控制時間或不同門檻時，
# 用 monkeypatch.setattr("app.api.routes.auth.login_rate_limiter", ...) 換掉，
# 不要直接改這個 instance 的門檻常數（那會影響所有其他測試）。
login_rate_limiter = LoginRateLimiter()
