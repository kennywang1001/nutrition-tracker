# 小項目包 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 份量可以修改、刪除（已記的餐不受影響）；編輯歷史的日期好讀；趨勢圖有日期軸；報表清單的按鈕換新外觀。

**Architecture:** 後端加兩個份量端點，權限集中在一個 `_load_manageable_portion`。前端把食物詳情的一列份量抽成 `PortionRow` 元件（顯示、修改表單、刪除確認）。日期格式是 `lib/dates.ts` 的一個純函式。趨勢日期軸畫在 SVG 柱子區域下方多出的一條。報表按鈕只改 `Expenses.module.css`。

**Tech Stack:** FastAPI · Pydantic · SQLAlchemy async · React 19 · TypeScript strict · TanStack Query · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-06-small-items-design.md`

---

## 執行環境

- 分支 `feat/small-items`（規格 commit `770c6d6`）。
- 後端在 repo 根目錄：`./.venv/Scripts/python.exe -m pytest -q`、`… -m ruff check app tests`、`… -m mypy app`。測試資料庫 `wallet-db-1` 要 healthy。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`、`npm run -s test`。lint 抱怨格式時用 `npx biome check --write <檔案>`。e2e：`npx playwright test …`（會自己起 dev server；後端是本機 docker 的 `wallet-api-1`）。
- 基準線（master `1735e35`）：後端 662；前端 94 檔 886；e2e 26。
- **`schema.d.ts` 重新產生**（Windows 一定要 UTF-8）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"
  (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

- **Write/Edit；LF。不要在任何地方留備份檔或暫存腳本。** 突變後手動改回並重跑。
- Commit：`git commit -F <scratchpad 裡的檔案>`，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。不要 amend。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。預測的紅燈數對不上 → 照實回報是哪幾條。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. 先寫測試、看它紅，再寫實作。
4. Playwright 的 `getByLabel`／`getByRole` 名稱預設是子字串比對；換頁之後的第一個斷言要選只有新頁面才有的東西（handover §6 第 48、53 種）。
5. 斷言「沒有」之前，先證明畫面已經載入完成（第 41 種）。

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| 份量的端點只有 `GET`／`POST /api/foods/{food_id}/portions`；`create_portion` 用 `load_visible_food`、公開份量要管理員（`403 FORBIDDEN`）、新預設在同一個交易裡取消同擁有者的舊預設、`IntegrityError` → `409 PORTION_EXISTS`「你已經為這個食物建過同名的份量了」 | `app/api/routes/foods.py:355-430` |
| `FoodPortion`：`UniqueConstraint(food_id, owner_id, label, nulls_not_distinct)`、`CHECK grams > 0`；`meal_items.portion_id` 是 `ON DELETE SET NULL`；**沒有 ORM relationship** | `app/models/food.py:160-185`、`app/models/meal.py:85-89` |
| `load_visible_portion` 看不到 → `NotFoundError("PORTION_NOT_FOUND", "找不到該份量")` | `app/food_visibility.py:56-76` |
| `app/schemas/food.py` 目前沒有 import `model_validator` | 同檔 |
| 份量測試在 `tests/test_foods_portions.py`（`auth`、`create_food`、`create_portion(food, label, grams, owner, is_default)`、`create_user(role=…)`） | 同檔、`tests/factories.py` |
| 食物詳情的份量清單：`<li>{label}（{grams} {unit}）{預設的 ・<span class=tag>預設</span>}</li>`；`AddPortionForm` 的標籤是「份量名稱」「重量（{unit}）」「記一餐時預設用這個份量」；**`e2e/portions.spec.ts` 用 `getByText(/碗（150 g）/)` 找那一列** | `frontend/src/screens/FoodDetail.tsx:203-228` |
| `food-detail.test.tsx` 的 `PORTIONS` 只有一筆**公開**份量；`foodRoutes(food, revisions, portions, extra)` 把 `extra` 排在前面；編輯歷史的測試斷言原始字串 `getByText("2026-09-01T00:00:00Z")` | `frontend/tests/food-detail.test.tsx:96,132-153,388-400` |
| `lib/dates.ts` 只有 `formatTime`，開頭寫明「只做顯示格式化，不做日界線計算」 | `frontend/src/lib/dates.ts` |
| `TrendChart`：`VIEW_WIDTH = 280`、`VIEW_HEIGHT = 160`、`slot = VIEW_WIDTH / days.length`、柱子 `y = VIEW_HEIGHT - height`；`today` prop 已經有 | `frontend/src/components/TrendChart.tsx` |
| 報表清單的一列：`<li className={styles.row}>`，裡面「修改」→ `<form>`（「修改金額」輸入、「儲存」submit、「放棄」）；「刪除」→ `<div role="alertdialog">`（「確定刪除」「取消」）；`.row` 是 flex-wrap | `frontend/src/screens/Expenses.tsx:88-180` |
| e2e 記一筆帳的步驟（「新增紀錄」→「記帳」→ 鍵盤 → 分類 → 備註 → 「記一筆」） | `frontend/e2e/money-loop.spec.ts:26-38` |
| `e2e/touch-targets.ts` 有 `login`、`expectTouchTargets(locator, where)`（至少要有一個目標） | 同檔 |

## 與規格的差異

1. **介面上只能修改、刪除私人份量**（規格 §3.3 寫「或管理員看到的公開的」，但 §1.2 寫「管理員在介面上管理公開份量」不做——兩處矛盾，照 §1.2 收斂）。前端判斷是 `!portion.is_global`，不需要查 `/api/me`。管理員改公開份量走 API（後端照規格允許）。規格 §3.3 在 Task 6 一起改正。

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/schemas/food.py`（改） | `PortionUpdateRequest` |
| `app/api/routes/foods.py`（改） | `_portion_response`、`_load_manageable_portion`、`update_portion`、`delete_portion` |
| `tests/test_foods_portions.py`（改） | |
| `frontend/src/api/schema.d.ts`（重新產生） | |
| `frontend/src/components/PortionRow.tsx`（新） | 一列份量：顯示、修改、刪除 |
| `frontend/src/screens/FoodDetail.tsx`（改） | 用 `PortionRow`；日期用 `formatDateTime` |
| `frontend/src/lib/dates.ts`（改） | `formatDateTime` |
| `frontend/src/components/TrendChart.tsx`、`frontend/src/index.css`（改） | 日期軸 |
| `frontend/src/screens/Expenses.tsx`、`Expenses.module.css`（改） | 按鈕外觀 |
| `frontend/tests/food-detail.test.tsx`、`dates.test.ts`（新）、`trend-chart.test.tsx`、`frontend/e2e/touch-targets.spec.ts`（改） | |
| `docs/handover.md`、規格（改） | |

---

## Task 1：後端——份量的修改與刪除

**Files:** Modify `app/schemas/food.py`、`app/api/routes/foods.py`；Test `tests/test_foods_portions.py`；Regenerate `frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_portions.py` 檔尾加（imports 補上 `from sqlalchemy import select` 與 `from app.models.food import FoodPortion`）：

```python
async def _meal_with_portion(client, user, food, portion) -> int:
    """用這個份量記一份，回傳那一餐的 id。"""
    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-12-15T12:00:00+08:00",
            "meal_type": "lunch",
            "items": [{"food_id": food.id, "quantity": "1", "portion_id": portion.id}],
        },
    )
    assert response.status_code == 201
    return response.json()["id"]


async def test_owner_can_rename_a_portion_and_other_fields_stay(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}",
        headers=auth(user),
        json={"label": "大碗"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["label"] == "大碗"
    assert body["grams"] == "200.00"
    assert body["is_default"] is False


async def test_changing_grams_does_not_touch_meals_already_recorded(client, db_session):
    """凍結歷史（handover §4.3）：改的是之後要記的，不是已經記下的。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)
    meal_id = await _meal_with_portion(client, user, food, portion)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}",
        headers=auth(user),
        json={"grams": "300"},
    )
    assert patched.json()["grams"] == "300.00"

    meal = await client.get(f"/api/meals/{meal_id}", headers=auth(user))
    assert meal.json()["items"][0]["quantity_g"] == "200.00"


async def test_making_a_portion_default_unsets_only_the_same_owners_default(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)  # 全域食物
    public_default = await create_portion(
        db_session, food=food, label="公開碗", grams=150, owner=None, is_default=True
    )
    own_default = await create_portion(
        db_session, food=food, label="我的碗", grams=200, owner=user, is_default=True
    )
    other = await create_portion(db_session, food=food, label="我的盤", grams=300, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{other.id}",
        headers=auth(user),
        json={"is_default": True},
    )

    assert response.status_code == 200
    await db_session.refresh(own_default)
    await db_session.refresh(public_default)
    assert own_default.is_default is False
    assert public_default.is_default is True


async def test_deleting_a_portion_keeps_recorded_grams(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)
    meal_id = await _meal_with_portion(client, user, food, portion)

    response = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user)
    )

    assert response.status_code == 204
    item = (await client.get(f"/api/meals/{meal_id}", headers=auth(user))).json()["items"][0]
    assert item["portion_id"] is None
    assert item["quantity_g"] == "200.00"


async def test_someone_elses_private_portion_is_404_and_unchanged(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice)  # 全域食物：Bob 看得到食物本身
    portion = await create_portion(db_session, food=food, label="Alice 的碗", grams=200, owner=alice)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(bob), json={"grams": "1"}
    )
    deleted = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(bob)
    )

    assert patched.status_code == 404
    assert deleted.status_code == 404
    await db_session.refresh(portion)
    assert str(portion.grams) == "200.00"


async def test_a_normal_user_cannot_change_or_delete_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=admin)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=None)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user), json={"grams": "1"}
    )
    deleted = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user)
    )

    assert patched.status_code == 403
    assert deleted.status_code == 403


async def test_an_admin_can_change_and_delete_a_global_portion(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    food = await create_food(db_session, created_by=admin)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=None)

    patched = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(admin), json={"grams": "250"}
    )
    deleted = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(admin)
    )

    assert patched.status_code == 200
    assert deleted.status_code == 204


async def test_a_portion_of_another_food_in_the_path_is_404(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    other_food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=other_food, label="碗", grams=200, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user), json={"grams": "1"}
    )

    assert response.status_code == 404


async def test_renaming_to_an_existing_label_is_409(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    await create_portion(db_session, food=food, label="碗", grams=200, owner=user)
    plate = await create_portion(db_session, food=food, label="盤", grams=300, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{plate.id}", headers=auth(user), json={"label": "碗"}
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "PORTION_EXISTS"


async def test_explicit_null_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=user)

    response = await client.patch(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(user), json={"grams": None}
    )

    assert response.status_code == 422


async def test_a_portion_on_an_invisible_food_is_404(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)  # Alice 的私人食物
    portion = await create_portion(db_session, food=food, label="碗", grams=200, owner=alice)

    response = await client.delete(
        f"/api/foods/{food.id}/portions/{portion.id}", headers=auth(bob)
    )

    assert response.status_code == 404
    assert await db_session.scalar(select(FoodPortion).where(FoodPortion.id == portion.id))
```

> `create_food(created_by=…)` 不給 `owner` 是全域食物；`create_portion(owner=None)` 是公開份量——以 `tests/factories.py` 現況為準。

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_foods_portions.py -q
```

Expected：新的 11 條 FAIL（405 Method Not Allowed）；既有的 PASS。

- [ ] **Step 3: 實作**

`app/schemas/food.py`：`from pydantic import BaseModel, ConfigDict, Field` 加上 `model_validator`；`PortionCreateRequest` 之後加：

```python
class PortionUpdateRequest(BaseModel):
    """`PATCH /api/foods/{food_id}/portions/{portion_id}`（小項目包規格 §3.1）。

    `exclude_unset`：不帶＝不動。限制同 `PortionCreateRequest`。三個欄位都是
    NOT NULL——顯式 `null` 擋在這裡（不擋會一路流到 asyncpg 變成 500，
    跟 `MealUpdateRequest` 同一個坑）。
    """

    label: str | None = Field(default=None, min_length=1, max_length=50)
    grams: Decimal | None = Field(
        default=None, gt=0, le=10000, max_digits=8, decimal_places=2
    )
    is_default: bool | None = None

    @model_validator(mode="after")
    def _reject_explicit_null(self) -> "PortionUpdateRequest":
        for name in ("label", "grams", "is_default"):
            if name in self.model_fields_set and getattr(self, name) is None:
                raise ValueError(f"{name} 可以省略，但不接受 null")
        return self
```

`app/api/routes/foods.py`：

1. `from app.errors import ConflictError, ForbiddenError` 改成 `from app.errors import ConflictError, ForbiddenError, NotFoundError`；schema imports 加 `PortionUpdateRequest`。
2. 在 `list_portions` 之前加：

```python
def _portion_response(portion: FoodPortion) -> PortionResponse:
    return PortionResponse(
        id=portion.id,
        label=portion.label,
        grams=portion.grams,
        is_default=portion.is_default,
        is_global=portion.owner_id is None,
    )


async def _load_manageable_portion(
    db: AsyncSession, food_id: int, portion_id: int, user: User
) -> FoodPortion:
    """修改、刪除份量的權限（小項目包規格 §3.1）：

    - 食物要看得到（`load_visible_food`，看不到 → 404）
    - 份量要屬於路徑上的食物、而且是自己的或公開的——別人的私人份量 → 404
      （不透露存在，handover §4.7）
    - 公開份量只有管理員能動 → 一般使用者 403（同「新增公開份量」：看得到但不能動）
    """
    food, _ = await load_visible_food(db, food_id, user)
    portion = await db.scalar(
        select(FoodPortion).where(
            FoodPortion.id == portion_id,
            FoodPortion.food_id == food.id,
            or_(FoodPortion.owner_id.is_(None), FoodPortion.owner_id == user.id),
        )
    )
    if portion is None:
        raise NotFoundError("PORTION_NOT_FOUND", "找不到該份量")
    if portion.owner_id is None and user.role is not UserRole.ADMIN:
        raise ForbiddenError("FORBIDDEN", "只有管理員能修改或刪除全域份量")
    return portion
```

3. `list_portions` 與 `create_portion` 的回傳改用 `_portion_response(...)`（行為不變）。
4. 在 `create_portion` 之後加：

```python
@router.patch("/{food_id}/portions/{portion_id}", response_model=PortionResponse)
async def update_portion(
    food_id: ResourceId,
    portion_id: ResourceId,
    payload: PortionUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> PortionResponse:
    """改份量的名稱、重量或是否預設。

    **已經記下的餐不受影響**——`meal_items.quantity_g` 在寫入時算好、讀取不重算
    （handover §4.3）。改重量只影響之後新記的餐。
    """
    portion = await _load_manageable_portion(db, food_id, portion_id, user)
    changes = payload.model_dump(exclude_unset=True)

    if changes.get("is_default") is True:
        # 同一個擁有者、同一個食物只有一個預設（同 create_portion），同一個交易。
        await db.execute(
            update(FoodPortion)
            .where(
                FoodPortion.food_id == portion.food_id,
                FoodPortion.owner_id.is_not_distinct_from(portion.owner_id),
                FoodPortion.is_default.is_(True),
                FoodPortion.id != portion.id,
            )
            .values(is_default=False)
        )

    for field, value in changes.items():
        setattr(portion, field, value)
    try:
        await db.commit()
    except IntegrityError as exc:
        await db.rollback()
        raise ConflictError("PORTION_EXISTS", "你已經為這個食物建過同名的份量了") from exc

    await db.refresh(portion)
    return _portion_response(portion)


@router.delete("/{food_id}/portions/{portion_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_portion(
    food_id: ResourceId,
    portion_id: ResourceId,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> None:
    """刪除份量。用過它的餐點那一項 `portion_id` 由資料庫 `SET NULL`，
    `quantity_g` 不變——舊紀錄變成「直接輸入的公克數」，數字照舊。"""
    portion = await _load_manageable_portion(db, food_id, portion_id, user)
    await db.delete(portion)
    await db.commit()
```

5. `create_portion` 裡「沒有刪除／編輯份量的端點，一旦出現兩個預設就無法修正」那句註解改成「同一個人、同一個食物只會有一個預設份量——新增預設時在同一個交易裡取消舊的（`update_portion` 同一條規則）」。

- [ ] **Step 4: 跑測試確認通過**（`tests/test_foods_portions.py`、`tests/test_meals_items.py`、`tests/test_meals_read.py`）

- [ ] **Step 5: 突變測試**（每個做完都手動改回並重跑）

1. `_load_manageable_portion` 的 `or_(...)` 擋別人的條件拿掉（只留 `FoodPortion.id == …, FoodPortion.food_id == …`）→ Expected：`…someone_elses_private_portion_is_404…` FAIL。
2. 把整段取消預設的 `update` 拿掉 → Expected：`…unsets_only_the_same_owners_default` FAIL（舊的預設還是 True）。
3. `update` 的 `owner_id.is_not_distinct_from(...)` 條件拿掉 → Expected：同一條 FAIL（公開預設被取消）。

- [ ] **Step 6: 全部後端測試、ruff、mypy**；然後重新產生 `schema.d.ts`（指令見「執行環境」），在 `frontend/` 跑 `npm run -s typecheck` 與 `npm run -s test`。

Expected：`schema.d.ts` 多了 `PortionUpdateRequest` 與兩個新路徑；前端全綠。

- [ ] **Step 7: Commit**

```
feat(foods): 份量可以修改、刪除，已記的餐不受影響

PATCH／DELETE /api/foods/{food_id}/portions/{portion_id}。自己的私人份量本人
能動；公開份量只有管理員（一般使用者 403）；別人的私人份量 404。改成預設時
取消同擁有者的舊預設；改名撞名 409。改重量不動已記的 quantity_g；刪除時
餐點那一項的 portion_id 變 null、公克數照舊。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/food.py app/api/routes/foods.py tests/test_foods_portions.py frontend/src/api/schema.d.ts
```

---

## Task 2：前端——食物詳情的份量修改、刪除

**Files:** Create `frontend/src/components/PortionRow.tsx`；Modify `frontend/src/screens/FoodDetail.tsx`；Test `frontend/tests/food-detail.test.tsx`（加，不改既有的）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/food-detail.test.tsx`：`PORTIONS` 之後加 fixture，檔尾加一個 `describe`（`within`、`waitFor`、`userEvent`、`queryKeys` 若還沒 import 就補上；`PRIVATE_FOOD`、`foodRoutes`、`wrap`／render 的方式照檔案裡既有的測試）：

```tsx
const MY_BOWL = {
	id: 5,
	label: "我的碗",
	grams: "220.00",
	is_default: false,
	is_global: false,
};

function portionRequests(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
): Array<[unknown, RequestInit | undefined]> {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes("/portions/5"),
	) as Array<[unknown, RequestInit | undefined]>;
}

describe("食物詳情：份量的修改與刪除", () => {
	it("公開份量沒有修改、刪除按鈕；自己的有", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], [...PORTIONS, MY_BOWL]));
		renderDetail();

		await screen.findByText(/我的碗（220 g）/);
		expect(screen.getByRole("button", { name: "修改我的碗" })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "刪除我的碗" })).toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "修改一份" })).not.toBeInTheDocument();
		expect(screen.queryByRole("button", { name: "刪除一份" })).not.toBeInTheDocument();
	});

	it("修改：只送改過的欄位，成功後重抓份量清單", async () => {
		const fetchMock = mockApi(
			foodRoutes(PRIVATE_FOOD, [], [MY_BOWL], [
				{
					method: "PATCH",
					path: "/portions/5",
					handler: () => json({ ...MY_BOWL, grams: "250.00" }),
				},
			]),
		);
		const client = renderDetail();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(await screen.findByRole("button", { name: "修改我的碗" }));
		const form = screen.getByRole("form", { name: "修改我的碗" });
		const grams = within(form).getByLabelText("重量（g）");
		expect(grams).toHaveValue("220");
		await userEvent.clear(grams);
		await userEvent.type(grams, "250");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		await waitFor(() => expect(portionRequests(fetchMock, "PATCH")).toHaveLength(1));
		const body = JSON.parse(String(portionRequests(fetchMock, "PATCH")[0]?.[1]?.body));
		expect(body).toEqual({ grams: "250" });
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: queryKeys.portions(PRIVATE_FOOD.id),
			}),
		);
	});

	it("沒改任何東西就儲存：不送，收起來", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], [MY_BOWL]));
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "修改我的碗" }));
		const form = screen.getByRole("form", { name: "修改我的碗" });
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(screen.queryByRole("form", { name: "修改我的碗" })).not.toBeInTheDocument();
		expect(portionRequests(fetchMock, "PATCH")).toHaveLength(0);
	});

	it("名稱清空：擋下，不送", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], [MY_BOWL]));
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "修改我的碗" }));
		const form = screen.getByRole("form", { name: "修改我的碗" });
		await userEvent.clear(within(form).getByLabelText("份量名稱"));
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(within(form).getByRole("alert")).toHaveTextContent("請輸入份量名稱");
		expect(portionRequests(fetchMock, "PATCH")).toHaveLength(0);
	});

	it("改名撞名：顯示後端的訊息", async () => {
		mockApi(
			foodRoutes(PRIVATE_FOOD, [], [MY_BOWL], [
				{
					method: "PATCH",
					path: "/portions/5",
					handler: () =>
						json(
							{
								error: {
									code: "PORTION_EXISTS",
									message: "你已經為這個食物建過同名的份量了",
									details: {},
								},
							},
							409,
						),
				},
			]),
		);
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "修改我的碗" }));
		const form = screen.getByRole("form", { name: "修改我的碗" });
		await userEvent.type(within(form).getByLabelText("份量名稱"), "2");
		await userEvent.click(within(form).getByRole("button", { name: "儲存" }));

		expect(await within(form).findByRole("alert")).toHaveTextContent(
			"你已經為這個食物建過同名的份量了",
		);
	});

	it("刪除要先確認，寫明已記的餐不受影響；取消就不送", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], [MY_BOWL]));
		renderDetail();

		await userEvent.click(await screen.findByRole("button", { name: "刪除我的碗" }));
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除我的碗" });
		expect(dialog).toHaveTextContent("已經記下的餐不受影響，公克數照舊");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(portionRequests(fetchMock, "DELETE")).toHaveLength(0);
	});

	it("確認刪除：送 DELETE，成功後重抓份量清單", async () => {
		const fetchMock = mockApi(
			foodRoutes(PRIVATE_FOOD, [], [MY_BOWL], [
				{
					method: "DELETE",
					path: "/portions/5",
					handler: () => new Response(null, { status: 204 }),
				},
			]),
		);
		const client = renderDetail();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(await screen.findByRole("button", { name: "刪除我的碗" }));
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除我的碗" });
		await userEvent.click(within(dialog).getByRole("button", { name: "確定刪除" }));

		await waitFor(() => expect(portionRequests(fetchMock, "DELETE")).toHaveLength(1));
		await waitFor(() =>
			expect(invalidate).toHaveBeenCalledWith({
				queryKey: queryKeys.portions(PRIVATE_FOOD.id),
			}),
		);
	});
});
```

> `renderDetail()` 是示意：照檔案裡既有測試的 render 方式寫（它們怎麼建 `QueryClient`、怎麼包 `MemoryRouter`、路徑是 `/foods/{id}`）。如果既有的 helper 沒有回傳 `QueryClient`，就在這個 `describe` 裡寫一個小 helper 自己建 client 並回傳——**不要改既有的 helper 或既有的測試**。`PRIVATE_FOOD` 若不叫這個名字，用檔案裡那個私人食物 fixture。

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/food-detail.test.tsx
```

Expected：新的 7 條 FAIL（找不到「修改我的碗」按鈕）；既有的 PASS。

- [ ] **Step 3: 實作**

`frontend/src/components/PortionRow.tsx`（新）：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors } from "../api/errors";
import type { Portion } from "../api/foods";
import { queryKeys } from "../api/queries";
import { formatMacro, isPlainPositiveDecimal } from "../lib/decimal";
import ui from "./ui.module.css";

/** 份量重量的後端上限（`PortionUpdateRequest.grams` 的 `le=10000`）。 */
const MAX_GRAMS = 10000;

type Props = {
	foodId: number;
	portion: Portion;
	unit: string;
	/** 這一列的修改表單是不是開著——同一時間只開一個，由食物詳情管。 */
	editing: boolean;
	onEdit: () => void;
	onClose: () => void;
};

function describeError(error: unknown, fallback: string): string {
	if (error instanceof ApiError) {
		if (error.code === "PORTION_EXISTS") return error.message;
		if (error.code === "VALIDATION_ERROR") return describeFieldErrors(error).join("；");
	}
	return fallback;
}

/** 食物詳情的一列份量：顯示、修改、刪除（小項目包規格 §3.3）。
 *
 *  **只有私人份量能動**（`!portion.is_global`）：公開份量的修改、刪除只開放
 *  API 給管理員（計畫「與規格的差異」第 1 點）。後端仍然是授權的唯一依據。
 *
 *  **已經記下的餐不受影響**——改重量不動舊紀錄的公克數；刪除後舊紀錄那一項
 *  變成直接輸入的公克數。確認文字把這件事講出來。
 *
 *  名稱與重量那一段包在自己的 `<span>` 裡：`e2e/portions.spec.ts` 用
 *  `getByText(/碗（150 g）/)` 找這一列，按鈕的文字不能混進同一個文字節點。 */
export function PortionRow({ foodId, portion, unit, editing, onEdit, onClose }: Props) {
	const queryClient = useQueryClient();
	const canManage = !portion.is_global;
	const [label, setLabel] = useState(portion.label);
	const [grams, setGrams] = useState(formatMacro(portion.grams));
	const [isDefault, setIsDefault] = useState(portion.is_default);
	const [confirming, setConfirming] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const path = `/api/foods/${foodId}/portions/${portion.id}`;
	const refresh = () =>
		queryClient.invalidateQueries({ queryKey: queryKeys.portions(foodId) });

	const save = useMutation({
		mutationFn: (body: Record<string, unknown>) =>
			apiFetch<Portion>(path, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: () => {
			refresh();
			onClose();
		},
		onError: (caught) => setError(describeError(caught, "儲存失敗，請再試一次")),
	});

	const remove = useMutation({
		mutationFn: () => apiFetch(path, { method: "DELETE" }),
		onSuccess: () => {
			setConfirming(false);
			refresh();
		},
		onError: (caught) => setError(describeError(caught, "刪除失敗，請再試一次")),
	});

	function openEditor() {
		// 每次打開都從目前的值帶入——清單可能在背景重抓過。
		setLabel(portion.label);
		setGrams(formatMacro(portion.grams));
		setIsDefault(portion.is_default);
		setError(null);
		setConfirming(false);
		onEdit();
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const trimmedLabel = label.trim();
		const trimmedGrams = grams.trim();
		if (trimmedLabel === "") {
			setError("請輸入份量名稱");
			return;
		}
		if (!isPlainPositiveDecimal(trimmedGrams)) {
			setError("重量要大於 0");
			return;
		}
		if (Number(trimmedGrams) > MAX_GRAMS) {
			setError(`重量不能超過 ${MAX_GRAMS}`);
			return;
		}
		// 只送改過的欄位（PATCH 是 exclude_unset：不帶＝不動）。
		const body: Record<string, unknown> = {};
		if (trimmedLabel !== portion.label) body.label = trimmedLabel;
		if (trimmedGrams !== formatMacro(portion.grams)) body.grams = trimmedGrams;
		if (isDefault !== portion.is_default) body.is_default = isDefault;
		if (Object.keys(body).length === 0) {
			onClose();
			return;
		}
		setError(null);
		save.mutate(body);
	}

	const busy = save.isPending || remove.isPending;
	const idPrefix = `portion-${portion.id}`;

	return (
		<li>
			<span>
				{portion.label}（{formatMacro(portion.grams)} {unit}）
				{portion.is_default && (
					<>
						・<span className={ui.tag}>預設</span>
					</>
				)}
			</span>

			{canManage && !editing && !confirming && (
				<>
					<button type="button" aria-label={`修改${portion.label}`} onClick={openEditor}>
						修改
					</button>
					<button
						type="button"
						className={ui.danger}
						aria-label={`刪除${portion.label}`}
						onClick={() => {
							setError(null);
							setConfirming(true);
						}}
					>
						刪除
					</button>
				</>
			)}

			{editing && (
				<form aria-label={`修改${portion.label}`} onSubmit={handleSubmit}>
					<label htmlFor={`${idPrefix}-label`}>份量名稱</label>
					<input
						id={`${idPrefix}-label`}
						type="text"
						maxLength={50}
						value={label}
						onChange={(event) => setLabel(event.target.value)}
					/>
					<label htmlFor={`${idPrefix}-grams`}>重量（{unit}）</label>
					<input
						id={`${idPrefix}-grams`}
						type="text"
						inputMode="decimal"
						value={grams}
						onChange={(event) => setGrams(event.target.value)}
					/>
					<label>
						<input
							type="checkbox"
							checked={isDefault}
							onChange={(event) => setIsDefault(event.target.checked)}
						/>
						記一餐時預設用這個份量
					</label>
					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={busy}>
						{save.isPending ? "儲存中…" : "儲存"}
					</button>
					<button type="button" onClick={onClose}>
						放棄
					</button>
				</form>
			)}

			{confirming && (
				<div role="alertdialog" aria-label={`確認刪除${portion.label}`}>
					<p>
						確定要刪除「{portion.label}」嗎？已經記下的餐不受影響，公克數照舊。
					</p>
					<button
						type="button"
						className={ui.danger}
						disabled={busy}
						onClick={() => remove.mutate()}
					>
						確定刪除
					</button>
					<button type="button" onClick={() => setConfirming(false)}>
						取消
					</button>
				</div>
			)}

			{!editing && error !== null && <p role="alert">{error}</p>}
		</li>
	);
}
```

`frontend/src/screens/FoodDetail.tsx`：import `PortionRow`；元件裡加 `const [editingPortionId, setEditingPortionId] = useState<number | null>(null);`；份量清單的 `<li>…</li>` 換成：

```tsx
								{portions.map((portion) => (
									<PortionRow
										key={portion.id}
										foodId={foodId}
										portion={portion}
										unit={unit}
										editing={editingPortionId === portion.id}
										onEdit={() => setEditingPortionId(portion.id)}
										onClose={() => setEditingPortionId(null)}
									/>
								))}
```

> `ui.danger` 是介面改版第二階段 Task 4 加的（`ui.module.css` 檔尾）。`Portion` 型別從 `../api/foods` 匯出——以現況為準。

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/food-detail.test.tsx
git diff HEAD -- tests/food-detail.test.tsx | grep "^-[^-]" || echo "沒有刪除任何既有的行"
```

- [ ] **Step 5: 突變測試**：`canManage` 改成永遠 `true` → Expected：「公開份量沒有修改、刪除按鈕…」FAIL。改回。

- [ ] **Step 6: 全部前端檢查**＋e2e（`npx playwright test e2e/portions.spec.ts e2e/touch-targets.spec.ts`——份量那一列多了按鈕，`portions.spec.ts` 的 `getByText(/碗（150 g）/)` 要照樣過）

- [ ] **Step 7: Commit**

```
feat(foods): 食物詳情可以修改、刪除自己的份量

每一列私人份量多了「修改」「刪除」：修改只送改過的欄位；刪除先確認，寫明
已記的餐不受影響。成功後重抓份量清單（記一餐與編輯畫面共用同一個 key）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/PortionRow.tsx frontend/src/screens/FoodDetail.tsx frontend/tests/food-detail.test.tsx
```

---

## Task 3：編輯歷史的日期

**Files:** Modify `frontend/src/lib/dates.ts`、`frontend/src/screens/FoodDetail.tsx`、`frontend/tests/food-detail.test.tsx`；Create `frontend/tests/dates.test.ts`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/dates.test.ts`（新）：

```ts
import { describe, expect, it } from "vitest";
import { formatDateTime } from "../src/lib/dates";

describe("formatDateTime", () => {
	it("給人看的日期與時間，不是 ISO 原文", () => {
		const text = formatDateTime("2026-09-01T00:00:00Z");

		expect(text).toMatch(/2026/);
		// 不是原始字串：沒有 T 分隔、沒有 Z、沒有秒以下的位數。
		expect(text).not.toMatch(/T\d|Z$|\.\d{3}/);
	});

	it("有時與分", () => {
		expect(formatDateTime("2026-09-01T00:00:00Z")).toMatch(/\d{1,2}:\d{2}/);
	});
});
```

`frontend/tests/food-detail.test.tsx`：**這是刻意的行為改變**（規格 §4）——「編輯歷史每一筆顯示 status / change_note / created_at…」那條測試裡的

```tsx
		expect(screen.getByText("2026-09-01T00:00:00Z")).toBeInTheDocument();
```

與 `"2026-08-20T00:00:00Z"` 那一行，改成（import `formatDateTime`）：

```tsx
		expect(
			screen.getByText(formatDateTime("2026-09-01T00:00:00Z")),
		).toBeInTheDocument();
		expect(screen.queryByText("2026-09-01T00:00:00Z")).not.toBeInTheDocument();
```

（`2026-08-20` 那一筆照同樣的形狀改。）

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/dates.test.ts tests/food-detail.test.tsx
```

Expected：`dates.test.ts` FAIL（`formatDateTime` 不存在）；`food-detail` 那條 FAIL。

- [ ] **Step 3: 實作**

`frontend/src/lib/dates.ts` 檔尾加：

```ts
/** 日期加時間（例如「2026/9/1 08:00」），用瀏覽器的時區與語系。
 *
 *  **只做顯示格式化**，跟 `formatTime` 一樣，不算日界線（見檔頭）。
 *  給「這件事是什麼時候發生的」用——例如食物詳情的編輯歷史。 */
export function formatDateTime(timestamp: string | number): string {
	return new Date(timestamp).toLocaleString(undefined, {
		year: "numeric",
		month: "numeric",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}
```

`frontend/src/screens/FoodDetail.tsx`：import `formatDateTime`（`../lib/dates`）；編輯歷史的 `<p>{revision.created_at}</p>` 改成 `<p>{formatDateTime(revision.created_at)}</p>`。

- [ ] **Step 4: 跑測試確認通過**；全部前端檢查。

- [ ] **Step 5: Commit**

```
feat(foods): 編輯歷史的日期改成好讀的格式

lib/dates.ts 加 formatDateTime（只做顯示格式化）。食物詳情的測試原本斷言
原始 ISO 字串，跟著改——這是刻意的行為改變。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/lib/dates.ts frontend/src/screens/FoodDetail.tsx frontend/tests/dates.test.ts frontend/tests/food-detail.test.tsx
```

---

## Task 4：趨勢圖的日期軸

**Files:** Modify `frontend/src/components/TrendChart.tsx`、`frontend/src/index.css`；Test `frontend/tests/trend-chart.test.tsx`（加）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/trend-chart.test.tsx` 檔尾加（`fullDay` 是第二階段加的 helper）：

```tsx
describe("TrendChart：日期軸", () => {
	it("每根柱子下面有那天的日期，今天那根寫「今天」", () => {
		render(
			<TrendChart
				today="2026-09-16"
				days={[
					fullDay("2026-09-15", { kcal: "1800.00" }, null),
					fullDay("2026-09-16", { kcal: "900.00" }, null),
				]}
			/>,
		);

		expect(screen.getByTestId("trend-date-2026-09-15")).toHaveTextContent("9/15");
		expect(screen.getByTestId("trend-date-2026-09-16")).toHaveTextContent("今天");
	});

	it("日期在柱子正下方（同一個水平中心）", () => {
		render(
			<TrendChart
				days={[
					fullDay("2026-09-15", { kcal: "1800.00" }, null),
					fullDay("2026-09-16", { kcal: "900.00" }, null),
				]}
			/>,
		);

		const bar = screen.getByTestId("trend-bar-2026-09-16");
		const center = Number(bar.getAttribute("x")) + Number(bar.getAttribute("width")) / 2;
		expect(
			Number(screen.getByTestId("trend-date-2026-09-16").getAttribute("x")),
		).toBeCloseTo(center, 5);
	});

	it("日期是裝飾：柱子的 aria-label 已經有日期", () => {
		render(<TrendChart days={[fullDay("2026-09-15", { kcal: "1800.00" }, null)]} />);

		expect(screen.getByTestId("trend-date-2026-09-15")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});
});
```

- [ ] **Step 2: 跑測試確認失敗**（新的 3 條 FAIL：找不到 `trend-date-…`）

- [ ] **Step 3: 實作**

`frontend/src/components/TrendChart.tsx`：

1. `const VIEW_HEIGHT = 160;` 下面加：

```tsx
/** 柱子下方給日期用的一條。柱子的計算範圍仍然是 VIEW_HEIGHT——
 *  既有的高度比例與位置測試不受影響。 */
const DATE_BAND = 16;
```

2. `<svg>` 的 `viewBox` 改成 ``{`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT + DATE_BAND}`}``。
3. 每一天的 `<g>` 裡，`<rect>` 之後加：

```tsx
						<text
							data-testid={`trend-date-${day.date}`}
							x={x + barWidth / 2}
							y={VIEW_HEIGHT + DATE_BAND - 4}
							textAnchor="middle"
							className="trend-date"
							aria-hidden="true"
						>
							{day.date === today ? "今天" : formatCivilDate(day.date)}
						</text>
```

> `x` 與 `barWidth` 是迴圈裡算好的那兩個變數（以現況的名稱為準）。

`frontend/src/index.css`，`.trend-target` 規則之後加：

```css
/* 趨勢圖柱子下方的日期。 */
.trend-date {
	fill: var(--color-text-muted);
	font-size: 10px;
}
```

- [ ] **Step 4: 跑測試確認通過**（`tests/trend-chart.test.tsx`、`tests/trend.test.tsx`、`tests/css-tokens.test.ts`）；全部前端檢查。

- [ ] **Step 5: 用眼睛看一次**：Playwright 截 `/trend`（390×844，淺色與深色）存到 scratchpad，描述日期是否清楚、有沒有擠在一起。

- [ ] **Step 6: Commit**

```
feat(ui): 趨勢圖每根柱子下面寫日期，今天寫「今天」

日期畫在柱子區域下方多出的一條（柱子的計算範圍不變）；是裝飾，柱子的
aria-label 已經有日期。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/TrendChart.tsx frontend/src/index.css frontend/tests/trend-chart.test.tsx
```

---

## Task 5：報表清單的按鈕

**Files:** Modify `frontend/src/screens/Expenses.tsx`、`frontend/src/screens/Expenses.module.css`、`frontend/e2e/touch-targets.spec.ts`

- [ ] **Step 1: 寫失敗的 e2e**

`frontend/e2e/touch-targets.spec.ts` 檔尾加：

```ts
test("報表：支出清單的按鈕都 ≥ 44px", async ({ page }) => {
	await login(page);
	// 先記一筆，清單才一定有東西（同 money-loop.spec.ts 的步驟）。
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記帳" }).click();
	await expect(page.getByRole("heading", { name: "記帳", exact: true })).toBeVisible();
	for (const key of ["4", "2"]) {
		await page.getByRole("button", { name: key, exact: true }).click();
	}
	await page.getByRole("button", { name: "交通" }).click();
	const note = `e2e-touch-${Date.now()}`;
	await page.getByLabel("備註").fill(note);
	await page.getByRole("button", { name: "記一筆" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	await page.goto("/reports");
	const row = page.locator('main li[data-testid^="expense-"]').filter({ hasText: note });
	await expect(row).toHaveCount(1);
	await expectTouchTargets(row.locator("button:visible"), "報表清單");

	// 打開修改與刪除確認，裡面的按鈕也量。
	await row.getByRole("button", { name: "修改", exact: true }).click();
	await expectTouchTargets(row.locator("button:visible"), "報表清單（修改中）");
	await row.getByRole("button", { name: "放棄", exact: true }).click();
	await row.getByRole("button", { name: "刪除", exact: true }).click();
	await expectTouchTargets(row.locator("button:visible"), "報表清單（確認刪除）");
});
```

- [ ] **Step 2: 跑 e2e 確認失敗**

```
cd frontend
npx playwright test e2e/touch-targets.spec.ts -g 報表
```

Expected：FAIL（「修改」或「刪除」的高度小於 44——照實回報數字）。

- [ ] **Step 3: 實作**

`frontend/src/screens/Expenses.tsx`：「刪除」與「確定刪除」兩個按鈕加 `className={styles.danger}`。**文字、順序、其他屬性不動。**

`frontend/src/screens/Expenses.module.css` 檔尾加：

```css
/* 清單一列裡的按鈕（小項目包規格 §6）：至少 44px；儲存是實心，刪除類是危險色的框。 */
.row button {
	min-height: 44px;
	padding: 0 var(--space-3);
	border: 1px solid var(--color-action);
	border-radius: var(--radius-button);
	background: transparent;
	color: var(--color-action);
	font-size: 14px;
	font-weight: 600;
}

.row button[type="submit"] {
	border: none;
	background: var(--color-action);
	color: var(--color-on-action);
}

/* (0,2,0) 贏過上面的 .row button (0,1,1)。 */
.row .danger {
	border-color: var(--color-danger);
	color: var(--color-danger);
}

.row button:disabled {
	opacity: 0.4;
}

/* 修改表單與刪除確認佔滿一整行，換到金額下面。 */
.row form,
.row [role="alertdialog"] {
	flex-basis: 100%;
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
}

.row form input {
	flex: 1;
	min-height: 44px;
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-bg);
	color: var(--color-text);
}

.row [role="alertdialog"] p,
.row [role="alert"] {
	flex-basis: 100%;
	margin: 0;
}

.row [role="alert"] {
	color: var(--color-danger);
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx playwright test e2e/touch-targets.spec.ts
npx vitest run tests/expenses.test.tsx tests/css-tokens.test.ts
git status --short tests
```

Expected：e2e 全綠；單元測試全綠；`tests/` 沒有改動。

- [ ] **Step 5: 用眼睛看一次**：截 `/reports`（淺色與深色、打開一列的修改、打開一列的刪除確認），描述。

- [ ] **Step 6: 全部前端檢查**＋全部 e2e（Expected：26 + 1 = 27 passed）

- [ ] **Step 7: Commit**

```
style(ui): 報表清單的修改、刪除按鈕換成新外觀

至少 44px；儲存是實心、刪除類是危險色的框；修改表單與刪除確認換到下一行。
新的 e2e 量這一列（含打開修改、打開刪除確認）的按鈕高度。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/Expenses.tsx frontend/src/screens/Expenses.module.css frontend/e2e/touch-targets.spec.ts
```

---

## Task 6：交接文件與規格

- [ ] 規格 §3.3 第一點改成「**只有私人份量能動**（`!portion.is_global`）；公開份量的修改、刪除只開放 API 給管理員（§1.2）」。
- [ ] `docs/handover.md`：§8.2「份量管理」那一條改成「新增、修改、刪除都已完成（已記的餐不受影響）」；介面改版已知待辦裡「編輯歷史日期」「趨勢日期軸」「報表清單按鈕」三條拿掉；新的綠燈說謊或技術坑（有的話）寫進 §6／§7。
- [ ] Commit：`docs: 交接文件與規格——小項目包`

---

## 收尾

- [ ] 全部測試：後端 pytest、ruff、mypy；前端 typecheck、lint、test；e2e（27）。
- [ ] `git status` 乾淨（`lunch.jpg` 除外）。

## 自我檢查

| 規格 | 任務 |
|---|---|
| §3.1 PATCH／DELETE、權限表、預設、撞名、null | Task 1 |
| §3.2 已記的餐不受影響 | Task 1（兩條測試） |
| §3.3 前端（私人份量；與規格的差異第 1 點） | Task 2、Task 6 改規格 |
| §4 日期 | Task 3 |
| §5 日期軸 | Task 4 |
| §6 報表按鈕 | Task 5 |
| §7 測試 | Task 1–5 |

名稱一致：`PortionUpdateRequest`、`_portion_response`、`_load_manageable_portion`（Task 1）；`PortionRow` 的 props `foodId`／`portion`／`unit`／`editing`／`onEdit`／`onClose`（Task 2）；`formatDateTime`（Task 3）；`trend-date-{date}`、`.trend-date`、`DATE_BAND`（Task 4）；`styles.danger`（Task 5）。
