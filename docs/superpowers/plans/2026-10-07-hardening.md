# 上線前的安全補強 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `/refresh` 與 `/logout` 每個使用者每分鐘 10 次；前端只有 401 才登出；一餐最多一筆餐費（同時補金額回 409）；公克數超出 `Numeric(8,2)` 或變成 0 時回 422 而不是 500。

**Architecture:** `app/ratelimit.py` 新增通用的 `KeyedRateLimiter`，兩個端點先驗簽取 `sub` 再計數、最後才碰資料庫。餐費的唯一性交給資料庫（部分唯一索引，migration `0015`），`update_meal` 把 `IntegrityError` 轉成 409。公克數的範圍檢查放在三條路共用的 `_quantity_g` 最後。前端改 `auth/refresh.ts` 的失敗分類，並讓兩個新錯誤碼顯示後端訊息。

**Tech Stack:** FastAPI · SQLAlchemy async · Alembic · PostgreSQL · React 19 · TypeScript · TanStack Query · Vitest

**依據規格：** `docs/superpowers/specs/2026-10-07-hardening-design.md`

---

## 執行環境

- 分支 `feat/hardening`（規格 commit `ece2fbb`）。
- 後端在 repo 根目錄：`PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest -q`（**一定用 `.venv`**）、`… -m ruff check app tests migrations`、`… -m mypy app`。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`（格式問題用 `npx biome check --write <檔案>`）、`npm run -s test`（**數字是實際的兩倍**）。e2e：`npx playwright test`。
- 基準線（master `f751007`）：後端 759；前端 106 檔 1024；e2e 29。
- 本機 api 容器（有 migration 或後端改動、之後要跑 e2e 時）：`docker compose up -d --build api`、`docker compose exec api python -m alembic upgrade head`、`docker compose ps`。
- **Write/Edit；LF。不要在 repo 或 scratchpad 以外的地方留備份檔或暫存腳本。** 突變用 Edit 改、跑、再用 Edit 改回。
- Commit：`git commit -F <scratchpad 裡的檔案>`，結尾 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。不要 stage `lunch.jpg`。不要 amend。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。預測的紅燈數對不上 → 照實回報是哪幾條。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. 先寫測試、看它紅，再寫實作。
4. **共用交易**：`client` 與 `db_session` 共用一個 session；斷言「寫進去了／沒寫進去」之前先 `await db_session.rollback()`，**rollback 之後 ORM 物件過期**——讀屬性前先把值存成區域變數，或 `await db_session.refresh(obj)`。路由裡 `db.rollback()` 之後也一樣（`user.id` 之類要先存）。

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `LoginRateLimiter`：固定視窗、`clock` 可注入、`reset()`；`login_rate_limiter` 是模組層單例；`TooManyRequestsError(code, message, retry_after_seconds)` 會帶 `Retry-After`（無條件進位、至少 1） | `app/ratelimit.py`、`app/errors.py:97-120` |
| `tests/conftest.py` 有 autouse fixture `_reset_login_rate_limiter` 每個測試呼叫 `login_rate_limiter.reset()` | 同檔 |
| `tests/test_rate_limit.py` 有 `_FakeClock`（`__call__`、`advance`） | 同檔:26-37 |
| `/refresh`：`rotate_session(db, token)`；`ReuseDetectedError` 先接（記 log）、`TokenError` 後接，都回 `401 INVALID_TOKEN`。`/logout`：`revoke_session(db, token)`，一律 204 | `app/api/routes/auth.py:108-183` |
| `decode_refresh_token(token) -> RefreshClaims(user_id, jti)`，驗簽、期限、`type`、`jti`；失敗丟 `TokenError` | `app/security/tokens.py:97` |
| `start_session(db, user_id) -> IssuedTokens(access_token, refresh_token)`（測試可直接發票） | `app/security/sessions.py` |
| `Expense`：`Index("ix_expenses_meal_id", "meal_id")`；`meal_id` FK `ON DELETE SET NULL` | `app/models/expense.py:82`、`migrations/versions/0010_create_expenses.py` |
| `update_meal`：先 `setattr` 改欄位，再 `select(Expense).where(meal_id).order_by(id).limit(1)`；沒有就 `db.add(Expense(...))`；最後一次 `commit` | `app/api/routes/meals.py:352-415` |
| `_quantity_g(db, *, food_id, portion_id, quantity, user)`：沒份量 → `quantity`；有份量 → `(grams * quantity).quantize(0.01, ROUND_HALF_UP)`；新增一餐（`_resolve_item`）、加一項、改一項都用它 | `app/api/routes/meals.py:70-84` |
| `meal_items.quantity_g` 是 `Numeric(8,2)` ＋ `CHECK (quantity_g > 0)`；份量 `grams` 與項目 `quantity` 的欄位限制都是 `gt=0, le=10000, decimal_places=2` | `app/models/meal.py`、`app/schemas/meal.py`、`app/schemas/food.py` |
| 測試工廠：`create_portion(db_session, *, food, label, grams, owner, is_default)`、`create_meal(..., items=[(revision, grams)])`、`create_expense(..., meal=)` | `tests/factories.py` |
| 前端 `performRefresh`：`fetch` 之後 `if (!response.ok) { clearTokens(); clearQueryCacheOnForcedLogout(queryClient); return false; }`；`fetch` 丟例外沒有接 | `frontend/src/auth/refresh.ts:12-40` |
| `tests/auth-refresh.test.ts`：401 清 token 的測試、「一次失敗之後下一次會重試」（用 401） | 同檔 |
| `LogMeal.tsx` 的 `onError`：`FOOD_HAS_NO_REVISION` → 後端訊息、`cost` 的 422 → 金額訊息、其他 →「記錄失敗，請再試一次」 | `frontend/src/screens/LogMeal.tsx:165-195` |
| `EditMealItems.tsx` 的 `describeItemError`：`PORTION_FOOD_MISMATCH`、`MEAL_ITEM_NOT_FOUND`、`FOOD_HAS_NO_REVISION`、`quantity` 的 422 | `frontend/src/screens/EditMealItems.tsx:57-75` |
| `EditMeal.tsx` 的 `describeSaveError`（`cost` 的 422 → 金額訊息、其他 →「儲存失敗，請再試一次」）；`MealDetailsForm` 的草稿 `cost`／`setCost` | `frontend/src/screens/EditMeal.tsx:72-180` |
| 本機 dev 資料庫目前沒有任何一餐有兩筆餐費（規格寫好時查過） | |

## 與規格的差異

1. **`update_meal` 抽出 `_existing_meal_expense(db, meal_id)`**（查這一餐的餐費）。不改行為；它是「同時補金額」測試的接縫——monkeypatch 讓它回 None（「沒看到對方剛補的那筆」），請求就會撞上唯一約束。不抽的話，競爭只能用兩條真的連線重現。

## 檔案結構

| 檔案 | 負責什麼 |
|---|---|
| `app/ratelimit.py`（改） | `KeyedRateLimiter`、`session_rate_limiter` |
| `app/api/routes/auth.py`（改） | `/refresh`、`/logout` 先驗簽、計數 |
| `tests/conftest.py`（改） | 重置 `session_rate_limiter` |
| `tests/test_session_rate_limit.py`（新） | |
| `frontend/src/auth/refresh.ts`、`frontend/tests/auth-refresh.test.ts`（改） | 只有 401 才登出 |
| `migrations/versions/0015_unique_expense_per_meal.py`（新）、`app/models/expense.py`（改） | 部分唯一索引 |
| `app/api/routes/meals.py`（改） | `_existing_meal_expense`、409、`_quantity_g` 的範圍 |
| `tests/test_meal_cost_unique.py`、`tests/test_meal_quantity_range.py`（新） | |
| `frontend/src/screens/EditMeal.tsx`、`LogMeal.tsx`、`EditMealItems.tsx`（改）；`frontend/tests/edit-meal.test.tsx`、`log-meal.test.tsx`（只新增測試） | 錯誤訊息 |
| `docs/handover.md`、`docs/deployment.md`、規格（改） | |

---

## Task 1：後端——`/refresh`、`/logout` 限速

**Files:**
- Modify: `app/ratelimit.py`、`app/api/routes/auth.py`、`tests/conftest.py`
- Create: `tests/test_session_rate_limit.py`

- [ ] **Step 1: 寫失敗的測試** `tests/test_session_rate_limit.py`：

```python
import pytest

from app.errors import TooManyRequestsError
from app.ratelimit import KeyedRateLimiter
from app.security.sessions import start_session
from tests.factories import create_user


class _FakeClock:
    def __init__(self) -> None:
        self.now = 0.0

    def __call__(self) -> float:
        return self.now


def _limiter(clock: _FakeClock) -> KeyedRateLimiter:
    return KeyedRateLimiter(
        limit=3, window_seconds=60, code="SLOW_DOWN", message="慢一點", clock=clock
    )


def test_the_limit_counts_every_hit_per_key_and_resets_after_the_window():
    clock = _FakeClock()
    limiter = _limiter(clock)

    for _ in range(3):
        limiter.hit("alice")
    with pytest.raises(TooManyRequestsError) as blocked:
        limiter.hit("alice")
    limiter.hit("bob")  # 別人的額度不受影響

    assert blocked.value.code == "SLOW_DOWN"
    assert blocked.value.retry_after_seconds == 60
    clock.now = 60.0
    limiter.hit("alice")  # 視窗過了


def test_reset_clears_every_key():
    limiter = _limiter(_FakeClock())
    for _ in range(3):
        limiter.hit("alice")

    limiter.reset()

    limiter.hit("alice")


async def _tokens(db_session):
    user = await create_user(db_session)
    issued = await start_session(db_session, user.id)
    return issued.refresh_token


async def test_logout_and_refresh_share_ten_requests_per_user_a_minute(client, db_session):
    token = await _tokens(db_session)

    logouts = [
        await client.post("/api/auth/logout", json={"refresh_token": token}) for _ in range(10)
    ]
    blocked = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert [r.status_code for r in logouts] == [204] * 10
    # 這張票第一次登出就已經撤銷了——第 11 次不是 401，是 429：限速在碰資料庫之前。
    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_SESSION_REQUESTS"
    assert int(blocked.headers["Retry-After"]) >= 1


async def test_another_user_is_not_affected(client, db_session):
    spammed = await _tokens(db_session)
    other = await _tokens(db_session)
    for _ in range(10):
        await client.post("/api/auth/logout", json={"refresh_token": spammed})

    response = await client.post("/api/auth/refresh", json={"refresh_token": other})

    assert response.status_code == 200


async def test_garbage_tokens_are_not_counted(client, db_session):
    token = await _tokens(db_session)
    garbage = [
        await client.post("/api/auth/refresh", json={"refresh_token": "not-a-token"})
        for _ in range(20)
    ]

    response = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert {r.status_code for r in garbage} == {401}
    assert response.status_code == 200


async def test_a_blocked_request_never_reaches_the_database(client, db_session, monkeypatch):
    token = await _tokens(db_session)
    calls: list[str] = []

    async def spy_revoke(db, refresh_token):
        calls.append("revoke")

    async def spy_rotate(db, refresh_token):
        calls.append("rotate")
        raise AssertionError("被擋的請求不該走到這裡")

    monkeypatch.setattr("app.api.routes.auth.revoke_session", spy_revoke)
    monkeypatch.setattr("app.api.routes.auth.rotate_session", spy_rotate)
    for _ in range(10):
        await client.post("/api/auth/logout", json={"refresh_token": token})

    blocked_logout = await client.post("/api/auth/logout", json={"refresh_token": token})
    blocked_refresh = await client.post("/api/auth/refresh", json={"refresh_token": token})

    assert blocked_logout.status_code == 429
    assert blocked_refresh.status_code == 429
    assert calls == ["revoke"] * 10
```

- [ ] **Step 2: 跑測試確認失敗**

```
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest tests/test_session_rate_limit.py -q
```

Expected：收集失敗（`KeyedRateLimiter` 不存在）。

- [ ] **Step 3: 實作**

`app/ratelimit.py` 檔尾（`login_rate_limiter = LoginRateLimiter()` 之後）加：

```python
SESSION_LIMIT = 10
SESSION_WINDOW_SECONDS = 60.0


class KeyedRateLimiter:
    """固定視窗、每個鍵最多 `limit` 次——**每一次 `hit` 都算**。

    跟 `LoginRateLimiter` 分開：登入只算失敗、成功就重置（擋的是猜密碼）；
    這裡擋的是「重放」——成功與失敗一樣要算，否則拿同一張票狂打的人每次
    都「成功」登出（冪等的 204），計數永遠不會累積。
    """

    def __init__(
        self,
        *,
        limit: int,
        window_seconds: float,
        code: str,
        message: str,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._limit = limit
        self._window_seconds = window_seconds
        self._code = code
        self._message = message
        self._clock = clock
        self._windows: dict[str, _Window] = {}

    def hit(self, key: str) -> None:
        now = self._clock()
        window = self._windows.get(key)
        if window is None or now - window.started_at >= self._window_seconds:
            self._windows[key] = _Window(count=1, started_at=now)
            return
        if window.count >= self._limit:
            raise TooManyRequestsError(
                self._code,
                self._message,
                retry_after_seconds=window.started_at + self._window_seconds - now,
            )
        window.count += 1

    def reset(self) -> None:
        self._windows.clear()


# `/refresh` 與 `/logout` 共用（安全補強規格 §3.1）：鍵是 token 的 `sub`（簽章驗過，
# 偽造不了）。正常使用大約每 15 分鐘換一次票，幾台裝置加起來遠低於 10 次。
session_rate_limiter = KeyedRateLimiter(
    limit=SESSION_LIMIT,
    window_seconds=SESSION_WINDOW_SECONDS,
    code="TOO_MANY_SESSION_REQUESTS",
    message="操作太頻繁，請稍後再試",
)
```

> 如果 `_Window` 是 `frozen` 的 dataclass，`window.count += 1` 會失敗——改成換一個新的 `_Window(count=window.count + 1, started_at=window.started_at)`。照現況回報。

`app/api/routes/auth.py`：import 加 `session_rate_limiter`（從 `app.ratelimit`）與 `decode_refresh_token`（從 `app.security.tokens`）。

`logout` 改成：

```python
@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
async def logout(payload: LogoutRequest, db: AsyncSession = Depends(get_db)) -> None:
    """登出這一台裝置：這張 refresh token 所屬的整條鏈立刻失效，不能再換發新票。

    對無效、過期、已經登出過的 token 一律回 204——這個端點本來就是冪等的。

    **先驗簽、再限速、最後才碰資料庫**（安全補強規格 §3.1）：簽章不對的票不計數
    （驗簽不碰資料庫、不取鎖，本來就便宜）；簽章對的票——包括早就撤銷的——
    每個使用者每分鐘最多 10 次走到 `revoke_session` 的 advisory lock。
    """
    try:
        claims = decode_refresh_token(payload.refresh_token)
    except TokenError:
        return
    session_rate_limiter.hit(str(claims.user_id))
    await revoke_session(db, payload.refresh_token)
```

`refresh` 的開頭（`try: issued = await rotate_session(...)` 之前）加：

```python
    # 先驗簽取 sub、再限速，最後才進 rotate_session 的資料庫與 advisory lock
    # （安全補強規格 §3.1；同 logout）。簽章不對 → 跟原本一樣的 401，不計數。
    try:
        claims = decode_refresh_token(payload.refresh_token)
    except TokenError as exc:
        raise UnauthorizedError("INVALID_TOKEN", "token 無效或已過期") from exc
    session_rate_limiter.hit(str(claims.user_id))
```

`tests/conftest.py`：import 加 `session_rate_limiter`；`_reset_login_rate_limiter` 裡多呼叫一行 `session_rate_limiter.reset()`（docstring 補一句：同樣是全域單例，同樣要每個測試重置）。

- [ ] **Step 4: 跑測試確認通過**：同 Step 2，Expected：6 passed。再跑既有的 `tests/test_rate_limit.py tests/test_sessions.py tests/test_sessions_concurrency.py tests/test_auth*.py -q`——全綠。**如果有既有測試在一個測試裡對同一個使用者打超過 10 次 `/refresh`／`/logout` 而變成 429，照實回報，不要調高限制、也不要改那條測試。**

- [ ] **Step 5: 突變**（Edit 改、跑 Step 2、確認紅、改回）：
  - `logout` 把 `session_rate_limiter.hit(...)` 移到 `await revoke_session(...)` **之後** → `test_a_blocked_request_never_reaches_the_database` 紅。
  - `KeyedRateLimiter.hit` 拿掉 `window.count += 1` → 頭兩條紅。

- [ ] **Step 6: 全部後端、ruff、mypy**。Expected：765（759 + 6）。

- [ ] **Step 7: Commit**

```
feat(auth): /refresh 與 /logout 每個使用者每分鐘 10 次

先驗簽取 sub、再計數、最後才碰資料庫與 advisory lock；簽章不對的票不計數。
新增通用的 KeyedRateLimiter（每一次都算，跟只算失敗的登入限速分開）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/ratelimit.py app/api/routes/auth.py tests/conftest.py tests/test_session_rate_limit.py
```

---

## Task 2：前端——只有 401 才登出

**Files:**
- Modify: `frontend/src/auth/refresh.ts`、`frontend/tests/auth-refresh.test.ts`（只新增測試）

- [ ] **Step 1: 寫失敗的測試**——`frontend/tests/auth-refresh.test.ts` 的 `describe` 裡加：

```ts
	it.each([
		[429, "TOO_MANY_SESSION_REQUESTS"],
		[500, "INTERNAL_ERROR"],
		[502, "BAD_GATEWAY"],
	])("後端回 %i：保留登入（票沒有被判定無效）", async (status, code) => {
		// 安全補強規格 §4.1：限速的 429、部署重啟的 502 都不代表票無效。
		// 以前任何非成功都會登出——NAS 一重啟，正在換票的人全被踢出去。
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(
				JSON.stringify({ error: { code, message: "x", details: {} } }),
				{ status, headers: { "content-type": "application/json" } },
			),
		);

		expect(await refreshTokens()).toBe(false);

		const { getRefreshToken } = await import("../src/auth/store");
		expect(getRefreshToken()).toBe("r1");
	});

	it("網路斷線：保留登入", async () => {
		setTokens({ access_token: "old", refresh_token: "r1" });
		vi.spyOn(globalThis, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

		expect(await refreshTokens()).toBe(false);

		const { getRefreshToken } = await import("../src/auth/store");
		expect(getRefreshToken()).toBe("r1");
	});
```

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend
npx vitest run tests/auth-refresh.test.ts
```

Expected：新的 4 條 FAIL（429／500／502 → token 被清掉；網路斷線 → `refreshTokens()` 直接 reject）。既有的全綠。

- [ ] **Step 3: 實作**——`frontend/src/auth/refresh.ts` 的 `performRefresh`，從 `const response = await fetch(...)` 到 `return false; }` 換成：

```ts
	let response: Response;
	try {
		response = await fetch("/api/auth/refresh", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ refresh_token: refreshToken }),
		});
	} catch {
		// 網路斷線：連不上不代表票無效。保留登入，這次請求就是失敗。
		return false;
	}

	if (response.status === 401) {
		// INVALID_TOKEN 可能是「票過期了」，也可能是「重用偵測撤銷了整條鏈」。
		// 前端分不出來，而處理一律相同（規格 §6.5）：清 token、清 query 快取。
		clearTokens();
		clearQueryCacheOnForcedLogout(queryClient);
		return false;
	}

	if (!response.ok) {
		// 429（限速）、5xx（部署重啟、代理的錯誤頁）：票沒有被判定無效，
		// **保留登入**（安全補強規格 §4.1）。下一次請求會再試換票。
		return false;
	}
```

（函式說明的那段「失敗（沒有票、或後端拒絕）回 `false` 並清空本地狀態」改成「只有 401 才清空本地狀態」。）

- [ ] **Step 4: 跑測試確認通過**：同 Step 2；再跑 `npx vitest run tests/client.test.ts tests/app.test.tsx`。

- [ ] **Step 5: 突變**：`response.status === 401` 改成 `!response.ok` → 429／500／502 三條紅。改回。

- [ ] **Step 6: 全部前端檢查**。

- [ ] **Step 7: Commit**

```
fix(auth): 換票只有 401 才登出

429（限速）、5xx（部署重啟）、網路斷線都保留登入——以前任何非成功都會清 token，
NAS 重啟那幾秒正在換票的人全被踢出去。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/auth/refresh.ts frontend/tests/auth-refresh.test.ts
```

---

## Task 3：一餐最多一筆餐費

**Files:**
- Create: `migrations/versions/0015_unique_expense_per_meal.py`、`tests/test_meal_cost_unique.py`
- Modify: `app/models/expense.py`、`app/api/routes/meals.py`、`frontend/src/screens/EditMeal.tsx`、`frontend/tests/edit-meal.test.tsx`（只新增測試）

- [ ] **Step 1: 寫失敗的測試** `tests/test_meal_cost_unique.py`：

```python
from datetime import UTC, datetime
from decimal import Decimal

import pytest
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError

from app.models.expense import Expense, ExpenseCategory
from app.models.meal import Meal
from app.security.tokens import create_access_token
from tests.factories import create_expense, create_meal, create_user


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def test_the_database_refuses_a_second_expense_for_the_same_meal(db_session):
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user)
    await create_expense(db_session, user=user, amount=100, meal=meal)

    db_session.add(
        Expense(
            user_id=user.id,
            meal_id=meal.id,
            category=ExpenseCategory.FOOD,
            amount=Decimal("50"),
            spent_at=datetime(2026, 1, 1, 12, tzinfo=UTC),
        )
    )
    with pytest.raises(IntegrityError, match="uq_expenses_meal_id"):
        await db_session.flush()


async def test_expenses_without_a_meal_are_unrestricted(db_session):
    user = await create_user(db_session)

    await create_expense(db_session, user=user, amount=100)
    await create_expense(db_session, user=user, amount=200)


async def test_adding_a_cost_that_someone_else_just_added_is_409_and_saves_nothing(
    client, db_session, monkeypatch
):
    """「同時補金額」：查的時候還沒有餐費，送出時另一個請求剛補了一筆。
    用 `_existing_meal_expense` 回 None 模擬「沒看到對方那一筆」。"""
    user = await create_user(db_session)
    meal = await create_meal(db_session, user=user, note="原本的備註")
    await create_expense(db_session, user=user, amount=50, meal=meal)
    meal_id = meal.id

    async def did_not_see_it(db, meal_id):
        return None

    monkeypatch.setattr("app.api.routes.meals._existing_meal_expense", did_not_see_it)

    response = await client.patch(
        f"/api/meals/{meal_id}",
        headers=auth(user),
        json={"cost": "80", "note": "新的備註"},
    )

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "MEAL_COST_CONFLICT"
    await db_session.rollback()
    amounts = (
        await db_session.scalars(select(Expense.amount).where(Expense.meal_id == meal_id))
    ).all()
    assert amounts == [Decimal("50.00")]
    note = await db_session.scalar(select(Meal.note).where(Meal.id == meal_id))
    assert note == "原本的備註"
```

`frontend/tests/edit-meal.test.tsx`：照檔案現有的寫法（`routes()`、`renderEditMeal`、`calls`）**新增**一條「金額被別的裝置改過：顯示後端訊息並重新抓這一餐」——`PATCH /api/meals/5` 回 409 `{ error: { code: "MEAL_COST_CONFLICT", message: "這一餐的金額剛被另一台裝置改過，請重新整理再試", details: {} } }`；改金額、按「儲存」；斷言訊息出現、而且 `GET /api/meals/5` 被打了第二次（用 `calls(...)` 或計數的 handler——**不是**看 `invalidateQueries` 有沒有被呼叫）。`routes()` 怎麼覆寫 PATCH 照檔案現況（例如 `itemNotFound()` 的寫法）。

- [ ] **Step 2: 跑測試確認失敗**

```
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest tests/test_meal_cost_unique.py -q
cd frontend && npx vitest run tests/edit-meal.test.tsx
```

Expected：後端第 1 條 FAIL（DID NOT RAISE）、第 2 條 PASS（守未來的）、第 3 條 FAIL（monkeypatch 的目標不存在 → AttributeError）；前端新的那條 FAIL。

- [ ] **Step 3: 實作**

`migrations/versions/0015_unique_expense_per_meal.py`：

```python
"""unique expense per meal

Revision ID: 0015
Revises: 0014
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0015"
down_revision: str | None = "0014"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    # 先查重複（安全補強規格 §3.2）。有的話**失敗**，不自動刪——那是錢的紀錄，
    # 要人看過再決定刪哪一筆。
    duplicates = (
        op.get_bind()
        .execute(
            sa.text(
                "SELECT meal_id FROM expenses WHERE meal_id IS NOT NULL "
                "GROUP BY meal_id HAVING count(*) > 1 ORDER BY meal_id"
            )
        )
        .scalars()
        .all()
    )
    if duplicates:
        raise RuntimeError(
            "這些餐有不只一筆餐費，無法建立唯一索引："
            f"meal_id {', '.join(str(d) for d in duplicates)}。"
            "這是錢的紀錄，migration 不會自動刪——到報表裡刪掉多的那筆再升級。"
        )
    op.drop_index("ix_expenses_meal_id", table_name="expenses")
    # 部分唯一索引：手動記的帳 meal_id 是 null，不受限制。它同時服務
    # ON DELETE SET NULL 的查找（舊的 ix_expenses_meal_id 的用途）。
    op.create_index(
        "uq_expenses_meal_id",
        "expenses",
        ["meal_id"],
        unique=True,
        postgresql_where=sa.text("meal_id IS NOT NULL"),
    )


def downgrade() -> None:
    op.drop_index("uq_expenses_meal_id", table_name="expenses")
    op.create_index("ix_expenses_meal_id", "expenses", ["meal_id"])
```

`app/models/expense.py`：`Index("ix_expenses_meal_id", "meal_id")` 換成（import 補 `text`）：

```python
        # 一餐最多一筆餐費（安全補強規格 §3.2）：部分唯一索引，手動記的帳
        # （meal_id 是 null）不受限制。同時服務 ON DELETE SET NULL 的查找。
        Index(
            "uq_expenses_meal_id",
            "meal_id",
            unique=True,
            postgresql_where=text("meal_id IS NOT NULL"),
        ),
```

`app/api/routes/meals.py`：
1. import 加 `from sqlalchemy.exc import IntegrityError`。
2. 新增（放在 `_costs_by_meal` 附近）：

```python
async def _existing_meal_expense(db: AsyncSession, meal_id: int) -> Expense | None:
    """這一餐的餐費（資料庫保證最多一筆：`uq_expenses_meal_id`）。"""
    expense: Expense | None = await db.scalar(
        select(Expense).where(Expense.meal_id == meal_id).order_by(Expense.id).limit(1)
    )
    return expense
```

3. `update_meal` 裡 `existing = await db.scalar(select(Expense)…limit(1))` 換成 `existing = await _existing_meal_expense(db, meal.id)`；最後的 `await db.commit()` 換成：

```python
    try:
        await db.commit()
    except IntegrityError:
        # 補金額時另一個請求剛補了一筆（uq_expenses_meal_id）：整個請求 rollback，
        # 同一次送出的餐別、備註也不存——請使用者重新整理看另一台存的值。
        await db.rollback()
        raise ConflictError(
            "MEAL_COST_CONFLICT", "這一餐的金額剛被另一台裝置改過，請重新整理再試"
        ) from None
```

4. `_costs_by_meal` 與 `update_meal` 註解裡「前提：一餐最多一筆餐費……萬一前提被打破，取 id 最小的那一筆」改成「資料庫保證一餐最多一筆（`uq_expenses_meal_id`）」。

`frontend/src/screens/EditMeal.tsx`：
- `describeSaveError` 開頭加：

```ts
	// 另一台裝置剛補了這一餐的金額（安全補強規格 §4.2）：用後端的訊息。
	if (error instanceof ApiError && error.code === "MEAL_COST_CONFLICT") {
		return error.message;
	}
```

- `MealDetailsForm` 的 `save` 加 `onError`：

```ts
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && caught.code === "MEAL_COST_CONFLICT") {
				// 重抓這一餐、清掉金額草稿：欄位換成另一台存的值。
				setCost(undefined);
				queryClient.invalidateQueries({ queryKey: queryKeys.meal(meal.id) });
			}
		},
```

- [ ] **Step 4: 跑測試確認通過**：同 Step 2；再跑 `tests/test_meals*.py tests/test_expenses*.py tests/test_cross_user_isolation.py -q`。

- [ ] **Step 5: 全部後端、ruff、mypy；全部前端**。Expected：後端 768（765 + 3）。

- [ ] **Step 6: 本機 api 容器**（見「執行環境」）。Expected：`0014 -> 0015`。

- [ ] **Step 7: Commit**

```
fix(meals): 一餐最多一筆餐費；同時補金額回 409

部分唯一索引 uq_expenses_meal_id（migration 0015，升級前查重複、有就失敗不自動刪）。
補金額撞上約束時整個請求 rollback，前端顯示訊息並重抓這一餐。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add migrations/versions/0015_unique_expense_per_meal.py app/models/expense.py app/api/routes/meals.py tests/test_meal_cost_unique.py frontend/src/screens/EditMeal.tsx frontend/tests/edit-meal.test.tsx
```

---

## Task 4：公克數範圍

**Files:**
- Create: `tests/test_meal_quantity_range.py`
- Modify: `app/api/routes/meals.py`、`frontend/src/screens/LogMeal.tsx`、`frontend/src/screens/EditMealItems.tsx`、`frontend/tests/log-meal.test.tsx`、`frontend/tests/edit-meal.test.tsx`（只新增測試）

- [ ] **Step 1: 寫失敗的測試** `tests/test_meal_quantity_range.py`：

```python
import pytest
from sqlalchemy import func, select

from app.models.food import FoodRevision
from app.models.meal import Meal, MealItem
from app.security.tokens import create_access_token
from tests.factories import create_food, create_meal, create_portion, create_user

# (份量的公克數, 數量)：一個換算後超過 Numeric(8,2)，一個四捨五入成 0。
OUT_OF_RANGE = [("10000", "10000"), ("0.01", "0.01")]


def auth(user):
    return {"Authorization": f"Bearer {create_access_token(user.id)}"}


async def _setup(db_session, grams: str):
    user = await create_user(db_session)
    food = await create_food(db_session, created_by=user, name="大鍋飯")
    portion = await create_portion(db_session, food=food, label="鍋", grams=grams, owner=user)
    return user, food, portion


@pytest.mark.parametrize(("grams", "quantity"), OUT_OF_RANGE)
async def test_creating_a_meal_is_422_and_saves_nothing(client, db_session, grams, quantity):
    user, food, portion = await _setup(db_session, grams)

    response = await client.post(
        "/api/meals",
        headers=auth(user),
        json={
            "eaten_at": "2026-10-07T04:00:00Z",
            "meal_type": "lunch",
            "items": [{"food_id": food.id, "portion_id": portion.id, "quantity": quantity}],
        },
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "QUANTITY_OUT_OF_RANGE"
    await db_session.rollback()
    assert await db_session.scalar(select(func.count()).select_from(Meal)) == 0


@pytest.mark.parametrize(("grams", "quantity"), OUT_OF_RANGE)
async def test_adding_an_item_is_422_and_saves_nothing(client, db_session, grams, quantity):
    user, food, portion = await _setup(db_session, grams)
    meal = await create_meal(db_session, user=user)
    meal_id = meal.id

    response = await client.post(
        f"/api/meals/{meal_id}/items",
        headers=auth(user),
        json={"food_id": food.id, "portion_id": portion.id, "quantity": quantity},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "QUANTITY_OUT_OF_RANGE"
    await db_session.rollback()
    count = await db_session.scalar(
        select(func.count()).select_from(MealItem).where(MealItem.meal_id == meal_id)
    )
    assert count == 0


@pytest.mark.parametrize(("grams", "quantity"), OUT_OF_RANGE)
async def test_changing_an_item_is_422_and_keeps_the_old_grams(
    client, db_session, grams, quantity
):
    user, food, portion = await _setup(db_session, grams)
    revision = await db_session.get(FoodRevision, food.current_revision_id)
    meal = await create_meal(db_session, user=user, items=[(revision, 100)])
    item = await db_session.scalar(select(MealItem).where(MealItem.meal_id == meal.id))
    assert item is not None
    meal_id, item_id = meal.id, item.id

    response = await client.patch(
        f"/api/meals/{meal_id}/items/{item_id}",
        headers=auth(user),
        json={"portion_id": portion.id, "quantity": quantity},
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "QUANTITY_OUT_OF_RANGE"
    await db_session.rollback()
    stored = await db_session.scalar(select(MealItem.quantity_g).where(MealItem.id == item_id))
    assert str(stored) == "100.00"


async def test_the_largest_and_smallest_valid_grams_still_work(client, db_session):
    """範圍的兩端都要能存：9999.99 g × 100 = 999,999 g；1 g × 0.01 = 0.01 g。"""
    user, food, big = await _setup(db_session, "9999.99")
    small = await create_portion(db_session, food=food, label="匙", grams="1", owner=user)

    responses = [
        await client.post(
            "/api/meals",
            headers=auth(user),
            json={
                "eaten_at": "2026-10-07T04:00:00Z",
                "meal_type": "lunch",
                "items": [{"food_id": food.id, "portion_id": portion.id, "quantity": quantity}],
            },
        )
        for portion, quantity in ((big, "100"), (small, "0.01"))
    ]

    assert [r.status_code for r in responses] == [201, 201]
    assert [r.json()["items"][0]["quantity_g"] for r in responses] == ["999999.00", "0.01"]
```

> 工廠的 `grams` 參數型別如果不收字串，改成 `Decimal("…")`；`PATCH …/items/{id}` 的 body 形狀照 `MealItemUpdateRequest` 現況（換份量要一起給 `quantity`）。照實回報調整。

前端（照檔案現有的寫法**新增**）：
- `frontend/tests/log-meal.test.tsx`：「換算後的公克數超出範圍：顯示後端訊息」——`/api/meals` 回 422 `{ error: { code: "QUANTITY_OUT_OF_RANGE", message: "換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量", details: {} } }`；選食物、按「記錄」；斷言那段訊息出現（不是「記錄失敗，請再試一次」）。
- `frontend/tests/edit-meal.test.tsx`：同樣的訊息出現在改一項的錯誤（照 `itemNotFound()` 的寫法造一個 `quantityOutOfRange()` 回應）。

- [ ] **Step 2: 跑測試確認失敗**

```
PYTHONUTF8=1 ./.venv/Scripts/python.exe -m pytest tests/test_meal_quantity_range.py -q
cd frontend && npx vitest run tests/log-meal.test.tsx tests/edit-meal.test.tsx
```

Expected：後端 6 條 FAIL（今天是 500——測試客戶端會直接拋 `DataError`／`IntegrityError`）、最後一條 PASS（守兩端）；前端新的 2 條 FAIL。

- [ ] **Step 3: 實作**

`app/api/routes/meals.py`：`_CENTS` 附近加：

```python
# meal_items.quantity_g 是 Numeric(8,2) ＋ CHECK (quantity_g > 0)（安全補強規格 §3.3）。
QUANTITY_G_MIN = Decimal("0.01")
QUANTITY_G_MAX = Decimal("999999.99")
```

`_quantity_g` 改成（docstring 補一句範圍）：

```python
    if portion_id is None:
        quantity_g = quantity
    else:
        portion = await load_visible_portion(db, portion_id, user)
        if portion.food_id != food_id:
            raise UnprocessableEntityError(
                "PORTION_FOOD_MISMATCH", "這個份量不屬於指定的食物"
            )
        quantity_g = (portion.grams * quantity).quantize(_CENTS, rounding=ROUND_HALF_UP)

    # 份量（≤10000 g）× 數量（≤10000）可以到一億，也可以四捨五入成 0——兩者都會在
    # 寫入時變成 500（DataError／CHECK）。在這裡擋成 422。沒有份量時欄位限制已經
    # 保證在範圍內，但檢查放在兩條路之後，不分支。
    if not QUANTITY_G_MIN <= quantity_g <= QUANTITY_G_MAX:
        raise UnprocessableEntityError(
            "QUANTITY_OUT_OF_RANGE", "換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量"
        )
    return quantity_g
```

`frontend/src/screens/LogMeal.tsx` 的 `onError`：`FOOD_HAS_NO_REVISION` 那個判斷改成兩個碼都用後端訊息：

```ts
			if (
				caught instanceof ApiError &&
				(caught.code === "FOOD_HAS_NO_REVISION" ||
					caught.code === "QUANTITY_OUT_OF_RANGE")
			) {
```

`frontend/src/screens/EditMealItems.tsx` 的 `describeItemError`：`FOOD_HAS_NO_REVISION` 那一段同樣加上 `|| error.code === "QUANTITY_OUT_OF_RANGE"`（附註解：份量 × 數量換算後超出範圍，用後端的訊息）。

- [ ] **Step 4: 跑測試確認通過**：同 Step 2；再跑 `tests/test_meals*.py tests/test_foods_portions.py -q`。

- [ ] **Step 5: 突變**：範圍檢查的 `QUANTITY_G_MIN <=` 拿掉（只檢查上限）→ `0.01×0.01` 的三條紅。改回。

- [ ] **Step 6: 全部後端、ruff、mypy；全部前端；本機 api 容器重建；全部 e2e**。Expected：後端 775（768 + 7）；e2e 29。

- [ ] **Step 7: Commit**

```
fix(meals): 換算後的公克數超出範圍回 422，不是 500

份量 × 數量可能超過 Numeric(8,2)，也可能四捨五入成 0；新增一餐、加一項、改一項都在
_quantity_g 擋下。記一餐與編輯項目顯示後端的訊息。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/api/routes/meals.py tests/test_meal_quantity_range.py frontend/src/screens/LogMeal.tsx frontend/src/screens/EditMealItems.tsx frontend/tests/log-meal.test.tsx frontend/tests/edit-meal.test.tsx
```

---

## Task 5：交接文件、部署手冊

- [ ] 規格狀態改成「已實作」；「與規格的差異」（`_existing_meal_expense` 的接縫）寫回 §3.2。
- [ ] `docs/handover.md`：
  - §8.1b「`/api/auth/refresh` 與 `/api/auth/logout` 都沒有限速」改成已完成：每個使用者每分鐘 10 次、先驗簽再計數、簽章不對的不計數；前端只有 401 才登出。
  - §8.2「兩個請求同時替同一餐補金額」改成已完成（`uq_expenses_meal_id`、409）。
  - §8.2「份量重量 × 數量可能超過 `quantity_g`」改成已完成（也包含四捨五入成 0）。
  - §8.2「速率限制的計數器不持久」那條補上 `session_rate_limiter`。
  - 新的綠燈說謊或技術坑（有的話）寫進 §6／§7。
- [ ] `docs/deployment.md`：這一版有 migration `0015`；**升級前**先跑：

```bash
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml \
  exec db psql -U wallet -d wallet -c \
  "SELECT meal_id, count(*) FROM expenses WHERE meal_id IS NOT NULL GROUP BY meal_id HAVING count(*) > 1;"
```

  有結果就先到報表刪掉多的那筆；沒有結果（`0 rows`）才 `alembic upgrade head`。（資料庫使用者與名稱照部署手冊現況。）
- [ ] Commit：`docs: 交接文件——上線前的安全補強`
