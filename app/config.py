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

    # **刻意跟 jwt_secret 相反：有預設值。**
    #
    # jwt_secret 沒有預設是 fail closed —— 沒設等於任何人都能偽造 token，
    # 那種情況下安靜地跑起來比崩潰更糟。
    #
    # AI 不一樣：沒有 key 不會讓系統變得不安全，只是少一個功能。讓整個 app
    # 因為少一個選配功能而起不來是錯的取捨（規格 §4.1）。
    #
    # 但「關閉」必須是明講的 —— 端點回 503 AI_NOT_CONFIGURED，
    # 不是一個看起來壞掉的樣子。
    anthropic_api_key: str | None = None
    ai_model: str = "claude-sonnet-5"
    # 規格 §7：只算真的呼叫 LLM 的次數，失敗的也算（一樣花了錢）。
    ai_daily_limit: int = Field(20, gt=0)

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
