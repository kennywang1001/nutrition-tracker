from argon2 import PasswordHasher
from argon2.exceptions import Argon2Error, InvalidHashError

_hasher = PasswordHasher()


def hash_password(password: str) -> str:
    return _hasher.hash(password)


def verify_password(password: str, password_hash: str) -> bool:
    try:
        return _hasher.verify(password_hash, password)
    except (Argon2Error, InvalidHashError):
        return False


# 登入時「帳號不存在」的分支也要跑一次完整的 Argon2 驗證，讓兩條路徑耗時一致。
# 放在這裡而不是路由裡，是因為它跟 _hasher 的參數綁在一起 ——
# 日後調整 Argon2 參數時，這個假雜湊會自動跟著更新。
DUMMY_PASSWORD_HASH = _hasher.hash("no-such-account-dummy-password")
