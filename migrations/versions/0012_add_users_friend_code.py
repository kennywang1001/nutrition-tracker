"""add users.friend_code

Revision ID: 0012
Revises: 0011
"""

import secrets
from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0012"
down_revision: str | None = "0011"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None

# 跟 app/friend_codes.py 同一份字母表——刻意複製，不 import：app 的程式碼之後
# 會變，migration 要照它被寫下的那一刻執行。
_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"


def _new_code() -> str:
    return "".join(secrets.choice(_ALPHABET) for _ in range(8))


def upgrade() -> None:
    # 先可為 null、逐一補碼、再收緊：既有的使用者需要一個值才能加 NOT NULL。
    op.add_column("users", sa.Column("friend_code", sa.Text, nullable=True))
    connection = op.get_bind()
    user_ids = connection.execute(sa.text("SELECT id FROM users ORDER BY id")).scalars().all()
    used: set[str] = set()
    for user_id in user_ids:
        code = _new_code()
        while code in used:
            code = _new_code()
        used.add(code)
        connection.execute(
            sa.text("UPDATE users SET friend_code = :code WHERE id = :id"),
            {"code": code, "id": user_id},
        )
    op.alter_column("users", "friend_code", nullable=False)
    op.create_unique_constraint("uq_users_friend_code", "users", ["friend_code"])


def downgrade() -> None:
    op.drop_constraint("uq_users_friend_code", "users", type_="unique")
    op.drop_column("users", "friend_code")
