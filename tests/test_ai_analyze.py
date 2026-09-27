"""`POST /api/ai/analyze`（計畫 P2 一 Task 5）。

規格 §8.1：LLM 一律 mock，不打真的網路（沒有 key，而且會花錢）。用
`app.dependency_overrides[get_estimator]` 注入一個可以數呼叫次數的假
estimator——`FakeEstimator` 就是為了讓 §8.3 那條「斷言結果沒有鑑別力」
的假綠燈測不出來而存在：食物庫命中那條測試斷言的是 `fake.calls == 0`，
不是回傳的營養素等不等於食物庫裡那筆。
"""

import base64
import io
from decimal import ROUND_HALF_UP, Decimal
from pathlib import Path

from PIL import Image
from sqlalchemy import select

from app.ai.estimator import NutritionEstimator, RawEstimate
from app.api.deps import get_estimator
from app.config import settings
from app.errors import BadGatewayError
from app.main import app
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.security.tokens import create_access_token
from tests.factories import create_food, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


_DEFAULT_ESTIMATE = RawEstimate(
    name="測試食物",
    brand=None,
    serving_grams=Decimal("250.00"),
    serving_kcal=Decimal("480.00"),
    serving_protein_g=Decimal("14.00"),
    serving_fat_g=Decimal("18.00"),
    serving_carb_g=Decimal("62.00"),
    confidence=Decimal("0.70"),
    raw={"name": "測試食物"},
)


class FakeEstimator:
    """可注入的假 `NutritionEstimator`（Task 4 的 Protocol 就是為了讓這種
    替身能被注入而存在）。記錄呼叫次數——「食物庫搜得到就不呼叫 LLM」
    要斷言的正是這裡的計數，不是回應內容（規格 §8.3）。
    """

    def __init__(
        self, *, estimate: RawEstimate | None = None, error: Exception | None = None
    ) -> None:
        self._estimate = estimate or _DEFAULT_ESTIMATE
        self._error = error
        self.text_calls = 0
        self.image_calls = 0

    async def estimate_text(self, text: str) -> RawEstimate:
        self.text_calls += 1
        if self._error is not None:
            raise self._error
        return self._estimate

    async def estimate_image(self, image: bytes, media_type: str) -> RawEstimate:
        self.image_calls += 1
        if self._error is not None:
            raise self._error
        return self._estimate

    @property
    def calls(self) -> int:
        return self.text_calls + self.image_calls


def _inject(fake: NutritionEstimator) -> None:
    app.dependency_overrides[get_estimator] = lambda: fake


async def _seed_analyses(db_session, user, count: int) -> None:
    for _ in range(count):
        db_session.add(
            AiAnalysis(
                user_id=user.id,
                kind=AnalysisKind.TEXT,
                model=settings.ai_model,
                input_hash="seed",
                succeeded=True,
            )
        )
    await db_session.commit()


def _tiny_png_bytes() -> bytes:
    buf = io.BytesIO()
    Image.new("RGB", (2, 2), color=(255, 0, 0)).save(buf, format="PNG")
    return buf.getvalue()


def _list_photo_files(photo_dir: Path) -> list[Path]:
    """刻意寫成一般的同步函式，不是在 `async def` 測試裡直接呼叫
    `Path.rglob()`——pathlib 的 I/O 方法是阻塞呼叫，ruff 的 ASYNC240 會擋
    直接寫在 async 函式裡（跟 app/cli.py 的 `_scan_and_clean` 同一個理由）。
    """
    return sorted(p for p in photo_dir.rglob("*") if p.is_file())


# ---------------------------------------------------------------------------
# 行為 1：食物庫搜得到就不呼叫 LLM
# ---------------------------------------------------------------------------


async def test_library_hit_does_not_call_the_llm(client, db_session):
    """**這是規格 §8.3 點名的假綠燈候選。** 如果實作是「先呼叫 LLM、再用
    食物庫的值覆蓋」，只斷言回傳內容的測試一樣會全綠——必須斷言的是
    `fake.calls == 0`，這一行就是那個斷言。
    """
    user = await create_user(db_session)
    await create_food(
        db_session,
        created_by=user,
        owner=user,
        name="滷肉飯",
        kcal=192,
        protein_g=6,
        fat_g=8,
        carb_g=25,
    )
    fake = FakeEstimator()
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze", headers=auth(user), json={"kind": "text", "text": "滷肉飯"}
    )

    assert response.status_code == 200
    assert fake.calls == 0

    body = response.json()
    assert body["analysis_id"] is None
    assert body["name"] == "滷肉飯"
    assert body["nutrition"]["kcal"] == "192.00"
    assert body["nutrition"]["protein_g"] == "6.00"
    assert body["confidence"] == "1.00"


async def test_library_search_only_applies_to_text_not_image(client, db_session):
    """設計決定（這份計畫沒有明講，執行者判斷）：kind=image 沒有可以拿來
    搜尋食物庫的文字，所以一律呼叫 LLM。就算食物庫裡剛好有一筆同名食物，
    也不該被誤用來短路圖片分析。
    """
    user = await create_user(db_session)
    await create_food(db_session, created_by=user, owner=user, name="測試食物")
    fake = FakeEstimator()
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "image", "image_base64": base64.b64encode(_tiny_png_bytes()).decode()},
    )

    assert response.status_code == 200
    assert fake.image_calls == 1
    assert response.json()["analysis_id"] is not None


# ---------------------------------------------------------------------------
# 行為 2：第 21 次被擋
# ---------------------------------------------------------------------------


async def test_the_21st_call_today_is_blocked(client, db_session):
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit)
    fake = FakeEstimator()
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 429
    body = response.json()
    assert body["error"]["code"] == "AI_DAILY_LIMIT"
    limit = settings.ai_daily_limit
    assert f"今天用了 {limit}/{limit}" in body["error"]["message"]
    # 被擋下來，根本沒機會呼叫 LLM——擋下來之後才呼叫的話,這一列會白算錢。
    assert fake.calls == 0


async def test_the_20th_call_today_is_still_allowed(client, db_session):
    """邊界對照組：用滿 19 次之後，第 20 次應該還放行——`>=` 是在等於上限
    「那一刻」才擋，不是提早一次擋。跟突變驗證（三）互為表裡。
    """
    user = await create_user(db_session)
    await _seed_analyses(db_session, user, settings.ai_daily_limit - 1)
    fake = FakeEstimator()
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 200
    assert fake.calls == 1


# ---------------------------------------------------------------------------
# 行為 3：失敗的呼叫也計入額度
# ---------------------------------------------------------------------------


async def test_a_failed_llm_call_is_still_recorded_in_ai_analyses(client, db_session):
    """**這條驗的是資料庫裡真的有那一列，不是回應碼。**

    `db_session` fixture 用 `join_transaction_mode="create_savepoint"`——
    commit() 在測試裡「有沒有真的發生」本身不可觀察，除非 rollback 之後
    還讀得到：rollback 不會抹掉已經 commit 過的 savepoint（計畫一 Task 7
    的教訓，這個專案踩過三次）。用 select 讀欄位、不讀 ORM 實體——
    rollback 會讓物件過期，之後同步讀屬性會觸發 refresh 而炸 MissingGreenlet。
    """
    user = await create_user(db_session)
    # 先把 id 取出來：下面的 rollback() 會讓 user 這個 ORM 物件過期，
    # 之後再讀 user.id 會觸發一次同步的 refresh 查詢，在 async 環境下
    # 直接炸 MissingGreenlet（照抄 tests/test_sessions.py 已經踩過的教訓）。
    user_id = user.id
    fake = FakeEstimator(
        error=BadGatewayError("AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON")
    )
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 502

    await db_session.rollback()
    rows = (
        await db_session.execute(
            select(AiAnalysis.succeeded, AiAnalysis.kind).where(AiAnalysis.user_id == user_id)
        )
    ).all()
    assert len(rows) == 1
    assert rows[0].succeeded is False
    assert rows[0].kind is AnalysisKind.TEXT


# ---------------------------------------------------------------------------
# 行為 4：LLM 回傳垃圾回 502 AI_BAD_RESPONSE
# ---------------------------------------------------------------------------


async def test_llm_garbage_response_is_502_not_500(client, db_session):
    user = await create_user(db_session)
    fake = FakeEstimator(error=BadGatewayError("AI_BAD_RESPONSE", "AI 回傳的內容缺欄位"))
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的另一段描述"},
    )

    assert response.status_code == 502
    assert response.json()["error"]["code"] == "AI_BAD_RESPONSE"


# ---------------------------------------------------------------------------
# 行為 5：沒設 API key 回 503 AI_NOT_CONFIGURED
# ---------------------------------------------------------------------------


async def test_analyze_without_api_key_returns_503(client, db_session, monkeypatch):
    """刻意不 override `get_estimator`——直接用 `app/api/deps.py` 真正的
    `get_estimator()`，它在 `settings.anthropic_api_key is None` 時就會拋
    503（Task 4 已經做好）。測試環境預設沒有 `ANTHROPIC_API_KEY`
    （見根目錄 conftest.py），這裡明確 monkeypatch 一次，不依賴那個環境
    細節、也不受其他測試汙染設定影響。
    """
    monkeypatch.setattr(settings, "anthropic_api_key", None)
    user = await create_user(db_session)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 503
    assert response.json()["error"]["code"] == "AI_NOT_CONFIGURED"


# ---------------------------------------------------------------------------
# 行為 6：flagged 為 True 時仍然正常回 200——標記不擋人
# ---------------------------------------------------------------------------


async def test_flagged_inconsistency_still_returns_200(client, db_session):
    """規格 §2.2：驗證失敗不阻止你記錄。刻意送一組 Atwater 對不起來的估算值
    （宣稱 500 大卡，三大營養素只算得出 80）。
    """
    user = await create_user(db_session)
    contradictory = RawEstimate(
        name="怪食物",
        brand=None,
        serving_grams=Decimal("100.00"),
        serving_kcal=Decimal("500.00"),
        serving_protein_g=Decimal("10.00"),
        serving_fat_g=Decimal("0.00"),
        serving_carb_g=Decimal("10.00"),
        confidence=Decimal("0.50"),
        raw={},
    )
    fake = FakeEstimator(estimate=contradictory)
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的一段描述"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["consistency"]["flagged"] is True
    assert body["consistency"]["atwater_kcal"] == "80.00"
    assert body["consistency"]["deviation"] == "420.00"


# ---------------------------------------------------------------------------
# 行為 7：圖片不會被寫到磁碟
# ---------------------------------------------------------------------------


async def test_image_analysis_does_not_write_to_disk(client, db_session):
    """規格 §6：圖片送去辨識完就丟。**斷言檔案系統，不是斷言回應**——
    只斷言回應裡沒有 photo_path 證明不了檔案沒被寫出去。

    `settings.photo_dir` 已經被 conftest.py 的 autouse fixture 指到
    `tmp_path`，這裡直接數那個目錄底下的檔案數量。
    """
    user = await create_user(db_session)
    fake = FakeEstimator()
    _inject(fake)

    photo_dir = Path(settings.photo_dir)
    before = _list_photo_files(photo_dir)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "image", "image_base64": base64.b64encode(_tiny_png_bytes()).decode()},
    )

    assert response.status_code == 200
    assert fake.image_calls == 1

    after = _list_photo_files(photo_dir)
    assert after == before


# ---------------------------------------------------------------------------
# 額外：每 100g 與一份的數值必須由同一個算法反推，不能各自獨立四捨五入
# ---------------------------------------------------------------------------


async def test_per_100g_and_serving_values_stay_consistent_under_rounding(client, db_session):
    """`serving_kcal == kcal × serving_grams / 100`（含四捨五入）。

    刻意選一個除不盡的 `serving_grams`（300）逼四捨五入真的發生：
    100 大卡 / 300 克 × 100 = 33.333...，進位成 33.33；反推回去
    33.33 × 300 / 100 = 99.99，跟原始的 100 不相等——這就是為什麼
    `serving_kcal` 不能直接照抄 LLM 原始的值，必須從已經四捨五入過的
    `kcal`（每 100g）反推,兩組數字才不會各自獨立四捨五入而漂移
    （這個專案踩過五次「兩處講同一件事就漂移」）。
    """
    user = await create_user(db_session)
    estimate = RawEstimate(
        name="除不盡的食物",
        brand=None,
        serving_grams=Decimal("300.00"),
        serving_kcal=Decimal("100.00"),
        serving_protein_g=Decimal("10.00"),
        serving_fat_g=Decimal("5.00"),
        serving_carb_g=Decimal("7.00"),
        confidence=Decimal("0.80"),
        raw={},
    )
    fake = FakeEstimator(estimate=estimate)
    _inject(fake)

    response = await client.post(
        "/api/ai/analyze",
        headers=auth(user),
        json={"kind": "text", "text": "食物庫裡找不到的第三段描述"},
    )

    assert response.status_code == 200
    nutrition = response.json()["nutrition"]
    assert nutrition["kcal"] == "33.33"
    assert nutrition["serving_kcal"] == "99.99"

    serving_grams = Decimal(nutrition["serving_grams"])
    for per100_key, serving_key in [
        ("kcal", "serving_kcal"),
        ("protein_g", "serving_protein_g"),
        ("fat_g", "serving_fat_g"),
        ("carb_g", "serving_carb_g"),
    ]:
        per100 = Decimal(nutrition[per100_key])
        expected_serving = (per100 * serving_grams / Decimal(100)).quantize(
            Decimal("0.01"), rounding=ROUND_HALF_UP
        )
        assert Decimal(nutrition[serving_key]) == expected_serving
