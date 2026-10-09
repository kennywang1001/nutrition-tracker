"""`POST /api/ai/analyze` 與 `POST /api/ai/analyze-meal` —— 文字或圖片進去，
一份（或一餐的每一樣）的營養素估算加上一致性檢查出來，而且不落庫（規格 §1.3、§4）。

流程（規格 §3）：

    ① 先搜自己看得到的食物庫（DB 查詢，不呼叫 LLM）—— 找到就直接回，
       不計入每日上限，也不寫 ai_analyses
    （命中食物庫之後才建 AI 實作——AI 沒設定時，命中食物庫照樣能用）
    ② 檢查今日額度（數 ai_analyses 今天的列數）
    ③ 呼叫 LLM。不管成功失敗都寫一列 ai_analyses —— 兩種都花了錢。
       唯一的例外：供應商說設定錯了（金鑰、權限、模型）→ 503，不寫——它直接拒絕，沒有計費
    ④ 純函式一致性檢查（app/ai/consistency.py）
    ⑤ 回傳估算值 + 一致性結果 + analysis_id + food_id（只有命中食物庫才有）
       + remaining_today，到這裡為止沒有寫入任何食物

`/analyze-meal`（AI 多樣估算規格 §3.1）是同一個流程的多樣版：①～③ 用的是同一批函式
（食物庫短路、額度、記錄與錯誤分類），差別只有呼叫的是 estimator 的 `estimate_meal_*`、
回的是一句描述＋每一樣各一份估算，而且每一樣再各自比對一次食物庫。**一次呼叫只寫一列**。
"""

import base64
import binascii
import hashlib
import io
import logging
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from PIL import Image
from pydantic import ValidationError
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.consistency import check_consistency
from app.ai.estimator import (
    EstimatorMisconfiguredError,
    EstimatorUpstreamError,
    RawEstimate,
    RawMealEstimate,
)
from app.api.deps import EstimatorFactory, get_current_user, get_estimator_factory
from app.api.routes.meals import MAX_PHOTO_BYTES
from app.config import settings
from app.days import day_bounds, today_in_timezone
from app.db import get_db
from app.errors import (
    BadGatewayError,
    PayloadTooLargeError,
    ServiceUnavailableError,
    TooManyRequestsError,
    UnprocessableEntityError,
)
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.models.food import BaseUnit, Food, FoodRevision
from app.models.user import User
from app.schemas.ai import (
    AnalyzedMealItem,
    AnalyzedNutrition,
    AnalyzeMealResponse,
    AnalyzeRequest,
    AnalyzeResponse,
    AnalyzeTextRequest,
    ConsistencyResult,
    LibraryFoodMatch,
)
from app.storage.photos import MAX_IMAGE_PIXELS

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/ai", tags=["ai"])

_CENTS = Decimal("0.01")
_BASE_AMOUNT = Decimal(100)

# 跟 app/storage/photos.py 的 save_photo() 同一組格式對照，但這裡刻意
# 不呼叫 save_photo()——規格 §6：圖片辨識完就丟，這個端點全程不寫磁碟。
_MEDIA_TYPE_BY_PIL_FORMAT = {
    "JPEG": "image/jpeg",
    "PNG": "image/png",
    "GIF": "image/gif",
    "WEBP": "image/webp",
}


async def _find_in_food_library(
    db: AsyncSession, user: User, text: str
) -> tuple[Food, FoodRevision] | None:
    """規格 §3 步驟①：「能用 DB 解決的就別呼叫 LLM」（P1 規格 §11 原話）。

    只在 kind=text 時做（kind=image 沒有可以拿來搜尋的文字）。**刻意用精確
    比對（不分大小寫），不是子字串**——這個文字欄位通常是一段描述（規格
    §4.1 範例「一碗滷肉飯」），子字串比對在多義詞情境下會不可預期地挑中
    一筆當作「找到」，那比直接呼叫 LLM 更危險。隨著使用者確認過的 AI 結果
    越存越多（規格 §3：那些都會變成食物庫的一部分），精確比對命中的機率
    會自然提升。比較用 `lower() ==`，不用 `ilike`——後者把使用者文字裡的 `%`、`_`
    當萬用字元，`%麵` 會命中任意一個食物。同名的自己的食物與全域食物並存時，
    回自己的。

    範圍是使用者看得到的食物（自己的 + 全域），跟 `search_foods` 同一個
    可見性規則——全域食物（例如「白飯」）一樣不需要為它多花一次 LLM 呼叫，
    不是規格字面上「自己的食物庫」那麼窄。

    只有「有生效版本」的食物算數（`current_revision_id` 不是 NULL）——
    沒有生效版本就沒有營養素可以回，等同沒找到（跟 app/api/routes/meals.py
    的 `_resolve_item` 同一個道理）。
    """
    row = (
        await db.execute(
            select(Food, FoodRevision)
            .join(FoodRevision, Food.current_revision_id == FoodRevision.id)
            .where(
                or_(Food.owner_id.is_(None), Food.owner_id == user.id),
                # 不用 ilike：`%`、`_` 會被當萬用字元，`%麵` 會命中任意一個食物。
                func.lower(Food.name) == text.strip().lower(),
            )
            # 自己的食物優先於全域的（False 排前面），再用 id 讓結果固定。
            .order_by(Food.owner_id.is_(None), Food.id)
            .limit(1)
        )
    ).first()
    return None if row is None else (row[0], row[1])


def _library_hit_response(
    food: Food, revision: FoodRevision, *, remaining_today: int
) -> AnalyzeResponse:
    """食物庫命中：直接用那一版的資料組回應，`serving_grams` 沒有意義，
    取 100（等同「一份 = 每 100g」，讓 serving_* 與 per-100g 的值自然相等）。

    `confidence` 不是 AI 自陳值——這是驗證過、已經存在食物庫裡的資料，
    不是估算，給 1.00 表示「這不是估的，是查到的」。
    """
    consistency = check_consistency(
        kcal=revision.kcal,
        protein_g=revision.protein_g,
        fat_g=revision.fat_g,
        carb_g=revision.carb_g,
    )
    return AnalyzeResponse(
        analysis_id=None,
        food_id=food.id,
        name=food.name,
        brand=food.brand,
        nutrition=AnalyzedNutrition(
            base_unit=revision.base_unit,
            serving_grams=_BASE_AMOUNT,
            kcal=revision.kcal,
            protein_g=revision.protein_g,
            fat_g=revision.fat_g,
            carb_g=revision.carb_g,
            serving_kcal=revision.kcal,
            serving_protein_g=revision.protein_g,
            serving_fat_g=revision.fat_g,
            serving_carb_g=revision.carb_g,
        ),
        confidence=Decimal("1.00"),
        consistency=ConsistencyResult.model_validate(consistency),
        remaining_today=remaining_today,
    )


async def _count_used_today(db: AsyncSession, user: User) -> int:
    """今天呼叫了幾次 AI——直接數 `ai_analyses`（規格 §7.2），不另設計數器。

    「今天」用 `day_bounds(today_in_timezone(user.timezone), user.timezone)`
    ——跟 `stats/daily`、`meals`、`supplements/today` 同一個「今天」
    （P1 陷阱 1），不是 `date.today()`。
    """
    start, end = day_bounds(today_in_timezone(user.timezone), user.timezone)
    return (
        await db.scalar(
            select(func.count())
            .select_from(AiAnalysis)
            .where(
                AiAnalysis.user_id == user.id,
                AiAnalysis.created_at >= start,
                AiAnalysis.created_at < end,
            )
        )
        or 0
    )


def _remaining(used_today: int) -> int:
    return max(0, settings.ai_daily_limit - used_today)


async def _assert_quota_available(db: AsyncSession, user: User) -> int:
    """額度用完就 429；沒用完回傳今天已經用了幾次。

    **比較必須是 `>=`，不是 `>`。** 上限 20 代表最多存在 20 列，第 21 次
    呼叫發生時 `used_today` 已經是 20，`20 >= 20` 才會擋下來；`>` 會讓
    第 21 次還被放行，差一錯誤（計畫 Task 5 突變驗證（三））。
    """
    used_today = await _count_used_today(db, user)
    if used_today >= settings.ai_daily_limit:
        _, end = day_bounds(today_in_timezone(user.timezone), user.timezone)
        retry_after_seconds = max(1.0, (end - datetime.now(UTC)).total_seconds())
        raise TooManyRequestsError(
            "AI_DAILY_LIMIT",
            f"今天用了 {used_today}/{settings.ai_daily_limit} 次，請明天再試",
            retry_after_seconds,
        )
    return used_today


async def _call_estimator_or_record_failure[T](
    db: AsyncSession,
    *,
    user_id: int,
    kind: AnalysisKind,
    input_hash: str,
    model: str,
    call: Callable[[], Awaitable[T]],
) -> T:
    """呼叫 LLM；不管成功或失敗都要在 `ai_analyses` 留一列（規格 §7：
    兩種都花了錢）。

    失敗時的處理照抄 `app/security/sessions.py` 的 `_reject()`：**必須在
    例外離開這個函式之前 commit**——例外一旦真的往外拋，FastAPI 的路由
    函式就不會執行到後面幫這個 session commit 的那一行，少了這裡的
    commit，失敗那一列會跟著例外一起被外層的交易（測試是 db_session
    fixture 的最外層 rollback，production 是 get_db 那個 per-request
    session 沒有 commit 就直接 close）一起丟掉，於是「LLM 一直失敗」
    會變成一個不花錢的無限迴圈，而它其實每次都在計費。

    **例外是設定錯誤**（`EstimatorMisconfiguredError`：金鑰、權限、模型）——供應商
    直接拒絕、沒有計費，不記一列也就不算額度（AI 與編輯畫面的收尾規格 §2 第 2 項）。
    記的話，管理員修好設定之前，每個人每按一次就少一次額度。

    上游錯誤（`EstimatorUpstreamError`）照舊記一列，再換成 502 AI_UPSTREAM_ERROR；
    沒分類的例外也照舊記一列，原樣往外拋（500）。
    """
    try:
        return await call()
    except EstimatorMisconfiguredError as exc:
        # 不記列，所以這一行 log 是管理員唯一看得到「供應商說了什麼」的地方。
        logger.error("AI 供應商拒絕了設定（model=%s）：%s", model, exc)
        raise ServiceUnavailableError(
            "AI_MISCONFIGURED", "AI 設定有問題（金鑰或模型），請管理員檢查"
        ) from exc
    except Exception as exc:
        db.add(
            AiAnalysis(
                user_id=user_id,
                kind=kind,
                model=model,
                input_hash=input_hash,
                succeeded=False,
            )
        )
        await db.commit()
        if isinstance(exc, EstimatorUpstreamError):
            logger.warning("AI 供應商暫時無法使用（model=%s）：%s", model, exc)
            raise BadGatewayError(
                "AI_UPSTREAM_ERROR", "AI 服務暫時無法使用，請稍後再試"
            ) from exc
        if isinstance(exc, BadGatewayError):
            # 連上了、也回了，但回的東西沒過把關（AI_BAD_RESPONSE／AI_NO_FOOD_FOUND）。
            # 使用者只看得到一句「看不懂」；這一行是管理員唯一查得到「哪裡不對」的地方。
            logger.warning(
                "AI 的回覆沒有通過檢查（model=%s）：%s %s",
                model,
                exc.code,
                _describe_rejected_reply(exc),
            )
        raise


def _describe_rejected_reply(exc: BadGatewayError) -> str:
    """回覆為什麼被拒絕——**只說位置與種類，不帶回覆的內容**。

    回覆裡是使用者那一餐的東西（照片裡看到的、他打的字），不進 log。Pydantic 的
    `errors()` 每一筆都帶 `input`（被拒絕的值）與 `msg`（有時會把值寫進去），所以
    只取 `loc` 與 `type`；JSON 解析失敗只取例外的類別與位置，不取它帶的原文。
    """
    cause = exc.__cause__
    if isinstance(cause, ValidationError):
        places = [
            f"{'.'.join(str(part) for part in error['loc'])}:{error['type']}"
            for error in cause.errors(include_input=False, include_url=False)
        ]
        # 一餐最多 8 樣 × 8 欄；真的全錯也只列前 20 筆，夠看出是哪一類問題。
        return f"{len(places)} 處不合格：{', '.join(places[:20])}"
    if isinstance(cause, ValueError):
        position = getattr(cause, "pos", None)
        return f"{type(cause).__name__}（位置 {position}）"
    return "沒有進一步的原因"


def _decode_photo(image_base64: str) -> tuple[bytes, str]:
    """base64 解碼 + 驗證 + 判斷 media_type。

    跟 `app/storage/photos.py` 的 `save_photo()` 同一個「不信任宣告」原則
    （實際用 Pillow 解碼後判斷格式，不信任 client 宣告的內容），但只做到
    「判斷格式」為止——**刻意不呼叫 `save_photo()`，全程不寫磁碟**
    （規格 §6：圖片送去辨識完就丟）。
    """
    try:
        content = base64.b64decode(image_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise UnprocessableEntityError("INVALID_PHOTO", "圖片內容不是合法的 base64") from exc

    if len(content) > MAX_PHOTO_BYTES:
        raise PayloadTooLargeError(
            "PHOTO_TOO_LARGE", f"照片大小超過 {MAX_PHOTO_BYTES} bytes 的上限"
        )

    try:
        image: Image.Image = Image.open(io.BytesIO(content))
        width, height = image.size
    except Exception as exc:
        raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式") from exc

    if width * height > MAX_IMAGE_PIXELS:
        # 跟 save_photo() 同一個理由：這個檢查一定要在 image.load() 之前，
        # 避免真的把巨大的像素資料解壓進記憶體（疑似解壓縮炸彈）。
        raise UnprocessableEntityError("INVALID_PHOTO", "圖片尺寸超過允許上限，疑似解壓縮炸彈")

    try:
        image.load()
    except Exception as exc:
        raise UnprocessableEntityError("INVALID_PHOTO", "無法識別的圖片格式") from exc

    media_type = _MEDIA_TYPE_BY_PIL_FORMAT.get(image.format or "")
    if media_type is None:
        raise UnprocessableEntityError("INVALID_PHOTO", "不支援的圖片格式")

    return content, media_type


def _per_100g(serving_value: Decimal, serving_grams: Decimal) -> Decimal:
    return (serving_value * _BASE_AMOUNT / serving_grams).quantize(
        _CENTS, rounding=ROUND_HALF_UP
    )


def _serving_from_per_100g(per_100g_value: Decimal, serving_grams: Decimal) -> Decimal:
    return (per_100g_value * serving_grams / _BASE_AMOUNT).quantize(
        _CENTS, rounding=ROUND_HALF_UP
    )


def _to_analyzed_nutrition(raw: RawEstimate) -> AnalyzedNutrition:
    """`serving_grams` 是 AI 估的「一份」，`AnalyzedNutrition` 的 kcal 等
    欄位要換成每 100g/ml（規格 §4.1：換算一定要在後端做一次，前端不重算）。

    **`serving_kcal` 等欄位是從已經四捨五入過的每 100g 值反推回去的，不是
    直接拿 `raw.serving_kcal` 填進去。** 這樣兩組數字才保證「兩處講同一件
    事」不會各自獨立四捨五入而漂移——`serving_kcal == kcal × serving_grams
    / 100`（含四捨五入）這個不變式因此是「因為算法只有一個事實來源」而
    必然成立，不是巧合（計畫 Task 5：「這個專案踩過五次」的那個形狀）。
    """
    kcal = _per_100g(raw.serving_kcal, raw.serving_grams)
    protein_g = _per_100g(raw.serving_protein_g, raw.serving_grams)
    fat_g = _per_100g(raw.serving_fat_g, raw.serving_grams)
    carb_g = _per_100g(raw.serving_carb_g, raw.serving_grams)

    return AnalyzedNutrition(
        base_unit=BaseUnit.G,
        serving_grams=raw.serving_grams,
        kcal=kcal,
        protein_g=protein_g,
        fat_g=fat_g,
        carb_g=carb_g,
        serving_kcal=_serving_from_per_100g(kcal, raw.serving_grams),
        serving_protein_g=_serving_from_per_100g(protein_g, raw.serving_grams),
        serving_fat_g=_serving_from_per_100g(fat_g, raw.serving_grams),
        serving_carb_g=_serving_from_per_100g(carb_g, raw.serving_grams),
    )


@router.post("/analyze", response_model=AnalyzeResponse)
async def analyze(
    payload: AnalyzeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    make_estimator: EstimatorFactory = Depends(get_estimator_factory),
) -> AnalyzeResponse:
    if isinstance(payload, AnalyzeTextRequest):
        hit = await _find_in_food_library(db, user, payload.text)
        if hit is not None:
            food, revision = hit
            used_today = await _count_used_today(db, user)
            return _library_hit_response(food, revision, remaining_today=_remaining(used_today))

    # 到這裡才真的需要 AI：沒設定就 503（AI 估算前端規格 §3.3）。**要在檢查
    # 額度之前**——沒設定又剛好額度用完時，該說的是「未設定」，不是「今天
    # 用完了」（後者會讓人以為明天就好了）。
    estimator = make_estimator()
    used_today = await _assert_quota_available(db, user)

    kind: AnalysisKind
    input_hash: str
    raw: RawEstimate
    if isinstance(payload, AnalyzeTextRequest):
        kind = AnalysisKind.TEXT
        input_hash = hashlib.sha256(payload.text.encode()).hexdigest()
        text = payload.text
        raw = await _call_estimator_or_record_failure(
            db,
            user_id=user.id,
            kind=kind,
            input_hash=input_hash,
            model=estimator.model,
            call=lambda: estimator.estimate_text(text),
        )
    else:
        kind = AnalysisKind.IMAGE
        content, media_type = _decode_photo(payload.image_base64)
        input_hash = hashlib.sha256(content).hexdigest()
        raw = await _call_estimator_or_record_failure(
            db,
            user_id=user.id,
            kind=kind,
            input_hash=input_hash,
            model=estimator.model,
            call=lambda: estimator.estimate_image(content, media_type),
        )

    analysis = AiAnalysis(
        user_id=user.id,
        kind=kind,
        model=estimator.model,
        input_hash=input_hash,
        succeeded=True,
    )
    db.add(analysis)
    await db.commit()
    await db.refresh(analysis)

    consistency = check_consistency(
        kcal=raw.serving_kcal,
        protein_g=raw.serving_protein_g,
        fat_g=raw.serving_fat_g,
        carb_g=raw.serving_carb_g,
    )
    return AnalyzeResponse(
        analysis_id=analysis.id,
        food_id=None,
        name=raw.name,
        brand=raw.brand,
        nutrition=_to_analyzed_nutrition(raw),
        confidence=raw.confidence,
        consistency=ConsistencyResult.model_validate(consistency),
        # 這一次已經寫進 ai_analyses 了。
        remaining_today=_remaining(used_today + 1),
    )


def _library_match(
    food: Food, revision: FoodRevision, serving_grams: Decimal
) -> LibraryFoodMatch:
    return LibraryFoodMatch(
        food_id=food.id,
        name=food.name,
        base_unit=revision.base_unit,
        # 用食物庫那一筆的話，這一樣會記成多少熱量：它的每 100 × AI 估的量。
        serving_kcal=_serving_from_per_100g(revision.kcal, serving_grams),
    )


async def _to_meal_item(db: AsyncSession, user: User, raw: RawEstimate) -> AnalyzedMealItem:
    """一樣的估算 → 回應裡的一樣：一致性檢查＋比對食物庫（跟文字短路同一個
    `_find_in_food_library`，「同名」只有這一種定義）。"""
    consistency = check_consistency(
        kcal=raw.serving_kcal,
        protein_g=raw.serving_protein_g,
        fat_g=raw.serving_fat_g,
        carb_g=raw.serving_carb_g,
    )
    hit = await _find_in_food_library(db, user, raw.name)
    return AnalyzedMealItem(
        name=raw.name,
        brand=raw.brand,
        nutrition=_to_analyzed_nutrition(raw),
        confidence=raw.confidence,
        consistency=ConsistencyResult.model_validate(consistency),
        library_food=None if hit is None else _library_match(hit[0], hit[1], raw.serving_grams),
    )


@router.post("/analyze-meal", response_model=AnalyzeMealResponse)
async def analyze_meal(
    payload: AnalyzeRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
    make_estimator: EstimatorFactory = Depends(get_estimator_factory),
) -> AnalyzeMealResponse:
    """文字或照片 → 這一餐的每一樣食物（最多 8 樣）＋一句描述。算一次額度。"""
    if isinstance(payload, AnalyzeTextRequest):
        hit = await _find_in_food_library(db, user, payload.text)
        if hit is not None:
            # 整段文字就是一個食物的名稱：跟 /analyze 一樣不呼叫 LLM、不記一列、不扣次數。
            # 直接重用那邊組回應的函式——兩個端點對「命中食物庫」回的數字不會不一樣。
            food, revision = hit
            used_today = await _count_used_today(db, user)
            single = _library_hit_response(
                food, revision, remaining_today=_remaining(used_today)
            )
            return AnalyzeMealResponse(
                analysis_id=None,
                description=food.name,
                items=[
                    AnalyzedMealItem(
                        name=single.name,
                        brand=single.brand,
                        nutrition=single.nutrition,
                        confidence=single.confidence,
                        consistency=single.consistency,
                        library_food=_library_match(food, revision, _BASE_AMOUNT),
                    )
                ],
                remaining_today=single.remaining_today,
            )

    # 順序同 /analyze：先建實作（沒設定 → 503），再看額度。
    estimator = make_estimator()
    used_today = await _assert_quota_available(db, user)

    kind: AnalysisKind
    input_hash: str
    raw: RawMealEstimate
    if isinstance(payload, AnalyzeTextRequest):
        kind = AnalysisKind.TEXT
        input_hash = hashlib.sha256(payload.text.encode()).hexdigest()
        text = payload.text
        raw = await _call_estimator_or_record_failure(
            db,
            user_id=user.id,
            kind=kind,
            input_hash=input_hash,
            model=estimator.model,
            call=lambda: estimator.estimate_meal_text(text),
        )
    else:
        kind = AnalysisKind.IMAGE
        content, media_type = _decode_photo(payload.image_base64)
        input_hash = hashlib.sha256(content).hexdigest()
        raw = await _call_estimator_or_record_failure(
            db,
            user_id=user.id,
            kind=kind,
            input_hash=input_hash,
            model=estimator.model,
            call=lambda: estimator.estimate_meal_image(content, media_type),
        )

    # **一列**：一次呼叫就是一次計費，跟估出幾樣無關（規格 D7）。
    analysis = AiAnalysis(
        user_id=user.id,
        kind=kind,
        model=estimator.model,
        input_hash=input_hash,
        succeeded=True,
    )
    db.add(analysis)
    await db.commit()
    await db.refresh(analysis)

    items = [await _to_meal_item(db, user, item) for item in raw.items]
    return AnalyzeMealResponse(
        analysis_id=analysis.id,
        description=raw.description,
        items=items,
        remaining_today=_remaining(used_today + 1),
    )
