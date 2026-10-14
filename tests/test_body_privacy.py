"""身體資料是健康資料（身體資料規格 §7）：不進任何好友或社群的回應、只有身體資料的模組
碰得到那兩張表、那幾個模組不寫 log。掃的是型別與原始碼——端點測試只看得到「這一次的回應
沒有」，看不到「某天有人把它加進白名單」。"""

import re

import app.schemas.friend as friend_schemas
import app.schemas.social as social_schemas
from tests.privacy_helpers import APP, SOCIAL_MODULES, models_reachable_from, names_defined_in

HEALTH_WORDS = ("weight", "height", "birth", "sex", "activity", "goal", "profile")


def test_no_friend_or_social_response_has_a_health_field():
    models = models_reachable_from(friend_schemas) | models_reachable_from(social_schemas)
    assert len(models) >= 20  # 掃到東西了：寫計畫時兩個模組頂層就有 22 個模型（含 import 進來的）
    offenders = sorted(
        f"{model.__name__}.{name}"
        for model in models
        for name in model.model_fields
        if any(word in name.lower() for word in HEALTH_WORDS)
    )
    assert offenders == []


BODY_MODULES = {
    APP / "models" / "body.py",
    APP / "models" / "__init__.py",
    APP / "body_targets.py",
    APP / "body_data.py",
    APP / "schemas" / "body.py",
    APP / "api" / "routes" / "body.py",
    APP / "api" / "routes" / "weights.py",
    APP / "export.py",
}


def test_only_the_body_modules_touch_the_health_tables():
    """`routes/targets.py` 只准呼叫 `clear_applied_weight`，不准自己碰那張表。"""
    words = re.compile(r"\bUserProfile\b|\bWeightEntry\b|\buser_profiles\b|\bweight_entries\b")
    offenders = sorted(
        str(path.relative_to(APP))
        for path in APP.rglob("*.py")
        if path not in BODY_MODULES and words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []


def test_the_body_modules_do_not_log():
    """`export.py` 例外：它不在這個集合裡要掃的範圍（它本來就沒有 logger；如果之後有，
    也只會記匯出的事件）。"""
    log_words = re.compile(r"\blogging\b|\blogger\b|\bprint\(")
    offenders = sorted(
        str(path.relative_to(APP))
        for path in BODY_MODULES - {APP / "export.py", APP / "models" / "__init__.py"}
        if log_words.search(path.read_text(encoding="utf-8"))
    )
    assert offenders == []


# 好友與社群的模組（`SOCIAL_MODULES`）：檔名帶 friend／social／notification 的都算。
# 間接的路（審查 M3）：上一條只認表名與模型名，好友的模組 `from app.body_data import
# latest_weight` 一樣拿得到體重，那一條卻是綠的。這裡擋的是「碰到身體資料的模組」本身。
BODY_MODULE_REFERENCES = (
    r"\bbody_data\b",
    r"\bbody_targets\b",
    r"\bschemas\.body\b",
    r"\bmodels\.body\b",
    r"\broutes\.(?:body|weights)\b",
    r"\bfrom\s+app(?:\.schemas|\.models|\.api\.routes)?\s+import\s[^\n]*\b(?:body|weights)\b",
)


def _names_defined_in(module_name: str) -> set[str]:
    """模組自己定義的函式與類別（不含 import 進來的）。`round_half_up` 是通用的四捨五入，
    不是身體資料；真的從 `app.body_targets` import 它，上面的模組名稱照樣擋得到。"""
    return names_defined_in(module_name) - {"round_half_up"}


def test_the_friend_and_social_modules_do_not_reach_the_body_modules():
    names = (
        _names_defined_in("app.body_data")
        | _names_defined_in("app.body_targets")
        | _names_defined_in("app.schemas.body")
    )
    # 掃到東西了：寫這條的時候 body_data 有四個函式（load_profile、latest_weight……）。
    assert {"load_profile", "latest_weight", "inputs_from", "clear_applied_weight"} <= names
    assert {"suggest", "BodyInputs", "SuggestionReady", "WeightListResponse"} <= names
    assert len(SOCIAL_MODULES) >= 10
    words = re.compile(
        "|".join((*BODY_MODULE_REFERENCES, *(rf"\b{re.escape(name)}\b" for name in names)))
    )
    offenders = sorted(
        f"{path.relative_to(APP)}: {match.group(0)}"
        for path in SOCIAL_MODULES
        for match in [words.search(path.read_text(encoding="utf-8"))]
        if match is not None
    )
    assert offenders == []
