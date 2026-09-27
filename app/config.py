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
    #
    # **空字串會被正規化成 None，見下面的 validator。** 那不是潔癖：
    # docker-compose 傳的是 `${GEMINI_API_KEY:-}`，沒設值時容器裡會收到
    # 一個空字串而不是「沒有這個變數」。少了正規化，`is None` 會是 False，
    # 程式就會拿一把空字串金鑰去打 API —— 比「功能關閉」更糟，
    # 因為它看起來是開著的。
    gemini_api_key: str | None = None
    # **這個值不要用記憶裡的模型名稱猜。** google-genai 2.25.0 的原始碼裡
    # 沒有任何地方硬編碼一份「目前合法的 model id」清單（inspect 過，
    # 見計畫「開工前已經查證過的事實」）；套件自己的 README 範例反覆用
    # `gemini-flash-latest`，但那是文件範例，不是「這是保證存在的 id」的
    # 權威來源，而且沒有真的打一次 API 驗證過（這份任務不允許打真的 API）。
    # 所以刻意留一個明顯是佔位符、絕對不是真實 model id 的值——部署時第一次
    # 真的呼叫會直接看到 Google 那邊「model not found」的錯誤，逼著填一個
    # 查證過的值，而不是安靜地用一個「看起來合理、其實是猜的」名字失敗在
    # 更難查的地方（見 .env.production.example 的說明）。
    ai_model: str = "REPLACE_ME_SET_A_REAL_GEMINI_MODEL_ID"
    # 規格 §7：只算真的呼叫 LLM 的次數，失敗的也算（一樣花了錢）。
    ai_daily_limit: int = Field(20, gt=0)

    @field_validator("gemini_api_key", mode="before")
    @classmethod
    def _empty_key_is_no_key(cls, value: object) -> object:
        """空字串等於沒有金鑰。

        `docker-compose` 用 `${GEMINI_API_KEY:-}` 傳這個變數（`:-` 而不是
        `:?`，因為它是選配的），所以沒設值時容器裡收到的是**空字串**，
        不是「沒有這個變數」。

        少了這一步，`settings.gemini_api_key is None` 會是 `False`，
        於是 `get_estimator()` 不會拋 `AI_NOT_CONFIGURED`，而是拿一把空字串
        金鑰去建 client —— 使用者看到的會是一個來自 Google 的認證錯誤，
        而不是「你沒設定 AI」。**看起來是開著的比明確關閉更糟。**
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
