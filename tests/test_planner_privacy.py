"""營養素配餐只給本人（規格 §8）：讀資料、算剩下的、解題的模組不寫 log；好友與社群的模組
（直接或間接）碰不到它們。掃的是原始碼——端點測試只看得到「這一次的回應沒有」。"""

import re

from tests.privacy_helpers import (
    APP,
    SOCIAL_MODULES,
    app_import_closure,
    module_file,
    module_name_of,
    top_level_names_in,
)

PLANNER_MODULE_NAMES = (
    "app.planner",
    "app.planner_data",
    "app.day_budget",
    "app.api.routes.planner",
    "app.schemas.planner",
)


def test_the_planner_modules_do_not_log():
    log_words = re.compile(r"\blogging\b|\blogger\b|\bprint\(")
    paths = [module_file(name) for name in PLANNER_MODULE_NAMES]
    assert all(path is not None for path in paths)
    offenders = sorted(
        str(path.relative_to(APP))
        for path in paths
        if path is not None and log_words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []


# 直接提到配餐模組的寫法：模組名稱本身，或 `from app.x import planner`。
PLANNER_MODULE_REFERENCES = (
    r"\bplanner\b",
    r"\bplanner_data\b",
    r"\bday_budget\b",
)


def _planner_names() -> set[str]:
    """配餐模組在頂層定義的公開名字（`router` 每個路由模組都有，不算）。"""
    names: set[str] = set()
    for module_name in PLANNER_MODULE_NAMES:
        names |= top_level_names_in(module_name)
    return names - {"router"}


def test_the_friend_and_social_modules_do_not_mention_the_planner_modules():
    names = _planner_names()
    # 掃到東西了：函式、類別、常數都在。
    assert {"suggest_combos", "remaining_for", "load_candidates", "load_day_budget"} <= names
    assert {"Remaining", "Candidate", "DayBudget", "LibrarySuggestionsResponse"} <= names
    assert {"CANDIDATE_LIMIT", "FULL_BELOW_KCAL"} <= names
    assert len(SOCIAL_MODULES) >= 10
    words = re.compile(
        "|".join((*PLANNER_MODULE_REFERENCES, *(rf"\b{re.escape(name)}\b" for name in names)))
    )
    offenders = sorted(
        f"{path.relative_to(APP)}: {match.group(0)}"
        for path in SOCIAL_MODULES
        for match in [words.search(path.read_text(encoding="utf-8"))]
        if match is not None
    )
    assert offenders == []


def test_the_friend_and_social_modules_cannot_reach_the_planner_modules_indirectly():
    """同運動的那一條：沿著 import 一路走下去（`app.models` 總表不往下走）。"""
    roots = [module_name_of(path) for path in SOCIAL_MODULES]
    reachable = app_import_closure(roots, stop_at={"app.models"})
    assert {"app.meal_reads", "app.models.meal", "app.models.user"} <= reachable
    assert sorted(reachable & set(PLANNER_MODULE_NAMES)) == []
