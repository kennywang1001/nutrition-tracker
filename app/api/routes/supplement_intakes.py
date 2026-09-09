"""打卡 / 臨時記錄補劑攝取 —— 決定 3 的快照落地之處（陷阱 1 的第三次出現）。

四個營養素欄位在這裡、也只在這裡算好寫死
（`kcal_total = supplement.kcal * dose`，決定 1，見 `app/nutrition.py` 的
`scale_supplement`）。之後補劑主檔被改，這裡已經寫入的列不會跟著變 ——
4b 的統計因此是單純的 `SUM`，不需要在統計查詢裡再乘一次。
"""

from fastapi import APIRouter, Depends, status
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import get_current_user
from app.api.routes.supplement_plans import _load_owned_plan
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.supplement import SupplementIntake
from app.models.user import User
from app.nutrition import scale_supplement
from app.schemas.supplement import SupplementIntakeCreateRequest, SupplementIntakeResponse
from app.supplement_visibility import assert_supplement_visible

router = APIRouter(prefix="/supplement-intakes", tags=["supplement-intakes"])


def _to_response(intake: SupplementIntake) -> SupplementIntakeResponse:
    return SupplementIntakeResponse(
        id=intake.id,
        supplement_id=intake.supplement_id,
        plan_id=intake.plan_id,
        dose=intake.dose,
        taken_at=intake.taken_at,
        kcal=intake.kcal,
        protein_g=intake.protein_g,
        fat_g=intake.fat_g,
        carb_g=intake.carb_g,
    )


@router.post("", status_code=status.HTTP_201_CREATED, response_model=SupplementIntakeResponse)
async def create_intake(
    payload: SupplementIntakeCreateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> SupplementIntakeResponse:
    # 看不到的補劑一律 404（繼承規矩第 1 條），跟 supplement_plans 的建立
    # 用同一套可見性邏輯（`app/supplement_visibility.py`，第二個呼叫者）。
    supplement = await assert_supplement_visible(db, payload.supplement_id, user)

    if payload.plan_id is not None:
        # 重用 supplement_plans 的擁有權檢查（同一個函式，同一條規則）：
        # 不存在或不是自己的計畫一律 404。
        plan = await _load_owned_plan(db, payload.plan_id, user)
        if plan.supplement_id != supplement.id:
            # 看得到、也是自己的，但引用的是別的補劑 —— 這是業務規則違反，
            # 不是「看不到」，所以是 422 不是 404
            # （同 app/api/routes/meals.py 的 PORTION_FOOD_MISMATCH）。
            raise UnprocessableEntityError(
                "PLAN_SUPPLEMENT_MISMATCH", "這筆計畫不屬於指定的補劑"
            )

    # 決定 1 + 決定 3 唯一落地的地方：算好就寫死，之後補劑主檔被改也不會
    # 連動（見 app/nutrition.py 的 scale_supplement）。
    macros = scale_supplement(supplement, payload.dose)

    intake = SupplementIntake(
        user_id=user.id,
        supplement_id=supplement.id,
        plan_id=payload.plan_id,
        dose=payload.dose,
        taken_at=payload.taken_at,
        kcal=macros.kcal,
        protein_g=macros.protein_g,
        fat_g=macros.fat_g,
        carb_g=macros.carb_g,
    )
    db.add(intake)
    await db.commit()
    await db.refresh(intake)
    return _to_response(intake)
