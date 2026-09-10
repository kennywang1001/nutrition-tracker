"""P4 Task 3：登入速率限制 + Argon2 移出 event loop。

見 docs/superpowers/plans/2026-09-10-p4-deployment.md 的決定 1、決定 2、陷阱 1。

兩組測試：
- 速率限制（決定 1、決定 2）：大多數測試直接用 `app.ratelimit.login_rate_limiter`
  這個正式 instance（門檻是 production 的真實值，見 app/ratelimit.py 的
  PER_EMAIL_LIMIT / GLOBAL_LIMIT），不用 mock 掉重寫一份門檻——這樣測到的才是
  真的會在 production 跑的行為。只有「視窗過期後恢復」那個測試需要控制時間，
  才另外建一個帶假時鐘的 instance。
  每個測試都靠 conftest.py 的 autouse fixture 在開始前重置這個全域 instance，
  不然测试之间会互相污染（尤其是重複使用 "xxx@example.com" 这种 email 的地方）。
- 不阻塞（陷阱 1）：verify_password / hash_password 要跑在執行緒池，不能卡住
  event loop。
"""

import asyncio
import threading
import time

from app.ratelimit import GLOBAL_LIMIT, PER_EMAIL_LIMIT, PER_EMAIL_WINDOW_SECONDS, LoginRateLimiter
from app.security.password import hash_password, verify_password
from tests.factories import DEFAULT_PASSWORD, create_user


class _FakeClock:
    """讓「視窗過期」這種測試不用真的等 60 秒。"""

    def __init__(self, start: float = 0.0) -> None:
        self._now = start

    def __call__(self) -> float:
        return self._now

    def advance(self, seconds: float) -> None:
        self._now += seconds


async def _attempt_many(client, email: str, password: str, n: int) -> list:
    """依序（不是併發）送 n 次登入請求。刻意不用 asyncio.gather——測試共用的
    db_session 一次只能被一個 coroutine 用（見 tests/conftest.py 的已知邊界 1），
    併發送多個會打到 login 內部的 `await db.scalar(...)`，兩個 coroutine 同時用
    同一個 AsyncSession 會直接炸掉，跟這個 task 要測的東西無關。
    """
    responses = []
    for _ in range(n):
        responses.append(
            await client.post("/api/auth/login", json={"email": email, "password": password})
        )
    return responses


async def _trigger_429(client, email: str):
    responses = await _attempt_many(client, email, "wrong-password", PER_EMAIL_LIMIT + 1)
    return responses[-1]


# ---------------------------------------------------------------------------
# 速率限制
# ---------------------------------------------------------------------------


async def test_exceeding_the_per_email_limit_returns_429(client, db_session):
    await create_user(db_session, email="bruteforced@example.com")

    responses = await _attempt_many(
        client, "bruteforced@example.com", "wrong-password", PER_EMAIL_LIMIT + 1
    )

    assert [r.status_code for r in responses] == [401] * PER_EMAIL_LIMIT + [429]
    assert responses[-1].json()["error"]["code"] == "TOO_MANY_LOGIN_ATTEMPTS"


async def test_failed_attempts_under_the_limit_return_401(client, db_session):
    await create_user(db_session, email="typo@example.com")

    responses = await _attempt_many(client, "typo@example.com", "wrong-password", PER_EMAIL_LIMIT)

    assert [r.status_code for r in responses] == [401] * PER_EMAIL_LIMIT


async def test_rate_limiting_treats_unknown_and_known_emails_identically(client, db_session):
    """決定 2，這個 task 最重要的測試。

    不是只挑「最後一次有沒有 429」比對——如果限速只對存在的帳號生效，
    兩條序列會在中間某一步分岔（例如已知帳號提早進入 429、不存在的帳號永遠
    401），但只看最後一步兩邊都可能剛好是「429」而讓測試誤判成通過。這裡逐一
    比對每一步的狀態碼跟 body，任何一步不一樣都要讓這個測試變紅。
    """
    await create_user(db_session, email="known@example.com")

    known = await _attempt_many(client, "known@example.com", "wrong-password", PER_EMAIL_LIMIT + 2)
    unknown = await _attempt_many(
        client, "unknown@example.com", "wrong-password", PER_EMAIL_LIMIT + 2
    )

    known_status = [r.status_code for r in known]
    unknown_status = [r.status_code for r in unknown]

    assert known_status == unknown_status == [401] * PER_EMAIL_LIMIT + [429, 429]

    for known_response, unknown_response in zip(known, unknown, strict=True):
        assert known_response.json() == unknown_response.json()


async def test_successful_login_resets_the_per_email_counter(client, db_session):
    await create_user(db_session, email="resets@example.com", password=DEFAULT_PASSWORD)

    await _attempt_many(client, "resets@example.com", "wrong-password", PER_EMAIL_LIMIT - 1)

    success = await client.post(
        "/api/auth/login",
        json={"email": "resets@example.com", "password": DEFAULT_PASSWORD},
    )
    assert success.status_code == 200

    # 如果沒有真的重置：重置前已經失敗 PER_EMAIL_LIMIT - 1 次，這裡再失敗
    # PER_EMAIL_LIMIT 次，總數早就超過上限，應該提早出現 429。全部仍然是 401
    # 才證明成功登入真的把計數歸零了。
    after_reset = await _attempt_many(
        client, "resets@example.com", "wrong-password", PER_EMAIL_LIMIT
    )
    assert [r.status_code for r in after_reset] == [401] * PER_EMAIL_LIMIT


async def test_different_emails_are_counted_independently(client, db_session):
    await create_user(db_session, email="victim@example.com")

    exhausted = await _attempt_many(
        client, "victim@example.com", "wrong-password", PER_EMAIL_LIMIT + 1
    )
    assert exhausted[-1].status_code == 429

    bystander = await client.post(
        "/api/auth/login",
        json={"email": "bystander@example.com", "password": "wrong-password"},
    )
    assert bystander.status_code == 401


async def test_global_limit_triggers_across_many_distinct_emails(client):
    """每個 email 都只試一次（遠低於每帳號上限），但橫向掃過夠多帳號時，
    全域上限要擋下來——這正是全域那一層要防的攻擊型態（決定 1）。
    """
    for i in range(GLOBAL_LIMIT):
        response = await client.post(
            "/api/auth/login",
            json={"email": f"sweep{i}@example.com", "password": "wrong-password"},
        )
        assert response.status_code == 401, f"第 {i} 次還在全域上限之下，應該是 401"

    blocked = await client.post(
        "/api/auth/login",
        json={"email": f"sweep{GLOBAL_LIMIT}@example.com", "password": "wrong-password"},
    )
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_LOGIN_ATTEMPTS"


async def test_429_uses_the_standard_error_envelope(client, db_session):
    await create_user(db_session, email="envelope@example.com")

    response = await _trigger_429(client, "envelope@example.com")

    assert response.status_code == 429
    assert response.json() == {
        "error": {
            "code": "TOO_MANY_LOGIN_ATTEMPTS",
            "message": "登入嘗試次數過多，請稍後再試",
            "details": {},
        }
    }


async def test_429_carries_a_reasonable_retry_after_header(client, db_session):
    await create_user(db_session, email="retry@example.com")

    response = await _trigger_429(client, "retry@example.com")

    assert response.status_code == 429
    assert "Retry-After" in response.headers
    retry_after = int(response.headers["Retry-After"])
    assert 0 < retry_after <= PER_EMAIL_WINDOW_SECONDS


async def test_rate_limit_recovers_after_the_window_expires(client, monkeypatch):
    """視窗過期後要恢復——用假時鐘直接跳過 10 秒，不用真的等待，測試才會快。
    門檻刻意跟 production 不一樣（2 次而不是 5 次），單純是讓測試步驟少一點，
    機制本身（固定視窗、過期後重置）跟門檻數字無關。
    """
    clock = _FakeClock()
    limiter = LoginRateLimiter(
        per_email_limit=2,
        per_email_window_seconds=10.0,
        global_limit=1000,
        global_window_seconds=10.0,
        clock=clock,
    )
    monkeypatch.setattr("app.api.routes.auth.login_rate_limiter", limiter)

    first = await client.post(
        "/api/auth/login", json={"email": "windowed@example.com", "password": "wrong"}
    )
    second = await client.post(
        "/api/auth/login", json={"email": "windowed@example.com", "password": "wrong"}
    )
    third = await client.post(
        "/api/auth/login", json={"email": "windowed@example.com", "password": "wrong"}
    )
    assert [first.status_code, second.status_code, third.status_code] == [401, 401, 429]

    clock.advance(10.1)

    recovered = await client.post(
        "/api/auth/login", json={"email": "windowed@example.com", "password": "wrong"}
    )
    assert recovered.status_code == 401


# ---------------------------------------------------------------------------
# 不阻塞：verify_password / hash_password 要跑在執行緒池（陷阱 1）
# ---------------------------------------------------------------------------


async def test_login_runs_verify_password_in_a_thread(client, db_session, monkeypatch):
    await create_user(db_session, email="thready@example.com", password=DEFAULT_PASSWORD)
    main_thread_id = threading.get_ident()
    seen_thread_ids: list[int] = []

    def _recording_verify(password: str, password_hash: str) -> bool:
        seen_thread_ids.append(threading.get_ident())
        return verify_password(password, password_hash)

    monkeypatch.setattr("app.api.routes.auth.verify_password", _recording_verify)

    response = await client.post(
        "/api/auth/login",
        json={"email": "thready@example.com", "password": DEFAULT_PASSWORD},
    )

    assert response.status_code == 200
    assert seen_thread_ids, "verify_password 應該有被呼叫到"
    assert seen_thread_ids[0] != main_thread_id


async def test_register_runs_hash_password_in_a_thread(client, monkeypatch):
    main_thread_id = threading.get_ident()
    seen_thread_ids: list[int] = []

    def _recording_hash(password: str) -> str:
        seen_thread_ids.append(threading.get_ident())
        return hash_password(password)

    monkeypatch.setattr("app.api.routes.auth.hash_password", _recording_hash)

    response = await client.post(
        "/api/auth/register",
        json={
            "email": "thready-register@example.com",
            "password": "a-good-password",
            "display_name": "阿明",
        },
    )

    assert response.status_code == 201
    assert seen_thread_ids, "hash_password 應該有被呼叫到"
    assert seen_thread_ids[0] != main_thread_id


async def test_registered_password_still_verifies_correctly_after_threadpool_hash(client):
    """搬進執行緒池不能把雜湊結果搞壞——註冊完馬上用同樣的密碼登入，
    確認整條路徑（hash 在執行緒池跑、結果存進 DB、下次 verify 在執行緒池跑）
    銜接起來還是對的，不是只看回傳型別對不對。
    """
    register_response = await client.post(
        "/api/auth/register",
        json={
            "email": "roundtrip@example.com",
            "password": "a-good-password",
            "display_name": "阿明",
        },
    )
    assert register_response.status_code == 201

    login_response = await client.post(
        "/api/auth/login",
        json={"email": "roundtrip@example.com", "password": "a-good-password"},
    )
    assert login_response.status_code == 200


async def _poll_health_while(client, other_task: asyncio.Task) -> list[tuple[float, int]]:
    """在 `other_task` 還沒完成之前，每約 10ms 打一次 `/api/health`，記錄每一次
    的（花費秒數、狀態碼）。

    為什麼是「連續輪詢整段期間」而不是「算好時間點打一次」：第一版這兩個測試
    試過兩種「算時間點」的寫法（先 `await asyncio.sleep(0.1)` 再打一次；後來改成
    用 `threading.Event` 從另一個 OS 執行緒等 verify_password／hash_password
    真的開始執行），兩種都在刻意還原成阻塞版本的 auth.py 之後**仍然意外通過**
    ——見這個 task 的紅燈紀錄。原因：
    1. login／register 在打到 verify_password／hash_password 之前，會先
       `await db.scalar(...)`（真正的資料庫 I/O，會讓出 event loop）。
       `/api/health` 幾乎每次都會在那個空檔就先跑完，量到的是「還沒被卡住
       之前」的時間，不管後面到底卡不卡都一樣快。
    2. 一旦 verify_password／hash_password 真的同步卡住 event loop 所在的
       那個唯一的 OS 執行緒，**這個測試自己的任何計時機制**（`asyncio.sleep`、
       透過 executor 等一個 `threading.Event`）一樣要靠那個被卡住的 event loop
       才能繼續前進——換句話說，卡住的當下沒有任何辦法從這個 process 裡
       「精準抓到卡住的那一刻」，因為抓的動作本身也需要 event loop 空出來。

    這裡改成整段期間持續輪詢：不去猜哪個時間點會踩進卡住的區間，而是讓夠多次
    的 `/api/health` request 分散在整個 0.5 秒的視窗裡，只要卡住真的發生，
    一定會有某一次（甚至好幾次）在卡住結束的當下才一起被放行，量到的
    latency 會被拉高，藏不住。

    這個 coroutine 在一個 for 迴圈裡，只有兩個 `await` 點會真的讓出 event loop：
    `client.get(...)` 跟 `asyncio.sleep(0.01)`。迴圈本身（`for` 的每一輪銜接處）
    不會讓出——也就是說「卡住」這件事只可能發生在這兩個 await 點的其中一個
    正在進行的當下（因為只有這兩個時刻，這個 coroutine 才會把 CPU／執行緒
    讓給其他 task，讓 login_task／register_task 有機會被排到、進而卡住）。
    所以量測要涵蓋這一整輪（get + sleep）的總時間，不能只量 get() 那一段——
    第一版只量 get() 本身，卡住如果剛好落在後面那個 `asyncio.sleep(0.01)`
    裡，這個測試完全看不到（sleep 本來只該花 10ms，被卡住時會變成將近
    500ms，但因為沒被記錄下來，量到的 get() 耗時看起來永遠正常）。
    """
    samples: list[tuple[float, int]] = []
    for _ in range(100):  # 上限保護：100 次 * 至少 10ms 一輪 = 至少 1 秒的觀察窗
        if other_task.done():
            break
        started = time.monotonic()
        response = await client.get("/api/health")
        await asyncio.sleep(0.01)
        samples.append((time.monotonic() - started, response.status_code))
    return samples


async def test_concurrent_login_does_not_block_other_requests(client, db_session, monkeypatch):
    """陷阱 1 的核心斷言：一次登入嘗試不能把 event loop 卡住，害其他 request
    一起變慢（實測過 /api/health 在並發登入下最高到 1094.66ms）。

    用 monkeypatch 換一個明顯慢（time.sleep 0.5 秒）的 verify_password，訊號夠大、
    不依賴真實 Argon2 那 50 幾毫秒的量測噪音。整段期間持續打 /api/health 並記錄
    每一次的耗時（見 `_poll_health_while` 的說明——只打一次、只挑一個時間點，
    測不出這個 bug）——如果 verify_password 改回同步內聯呼叫，其中一定會有
    幾次 /api/health 被拖到接近 0.5 秒；如果真的搬進執行緒池，每一次都應該
    只要幾毫秒。
    """
    await create_user(db_session, email="slow@example.com")

    def _slow_verify(password: str, password_hash: str) -> bool:
        time.sleep(0.5)
        return False

    monkeypatch.setattr("app.api.routes.auth.verify_password", _slow_verify)

    login_task = asyncio.create_task(
        client.post(
            "/api/auth/login", json={"email": "slow@example.com", "password": "wrong-password"}
        )
    )

    samples = await _poll_health_while(client, login_task)
    login_response = await login_task

    assert login_response.status_code == 401
    assert samples, "整段期間應該至少打到一次 /api/health"
    assert all(status == 200 for _, status in samples)
    max_latency = max(latency for latency, _ in samples)
    # 遠低於 0.5 秒的 sleep：留出排程雜訊的空間，但足以區分「被卡住」跟「沒被卡住」。
    assert max_latency < 0.3, (
        f"/api/health 有一次花了 {max_latency:.3f}s，event loop 被 verify_password 卡住了"
    )


async def test_concurrent_register_does_not_block_other_requests(client, monkeypatch):
    """跟上一個測試同一個道理與同一個修法，換成 register 的 hash_password。"""

    def _slow_hash(password: str) -> str:
        time.sleep(0.5)
        return hash_password(password)

    monkeypatch.setattr("app.api.routes.auth.hash_password", _slow_hash)

    register_task = asyncio.create_task(
        client.post(
            "/api/auth/register",
            json={
                "email": "slow-register@example.com",
                "password": "a-good-password",
                "display_name": "阿明",
            },
        )
    )

    samples = await _poll_health_while(client, register_task)
    register_response = await register_task

    assert register_response.status_code == 201
    assert samples, "整段期間應該至少打到一次 /api/health"
    assert all(status == 200 for _, status in samples)
    max_latency = max(latency for latency, _ in samples)
    assert max_latency < 0.3, (
        f"/api/health 有一次花了 {max_latency:.3f}s，event loop 被 hash_password 卡住了"
    )


# ---------------------------------------------------------------------------
# 並發雜湊數量的上限（P4 Task 3 收尾補上）
# ---------------------------------------------------------------------------


def test_concurrent_hashing_is_bounded_by_the_semaphore(monkeypatch):
    """同時進行的 Argon2 運算不能超過 MAX_CONCURRENT_HASHES。

    這個測試**不量延遲** —— 延遲測試在 CI 上會 flaky。它直接觀測
    「同一時刻有幾個雜湊在跑」的峰值。

    為什麼需要這個上限：argon2-cffi 的預設 parallelism=4、memory_cost=64 MiB，
    所以「一次雜湊」本身就要 4 路平行 + 64 MiB。把 Argon2 搬進執行緒池解開了
    原本的序列化之後，全域限速允許的 20 次並發會變成 80 路平行 + 1.2 GiB ——
    在 12 核開發機上實測 /api/health 最高仍到 ~1000ms，
    而部署目標 NAS 只有 2~4 核、4~8 GB 而且要分給 DSM。

    實測對照（/api/health 在 20 個並發雜湊下的最高延遲）：
        Argon2 阻塞 event loop（原始）     1094.66ms
        搬進執行緒池、無號誌               ~1000ms
        加上號誌（上限 2）                  153.30ms
    """
    import threading
    import time

    from app.security import password as password_module

    live = 0
    peak = 0
    lock = threading.Lock()

    class CountingHasher:
        """替換整個 _hasher，而不是它的 hash 方法 ——
        `PasswordHasher.hash` 是唯讀屬性（attrs 凍結類別），monkeypatch 不上去。"""

        def hash(self, value: str) -> str:
            nonlocal live, peak
            with lock:
                live += 1
                peak = max(peak, live)
            try:
                time.sleep(0.05)  # 拉長重疊視窗，讓峰值穩定觀測得到
                return "fake-hash"
            finally:
                with lock:
                    live -= 1

    monkeypatch.setattr(password_module, "_hasher", CountingHasher())

    threads = [
        threading.Thread(target=password_module.hash_password, args=("pw",)) for _ in range(10)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    assert peak <= password_module.MAX_CONCURRENT_HASHES, (
        f"同時有 {peak} 個雜湊在跑，上限是 {password_module.MAX_CONCURRENT_HASHES}"
    )
    assert peak >= 2, "上限是 2，應該真的有兩個同時跑過（否則測試沒有觀測到並發）"


def test_the_hash_concurrency_bound_is_actually_small():
    """上限本身必須是個小數字 —— 這一條跟上面那個測試守的是不同的東西。

    上面那個斷言寫的是 `peak <= MAX_CONCURRENT_HASHES`，它**讀那個常數**，
    所以把常數從 2 調到 20，標準會跟著調高、測試照樣通過 ——
    實測確認過：那個突變存活。它守的是「機制存在」（拿掉號誌會紅），
    守不住「常數合理」。

    所以這裡直接對常數本身設限，並把理由寫進失敗訊息：
    每一次 Argon2 要 64 MiB，而部署目標 NAS 只有 4~8 GB 且要分給 DSM
    與其他容器。把上限調到 8 就是 512 MiB 的峰值，調到 20 就是 1.2 GiB。

    要調高的人會在這裡被擋下來，而且會看到該算的那筆帳 ——
    這比在文件裡再寫一次警告有效（計畫 4b Task 9 的教訓：
    文件擋不住重蹈覆轍，程式碼可以）。
    """
    limit = password_module_max()
    assert limit <= 4, (
        f"MAX_CONCURRENT_HASHES = {limit}，峰值記憶體約 {limit * 64} MiB。"
        "部署目標是 NAS（4~8 GB，還要分給 DSM 與其他容器），"
        "要調高請先算過那筆帳並更新這個測試。"
    )


def password_module_max() -> int:
    from app.security import password as password_module

    return password_module.MAX_CONCURRENT_HASHES
