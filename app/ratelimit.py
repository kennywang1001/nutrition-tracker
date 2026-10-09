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


SESSION_LIMIT = 60
SESSION_WINDOW_SECONDS = 60.0


class KeyedRateLimiter:
    """固定視窗、每個鍵最多 `limit` 次——**每一次 `hit` 都算**。

    跟 `LoginRateLimiter` 分開：登入只算失敗、成功就重置（擋的是猜密碼）；
    這裡擋的是「重放」——成功與失敗一樣要算，否則拿同一張票狂打的人每次
    都「成功」登出（冪等的 204），計數永遠不會累積。
    """

    def __init__(
        self,
        *,
        limit: int,
        window_seconds: float,
        code: str,
        message: str,
        clock: Callable[[], float] = time.monotonic,
        prune_above: int = 1000,
    ) -> None:
        self._limit = limit
        self._window_seconds = window_seconds
        self._code = code
        self._message = message
        self._clock = clock
        self._prune_above = prune_above
        self._windows: dict[str, _Window] = {}

    def hit(self, key: str) -> None:
        now = self._clock()
        # 鍵是 jti 時，每一次正常換票都是新的鍵——不清掉過期的視窗，記憶體會隨換票
        # 次數一直長到容器重啟。超過門檻才掃一次，平常的 hit 不付這個成本。
        if len(self._windows) >= self._prune_above:
            self._windows = {
                k: w
                for k, w in self._windows.items()
                if now - w.started_at < self._window_seconds
            }
        window = self._windows.get(key)
        if window is None or now - window.started_at >= self._window_seconds:
            self._windows[key] = _Window(count=1, started_at=now)
            return
        if window.count >= self._limit:
            raise TooManyRequestsError(
                self._code,
                self._message,
                retry_after_seconds=window.started_at + self._window_seconds - now,
            )
        window.count += 1

    def tracked_keys(self) -> int:
        """目前記著幾個鍵（測試用：確認過期的視窗會被清掉）。"""
        return len(self._windows)

    def reset(self) -> None:
        self._windows.clear()


# `/refresh` 與 `/logout` 共用（安全補強規格 §3.1）：鍵是 token 自己的 `jti`（簽章驗過，
# 偽造不了），所以同一張票的登出與換票共用一份額度。
#
# **為什麼是 `jti`，不是 `sub`（審查後改的）。** 簽章與期限驗得過的票不一定是活的：
# 換過、登出過、被重用偵測撤銷的舊票，14 天內照樣解得開。鍵如果是 `sub`，任何拿到
# 使用者 X 一張舊票的人（例如從一台已經登出的裝置、一份備份、一段紀錄裡撈到的），
# 每分鐘打 60 次就能讓 X 的 `sub` 一直停在 429——X 本人在每一台裝置上都換不了票，
# access token 一過期就被踢出去，而且可以一直這樣下去，不是「一分鐘」而已。
# 鍵是 `jti` 時：
# - 重放舊票只燒掉那張舊票自己的額度，碰不到本人手上的票；
# - 正常輪替每次都拿到新的 `jti`，永遠不會被限速；
# - 洪水仍然被壓在每張票每分鐘 60 次，打到 advisory lock 的量一樣有上限。
#
# **60，不是規格原本寫的 10。** 每次整頁載入都會換一次票（access token 只在記憶體），
# 連續重新整理、開好幾個分頁就是好幾次。10 次時 e2e 實測紅了：一次完整 e2e（約 31 秒）
# 同一個帳號換了 23 次票、7 次被擋。60 次仍然把交接文件實測的重放（每秒 302 次，
# 約每分鐘 18,000 次）壓低 300 倍——要擋的是洪水，不是重新整理。
session_rate_limiter = KeyedRateLimiter(
    limit=SESSION_LIMIT,
    window_seconds=SESSION_WINDOW_SECONDS,
    code="TOO_MANY_SESSION_REQUESTS",
    message="操作太頻繁，請稍後再試",
)


@dataclass(frozen=True, eq=False)
class _Hold:
    """一次 `acquire` 佔到的位子，同時是放掉它的憑證。

    `eq=False`：比的是「是不是同一次 `acquire`」（物件本身），不是欄位——同一個鍵、
    同一個時刻佔到的兩次也是兩張不同的憑證。
    """

    acquired_at: float


class InFlightLimiter:
    """每個鍵**同一時間**最多一個在跑——不是「一段時間內幾次」。

    `KeyedRateLimiter` 算的是「開始了幾次」，管不到「開始之後佔多久」：一個下載到一半就
    不讀的用戶端可以讓一次匯出一直掛著。這個類別只記「誰現在佔著」，`acquire` 與
    `release` 要成對，呼叫端負責在**每一條**結束的路上放掉（做完、失敗、被取消、
    根本沒開始）。

    **佔著的時間有上限（`max_hold_seconds`）：超過了，下一個 `acquire` 直接接手。**
    「每一條結束的路上放掉」管不到**不結束**的那一種：不讀、也不斷線的用戶端可以讓連線
    一直開著（uvicorn 沒有寫入逾時），位子就跟著一直佔著，那個人一直是 429，直到那條連線
    斷掉或 process 重啟。接手只換「誰佔著位子」，**不會去停掉被接手的那一個**——它還掛在
    那裡，等它自己的連線結束。所以「同一時間最多一個」在有人卡住的時候是「每
    `max_hold_seconds` 最多多一個」。

    **放的時候要出示佔的時候拿到的憑證**（`acquire` 的回傳值）。被接手的那一個後來才
    結束時也會來放——它放的是自己的位子，而那個位子已經是別人的了。只認鍵的話，那一下
    會把正在跑的那一個放掉，第三個就進得來。憑證對不上就什麼都不做。

    時鐘是 `time.monotonic`（跟上面兩個限速器一樣可以換掉，測試用）：量的是「過了多久」，
    不能跟著系統時間被調動。

    擋下來的是 `TooManyRequestsError`、**不帶 `Retry-After`**：前一個什麼時候結束這裡
    不知道，不編一個秒數（`app/errors.py`）。上限還剩幾秒是算得出來的，但那是「最壞
    還要等多久」，不是「什麼時候可以再試」——正常的匯出幾秒就結束了，拿它當 `Retry-After`
    會叫人白等十分鐘。

    跟上面兩個限速器一樣只在這個 process 的記憶體裡：單一容器成立；多容器的話，每個
    容器各算各的，「一個人一個」會變成「一個人每個容器一個」。重啟就全部清空——那時
    進行中的串流也一起斷了，兩邊是一致的。
    """

    def __init__(
        self,
        *,
        code: str,
        message: str,
        max_hold_seconds: float,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._code = code
        self._message = message
        self._max_hold_seconds = max_hold_seconds
        self._clock = clock
        self._active: dict[str, _Hold] = {}

    def acquire(self, key: str) -> object:
        """佔住 `key`，回傳放掉它要用的憑證。

        已經有人佔著、而且還沒超過上限就丟 429，**而且這一次什麼都沒有佔到**（沒有憑證，
        也就沒有東西可以拿去 `release`）。佔著的那一個超過上限了：這一次接手，位子從現在
        重新算起。
        """
        now = self._clock()
        current = self._active.get(key)
        if current is not None and now - current.acquired_at < self._max_hold_seconds:
            raise TooManyRequestsError(self._code, self._message, retry_after_seconds=None)
        hold = _Hold(acquired_at=now)
        self._active[key] = hold
        return hold

    def release(self, key: str, token: object) -> None:
        """放掉 `key`——**只有 `token` 是現在佔著的那一次拿到的才放**。

        對不上（已經被接手、已經放過、或這個鍵根本沒有人佔著）不是錯誤，什麼都不做：
        呼叫端在 `finally` 裡呼叫，那裡沒有辦法、也不需要分辨。
        """
        if self._active.get(key) is token:
            del self._active[key]

    def reset(self) -> None:
        self._active.clear()


EXPORT_LIMIT = 6
EXPORT_WINDOW_SECONDS = 60.0

# 匯出（報表月份與匯出規格 §3.6）：三個端點共用，鍵是使用者 id（`str(user.id)`）。
#
# 每一次匯出都是把這個人的整段歷史讀一遍——偷到 access token 的人、或一個寫壞的
# 重試迴圈，不該能一直叫它做。**6 次**：三顆按鈕各按一次是 3 次，手滑再按一輪還在
# 額度內；正常使用碰不到（e2e 一條測試按一次）。
# 鍵是使用者不是端點：分開算的話，額度實際上是三倍。
export_rate_limiter = KeyedRateLimiter(
    limit=EXPORT_LIMIT,
    window_seconds=EXPORT_WINDOW_SECONDS,
    code="TOO_MANY_EXPORTS",
    message="匯出太頻繁，請稍後再試",
)

# 一次匯出最多佔著位子 **10 分鐘**；超過了，同一個人的下一次匯出接手（`InFlightLimiter`）。
#
# 這個數字夾在兩件事中間：
#
# - **不能短到正常的下載被接手。** 一個人的整段歷史是幾 MB 的 CSV（規格 §8 第 9 點），
#   很慢的行動網路（每秒幾十 KB）也是一兩分鐘的事。10 分鐘離它很遠。就算真的有人下載
#   超過 10 分鐘，接手也**不會中斷**那一次——只是那之後同一個人可以同時有兩個在跑。
# - **不能長到「卡住」等於「鎖死」。** 不讀也不斷線的用戶端（或偷到 access token 的人
#   故意這樣做）讓本人一直拿到 `429 EXPORT_IN_PROGRESS`；上限就是本人最多要等多久。
#   10 分鐘是「等一下再試」還說得過去的長度，不必去重啟容器。
#
# 反過來的代價：被接手的那一個還掛著（一個 task、一塊寫入緩衝，不握資料庫連線），所以
# 故意卡住的人每 10 分鐘可以多疊一個——一小時 6 個，沒有這個上限之前是 0 個、沒有
# 「一次一個」之前是每分鐘 6 個（上面的限速）。access token 15 分鐘過期，拿不到新票的人
# 疊不了幾個。
EXPORT_MAX_HOLD_SECONDS = 600.0

# 匯出「一個人同時一個」（規格 §8 第 10 點）：鍵跟上面一樣是使用者 id，三個端點共用。
#
# 限速只管「開始幾次」；一個下載到一半就不讀的用戶端會讓那一次一直掛著——已經不握資料庫
# 連線了（`app/api/routes/export.py` 每一塊之間把連線還回去），但還佔著一個 task 與 uvicorn
# 的寫入緩衝，而且每分鐘可以再疊 6 個。佔與放都在 `export_slot` 那個依賴裡。
export_in_flight = InFlightLimiter(
    code="EXPORT_IN_PROGRESS",
    message="已經有一個匯出在進行，等它下載完再試",
    max_hold_seconds=EXPORT_MAX_HOLD_SECONDS,
)


LIKE_LIMIT = 60
COMMENT_LIMIT = 20
SOCIAL_WINDOW_SECONDS = 60.0

# 按讚與收回**共用**（社群規格 D20），鍵是使用者 id（`str(user.id)`）。分開算的話額度實際上
# 是兩倍。60：連按、反悔、一口氣滑過一頁動態都在額度內——擋的是寫壞的迴圈與拿 id 亂試的人
# （限速在可見性檢查之前）。
like_rate_limiter = KeyedRateLimiter(
    limit=LIKE_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_LIKES",
    message="按得太快了，請稍後再試",
)

# 留言：每一則都會通知餐的主人，所以比讚緊。刪留言不算。
comment_rate_limiter = KeyedRateLimiter(
    limit=COMMENT_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_COMMENTS",
    message="留言太頻繁，請稍後再試",
)

FRIEND_REQUEST_LIMIT = 10

# 送好友邀請（`POST /api/friends/requests`；社群審查 M3），鍵是**送的人**的使用者 id。
#
# 每一個新邀請都給對方一則未讀的「X 想加你為好友」。「送出、收回、再送」每一輪都是一則新的
# ——而且那是對的（收回之後邀請就不在了，再送是一個新的邀請），所以擋的不是通知的寫法，
# 是送的次數。這件事只要拿到對方的好友碼就做得到，不必是好友。收回與拒絕不算。
#
# **10**：一個人一分鐘內真的要加的朋友不會有這麼多個；被擋的人等一分鐘。
# 限速在查好友碼之前，所以查不到的碼也算一次——順便讓拿碼亂試的人一分鐘只有 10 次
# （好友碼是 8 個字，以前這個端點沒有任何限速）。
friend_request_rate_limiter = KeyedRateLimiter(
    limit=FRIEND_REQUEST_LIMIT,
    window_seconds=SOCIAL_WINDOW_SECONDS,
    code="TOO_MANY_FRIEND_REQUESTS",
    message="邀請送得太頻繁，請稍後再試",
)
