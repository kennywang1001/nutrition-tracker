import re
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from pydantic import BaseModel, ConfigDict, EmailStr, Field, field_validator

from app.models.user import UserRole

# C0 控制字元 + DEL + C1。顯示用名稱裡不該出現任何一個。
# 其中 \x00 特別重要：它通得過 Pydantic，然後被 PostgreSQL 拒收，
# 變成一個未經認證就能觸發的 500。
_CONTROL_CHARACTERS = re.compile(r"[\x00-\x1f\x7f-\x9f]")


class RegisterRequest(BaseModel):
    email: EmailStr
    # 上限跟 Argon2 無關 —— 實測雜湊耗時與輸入長度無關（8 字元與 100 萬字元都約 70ms），
    # 因為 Argon2 會先把輸入吸收成固定大小再進記憶體硬化階段。
    # 這個上限單純是請求體衛生：限制客戶端能讓伺服器解析與複製多少資料。
    password: str = Field(min_length=8, max_length=128)
    display_name: str = Field(min_length=1, max_length=50)
    timezone: str = "Asia/Taipei"

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()

    @field_validator("display_name")
    @classmethod
    def _clean_display_name(cls, value: str) -> str:
        value = value.strip()
        if not value:
            raise ValueError("顯示名稱不能只有空白")
        if _CONTROL_CHARACTERS.search(value):
            raise ValueError("顯示名稱不能包含控制字元")
        return value

    @field_validator("timezone")
    @classmethod
    def _must_be_real_timezone(cls, value: str) -> str:
        # 兩種例外都要接：ZoneInfoNotFoundError 是查無此時區；ValueError 是
        # key 本身不合法 —— ZoneInfo("../../etc/passwd") 走的是這條，因為
        # zoneinfo 自己會擋含 ".." 或以 "/" 開頭的 key。
        #
        # 實測澄清兩者的風險方向（不對稱，而且跟直覺相反）：
        # ZoneInfoNotFoundError 繼承自 KeyError/LookupError，不是 ValueError；
        # 而 Pydantic v2 的 field_validator 會自動把驗證函式內部「任何」逃逸的
        # ValueError/TypeError/AssertionError 轉成乾淨的 422 —— 不限於我們自己
        # raise 的那個。所以只接 ZoneInfoNotFoundError（漏接 ValueError）時，
        # "../../etc/passwd" 的原始 ValueError 仍會被 Pydantic 接住變成 422，
        # 只是 response body 的 msg 會外洩 zoneinfo 內部訊息
        # （"ZoneInfo keys must refer to subdirectories of TZPATH..."）而不是
        # 這裡的中文訊息。真正會變成未處理 500 的是反過來：只接 ValueError、
        # 漏接 ZoneInfoNotFoundError 時，"Mars/Olympus" 這類格式合法但查無
        # 此時區的輸入會直接讓 ZoneInfoNotFoundError 逃出去（兩次突變測試
        # 都實際跑過，見 Task 1 報告）。兩種都要接，理由不只一個。
        try:
            ZoneInfo(value)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("不是合法的 IANA 時區名稱") from exc
        return value


class LoginRequest(BaseModel):
    email: EmailStr
    password: str

    @field_validator("email")
    @classmethod
    def _normalise_email(cls, value: str) -> str:
        return value.strip().lower()


class RefreshRequest(BaseModel):
    refresh_token: str


class UserResponse(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: int
    email: str
    display_name: str
    role: UserRole


class TokenResponse(BaseModel):
    access_token: str
    refresh_token: str
    token_type: str = "bearer"
