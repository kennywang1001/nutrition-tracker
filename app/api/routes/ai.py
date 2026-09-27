"""`POST /api/ai/analyze` —— 文字或圖片進去，一份的營養素估算加上一致性檢查
出來，而且不落庫（規格 §1.3、§4）。

流程（規格 §3）：

    ① 先搜自己看得到的食物庫（DB 查詢，不呼叫 LLM）—— 找到就直接回，
       不計入每日上限，也不寫 ai_analyses
    ② 檢查今日額度（數 ai_analyses 今天的列數）
    ③ 呼叫 LLM。不管成功失敗都寫一列 ai_analyses —— 兩種都花了錢
    ④ 純函式一致性檢查（app/ai/consistency.py）
    ⑤ 回傳估算值 + 一致性結果 + analysis_id，到這裡為止沒有寫入任何食物
"""

import base64
import binascii
import hashlib
import io
from collections.abc import Awaitable, Callable
from datetime import UTC, datetime
from decimal import ROUND_HALF_UP, Decimal

from fastapi import APIRouter, Depends
from PIL import Image
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.ai.consistency import check_consistency
from app.ai.estimator import NutritionEstimator, RawEstimate
from app.api.deps import get_current_user, get_estimator
from app.api.routes.meals import MAX_PHOTO_BYTES
from app.config import settings
from app.days import day_bounds, today_in_timezone
from app.db import get_db
from app.errors import PayloadTooLargeError, TooManyRequestsError, UnprocessableEntityError
from app.models.ai_analysis import AiAnalysis, AnalysisKind
from app.models.food import BaseUnit, Food, FoodRevision
from app.models.user import User
from app.schemas.ai import (
    AnalyzedNutrition,
    AnalyzeRequest,
    AnalyzeResponse,
    AnalyzeTextRequest,
    ConsistencyResult,
)
from app.storage.photos import MAX_IMAGE_PIXELS

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
    會自然提升。

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
                Food.name.ilike(text.strip()),
            )
            .limit(1)
        )
    ).first()
    return None if row is None else (row[0], row[1])


def _library_hit_response(food: Food, revision: FoodRevision) -> AnalyzeResponse:
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
    )


async def _assert_quota_available(db: AsyncSession, user: User) -> None:
    """規格 §7.2：額度直接數 `ai_analyses` 今天的列數，不另設計數器。

    「今天」用 `day_bounds(today_in_timezone(user.timezone), user.timezone)`
    ——跟 `stats/daily`、`meals`、`supplements/today` 同一個「今天」
    （P1 陷阱 1），不是 `date.today()`。

    **比較必須是 `>=`，不是 `>`。** 上限 20 代表最多存在 20 列，第 21 次
    呼叫發生時 `used_today` 已經是 20，`20 >= 20` 才會擋下來；`>` 會讓
    第 21 次還被放行，差一錯誤（計畫 Task 5 突變驗證（三））。
    """
    start, end = day_bounds(today_in_timezone(user.timezone), user.timezone)
    used_today = (
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
    if used_today >= settings.ai_daily_limit:
        retry_after_seconds = max(1.0, (end - datetime.now(UTC)).total_seconds())
        raise TooManyRequestsError(
            "AI_DAILY_LIMIT",
            f"今天用了 {used_today}/{settings.ai_daily_limit} 次，請明天再試",
            retry_after_seconds,
        )


async def _call_estimator_or_record_failure(
    db: AsyncSession,
    *,
    user_id: int,
    kind: AnalysisKind,
    input_hash: str,
    call: Callable[[], Awaitable[RawEstimate]],
) -> RawEstimate:
    """呼叫 LLM；不管成功或失敗都要在 `ai_analyses` 留一列（規格 §7：
    兩種都花了錢）。

    失敗時的處理照抄 `app/security/sessions.py` 的 `_reject()`：**必須在
    例外離開這個函式之前 commit**——例外一旦真的往外拋，FastAPI 的路由
    函式就不會執行到後面幫這個 session commit 的那一行，少了這裡的
    commit，失敗那一列會跟著例外一起被外層的交易（測試是 db_session
    fixture 的最外層 rollback，production 是 get_db 那個 per-request
    session 沒有 commit 就直接 close）一起丟掉，於是「LLM 一直失敗」
    會變成一個不花錢的無限迴圈，而它其實每次都在計費。
    """
    try:
        return await call()
    except Exception:
        db.add(
            AiAnalysis(
                user_id=user_id,
                kind=kind,
                model=settings.ai_model,
                input_hash=input_hash,
                succeeded=False,
            )
        )
        await db.commit()
        raise


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
    estimator: NutritionEstimator = Depends(get_estimator),
) -> AnalyzeResponse:
    if isinstance(payload, AnalyzeTextRequest):
        hit = await _find_in_food_library(db, user, payload.text)
        if hit is not None:
            food, revision = hit
            return _library_hit_response(food, revision)

    await _assert_quota_available(db, user)

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
            call=lambda: estimator.estimate_image(content, media_type),
        )

    analysis = AiAnalysis(
        user_id=user.id,
        kind=kind,
        model=settings.ai_model,
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
        name=raw.name,
        brand=raw.brand,
        nutrition=_to_analyzed_nutrition(raw),
        confidence=raw.confidence,
        consistency=ConsistencyResult.model_validate(consistency),
    )
