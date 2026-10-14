"""運動的活動清單與熱量估算（運動規格 §3、§4）。純函式與常數，不碰資料庫。

活動代碼只寫在這裡：模型的 CHECK 從 `ActivityCode` 產生，前端從 `GET /api/exercise/activities` 拿。
**新增一個活動要一個 migration**（CHECK 的文字 `alembic check` 不比，
`tests/test_exercise_model.py` 比）。"""

import enum
from dataclasses import dataclass
from decimal import ROUND_HALF_UP, Decimal


class ActivityCode(enum.StrEnum):
    WALKING = "walking"
    BRISK_WALKING = "brisk_walking"
    JOGGING = "jogging"
    RUNNING = "running"
    CYCLING = "cycling"
    SPINNING = "spinning"
    SWIMMING = "swimming"
    WEIGHT_TRAINING = "weight_training"
    WEIGHT_TRAINING_VIGOROUS = "weight_training_vigorous"
    YOGA = "yoga"
    PILATES = "pilates"
    HIIT = "hiit"
    HIKING = "hiking"
    STAIR_CLIMBING = "stair_climbing"
    BASKETBALL = "basketball"
    BADMINTON = "badminton"
    TABLE_TENNIS = "table_tennis"
    JUMP_ROPE = "jump_rope"
    OTHER = "other"


class KcalSource(enum.StrEnum):
    ESTIMATED = "estimated"
    MANUAL = "manual"


# 一筆運動的熱量上限（D5）；估算超過它是 422，不夾（D9）。
MAX_KCAL = Decimal(5000)
_WHOLE = Decimal(1)
_MINUTES_PER_HOUR = Decimal(60)


@dataclass(frozen=True)
class Activity:
    code: ActivityCode
    label: str
    # Compendium of Physical Activities 的近似值（規格 §3）。「其他」沒有 MET，只能手動輸入熱量。
    met: Decimal | None


# 順序就是選單的順序。MET 一律用字串建 Decimal——Decimal(9.8) 是 9.800000000000000710…
# 跳繩是 Compendium 2011 的 15552「moderate pace, 100–120 skips/min」＝11.8（規格原本寫 11.0，
# Compendium 裡沒有這個值；見計畫「執行中發現的差異」）。
ACTIVITIES: tuple[Activity, ...] = (
    Activity(ActivityCode.WALKING, "走路", Decimal("3.5")),
    Activity(ActivityCode.BRISK_WALKING, "快走", Decimal("4.3")),
    Activity(ActivityCode.JOGGING, "慢跑", Decimal("7.0")),
    Activity(ActivityCode.RUNNING, "跑步（約 10 km/h）", Decimal("9.8")),
    Activity(ActivityCode.CYCLING, "騎腳踏車", Decimal("7.5")),
    Activity(ActivityCode.SPINNING, "飛輪", Decimal("8.5")),
    Activity(ActivityCode.SWIMMING, "游泳", Decimal("6.0")),
    Activity(ActivityCode.WEIGHT_TRAINING, "重量訓練（一般）", Decimal("3.5")),
    Activity(ActivityCode.WEIGHT_TRAINING_VIGOROUS, "重量訓練（高強度）", Decimal("6.0")),
    Activity(ActivityCode.YOGA, "瑜伽", Decimal("2.5")),
    Activity(ActivityCode.PILATES, "皮拉提斯", Decimal("3.0")),
    Activity(ActivityCode.HIIT, "HIIT", Decimal("8.0")),
    Activity(ActivityCode.HIKING, "爬山", Decimal("6.0")),
    Activity(ActivityCode.STAIR_CLIMBING, "爬樓梯", Decimal("8.8")),
    Activity(ActivityCode.BASKETBALL, "籃球", Decimal("6.5")),
    Activity(ActivityCode.BADMINTON, "羽球", Decimal("5.5")),
    Activity(ActivityCode.TABLE_TENNIS, "桌球", Decimal("4.0")),
    Activity(ActivityCode.JUMP_ROPE, "跳繩", Decimal("11.8")),
    Activity(ActivityCode.OTHER, "其他", None),
)
ACTIVITY_BY_CODE: dict[ActivityCode, Activity] = {a.code: a for a in ACTIVITIES}


def estimate_kcal(met: Decimal, weight_kg: Decimal, minutes: int) -> Decimal:
    """kcal = MET × 體重 × 小時，四捨五入（HALF_UP）到整數（D6）。不檢查上限（D9 在端點）。

    MET 本身只有兩三位有效數字，小數點後沒有意義；整數也讓畫面上的數字跟手算一致。"""
    raw = met * weight_kg * Decimal(minutes) / _MINUTES_PER_HOUR
    return raw.quantize(_WHOLE, rounding=ROUND_HALF_UP)


def label_for(activity: ActivityCode, name: str | None) -> str:
    """畫面上的名字（D20）：固定活動是中文標籤，「其他」是使用者取的名稱。"""
    if activity is ActivityCode.OTHER:
        return name or ACTIVITY_BY_CODE[ActivityCode.OTHER].label
    return ACTIVITY_BY_CODE[activity].label


def kcal_budget(
    target_kcal: Decimal | None, exercise_kcal: Decimal, adds_exercise: bool
) -> Decimal | None:
    """今天的熱量額度（D15）：沒有熱量目標就沒有額度（不是「額度＝運動消耗」）；
    設定關掉時是目標本身。只動熱量，三大營養素不動（D12）。"""
    if target_kcal is None:
        return None
    return target_kcal + exercise_kcal if adds_exercise else target_kcal
