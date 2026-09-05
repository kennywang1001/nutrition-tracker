from typing import Annotated

from fastapi import Path

# PostgreSQL 的 BIGINT 上限。超過就會在 asyncpg 的驅動層拋 DataError，
# 而那不會被任何 handler 接住 —— 變成 500，而不是「這個 id 格式不對」該有的 422。
# 下限用 gt=0：所有主鍵都是 GENERATED ALWAYS AS IDENTITY，不會有 0 或負數。
ResourceId = Annotated[int, Path(gt=0, lt=2**63)]
