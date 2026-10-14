"""身體資料與建議目標（身體資料規格 §5.1、§5.2）。只讀寫自己的：路徑上沒有使用者 id。

健康資料：這個模組不寫 log（`tests/test_body_privacy.py` 掃這個檔案，連註解都不能出現那幾個字）。"""

from decimal import Decimal

from fastapi import APIRouter, Depends
from sqlalchemy import func, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.routes.targets import TargetValues, target_response, write_target_from_today
from app.body_data import inputs_from, latest_weight, load_profile
from app.body_targets import RESUGGEST_THRESHOLD_KG, suggest
from app.days import today_in_timezone
from app.db import get_db
from app.errors import ConflictError, UnprocessableEntityError
from app.models.body import UserProfile
from app.models.user import User
from app.schemas.body import (
    ApplySuggestionRequest,
    BodyProfileRequest,
    BodyProfileResponse,
    SuggestionMissing,
    SuggestionReady,
)
from app.schemas.target import TargetResponse

router = APIRouter(tags=["body"])

# D4：出生年在「使用者的今年 − 100」到「今年 − 13」。
MAX_AGE = 100
MIN_AGE = 13
PROFILE_FIELDS = (
    "sex",
    "birth_year",
    "height_cm",
    "activity_level",
    "goal",
    "rate_kg_per_week",
    "target_weight_kg",
)


def _profile_response(profile: UserProfile | None) -> BodyProfileResponse:
    if profile is None:
        return BodyProfileResponse(**dict.fromkeys(PROFILE_FIELDS))
    return BodyProfileResponse(**{field: getattr(profile, field) for field in PROFILE_FIELDS})


@router.get("/me/body-profile", response_model=BodyProfileResponse)
async def read_body_profile(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> BodyProfileResponse:
    """自己的身體資料。還沒填過＝七個都是 null（200，不是 404）。"""
    return _profile_response(await load_profile(db, user.id))


@router.put("/me/body-profile", response_model=BodyProfileResponse)
async def save_body_profile(
    payload: BodyProfileRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> BodyProfileResponse:
    """整組取代自己的身體資料（D5）。`INSERT … ON CONFLICT DO UPDATE`：兩台裝置同時第一次存
    不會撞主鍵變 500。套用時的體重不在這裡改（`set_` 只有七個欄位）。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    if payload.birth_year is not None:
        earliest, latest = today.year - MAX_AGE, today.year - MIN_AGE
        if not earliest <= payload.birth_year <= latest:
            raise UnprocessableEntityError(
                "BIRTH_YEAR_OUT_OF_RANGE", f"出生年要在 {earliest} 到 {latest} 之間"
            )

    values = payload.model_dump()
    statement = (
        pg_insert(UserProfile)
        .values(user_id=user_id, **values)
        .on_conflict_do_update(
            index_elements=[UserProfile.user_id],
            # ON CONFLICT 不走 ORM 的 onupdate：updated_at 自己寫。
            set_={**values, "updated_at": func.now()},
        )
        .returning(*(getattr(UserProfile, field) for field in PROFILE_FIELDS))
    )
    row = (await db.execute(statement)).one()
    await db.commit()
    return BodyProfileResponse(**row._asdict())


@router.get("/me/target-suggestion", response_model=SuggestionReady | SuggestionMissing)
async def read_target_suggestion(
    user: User = Depends(get_current_user), db: AsyncSession = Depends(get_db)
) -> SuggestionReady | SuggestionMissing:
    """依身體資料與**日期最新**的體重算建議目標（規格 §3）；缺什麼就回缺什麼（D11）。

    `resuggest`：最新體重跟套用建議時的體重差 ≥ 1 公斤（D17）。從沒套用過、或之後手動改過
    目標（D16）時 `applied_weight_kg` 是 null，不提示。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    profile = await load_profile(db, user_id)
    latest = await latest_weight(db, user_id)
    result = suggest(inputs_from(profile, latest), today)
    if isinstance(result, list):
        return SuggestionMissing(ready=False, missing=result)
    assert latest is not None  # suggest 只有在有體重時才回建議

    applied = profile.targets_applied_weight_kg if profile is not None else None
    change: Decimal | None = None if applied is None else latest.weight_kg - applied
    return SuggestionReady(
        ready=True,
        kcal=result.kcal,
        protein_g=result.protein_g,
        fat_g=result.fat_g,
        carb_g=result.carb_g,
        bmr=result.bmr,
        tdee=result.tdee,
        adjustment_kcal=result.adjustment_kcal,
        floor_applied=result.floor_applied,
        floor_kcal=result.floor_kcal,
        weight_kg=latest.weight_kg,
        based_on_date=latest.date,
        applied_weight_kg=applied,
        weight_change_kg=change,
        resuggest=change is not None and abs(change) >= RESUGGEST_THRESHOLD_KG,
    )


@router.post("/me/target-suggestion/apply", response_model=TargetResponse)
async def apply_target_suggestion(
    payload: ApplySuggestionRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    """把建議存成今天起的目標（D15）。一個交易：重算 → 跟畫面上看到的比 → 寫目標 →
    記下這次用的體重。

    存的是**重算的**數字，不是請求裡的；請求的四個數字只用來確認使用者按下去的時候看到的
    就是會存的——另一個分頁剛記了體重、或畫面是離線快取裡的舊建議，就 409，什麼都不寫。"""
    user_id = user.id
    today = today_in_timezone(user.timezone)
    profile = await load_profile(db, user_id)
    latest = await latest_weight(db, user_id)
    result = suggest(inputs_from(profile, latest), today)
    if isinstance(result, list):
        raise UnprocessableEntityError(
            "PROFILE_INCOMPLETE", "身體資料或體重還沒填完", {"missing": result}
        )
    assert latest is not None  # suggest 只有在有體重時才回建議
    # 比 Decimal 的值（2110.00 == 2110），不是字串。
    shown = (payload.kcal, payload.protein_g, payload.fat_g, payload.carb_g)
    if shown != (result.kcal, result.protein_g, result.fat_g, result.carb_g):
        raise ConflictError("SUGGESTION_CHANGED", "建議目標剛剛變了，請看過新的數字再套用")

    weight_used = latest.weight_kg
    target = await write_target_from_today(
        db,
        user_id,
        today,
        TargetValues(
            kcal=result.kcal,
            protein_g=result.protein_g,
            fat_g=result.fat_g,
            # D9：碳水被擠到 0 時存「未設定」——0 的目標算不出比例。
            carb_g=None if result.carb_g == 0 else result.carb_g,
        ),
    )
    # 目標寫進去之後才記體重：撞期（409）時 write_target_from_today 已經整筆 rollback，
    # 走不到這裡，體重就不會被記成「套用過」。
    await db.execute(
        update(UserProfile)
        .where(UserProfile.user_id == user_id)
        .values(targets_applied_weight_kg=weight_used)
    )
    await db.commit()
    await db.refresh(target)
    return target_response(target)
