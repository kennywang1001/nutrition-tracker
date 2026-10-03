# 食物的「一份」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增食物時可以設定「一份」並用「每一份」輸入營養素、食物詳情頁可以加自己的份量、記一餐自動選上預設份量。

**Architecture:** 後端 `POST /api/foods` 多一個選填的 `default_portion`，跟食物在同一個交易裡建立。前端：`lib/decimal.ts` 的 `perServingToPer100` 做換算；`NewFood` 加份量區塊與「每 100／每一份」切換；新元件 `AddPortionForm` 放進 `FoodDetail`；`LogMeal` 用純函式 `pickDefaultPortion` 推導預設份量。

**Tech Stack:** FastAPI · Pydantic · SQLAlchemy · Vite · React 19 · TypeScript strict · TanStack Query · decimal.js · Vitest + Testing Library · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-03-food-portions-design.md`

---

## 執行環境

- 後端指令在 repo 根目錄：`./.venv/Scripts/python.exe -m pytest …`。測試資料庫：`docker ps` 確認 `wallet-db-1` healthy（沒開的話回報，不要自己開關容器）。
- 前端指令在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`、`npm run -s test`。
- **Vitest 會把每個測試檔再跑一次型別檢查**，數量看起來是兩倍。
- 基準線（master `6296685`）：後端 602 passed；前端 74 檔 523 passed；e2e 17 passed。
- Biome 會要求重新排版——在本任務的檔案裡做機械性排版沒問題，回報時提一句。
- **在 Windows 上用腳本改檔案要確認是 LF**（上一輪有人的 Python 腳本寫出 CRLF）；優先用 Write/Edit 工具。
- Commit 結尾一律：`Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`；中文訊息用全形標點，`git commit -F 檔案`。

---

## 開工前必讀：這份計畫的文字沒有權威性

前三份計畫都被抓到錯誤（P5 計畫一 13 個、P5 計畫二 6 個、介面改版第一階段 5 個）。

1. 每一個「Expected: FAIL」如果**沒有**如預期失敗，**停下來回報**，不要調整測試讓它變紅。
2. 預測「紅 N 條」而實際不是 N，照實回報是哪幾條。
3. 要改的檔案不在清單上，回報，不要默默改。
4. 引用既有程式碼對不上時，以現況為準並回報。
5. **斷言「某件事沒發生」在動作是非同步時會空轉通過**（handover §6 第 41 種）——突變檢查會揭露它。
6. **在有表單又有清單的畫面上，裸的 `screen.getByText` 預設就該懷疑**（第 38 種）。

---

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `create_food` 的流程：前置 SELECT 擋同名 → `db.add(food)` → `flush`（接 IntegrityError）→ 加 `FoodRevision` → `flush` → `food.current_revision_id = revision.id` → **單一個 `commit`**（接 IntegrityError → rollback → 409 `FOOD_EXISTS`） | `app/api/routes/foods.py:43-129` |
| `FoodPortion` 已經在 `foods.py` 裡匯入並使用（`create_portion`） | `app/api/routes/foods.py:356` |
| `food_portions.grams` 是 `Numeric(8, 2)`，有 `CheckConstraint("grams > 0")` | `app/models/food.py:164,183` |
| `PortionCreateRequest`：`label` 1–50、`grams` `gt=0, le=10000, max_digits=8, decimal_places=2`、`is_default`、`is_global` | `app/schemas/food.py:118-123` |
| 任何人都能替看得到的食物加**私人**份量；份量清單回「公開的＋自己的」 | `tests/test_foods_portions.py:10-41` |
| 測試的 `client` 與 `db_session` 共用同一個 session（`join_transaction_mode="create_savepoint"`）；handler 裡 rollback 之後 session 仍可用 | `tests/conftest.py:113-150` |
| `NewFood` 的 `NUMERIC_FIELDS` 標籤：「熱量（每 100 單位 kcal）」「蛋白質（g）」「脂肪（g）」「碳水化合物（g）」——**被 `FoodDetail` 共用**，也被 `e2e/foods.spec.ts`、`e2e/admin.spec.ts`、`e2e/mobile-form-zoom.spec.ts` 用來找欄位 | `frontend/src/screens/NewFood.tsx:24-33` |
| `NewFood` 目前沒有 module CSS（第二階段才換外觀）——這份計畫**不加樣式** | 同上 |
| `FoodDetail` 已經 335 行；份量區塊目前唯讀，清單寫死「（{grams} g）」 | `frontend/src/screens/FoodDetail.tsx:194-209` |
| `food-detail.test.tsx` 有一條「份量清單唯讀——顯示得出來，但沒有新增或修改的表單」，**跟這份計畫直接衝突**，Task 4 要改它 | `frontend/tests/food-detail.test.tsx:158-172` |
| `food-detail.test.tsx` 的 `foodRoutes(food, revisions, portions, extra)`——`extra` 排在最前面 | 同上 95-125 |
| `queryKeys.portions(foodId)` = `["foods", foodId, "portions"]` | `frontend/src/api/queries.ts:65` |
| `LogMeal` 用 `portionId: number \| null` 狀態（`null` = 直接輸入數量），在三個地方 `setPortionId`；份量下拉的標籤是「份量選項」，數量欄的標籤是「份量」（`e2e/trend.spec.ts` 用它） | `frontend/src/screens/LogMeal.tsx:102,238,278,350` |
| `log-meal.test.tsx` 既有測試的份量清單一律是 `[]`——預設份量的邏輯不會影響它們 | `frontend/tests/log-meal.test.tsx` |
| `lib/decimal.ts` 已有 `isPositiveAmount`（空字串、非數字回 false，不丟例外） | `frontend/src/lib/decimal.ts` |
| decimal.js 的 `toFixed(dp, rm)` 接受捨入模式；`Decimal.ROUND_HALF_UP` 是靜態常數 | decimal.js API |
| `MealList` 每個項目顯示「{食物名} · {quantity_g} g」 | `frontend/src/screens/MealList.tsx` |

---

## 與規格的差異（寫計畫時發現，已決定）

1. **規格 §3.2 第 3 條「份量格式錯誤 → 422，而且食物沒有被建立（守同一個交易）」證明不了同一個交易。** Pydantic 在進入 handler 之前就擋下 422，不管實作是一次還是兩次 commit 都會綠。計畫保留那條（它守的是「驗證在寫入之前」），**另外加一條真的有鑑別力的**：monkeypatch 讓份量在 commit 時被資料庫的 `CHECK (grams > 0)` 擋下，確認食物也沒留下。
2. **規格 §7.2 的 e2e 用「飲食頁熱量 = 每 100 × 1.5」驗證** → 改成「飲食頁餐點清單裡那個食物顯示 150 g」。同一件事（選上了 150 g 的份量），但不受同一個帳號在平行執行的其他 e2e 影響。
3. **`AddPortionForm` 獨立成元件**（規格只說「在份量區塊加表單」）：`FoodDetail` 已經 335 行。

---

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/schemas/food.py`（改） | `DefaultPortionInput`；`FoodCreateRequest.default_portion` |
| `app/api/routes/foods.py`（改） | `create_food` 在同一個交易裡加份量 |
| `tests/test_foods_create.py`（改） | 5 條新測試 |
| `frontend/src/api/schema.d.ts`（重新產生） | |
| `frontend/src/lib/decimal.ts`（改） | `perServingToPer100` |
| `frontend/tests/decimal.test.ts`（改） | |
| `frontend/src/screens/NewFood.tsx`（改） | 份量區塊、營養標示切換、換算預覽、驗證 |
| `frontend/tests/new-food.test.tsx`（改） | |
| `frontend/src/components/AddPortionForm.tsx`（新） | 食物詳情頁的新增份量表單 |
| `frontend/src/screens/FoodDetail.tsx`（改） | 放進 `AddPortionForm`；清單單位跟著食物 |
| `frontend/tests/food-detail.test.tsx`（改） | |
| `frontend/src/lib/portions.ts`（新） | `pickDefaultPortion`（純函式） |
| `frontend/tests/portions.test.ts`（新） | |
| `frontend/src/screens/LogMeal.tsx`、`LogMeal.module.css`（改） | 預設份量、單位提示 |
| `frontend/tests/log-meal.test.tsx`（改） | |
| `frontend/e2e/portions.spec.ts`（新） | |

---

## Task 1：後端 `default_portion`

**Files:** Modify `app/schemas/food.py`、`app/api/routes/foods.py`；Test `tests/test_foods_create.py`；Regenerate `frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_foods_create.py` 的 imports 改成：

```python
from decimal import Decimal

from sqlalchemy import func, select

from app.models.food import Food, FoodRevision, RevisionStatus
from app.models.user import UserRole
from app.security.tokens import create_access_token
from tests.factories import create_food, create_user
```

（保留檔案原本有、這裡沒列到的 import。）

檔尾加：

```python
NUTRITION = {"kcal": "180", "protein_g": "6", "fat_g": "7", "carb_g": "22"}


async def test_create_food_with_a_default_portion_creates_it(client, db_session):
    """新增食物時一併建立「一份」（食物份量規格 §3.1）。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "滷肉飯",
            "nutrition": NUTRITION,
            "default_portion": {"label": "碗", "grams": "150"},
        },
    )

    assert response.status_code == 201
    portions = await client.get(
        f"/api/foods/{response.json()['id']}/portions", headers=auth(user)
    )
    body = portions.json()
    assert len(body) == 1
    assert body[0]["label"] == "碗"
    assert body[0]["grams"] == "150.00"
    assert body[0]["is_default"] is True
    assert body[0]["is_global"] is False


async def test_create_food_without_a_default_portion_has_no_portions(client, db_session):
    """不帶 default_portion 時行為完全不變——加欄位不能改變預設行為。"""
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods", headers=auth(user), json={"name": "白飯", "nutrition": NUTRITION}
    )

    assert response.status_code == 201
    portions = await client.get(
        f"/api/foods/{response.json()['id']}/portions", headers=auth(user)
    )
    assert portions.json() == []


async def test_default_portion_with_zero_grams_is_rejected_before_anything_is_written(
    client, db_session
):
    """份量格式錯誤 → 422，而且食物沒有被建立。

    **這條守的是「驗證在任何寫入之前」，不是「同一個交易」**：Pydantic 在
    進入 handler 之前就擋下來了，不管實作是一次還是兩次 commit 都會綠。
    「同一個交易」由下一條測試守。
    """
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "零克食物",
            "nutrition": NUTRITION,
            "default_portion": {"label": "碗", "grams": "0"},
        },
    )

    assert response.status_code == 422
    count = await db_session.scalar(
        select(func.count()).select_from(Food).where(Food.name == "零克食物")
    )
    assert count == 0


async def test_food_and_default_portion_are_written_in_one_transaction(
    client, db_session, monkeypatch
):
    """份量寫入失敗時，食物也不能留下來（規格 §2「同一個交易」）。

    讓份量的 grams 在 commit 時被資料庫的 CHECK (grams > 0) 擋下——
    Pydantic 已經放行，所以這是真的走到寫入才失敗。

    **如果實作把份量放在另一次 commit（食物先 commit），這條會紅**：
    食物已經寫進去了，第二次 commit 失敗也撤不回來。
    """
    from app.api.routes import foods as foods_route

    real_portion = foods_route.FoodPortion

    def portion_that_violates_the_check(**kwargs):
        return real_portion(**{**kwargs, "grams": Decimal("-1")})

    monkeypatch.setattr(foods_route, "FoodPortion", portion_that_violates_the_check)
    user = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(user),
        json={
            "name": "交易測試食物",
            "nutrition": NUTRITION,
            "default_portion": {"label": "碗", "grams": "150"},
        },
    )

    assert response.status_code != 201
    monkeypatch.undo()
    count = await db_session.scalar(
        select(func.count()).select_from(Food).where(Food.name == "交易測試食物")
    )
    assert count == 0


async def test_admin_global_food_gets_a_global_default_portion(client, db_session):
    """份量跟著食物走：公開食物的預設份量是公開的，別的使用者也看得到。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    other = await create_user(db_session)

    response = await client.post(
        "/api/foods",
        headers=auth(admin),
        json={
            "name": "公開滷肉飯",
            "nutrition": NUTRITION,
            "is_global": True,
            "default_portion": {"label": "碗", "grams": "200"},
        },
    )

    assert response.status_code == 201
    portions = await client.get(
        f"/api/foods/{response.json()['id']}/portions", headers=auth(other)
    )
    body = portions.json()
    assert [item["label"] for item in body] == ["碗"]
    assert body[0]["is_global"] is True
```

- [ ] **Step 2: 跑測試確認它失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_foods_create.py -q
```

Expected：
- 「…creates_it」FAIL（`default_portion` 被 Pydantic 忽略，沒有份量）
- 「…has_no_portions」**PASS**（現況就是沒有份量）
- 「…rejected_before_anything_is_written」FAIL（欄位被忽略 → 201）
- 「…one_transaction」FAIL（`FoodPortion` 根本沒被呼叫 → 201）
- 「…global_default_portion」FAIL

既有測試全部 PASS。**實際不同就照實回報。**

- [ ] **Step 3: 實作**

`app/schemas/food.py`，在 `class FoodCreateRequest` **之前**加：

```python
class DefaultPortionInput(BaseModel):
    """新增食物時一併建立的「一份」（食物份量規格 §3.1）。

    限制跟 `PortionCreateRequest` 的同名欄位一樣——同一個資料庫欄位，
    不該有兩套規則。
    """

    label: str = Field(min_length=1, max_length=50)
    grams: Decimal = Field(gt=0, le=10000, max_digits=8, decimal_places=2)
```

`FoodCreateRequest` 裡 `is_global` 之後加：

```python
    # 選填的「一份」，跟食物在同一個交易裡建立（食物份量規格 §3.1）。
    default_portion: DefaultPortionInput | None = None
```

`app/api/routes/foods.py` 的 `create_food`：在 `food.current_revision_id = revision.id` 之後、`try: await db.commit()` 之前加：

```python
    if payload.default_portion is not None:
        # 跟食物、第一個版本在同一個交易裡（食物份量規格 §3.1）：任何一步
        # 失敗，下面的 commit 不會成功，不會留下「食物建了、份量沒建」的
        # 半套狀態。份量跟著食物走——私人食物建私人份量，公開食物建公開份量。
        db.add(
            FoodPortion(
                food_id=food.id,
                owner_id=owner_id,
                label=payload.default_portion.label,
                grams=payload.default_portion.grams,
                is_default=True,
            )
        )
```

> 份量的 INSERT 會在 commit 的 flush 時送出；`CHECK` 失敗的 IntegrityError 由**既有的** `except IntegrityError` 接住、rollback、回 409。那個錯誤碼（`FOOD_EXISTS`）對這個情境不精確，但這條路徑只有在 Pydantic 被繞過時才會走到（就是上面那條 monkeypatch 測試）——不另外處理。

- [ ] **Step 4: 跑測試確認通過**

```
./.venv/Scripts/python.exe -m pytest tests/test_foods_create.py tests/test_foods_portions.py -q
```

Expected：全部 PASS。

- [ ] **Step 5: 突變測試——證明「同一個交易」那條守得住**

把加份量的那段搬到 `await db.commit()` **之後**，並在後面另外 `await db.commit()`：

```python
    # (突變) 食物先 commit，份量另外 commit
    await db.commit()
    if payload.default_portion is not None:
        db.add(FoodPortion(...同上...))
        await db.commit()
```

（原本 try/except 包住的那個 commit 保留在前面。）

```
./.venv/Scripts/python.exe -m pytest tests/test_foods_create.py -q -k one_transaction
```

Expected：**FAIL**（食物已經寫進去了，或第二次 commit 的 IntegrityError 沒被接住而炸開——兩種都算紅，照實回報是哪一種）。**改回來。**

- [ ] **Step 6: 整個後端測試與 lint**

```
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m ruff check app tests
```

Expected：全部 PASS（602 + 5）；ruff 乾淨。

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

Expected：diff 只有 `DefaultPortionInput` 與 `FoodCreateRequest.default_portion` 相關的幾十行以內；typecheck 通過。**diff 很大就停下來回報。** 確認 `schema.d.ts` 是 LF。

- [ ] **Step 8: Commit**

```
feat(foods): 新增食物時可以一併建立「一份」

POST /api/foods 多一個選填的 default_portion（label、grams，限制跟
PortionCreateRequest 一樣），在 create_food 唯一的那個 commit 之前加進去
——食物、第一個版本、份量同一個交易，不會留下半套狀態。

「422 而且食物沒建立」那條只守「驗證在寫入之前」；同一個交易由另一條
monkeypatch 測試守：讓份量在 commit 時被 CHECK 擋下，食物也不能留下。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/food.py app/api/routes/foods.py tests/test_foods_create.py frontend/src/api/schema.d.ts
```

---

## Task 2：`perServingToPer100`

**Files:** Modify `frontend/src/lib/decimal.ts`；Test `frontend/tests/decimal.test.ts`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/decimal.test.ts`：把 `perServingToPer100` 加進檔案頂端從 `../src/lib/decimal` 的 import；檔尾加：

```ts
describe("perServingToPer100", () => {
	it("每份換算成每 100，四捨五入到小數兩位", () => {
		// 包裝標示：每一份量 45 公克，熱量 210 大卡 → 每 100 公克 466.666…
		expect(perServingToPer100("210", "45")).toBe("466.67");
	});

	it("剛好 100 的份量不變", () => {
		expect(perServingToPer100("12.5", "100")).toBe("12.50");
	});

	it("四捨五入是 half-up，不是無條件捨去", () => {
		// 2 / 3 × 100 = 66.666… → 66.67（無條件捨去會是 66.66）
		expect(perServingToPer100("2", "3")).toBe("66.67");
	});

	it("0 也是合法的營養素值", () => {
		expect(perServingToPer100("0", "45")).toBe("0.00");
	});

	it.each([
		["210", "0"],
		["210", ""],
		["210", "-5"],
		["210", "abc"],
		["", "45"],
		["abc", "45"],
		["-1", "45"],
	])("(%s, %s) 不能換算時回 null，不丟例外、不除以零", (value, grams) => {
		expect(perServingToPer100(value, grams)).toBeNull();
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/decimal.test.ts
```

Expected：新的條目 FAIL（`perServingToPer100 is not a function`，加上型別錯誤）；既有的 PASS。

- [ ] **Step 3: 實作**

`frontend/src/lib/decimal.ts`，`isPositiveAmount` 之後加：

```ts
/** 「每一份」的營養素換算成「每 100 單位」（食物份量規格 §4.2）。
 *
 *  結果四捨五入到小數兩位（half-up）——後端的 `NutritionInput` 是
 *  `decimal_places=2`。
 *
 *  **精度**：存的是每 100、兩位小數；記一餐用「1 份」時會再乘回去，誤差
 *  在第三位小數以下。例：每份 45 g、210 kcal → 存 466.67 → 記一份算出
 *  210.0015，顯示 210。可以接受，但要知道它存在。
 *
 *  任何一個參數不是合法數字、營養素是負數、或份量不是正數 → `null`。
 *  **不丟例外、不除以零**：表單打到一半的值是常態。 */
export function perServingToPer100(
	value: string,
	servingGrams: string,
): string | null {
	if (value.trim() === "" || servingGrams.trim() === "") return null;
	try {
		const amount = new Decimal(value);
		const grams = new Decimal(servingGrams);
		if (!amount.isFinite() || !grams.isFinite()) return null;
		if (amount.isNegative() || !grams.greaterThan(0)) return null;
		return amount
			.times(100)
			.dividedBy(grams)
			.toFixed(2, Decimal.ROUND_HALF_UP);
	} catch {
		return null;
	}
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/decimal.test.ts tests/decimal-containment.test.ts
```

Expected：全部 PASS。

- [ ] **Step 5: 突變測試**

把 `Decimal.ROUND_HALF_UP` 改成 `Decimal.ROUND_DOWN` → Expected：「四捨五入是 half-up…」與「每份換算成每 100…」**FAIL**。改回來。

- [ ] **Step 6: 靜態檢查**

```
npm run -s typecheck
npm run -s lint
```

- [ ] **Step 7: Commit**

```
feat(decimal): 每份的營養素換算成每 100

經過 decimal.js、四捨五入 half-up 到兩位小數（後端 decimal_places=2）。
不能換算時回 null——不丟例外、不除以零。精度的代價寫在 docstring。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/lib/decimal.ts frontend/tests/decimal.test.ts
```

---

## Task 3：新增食物畫面

**Files:** Modify `frontend/src/screens/NewFood.tsx`；Test `frontend/tests/new-food.test.tsx`

**不能動的東西：** `NUMERIC_FIELDS` 的 `label`（`FoodDetail` 共用、三個 e2e 用它找欄位）。「每一份」的標籤用**另一份**對照表，只有 `NewFood` 用。

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/new-food.test.tsx` 加：

在 `fillNutrition` 之後：

```tsx
const CREATED = {
	id: 42,
	name: "滷肉飯",
	brand: null,
	is_global: false,
	nutrition: {
		base_unit: "g",
		kcal: "180.00",
		protein_g: "6.00",
		fat_g: "7.00",
		carb_g: "22.00",
	},
};

function postBody(
	fetchMock: ReturnType<typeof mockApi>,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/api/foods"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function mockCreate() {
	return mockApi([
		{ method: "POST", path: "/api/foods", handler: () => json(CREATED, 201) },
	]);
}
```

加到 `describe` 裡：

```tsx
	it("填了一份：body 帶 default_portion，營養素照原樣（每 100）", async () => {
		const fetchMock = mockCreate();
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "滷肉飯");
		await userEvent.type(screen.getByLabelText("份量名稱"), "碗");
		await userEvent.type(screen.getByLabelText("每份重量（g）"), "150");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByText("food-detail:42")).toBeInTheDocument();
		const body = postBody(fetchMock);
		expect(body?.default_portion).toEqual({ label: "碗", grams: "150" });
		expect((body?.nutrition as Record<string, unknown>).kcal).toBe("165");
	});

	it("沒填一份：body 不帶 default_portion", async () => {
		const fetchMock = mockCreate();
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "滷肉飯");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByText("food-detail:42")).toBeInTheDocument();
		expect(postBody(fetchMock)).not.toHaveProperty("default_portion");
	});

	it("「每一份」模式：送出的是換算成每 100 的值，畫面上看得到換算結果", async () => {
		const fetchMock = mockCreate();
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "洋芋片");
		await userEvent.type(screen.getByLabelText("份量名稱"), "份");
		await userEvent.type(screen.getByLabelText("每份重量（g）"), "45");
		await userEvent.click(screen.getByRole("radio", { name: "每一份" }));
		await userEvent.type(screen.getByLabelText("熱量（每份 kcal）"), "210");
		await userEvent.type(screen.getByLabelText("蛋白質（每份 g）"), "9");
		await userEvent.type(screen.getByLabelText("脂肪（每份 g）"), "4.5");
		await userEvent.type(screen.getByLabelText("碳水化合物（每份 g）"), "30");

		expect(screen.getByTestId("per100-preview")).toHaveTextContent("466.67");

		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByText("food-detail:42")).toBeInTheDocument();
		expect(postBody(fetchMock)?.nutrition).toMatchObject({
			kcal: "466.67",
			protein_g: "20.00",
			fat_g: "10.00",
			carb_g: "66.67",
		});
	});

	it.each([
		["只填份量名稱", "份量名稱", "碗"],
		["只填重量", "每份重量（g）", "150"],
	])("%s：擋下來，不送請求", async (_case, label, value) => {
		const fetchMock = mockApi([]);
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "滷肉飯");
		await userEvent.type(screen.getByLabelText(label), value);
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"份量名稱與重量要一起填",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("沒填每份重量時「每一份」不能選；清掉重量會切回每 100", async () => {
		render(wrap(<NewFood />));

		expect(screen.getByRole("radio", { name: "每一份" })).toBeDisabled();
		expect(screen.getByRole("radio", { name: "每 100 g" })).toBeChecked();

		await userEvent.type(screen.getByLabelText("每份重量（g）"), "45");
		await userEvent.click(screen.getByRole("radio", { name: "每一份" }));
		expect(screen.getByRole("radio", { name: "每一份" })).toBeChecked();

		await userEvent.clear(screen.getByLabelText("每份重量（g）"));

		expect(screen.getByRole("radio", { name: "每 100 g" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "每一份" })).toBeDisabled();
		// 標籤也跟著切回每 100
		expect(
			screen.getByLabelText("熱量（每 100 單位 kcal）"),
		).toBeInTheDocument();
	});

	it("換算後超過上限：擋下來並提示檢查重量", async () => {
		const fetchMock = mockApi([]);
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "打錯重量");
		await userEvent.type(screen.getByLabelText("份量名稱"), "份");
		// 實際是 10 g 打成 1 g：200 kcal / 1 g → 每 100 g 20000 kcal
		await userEvent.type(screen.getByLabelText("每份重量（g）"), "1");
		await userEvent.click(screen.getByRole("radio", { name: "每一份" }));
		await userEvent.type(screen.getByLabelText("熱量（每份 kcal）"), "200");
		await userEvent.type(screen.getByLabelText("蛋白質（每份 g）"), "1");
		await userEvent.type(screen.getByLabelText("脂肪（每份 g）"), "1");
		await userEvent.type(screen.getByLabelText("碳水化合物（每份 g）"), "1");
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"換算後超過上限，請確認每份重量",
		);
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("「每 100」模式下四個欄位的標籤跟以前一字不差", () => {
		// 守既有 e2e（foods / admin / mobile-form-zoom）與 FoodDetail 共用的標籤。
		// 用字面字串，不是引用 NUMERIC_FIELDS——引用常數的話，改了常數這條照樣綠。
		render(wrap(<NewFood />));

		for (const label of [
			"熱量（每 100 單位 kcal）",
			"蛋白質（g）",
			"脂肪（g）",
			"碳水化合物（g）",
		]) {
			expect(screen.getByLabelText(label)).toBeInTheDocument();
		}
	});
```

> 「擋下來，不送請求」兩條：驗證失敗是**同步**擋下的（`handleSubmit` 在 `mutate()` 之前 return），所以 `not.toHaveBeenCalled()` 有鑑別力；突變步驟會確認。

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/new-food.test.tsx
```

Expected：新的條目除了「「每 100」模式下四個欄位的標籤跟以前一字不差」與「沒填一份：body 不帶 default_portion」（兩條現況就會綠）之外都 FAIL（找不到「份量名稱」等）。既有的條目 PASS。照實回報。

- [ ] **Step 3: 實作**

`frontend/src/screens/NewFood.tsx`：

imports 加：

```tsx
import { isPositiveAmount, perServingToPer100 } from "../lib/decimal";
```

`NUMERIC_FIELDS` 之後加：

```tsx
/** 「每一份」模式的欄位標籤。**只有 NewFood 用**——`NUMERIC_FIELDS` 的
 *  標籤不能動（FoodDetail 共用、e2e 用它找欄位）。 */
const PER_SERVING_LABELS: Record<NumericField, string> = {
	kcal: "熱量（每份 kcal）",
	protein_g: "蛋白質（每份 g）",
	fat_g: "脂肪（每份 g）",
	carb_g: "碳水化合物（每份 g）",
};

/** 份量重量的後端上限（`DefaultPortionInput.grams` 的 `le=10000`）。 */
const MAX_PORTION_GRAMS = 10000;

type NutritionBasis = "per100" | "perServing";
```

`NewFood()` 裡，`values` 之後加 state：

```tsx
	// 「一份」（選填，食物份量規格 §4.1）。兩個要一起填。
	const [portionLabel, setPortionLabel] = useState("");
	const [portionGrams, setPortionGrams] = useState("");
	const [basis, setBasis] = useState<NutritionBasis>("per100");
	const servingGramsValid = isPositiveAmount(portionGrams);
```

（`isPositiveAmount` 對空字串、0、非數字都回 `false`。）

`createFood` 的 `mutationFn` 之前加換算：

```tsx
	// 送出與預覽用的「每 100」值。「每一份」模式下換算不了的欄位是 null。
	const per100: Record<NumericField, string | null> =
		basis === "per100"
			? values
			: {
					kcal: perServingToPer100(values.kcal, portionGrams),
					protein_g: perServingToPer100(values.protein_g, portionGrams),
					fat_g: perServingToPer100(values.fat_g, portionGrams),
					carb_g: perServingToPer100(values.carb_g, portionGrams),
				};
	const hasPortion = portionLabel.trim() !== "" && portionGrams.trim() !== "";
```

`mutationFn` 的 `body` 改成（`name`、`brand` 與它們的註解不動）：

```tsx
					nutrition: {
						base_unit: baseUnit,
						// 四個數值一律以字串送出（規格 §5.1）。「每一份」模式送的是
						// 換算後的每 100 值——後端只存每 100（食物份量規格 §4.2）。
						// validate() 已經保證走到這裡時不會是 null。
						kcal: per100.kcal,
						protein_g: per100.protein_g,
						fat_g: per100.fat_g,
						carb_g: per100.carb_g,
					},
					...(hasPortion
						? {
								default_portion: {
									label: portionLabel.trim(),
									grams: portionGrams.trim(),
								},
							}
						: {}),
```

`validate()` 整個換成：

```tsx
	function validate(): string | null {
		if (name.trim() === "") return "請輸入名稱";

		const labelFilled = portionLabel.trim() !== "";
		const gramsFilled = portionGrams.trim() !== "";
		if (labelFilled !== gramsFilled) return "份量名稱與重量要一起填";
		if (gramsFilled) {
			if (!servingGramsValid) return "每份重量要大於 0";
			if (Number(portionGrams) > MAX_PORTION_GRAMS) {
				return `每份重量不能超過 ${MAX_PORTION_GRAMS}`;
			}
		}

		for (const { field, label, max } of NUMERIC_FIELDS) {
			const raw = values[field];
			const shownLabel =
				basis === "perServing" ? PER_SERVING_LABELS[field] : label;
			if (raw.trim() === "") return `請輸入${shownLabel}`;
			if (basis === "perServing") {
				const converted = per100[field];
				if (converted === null) return `${shownLabel}必須是 0 以上的數字`;
				// 換算後超過上限，通常代表每份重量少打一位數。
				if (Number(converted) > max) return "換算後超過上限，請確認每份重量";
				continue;
			}
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
				return `${label}必須介於 0 到 ${max} 之間`;
			}
		}
		return null;
	}
```

> `Number(converted) > max` 只做大小比較，不做運算——跟既有 `validate` 對每 100 值用 `Number` 比上下限是同一個作法。

JSX：在「單位」的 `<select>` 之後、`NUMERIC_FIELDS.map` 之前加：

```tsx
				<fieldset>
					<legend>一份（選填）</legend>
					<label htmlFor="portion-label">份量名稱</label>
					<input
						id="portion-label"
						type="text"
						maxLength={50}
						placeholder="例如：碗、片、包"
						value={portionLabel}
						onChange={(event) => setPortionLabel(event.target.value)}
					/>
					<label htmlFor="portion-grams">每份重量（{baseUnit}）</label>
					<input
						id="portion-grams"
						type="text"
						inputMode="decimal"
						value={portionGrams}
						onChange={(event) => {
							const next = event.target.value;
							setPortionGrams(next);
							// 清掉或改成不合法的重量時切回每 100——不能停在
							// 一個無法換算的狀態（規格 §4.1）。
							if (!isPositiveAmount(next)) setBasis("per100");
						}}
					/>
				</fieldset>

				<fieldset>
					<legend>營養標示是</legend>
					<label>
						<input
							type="radio"
							name="nutrition-basis"
							value="per100"
							checked={basis === "per100"}
							onChange={() => setBasis("per100")}
						/>
						每 100 {baseUnit}
					</label>
					<label>
						<input
							type="radio"
							name="nutrition-basis"
							value="perServing"
							checked={basis === "perServing"}
							disabled={!servingGramsValid}
							onChange={() => setBasis("perServing")}
						/>
						每一份
					</label>
					{!servingGramsValid && <span>先填每份的重量</span>}
				</fieldset>
```

`NUMERIC_FIELDS.map` 裡的 `<label>` 改成依模式顯示：

```tsx
						<label htmlFor={`food-${field}`}>
							{basis === "perServing" ? PER_SERVING_LABELS[field] : label}
						</label>
```

在 `NUMERIC_FIELDS.map(...)` 之後、錯誤訊息之前加預覽：

```tsx
				{basis === "perServing" && (
					<p data-testid="per100-preview">
						換算成每 100 {baseUnit}：熱量 {per100.kcal ?? "—"} kcal、蛋白質{" "}
						{per100.protein_g ?? "—"} g、脂肪 {per100.fat_g ?? "—"} g、碳水{" "}
						{per100.carb_g ?? "—"} g
					</p>
				)}
```

> radio 的可及名稱是「每 100 g」：`每 100 {baseUnit}` 在 JSX 裡是「每 100 」＋「g」兩個文字節點，可及名稱會合成「每 100 g」。如果測試找不到（例如多一個空白），以實際的可及名稱為準並回報。

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/new-food.test.tsx tests/food-detail.test.tsx
```

Expected：全部 PASS（`food-detail` 確認 `NUMERIC_FIELDS` 沒被動到）。

- [ ] **Step 5: 突變測試**

1. 「每一份」模式下送原始值：把 body 的 `kcal: per100.kcal` 改成 `kcal: values.kcal` → Expected：「「每一份」模式：送出的是換算成每 100 的值…」**FAIL**。改回來。
2. 拿掉 `if (labelFilled !== gramsFilled) return …` → Expected：兩條「…擋下來，不送請求」**FAIL**。改回來。
3. 拿掉重量 `onChange` 裡的 `if (!isPositiveAmount(next)) setBasis("per100");` → Expected：「沒填每份重量時…清掉重量會切回每 100」**FAIL**。改回來。

- [ ] **Step 6: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 7: Commit**

```
feat(foods): 新增食物可以設定一份，也可以照包裝標示「每一份」輸入

一份（份量名稱＋每份重量）選填，兩個要一起填，跟食物在同一個請求裡送出。
營養標示可以選每 100 或每一份；每一份在前端經 perServingToPer100 換算成
每 100 再送，畫面即時顯示換算結果，上限用換算後的值檢查。

每 100 模式的四個標籤一字不差——FoodDetail 共用、三個 e2e 用它們找欄位，
有一條測試用字面字串守著。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/NewFood.tsx frontend/tests/new-food.test.tsx
```

---

## Task 4：食物詳情頁新增份量

**Files:** Create `frontend/src/components/AddPortionForm.tsx`；Modify `frontend/src/screens/FoodDetail.tsx`；Test `frontend/tests/food-detail.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/food-detail.test.tsx`：

**改掉**「份量清單唯讀——顯示得出來，但沒有新增或修改的表單」這一條（它跟這次的需求直接衝突）：

```tsx
	it("份量清單顯示名稱與重量", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], PORTIONS));

		render(wrap(<FoodDetail />, "/foods/1"));

		expect(await screen.findByText(/一份/)).toBeInTheDocument();
		expect(screen.getByText(/150 g/)).toBeInTheDocument();
	});
```

在 `PORTIONS` 之後加：

```tsx
const LIQUID_FOOD = {
	id: 4,
	name: "豆漿",
	brand: null,
	is_global: false,
	nutrition: { ...nutrition("60.00"), base_unit: "ml" as const },
};

function postedPortion(
	fetchMock: ReturnType<typeof mockApi>,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/portions"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function portionGets(fetchMock: ReturnType<typeof mockApi>): number {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "GET" &&
			String(input).includes("/portions"),
	).length;
}
```

加到 `describe` 裡：

```tsx
	it("新增份量：送出名稱、重量與預設，成功後清單重抓、表單清空", async () => {
		const fetchMock = mockApi(
			foodRoutes(PRIVATE_FOOD, [], [], [
				{
					method: "POST",
					path: "/api/foods/1/portions",
					handler: () =>
						json(
							{ id: 9, label: "碗", grams: "150.00", is_default: true, is_global: false },
							201,
						),
				},
			]),
		);
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("自製便當");

		await userEvent.type(screen.getByLabelText("份量名稱"), "碗");
		await userEvent.type(screen.getByLabelText("重量（g）"), "150");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		await waitFor(() => expect(portionGets(fetchMock)).toBeGreaterThanOrEqual(2));
		expect(postedPortion(fetchMock)).toEqual({
			label: "碗",
			grams: "150",
			is_default: true,
		});
		expect(screen.getByLabelText("份量名稱")).toHaveValue("");
	});

	it("已經有預設份量時，「預設」勾選框一開始不勾；沒有時勾起來", async () => {
		mockApi(foodRoutes(PRIVATE_FOOD, [], PORTIONS));
		const { unmount } = render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText(/一份/);

		expect(
			screen.getByRole("checkbox", { name: "記一餐時預設用這個份量" }),
		).not.toBeChecked();
		unmount();

		vi.restoreAllMocks();
		setTokens({ access_token: "a", refresh_token: "r" });
		mockApi(foodRoutes(PRIVATE_FOOD, [], []));
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("這個食物還沒有份量資料");

		expect(
			screen.getByRole("checkbox", { name: "記一餐時預設用這個份量" }),
		).toBeChecked();
	});

	it("同名份量：顯示後端的訊息", async () => {
		mockApi(
			foodRoutes(PRIVATE_FOOD, [], PORTIONS, [
				{
					method: "POST",
					path: "/api/foods/1/portions",
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
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText(/一份/);

		await userEvent.type(screen.getByLabelText("份量名稱"), "一份");
		await userEvent.type(screen.getByLabelText("重量（g）"), "150");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		expect(
			await screen.findByText("你已經為這個食物建過同名的份量了"),
		).toBeInTheDocument();
	});

	it("名稱或重量沒填：擋下來，不送請求", async () => {
		const fetchMock = mockApi(foodRoutes(PRIVATE_FOOD, [], []));
		render(wrap(<FoodDetail />, "/foods/1"));
		await screen.findByText("自製便當");

		await userEvent.type(screen.getByLabelText("重量（g）"), "150");
		await userEvent.click(screen.getByRole("button", { name: "新增份量" }));

		expect(await screen.findByText("請輸入份量名稱")).toBeInTheDocument();
		expect(postedPortion(fetchMock)).toBeNull();
	});

	it("液體食物的份量與重量欄位顯示 ml", async () => {
		mockApi(
			foodRoutes(LIQUID_FOOD, [], [
				{ id: 2, label: "杯", grams: "300.00", is_default: true, is_global: false },
			]),
		);
		render(wrap(<FoodDetail />, "/foods/4"));

		expect(await screen.findByText(/300 ml/)).toBeInTheDocument();
		expect(screen.getByLabelText("重量（ml）")).toBeInTheDocument();
	});
```

把 `waitFor` 加進檔案頂端從 `@testing-library/react` 的 import。

> 「預設勾選框」那條在同一個測試裡渲染兩次：第一次之後要 `unmount`，並重設 fetch mock 與 token（`beforeEach` 只在測試開始時跑一次）。

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/food-detail.test.tsx
```

Expected：新的 5 條 FAIL（找不到「份量名稱」等）；改過的「份量清單顯示名稱與重量」PASS；其他既有的 PASS。

- [ ] **Step 3: 實作 `AddPortionForm`**

Create `frontend/src/components/AddPortionForm.tsx`：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { isPositiveAmount } from "../lib/decimal";
import { describeFieldErrors } from "../screens/NewFood";

type Portion = components["schemas"]["PortionResponse"];
type BaseUnit = components["schemas"]["BaseUnit"];

type Props = {
	foodId: number;
	/** 食物的單位——重量欄位跟著它（液體是 ml）。 */
	unit: BaseUnit;
	/** 這個食物目前看得到的份量裡有沒有預設的。決定勾選框的初始值。 */
	hasDefault: boolean;
};

/** 食物詳情頁的「新增份量」（食物份量規格 §5）。
 *
 *  一律建**私人**份量（`is_global: false`）：任何人都能替看得到的食物加自己
 *  的「一碗」——「一碗」因人而異（`tests/test_foods_portions.py` 的第一條）。
 *
 *  「預設」勾選框的初始值：目前沒有任何預設份量時勾起來。使用者動過
 *  勾選框之後以使用者為準（`defaultChoice` 不是 null）；送出成功後回到
 *  跟著 `hasDefault` 走。 */
export function AddPortionForm({ foodId, unit, hasDefault }: Props) {
	const queryClient = useQueryClient();
	const [label, setLabel] = useState("");
	const [grams, setGrams] = useState("");
	const [defaultChoice, setDefaultChoice] = useState<boolean | null>(null);
	const isDefault = defaultChoice ?? !hasDefault;
	const [error, setError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<string[]>([]);

	const create = useMutation({
		mutationFn: () =>
			apiFetch<Portion>(`/api/foods/${foodId}/portions`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					label: label.trim(),
					// 字串送出，不經過 Number()。
					grams: grams.trim(),
					is_default: isDefault,
				}),
			}),
		onSuccess: () => {
			void queryClient.invalidateQueries({
				queryKey: queryKeys.portions(foodId),
			});
			setLabel("");
			setGrams("");
			setDefaultChoice(null);
			setError(null);
			setFieldErrors([]);
		},
		onError: (caught: unknown) => {
			setFieldErrors([]);
			if (caught instanceof ApiError) {
				if (caught.code === "PORTION_EXISTS") {
					// 後端的訊息就是要給使用者看的那句，不重寫一份。
					setError(caught.message);
					return;
				}
				if (caught.code === "VALIDATION_ERROR") {
					setError(null);
					setFieldErrors(describeFieldErrors(caught));
					return;
				}
			}
			setError("新增份量失敗，請再試一次");
		},
	});

	function handleSubmit(event: FormEvent<HTMLFormElement>) {
		event.preventDefault();
		setFieldErrors([]);
		if (label.trim() === "") {
			setError("請輸入份量名稱");
			return;
		}
		if (!isPositiveAmount(grams)) {
			setError("重量要大於 0");
			return;
		}
		setError(null);
		create.mutate();
	}

	return (
		<form onSubmit={handleSubmit} aria-label="新增份量">
			<label htmlFor="add-portion-label">份量名稱</label>
			<input
				id="add-portion-label"
				type="text"
				maxLength={50}
				placeholder="例如：碗、片、包"
				value={label}
				onChange={(event) => setLabel(event.target.value)}
			/>
			<label htmlFor="add-portion-grams">重量（{unit}）</label>
			<input
				id="add-portion-grams"
				type="text"
				inputMode="decimal"
				value={grams}
				onChange={(event) => setGrams(event.target.value)}
			/>
			<label>
				<input
					type="checkbox"
					checked={isDefault}
					onChange={(event) => setDefaultChoice(event.target.checked)}
				/>
				記一餐時預設用這個份量
			</label>
			{error !== null && <p role="alert">{error}</p>}
			{fieldErrors.length > 0 && (
				<ul role="alert">
					{fieldErrors.map((message, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 後端的欄位錯誤陣列沒有天然的唯一鍵，且同一次送出裡不會重排序。
						<li key={`${message}-${index}`}>{message}</li>
					))}
				</ul>
			)}
			<button type="submit" disabled={create.isPending}>
				新增份量
			</button>
		</form>
	);
}
```

> `<form aria-label="新增份量">` 與按鈕同名：`getByRole("button", { name: "新增份量" })` 只找按鈕，不會撞到 form（form 的角色是 `form`）。

- [ ] **Step 4: 接進 `FoodDetail`**

`frontend/src/screens/FoodDetail.tsx`：

- import `AddPortionForm`（`../components/AddPortionForm`）。
- 「份量」區塊：刪掉「唯讀：…」那段註解；清單的 `（{formatMacro(portion.grams)} g）` 改成 `（{formatMacro(portion.grams)} {unit}）`；清單之後放表單：

```tsx
					<section>
						<h2>份量</h2>
						{portions.length === 0 ? (
							<p>這個食物還沒有份量資料</p>
						) : (
							<ul>
								{portions.map((portion) => (
									<li key={portion.id}>
										{portion.label}（{formatMacro(portion.grams)} {unit}）
										{portion.is_default && "・預設"}
									</li>
								))}
							</ul>
						)}
						<AddPortionForm
							foodId={foodId}
							unit={unit}
							hasDefault={portions.some((portion) => portion.is_default)}
						/>
					</section>
```

- 在 `const portions = portionsQuery.data ?? [];`（約第 160 行）旁邊加：

```tsx
	// 份量的重量單位跟著食物（液體是 ml）。營養素還沒生效時沒有單位資訊，
	// 用 g——跟新增食物的預設一樣。
	const unit: BaseUnit = food?.nutrition?.base_unit ?? "g";
```

- [ ] **Step 5: 跑測試確認通過**

```
npx vitest run tests/food-detail.test.tsx
```

Expected：全部 PASS。

- [ ] **Step 6: 突變測試**

1. `is_default: isDefault` 改成 `is_default: false` → Expected：「新增份量：送出名稱、重量與預設…」**FAIL**。改回來。
2. 刪掉 `onSuccess` 的 `invalidateQueries` → Expected：同一條 **FAIL**（清單沒重抓）。改回來。
3. `const isDefault = defaultChoice ?? !hasDefault;` 改成 `defaultChoice ?? true` → Expected：「已經有預設份量時…」**FAIL**。改回來。

- [ ] **Step 7: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 8: Commit**

```
feat(foods): 食物詳情頁可以替任何食物加自己的份量

AddPortionForm 獨立成元件（FoodDetail 已經 335 行）：份量名稱、重量
（單位跟著食物）、「記一餐時預設用這個份量」——目前沒有預設份量時預設
勾起來。一律建私人份量：「一碗」因人而異。

原本「份量清單唯讀」那條測試跟這次的需求直接衝突，改成只驗清單顯示。
液體食物的份量清單順手改成顯示 ml。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/AddPortionForm.tsx frontend/src/screens/FoodDetail.tsx frontend/tests/food-detail.test.tsx
```

---

## Task 5：記一餐自動選上預設份量

**Files:** Create `frontend/src/lib/portions.ts`；Modify `frontend/src/screens/LogMeal.tsx`、`frontend/src/screens/LogMeal.module.css`；Test `frontend/tests/portions.test.ts`（新）、`frontend/tests/log-meal.test.tsx`

- [ ] **Step 1: 寫失敗的測試（純函式）**

Create `frontend/tests/portions.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { pickDefaultPortion } from "../src/lib/portions";

function portion(id: number, isDefault: boolean, isGlobal: boolean) {
	return { id, is_default: isDefault, is_global: isGlobal };
}

describe("pickDefaultPortion", () => {
	it("自己的預設份量優先於公開的", () => {
		// 「一碗」因人而異——使用者自己定義過的，比公開資料更貼近他實際吃的量。
		expect(
			pickDefaultPortion([portion(1, true, true), portion(2, true, false)])?.id,
		).toBe(2);
	});

	it("沒有自己的預設，就用公開的預設", () => {
		expect(
			pickDefaultPortion([portion(1, true, true), portion(2, false, false)])?.id,
		).toBe(1);
	});

	it("沒有任何預設份量時回 null", () => {
		expect(
			pickDefaultPortion([portion(1, false, true), portion(2, false, false)]),
		).toBeNull();
	});

	it("空清單回 null", () => {
		expect(pickDefaultPortion([])).toBeNull();
	});
});
```

- [ ] **Step 2: 跑測試確認它失敗**

```
cd frontend
npx vitest run tests/portions.test.ts
```

Expected：整個檔案 FAIL（找不到模組）。

- [ ] **Step 3: 實作**

Create `frontend/src/lib/portions.ts`：

```ts
/** 記一餐選了食物之後要預先選上哪個份量（食物份量規格 §6）。
 *
 *  自己的預設份量（`is_default && !is_global`）優先，沒有才用公開的預設份量；
 *  都沒有回 `null`（維持「直接輸入數量」）。純函式，不碰畫面。 */
export function pickDefaultPortion<
	T extends { is_default: boolean; is_global: boolean },
>(portions: readonly T[]): T | null {
	return (
		portions.find((portion) => portion.is_default && !portion.is_global) ??
		portions.find((portion) => portion.is_default && portion.is_global) ??
		null
	);
}
```

- [ ] **Step 4: 跑測試確認通過**

```
npx vitest run tests/portions.test.ts
```

- [ ] **Step 5: 寫失敗的測試（畫面）**

`frontend/tests/log-meal.test.tsx`（這個檔案用 `mockApiByPath as mockApi`，物件形式）。在 `FREQUENT_FOODS` 之後加：

```tsx
const MY_BOWL = {
	id: 7,
	label: "我的碗",
	grams: "220.00",
	is_default: true,
	is_global: false,
};
const PUBLIC_BOWL = {
	id: 8,
	label: "碗",
	grams: "200.00",
	is_default: true,
	is_global: true,
};
const PUBLIC_PLATE = {
	id: 9,
	label: "盤",
	grams: "300.00",
	is_default: false,
	is_global: true,
};

function mealBody(
	fetchMock: ReturnType<typeof mockApi>,
): { items: Array<Record<string, unknown>> } | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/api/meals"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function mockWithPortions(portions: unknown[]) {
	return mockApi({
		"/api/foods/frequent": () => json(FREQUENT_FOODS),
		"/api/foods/recent": () => json([]),
		"/api/foods/1/portions": () => json(portions),
		"/api/meals": () => json({ id: 99 }, 201),
	});
}
```

加到 `describe("記一餐", …)` 裡：

```tsx
	it("有自己的預設份量：自動選上，數量 1，送出帶它的 portion_id", async () => {
		const fetchMock = mockWithPortions([PUBLIC_BOWL, MY_BOWL, PUBLIC_PLATE]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);
		expect(screen.getByLabelText("份量")).toHaveValue("1");

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)?.items[0]).toMatchObject({
			portion_id: 7,
			quantity: "1",
		});
	});

	it("只有公開的預設份量：選公開的", async () => {
		mockWithPortions([PUBLIC_BOWL, PUBLIC_PLATE]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("8"),
		);
	});

	it("沒有預設份量：維持「直接輸入數量」，送出不帶 portion_id", async () => {
		const fetchMock = mockWithPortions([PUBLIC_PLATE]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await screen.findByLabelText("份量選項");

		expect(screen.getByLabelText("份量選項")).toHaveValue("");

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)?.items[0]).not.toHaveProperty("portion_id");
	});

	it("手動改成「直接輸入數量」之後就照使用者的，不會被預設份量蓋回去", async () => {
		const fetchMock = mockWithPortions([MY_BOWL]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)?.items[0]).not.toHaveProperty("portion_id");
	});

	it("數量旁邊的單位提示：選了份量是「份」，直接輸入是「g」", async () => {
		mockWithPortions([MY_BOWL]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);

		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("份");

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "");

		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("g");
	});
```

> `FREQUENT_FOODS` 的滷肉飯 `nutrition.base_unit` 是 `"g"`（既有 fixture）。
> 既有測試的份量清單都是 `[]`——不應該受影響；如果有既有測試變紅，停下來回報。

- [ ] **Step 6: 跑測試確認它失敗**

```
npx vitest run tests/log-meal.test.tsx
```

Expected：「有自己的預設份量…」「只有公開的預設份量…」「手動改成…」「數量旁邊的單位提示…」FAIL；「沒有預設份量…」**PASS**（現況就是直接輸入）；既有的 PASS。照實回報。

- [ ] **Step 7: 實作**

`frontend/src/screens/LogMeal.tsx`：

import 加：

```tsx
import { pickDefaultPortion } from "../lib/portions";
```

把 `const [portionId, setPortionId] = useState<number | null>(null);` 換成：

```tsx
	// 份量的選擇（食物份量規格 §6）：
	//   null     → 使用者還沒動過，用推導出來的預設份量（有的話）
	//   "manual" → 使用者選了「直接輸入數量」
	//   number   → 使用者選了某個份量
	// **不用 effect 在份量清單到的時候寫 state**：預設份量是從清單推導的，
	// 使用者一旦手動選過就以使用者為準，不會被重新抓到的清單蓋回去。
	const [portionChoice, setPortionChoice] = useState<number | "manual" | null>(
		null,
	);
```

在 `portionsQuery` 的定義之後加：

```tsx
	const defaultPortion = pickDefaultPortion(portionsQuery.data ?? []);
	const portionId =
		portionChoice === "manual"
			? null
			: (portionChoice ?? defaultPortion?.id ?? null);
```

其餘三處：
- `onSuccess` 裡的 `setPortionId(null);` → `setPortionChoice(null);`
- `selectFood` 裡的 `setPortionId(null);` → `setPortionChoice(null);`
- 份量下拉的 `onChange` 改成：

```tsx
									onChange={(event) =>
										setPortionChoice(
											event.target.value === ""
												? "manual"
												: Number(event.target.value),
										)
									}
```

（`value={portionId ?? ""}` 與送出 body 裡的 `...(portionId !== null ? { portion_id: portionId } : {})` 不用改——`portionId` 現在是推導出來的值。）

數量 `<input id="quantity" …/>` 之後加單位提示：

```tsx
					{/* 選了份量時數量是「幾份」；直接輸入時是公克（或毫升）——
					    預設的「1」在直接輸入模式下是 1 g，這個提示讓它看得出來。 */}
					<span className={styles.unit} data-testid="quantity-unit">
						{portionId !== null
							? "份"
							: (selectedFood.nutrition?.base_unit ?? "g")}
					</span>
```

`frontend/src/screens/LogMeal.module.css` 檔尾加：

```css
.unit {
	font-size: 12px;
	color: var(--color-text-muted);
}
```

- [ ] **Step 8: 跑測試確認通過**

```
npx vitest run tests/log-meal.test.tsx tests/portions.test.ts
```

Expected：全部 PASS。

- [ ] **Step 9: 突變測試**

1. `pickDefaultPortion` 的兩個 `find` 對調順序 → Expected：「自己的預設份量優先於公開的」與畫面的「有自己的預設份量…」**FAIL**。改回來。
2. `portionChoice === "manual" ? null : …` 改成直接 `portionChoice === null || portionChoice === "manual" ? (defaultPortion?.id ?? null) : portionChoice`（也就是「直接輸入」又被預設蓋回去）→ Expected：「手動改成「直接輸入數量」之後…」**FAIL**。改回來。

- [ ] **Step 10: 靜態檢查與全部測試**

```
npm run -s typecheck
npm run -s lint
npm run -s test
```

- [ ] **Step 11: Commit**

```
feat(meals): 記一餐自動選上預設份量

選了食物之後有預設份量就直接選好、數量 1——按「記錄」就是一碗。自己的
預設份量優先於公開的（pickDefaultPortion，純函式）。預設是從份量清單推導
的，不用 effect 寫 state；使用者手動選過就以使用者為準。

數量旁邊加單位提示（份／g／ml）：直接輸入模式下預設的「1」其實是 1 g。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/lib/portions.ts frontend/src/screens/LogMeal.tsx frontend/src/screens/LogMeal.module.css frontend/tests/portions.test.ts frontend/tests/log-meal.test.tsx
```

---

## Task 6：e2e

**Files:** Create `frontend/e2e/portions.spec.ts`

- [ ] **Step 1: 確認後端**

```
curl -s -o /dev/null -w "%{http_code}" http://localhost:8000/api/health
```

Expected：200。不是的話回報（不要修基礎設施）。**Task 1 改了後端，本機的 api 容器要重建才看得到 `default_portion`**：

```
cd ..   # repo 根目錄
docker compose up -d --build api
```

等 `docker inspect -f '{{.State.Health.Status}}' wallet-api-1` 是 healthy。

- [ ] **Step 2: 寫 e2e**

Create `frontend/e2e/portions.spec.ts`：

```ts
import { expect, test } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

async function login(page: import("@playwright/test").Page) {
	await page.goto("/");
	await page.getByLabel("Email").fill(ADMIN.email);
	await page.getByLabel("密碼").fill(ADMIN.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}

test("新增食物時設一份 → 記一餐自動選上那一份 → 記下的是那一份的重量", async ({
	page,
}) => {
	// 食物份量規格 §7.2。斷言用「餐點清單裡那個食物顯示 150 g」而不是
	// 熱量差——同一個帳號的其他 e2e 平行在記餐，熱量總數會一起變。
	await login(page);

	const foodName = `E2E 份量 ${Date.now()}`;
	await page.getByRole("link", { name: "飲食" }).click();
	await page.getByRole("link", { name: "食物庫" }).click();
	await page.getByRole("link", { name: "新增食物" }).click();
	await expect(page.getByRole("heading", { name: "新增食物" })).toBeVisible();

	await page.getByLabel("名稱").fill(foodName);
	await page.getByLabel("份量名稱").fill("碗");
	await page.getByLabel("每份重量（g）").fill("150");
	await page.getByLabel("熱量（每 100 單位 kcal）").fill("100");
	await page.getByLabel("蛋白質（g）").fill("10");
	await page.getByLabel("脂肪（g）").fill("5");
	await page.getByLabel("碳水化合物（g）").fill("5");
	await page.getByRole("button", { name: "建立食物" }).click();

	// 導到詳情頁，份量清單裡有剛建的那一份。
	await expect(page.getByRole("heading", { name: foodName })).toBeVisible();
	// 那一列的完整文字是「碗（150 g）・預設」——用正規表示式，不是精確比對。
	await expect(page.getByText(/碗（150 g）/)).toBeVisible();

	await page.getByRole("button", { name: "新增紀錄" }).click();
	await page.getByRole("link", { name: "記一餐" }).click();
	await page.getByLabel("搜尋食物").fill(foodName);
	await page.getByRole("button", { name: foodName }).click();

	// 預設份量自動選上，數量 1。
	await expect(page.locator("#portion option:checked")).toHaveText("碗");
	await expect(page.getByLabel("份量", { exact: true })).toHaveValue("1");
	await page.getByRole("button", { name: "記錄" }).click();

	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
	await page.getByRole("link", { name: "飲食" }).click();
	// 餐點卡片本身是 <li>，裡面每個食物又是一個 <li>（MealList）——用食物
	// 名稱篩會同時抓到外層與內層，strict mode 會報錯。取最後一個（內層那一項）。
	await expect(
		page.getByRole("listitem").filter({ hasText: foodName }).last(),
	).toContainText("150 g");
});
```

> `getByLabel("份量", { exact: true })`：「份量選項」也包含「份量」兩個字，不加 `exact` 會撞到兩個。

- [ ] **Step 3: 跑 e2e**

```
cd frontend
npx playwright test e2e/portions.spec.ts
npx playwright test
```

Expected：新的 1 條 PASS；全部 18 條 PASS。

- [ ] **Step 4: 突變檢查**

把 `LogMeal.tsx` 的 `(portionChoice ?? defaultPortion?.id ?? null)` 暫時改成 `(portionChoice ?? null)`（不自動選預設）→ 跑 `npx playwright test e2e/portions.spec.ts` → Expected：**FAIL**（選中的是「直接輸入數量」）。改回來、`git status` 確認乾淨。

- [ ] **Step 5: Commit**

```
test(e2e): 新增食物設一份，記一餐自動選上那一份

打真的後端：default_portion 在同一個交易裡建立、詳情頁列出來、記一餐
自動選上、記下的是那一份的重量。用餐點清單的「150 g」斷言，不用熱量差
——同一個帳號的其他 e2e 平行在記餐。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/e2e/portions.spec.ts
```

---

## 收尾

- [ ] 完整檢查：後端 `pytest -q`、`ruff check app tests`；前端 `typecheck`、`lint`、`test`；`npx playwright test`。
- [ ] `docs/handover.md` §8.2 的「份量管理沒有 UI」那一條改成已完成（新增食物可設一份、詳情頁可加、記一餐自動選預設）；刪除與修改份量仍然沒有（後端沒有端點）。
- [ ] 人工確認：在手機上新增一個包裝食品，用「每一份」輸入，看換算預覽與記一餐的預設份量。

---

## 自我檢查（對照規格）

| 規格 | 任務 |
|---|---|
| §3.1 `default_portion`、同一個交易、跟著食物的 owner、`is_default` | Task 1 |
| §3.2 四條後端測試 | Task 1（第 3 條另外補一條真正守交易的，見「與規格的差異」1） |
| §3.3 重新產生 schema（`PYTHONUTF8`） | Task 1 Step 7 |
| §4.1 一份（兩個要一起填）、營養標示切換、清掉重量切回、每 100 標籤不變 | Task 3 |
| §4.2 `perServingToPer100`、half-up、null 不丟例外、即時預覽、上限用換算後的值、精度 docstring | Task 2、Task 3 |
| §4.3 送出 body、成功導到詳情頁、錯誤處理不變 | Task 3 |
| §5 詳情頁新增份量、預設勾選規則、409/422/其他、送出中停用、ml | Task 4 |
| §6 自動選預設、自己的優先、手動選過不覆蓋、「份量」標籤不變、單位提示 | Task 5 |
| §7.1 單元與元件測試＋突變 | Task 1–5 |
| §7.2 e2e | Task 6（斷言方式見「與規格的差異」2） |
