# 修改與刪除已記錄的餐點 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 使用者可以修改（份量／數量、加刪項目、餐別、金額、照片）與刪除（連餐費）已記錄的餐點。

**Architecture:** 後端補 `MealResponse.cost`、刪一餐連餐費、`PATCH /api/meals/{id}` 的 `cost`、`PATCH .../items/{item_id}`，每個動作一個交易。前端先從 `LogMeal` 抽出 `FoodPicker` 與 `usePortionQuantity`／`PortionQuantityFields`（記一餐行為不變），再做 `/meals/:id/edit`，飲食卡片與總覽時間線的餐點列都連過去。

**Tech Stack:** FastAPI · Pydantic · SQLAlchemy async · Vite · React 19 · TypeScript strict · TanStack Query · react-router 8 · Vitest + Testing Library · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-04-edit-meals-design.md`

---

## 執行環境

- 後端在 repo 根目錄：`./.venv/Scripts/python.exe -m pytest …`、`… -m ruff check app tests`、`… -m mypy app`（CI 有跑 mypy）。測試資料庫 `wallet-db-1` 要 healthy（沒開就回報，不要自己開關容器）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`、`npm run -s test`。Vitest 會把每個測試檔再跑一次型別檢查，數量看起來是兩倍。
- 基準線（master `417663a`）：後端 611 passed；前端 76 檔 621 passed；e2e 18 passed。
- **檔案編輯用 Write/Edit 工具；LF 換行。** 不要在任何地方複製備份檔。
- **突變測試的還原：** 已追蹤的檔案用 `git checkout -- <file>`，**但要先確認那個檔案沒有本任務其他還沒 commit 的改動**（上一輪有人因此把整個任務的改動清掉）；新檔案（未追蹤）`git checkout` 沒有作用，要手動改回並重跑測試確認。
- Commit：`git commit -F <file>`，中文全形標點，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。

---

## 開工前必讀：這份計畫的文字沒有權威性

前四份計畫都被抓到錯誤。

1. 「Expected: FAIL」沒有如預期失敗 → **停下來回報**，不要調整測試讓它變紅。
2. 預測紅 N 條、實際不是 N → 照實回報是哪幾條。
3. 要改的檔案不在清單上 → 回報。
4. 引用的程式碼對不上 → 以現況為準並回報。
5. 斷言「某件事沒發生」在動作是非同步時會空轉通過（handover §6 第 41 種）。
6. 有表單又有清單的畫面上，裸的 `getByText` 預設要懷疑（第 38 種）；Playwright 的 `getByLabel` 預設是**子字串**比對（第 48 種）。

---

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `_build_meal_response(meal, item_rows)` 有 5 個呼叫點：`read_meal`、`update_meal`、`add_meal_item`、`list_meals`、`upload_meal_photo`；`create_meal` 自己組 `MealResponse` | `app/api/routes/meals.py` |
| `create_meal` 只有一次 `commit`，**有原始碼掃描測試守著**（`test_create_meal_commits_exactly_once`） | `tests/test_meals_cost.py:102` |
| **`test_meal_response_does_not_include_cost` 斷言回應裡沒有 `cost`**——它的 docstring 自己說「真的需要每一餐都顯示金額時，那是一次獨立的改動（把 LEFT JOIN 加進三條讀取路徑）」。這份計畫就是那次改動，Task 1 要把它換掉 | `tests/test_meals_cost.py:58-76` |
| `expenses.meal_id` 是 `ON DELETE SET NULL`，有索引 `ix_expenses_meal_id` | `app/models/expense.py:82,92` |
| `MealUpdateRequest` 用 `exclude_unset`，`model_validator` 擋 `eaten_at`／`meal_type` 的顯式 null；`note` 的 null 合法 | `app/schemas/meal.py:51-82` |
| `_resolve_item` 的份量規則：`load_visible_portion`（看不到 404）、`portion.food_id != food.id` → 422 `PORTION_FOOD_MISMATCH`、`quantity_g = (portion.grams * quantity).quantize(_CENTS, ROUND_HALF_UP)` | `app/api/routes/meals.py:69-130` |
| `delete_meal_item`：`_load_owned_meal` 後用 `MealItem.id == item_id, MealItem.meal_id == meal.id` 查，查不到 404 `MEAL_ITEM_NOT_FOUND` | 同上 |
| 「營養素版本不變」的測試寫法：`create_pending_revision` ＋ 管理員 approve | `tests/test_meals_read.py:178-224` |
| `queryKeys.meals` = `["meals"]`；**`queryKeys.mealPhoto(id)` = `["meal-photo", id]`，不在 `["meals"]` 底下** | `frontend/src/api/queries.ts:41,133` |
| `useFood(foodId)`、`useMealPhoto(mealId)`（回 `{ objectUrl, isError }`）、`useUploadMealPhoto(mealId)`（成功失效 `meals` 與 `mealPhoto`）都已匯出 | `frontend/src/api/foods.ts`、`photos.ts` |
| `LogMeal` 裡要抽出的部分：搜尋框（label「搜尋食物」、id `food-search-input`）、搜尋結果（`FoodResultList`）、常吃／最近吃清單（`NutritionPreview`、`dedupeById`、`NO_REVISION_MESSAGE`）、份量下拉（label「份量選項」、**id `portion`——`e2e/portions.spec.ts` 用 `#portion option:checked`**）、數量（label「份量」、id `quantity`）、單位提示（id 與 testid `quantity-unit`）、`portionChoice` 三態與「動過數量就鎖住」 | `frontend/src/screens/LogMeal.tsx` |
| `isCostValidationError` 目前是 `LogMeal.tsx` 裡的私有函式 | 同上:51-59 |
| 總覽時間線的餐點列：`<li className={styles.row} data-testid="timeline-row">`，內容是 `MealTypeIcon`、標題、時間、值 | `frontend/src/screens/Overview.tsx` 的 `TimelineItem` |
| `MealList` 的 `MealCard`：`<li className={styles.meal}>`，`<h3>{時間} · {餐別}</h3>` | `frontend/src/screens/MealList.tsx` |
| react-router 的初始 history entry 的 `location.key` 是 `"default"` | 介面改版 Task 5 的審查實測 |

---

## 與規格的差異（寫計畫時決定）

1. **`PortionQuantityFields` 拆成一個 hook（`usePortionQuantity`）加一個顯示元件。** 份量的選擇與數量是送出 body 要用的狀態，放在 hook 裡讓呼叫端（`LogMeal`、編輯畫面）拿得到；元件只負責畫。
2. **元件的 id 有前綴參數（`idPrefix`，預設空字串）**——`LogMeal` 不帶前綴，id 跟現在一字不差（e2e 依賴 `#portion`）；編輯畫面帶前綴。並且**編輯畫面同一時間只開一個編輯器**（改某一項／加一項），避免同一個畫面出現兩個「份量」標籤。
3. **`isCostValidationError` 搬到 `api/errors.ts`，改名 `hasFieldError(error, field)`**——編輯畫面也要判斷「這個 422 是不是金額欄位」。
4. **刪一餐之後先 `removeQueries` 這一餐的 key 再失效其他**——不然失效會讓還掛著的 `useMeal` 去重抓一個已經刪掉的餐，打出一個 404。
5. **刪一餐、刪照片之後，這一餐的 `mealPhoto` 用 `removeQueries`，不是規格表上寫的「失效」**——同一個理由：失效會讓還掛著的照片預覽立刻去抓一張已經刪掉的照片（404）。換照片仍然是失效（既有的 `useUploadMealPhoto`）。
6. **規格 §6 的第 5 步（編輯畫面）拆成兩個任務**：Task 5 做畫面骨架、這一餐、照片、刪除整餐（項目只顯示）；Task 6 做項目的改、刪、加。所以這份計畫是 8 個任務。
7. **`describeUploadError` 從 `MealList.tsx` 搬到 `api/photos.ts`（改名 `describePhotoUploadError`）**——編輯畫面的照片區也要用同一組訊息。
8. **`LogMeal` 的餐別清單改用 `MEAL_TYPE_ORDER`＋`MEAL_TYPE_LABELS`**（編輯畫面也要同一份清單；文字與順序不變）。

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/schemas/meal.py`（改） | `MealResponse.cost`；`MealUpdateRequest.cost`；`MealItemUpdateRequest` |
| `app/api/routes/meals.py`（改） | `_costs_by_meal`；回應帶 `cost`；刪一餐連餐費；`update_meal` 的 `cost`；`update_meal_item` |
| `tests/test_meals_cost.py`、`tests/test_meals_update.py`、`tests/test_meals_items.py`（改） | |
| `frontend/src/api/schema.d.ts`（重新產生） | |
| `frontend/src/api/errors.ts`（改） | `hasFieldError` |
| `frontend/src/components/FoodPicker.tsx`＋`.module.css`（新） | 搜尋＋常吃／最近吃 |
| `frontend/src/components/PortionQuantityFields.tsx`＋`.module.css`（新） | `usePortionQuantity` hook ＋ 顯示元件 |
| `frontend/src/screens/LogMeal.tsx`、`LogMeal.module.css`（改） | 改用上面兩個 |
| `frontend/src/api/queries.ts`、`frontend/src/api/meals.ts`（改） | `queryKeys.meal(id)`；`useMeal`；`MEAL_TYPE_ORDER` |
| `frontend/src/api/photos.ts`（改） | `describePhotoUploadError`（從 `MealList` 搬來） |
| `frontend/src/screens/EditMeal.tsx`＋`.module.css`（新） | 編輯畫面：這一餐、照片、刪除 |
| `frontend/src/screens/EditMealItems.tsx`（新） | 編輯畫面的項目區：改、刪、加 |
| `frontend/src/App.tsx`（改） | `/meals/:id/edit` |
| `frontend/src/screens/MealList.tsx`＋`.module.css`、`Overview.tsx`＋`.module.css`（改） | 入口 |
| `frontend/src/screens/Expenses.tsx`（改） | 只改一段過時的註解（刪餐點時餐費的去向） |
| `frontend/tests/…` | 新：`food-picker`、`portion-quantity-fields`、`edit-meal`；改：`errors`、`queries`、`meal-list`、`meal-photo-upload`（`wrap` 加 `MemoryRouter`）、`overview`、`timeline`（fixture 補 `cost`） |
| `docs/handover.md`（改） | 收尾 |
| `frontend/e2e/edit-meal.spec.ts`（新） | |

---

## Task 1：回應帶 `cost`、刪一餐連餐費

**Files:** Modify `app/schemas/meal.py`、`app/api/routes/meals.py`；Test `tests/test_meals_cost.py`、`tests/test_meals_update.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_meals_cost.py`：

**刪掉** `test_meal_response_does_not_include_cost` 整條。它的 docstring 說「真的需要每一餐都顯示金額時，那是一次獨立的改動（把 LEFT JOIN 加進三條讀取路徑）」——就是這次；下面的 `test_every_read_path_returns_the_meals_cost` 守的正是它擔心的事（只有建立時有值、讀取時永遠是 null）。

imports 加上 `from tests.factories import create_food, create_user`（保留原有的）。檔尾加：

```python
def _meal(cost=None, eaten_at="2026-12-15T12:00:00+08:00"):
    body = {"eaten_at": eaten_at, "meal_type": "lunch"}
    if cost is not None:
        body["cost"] = cost
    return body


async def test_create_meal_response_includes_cost(client, db_session):
    user = await create_user(db_session)

    response = await client.post("/api/meals", headers=auth(user), json=_meal(cost="180"))

    assert response.json()["cost"] == "180.00"


async def test_create_meal_without_cost_responds_with_null_cost(client, db_session):
    user = await create_user(db_session)

    response = await client.post("/api/meals", headers=auth(user), json=_meal())

    assert response.json()["cost"] is None


async def test_every_read_path_returns_the_meals_cost(client, db_session):
    """取代舊的 test_meal_response_does_not_include_cost。

    舊測試的理由是「只在建立時有值、讀取時永遠 null 的欄位比沒有更糟」。
    這條守的就是那件事：清單、單筆、PATCH、加項目四條路徑都要回真的值。
    """
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    with_cost = (await client.post("/api/meals", headers=auth(user), json=_meal(cost="180"))).json()["id"]
    without_cost = (await client.post("/api/meals", headers=auth(user), json=_meal())).json()["id"]

    listing = await client.get("/api/meals?date=2026-12-15", headers=auth(user))
    costs = {meal["id"]: meal["cost"] for meal in listing.json()}
    assert costs == {with_cost: "180.00", without_cost: None}

    single = await client.get(f"/api/meals/{with_cost}", headers=auth(user))
    assert single.json()["cost"] == "180.00"

    patched = await client.patch(
        f"/api/meals/{with_cost}", headers=auth(user), json={"note": "改備註"}
    )
    assert patched.json()["cost"] == "180.00"

    added = await client.post(
        f"/api/meals/{with_cost}/items",
        headers=auth(user),
        json={"food_id": food.id, "quantity": "100"},
    )
    assert added.json()["cost"] == "180.00"
```

> `upload_meal_photo` 也回 `MealResponse`，這裡不測（要準備一張圖）——`_build_meal_response` 的 `cost` 是**必填參數**，漏傳會是 mypy／執行期錯誤，不會默默回 null。

`tests/test_meals_update.py` 檔尾加（imports 補上 `from sqlalchemy import func, select`、`from app.models.expense import Expense`、`from tests.factories import create_expense`，保留原有的）：

```python
async def test_deleting_a_meal_deletes_its_cost_but_nothing_else(client, db_session):
    """刪一餐連餐費一起刪（編輯餐點規格 §2、§3.4）——**只刪這一餐的**。

    沒有這條測試，ON DELETE SET NULL 會讓那筆錢默默留下來，
    報表多一筆沒有對應餐點的「飲食」支出。
    """
    user = await create_user(db_session)
    meal_a = await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "180"},
    )
    await client.post(
        "/api/meals",
        headers=auth(user),
        json={"eaten_at": "2026-12-15T18:00:00+08:00", "meal_type": "dinner", "cost": "50"},
    )
    await create_expense(db_session, user=user, amount=999)  # 手動記帳，meal_id 是 NULL

    response = await client.delete(f"/api/meals/{meal_a.json()['id']}", headers=auth(user))

    assert response.status_code == 204
    amounts = sorted(
        str(amount) for amount in (await db_session.scalars(select(Expense.amount))).all()
    )
    assert amounts == ["50.00", "999.00"]


async def test_deleting_someone_elses_meal_keeps_their_cost(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    meal = await client.post(
        "/api/meals",
        headers=auth(alice),
        json={"eaten_at": "2026-12-15T12:00:00+08:00", "meal_type": "lunch", "cost": "180"},
    )

    response = await client.delete(f"/api/meals/{meal.json()['id']}", headers=auth(bob))

    assert response.status_code == 404
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 1
```

> 這兩個檔案的 `auth`、`create_user` 已經存在；`create_expense` 的簽章見 `tests/factories.py:350`（`amount=999` 會存成 `999.00`）。

- [ ] **Step 2: 跑測試確認它失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py tests/test_meals_update.py -q
```

Expected：`…includes_cost`、`…null_cost`、`…every_read_path…`（KeyError `cost`）與 `…deletes_its_cost_but_nothing_else`（剩下 `["180.00", "50.00", "999.00"]`）FAIL；`…keeps_their_cost` **PASS**（現況就會 404 而且不刪）。照實回報。

- [ ] **Step 3: 實作**

`app/schemas/meal.py` 的 `MealResponse`，`photo_path` 之後加：

```python
    # 這一餐的餐費（`expenses.meal_id` 指過來的那一筆）；沒有就是 None。
    # 編輯餐點規格 §3.3：**每一條回 MealResponse 的路徑都要帶**——
    # 只有建立時有值、讀取時永遠 null 的欄位比沒有這個欄位更糟。
    cost: Decimal | None
```

`app/api/routes/meals.py`：

1. `from sqlalchemy import Row, Select, select` 改成 `from sqlalchemy import Row, Select, delete, select`。
2. 在 `_build_meal_response` **之前**加：

```python
async def _costs_by_meal(db: AsyncSession, meal_ids: Sequence[int]) -> dict[int, Decimal]:
    """這幾餐各自的餐費（`expenses.meal_id` 指過來的那一筆）。

    **一次查完**（`meal_id IN (...)`），跟 `list_meals` 查項目同一個作法——
    不是每一餐各查一次。

    **前提：一餐最多一筆餐費**（編輯餐點規格 §3.2）：`POST /api/meals` 只建
    一筆、`PATCH /api/expenses/{id}` 不能改 `meal_id`、手動記帳的 `meal_id`
    一律是 NULL。萬一前提被打破，取 id 最小的那一筆——跟 `update_meal` 改
    金額時動的是同一筆。
    """
    if not meal_ids:
        return {}
    rows = (
        await db.execute(
            select(Expense.meal_id, Expense.amount)
            .where(Expense.meal_id.in_(meal_ids))
            .order_by(Expense.id)
        )
    ).all()
    costs: dict[int, Decimal] = {}
    for meal_id, amount in rows:
        if meal_id is not None and meal_id not in costs:
            costs[meal_id] = amount
    return costs
```

3. `_build_meal_response` 的簽章加一個**必填**參數，並帶進回應：

```python
def _build_meal_response(
    meal: Meal,
    item_rows: Sequence[Row[tuple[MealItem, FoodRevision, Food]]],
    cost: Decimal | None,
) -> MealResponse:
```

`return MealResponse(…)` 裡加 `cost=cost,`。

4. 五個呼叫點都改。`read_meal`、`update_meal`、`add_meal_item`、`upload_meal_photo` 是單一餐：

```python
    costs = await _costs_by_meal(db, [meal.id])
    return _build_meal_response(meal, rows, costs.get(meal.id))
```

`list_meals`（已經有 `meal_ids`）：

```python
    costs = await _costs_by_meal(db, meal_ids)
    return [
        _build_meal_response(meal, items_by_meal.get(meal.id, []), costs.get(meal.id))
        for meal in meals
    ]
```

5. `create_meal`：把支出存成變數，commit 之後 refresh 拿到資料庫的精度，帶進回應：

```python
    expense: Expense | None = None
    if payload.cost is not None:
        expense = Expense(
            user_id=user.id,
            meal_id=meal.id,
            category=ExpenseCategory.FOOD,
            amount=payload.cost,
            spent_at=payload.eaten_at,
            note=None,
        )
        db.add(expense)
```

（取代原本的 `if payload.cost is not None: db.add(Expense(...))`，上面的註解保留。）`await db.refresh(meal)` 之後加：

```python
    if expense is not None:
        # "180" 在記憶體裡還是使用者給的精度；refresh 才是 numeric(10,2) 的 "180.00"。
        await db.refresh(expense)
```

`return MealResponse(` 裡加 `cost=expense.amount if expense is not None else None,`。

> **`create_meal` 仍然只能有一次 `await db.commit()`**——`test_create_meal_commits_exactly_once` 會掃。`refresh` 不是 commit。

6. `delete_meal`：`photo_path = meal.photo_path` 之後、`await db.delete(meal)` 之前加：

```python
    # 連餐費一起刪（編輯餐點規格 §2、§3.4），跟刪餐點在同一個交易裡。
    #
    # **不改 expenses.meal_id 的 ON DELETE SET NULL**：那條約束守的是
    # 「別的路徑刪了餐點時，錢不會無聲消失」（P5 規格 §2.3）。這裡是使用者
    # 明確要「撤銷這一餐」，所以先自己刪掉那筆支出。
    await db.execute(delete(Expense).where(Expense.meal_id == meal.id))
```

docstring 開頭加一句「連這一餐的餐費一起刪（編輯餐點規格 §3.4）。」

- [ ] **Step 4: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py tests/test_meals_update.py tests/test_meals_read.py tests/test_meals_items.py tests/test_meals_photo.py -q
```

Expected：全部 PASS。

- [ ] **Step 5: 突變測試**

刪掉 `delete_meal` 裡的 `await db.execute(delete(Expense)…)` → Expected：`…deletes_its_cost_but_nothing_else` **FAIL**。改回來（`git checkout` 前先確認這個檔案沒有本任務其他未 commit 的改動——有的話手動改回）。

- [ ] **Step 6: 全部後端測試、ruff、mypy**

```
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m ruff check app tests
./.venv/Scripts/python.exe -m mypy app
```

- [ ] **Step 7: Commit**（`schema.d.ts` 在 Task 3 一起重新產生）

```
feat(meals): 回應帶 cost，刪一餐連餐費一起刪

MealResponse.cost 在每一條回 MealResponse 的路徑都有值（一次查完，
_costs_by_meal）；取代原本「刻意不回 cost」那條測試——它擔心的正是
「只在建立時有值」，現在由一條跨四條路徑的測試守著。

刪一餐時先刪掉 meal_id 指過來的支出，同一個交易。ON DELETE SET NULL
不改：別的路徑刪餐點時，錢仍然不會無聲消失。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/meal.py app/api/routes/meals.py tests/test_meals_cost.py tests/test_meals_update.py
```

---

## Task 2：`PATCH /api/meals/{id}` 的 `cost`

**Files:** Modify `app/schemas/meal.py`、`app/api/routes/meals.py`；Test `tests/test_meals_cost.py`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_meals_cost.py` 檔尾加（`_meal` helper 是 Task 1 加的）：

```python
async def _create(client, user, cost=None) -> int:
    response = await client.post("/api/meals", headers=auth(user), json=_meal(cost=cost))
    return response.json()["id"]


async def test_patch_cost_updates_the_existing_expense(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create(client, user, cost="180")

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"cost": "200"}
    )

    assert response.status_code == 200
    assert response.json()["cost"] == "200.00"
    amounts = (await db_session.scalars(select(Expense.amount))).all()
    assert [str(a) for a in amounts] == ["200.00"]  # 改的是同一筆，不是多一筆


async def test_patch_cost_creates_an_expense_when_there_was_none(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create(client, user)

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"cost": "90"}
    )

    assert response.json()["cost"] == "90.00"
    expense = await db_session.scalar(select(Expense))
    assert expense is not None
    assert expense.meal_id == meal_id
    assert expense.category is ExpenseCategory.FOOD
    # 跟記一餐帶 cost 一樣：錢屬於吃那一餐的時間，不是補上金額的時間。
    assert expense.spent_at.isoformat() == "2026-12-15T04:00:00+00:00"


async def test_patch_cost_null_deletes_the_expense(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create(client, user, cost="180")

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"cost": None}
    )

    assert response.json()["cost"] is None
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 0


async def test_patch_without_cost_leaves_the_expense_alone(client, db_session):
    user = await create_user(db_session)
    meal_id = await _create(client, user, cost="180")

    await client.patch(f"/api/meals/{meal_id}", headers=auth(user), json={"note": "x"})

    amounts = (await db_session.scalars(select(Expense.amount))).all()
    assert [str(a) for a in amounts] == ["180.00"]


async def test_patch_with_a_rejected_cost_changes_nothing(client, db_session):
    """cost = 0 被 Pydantic 擋下時，同一個請求裡的 note 也不能改。"""
    user = await create_user(db_session)
    meal_id = await _create(client, user, cost="180")

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(user), json={"note": "不該被存", "cost": "0"}
    )

    assert response.status_code == 422
    meal = await db_session.get(Meal, meal_id)
    assert meal is not None
    assert meal.note is None
    amounts = (await db_session.scalars(select(Expense.amount))).all()
    assert [str(a) for a in amounts] == ["180.00"]


async def test_patch_cost_on_someone_elses_meal_is_404_and_changes_nothing(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    meal_id = await _create(client, alice, cost="180")

    response = await client.patch(
        f"/api/meals/{meal_id}", headers=auth(bob), json={"cost": None}
    )

    assert response.status_code == 404
    assert await db_session.scalar(select(func.count()).select_from(Expense)) == 1


async def test_update_meal_commits_exactly_once():
    """原始碼掃描，同 test_create_meal_commits_exactly_once：餐點的欄位與餐費
    要嘛都改、要嘛都不改，靠的是只有一次 commit。"""
    import inspect

    from app.api.routes.meals import update_meal

    assert inspect.getsource(update_meal).count("await db.commit()") == 1
```

- [ ] **Step 2: 跑測試確認它失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py -q
```

Expected：`…updates_the_existing_expense`、`…creates_an_expense…`、`…null_deletes…` FAIL（`cost` 被忽略）；`…leaves_the_expense_alone`、`…on_someone_elses_meal…`、`…commits_exactly_once` PASS（現況）；`…rejected_cost_changes_nothing` **FAIL 或 PASS 都可能**——現在 `cost` 被 Pydantic 忽略（`extra="ignore"`），請求會 200 並改掉 note → 應該 FAIL。照實回報。

- [ ] **Step 3: 實作**

`app/schemas/meal.py` 的 `MealUpdateRequest`，`note` 之後加：

```python
    # 編輯餐點規格 §3.2：不帶＝不動；數字＝改那筆餐費或補一筆；null＝刪掉餐費。
    # null 是合法的（「拿掉金額」），所以不在下面驗證器的 non_nullable 集合裡。
    # 限制同 MealCreateRequest.cost。
    cost: Decimal | None = Field(default=None, gt=0, max_digits=10, decimal_places=2)
```

docstring 的「三個欄位」改成「四個欄位」並加一句 `cost` 的說明。

`app/api/routes/meals.py` 的 `update_meal`，把 `for field, value in payload.model_dump(exclude_unset=True).items(): setattr(meal, field, value)` 換成：

```python
    changes = payload.model_dump(exclude_unset=True)
    cost_was_sent = "cost" in changes
    new_cost = changes.pop("cost", None)

    for field, value in changes.items():
        setattr(meal, field, value)

    if cost_was_sent:
        # 前提：一餐最多一筆餐費（見 _costs_by_meal）。取 id 最小的那一筆，
        # 跟回應裡顯示的是同一筆。
        existing = await db.scalar(
            select(Expense).where(Expense.meal_id == meal.id).order_by(Expense.id).limit(1)
        )
        if new_cost is None:
            if existing is not None:
                await db.delete(existing)
        elif existing is not None:
            existing.amount = new_cost
        else:
            # 跟 create_meal 的 cost 同一個形狀：錢屬於吃那一餐的時間。
            db.add(
                Expense(
                    user_id=user.id,
                    meal_id=meal.id,
                    category=ExpenseCategory.FOOD,
                    amount=new_cost,
                    spent_at=meal.eaten_at,
                    note=None,
                )
            )
```

docstring 開頭改成「改餐點本身：`eaten_at`／`meal_type`／`note`，以及這一餐的餐費 `cost`（編輯餐點規格 §3.2）」，並加一句：**餐點的欄位與餐費在同一次 commit**——`test_update_meal_commits_exactly_once` 會掃。

> 已知的落差（不在這次範圍）：用這個端點同時改 `eaten_at` 時，**既有**餐費的 `spent_at` 不跟著動。前端這次不提供改時間（規格 §1.3），在 docstring 寫一句即可。

- [ ] **Step 4: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_meals_cost.py tests/test_meals_update.py -q
```

- [ ] **Step 5: 突變測試**

1. 把 `existing.amount = new_cost` 改成走「新增一筆」的分支（刪掉 `elif existing is not None:` 那兩行）→ Expected：`…updates_the_existing_expense` **FAIL**（變兩筆）。改回來。
2. 在 `if cost_was_sent:` 區塊之前多加一個 `await db.commit()` → Expected：`test_update_meal_commits_exactly_once` **FAIL**。改回來。

- [ ] **Step 6: 全部後端測試、ruff、mypy**

- [ ] **Step 7: Commit**

```
feat(meals): PATCH /api/meals/{id} 可以改、補、拿掉餐費

cost 不帶＝不動、數字＝改那筆或補一筆（category=food、spent_at=eaten_at）、
null＝刪掉。跟餐點的欄位在同一次 commit，有原始碼掃描守著。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/meal.py app/api/routes/meals.py tests/test_meals_cost.py
```

---

## Task 3：`PATCH /api/meals/{id}/items/{item_id}`

**Files:** Modify `app/schemas/meal.py`、`app/api/routes/meals.py`；Test `tests/test_meals_items.py`；Regenerate `frontend/src/api/schema.d.ts`；Modify（型別修正）`frontend/tests/timeline.test.ts`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_meals_items.py` imports 補上 `from app.models.user import UserRole` 與 `create_pending_revision`（從 `tests.factories`）。檔尾加：

```python
async def _meal_with_one_item(client, user, food, quantity="100", portion_id=None):
    item = {"food_id": food.id, "quantity": quantity}
    if portion_id is not None:
        item["portion_id"] = portion_id
    response = await client.post(
        "/api/meals", headers=auth(user), json=_create_payload(items=[item])
    )
    body = response.json()
    return body["id"], body["items"][0]["id"]


async def test_patching_quantity_recomputes_grams_and_totals(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user, kcal=100)
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "250"},
    )

    assert response.status_code == 200
    body = response.json()
    assert body["items"][0]["quantity_g"] == "250.00"
    assert body["kcal"] == "250.00"


async def test_switching_to_a_portion_uses_its_grams(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": portion.id, "quantity": "2"},
    )

    assert response.json()["items"][0]["quantity_g"] == "300.00"
    assert response.json()["items"][0]["portion_id"] == portion.id


async def test_patching_only_quantity_keeps_the_existing_portion(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(
        client, user, food, quantity="1", portion_id=portion.id
    )

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "2"},
    )

    assert response.json()["items"][0]["quantity_g"] == "300.00"


async def test_explicit_null_portion_switches_back_to_grams(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    portion = await create_portion(db_session, food=food, label="碗", grams=150)
    meal_id, item_id = await _meal_with_one_item(
        client, user, food, quantity="1", portion_id=portion.id
    )

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": None, "quantity": "80"},
    )

    item = response.json()["items"][0]
    assert item["portion_id"] is None
    assert item["quantity_g"] == "80.00"


async def test_a_portion_of_another_food_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    other_food = await create_food(db_session, created_by=user, owner=user)
    other_portion = await create_portion(db_session, food=other_food, label="盤", grams=300)
    meal_id, item_id = await _meal_with_one_item(client, user, food)

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": other_portion.id},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PORTION_FOOD_MISMATCH"


async def test_explicit_null_quantity_is_rejected(client, db_session):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    meal_id, item_id = await _meal_with_one_item(client, user, food)

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": None},
    )

    assert response.status_code == 422


async def test_patching_someone_elses_item_is_404_and_changes_nothing(client, db_session):
    alice = await create_user(db_session)
    bob = await create_user(db_session)
    food = await create_food(db_session, created_by=alice, owner=alice)
    meal_id, item_id = await _meal_with_one_item(client, alice, food, quantity="100")

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(bob),
        json={"quantity": "999"},
    )

    assert response.status_code == 404
    item = await db_session.get(MealItem, item_id)
    assert item is not None
    assert str(item.quantity_g) == "100.00"


async def test_patching_an_item_through_another_meal_is_404(client, db_session):
    """擁有權沿著 meal_items.meal_id 檢查：item 要屬於「這一餐」，
    不能只因為兩餐都是自己的就放行。"""
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, owner=user)
    _, item_id = await _meal_with_one_item(client, user, food)
    other_meal_id, _ = await _meal_with_one_item(client, user, food)

    response = await client.patch(
        f"/api/meals/{other_meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "999"},
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "MEAL_ITEM_NOT_FOUND"


async def test_patching_keeps_the_pinned_revision(client, db_session):
    """凍結歷史（handover §4.3）：改的是「吃了多少」，不是「用哪一版營養素」。
    食物後來有了新版本，改數量時仍然用記錄當下那一版。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, kcal=200)  # 全域食物
    meal_id, item_id = await _meal_with_one_item(client, user, food, quantity="100")
    pending = await create_pending_revision(db_session, food=food, created_by=admin, kcal=999)
    approve = await client.post(
        f"/api/admin/food-revisions/{pending.id}/approve", headers=auth(admin)
    )
    assert approve.status_code == 200

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"quantity": "50"},
    )

    assert response.json()["items"][0]["kcal"] == "100.00"  # 200 × 0.5，不是 999 × 0.5
```

> `create_pending_revision` 的簽章照 `tests/test_meals_read.py:178-224` 的用法；如果參數不同，以 `tests/factories.py` 為準並回報。

- [ ] **Step 2: 跑測試確認它失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_meals_items.py -q
```

Expected：新的 9 條全部 FAIL（405 Method Not Allowed——路由不存在）。既有的 PASS。

- [ ] **Step 3: 實作**

`app/schemas/meal.py`，`MealItemCreateRequest` 之後加：

```python
class MealItemUpdateRequest(BaseModel):
    """`PATCH /api/meals/{id}/items/{item_id}`（編輯餐點規格 §3.1）：只改
    「吃了多少」。

    **不收 `food_id`**——換食物是刪掉再加一項。`portion_id` 的顯式 null 合法
    （改回直接輸入數量）；`quantity` 是 NOT NULL，顯式 null 擋在這裡
    （跟 `MealUpdateRequest` 同一個坑：不擋會一路流到 asyncpg 變成 500）。
    """

    quantity: Decimal | None = Field(
        default=None, gt=0, le=10000, max_digits=8, decimal_places=2
    )
    portion_id: int | None = Field(default=None, gt=0, le=_MAX_BIGINT)

    @model_validator(mode="after")
    def _reject_explicit_null_quantity(self) -> "MealItemUpdateRequest":
        if "quantity" in self.model_fields_set and self.quantity is None:
            raise ValueError("quantity 可以省略，但不接受 null")
        return self
```

`app/api/routes/meals.py`：import `MealItemUpdateRequest`；在 `delete_meal_item` **之前**加：

```python
@router.patch("/{meal_id}/items/{item_id}", response_model=MealResponse)
async def update_meal_item(
    meal_id: ResourceId,
    item_id: ResourceId,
    payload: MealItemUpdateRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> MealResponse:
    """改一個項目的數量或份量（編輯餐點規格 §3.1）。

    擁有權同 `delete_meal_item`：這一餐是自己的，而且 item 屬於**這一餐**。

    **`food_revision_id` 不動**——凍結歷史（handover §4.3）：改的是「吃了
    多少」，不是「用哪一版營養素」。`quantity_g` 用跟 `_resolve_item` 同一套
    規則重算：份量看得到、屬於這個食物，`grams × quantity` 四捨五入到分。
    """
    meal = await _load_owned_meal(db, meal_id, user)

    item = await db.scalar(
        select(MealItem).where(MealItem.id == item_id, MealItem.meal_id == meal.id)
    )
    if item is None:
        raise NotFoundError("MEAL_ITEM_NOT_FOUND", "找不到該項目")

    changes = payload.model_dump(exclude_unset=True)
    quantity: Decimal = changes.get("quantity", item.quantity)
    portion_id: int | None = changes["portion_id"] if "portion_id" in changes else item.portion_id

    if portion_id is None:
        quantity_g = quantity
    else:
        revision = await db.get(FoodRevision, item.food_revision_id)
        portion = await load_visible_portion(db, portion_id, user)
        if revision is None or portion.food_id != revision.food_id:
            raise UnprocessableEntityError(
                "PORTION_FOOD_MISMATCH", "這個份量不屬於指定的食物"
            )
        quantity_g = (portion.grams * quantity).quantize(_CENTS, rounding=ROUND_HALF_UP)

    item.quantity = quantity
    item.portion_id = portion_id
    item.quantity_g = quantity_g
    await db.commit()
    await db.refresh(meal)
    # expire_on_commit=False：不 refresh 的話，下面的 join 查詢從 identity map
    # 拿回同一個 item，數量還是使用者給的精度（"250"），不是 NUMERIC(8,2) 的
    # "250.00"——跟 _item_response 註解裡說的是同一個坑。
    await db.refresh(item)

    rows = (
        await db.execute(
            _item_join_query().where(MealItem.meal_id == meal.id).order_by(MealItem.id)
        )
    ).all()
    costs = await _costs_by_meal(db, [meal.id])
    return _build_meal_response(meal, rows, costs.get(meal.id))
```

> `FoodRevision` 有 `food_id`（`_item_join_query` 的 join 就是用它）。`load_visible_portion` 看不到 → 它自己拋 404。

**同一個檔案還要改一個註解：** `app/schemas/meal.py` 的 `MealItemResponse` 裡寫「quantity_g 才是所有計算的依據，寫入當下就換算好、之後永不改變（見計畫陷阱 1）」。現在它會被這個端點改，把後半句改成：

```python
    # quantity + portion_id 只用於顯示；quantity_g 才是所有計算的依據，
    # 寫入時（建立或 PATCH 這一項時）就換算好——讀取時不重算，所以份量後來
    # 改了重量，舊的紀錄不跟著變（見計畫陷阱 1）。
```

（先讀原註解確認「計畫陷阱 1」講的是「讀取時不重算」；如果不是，照實回報，不要硬套。）

- [ ] **Step 4: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_meals_items.py tests/test_meals_read.py -q
```

- [ ] **Step 5: 突變測試**

1. 把 `portion.food_id != revision.food_id` 的檢查拿掉 → Expected：`test_a_portion_of_another_food_is_rejected` **FAIL**。改回來。
2. 在函式裡把 `item.food_revision_id` 改成食物目前的版本（例如 `food = await db.get(Food, revision.food_id); item.food_revision_id = food.current_revision_id`）→ Expected：`test_patching_keeps_the_pinned_revision` **FAIL**。改回來。

- [ ] **Step 6: 全部後端測試、ruff、mypy**

- [ ] **Step 7: 重新產生 `schema.d.ts`**

在 repo 根目錄：

```bash
PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > frontend/openapi.tmp.json
cd frontend
npx openapi-typescript openapi.tmp.json -o src/api/schema.d.ts
rm openapi.tmp.json
git diff --stat src/api/schema.d.ts
npm run -s typecheck
```

Expected：`schema.d.ts` 多了 `MealResponse.cost`、`MealUpdateRequest.cost`、`MealItemUpdateRequest`、新的 PATCH 路徑。**typecheck 會因為 `MealResponse.cost` 是必填而紅**：`frontend/tests/timeline.test.ts` 的 `meal()` 是型別化成 `Meal` 的 fixture，加上 `cost: null,`。其他地方紅了就回報（不要自己大改）。確認 `schema.d.ts` 是 LF。

- [ ] **Step 8: 前端測試**

```
npm run -s test
```

Expected：全部 PASS（其他前端測試的 fixture 是 `json(...)` 不經過型別，不受影響）。

- [ ] **Step 9: Commit**

```
feat(meals): PATCH 一個項目的數量或份量，營養素版本不動

PATCH /api/meals/{id}/items/{item_id}：只收 quantity 與 portion_id
（不能換食物）。quantity_g 用跟 _resolve_item 同一套規則重算；
food_revision_id 不動——凍結歷史：改的是吃了多少，不是用哪一版營養素。

順便重新產生 schema.d.ts（MealResponse.cost、MealUpdateRequest.cost、
MealItemUpdateRequest）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/meal.py app/api/routes/meals.py tests/test_meals_items.py frontend/src/api/schema.d.ts frontend/tests/timeline.test.ts
```

---
## Task 4：從記一餐抽出 `FoodPicker`、`usePortionQuantity`／`PortionQuantityFields`、`hasFieldError`

**這是純重構：記一餐的行為一個字都不變。** 證明是 `frontend/tests/log-meal.test.tsx` **一條都不改**而全部綠（`git diff master -- frontend/tests/log-meal.test.tsx` 要是空的）。e2e 依賴的 id（`#portion`）與文字（「搜尋食物」「份量」「份量選項」「已選擇：{名稱}」「記錄」）全部保留。

**Files:**
- Create: `frontend/src/components/FoodPicker.tsx`、`FoodPicker.module.css`、`PortionQuantityFields.tsx`、`PortionQuantityFields.module.css`
- Modify: `frontend/src/api/errors.ts`、`frontend/src/screens/LogMeal.tsx`、`LogMeal.module.css`
- Test: `frontend/tests/errors.test.ts`（加）、`frontend/tests/food-picker.test.tsx`（新）、`frontend/tests/portion-quantity-fields.test.tsx`（新）

- [ ] **Step 1: 寫新元件的測試（會紅：模組不存在）**

`frontend/tests/errors.test.ts`：import 改成 `import { ApiError, hasFieldError, parseErrorResponse } from "../src/api/errors";`，檔尾加：

```ts
describe("hasFieldError", () => {
	function validationError(locs: unknown[]) {
		return new ApiError(422, "VALIDATION_ERROR", "格式錯誤", {
			errors: locs.map((loc) => ({ loc, msg: "x" })),
		});
	}

	it("loc 裡有這個欄位名就是", () => {
		expect(hasFieldError(validationError([["body", "cost"]]), "cost")).toBe(
			true,
		);
	});

	it("別的欄位不算——份量填錯不能被說成金額錯誤", () => {
		expect(
			hasFieldError(
				validationError([["body", "items", 0, "quantity"]]),
				"cost",
			),
		).toBe(false);
	});

	it("details 沒有 errors 陣列時不丟例外", () => {
		expect(
			hasFieldError(new ApiError(422, "VALIDATION_ERROR", "x"), "cost"),
		).toBe(false);
	});
});
```

`frontend/tests/food-picker.test.tsx`（新）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { FoodPicker } from "../src/components/FoodPicker";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const RICE = {
	id: 1,
	name: "滷肉飯",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g",
		kcal: "180.00",
		protein_g: "6.50",
		fat_g: "7.00",
		carb_g: "22.00",
	},
};
const NO_NUTRITION = {
	id: 2,
	name: "沒有營養素的食物",
	brand: null,
	is_global: true,
	nutrition: null,
};
const SEARCHED = { ...RICE, id: 3, name: "白飯" };

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("FoodPicker", () => {
	it("點常吃的食物，把那個食物交給 onSelect", async () => {
		mockApi({
			"/api/foods/frequent": () => json([RICE, NO_NUTRITION]),
			"/api/foods/recent": () => json([RICE]),
		});
		const onSelect = vi.fn();
		render(wrap(<FoodPicker onSelect={onSelect} />));

		await userEvent.click(await screen.findByRole("button", { name: "滷肉飯" }));

		expect(onSelect).toHaveBeenCalledWith(RICE);
	});

	it("常吃與最近吃重複的食物只出現一次", async () => {
		mockApi({
			"/api/foods/frequent": () => json([RICE]),
			"/api/foods/recent": () => json([RICE]),
		});
		render(wrap(<FoodPicker onSelect={vi.fn()} />));

		await screen.findByRole("button", { name: "滷肉飯" });
		expect(screen.getAllByRole("button", { name: "滷肉飯" })).toHaveLength(1);
	});

	it("沒有生效營養素的食物不能選，旁邊寫原因", async () => {
		mockApi({
			"/api/foods/frequent": () => json([NO_NUTRITION]),
			"/api/foods/recent": () => json([]),
		});
		render(wrap(<FoodPicker onSelect={vi.fn()} />));

		expect(
			await screen.findByRole("button", { name: "沒有營養素的食物" }),
		).toBeDisabled();
		expect(
			screen.getByText("這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
	});

	it("搜尋到的食物也能選", async () => {
		mockApi({
			"/api/foods/frequent": () => json([]),
			"/api/foods/recent": () => json([]),
			"/api/foods?q=": () => json([SEARCHED]),
		});
		const onSelect = vi.fn();
		render(wrap(<FoodPicker onSelect={onSelect} />));

		await userEvent.type(screen.getByLabelText("搜尋食物"), "白飯");
		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));

		expect(onSelect).toHaveBeenCalledWith(SEARCHED);
	});
});
```

`frontend/tests/portion-quantity-fields.test.tsx`（新）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import {
	type PortionChoice,
	PortionQuantityFields,
	usePortionQuantity,
} from "../src/components/PortionQuantityFields";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const MY_BOWL = {
	id: 7,
	label: "我的碗",
	grams: "220.00",
	is_default: true,
	is_global: false,
};
const PLATE = {
	id: 9,
	label: "盤",
	grams: "300.00",
	is_default: false,
	is_global: true,
};

function Harness({
	initial,
	idPrefix,
}: {
	initial?: { choice: PortionChoice; quantity: string };
	idPrefix?: string;
}) {
	const state = usePortionQuantity(1, initial);
	return (
		<>
			<PortionQuantityFields state={state} unit="ml" idPrefix={idPrefix} />
			<output data-testid="portion-id">{String(state.portionId)}</output>
		</>
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
	mockApi({ "/api/foods/1/portions": () => json([MY_BOWL, PLATE]) });
});

describe("usePortionQuantity／PortionQuantityFields", () => {
	it("沒有給初始值：用預設份量、數量 1", async () => {
		render(wrap(<Harness />));

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);
		expect(screen.getByLabelText("份量")).toHaveValue("1");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("份");
	});

	it("給了「直接輸入」的初始值：預設份量不能把它蓋掉", async () => {
		// 編輯一個「直接輸入 80 ml」的項目時，食物後來才設的預設份量
		// 不能把它變成 80 碗。
		render(wrap(<Harness initial={{ choice: "manual", quantity: "80" }} />));

		await screen.findByRole("option", { name: "我的碗" });
		expect(screen.getByLabelText("份量選項")).toHaveValue("");
		expect(screen.getByLabelText("份量")).toHaveValue("80");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("ml");
		expect(screen.getByTestId("portion-id")).toHaveTextContent("null");
	});

	it("給了某個份量的初始值：選的就是那個份量", async () => {
		render(wrap(<Harness initial={{ choice: 9, quantity: "2" }} />));

		await screen.findByRole("option", { name: "盤" });
		expect(screen.getByLabelText("份量選項")).toHaveValue("9");
		expect(screen.getByTestId("portion-id")).toHaveTextContent("9");
	});

	it("idPrefix 加在每個 id 前面，標籤照樣對得上", async () => {
		render(wrap(<Harness idPrefix="item-5-" />));

		await screen.findByRole("option", { name: "我的碗" });
		expect(screen.getByLabelText("份量選項")).toHaveAttribute(
			"id",
			"item-5-portion",
		);
		expect(screen.getByLabelText("份量")).toHaveAttribute(
			"aria-describedby",
			"item-5-quantity-unit",
		);
		expect(screen.getByTestId("item-5-quantity-unit")).toBeInTheDocument();
	});

	it("選份量改的是 portionId", async () => {
		render(wrap(<Harness />));
		await screen.findByRole("option", { name: "盤" });

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "9");

		expect(screen.getByTestId("portion-id")).toHaveTextContent("9");
	});
});
```

> 「動過數量就鎖住」與「自己的預設優先於公開的」已經由 `log-meal.test.tsx` 守著（它一條都不改、全部綠就是證明），這裡不重複。

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/errors.test.ts tests/food-picker.test.tsx tests/portion-quantity-fields.test.tsx
```

Expected：`errors.test.ts` 的三條 `hasFieldError` FAIL（不存在）；另外兩個檔案整個 FAIL（模組找不到）。

- [ ] **Step 3: `hasFieldError`**

`frontend/src/api/errors.ts` 檔尾加：

```ts
/** 422 `VALIDATION_ERROR` 是不是出在某個欄位（看 `details.errors[].loc`）。
 *
 *  一個請求可能有好幾個欄位會被擋——記一餐的 `cost` 與 `items[0].quantity`
 *  是同一次 POST——只有真的是那個欄位才顯示那個欄位的訊息，不然份量填錯
 *  會被誤報成「金額格式不對」。原本是 `LogMeal.tsx` 裡的
 *  `isCostValidationError`，編輯餐點也要用，所以搬到這裡。
 *
 *  **不看 `error.code`**：呼叫端自己判斷是不是 `VALIDATION_ERROR`
 *  （跟原本的函式一樣）。 */
export function hasFieldError(error: ApiError, field: string): boolean {
	const raw = error.details.errors;
	if (!Array.isArray(raw)) return false;
	return raw.some((item) => {
		if (typeof item !== "object" || item === null) return false;
		const loc = (item as { loc?: unknown }).loc;
		return Array.isArray(loc) && loc.includes(field);
	});
}
```

- [ ] **Step 4: `PortionQuantityFields`**

`frontend/src/components/PortionQuantityFields.module.css`（新；從 `LogMeal.module.css` 搬過來）：

```css
.unit {
	font-size: 12px;
	color: var(--color-text-muted);
}
```

`frontend/src/components/PortionQuantityFields.tsx`（新）：

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import type { Portion } from "../api/foods";
import { queryKeys } from "../api/queries";
import { pickDefaultPortion } from "../lib/portions";
import styles from "./PortionQuantityFields.module.css";

/** 份量的選擇（食物份量規格 §6）：
 *    null     → 使用者還沒動過，用推導出來的預設份量（有的話）
 *    "manual" → 使用者選了「直接輸入數量」
 *    number   → 使用者選了某個份量
 *
 *  **不用 effect 在份量清單到的時候寫 state**：預設份量是從清單推導的，
 *  使用者一旦手動選過就以使用者為準，不會被重新抓到的清單蓋回去。
 *
 *  編輯一個已經記下的項目時，初始值直接給 `item.portion_id ?? "manual"`
 *  （不是 null）——那一項當初怎麼記就是怎麼記，食物後來才設的預設份量
 *  不能把「直接輸入 80 g」變成 80 碗。 */
export type PortionChoice = number | "manual" | null;

/** 份量下拉與數量的狀態。放在 hook 而不是元件裡：送出時呼叫端要拿
 *  `portionId` 與 `quantity` 組 body（記一餐、編輯餐點都是）。
 *
 *  `foodId` 是 `null` 時不抓份量清單。 */
export function usePortionQuantity(
	foodId: number | null,
	initial?: { choice: PortionChoice; quantity: string },
) {
	const [portionChoice, setPortionChoice] = useState<PortionChoice>(
		initial?.choice ?? null,
	);
	const [quantity, setQuantityValue] = useState(initial?.quantity ?? "1");

	const portionsQuery = useQuery({
		queryKey: queryKeys.portions(foodId ?? 0),
		queryFn: () => apiFetch<Portion[]>(`/api/foods/${foodId}/portions`),
		enabled: foodId !== null,
	});
	const portions = portionsQuery.data ?? [];

	const defaultPortion = pickDefaultPortion(portions);
	const portionId =
		portionChoice === "manual"
			? null
			: (portionChoice ?? defaultPortion?.id ?? null);

	return {
		portions,
		portionId,
		quantity,
		setQuantity(value: string) {
			// 使用者一動數量，就把「此刻看到的單位」鎖住：份量清單可能晚到
			// （或是快取裡過期的空清單被換掉），若還是 null，晚到的預設份量
			// 會把使用者輸入的「200」（當時提示是 g）變成 200 份。
			if (portionChoice === null) {
				setPortionChoice(portionId ?? "manual");
			}
			setQuantityValue(value);
		},
		choosePortion(choice: number | "manual") {
			setPortionChoice(choice);
		},
		/** 換了一個食物：份量回到「還沒動過」，數量不動（記一餐原本的行為）。 */
		resetChoice() {
			setPortionChoice(null);
		},
		/** 存好之後：兩個都回到初始狀態。 */
		reset() {
			setPortionChoice(null);
			setQuantityValue("1");
		},
	};
}

export type PortionQuantity = ReturnType<typeof usePortionQuantity>;

type Props = {
	state: PortionQuantity;
	/** 直接輸入時數量的單位（食物的 `base_unit`，`g` 或 `ml`）。 */
	unit: string;
	/** 加在每個 id 前面。記一餐不帶——id 要跟原本一字不差，
	 *  `e2e/portions.spec.ts` 用 `#portion option:checked` 找下拉。 */
	idPrefix?: string;
};

/** 份量下拉＋數量＋單位提示。**回 fragment**：欄位直接落在呼叫端的
 *  `<form>` 裡，版面與樣式（`.form input`、`.form select`）跟抽出來之前
 *  一樣。 */
export function PortionQuantityFields({ state, unit, idPrefix = "" }: Props) {
	const portionInputId = `${idPrefix}portion`;
	const quantityInputId = `${idPrefix}quantity`;
	const unitId = `${idPrefix}quantity-unit`;

	return (
		<>
			{state.portions.length > 0 && (
				<>
					<label htmlFor={portionInputId}>份量選項</label>
					<select
						id={portionInputId}
						value={state.portionId ?? ""}
						onChange={(event) =>
							state.choosePortion(
								event.target.value === ""
									? "manual"
									: Number(event.target.value),
							)
						}
					>
						<option value="">直接輸入數量</option>
						{state.portions.map((portion) => (
							<option key={portion.id} value={portion.id}>
								{portion.label}
							</option>
						))}
					</select>
				</>
			)}

			<label htmlFor={quantityInputId}>份量</label>
			<input
				id={quantityInputId}
				type="text"
				inputMode="decimal"
				value={state.quantity}
				aria-describedby={unitId}
				onChange={(event) => state.setQuantity(event.target.value)}
				required
			/>
			{/* 選了份量時數量是「幾份」；直接輸入時是公克（或毫升）——
			    預設的「1」在直接輸入模式下是 1 g，這個提示讓它看得出來。 */}
			<span id={unitId} className={styles.unit} data-testid={unitId}>
				{state.portionId !== null ? "份" : unit}
			</span>
		</>
	);
}
```

> `portionsQuery.data` 的型別是 `Portion[] | null`（`apiFetch` 在 204 時回 null）；`?? []` 一起處理掉 `undefined` 與 `null`——跟原本 `data !== undefined && data !== null && length > 0` 等價。

- [ ] **Step 5: `FoodPicker`**

`frontend/src/components/FoodPicker.module.css`（新；從 `LogMeal.module.css` **搬**過來，`LogMeal.module.css` 刪掉這幾段）：

```css
.search {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	font-size: 12px;
	color: var(--color-text-muted);
}

/* 字級不在這裡設——index.css 的全域規則保證 input ≥ 16px。 */
.search input {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
}

.foods {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-wrap: wrap;
	gap: var(--space-2);
}

.foods li {
	display: flex;
	align-items: center;
	gap: var(--space-1);
	padding: var(--space-1) var(--space-2);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	font-size: 12px;
	color: var(--color-text-muted);
}

.foods button {
	min-height: 44px;
	border: none;
	background: transparent;
	color: var(--color-text);
	font-size: 14px;
	font-weight: 600;
}
```

`LogMeal.module.css` 裡對應改成（`.search input` 從共用選擇器裡拿掉，`.search`／`.foods*`／`.unit` 整段刪掉）：

```css
/* 字級不在這裡設——index.css 的全域規則保證 input/select ≥ 16px。 */
.form input:not([type="file"]),
.form select {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-surface);
	color: var(--color-text);
}
```

`frontend/src/components/FoodPicker.tsx`（新）——**從 `LogMeal.tsx` 原樣搬**，包括 `NO_REVISION_MESSAGE`、`NutritionPreview`（含那段長註解）、`dedupeById`、兩個 query 與搜尋：

```tsx
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { type Food, useFoodSearch } from "../api/foods";
import { queryKeys } from "../api/queries";
import { formatMacro } from "../lib/decimal";
import { useDebounced } from "../lib/use-debounced";
import styles from "./FoodPicker.module.css";
import { FoodResultList } from "./FoodResultList";

/** `FoodResponse.nutrition` 為 `null` 時要顯示的說明。跟 `FoodDetail.tsx`
 *  「目前生效的營養素」區塊的空狀態用同一句文字——不重寫一份是為了不讓
 *  兩處的說法飄走。 */
const NO_REVISION_MESSAGE = "這個食物還沒有生效的營養素資料";

// （NutritionPreview 與它上面那整段註解，從 LogMeal.tsx 原封不動搬過來）
function NutritionPreview({ nutrition }: { nutrition: Food["nutrition"] }) {
	if (nutrition === null) {
		return <span className="food-no-nutrition">{NO_REVISION_MESSAGE}</span>;
	}
	return <span>{formatMacro(nutrition.kcal)} kcal</span>;
}

function dedupeById(lists: Food[][]): Food[] {
	const seen = new Set<number>();
	const result: Food[] = [];
	for (const list of lists) {
		for (const food of list) {
			if (seen.has(food.id)) continue;
			seen.add(food.id);
			result.push(food);
		}
	}
	return result;
}

type Props = {
	/** 選了一個食物。`nutrition === null` 的食物按鈕是 disabled，不會走到這裡。 */
	onSelect: (food: Food) => void;
};

/** 搜尋框＋常吃／最近吃清單（記一餐與編輯餐點的「加一項」共用）。
 *
 *  **回 fragment**：搜尋框、結果、清單直接落在呼叫端的版面裡，記一餐的
 *  畫面結構跟抽出來之前一樣。
 *
 *  食物庫不用這個元件——那邊選完是進詳情頁，而且有 scope 選擇器
 *  （見 `useFoodSearch` 的註解）。 */
export function FoodPicker({ onSelect }: Props) {
	const [searchInput, setSearchInput] = useState("");

	// P1 規格第 11 節：這兩個端點的索引就是為了這個畫面顧的——
	// 「記一餐」是每天走最多次的路徑（規格 §7.1）。
	const frequentQuery = useQuery({
		queryKey: queryKeys.frequentFoods,
		queryFn: () => apiFetch<Food[]>("/api/foods/frequent"),
	});
	const recentQuery = useQuery({
		queryKey: queryKeys.recentFoods,
		queryFn: () => apiFetch<Food[]>("/api/foods/recent"),
	});

	// 規格 §5.4：跟食物庫共用同一支 useFoodSearch query hook，不共用元件——
	// 兩邊選完之後的去向不一樣。這裡不給 scope 選擇器：要的是「這個字能不能
	// 找到食物」，不是瀏覽「我建立的」跟「公開的」的差異。
	const debouncedSearch = useDebounced(searchInput, 300);
	const hasSearchQuery = debouncedSearch.trim() !== "";
	const searchQuery = useFoodSearch(debouncedSearch, "all");

	const foods = dedupeById([frequentQuery.data ?? [], recentQuery.data ?? []]);

	return (
		<>
			<div className={styles.search}>
				<label htmlFor="food-search-input">搜尋食物</label>
				<input
					id="food-search-input"
					type="text"
					value={searchInput}
					onChange={(event) => setSearchInput(event.target.value)}
				/>
			</div>

			{hasSearchQuery && (
				<>
					{searchQuery.isLoading && <p>搜尋中…</p>}
					<FoodResultList
						foods={searchQuery.data ?? []}
						noNutritionMessage={NO_REVISION_MESSAGE}
						renderAction={(food) => (
							<button
								type="button"
								disabled={food.nutrition === null}
								onClick={() => onSelect(food)}
							>
								{food.name}
							</button>
						)}
					/>
				</>
			)}

			{frequentQuery.isLoading && <p>載入中…</p>}

			<ul className={styles.foods}>
				{foods.map((food) => (
					<li key={food.id}>
						<button
							type="button"
							disabled={food.nutrition === null}
							onClick={() => onSelect(food)}
						>
							{food.name}
						</button>
						<NutritionPreview nutrition={food.nutrition} />
					</li>
				))}
			</ul>
		</>
	);
}
```

> **「原封不動搬過來」的註解要真的搬**，不要只寫「（從 LogMeal.tsx 搬過來）」。上面的程式碼為了計畫篇幅省略了 `NutritionPreview` 上方那段很長的註解——實作時把 `LogMeal.tsx` 裡那段完整複製過去，然後從 `LogMeal.tsx` 刪掉。

- [ ] **Step 6: `LogMeal` 改用它們**

`frontend/src/screens/LogMeal.tsx`：

1. imports：刪掉 `useQuery`（留 `useMutation, useQueryClient`）、`useFoodSearch`、`FoodResultList`、`formatMacro`、`pickDefaultPortion`、`useDebounced`；`ApiError` 那行改成 `import { ApiError, hasFieldError } from "../api/errors";`；加上

```tsx
import { FoodPicker } from "../components/FoodPicker";
import {
	PortionQuantityFields,
	usePortionQuantity,
} from "../components/PortionQuantityFields";
```

`type Portion` 不再用到，刪掉；`type Food` 仍然要（`selectedFood`）。

2. 刪掉 `NO_REVISION_MESSAGE`、`isCostValidationError`、`NutritionPreview`、`dedupeById`（都搬走了）。
3. 元件裡刪掉 `portionChoice`／`quantity` 兩個 state（連同上面那段三態註解——它搬到 `PortionChoice` 了）、`searchInput`、`frequentQuery`、`recentQuery`、`debouncedSearch`／`hasSearchQuery`／`searchQuery`、`portionsQuery`、`defaultPortion`／`portionId`、`foods`。在 `selectedFood` 那行之後加：

```tsx
	const portion = usePortionQuantity(selectedFood?.id ?? null);
```

4. `saveMeal` 的 body：`quantity,` → `quantity: portion.quantity,`；`...(portionId !== null ? { portion_id: portionId } : {})` → `...(portion.portionId !== null ? { portion_id: portion.portionId } : {})`（旁邊的註解保留）。
5. `onSuccess`：`setPortionChoice(null); setQuantity("1");` → `portion.reset();`。
6. `onError` 的金額判斷：`isCostValidationError(caught)` → `hasFieldError(caught, "cost")`（上面的註解保留）。
7. `selectFood`：

```tsx
	function selectFood(food: Food) {
		setSelectedFood(food);
		portion.resetChoice();
	}
```

8. JSX：`<h1>記一餐</h1>` 之後，從搜尋框的 `<div className={styles.search}>` 到常吃清單的 `</ul>` 整段換成 `<FoodPicker onSelect={selectFood} />`。表單裡從 `{portionsQuery.data !== undefined && …` 到 `quantity-unit` 的 `</span>` 整段換成：

```tsx
					<PortionQuantityFields
						state={portion}
						unit={selectedFood.nutrition?.base_unit ?? "g"}
					/>
```

- [ ] **Step 7: 跑測試**

```
npx vitest run tests/log-meal.test.tsx tests/errors.test.ts tests/food-picker.test.tsx tests/portion-quantity-fields.test.tsx tests/css-tokens.test.ts
git diff master -- tests/log-meal.test.tsx
```

Expected：全部 PASS；`git diff` **沒有輸出**。

- [ ] **Step 8: 突變測試**

在 `usePortionQuantity` 的 `setQuantity` 裡拿掉「鎖住」那個 `if` → Expected：`log-meal.test.tsx` 的「使用者動過數量之後，晚到的份量清單不會把「200 g」變成「200 份」」**FAIL**。改回來（新檔案，`git checkout` 沒用——手動改回並重跑確認綠）。

> 這證明 `log-meal.test.tsx` 透過抽出來的 hook 仍然守著那條規則，不是空轉。

- [ ] **Step 9: 全部前端檢查**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

Expected：全部綠；前端測試數 = 基準線 + 本任務新增的條數（`errors` 3、`food-picker` 4、`portion-quantity-fields` 5，Vitest 的型別檢查會讓每個檔案多算一次）。

- [ ] **Step 10: Commit**

```
refactor(meals): 從記一餐抽出選食物與份量欄位，給編輯餐點共用

FoodPicker（搜尋＋常吃／最近吃）、usePortionQuantity＋PortionQuantityFields
（份量下拉、數量、單位提示、動過數量就鎖住），以及 hasFieldError（原本是
LogMeal 私有的 isCostValidationError）。

記一餐的行為不變：log-meal.test.tsx 一條都沒改，全部綠。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/errors.ts frontend/src/components/FoodPicker.tsx frontend/src/components/FoodPicker.module.css frontend/src/components/PortionQuantityFields.tsx frontend/src/components/PortionQuantityFields.module.css frontend/src/screens/LogMeal.tsx frontend/src/screens/LogMeal.module.css frontend/tests/errors.test.ts frontend/tests/food-picker.test.tsx frontend/tests/portion-quantity-fields.test.tsx
```

---
## Task 5：`useMeal`＋編輯畫面（這一餐、照片、刪除這一餐）

項目區在這個任務只**顯示**（Task 6 才加修改、刪除、加一項）。

**Files:**
- Create: `frontend/src/screens/EditMeal.tsx`、`EditMeal.module.css`、`EditMealItems.tsx`
- Modify: `frontend/src/api/queries.ts`、`frontend/src/api/meals.ts`、`frontend/src/api/photos.ts`、`frontend/src/screens/MealList.tsx`（只搬 `describeUploadError`）、`frontend/src/screens/LogMeal.tsx`（只換餐別清單）、`frontend/src/screens/Expenses.tsx`（只改註解）、`frontend/src/App.tsx`
- Test: `frontend/tests/queries.test.tsx`（加）、`frontend/tests/edit-meal.test.tsx`（新）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/queries.test.tsx` 檔尾加：

```tsx
describe("單一餐的 query key", () => {
	it("掛在 meals 底下——改了任何一餐，今日清單與那一餐一起重取", () => {
		const prefix = queryKeys.meals;
		expect(queryKeys.meal(5).slice(0, prefix.length)).toEqual([...prefix]);
	});

	it("移除某一餐的快取不會連帶移除今日清單", () => {
		// 刪一餐之後要 removeQueries(meal(id))（見 EditMeal 的 DeleteMeal）。
		// 這條守的是那一行不會順手清掉別的東西。
		const client = new QueryClient();
		client.setQueryData(queryKeys.meals, []);
		client.setQueryData(queryKeys.meal(5), { id: 5 });

		client.removeQueries({ queryKey: queryKeys.meal(5) });

		expect(client.getQueryData(queryKeys.meals)).toEqual([]);
		expect(client.getQueryData(queryKeys.meal(5))).toBeUndefined();
	});
});
```

`frontend/tests/edit-meal.test.tsx`（新）：

```tsx
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { AMOUNT_FORMAT_ERROR } from "../src/api/expenses";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { EditMeal } from "../src/screens/EditMeal";
import { json, type Route as MockRoute, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const ITEM = {
	id: 51,
	food_id: 1,
	food_name: "滷肉飯",
	portion_id: null,
	quantity: "200.00",
	quantity_g: "200.00",
	kcal: "360.00",
	protein_g: "13.00",
	fat_g: "14.00",
	carb_g: "44.00",
};

const MEAL = {
	id: 5,
	eaten_at: "2026-10-04T12:30:00+08:00",
	meal_type: "lunch",
	note: null,
	photo_path: null,
	cost: "180.00",
	items: [ITEM],
	kcal: "360.00",
	protein_g: "13.00",
	fat_g: "14.00",
	carb_g: "44.00",
};

const RICE = {
	id: 1,
	name: "滷肉飯",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g",
		kcal: "180.00",
		protein_g: "6.50",
		fat_g: "7.00",
		carb_g: "22.00",
	},
};

/** `extra` 排在前面：`mockApi` 依序用 `url.includes` 比對，而
 *  `/api/meals/5/photo`、`/api/meals/5/items/51` 都「包含」`/api/meals/5`。 */
function routes(meal: unknown = MEAL, extra: MockRoute[] = []): MockRoute[] {
	return [
		...extra,
		{
			method: "GET",
			path: "/api/meals/5/photo",
			handler: () =>
				new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" })),
		},
		{ method: "GET", path: "/api/meals/5", handler: () => json(meal) },
		{ method: "PATCH", path: "/api/meals/5", handler: () => json(meal) },
		{
			method: "DELETE",
			path: "/api/meals/5",
			handler: () => new Response(null, { status: 204 }),
		},
		{ path: "/api/foods/1/portions", handler: () => json([]) },
		{ path: "/api/foods/1", handler: () => json(RICE) },
		{ path: "/api/foods/frequent", handler: () => json([]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
	];
}

function newClient() {
	return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

/** 預設從總覽點進來（history 有上一頁）。`entries` 只給一個時＝直接打開網址。 */
function renderEditMeal(
	client = newClient(),
	entries: string[] = ["/", "/meals/5/edit"],
) {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={entries} initialIndex={entries.length - 1}>
				<Routes>
					<Route path="/" element={<p>總覽頁</p>} />
					<Route path="/meals/:id/edit" element={<EditMeal />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

function calls(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
) {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes(path),
	);
}

function bodyOf(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
): unknown {
	const call = calls(fetchMock, method, path)[0];
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function keysOf(spy: { mock: { calls: unknown[][] } }): unknown[] {
	return spy.mock.calls.map(
		(call) => (call[0] as { queryKey?: unknown } | undefined)?.queryKey,
	);
}

function validationError(loc: unknown[]) {
	return json(
		{
			error: {
				code: "VALIDATION_ERROR",
				message: "格式錯誤",
				details: { errors: [{ loc, msg: "x" }] },
			},
		},
		422,
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("編輯這一餐：讀取", () => {
	it("帶入目前的餐別、金額、備註與項目", async () => {
		mockApi(routes());
		renderEditMeal();

		expect(await screen.findByLabelText("餐別")).toHaveValue("lunch");
		expect(screen.getByLabelText("金額（選填）")).toHaveValue("180.00");
		expect(screen.getByLabelText("備註（選填）")).toHaveValue("");
		expect(screen.getByTestId("meal-item-51")).toHaveTextContent("滷肉飯");
	});

	it("404：找不到這一餐（可能在另一台裝置上刪了）", async () => {
		mockApi([
			{
				path: "/api/meals/5",
				handler: () =>
					json(
						{
							error: {
								code: "MEAL_NOT_FOUND",
								message: "找不到該餐點",
								details: {},
							},
						},
						404,
					),
			},
		]);
		renderEditMeal();

		expect(await screen.findByText("找不到這一餐")).toBeInTheDocument();
	});

	it("其他錯誤：說載入失敗，不是說找不到", async () => {
		mockApi([
			{
				path: "/api/meals/5",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
		]);
		renderEditMeal();

		expect(await screen.findByText("無法載入這一餐")).toBeInTheDocument();
	});

	it("沒有項目時說沒有項目", async () => {
		mockApi(routes({ ...MEAL, items: [] }));
		renderEditMeal();

		expect(await screen.findByText("這一餐沒有項目")).toBeInTheDocument();
	});
});

describe("編輯這一餐：餐別、金額、備註", () => {
	it("只改餐別：PATCH 的 body 只有 meal_type，不失效花費", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.selectOptions(await screen.findByLabelText("餐別"), "dinner");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				meal_type: "dinner",
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.meals),
		);
		expect(keysOf(invalidate)).not.toContainEqual(queryKeys.expensesAll);
	});

	it("改金額：送 cost，失效花費", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "200");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				cost: "200",
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.expensesAll),
		);
	});

	it("清空金額：送 cost: null（拿掉餐費）", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.clear(await screen.findByLabelText("金額（選填）"));
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5")).toEqual({
				cost: null,
			}),
		);
	});

	it("沒改任何東西時不能按儲存", async () => {
		mockApi(routes());
		renderEditMeal();

		await screen.findByLabelText("餐別");
		expect(screen.getByRole("button", { name: "儲存" })).toBeDisabled();
	});

	it("金額格式錯誤：顯示金額專屬訊息", async () => {
		mockApi(
			routes(MEAL, [
				{
					method: "PATCH",
					path: "/api/meals/5",
					handler: () => validationError(["body", "cost"]),
				},
			]),
		);
		renderEditMeal();

		const cost = await screen.findByLabelText("金額（選填）");
		await userEvent.clear(cost);
		await userEvent.type(cost, "0");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText(AMOUNT_FORMAT_ERROR)).toBeInTheDocument();
	});
});

describe("編輯這一餐：照片", () => {
	it("沒有照片：只有「加照片」，沒有刪除", async () => {
		mockApi(routes());
		renderEditMeal();

		expect(await screen.findByLabelText("加照片")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "刪除照片" }),
		).not.toBeInTheDocument();
	});

	it("刪除照片要先確認；取消就不送", async () => {
		const fetchMock = mockApi(
			routes({ ...MEAL, photo_path: "3/abc.jpg" }, [
				{
					method: "DELETE",
					path: "/api/meals/5/photo",
					handler: () => new Response(null, { status: 204 }),
				},
			]),
		);
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除照片" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除照片" });
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(calls(fetchMock, "DELETE", "/api/meals/5/photo")).toHaveLength(0);
	});

	it("確認刪除照片：送 DELETE，失效清單、移除這一餐的照片快取", async () => {
		const fetchMock = mockApi(
			routes({ ...MEAL, photo_path: "3/abc.jpg" }, [
				{
					method: "DELETE",
					path: "/api/meals/5/photo",
					handler: () => new Response(null, { status: 204 }),
				},
			]),
		);
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const remove = vi.spyOn(client, "removeQueries");

		expect(await screen.findByLabelText("換照片")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "刪除照片" }));
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除照片" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(calls(fetchMock, "DELETE", "/api/meals/5/photo")).toHaveLength(1),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.meals),
		);
		expect(keysOf(remove)).toContainEqual(queryKeys.mealPhoto(5));
	});
});

describe("編輯這一餐：刪除這一餐", () => {
	it("有餐費時，確認文字寫出餐費也會一起刪；取消就不送", async () => {
		const fetchMock = mockApi(routes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		expect(dialog).toHaveTextContent("這一餐的餐費 $180.00 也會一起刪除");
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(calls(fetchMock, "DELETE", "/api/meals/5")).toHaveLength(0);
	});

	it("沒有餐費時，確認文字不提餐費", async () => {
		mockApi(routes({ ...MEAL, cost: null }));
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		expect(
			screen.getByRole("alertdialog", { name: "確認刪除這一餐" }),
		).not.toHaveTextContent("餐費");
	});

	it("確認刪除：送 DELETE、移除這一餐的快取、失效相關的一切、回上一頁", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");
		const remove = vi.spyOn(client, "removeQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(calls(fetchMock, "DELETE", "/api/meals/5")).toHaveLength(1);
		expect(keysOf(remove)).toEqual(
			expect.arrayContaining([queryKeys.meal(5), queryKeys.mealPhoto(5)]),
		);
		expect(keysOf(invalidate)).toEqual(
			expect.arrayContaining([
				queryKeys.meals,
				queryKeys.dailyStats,
				queryKeys.rangeStatsAll,
				queryKeys.frequentFoods,
				queryKeys.recentFoods,
				queryKeys.expensesAll,
			]),
		);
		// 已經回到總覽頁（EditMeal 卸載了）才數：刪掉之後沒有人再去抓
		// 那一餐（會是一個 404）。
		expect(calls(fetchMock, "GET", "/api/meals/5")).toHaveLength(1);
	});

	it("直接打開網址（沒有上一頁）時，刪完回總覽", async () => {
		mockApi(routes());
		renderEditMeal(newClient(), ["/meals/5/edit"]);

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除這一餐" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除這一餐" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
	});

	it("✕ 回上一頁", async () => {
		mockApi(routes());
		renderEditMeal();

		await userEvent.click(await screen.findByRole("button", { name: "關閉" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
	});
});
```

> 照片測試的 `GET /api/meals/5/photo` 回一個 blob——`useMealPhoto` 的既有測試（`meal-photo.test.tsx`）也是這樣在 jsdom 裡跑的。

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/queries.test.tsx tests/edit-meal.test.tsx
```

Expected：`queries.test.tsx` 新的兩條 FAIL（`queryKeys.meal` 不存在）；`edit-meal.test.tsx` 整個 FAIL（模組找不到）。

- [ ] **Step 3: query key、`useMeal`、餐別順序**

`frontend/src/api/queries.ts`，`meals` 之後加：

```ts
	/** 單一餐（編輯畫面 `useMeal`）。**刻意掛在 `meals` 底下**：記一餐、改
	 *  項目、改金額之後都失效 `meals`，前綴比對會一起打到正在編輯的那一餐。
	 *
	 *  刪掉一餐之後要先 `removeQueries` 這個 key 再失效其他——不然失效會讓
	 *  還掛著的 `useMeal` 去重抓一個已經刪掉的餐，打出一個 404。 */
	meal: (mealId: number) => ["meals", mealId] as const,
```

`frontend/src/api/meals.ts`：

```ts
/** 餐別在下拉選單裡的順序（一天裡的時間順序）。標籤用 `MEAL_TYPE_LABELS`。 */
export const MEAL_TYPE_ORDER: readonly MealType[] = [
	"breakfast",
	"lunch",
	"dinner",
	"snack",
];

/** 一餐（編輯畫面）。`useParams` 給的 id 可能是 `NaN`——那時不發請求，
 *  畫面自己說「找不到這一餐」（跟 `useFood` 同一個作法）。 */
export function useMeal(mealId: number) {
	return useQuery({
		queryKey: queryKeys.meal(mealId),
		queryFn: () => apiFetch<Meal>(`/api/meals/${mealId}`),
		enabled: Number.isFinite(mealId),
	});
}
```

`frontend/src/screens/LogMeal.tsx`：刪掉 `MEAL_TYPES` 常數，import 改成 `import { MEAL_TYPE_LABELS, MEAL_TYPE_ORDER } from "../api/meals";`，餐別下拉的選項改成

```tsx
						{MEAL_TYPE_ORDER.map((value) => (
							<option key={value} value={value}>
								{MEAL_TYPE_LABELS[value]}
							</option>
						))}
```

（標籤文字與順序跟原本一樣，`log-meal.test.tsx` 照樣不改。）

- [ ] **Step 4: 上傳錯誤訊息搬到 `api/photos.ts`**

`MealList.tsx` 的 `describeUploadError`（連同註解）搬到 `frontend/src/api/photos.ts`，改名 `describePhotoUploadError` 並 `export`；`photos.ts` 加 `import { ApiError } from "./errors";`。`MealList.tsx` 刪掉原函式與不再用到的 `ApiError`、`PhotoTooLargeError` import，改成從 `../api/photos` import `describePhotoUploadError`，呼叫端改名。

- [ ] **Step 5: 項目區（先只顯示）**

`frontend/src/screens/EditMealItems.tsx`（新；Task 6 會整個換掉）：

```tsx
import type { Meal } from "../api/meals";
import { formatMacro } from "../lib/decimal";
import styles from "./EditMeal.module.css";

/** 編輯畫面的項目區。 */
export function EditMealItems({ meal }: { meal: Meal }) {
	return (
		<section aria-labelledby="edit-meal-items" className={styles.section}>
			<h2 id="edit-meal-items">項目</h2>
			{meal.items.length === 0 ? (
				<p>這一餐沒有項目</p>
			) : (
				<ul className={styles.items}>
					{meal.items.map((item) => (
						<li key={item.id} data-testid={`meal-item-${item.id}`}>
							<span className={styles.itemName}>{item.food_name}</span>
							<span className={styles.itemMeta}>
								{formatMacro(item.quantity_g)} g · {formatMacro(item.kcal)}{" "}
								kcal
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
```

- [ ] **Step 6: 編輯畫面**

`frontend/src/screens/EditMeal.module.css`（新）：

```css
.screen {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.header {
	display: flex;
	align-items: center;
	gap: var(--space-2);
}

.header h1 {
	margin: 0;
	font-size: 18px;
}

.close {
	min-width: 44px;
	min-height: 44px;
	border: none;
	background: transparent;
	color: var(--color-text);
}

.section {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	padding: var(--space-4);
	border-radius: var(--radius-card);
	background: var(--color-surface);
}

.section h2 {
	margin: 0;
	font-size: 14px;
	color: var(--color-text-muted);
}

/* 字級不在這裡設——index.css 的全域規則保證 input/select ≥ 16px。 */
.section input:not([type="file"]),
.section select {
	padding: var(--space-2) var(--space-3);
	border: 1px solid var(--color-border);
	border-radius: var(--radius-button);
	background: var(--color-bg);
	color: var(--color-text);
}

.section button,
.photoButton {
	min-height: 44px;
}

.primary {
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-action);
	color: var(--color-on-action);
	font-weight: 700;
}

.primary:disabled {
	opacity: 0.4;
}

.danger {
	border: 1px solid var(--color-danger);
	border-radius: var(--radius-button);
	background: transparent;
	color: var(--color-danger);
	font-weight: 700;
}

.items {
	list-style: none;
	margin: 0;
	padding: 0;
}

.items > li {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-2);
	padding: var(--space-2) 0;
	border-bottom: 1px solid var(--color-border);
}

.items > li:last-child {
	border-bottom: none;
}

.itemName {
	font-weight: 600;
}

.itemMeta {
	flex: 1;
	font-size: 12px;
	color: var(--color-text-muted);
}

.editor {
	display: flex;
	flex-direction: column;
	gap: var(--space-2);
	width: 100%;
}

.photo {
	width: 100%;
	max-width: 240px;
	border-radius: var(--radius-button);
}

.photoButton {
	display: inline-flex;
	align-items: center;
	gap: var(--space-2);
	padding: 0 var(--space-3);
	border: 1px dashed var(--color-border);
	border-radius: var(--radius-button);
	color: var(--color-text-muted);
}

/* 同 LogMeal：視覺上藏起來但仍可用鍵盤對焦，外框畫在前一個兄弟 label 上。 */
.fileInput {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
}

.photoButton:has(+ .fileInput:focus-visible) {
	outline: 2px solid var(--color-action);
	outline-offset: 2px;
}

.photoButton:has(+ .fileInput:disabled) {
	opacity: 0.4;
}
```

> `.editor` 給 Task 6 用；先放進來，Task 6 不用再動這個檔案。

`frontend/src/screens/EditMeal.tsx`（新）：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, X } from "lucide-react";
import { type ChangeEvent, type ReactNode, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { apiFetch } from "../api/client";
import { ApiError, hasFieldError } from "../api/errors";
import { AMOUNT_FORMAT_ERROR } from "../api/expenses";
import {
	MEAL_TYPE_LABELS,
	MEAL_TYPE_ORDER,
	type Meal,
	type MealType,
	useMeal,
} from "../api/meals";
import {
	describePhotoUploadError,
	useMealPhoto,
	useUploadMealPhoto,
} from "../api/photos";
import { queryKeys } from "../api/queries";
import { formatMoney } from "../lib/decimal";
import styles from "./EditMeal.module.css";
import { EditMealItems } from "./EditMealItems";

type MealChanges = {
	meal_type?: MealType;
	cost?: string | null;
	note?: string | null;
};

function initialCost(meal: Meal): string {
	return meal.cost === null ? "" : formatMoney(meal.cost);
}

/** 跟目前的這一餐比，有改的欄位才放進 body（`PATCH` 是 `exclude_unset`：
 *  不帶＝不動）。沒有任何改動回 `null`。
 *
 *  金額清空＝`cost: null`＝拿掉餐費（編輯餐點規格 §3.2）；備註清空＝
 *  `note: null`。 */
function mealChanges(
	meal: Meal,
	draft: { mealType: MealType; cost: string; note: string },
): MealChanges | null {
	const changes: MealChanges = {};
	if (draft.mealType !== meal.meal_type) {
		changes.meal_type = draft.mealType;
	}
	const cost = draft.cost.trim();
	if (cost !== initialCost(meal)) {
		changes.cost = cost === "" ? null : cost;
	}
	const note = draft.note.trim();
	if (note !== (meal.note ?? "")) {
		changes.note = note === "" ? null : note;
	}
	return Object.keys(changes).length === 0 ? null : changes;
}

function describeSaveError(error: unknown): string {
	// VALIDATION_ERROR 只有在真的是 cost 時才說金額（同記一餐）。
	if (
		error instanceof ApiError &&
		error.code === "VALIDATION_ERROR" &&
		hasFieldError(error, "cost")
	) {
		return AMOUNT_FORMAT_ERROR;
	}
	return "儲存失敗，請再試一次";
}

/** 餐別、金額、備註（編輯餐點規格 §4.2 第 2 點）。一顆「儲存」，只送有改的欄位。
 *
 *  草稿在掛載時從這一餐帶入。存好之後 `meals` 失效、這一餐重抓，草稿跟
 *  新的值一樣，「儲存」回到 disabled。 */
function MealDetailsForm({ meal }: { meal: Meal }) {
	const queryClient = useQueryClient();
	const [mealType, setMealType] = useState<MealType>(meal.meal_type);
	const [cost, setCost] = useState(initialCost(meal));
	const [note, setNote] = useState(meal.note ?? "");

	const changes = mealChanges(meal, { mealType, cost, note });

	const save = useMutation({
		mutationFn: (body: MealChanges) =>
			apiFetch<Meal>(`/api/meals/${meal.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: (_meal, body) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			// 餐費改了（改、補、拿掉）——報表與總覽的支出都要重取。
			if ("cost" in body) {
				queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			}
		},
	});

	// 一改欄位就把上一次的「已儲存」或錯誤收掉，不然它會掛在一個已經不是
	// 那次送出內容的表單上。
	function edit<T>(setter: (value: T) => void) {
		return (value: T) => {
			setter(value);
			save.reset();
		};
	}

	return (
		<form
			aria-labelledby="edit-meal-details"
			className={styles.section}
			onSubmit={(event) => {
				event.preventDefault();
				if (changes !== null) save.mutate(changes);
			}}
		>
			<h2 id="edit-meal-details">這一餐</h2>

			<label htmlFor="edit-meal-type">餐別</label>
			<select
				id="edit-meal-type"
				value={mealType}
				onChange={(event) =>
					edit(setMealType)(event.target.value as MealType)
				}
			>
				{MEAL_TYPE_ORDER.map((value) => (
					<option key={value} value={value}>
						{MEAL_TYPE_LABELS[value]}
					</option>
				))}
			</select>

			<label htmlFor="edit-meal-cost">金額（選填）</label>
			<input
				id="edit-meal-cost"
				type="text"
				inputMode="decimal"
				value={cost}
				onChange={(event) => edit(setCost)(event.target.value)}
			/>

			<label htmlFor="edit-meal-note">備註（選填）</label>
			<input
				id="edit-meal-note"
				type="text"
				value={note}
				onChange={(event) => edit(setNote)(event.target.value)}
			/>

			{save.isError && <p role="alert">{describeSaveError(save.error)}</p>}
			{save.isSuccess && <p role="status">已儲存</p>}
			<button
				type="submit"
				className={styles.primary}
				disabled={changes === null || save.isPending}
			>
				{save.isPending ? "儲存中…" : "儲存"}
			</button>
		</form>
	);
}

function PhotoPreview({ mealId }: { mealId: number }) {
	const { objectUrl, isError } = useMealPhoto(mealId);
	return (
		<>
			{objectUrl !== null && (
				<img className={styles.photo} src={objectUrl} alt="這一餐的照片" />
			)}
			{isError && <p>照片無法顯示</p>}
		</>
	);
}

/** 照片：換、加、刪（編輯餐點規格 §4.2 第 4 點）。
 *
 *  **只有 `photo_path` 不是 null 才掛 `PhotoPreview`**——沒有照片時抓圖
 *  一定是 404，白打一個請求。 */
function MealPhotoSection({ meal }: { meal: Meal }) {
	const queryClient = useQueryClient();
	const upload = useUploadMealPhoto(meal.id);
	const [confirming, setConfirming] = useState(false);
	const hasPhoto = meal.photo_path !== null;

	const removePhoto = useMutation({
		mutationFn: () =>
			apiFetch(`/api/meals/${meal.id}/photo`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirming(false);
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			// **移除，不是失效**：失效會讓還掛著的 PhotoPreview 立刻重抓一張
			// 已經刪掉的照片（404）。這一餐重抓回來 photo_path 是 null，
			// PhotoPreview 就卸載了。
			queryClient.removeQueries({ queryKey: queryKeys.mealPhoto(meal.id) });
		},
	});

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：上傳失敗後重選同一張，change 才會再觸發。
		event.target.value = "";
		if (file === undefined) return;
		upload.mutate(file);
	}

	return (
		<section aria-labelledby="edit-meal-photo-title" className={styles.section}>
			<h2 id="edit-meal-photo-title">照片</h2>
			{hasPhoto && <PhotoPreview mealId={meal.id} />}

			<label htmlFor="edit-meal-photo" className={styles.photoButton}>
				<Camera aria-hidden="true" size={18} />
				{hasPhoto ? "換照片" : "加照片"}
			</label>
			<input
				id="edit-meal-photo"
				type="file"
				accept="image/*"
				className={styles.fileInput}
				disabled={upload.isPending}
				onChange={handleChange}
			/>
			{upload.isError && (
				<p role="alert">{describePhotoUploadError(upload.error)}</p>
			)}

			{hasPhoto &&
				(confirming ? (
					<div role="alertdialog" aria-label="確認刪除照片">
						<p>確定要刪除這張照片嗎？</p>
						<button
							type="button"
							disabled={removePhoto.isPending}
							onClick={() => removePhoto.mutate()}
						>
							確定刪除
						</button>
						<button type="button" onClick={() => setConfirming(false)}>
							取消
						</button>
					</div>
				) : (
					<button
						type="button"
						className={styles.danger}
						onClick={() => setConfirming(true)}
					>
						刪除照片
					</button>
				))}
			{removePhoto.isError && <p role="alert">刪除照片失敗，請再試一次</p>}
		</section>
	);
}

/** 刪除整餐（編輯餐點規格 §4.2 第 5 點）。後端連餐費一起刪（同一個交易），
 *  所以確認文字要把餐費講出來。 */
function DeleteMeal({ meal, onDeleted }: { meal: Meal; onDeleted: () => void }) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);

	const remove = useMutation({
		mutationFn: () => apiFetch(`/api/meals/${meal.id}`, { method: "DELETE" }),
		onSuccess: () => {
			// **先移除這一餐自己的快取，再失效其他。** 順序反過來的話，
			// 失效 `meals` 會前綴比對到 `meal(id)`，讓還掛著的 useMeal 去重抓
			// 一個已經刪掉的餐（404）。照片同理。
			queryClient.removeQueries({ queryKey: queryKeys.meal(meal.id) });
			queryClient.removeQueries({ queryKey: queryKeys.mealPhoto(meal.id) });
			// 營養素、趨勢、常吃／最近吃都少了這一餐；餐費也刪了。
			for (const queryKey of [
				queryKeys.meals,
				queryKeys.dailyStats,
				queryKeys.rangeStatsAll,
				queryKeys.frequentFoods,
				queryKeys.recentFoods,
				queryKeys.expensesAll,
			]) {
				queryClient.invalidateQueries({ queryKey });
			}
			onDeleted();
		},
	});

	return (
		<section className={styles.section}>
			{confirming ? (
				<div role="alertdialog" aria-label="確認刪除這一餐">
					<p>確定要刪除這一餐嗎？</p>
					{meal.cost !== null && (
						<p>這一餐的餐費 ${formatMoney(meal.cost)} 也會一起刪除。</p>
					)}
					{/* 送出中停用：刪兩次第二次會 404，顯示一個誤導的錯誤。 */}
					<button
						type="button"
						disabled={remove.isPending}
						onClick={() => remove.mutate()}
					>
						確定刪除
					</button>
					<button type="button" onClick={() => setConfirming(false)}>
						取消
					</button>
				</div>
			) : (
				<button
					type="button"
					className={styles.danger}
					onClick={() => setConfirming(true)}
				>
					刪除這一餐
				</button>
			)}
			{remove.isError && <p role="alert">刪除失敗，請再試一次</p>}
		</section>
	);
}

/** `/meals/:id/edit`：修改或刪除一筆已經記下的餐（編輯餐點規格 §4.2）。
 *
 *  **每個區塊各自立即送出**，沒有「全部儲存」——每個動作在後端是一個交易，
 *  畫面不會有「改了一半」的狀態。錯誤也顯示在各自的區塊裡。
 *
 *  不能改時間（規格 §1.3）。 */
export function EditMeal() {
	const params = useParams<{ id: string }>();
	const mealId = params.id !== undefined ? Number(params.id) : Number.NaN;
	const mealQuery = useMeal(mealId);
	const navigate = useNavigate();
	const location = useLocation();

	// 直接打開網址（書籤、PWA 重新整理）時沒有上一頁，navigate(-1) 會離開
	// app 或什麼都不做。react-router 的第一個 history entry 的 key 是
	// "default"（介面改版 Task 5 實測）。
	function close() {
		if (location.key === "default") {
			navigate("/");
		} else {
			navigate(-1);
		}
	}

	const meal = mealQuery.data;
	const notFound =
		!Number.isFinite(mealId) ||
		(mealQuery.error instanceof ApiError && mealQuery.error.status === 404);

	let body: ReactNode;
	if (notFound) {
		body = <p>找不到這一餐</p>;
	} else if (meal != null) {
		// 資料優先於錯誤：重抓失敗但手上有資料就照樣顯示。
		body = (
			<>
				<MealDetailsForm key={meal.id} meal={meal} />
				<EditMealItems meal={meal} />
				<MealPhotoSection meal={meal} />
				<DeleteMeal meal={meal} onDeleted={close} />
			</>
		);
	} else if (mealQuery.isPending) {
		body = <p>載入中…</p>;
	} else {
		body = <p>無法載入這一餐</p>;
	}

	return (
		<section className={styles.screen}>
			<header className={styles.header}>
				<button
					type="button"
					className={styles.close}
					aria-label="關閉"
					onClick={close}
				>
					<X aria-hidden="true" size={20} />
				</button>
				<h1>編輯這一餐</h1>
			</header>
			{body}
		</section>
	);
}
```

> `meal != null` 用 `!=`：`apiFetch` 在 204 時回 `null`，`data` 的型別是 `Meal | null | undefined`。

- [ ] **Step 7: 路由**

`frontend/src/App.tsx`：import `EditMeal`；在 `<Route path="/meals/new" … />` 之後加

```tsx
							{/* 修改或刪除一筆已經記下的餐（編輯餐點規格 §4.2）。入口：飲食頁
									餐點卡片的「編輯」、總覽時間線的餐點列。 */}
							<Route path="/meals/:id/edit" element={<EditMeal />} />
```

- [ ] **Step 8: 更新過時的註解**

`frontend/src/screens/Expenses.tsx` 的 `（餐費）` 標示上面那段註解，改成：

```tsx
			{/* meal_id 有值＝這筆是記一餐時順手建立的餐費（規格 §4.1）。
			    在編輯畫面刪掉那一餐時，後端連這筆一起刪（編輯餐點規格 §3.4），
			    EditMeal 會失效 expensesAll；別的路徑刪了餐點時是 SET NULL
			    （app/models/expense.py）：標示消失，但錢保留。 */}
```

- [ ] **Step 9: 跑測試確認通過**

```
npx vitest run tests/edit-meal.test.tsx tests/queries.test.tsx tests/log-meal.test.tsx tests/meal-list.test.tsx tests/meal-photo-upload.test.tsx tests/css-tokens.test.ts
```

Expected：全部 PASS。

- [ ] **Step 10: 突變測試**（每個做完都改回來；新檔案要手動改回）

1. `DeleteMeal` 的 `onSuccess` 裡把兩行 `removeQueries` 移到 `for` 迴圈**之後** → Expected：「確認刪除…」那條**應該 FAIL**（多了一次 `GET /api/meals/5`）。**如果沒紅，照實回報**——代表 TanStack 在這個情境下不會重抓，那段註解的理由要改寫，不要硬讓測試變紅。
2. `close()` 改成永遠 `navigate(-1)` → Expected：「直接打開網址（沒有上一頁）時，刪完回總覽」FAIL。
3. `mealChanges` 拿掉 `if (draft.mealType !== meal.meal_type)` 的條件（永遠帶 `meal_type`）→ Expected：「改金額」與「清空金額」FAIL（body 多了 `meal_type`）。
4. 確認文字拿掉餐費那一行 → Expected：「有餐費時，確認文字…」FAIL。

- [ ] **Step 11: 全部前端檢查**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 12: Commit**

```
feat(meals): 編輯這一餐的畫面——餐別、金額、備註、照片、刪除整餐

/meals/:id/edit。每個區塊各自立即送出：PATCH 只帶有改的欄位（金額清空
＝拿掉餐費）、照片換／加／刪、刪除整餐（確認文字寫出會一起刪的餐費）。
刪完先移除這一餐自己的快取再失效其他，不會回頭去抓一個已經刪掉的餐。

項目區這一步只顯示，下一步才能改。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/queries.ts frontend/src/api/meals.ts frontend/src/api/photos.ts frontend/src/screens/EditMeal.tsx frontend/src/screens/EditMeal.module.css frontend/src/screens/EditMealItems.tsx frontend/src/screens/MealList.tsx frontend/src/screens/LogMeal.tsx frontend/src/screens/Expenses.tsx frontend/src/App.tsx frontend/tests/queries.test.tsx frontend/tests/edit-meal.test.tsx
```

---
## Task 6：項目——修改、刪除、加一項

**Files:**
- Modify（整個換掉）: `frontend/src/screens/EditMealItems.tsx`
- Test: `frontend/tests/edit-meal.test.tsx`（加）

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/edit-meal.test.tsx`：在 `RICE` 之後加 fixture：

```tsx
const BOWL = {
	id: 8,
	label: "碗",
	grams: "150.00",
	is_default: true,
	is_global: true,
};

const WHITE_RICE = { ...RICE, id: 3, name: "白飯" };

const PORTION_MISMATCH = json(
	{
		error: {
			code: "PORTION_FOOD_MISMATCH",
			message: "這個份量不屬於指定的食物",
			details: {},
		},
	},
	422,
);
```

檔尾加：

```tsx
describe("編輯這一餐：項目", () => {
	/** 這一項的份量清單有一個公開的預設份量「碗」。 */
	function itemRoutes(patch: () => Response = () => json(MEAL)) {
		return routes(MEAL, [
			{ method: "PATCH", path: "/api/meals/5/items/51", handler: patch },
			{
				method: "DELETE",
				path: "/api/meals/5/items/51",
				handler: () => new Response(null, { status: 204 }),
			},
			{ path: "/api/foods/1/portions", handler: () => json([BOWL]) },
		]);
	}

	async function openEditor() {
		await userEvent.click(
			await screen.findByRole("button", { name: "修改滷肉飯" }),
		);
		const editor = screen.getByRole("form", { name: "修改滷肉飯" });
		await within(editor).findByRole("option", { name: "碗" });
		return editor;
	}

	it("改數量：帶入目前的值、預設份量不蓋掉它，PATCH 帶 quantity 與 portion_id", async () => {
		const fetchMock = mockApi(itemRoutes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const editor = await openEditor();
		// 這一項當初是「直接輸入 200 g」：食物後來才有的預設份量「碗」
		// 不能把它變成 200 碗。
		expect(within(editor).getByLabelText("份量選項")).toHaveValue("");
		const quantity = within(editor).getByLabelText("份量");
		expect(quantity).toHaveValue("200");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "250");
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5/items/51")).toEqual({
				quantity: "250",
				portion_id: null,
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toEqual(
				expect.arrayContaining([
					queryKeys.meals,
					queryKeys.dailyStats,
					queryKeys.rangeStatsAll,
					queryKeys.frequentFoods,
					queryKeys.recentFoods,
				]),
			),
		);
		// 改項目不動餐費。
		expect(keysOf(invalidate)).not.toContainEqual(queryKeys.expensesAll);
		// 存好就收起來。
		await waitFor(() =>
			expect(
				screen.queryByRole("form", { name: "修改滷肉飯" }),
			).not.toBeInTheDocument(),
		);
	});

	it("改成某個份量：送那個份量的 id", async () => {
		const fetchMock = mockApi(itemRoutes());
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.selectOptions(
			within(editor).getByLabelText("份量選項"),
			"8",
		);
		const quantity = within(editor).getByLabelText("份量");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "1");
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "PATCH", "/api/meals/5/items/51")).toEqual({
				quantity: "1",
				portion_id: 8,
			}),
		);
	});

	it("原本用份量記的一項：帶入那個份量與份數", async () => {
		mockApi(
			routes(
				{
					...MEAL,
					items: [{ ...ITEM, portion_id: 8, quantity: "1.50" }],
				},
				[{ path: "/api/foods/1/portions", handler: () => json([BOWL]) }],
			),
		);
		renderEditMeal();

		const editor = await openEditor();
		expect(within(editor).getByLabelText("份量選項")).toHaveValue("8");
		expect(within(editor).getByLabelText("份量")).toHaveValue("1.5");
	});

	it("份量不屬於這個食物：說清楚", async () => {
		mockApi(itemRoutes(() => PORTION_MISMATCH));
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText("這個份量不屬於這個食物"),
		).toBeInTheDocument();
	});

	it("數量格式錯誤：指到數量，不說成金額錯誤", async () => {
		mockApi(itemRoutes(() => validationError(["body", "quantity"])));
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "儲存" }));

		expect(
			await within(editor).findByText(
				"數量要大於 0、不超過 10000，最多兩位小數",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(AMOUNT_FORMAT_ERROR)).not.toBeInTheDocument();
	});

	it("放棄：收起來，不送", async () => {
		const fetchMock = mockApi(itemRoutes());
		renderEditMeal();

		const editor = await openEditor();
		await userEvent.click(within(editor).getByRole("button", { name: "放棄" }));

		expect(
			screen.queryByRole("form", { name: "修改滷肉飯" }),
		).not.toBeInTheDocument();
		expect(calls(fetchMock, "PATCH", "/api/meals/5/items/51")).toHaveLength(0);
	});

	it("同一時間只開一個編輯器：打開「加一項」就收起正在改的那一項", async () => {
		mockApi(itemRoutes());
		renderEditMeal();

		await openEditor();
		await userEvent.click(screen.getByRole("button", { name: "＋ 加一項" }));

		expect(
			screen.queryByRole("form", { name: "修改滷肉飯" }),
		).not.toBeInTheDocument();
	});

	it("刪除一項要先確認；取消就不送", async () => {
		const fetchMock = mockApi(itemRoutes());
		renderEditMeal();

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" });
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));

		expect(calls(fetchMock, "DELETE", "/api/meals/5/items/51")).toHaveLength(0);
	});

	it("確認刪除一項：送 DELETE，失效營養素相關的 query", async () => {
		const fetchMock = mockApi(itemRoutes());
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除滷肉飯" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認刪除滷肉飯" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "確定刪除" }),
		);

		await waitFor(() =>
			expect(calls(fetchMock, "DELETE", "/api/meals/5/items/51")).toHaveLength(
				1,
			),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toEqual(
				expect.arrayContaining([queryKeys.meals, queryKeys.dailyStats]),
			),
		);
	});

	it("加一項：選食物、填數量，POST 到這一餐", async () => {
		const fetchMock = mockApi(
			routes(MEAL, [
				{
					method: "POST",
					path: "/api/meals/5/items",
					handler: () => json(MEAL, 201),
				},
				{ path: "/api/foods/frequent", handler: () => json([WHITE_RICE]) },
				{ path: "/api/foods/3/portions", handler: () => json([]) },
			]),
		);
		const client = renderEditMeal();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await userEvent.click(
			await screen.findByRole("button", { name: "＋ 加一項" }),
		);
		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));
		const form = screen.getByRole("form", { name: "加一項" });
		expect(within(form).getByText("已選擇：白飯")).toBeInTheDocument();
		const quantity = within(form).getByLabelText("份量");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "150");
		await userEvent.click(within(form).getByRole("button", { name: "加入" }));

		await waitFor(() =>
			expect(bodyOf(fetchMock, "POST", "/api/meals/5/items")).toEqual({
				food_id: 3,
				quantity: "150",
			}),
		);
		await waitFor(() =>
			expect(keysOf(invalidate)).toContainEqual(queryKeys.dailyStats),
		);
	});
});
```

> `within(editor).findByRole("option", { name: "碗" })` 是在等份量清單到——在那之前斷言「份量選項是空的」會因為下拉還沒出現而失敗，或者更糟：在清單到之前就通過（handover §6 第 41 種）。

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/edit-meal.test.tsx
```

Expected：新的 10 條 FAIL（找不到「修改滷肉飯」「刪除滷肉飯」「＋ 加一項」按鈕）；Task 5 的既有測試 PASS。

- [ ] **Step 3: 實作**

`frontend/src/screens/EditMealItems.tsx` 整個換成：

```tsx
import {
	type QueryClient,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { type Food, useFood } from "../api/foods";
import type { Meal } from "../api/meals";
import { queryKeys } from "../api/queries";
import { FoodPicker } from "../components/FoodPicker";
import {
	PortionQuantityFields,
	usePortionQuantity,
} from "../components/PortionQuantityFields";
import { formatMacro } from "../lib/decimal";
import styles from "./EditMeal.module.css";

type MealItem = Meal["items"][number];

/** 同一時間只開一個編輯器：改某一項，或加一項。兩個同時開的話，畫面上
 *  會有兩組「份量」欄位——標籤對不上（`getByLabelText` 與螢幕閱讀器都
 *  分不清），使用者也分不清在改哪一個。 */
type Editor = { kind: "item"; itemId: number } | { kind: "add" } | null;

/** 項目變了：這一餐、今天的營養素、趨勢、常吃／最近吃都跟著變（同記一餐）。
 *  餐費不受影響，不失效 `expensesAll`。 */
function invalidateAfterItemChange(queryClient: QueryClient) {
	for (const queryKey of [
		queryKeys.meals,
		queryKeys.dailyStats,
		queryKeys.rangeStatsAll,
		queryKeys.frequentFoods,
		queryKeys.recentFoods,
	]) {
		queryClient.invalidateQueries({ queryKey });
	}
}

function describeItemError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "PORTION_FOOD_MISMATCH") {
			return "這個份量不屬於這個食物";
		}
		// 搜尋到送出之間食物失去生效版本（同記一餐）：用後端的訊息。
		if (error.code === "FOOD_HAS_NO_REVISION") {
			return error.message;
		}
		// 這兩個端點的 422 只可能來自數量（或份量）——不是金額。
		// 限制同 MealItemCreateRequest.quantity。
		if (error.code === "VALIDATION_ERROR") {
			return "數量要大於 0、不超過 10000，最多兩位小數";
		}
	}
	return "儲存失敗，請再試一次";
}

/** 一項的份量顯示：用份量記的寫「幾份（幾 g）」，直接輸入的寫公克數。
 *
 *  單位一律寫 g：`MealItemResponse` 沒有帶食物的 `base_unit`（液體會顯示
 *  成 g——handover 已記錄的已知問題，跟飲食頁的 `MealList` 一致）。 */
function amountText(item: MealItem): string {
	const grams = `${formatMacro(item.quantity_g)} g`;
	return item.portion_id === null
		? grams
		: `${formatMacro(item.quantity)} 份（${grams}）`;
}

/** 改一項的份量或數量（`PATCH /api/meals/{id}/items/{item_id}`）。 */
function ItemEditor({
	mealId,
	item,
	onClose,
}: {
	mealId: number;
	item: MealItem;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	// 直接輸入時的單位（g 或 ml）要看食物——MealItemResponse 沒有帶。
	const foodQuery = useFood(item.food_id);
	// 初始值是這一項當初怎麼記的（不是 null）：食物後來才設的預設份量
	// 不能把「直接輸入 200 g」變成 200 碗。
	const portion = usePortionQuantity(item.food_id, {
		choice: item.portion_id ?? "manual",
		quantity: formatMacro(item.quantity),
	});

	const save = useMutation({
		mutationFn: () =>
			apiFetch<Meal>(`/api/meals/${mealId}/items/${item.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					quantity: portion.quantity,
					// **一律帶 portion_id**（null＝直接輸入數量）：不帶的話後端
					// 沿用舊的份量，「從碗改回直接輸入 200」會變成 200 碗。
					portion_id: portion.portionId,
				}),
			}),
		onSuccess: () => {
			invalidateAfterItemChange(queryClient);
			onClose();
		},
	});

	return (
		<form
			className={styles.editor}
			aria-label={`修改${item.food_name}`}
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate();
			}}
		>
			<PortionQuantityFields
				state={portion}
				unit={foodQuery.data?.nutrition?.base_unit ?? "g"}
				idPrefix={`item-${item.id}-`}
			/>
			{save.isError && <p role="alert">{describeItemError(save.error)}</p>}
			<button
				type="submit"
				className={styles.primary}
				disabled={save.isPending}
			>
				{save.isPending ? "儲存中…" : "儲存"}
			</button>
			<button type="button" onClick={onClose}>
				放棄
			</button>
		</form>
	);
}

function ItemRow({
	mealId,
	item,
	editing,
	onEdit,
	onClose,
}: {
	mealId: number;
	item: MealItem;
	editing: boolean;
	onEdit: () => void;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);

	const remove = useMutation({
		mutationFn: () =>
			apiFetch(`/api/meals/${mealId}/items/${item.id}`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirming(false);
			invalidateAfterItemChange(queryClient);
		},
	});

	return (
		<li data-testid={`meal-item-${item.id}`}>
			<span className={styles.itemName}>{item.food_name}</span>
			<span className={styles.itemMeta}>
				{amountText(item)} · {formatMacro(item.kcal)} kcal
			</span>
			{editing ? (
				<ItemEditor mealId={mealId} item={item} onClose={onClose} />
			) : (
				<>
					{/* 名稱帶食物名：每一列都有「修改」「刪除」，只寫動詞的話
					    螢幕閱讀器（與測試）分不出是哪一項。 */}
					<button
						type="button"
						aria-label={`修改${item.food_name}`}
						onClick={onEdit}
					>
						修改
					</button>
					<button
						type="button"
						aria-label={`刪除${item.food_name}`}
						onClick={() => setConfirming(true)}
					>
						刪除
					</button>
				</>
			)}
			{confirming && (
				<div role="alertdialog" aria-label={`確認刪除${item.food_name}`}>
					<p>確定要刪除「{item.food_name}」嗎？</p>
					<button
						type="button"
						disabled={remove.isPending}
						onClick={() => remove.mutate()}
					>
						確定刪除
					</button>
					<button type="button" onClick={() => setConfirming(false)}>
						取消
					</button>
				</div>
			)}
			{remove.isError && <p role="alert">刪除失敗，請再試一次</p>}
		</li>
	);
}

/** 加一項（`POST /api/meals/{id}/items`）：選食物、份量、數量——跟記一餐
 *  同一組元件。 */
function AddItem({ mealId, onClose }: { mealId: number; onClose: () => void }) {
	const queryClient = useQueryClient();
	const [food, setFood] = useState<Food | null>(null);
	const portion = usePortionQuantity(food?.id ?? null);

	const add = useMutation({
		mutationFn: (selected: Food) =>
			apiFetch<Meal>(`/api/meals/${mealId}/items`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					food_id: selected.id,
					quantity: portion.quantity,
					...(portion.portionId !== null
						? { portion_id: portion.portionId }
						: {}),
				}),
			}),
		onSuccess: () => {
			invalidateAfterItemChange(queryClient);
			onClose();
		},
	});

	return (
		<div className={styles.editor}>
			<FoodPicker
				onSelect={(selected) => {
					setFood(selected);
					portion.resetChoice();
					add.reset();
				}}
			/>
			{food !== null && (
				<form
					className={styles.editor}
					aria-label="加一項"
					onSubmit={(event) => {
						event.preventDefault();
						add.mutate(food);
					}}
				>
					<p>已選擇：{food.name}</p>
					<PortionQuantityFields
						state={portion}
						unit={food.nutrition?.base_unit ?? "g"}
						idPrefix="add-"
					/>
					{add.isError && <p role="alert">{describeItemError(add.error)}</p>}
					<button
						type="submit"
						className={styles.primary}
						disabled={add.isPending}
					>
						{add.isPending ? "加入中…" : "加入"}
					</button>
				</form>
			)}
			<button type="button" onClick={onClose}>
				放棄
			</button>
		</div>
	);
}

/** 編輯畫面的項目區（編輯餐點規格 §4.2 第 3 點）：每一項可以改份量／數量、
 *  刪除；最後可以加一項。每個動作各自立即送出。 */
export function EditMealItems({ meal }: { meal: Meal }) {
	const [editor, setEditor] = useState<Editor>(null);
	const close = () => setEditor(null);

	return (
		<section aria-labelledby="edit-meal-items" className={styles.section}>
			<h2 id="edit-meal-items">項目</h2>
			{meal.items.length === 0 ? (
				<p>這一餐沒有項目</p>
			) : (
				<ul className={styles.items}>
					{meal.items.map((item) => (
						<ItemRow
							key={item.id}
							mealId={meal.id}
							item={item}
							editing={editor?.kind === "item" && editor.itemId === item.id}
							onEdit={() => setEditor({ kind: "item", itemId: item.id })}
							onClose={close}
						/>
					))}
				</ul>
			)}
			{editor?.kind === "add" ? (
				<AddItem mealId={meal.id} onClose={close} />
			) : (
				<button type="button" onClick={() => setEditor({ kind: "add" })}>
					＋ 加一項
				</button>
			)}
		</section>
	);
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/edit-meal.test.tsx tests/log-meal.test.tsx
```

- [ ] **Step 5: 突變測試**（每個做完都手動改回並重跑）

1. `ItemEditor` 的 body 改成 `...(portion.portionId !== null ? { portion_id: portion.portionId } : {})`（null 時不帶）→ Expected：「改數量：…」**FAIL**（body 少了 `portion_id: null`）。
2. `usePortionQuantity(item.food_id, …)` 的第二個參數拿掉 → Expected：「改數量：…」**FAIL**（份量選項變成預設的「8」、數量變成「1」）。
3. `describeItemError` 拿掉 `PORTION_FOOD_MISMATCH` 那個分支 → Expected：「份量不屬於這個食物」**FAIL**。
4. `editing` 改成 `editor?.kind === "item"`（不比對 itemId）——只有一項時看不出來，**這個突變預期不會紅**；不用做，這裡只是說明為什麼不測它（測試資料只有一項）。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）

- [ ] **Step 7: Commit**

```
feat(meals): 編輯畫面的項目——改份量或數量、刪一項、加一項

改一項時帶入當初怎麼記的（份量或直接輸入），食物後來才設的預設份量
不會蓋掉它；PATCH 一律帶 portion_id，改回直接輸入不會沿用舊份量。
同一時間只開一個編輯器。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/EditMealItems.tsx frontend/tests/edit-meal.test.tsx
```

---

## Task 7：入口——飲食頁卡片、總覽時間線

**Files:**
- Modify: `frontend/src/screens/MealList.tsx`、`MealList.module.css`、`frontend/src/screens/Overview.tsx`、`Overview.module.css`
- Test: `frontend/tests/meal-list.test.tsx`、`frontend/tests/meal-photo-upload.test.tsx`（`wrap` 加 `MemoryRouter`）、`frontend/tests/overview.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/meal-list.test.tsx`：

1. import 加 `import { MemoryRouter } from "react-router";`。
2. `wrap` 改成：

```tsx
// 需要 MemoryRouter：每張卡片有連到編輯畫面的 <Link>（編輯餐點規格 §4.3）。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}
```

3. `describe` 裡加：

```tsx
	it("每張卡片有連到那一餐編輯畫面的連結", async () => {
		mockApi({ "/api/meals": () => json(MEALS) });

		render(wrap(<MealList />));

		const link = await screen.findByRole("link", { name: /^編輯/ });
		expect(link).toHaveAttribute("href", "/meals/11/edit");
	});
```

> `MEALS[0]` 的 `photo_path` 不是 null，會去抓照片——看這個檔案其他測試怎麼準備 `/api/meals/11/photo` 的路由，照做（`mockApiByPath` 依鍵的順序比對，照片路徑要排在 `/api/meals` 前面）。如果其他測試沒有準備而且照樣綠，照實回報你怎麼處理的。

`frontend/tests/meal-photo-upload.test.tsx`：同樣 import `MemoryRouter`、`wrap` 包上 `<MemoryRouter>`（加同一句註解）。**其他測試不改。**

`frontend/tests/overview.test.tsx` 的 `describe("總覽")` 裡加：

```tsx
	it("時間線的餐點列連到那一餐的編輯畫面；支出列不是連結", async () => {
		mockOverview();

		render(wrap(<Overview />));

		const rows = await screen.findAllByTestId("timeline-row");
		expect(within(rows[0]).getByRole("link")).toHaveAttribute(
			"href",
			"/meals/11/edit",
		);
		expect(within(rows[1]).queryByRole("link")).not.toBeInTheDocument();
	});
```

- [ ] **Step 2: 跑測試確認失敗**

```
npx vitest run tests/meal-list.test.tsx tests/meal-photo-upload.test.tsx tests/overview.test.tsx
```

Expected：三條新測試 FAIL；`wrap` 加了 `MemoryRouter` 的既有測試照樣 PASS。

- [ ] **Step 3: 實作**

`frontend/src/screens/MealList.tsx`：import `Link`（`from "react-router"`）；`MealCard` 的 `<h3>` 換成：

```tsx
			<div className={styles.cardHeader}>
				<h3>
					{formatTime(meal.eaten_at)} · {MEAL_TYPE_LABELS[meal.meal_type]}
				</h3>
				{/* 名稱帶時間與餐別：一頁有好幾張卡片，每張都寫「編輯」的話
				    螢幕閱讀器分不出是哪一餐。 */}
				<Link
					to={`/meals/${meal.id}/edit`}
					className={styles.editLink}
					aria-label={`編輯 ${formatTime(meal.eaten_at)} ${MEAL_TYPE_LABELS[meal.meal_type]}`}
				>
					編輯
				</Link>
			</div>
```

`MealList.module.css`：`.meal h3` 的 `margin` 改成 `0`，加：

```css
.cardHeader {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: var(--space-2);
	margin-bottom: var(--space-2);
}

.editLink {
	display: inline-flex;
	align-items: center;
	min-height: 44px;
	padding: 0 var(--space-2);
	color: var(--color-action);
	font-weight: 600;
	text-decoration: none;
}
```

`frontend/src/screens/Overview.tsx`：import `Link`（`from "react-router"`，跟既有的 `useLocation, useNavigate` 同一行）。`TimelineItem` 改成：

```tsx
/** 時間線的一列。**餐點列是連到編輯畫面的連結**（編輯餐點規格 §4.3）；
 *  支出列只能看（支出在報表改，介面改版規格 §1.3）。
 *
 *  `data-testid` 留在 `<li>` 上（`e2e/money-loop.spec.ts` 用它找列），
 *  格線排版在裡面那一層（`.row`）。 */
function TimelineItem({ row }: { row: TimelineRow }) {
	if (row.kind === "meal") {
		const foods = row.meal.items.map((item) => item.food_name).join("、");
		return (
			<li className={styles.item} data-testid="timeline-row">
				<Link
					to={`/meals/${row.meal.id}/edit`}
					className={`${styles.row} ${styles.rowLink}`}
				>
					<MealTypeIcon mealType={row.meal.meal_type} />
					<span className={styles.title}>
						{MEAL_TYPE_LABELS[row.meal.meal_type]}・
						{foods === "" ? "（沒有項目）" : foods}
					</span>
					<span className={styles.time}>{formatTime(row.time)}</span>
					<span className={styles.value}>
						{row.cost !== null
							? `$${formatMoney(row.cost)}`
							: `${formatMacro(row.meal.kcal)} kcal`}
					</span>
				</Link>
			</li>
		);
	}

	const { expense } = row;
	return (
		<li className={styles.item} data-testid="timeline-row">
			<div className={styles.row}>
				<CategoryIcon category={expense.category} />
				<span className={styles.title}>
					{expense.note?.trim() || CATEGORY_LABELS[expense.category]}
				</span>
				<span className={styles.time}>{formatTime(row.time)}</span>
				<span className={styles.value}>${formatMoney(expense.amount)}</span>
			</div>
		</li>
	);
}
```

`Overview` 函式上面的註解「時間線的列只能看、不能點（規格 §1.3）。」改成「時間線的餐點列連到編輯畫面；支出列只能看（編輯餐點規格 §4.3）。」

`Overview.module.css`：`.row` 的 `padding` 與 `border-bottom`、`.row:last-child` 搬到新的 `.item`，加 `.rowLink`：

```css
.item {
	border-bottom: 1px solid var(--color-border);
}

.item:last-child {
	border-bottom: none;
}

.row {
	display: grid;
	grid-template-columns: auto 1fr auto;
	grid-template-areas:
		"icon title value"
		"icon time value";
	column-gap: var(--space-3);
	align-items: center;
	padding: var(--space-2) 0;
}

/* 整列可以點：連結本身就是那一格，不是裡面某個字。 */
.rowLink {
	min-height: 44px;
	color: inherit;
	text-decoration: none;
}
```

（原本的 `.row:last-child { border-bottom: none; }` 刪掉；`.row > :first-child`、`.title`、`.time`、`.value` 不動——它們仍然是 `.row` 的直接子元素。）

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/meal-list.test.tsx tests/meal-photo-upload.test.tsx tests/overview.test.tsx tests/today.test.tsx tests/offline.test.tsx tests/css-tokens.test.ts
```

- [ ] **Step 5: 突變測試**

1. `MealCard` 拿掉 `<Link>` → Expected：「每張卡片有連到…」FAIL。
2. 餐點列的 `<Link>` 換回 `<div className={styles.row}>` → Expected：「時間線的餐點列連到…」FAIL。

- [ ] **Step 6: 全部前端檢查**（typecheck、lint、test）

- [ ] **Step 7: Commit**

```
feat(meals): 從飲食頁卡片與總覽時間線進到編輯畫面

飲食頁每張餐點卡片有「編輯」連結；總覽時間線的餐點列整列可以點。
支出列不變（在報表改）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/MealList.tsx frontend/src/screens/MealList.module.css frontend/src/screens/Overview.tsx frontend/src/screens/Overview.module.css frontend/tests/meal-list.test.tsx frontend/tests/meal-photo-upload.test.tsx frontend/tests/overview.test.tsx
```

---

## Task 8：e2e

**Files:** Create `frontend/e2e/edit-meal.spec.ts`

- [ ] **Step 1: 先把本機的後端換成這個分支**

e2e 打的是本機 docker 的 api。後端在 Task 1–3 改過，舊的容器沒有新端點：

```
cd F:/wallet
docker compose up -d --build api
docker compose exec api alembic upgrade head
```

（這次沒有 migration，`upgrade head` 應該什麼都不做；照跑是確認資料庫在最新版。）Docker 沒開或指令失敗 → **回報，不要自己處理**。

- [ ] **Step 2: 寫 e2e**

`frontend/e2e/edit-meal.spec.ts`：

```ts
import { expect, type Page, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

test("記一餐（有金額）→ 從總覽進編輯 → 改數量 → 刪掉這一餐，餐費也不見了", async ({
	page,
}) => {
	// 編輯餐點規格 §5.2。同一個帳號的其他 e2e 平行在記餐、記帳：
	// 一律用唯一的食物名稱與金額斷言，不看總數。
	await login(page);

	const stamp = Date.now();
	const foodName = `E2E 編輯 ${stamp}`;
	// 唯一的金額：時間線與報表都用它找那一筆。
	const cost = `${(stamp % 90000) + 10000}.37`;

	// 建一個私人食物（只用公克，不設份量）。
	await page.getByRole("link", { name: "飲食" }).click();
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();
	await page.getByLabel("名稱", { exact: true }).fill(foodName);
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）").fill("10");
	await page.getByLabel("脂肪（g）").fill("5");
	await page.getByLabel("碳水化合物（g）").fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();

	// 記一餐：100 g，有金額。
	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByLabel("搜尋食物").fill(foodName);
	await page.getByRole("button", { name: foodName }).click();
	await page.getByLabel("份量", { exact: true }).fill("100");
	await page.getByLabel("金額（選填）").fill(cost);
	await page.getByRole("button", { name: "記錄" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();

	// 從總覽時間線點那一列進編輯。
	const row = page.getByTestId("timeline-row").filter({ hasText: foodName });
	await expect(row).toHaveCount(1);
	await expect(row).toContainText(`$${cost}`);
	await row.getByRole("link").click();
	await expect(
		page.getByRole("heading", { name: "編輯這一餐" }),
	).toBeVisible();
	await expect(page.getByLabel("金額（選填）")).toHaveValue(cost);

	// 改數量：100 → 250。
	await page.getByRole("button", { name: `修改${foodName}` }).click();
	const editor = page.getByRole("form", { name: `修改${foodName}` });
	await editor.getByLabel("份量", { exact: true }).fill("250");
	await editor.getByRole("button", { name: "儲存" }).click();
	await expect(editor).toHaveCount(0);
	await expect(page.getByTestId(/^meal-item-/)).toContainText("250 g");

	// 飲食頁那一項的公克數也變了。
	await page.getByRole("button", { name: "關閉" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	await page.getByRole("link", { name: "飲食" }).click();
	// 餐點卡片是 <li>，裡面每個食物又是一個 <li>——取最後一個（內層那一項）。
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }).last(),
	).toContainText("250 g");

	// 從飲食頁卡片的「編輯」進去，刪掉這一餐。
	await page
		.getByRole("listitem")
		.filter({ hasText: foodName })
		.first()
		.getByRole("link", { name: /^編輯/ })
		.click();
	await page.getByRole("button", { name: "刪除這一餐" }).click();
	const dialog = page.getByRole("alertdialog", { name: "確認刪除這一餐" });
	await expect(dialog).toContainText(`這一餐的餐費 $${cost} 也會一起刪除`);
	await dialog.getByRole("button", { name: "確定刪除" }).click();

	// 回到飲食頁，那一餐不見了。
	await expect(page.getByRole("heading", { name: "今日餐點" })).toBeVisible();
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }),
	).toHaveCount(0);

	// 報表裡那筆餐費也不見了（SET NULL 的話它會留下來，只是少了「（餐費）」）。
	await page.getByRole("link", { name: "報表" }).click();
	await expect(page.getByTestId(/^expense-/).first()).toBeVisible();
	await expect(
		page.getByTestId(/^expense-/).filter({ hasText: cost }),
	).toHaveCount(0);
});
```

> **報表的斷言：** `toHaveCount(0)` 在清單還沒載入時也會成立——先等至少一筆 `expense-` 出現（同一個帳號的其他 e2e 一定記過帳；如果報表在這個時間點真的是空的，照實回報，改用總覽時間線斷言：`page.getByTestId("timeline-row").filter({ hasText: cost })` 為 0）。這正是 handover §6 第 41 種：斷言「沒有」之前，要先證明畫面已經是「載入完成」的狀態。
>
> 新增食物的欄位標籤照 `e2e/portions.spec.ts`；如果標籤對不上（例如「蛋白質（g）」在「每 100」模式下不是這個字），以 `portions.spec.ts` 現況為準並回報。報表頁的標題、清單的 testid 以 `Expenses.tsx` 現況為準。

- [ ] **Step 3: 跑 e2e**

```
cd frontend
npx playwright test e2e/edit-meal.spec.ts
npx playwright test
```

Expected：新的這條 PASS；全部 e2e = 基準線 18 + 1 = 19 passed。

- [ ] **Step 4: 突變測試**

把後端 `delete_meal` 裡刪支出那一行註解掉、`docker compose up -d --build api`、重跑這條 e2e → Expected：最後的報表斷言 **FAIL**。改回來、重建 api、重跑確認綠。

- [ ] **Step 5: Commit**

```
test(e2e): 改一餐的數量、刪掉一餐連餐費

從總覽時間線進編輯、改數量、飲食頁看到新的公克數；從飲食頁卡片進編輯、
刪掉這一餐，報表裡那筆餐費也不見了。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/e2e/edit-meal.spec.ts
```

---

## 收尾

- [ ] **handover 更新**（`docs/handover.md`）：
  - §8.2「前端沒有修改或刪除餐點的介面」那一項標成已完成，寫上入口（飲食頁卡片「編輯」、總覽時間線的餐點列）。
  - 已知問題補一行：用 `PATCH /api/meals/{id}` 改 `eaten_at` 時，既有餐費的 `spent_at` 不跟著動（前端目前不提供改時間）。
  - 這次實作過程中新發現的「綠燈說謊」寫進 §6（沒有就不寫）。
- [ ] 全部測試：後端 `pytest`、`ruff`、`mypy`；前端 `typecheck`、`lint`、`test`；e2e。
- [ ] Commit：`docs: 交接文件——修改與刪除已記錄的餐點`

---

## 自我檢查（寫計畫時做的）

**規格涵蓋：**

| 規格 | 任務 |
|---|---|
| §3.1 PATCH 一項 | Task 3 |
| §3.2 PATCH 的 `cost` 四種情況、同一個交易 | Task 2 |
| §3.3 `MealResponse.cost` 每條路徑、一次查完 | Task 1（`_costs_by_meal`）；Task 3 的新端點也帶 |
| §3.4 刪一餐連餐費、不改 SET NULL | Task 1 |
| §3.5 後端測試（含跨使用者隔離、`quantity: null`） | Task 1–3 |
| §3.6 `schema.d.ts` | Task 3 Step 7 |
| §4.1 `FoodPicker`、`PortionQuantityFields`、`log-meal.test.tsx` 不改 | Task 4 |
| §4.2 編輯畫面五個區塊 | Task 5（標題、這一餐、照片、刪除）、Task 6（項目） |
| §4.3 入口 | Task 7 |
| §4.4 `useMeal`、失效表 | Task 5（`queryKeys.meal`、刪除／照片）、Task 6（項目）；與規格的差異第 4 點 |
| §4.5 錯誤處理（404、金額 vs 數量、`PORTION_FOOD_MISMATCH`、各區塊各自顯示） | Task 5、6 |
| §5.1、§5.2 測試 | Task 4–8 |

**型別與名稱一致：** `queryKeys.meal`（Task 5 定義，Task 5 的 `DeleteMeal` 使用）；`usePortionQuantity(foodId, { choice, quantity })`、`PortionChoice`、`PortionQuantityFields({ state, unit, idPrefix })`（Task 4 定義，Task 6 使用）；`hasFieldError(error, field)`（Task 4 定義，Task 5 使用）；`describePhotoUploadError`（Task 5 從 `MealList` 搬出）；`MEAL_TYPE_ORDER`（Task 5）。
