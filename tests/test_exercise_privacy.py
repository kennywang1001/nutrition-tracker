"""運動只有自己看得到（運動規格 §8）：不進任何好友或社群的回應、只有運動的模組碰得到那張表、
那幾個模組不寫 log、好友與社群的模組（直接或間接）碰不到運動的模組。掃的是型別與原始碼——
端點測試只看得到「這一次的回應沒有」，看不到「某天有人把它加進白名單」。"""

import re

import app.schemas.friend as friend_schemas
import app.schemas.social as social_schemas
from tests.privacy_helpers import (
    APP,
    SOCIAL_MODULES,
    app_import_closure,
    models_reachable_from,
    module_file,
    module_name_of,
    top_level_names_in,
)

# `minutes`、`kcal_source` 是運動才有的欄位名；`budget` 是額度與那個設定。
EXERCISE_WORDS = ("exercise", "minutes", "kcal_source", "budget")

EXERCISE_MODULE_NAMES = (
    "app.exercise",
    "app.exercise_data",
    "app.schemas.exercise",
    "app.models.exercise",
    "app.api.routes.exercises",
)


def test_no_friend_or_social_response_has_an_exercise_field():
    models = models_reachable_from(friend_schemas) | models_reachable_from(social_schemas)
    assert len(models) >= 20  # 掃到東西了（同身體資料的那一條）
    offenders = sorted(
        f"{model.__name__}.{name}"
        for model in models
        for name in model.model_fields
        if any(word in name.lower() for word in EXERCISE_WORDS)
    )
    assert offenders == []


# 碰得到 exercise_entries 這張表的模組。`stats.py` 不在裡面：它只呼叫 `exercise_kcal_on`。
EXERCISE_TABLE_MODULES = {
    APP / "models" / "exercise.py",
    APP / "models" / "__init__.py",
    APP / "exercise_data.py",
    APP / "api" / "routes" / "exercises.py",
    APP / "export.py",
}


def test_only_the_exercise_modules_touch_the_exercise_table():
    words = re.compile(r"\bExerciseEntry\b|\bexercise_entries\b")
    offenders = sorted(
        str(path.relative_to(APP))
        for path in APP.rglob("*.py")
        if path not in EXERCISE_TABLE_MODULES and words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []


def test_the_exercise_modules_do_not_log():
    log_words = re.compile(r"\blogging\b|\blogger\b|\bprint\(")
    paths = [module_file(name) for name in EXERCISE_MODULE_NAMES]
    assert all(path is not None for path in paths)
    offenders = sorted(
        str(path.relative_to(APP))
        for path in paths
        if path is not None and log_words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []


# 直接提到運動模組的寫法（同身體資料審查 M3）：模組名稱本身，或 `from app.x import exercises`。
EXERCISE_MODULE_REFERENCES = (
    r"\bapp\.exercise\b",
    r"\bexercise_data\b",
    r"\bschemas\.exercise\b",
    r"\bmodels\.exercise\b",
    r"\broutes\.exercises\b",
    r"\bfrom\s+app(?:\.schemas|\.models|\.api\.routes)?\s+import\s[^\n]*\bexercises?\b",
)


def _exercise_names() -> set[str]:
    """運動模組在頂層定義的公開名字：函式、類別，還有常數（`ACTIVITIES`、`MAX_KCAL`）。
    `router` 每個路由模組都有，不算（`routes.exercises` 本身上面的模組名稱擋得到）。"""
    names: set[str] = set()
    for module_name in EXERCISE_MODULE_NAMES:
        names |= top_level_names_in(module_name)
    return names - {"router"}


def test_the_friend_and_social_modules_do_not_mention_the_exercise_modules():
    names = _exercise_names()
    # 掃到東西了：函式、類別、常數都在。
    assert {"estimate_for", "exercise_kcal_on", "label_for", "kcal_budget"} <= names
    assert {"ExerciseEntry", "ExerciseResponse", "ActivityCode", "Estimate"} <= names
    assert {"ACTIVITIES", "MAX_KCAL", "FUTURE_TOLERANCE"} <= names
    assert len(SOCIAL_MODULES) >= 10
    words = re.compile(
        "|".join((*EXERCISE_MODULE_REFERENCES, *(rf"\b{re.escape(name)}\b" for name in names)))
    )
    offenders = sorted(
        f"{path.relative_to(APP)}: {match.group(0)}"
        for path in SOCIAL_MODULES
        for match in [words.search(path.read_text(encoding="utf-8"))]
        if match is not None
    )
    assert offenders == []


def test_the_friend_and_social_modules_cannot_reach_the_exercise_modules_indirectly():
    """上一條只看好友與社群模組**自己**的原始碼：它們 import 的某個共用模組（例如
    `app.meal_reads`）哪天 import 了 `app.exercise_data`，好友的回應就拿得到運動，上一條卻是綠的。
    這一條沿著 import 一路走下去。

    `app.models` 這個總表不往下走：它為了 Alembic import 每一個模型（包括 `ExerciseEntry`），
    經過它的話每個模組都「碰得到」每張表。直接 `from app.models.exercise import …` 照樣擋得到。"""
    roots = [module_name_of(path) for path in SOCIAL_MODULES]
    reachable = app_import_closure(roots, stop_at={"app.models"})
    # 掃到東西了：好友的模組會走到共用的讀取與模型。
    assert {"app.meal_reads", "app.models.meal", "app.models.user"} <= reachable
    assert sorted(reachable & set(EXERCISE_MODULE_NAMES)) == []
