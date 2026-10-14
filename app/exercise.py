"""運動的活動清單與熱量估算（運動規格 §3、§4）。純函式與常數，不碰資料庫。

活動代碼只寫在這裡：模型的 CHECK 從 `ActivityCode` 產生，前端從 `GET /api/exercise/activities` 拿。
**新增一個活動要一個 migration**（CHECK 的文字 `alembic check` 不比，
`tests/test_exercise_model.py` 比）。"""

import enum


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
