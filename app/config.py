from typing import Literal

from pydantic import Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 這個字串以前是 jwt_secret 的預設值，現在整個原始碼庫的歷史裡到處都找得到——
# 包含公開的 GitHub repo。它已經不是「密鑰」了，是全世界都看得到的已知值。
# 拒絕它的理由跟拒絕「沒有密鑰」是同一個：兩者都等於沒有密鑰，
# 差別只在後者至少會在啟動時大聲失敗，前者會安靜地跑起來看起來正常。
_KNOWN_PUBLIC_PLACEHOLDER_SECRET = "dev-secret-change-me-in-production"


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    database_url: str = "postgresql+asyncpg://wallet:wallet@localhost:5433/wallet"
    # 沒有預設值：fail closed。任何沒有設 JWT_SECRET 的入口
    # （本機 pytest、本機 alembic、忘記設環境變數的 production）都必須在
    # 啟動當下就因為 ValidationError 而崩潰，而不是安靜地退回一個看起來能用、
    # 實際上任何人都能偽造 token 的預設密鑰。
    jwt_secret: str
    jwt_algorithm: str = "HS256"
    access_token_ttl_minutes: int = Field(15, gt=0)
    refresh_token_ttl_days: int = Field(14, gt=0)
    photo_dir: str = "data/photos"

    # **AI 是選配功能，刻意跟 jwt_secret 相反：有預設值（＝關閉）。**
    #
    # jwt_secret 沒有預設是 fail closed —— 沒設等於任何人都能偽造 token。
    # AI 不一樣：沒有它只是少一個功能，讓整個 app 因此起不來是錯的取捨。
    # 但「關閉」必須是明講的 —— 端點回 503 AI_NOT_CONFIGURED（見
    # app/api/deps.py 的 build_estimator），不是一個看起來壞掉的樣子。
    #
    # **部署時選一家**（AI 估算前端規格 §3.1）：沒設 ai_provider＝關閉；
    # 設了一個不認得的值（打錯字）→ 這裡的 Literal 讓啟動直接失敗——打錯字
    # 是設定錯誤，要大聲說出來，不是安靜地關掉。
    ai_provider: Literal["anthropic", "gemini"] | None = None
    anthropic_api_key: str | None = None
    gemini_api_key: str | None = None
    # **不給預設值。** 猜一個看起來合理的模型名稱，猜錯時要到第一次真的呼叫
    # 才失敗，而且錯在更難查的地方（feat/p2-gemini 分支的教訓）。
    ai_model: str | None = None
    # 規格 §7：只算真的呼叫 LLM 的次數，失敗的也算（一樣花了錢）。
    ai_daily_limit: int = Field(20, gt=0)

    @field_validator(
        "ai_provider", "anthropic_api_key", "gemini_api_key", "ai_model", mode="before"
    )
    @classmethod
    def _empty_means_unset(cls, value: object) -> object:
        """空字串（含只有空白）等於沒設。

        `docker-compose` 用 `${VAR:-}` 傳這些選配變數（`:-` 而不是 `:?`），
        所以沒設值時容器裡收到的是**空字串**，不是「沒有這個變數」。

        少了這一步：金鑰是空字串時 `is None` 會是 False，程式會拿一把空字串
        金鑰去建 client——使用者看到的是供應商的認證錯誤，而不是「你沒設定
        AI」；`ai_provider` 是空字串時會撞上 Literal 而讓整個 app 起不來。
        **看起來是開著的比明確關閉更糟。**
        """
        if isinstance(value, str) and value.strip() == "":
            return None
        return value

    @field_validator("jwt_secret")
    @classmethod
    def _reject_known_public_placeholder(cls, value: str) -> str:
        if value == _KNOWN_PUBLIC_PLACEHOLDER_SECRET:
            raise ValueError(
                "JWT_SECRET 不能是原始碼裡公開過的開發預設值"
                f' ("{_KNOWN_PUBLIC_PLACEHOLDER_SECRET}")——'
                "這個字串在公開的 GitHub repo 裡，等於沒有密鑰。"
                "請用 `openssl rand -hex 32` 產生一個新的。"
            )
        return value


settings = Settings()
