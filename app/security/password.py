import threading

from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError

_hasher = PasswordHasher()

# Argon2 的預設參數（實測 argon2-cffi）：time_cost=3、memory_cost=64 MiB、
# **parallelism=4**。也就是說「一次雜湊」本身就想要 4 路平行與 64 MiB。
#
# P4 Task 3 把它搬進執行緒池之後，event loop 不再被結構性地阻塞了——
# 但那也解開了原本的序列化，於是可以同時有很多次雜湊在跑。
# 在全域限速允許的上限（20 次/分）下，最壞情況是同時 20 次：
#
#     20 × parallelism 4      = 80 路平行
#     20 × memory_cost 64 MiB = 1.2 GiB 記憶體頻寬
#
# 在 12 核的開發機上這只是延遲變差（實測 /api/health 最高仍到 1000ms）。
# 但**部署目標是 NAS** —— 典型的 Synology 是 2~4 核、4~8 GB RAM，
# 還要分給 DSM 與其他容器。1.2 GiB 的峰值在那裡不是「慢一點」，
# 是可能把整台機器拖垮。
#
# 所以限制「同時進行的雜湊數量」。這不削弱雜湊強度（參數完全沒動），
# 只限制並行度。用 threading 的號誌而不是 asyncio 的，理由是：
# 這個物件是模組層級的，而 asyncio 的同步原語會跟建立它的 event loop 綁定——
# pytest 每個測試都有自己的 loop，一旦發生競爭就會用到已死 loop 上的 future。
# 執行緒號誌完全不依賴 loop，在測試與正式環境行為一致。
#
# 等待中的執行緒不吃 CPU，但會佔住執行緒池的名額（Starlette 預設 40）。
# 全域限速是 20，所以最多只會有 20 條在等，不會把執行緒池吃光。
MAX_CONCURRENT_HASHES = 2
_hash_slots = threading.Semaphore(MAX_CONCURRENT_HASHES)


def hash_password(password: str) -> str:
    with _hash_slots:
        return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    with _hash_slots:
        try:
            return _hasher.verify(password_hash, password)
        except (Argon2Error, InvalidHashError):
            return False


# 登入時「帳號不存在」的分支也要跑一次完整的 Argon2 驗證，讓兩條路徑耗時一致。
# 放在這裡而不是路由裡，是因為它跟 _hasher 的參數綁在一起 ——
# 日後調整 Argon2 參數時，這個假雜湊會自動跟著更新。
DUMMY_PASSWORD_HASH = _hasher.hash("no-such-account-dummy-password")
