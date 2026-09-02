from sqlalchemy import MetaData
from sqlalchemy.orm import DeclarativeBase

# 不設命名慣例的話，PostgreSQL 會自己幫 CHECK 約束取名（food_revisions_check、
# food_revisions_check1…），編號依約束加入的順序決定，從模型讀不出來。
# 後果不只是名字醜：alembic revision --autogenerate 會因為對不上名字，
# 對「完全沒改過」的 CHECK 約束產生 remove_constraint，照著跑就真的把約束刪掉。
NAMING_CONVENTION = {
    "ix": "ix_%(column_0_label)s",
    "uq": "uq_%(table_name)s_%(column_0_N_name)s",
    "ck": "ck_%(table_name)s_%(constraint_name)s",
    "fk": "fk_%(table_name)s_%(column_0_name)s_%(referred_table_name)s",
    "pk": "pk_%(table_name)s",
}


class Base(DeclarativeBase):
    metadata = MetaData(naming_convention=NAMING_CONVENTION)
