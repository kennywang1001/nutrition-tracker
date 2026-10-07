"""好友碼（好友規格 §3.1）。

8 個字元、去掉容易看錯的 0/O、1/I/L。顯示成 `XXXX-XXXX`；輸入時不分大小寫、
不管連字號與空白——朋友是從 LINE 或口頭抄過來的，不該因為格式被拒絕。

不是秘密：它的用途是「讓對方送邀請給你」，而邀請還要你接受才成立。重設
只是讓舊碼不能再拿來送新的邀請。
"""

import re
import secrets

FRIEND_CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
FRIEND_CODE_LENGTH = 8

_SEPARATORS = re.compile(r"[\s-]")


def new_friend_code() -> str:
    return "".join(secrets.choice(FRIEND_CODE_ALPHABET) for _ in range(FRIEND_CODE_LENGTH))


def normalize_friend_code(raw: str) -> str:
    return _SEPARATORS.sub("", raw).upper()


def format_friend_code(code: str) -> str:
    return f"{code[:4]}-{code[4:]}"
