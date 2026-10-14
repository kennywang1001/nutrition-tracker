"""隱私掃描共用的小函式（`test_body_privacy.py`、`test_exercise_privacy.py`）。

放在這裡而不是從另一個測試檔 import：從測試檔 import 會讓那個檔案的測試在 import 它的
檔案裡多跑一份（handover §7）。這個檔名不是 `test_` 開頭，pytest 不收。"""

import ast
import importlib
from pathlib import Path

from pydantic import BaseModel

APP = Path(__file__).resolve().parent.parent / "app"

# 好友與社群的模組：檔名帶 friend／social／notification 的都算（之後新增的也掃得到）。
SOCIAL_MODULES = sorted(
    path
    for path in APP.rglob("*.py")
    if any(word in path.name for word in ("friend", "social", "notification"))
)


def models_reachable_from(module) -> set[type[BaseModel]]:
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


def names_defined_in(module_name: str) -> set[str]:
    """模組自己定義的函式與類別（不含 import 進來的）。"""
    module = importlib.import_module(module_name)
    return {
        name
        for name, value in vars(module).items()
        if not name.startswith("_") and getattr(value, "__module__", None) == module_name
    }


def top_level_names_in(module_name: str) -> set[str]:
    """模組在頂層寫出來的公開名字：函式、類別，**還有常數**（`ACTIVITIES` 這種 tuple、
    `MAX_KCAL` 這種 Decimal 沒有 `__module__`，`names_defined_in` 看不到）。讀的是原始碼。"""
    path = module_file(module_name)
    assert path is not None, module_name
    names: set[str] = set()
    for node in ast.parse(path.read_text(encoding="utf-8")).body:
        if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef | ast.ClassDef):
            names.add(node.name)
        elif isinstance(node, ast.Assign):
            names |= {target.id for target in node.targets if isinstance(target, ast.Name)}
        elif isinstance(node, ast.AnnAssign) and isinstance(node.target, ast.Name):
            names.add(node.target.id)
    return {name for name in names if not name.startswith("_")}


def module_file(module_name: str) -> Path | None:
    base = APP.parent.joinpath(*module_name.split("."))
    if base.with_suffix(".py").is_file():
        return base.with_suffix(".py")
    if (base / "__init__.py").is_file():
        return base / "__init__.py"
    return None


def module_name_of(path: Path) -> str:
    return ".".join(path.relative_to(APP.parent).with_suffix("").parts)


def _in_app(module_name: str) -> bool:
    return module_name.split(".")[0] == "app"


def app_imports_of(module_name: str) -> set[str]:
    """這個模組的原始碼 import 了哪些 `app.*` 模組（`from app.x import y` 的 y 是模組就算
    `app.x.y`，否則算 `app.x`）。函式裡面的 import 也算。"""
    path = module_file(module_name)
    assert path is not None, module_name
    found: set[str] = set()
    for node in ast.walk(ast.parse(path.read_text(encoding="utf-8"))):
        if isinstance(node, ast.Import):
            found |= {alias.name for alias in node.names if _in_app(alias.name)}
        elif isinstance(node, ast.ImportFrom) and node.module and _in_app(node.module):
            for alias in node.names:
                submodule = f"{node.module}.{alias.name}"
                found.add(submodule if module_file(submodule) else node.module)
    return found


def app_import_closure(roots: list[str], *, stop_at: set[str]) -> set[str]:
    """從 `roots` 出發、沿著 import 走得到的每一個 `app.*` 模組。`stop_at` 裡的模組算進去
    但不往下走（例如 `app.models` 這個總表：它為了 Alembic import 每一個模型，經過它的話
    每個模組都「碰得到」每張表，這條路沒有鑑別力）。"""
    seen: set[str] = set()
    stack = list(roots)
    while stack:
        name = stack.pop()
        if name in seen:
            continue
        seen.add(name)
        if name not in stop_at:
            stack.extend(app_imports_of(name))
    return seen
