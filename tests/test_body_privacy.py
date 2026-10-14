"""身體資料是健康資料（身體資料規格 §7）：不進任何好友或社群的回應、只有身體資料的模組
碰得到那兩張表、那幾個模組不寫 log。掃的是型別與原始碼——端點測試只看得到「這一次的回應
沒有」，看不到「某天有人把它加進白名單」。"""

import re
from pathlib import Path

from pydantic import BaseModel

import app.schemas.friend as friend_schemas
import app.schemas.social as social_schemas

APP = Path(__file__).resolve().parent.parent / "app"
HEALTH_WORDS = ("weight", "height", "birth", "sex", "activity", "goal", "profile")


def _models_reachable_from(module) -> set[type[BaseModel]]:
    """模組裡每個 BaseModel，連同欄位型別裡巢狀的（list[X]、X | None）。"""
    seen: set[type[BaseModel]] = set()
    stack = [
        value
        for value in vars(module).values()
        if isinstance(value, type) and issubclass(value, BaseModel) and value is not BaseModel
    ]
    while stack:
        model = stack.pop()
        if model in seen:
            continue
        seen.add(model)
        for field in model.model_fields.values():
            for inner in _types_in(field.annotation):
                if isinstance(inner, type) and issubclass(inner, BaseModel):
                    stack.append(inner)
    return seen


def _types_in(annotation) -> list:
    args = getattr(annotation, "__args__", None)
    if not args:
        return [annotation]
    return [inner for arg in args for inner in _types_in(arg)]


def test_no_friend_or_social_response_has_a_health_field():
    models = _models_reachable_from(friend_schemas) | _models_reachable_from(social_schemas)
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
