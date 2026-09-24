# P3-B 計畫二：食物庫與審核佇列 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 補上「建立食物」這個目前整個 app 都沒有的入口，並做完食物庫、編輯送審與管理員審核佇列。

**Architecture:** 食物庫與記一餐共用同一支 `useFoodSearch` query hook（不共用元件）。搜尋結果用獨立的 `["food-search", …]` 命名空間，不掛在 `["foods"]` 底下，也不進離線持久化。管理員身分來自 `GET /api/me` 的 `role`，但前端藏起連結只是可用性，真正的授權在後端 `require_admin`。

**Tech Stack:** Python 3.12 / FastAPI（Task 1）· React 19 · react-router 8 · TanStack Query 5 · TypeScript strict · Biome · Vitest + Testing Library · Playwright

**規格：** [2026-09-21-p3b-frontend-design.md](../specs/2026-09-21-p3b-frontend-design.md)
**前一份：** [計畫一：導覽與趨勢](2026-09-21-p3b-plan1-nav-and-trend.md)（已合併，PR #10）

---

## ⚠️ 這份計畫刻意不預測突變結果

**計畫一的六個 task，裡面每一句「Expected: 某條測試會紅」都是寫計畫的人沒有
執行過的推測。五次是錯的。**

| Task | 計畫預測 | 實際 |
|---|---|---|
| 1 | `auth-refresh`/`client` 會紅 | 138 則全綠（揭出一個死碼分支） |
| 2 | 掃描測試擋得住本地 accessor | 擋住了，但也擋住模組講出自己禁止什麼 |
| 3 | 拿掉 `end: true` 會紅 | 全綠（react-router 對 `to="/"` 有內建特例） |
| 5 | mock 日期用 `2026-09-21` | 那就是計畫寫成的那一天，測試在那天鑑別力為零 |
| 6 | `items: [{ food_id, grams }]` | 實際 schema 是 `quantity` |

那些錯誤本身有價值（每一個都揭出真問題），但它們**用掉了每個 task 一次來回**，
而且有一次差點讓正確的程式碼被「修」壞。

**所以這份計畫的突變步驟改成這個形狀：**

> **必須成立：** 把 X 改成 Y 之後，至少有一條測試紅，而且紅的原因是 Z。
>
> **實測填回：** 哪一條、訊息是什麼 —— 執行時填進來。

**如果某個突變跑完全綠，那是一個發現，不是一個要繞過的障礙。** 停下來報告。

### 同一個理由：Task 4、5、6 只給行為規格，不給完整實作程式碼

計畫一的六個 task 都附了完整的實作程式碼，而其中**三個 task 的草稿直接貼上
是跑不起來的**（Task 2 的 docstring 讓它自己的掃描測試紅、Task 4 的 JSX 過不了
lint、Task 6 的 API 欄位名是錯的）。實作者每次都要先修掉我的程式碼才能開始。

Task 3、7 還是給了完整程式碼，因為那兩個有非顯而易見的結構決定
（`renderAction` 這個 render prop、`TabBar` 自己呼叫 `useMe`）——那些寫出來
比描述清楚。

Task 4、5、6 是三個形狀相近的表單／清單畫面，這個 repo 裡已經有四個同類的
畫面可以照著寫（`LogMeal` / `Today` / `MealList` / `Login`）。**與其讓我猜一份
會被改掉的程式碼，不如把「必須成立的行為」寫到不可能誤解**——那一部分我是
從實際的 schema 與實測結果寫的，不是猜的。

---

## 開工前必讀

### 1. 計畫的文字不是權威

發現實際情況跟這份計畫寫的不一樣 —— 檔案內容不同、指令輸出不同、某個假設
不成立 —— **停下來報告**，不要硬做，也不要自己悄悄改一個方向繼續。

計畫一每一個 task 的最有價值產出都是這種回報。

### 2. 綠燈在被觀察到失敗之前不算證據

### 3. 驗證輸出要一起看 `FAIL` 與 `Unhandled`

計畫一 Task 4 踩過：一個 transform parse error 讓 vitest **同時**印出
`FAIL tests/x.test.tsx (0 test)` 與 `Tests 8 passed (8)`。只 grep `Tests `
會看到「8 passed」而完全錯過整個檔案根本沒編譯成功。

```bash
cd F:/wallet/frontend && npm run test 2>&1 | grep -E "Test Files|Tests |Type Errors|FAIL|Unhandled"
```

### 4. `Test Files` 與 `Tests` 都是實際數量的兩倍

`vite.config.ts` 的 `typecheck.include` 跟一般 include 蓋到同一組檔案，
每個檔案被跑兩次（一次執行、一次交給 tsc）。**算數字時要除以二。**

計畫二開工時的基準線：

```
 Test Files  44 passed (44)
      Tests  196 passed (196)
Type Errors  no errors
```

### 5. 不要動 `App.tsx` 裡的「重新整理」按鈕

它直接呼叫 `apiFetch<{ display_name: string }>("/api/me")`，而
`frontend/e2e/auth.spec.ts` 靠它驗證「access token 過期時會自動換票並重送」。

Task 7 會引入 `useMe()`。**兩者並存，不要合併。** 換成 `refetch` 會被
`staleTime: 60_000` 擋掉 —— 按下去什麼都不會發生，而那條 E2E **不會紅，
它只是不再測到任何東西**（規格 §8.1）。

### 6. `npm run format` 可以自動修 Biome 的格式

計畫一用過四次，沒問題。但 `// biome-ignore` 寫在 **JSX children 位置**會被
當成文字（計畫一 Task 4 踩過 parse error），那個位置要用 `{/* biome-ignore … */}`。

---

## 開工前已經查證過的事實

**這一節的每一項都是寫計畫時實際讀原始碼或實際打 API 確認的，不是從記憶裡拿的。**
計畫一有三處是從記憶裡拿的，全錯。

### 後端

| 事實 | 出處 |
|---|---|
| `POST /api/foods` 的 body 是 `FoodCreateRequest`：`name`、`brand`、`nutrition`（`base_unit` / `kcal` / `protein_g` / `fat_g` / `carb_g`） | `app/schemas/food.py` |
| 同一個人建同名同品牌的食物 → **`409 FOOD_EXISTS`「你已經建過同名的食物了」** | `app/api/routes/foods.py` `create_food` |
| `GET /api/foods` 參數：`q`（可省略，`Food.name ILIKE %q%`，**只比對名稱不比對品牌**）、`scope`（`all` / `global` / `mine`，預設 `all`）、`limit`（預設 50，最大 200） | 同上 `search_foods` |
| `FoodResponse`：`id` / `name` / `brand` / `is_global` / `nutrition`，**沒有 `owner_id`**。`is_global` 由 `_to_response` 算成 `food.owner_id is None` | `app/schemas/food.py`、`app/api/routes/foods.py` |
| `POST /api/foods/{id}/revisions` body 是 `RevisionCreateRequest`：`nutrition` + `change_note`（可 null，最多 500 字） | `app/schemas/food.py` |
| 同一個食物已經有待審編輯 → **`409 REVISION_PENDING`** | `app/api/routes/foods.py` `propose_revision` |
| `POST /api/admin/food-revisions/{id}/reject` body 是 `{"reason": "…"}`，**`reason` 必填**（`min_length=1`，最多 500） | `app/schemas/food.py` `RevisionRejectRequest` |
| 審核已經處理過的提案 → **`409 REVISION_NOT_PENDING`**；提案不存在 → **`404 REVISION_NOT_FOUND`**；非管理員 → **`403 FORBIDDEN`** | `app/api/routes/admin_foods.py`、`app/api/deps.py` |
| `UserRole` 是 `"user"` / `"admin"`，`GET /api/me` 的 `UserResponse` 帶 `role` | `app/models/user.py`、`app/schemas/auth.py` |
| `MealItemCreateRequest` 只有 `food_id` / `quantity` / `portion_id` —— **沒有 `grams`** | `app/schemas/meal.py` |

### 一個實際打 API 量出來的事實

**沒有生效版本的食物，搜尋查得到，但記不了。**

```
# 手動插一筆 current_revision_id 是 NULL 的全域食物
GET /api/foods?scope=global   → {'id': 66, 'name': …, 'is_global': True, 'nutrition': None}
POST /api/meals (food_id=66)  → 409 {"code":"FOOD_HAS_NO_REVISION"}
```

三個列表端點（`search_foods` / `list_frequent_foods` / `list_recent_foods`）都用
`outerjoin`，**沒有任何一個過濾掉 `current_revision_id IS NULL` 的食物**。

> 後端 `meals.py` 原本的註解寫「正常流程不會發生（沒有 `current_revision_id`
> 的食物本來就查不到）」—— 那句話是錯的，已經在這個分支的第一個 commit 修掉。

**而 `LogMeal.tsx` 現在的註解寫著「這個食物仍然要能被選」** —— 照那樣做，
使用者會填完表單、按下「記錄」、然後看到通用的「記錄失敗，請再試一次」。
Task 6 要修這件事。

### 前端

| 事實 | 出處 |
|---|---|
| `LogMeal.tsx` 的份量欄位 label 是**「份量」**（`<label htmlFor="quantity">`），送出按鈕文字是**「記錄」** | `frontend/src/screens/LogMeal.tsx` |
| 食物清單是 `<li><button type="button">{food.name}</button><NutritionPreview/></li>` | 同上 |
| `apiFetch<T>` 回的是 `Promise<T \| null>`（204 → `null`），**不是 `T \| undefined`**。所以 `=== undefined` narrow 不掉 `null` | `frontend/src/api/client.ts` |
| `client.ts` 只在 `response.status === 401` 換票，403 直接落到 `!response.ok` 拋 `ApiError` | 同上 |
| `ApiError` 有 `status` / `code` / `details` / `retryAfterSeconds` | `frontend/src/api/errors.ts` |
| `queryKeys` 目前有：`dailyStats` / `supplementsToday` / `meals` / `rangeStats` / `rangeStatsAll` / `frequentFoods` / `recentFoods` / `portions` / `mealPhoto` | `frontend/src/api/queries.ts` |
| `persist.ts` 的排除目前是 `query.queryKey[0] !== "meal-photo"` | `frontend/src/api/persist.ts` |
| `FoodScope` 在產生的型別裡是 `"all" \| "global" \| "mine"` | `frontend/src/api/schema.d.ts` |
| 四支 E2E 各自宣告一份 `const EMAIL = "kenny.demo@example.com"` / `const PASSWORD` | `frontend/e2e/*.spec.ts` |

### ⚠️ 本機與 CI 的帳號角色現在不一致，而且沒有辦法建立非管理員帳號

**這是 Task 1 存在的原因。**

- CI 的 e2e job 用 `python -m app.cli create-admin kenny.demo@example.com …` 種子
  → **在 CI 那個帳號是 `admin`**
- 本機 dev 資料庫裡 `kenny.demo@example.com` 的 role 是 **`user`**
- `create_admin` 對既有帳號是「提升並重設密碼」，**沒有任何指令可以建立
  或降級成一般使用者**（`app/cli.py` 只有 `create-admin` / `cleanup-photos` /
  `cleanup-sessions`）

後果：規格 §11.2 那條「前端藏起連結不是授權」的守衛 —— E2E 4「非管理員打
admin 端點得到 403」—— **現在根本寫不出來**，因為造不出非管理員。

而且如果不處理，同一條 E2E 在本機與 CI 會有相反的結果。

---

## 檔案結構

**新增：**

| 檔案 | 責任 |
|---|---|
| `frontend/src/api/foods.ts` | `useFoodSearch`、`useFood`、`useFoodRevisions` |
| `frontend/src/api/me.ts` | `useMe` |
| `frontend/src/lib/use-debounced.ts` | 搜尋輸入的 debounce |
| `frontend/src/screens/FoodLibrary.tsx` | `/foods` |
| `frontend/src/screens/NewFood.tsx` | `/foods/new` |
| `frontend/src/screens/FoodDetail.tsx` | `/foods/:id` |
| `frontend/src/screens/AdminRevisions.tsx` | `/admin/revisions` |
| `frontend/src/components/FoodResultList.tsx` | 搜尋結果清單（食物庫與記一餐共用的**呈現**，不含去向） |
| `frontend/e2e/accounts.ts` | E2E 共用的帳號常數 |

**修改：**

| 檔案 | 改什麼 | Task |
|---|---|---|
| `app/cli.py` | 加 `create_regular_user` 與 `create-user` 子指令 | 1 |
| `tests/test_cli.py` | 新指令的測試 | 1 |
| `.github/workflows/ci.yml` | e2e job 多種一個非管理員帳號 | 1 |
| `docs/deployment.md` | 記錄新指令 | 1 |
| `frontend/e2e/*.spec.ts`（4 支） | 改用 `accounts.ts` | 1 |
| `frontend/src/api/queries.ts` | 加 5 個 key | 2 |
| `frontend/src/api/persist.ts` | 排除改成命名空間清單 | 2 |
| `frontend/src/App.tsx` | 加 4 條路由 | 3–7 |
| `frontend/src/components/TabBar.tsx` | 第五格（管理員限定） | 7 |
| `frontend/tests/tab-bar.test.tsx` | `TabBar` 開始用 `useMe()`，測試要包 provider | 7 |
| `frontend/src/screens/LogMeal.tsx` | 搜尋框、擋掉沒有生效版本的食物、具名處理 409 | 6 |

---

## Task 1: 讓系統造得出非管理員帳號

**這是後端 task，而且它是 E2E 4 的前置條件。**

**Files:**
- Modify: `app/cli.py`
- Modify: `tests/test_cli.py`
- Modify: `.github/workflows/ci.yml`
- Modify: `docs/deployment.md`
- Create: `frontend/e2e/accounts.ts`
- Modify: `frontend/e2e/auth.spec.ts`
- Modify: `frontend/e2e/daily-loop.spec.ts`
- Modify: `frontend/e2e/photo-and-limits.spec.ts`
- Modify: `frontend/e2e/trend.spec.ts`

- [ ] **Step 1: 寫失敗的測試**

在 `tests/test_cli.py` 的 `create_admin` 那組測試之後加。

**注意 import：** `tests/factories.py` 已經匯出一個叫 `create_user` 的東西，
所以 CLI 這個函式叫 `create_regular_user`，避免在這個檔案裡撞名。

```python
async def test_create_regular_user_creates_a_user(db_session):
    await create_regular_user(db_session, "member@example.com", "a-good-password", "成員")

    user = await db_session.scalar(select(User).where(User.email == "member@example.com"))
    assert user is not None
    assert user.role is UserRole.USER
    assert verify_password("a-good-password", user.password_hash)


async def test_create_regular_user_updates_an_existing_regular_user(db_session):
    """重跑種子不該失敗 —— 這個指令要能冪等地把密碼設回已知的值。"""
    existing = await create_user(db_session, email="member@example.com", role=UserRole.USER)

    user, created = await create_regular_user(
        db_session, "member@example.com", "a-new-password", "新名字"
    )

    assert created is False
    await db_session.refresh(existing)
    assert existing.role is UserRole.USER
    assert existing.display_name == "新名字"
    assert verify_password("a-new-password", existing.password_hash)


async def test_create_regular_user_refuses_to_demote_an_admin(db_session):
    """**這一條是這個 task 最重要的行為。**

    `create_admin` 對既有帳號是「提升」。如果這個指令對既有帳號是「降級」，
    那麼打錯一個 email 就會把管理員默默降成一般使用者 —— 而那件事沒有任何
    畫面會顯示出來，要到下一次登入發現進不去審核佇列才知道。

    提升是可逆的（再跑一次 `create-admin`）；在「你不知道它發生了」的情況下
    降級不是。所以這裡拒絕，而且要留著原本的密碼不動。
    """
    admin = await create_user(db_session, email="boss@example.com", role=UserRole.ADMIN)
    original_hash = admin.password_hash

    with pytest.raises(ValueError, match="已經是管理員"):
        await create_regular_user(db_session, "boss@example.com", "a-new-password", "老闆")

    await db_session.refresh(admin)
    assert admin.role is UserRole.ADMIN
    # 拒絕的意思是「什麼都沒做」，不是「角色沒改但密碼改了」
    assert admin.password_hash == original_hash


async def test_create_regular_user_rejects_a_short_password(db_session):
    with pytest.raises(ValueError, match="密碼至少 8 個字元"):
        await create_regular_user(db_session, "member@example.com", "short", "成員")


async def test_create_regular_user_matches_an_existing_user_despite_whitespace_and_case(
    db_session,
):
    """跟 create_admin 用同一套正規化 —— 兩個指令對「同一個 email」的判斷
    不一致的話，會出現「create-admin 提升了 A，create-user 卻建出了 A 的分身」。
    """
    existing = await create_user(db_session, email="member@example.com", role=UserRole.USER)

    _, created = await create_regular_user(
        db_session, "  MEMBER@Example.COM  ", "a-good-password", "成員"
    )

    assert created is False
    await db_session.refresh(existing)
    assert verify_password("a-good-password", existing.password_hash)


def test_parser_accepts_create_user():
    args = build_parser().parse_args(
        ["create-user", "member@example.com", "a-good-password", "成員"]
    )
    assert args.command == "create-user"
    assert args.email == "member@example.com"
```

記得在檔案頂端的 import 加 `create_regular_user`：

```python
from app.cli import build_parser, cleanup_expired_sessions, create_admin, create_regular_user
```

- [ ] **Step 2: 跑測試確認它失敗**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest tests/test_cli.py -x -q 2>&1 | tail -15
```

Expected: 收集階段就失敗（`ImportError: cannot import name 'create_regular_user'`）。

- [ ] **Step 3: 寫實作**

`app/cli.py`。**`create_admin` 的簽章與行為一個字都不要改** —— CI 的種子步驟、
`docs/deployment.md`、以及六則既有測試都依賴它。

把共用的部分抽成一個私有函式，兩個公開函式各自決定對既有帳號的政策：

```python
async def _upsert_account(
    db: AsyncSession,
    email: str,
    password: str,
    display_name: str,
    *,
    role: UserRole,
    on_existing_admin: str | None = None,
) -> tuple[User, bool]:
    """建立或更新一個帳號。

    `on_existing_admin` 不是 `None` 時，遇到既有的管理員就拋
    `ValueError(on_existing_admin)` 而**什麼都不改** —— 見 `create_regular_user`。
    """
    if len(password) < MIN_PASSWORD_LENGTH:
        raise ValueError(f"密碼至少 {MIN_PASSWORD_LENGTH} 個字元")

    email = email.strip().lower()

    user = await db.scalar(select(User).where(User.email == email))
    created = user is None

    if user is not None and on_existing_admin is not None and user.role is UserRole.ADMIN:
        # 在 **任何** 欄位被改之前就退出。拋在賦值之後的話，雖然沒 commit，
        # 但 db_session 裡那個物件已經髒了，同一個 session 後續的 flush
        # 會把它寫出去 —— 測試裡的 refresh 會讀回改過的值。
        raise ValueError(on_existing_admin)

    if user is None:
        user = User(email=email, display_name=display_name)
        db.add(user)

    user.password_hash = hash_password(password)
    user.display_name = display_name
    user.role = role

    await db.commit()
    await db.refresh(user)
    return user, created


async def create_admin(
    db: AsyncSession, email: str, password: str, display_name: str
) -> tuple[User, bool]:
    """建立管理員帳號；若 email 已存在則提升為管理員並更新密碼。

    回傳 (user, created)，created 為 False 代表是提升既有帳號 —— 打錯 email 時
    會靜默重設別人的密碼，所以呼叫端必須把這件事講清楚。
    """
    return await _upsert_account(db, email, password, display_name, role=UserRole.ADMIN)


async def create_regular_user(
    db: AsyncSession, email: str, password: str, display_name: str
) -> tuple[User, bool]:
    """建立一般使用者帳號；若 email 已存在且本來就是一般使用者，更新密碼與名稱。

    回傳 (user, created)。

    **對既有管理員的行為刻意跟 `create_admin` 不對稱：拒絕，而且什麼都不改。**

    `create_admin` 對既有帳號是「提升」。如果這裡對既有帳號是「降級」，那麼
    打錯一個 email 就會把管理員默默降成一般使用者 —— 而那件事沒有任何畫面會
    顯示出來，要到下一次登入發現進不去審核佇列才知道。

    提升是可逆的（再跑一次 `create-admin`）；在「你不知道它發生了」的情況下
    降級不是。真的要降級，請明確地用資料庫改，那至少是一個你知道自己在做的動作。
    """
    return await _upsert_account(
        db,
        email,
        password,
        display_name,
        role=UserRole.USER,
        on_existing_admin="這個 email 已經是管理員，不會被降級；真要降級請直接改資料庫",
    )
```

`build_parser()` 裡，在 `create_admin_parser` 之後加：

```python
    create_user_parser = subparsers.add_parser(
        "create-user", help="建立或更新一般使用者帳號（不會降級既有的管理員）"
    )
    create_user_parser.add_argument("email")
    create_user_parser.add_argument("password")
    create_user_parser.add_argument("display_name")
```

以及對應的 runner 與 dispatch。**照 `_run_create_admin` 現有的形狀寫** ——
去讀它怎麼印訊息（`created` 為 True / False 時分別說什麼），用同一個語氣。

- [ ] **Step 4: 跑測試確認全綠**

```bash
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest tests/test_cli.py -q 2>&1 | tail -5
```

- [ ] **Step 5: 突變驗證**

> **必須成立（一）：** 把 `_upsert_account` 裡那個提前 `raise` 的區塊整個刪掉
> （讓 `create_regular_user` 直接降級既有管理員），**至少有一條測試紅**，
> 而且紅的原因是「管理員被降級了」。
>
> **實測填回：** 哪一條、訊息是什麼 —— 執行時填進來。

> **必須成立（二）：** 把那個 `raise` 從「賦值之前」移到「三行賦值之後」
> （還是在 `commit` 之前），**至少有一條測試紅**，而且紅的原因是密碼被改了。
>
> 這一條在驗註解說的那件事：沒 commit 不代表沒改到 —— ORM 物件已經髒了，
> 同一個 session 後續的 flush 會把它寫出去。
>
> ### 實測結果：計畫給的測試驗不到這件事，已修
>
> **這個突變原本是全綠的**，而那不是因為註解的理由不成立 —— 是因為測試用
> 錯了讀取方式。
>
> 計畫 Step 1 給的測試用 `await db_session.refresh(admin)` 讀回狀態。
> 實測（把物件弄髒之後分別用兩種方式讀）：
>
> ```
> refresh() → 密碼有變 = False，名字回到資料庫裡的值     ← 髒值被丟掉
> select()  → 密碼有變 = True，名字是被改掉的那個        ← autoflush 寫進去了
> ```
>
> `refresh()` 會先把物件標成過期（同時移出 dirty 集合）再發 SELECT，
> **髒值從頭到尾沒有機會被寫出去**。所以用 `refresh()` 寫的測試，
> 即使把 `raise` 延後到賦值之後，也**永遠是綠的** —— 那個安全性質等於沒有
> 守衛。
>
> 已改成 `db_session.scalar(select(User).where(...))`（會觸發 autoflush）。
> 改完之後同一個突變確實紅：
>
> ```
> assert stored.role is UserRole.ADMIN
> E  AssertionError: assert <UserRole.USER: 'user'> is <UserRole.ADMIN: 'admin'>
> FAILED tests/test_cli.py::test_create_regular_user_refuses_to_demote_an_admin
> ```
>
> `app/cli.py` 那段註解最後一句原本寫「測試裡的 refresh 會讀回改過的值」——
> 那句話是假的，也一併改掉了。
>
> ### 另外：字面照做那個突變會以錯誤的理由變紅
>
> 把整個 `if …: raise …` 區塊原封不動搬到賦值之後，條件裡的
> `user.role is UserRole.ADMIN` 會讀到**已經被 `user.role = role` 覆寫過**
> 的值，於是條件恆不成立、`raise` 根本不會觸發 —— 失敗訊息是
> `DID NOT RAISE ValueError`，跟突變（一）一模一樣。
>
> 要驗到「延後拋出」這件事，突變必須寫成先算好 `should_reject`、賦值之後
> 再拋。**這一節記下來是因為下一個人照字面做會得到一個看起來對、理由卻
> 錯的紅燈。**

- [ ] **Step 6: CI 多種一個非管理員帳號**

`.github/workflows/ci.yml` 的 e2e job，「種子資料」那一步改成：

```yaml
      - name: 種子資料
        # E2E 用兩個帳號，角色是**測試內容的一部分**，不是巧合：
        #   kenny.demo  → 管理員，審核佇列那幾條要用
        #   e2e.member  → 一般使用者，「非管理員拿到 403」那條要用
        #
        # 兩個指令對既有 email 都是冪等的（create-admin 提升並重設密碼，
        # create-user 更新密碼但拒絕降級管理員），所以重跑 job 不會失敗。
        run: |
          python -m app.cli create-admin kenny.demo@example.com demo-pass-12345 "示範帳號"
          python -m app.cli create-user e2e.member@example.com member-pass-12345 "一般成員"
```

- [ ] **Step 7: 抽出 E2E 的帳號常數**

四支 E2E 各自宣告一份 `EMAIL` / `PASSWORD`。Task 8 會加第二個帳號，再抄一份
就變成 5 個檔案 × 2 個帳號。

建 `frontend/e2e/accounts.ts`：

```ts
/** E2E 用的帳號。**角色是測試內容的一部分，不是巧合。**
 *
 *  兩個帳號由 CI 的「種子資料」步驟建立（`.github/workflows/ci.yml`），
 *  本機要自己跑一次（見 `docs/deployment.md`）。
 *
 *  **本機與 CI 曾經不一致過：** CI 一直用 `create-admin` 種
 *  `kenny.demo@example.com`，所以在 CI 它是管理員；而本機 dev 資料庫裡
 *  它是一般使用者。那個差異在 P3-B 計畫二之前沒有任何測試碰得到，
 *  所以也沒有人發現 —— 直到要寫「非管理員拿到 403」那條 E2E 才浮出來。
 */
export const ADMIN = {
	email: "kenny.demo@example.com",
	password: "demo-pass-12345",
} as const;

export const MEMBER = {
	email: "e2e.member@example.com",
	password: "member-pass-12345",
} as const;
```

四支既有 E2E：刪掉本地的兩個 const，改成

```ts
import { ADMIN } from "./accounts";
```

並把用到 `EMAIL` / `PASSWORD` 的地方改成 `ADMIN.email` / `ADMIN.password`。

> **這一步會改到呼叫端**（跟計畫一 Task 1 的「純刪除」不一樣），所以
> 改完一定要把四支 E2E 跑過一輪。

- [ ] **Step 8: 本機把兩個帳號種好**

```bash
cd F:/wallet && docker compose up -d
docker compose exec api python -m app.cli create-admin kenny.demo@example.com demo-pass-12345 "示範帳號"
docker compose exec api python -m app.cli create-user e2e.member@example.com member-pass-12345 "一般成員"
```

**第一行會把本機的 `kenny.demo` 從 `user` 提升成 `admin`** —— 那是刻意的，
本機從此跟 CI 一致。

確認：

```bash
docker compose exec -T db psql -U wallet -d wallet -t -c \
  "SELECT email, role FROM users WHERE email IN ('kenny.demo@example.com','e2e.member@example.com');"
```

Expected: 一個 `admin`、一個 `user`。

- [ ] **Step 9: 跑既有 E2E 確認沒壞**

```bash
cd F:/wallet && docker compose restart api && sleep 8
cd frontend && npx playwright test --reporter=list 2>&1 | tail -15
```

Expected: 7 條全綠。

> **本機重複跑會撞到登入限速**（`GLOBAL_LIMIT = 20` / 60 秒，所有 email 共用）。
> 連續跑幾輪之後**全部**測試會一起失敗，症狀看起來像功能壞了。
> 解法：`docker compose restart api`。

- [ ] **Step 10: 更新部署文件**

`docs/deployment.md` 目前只寫 `create-admin`。在那一段旁邊補上 `create-user`，
並說明兩者對既有帳號的行為不對稱（一個提升、一個拒絕降級）。

`docs/handover.md` 的 `cli.py` 那一行（`create-admin / cleanup-photos /
cleanup-sessions`）也要補上 `create-user`。

- [ ] **Step 11: 後端全套驗證**

```bash
cd F:/wallet && ./.venv/Scripts/ruff.exe check . && ./.venv/Scripts/mypy.exe app
cd F:/wallet && ./.venv/Scripts/python.exe -m pytest -q 2>&1 | tail -5
```

Expected: ruff 與 mypy 乾淨；pytest 全綠（基準線 503 則 + 你加的 6 則）。

> **不要跑 `ruff format`。** CI 只跑 `ruff check .`，沒有跑
> `ruff format --check`，而這個 repo 目前有既有的格式差異 —— 跑 format 會
> 重排一堆跟你無關的行。（計畫二開工時查證過。）

- [ ] **Step 12: Commit**

```bash
cd F:/wallet && git add app/cli.py tests/test_cli.py .github/workflows/ci.yml docs/ frontend/e2e/
git commit -F- <<'EOF'
feat: create-user——系統本來造不出非管理員帳號

app/cli.py 只有 create-admin，而它一律設 role = ADMIN，對既有帳號是提升。
所以沒有任何辦法建立或降級成一般使用者。

後果是規格 §11.2 那條守衛寫不出來：「非管理員打 admin 端點得到 403」需要
一個非管理員，而系統造不出來。那條 E2E 在計畫二 Task 8。

順帶揭出本機與 CI 的不一致：CI 的 e2e job 一直用 create-admin 種
kenny.demo@example.com，所以在 CI 它是管理員；本機 dev 資料庫裡它是
一般使用者。那個差異之前沒有任何測試碰得到，所以也沒有人發現。
現在兩邊都種兩個角色明確的帳號。

create_regular_user 對既有管理員的行為刻意跟 create_admin 不對稱：
拒絕，而且什麼都不改。create_admin 對既有帳號是提升；如果這裡是降級，
打錯一個 email 就會把管理員默默降級——而那件事沒有任何畫面會顯示出來，
要到下一次登入發現進不去審核佇列才知道。提升可逆，不知情的降級不可逆。

拒絕發生在任何欄位被賦值之前：沒 commit 不代表沒改到，ORM 物件髒了之後
同一個 session 後續的 flush 會把它寫出去。

四支 E2E 各自抄一份帳號常數，抽成 e2e/accounts.ts——Task 8 會加第二個
帳號，不抽的話就是 5 個檔案 × 2 個帳號。
EOF
```

---

## Task 2: 食物的資料層

**Files:**
- Create: `frontend/src/api/foods.ts`
- Create: `frontend/src/lib/use-debounced.ts`
- Create: `frontend/tests/use-debounced.test.ts`
- Modify: `frontend/src/api/queries.ts`
- Modify: `frontend/src/api/persist.ts`
- Modify: `frontend/tests/offline.test.tsx`

- [x] **Step 1: 加 query key**

`frontend/src/api/queries.ts` 的 `queryKeys` 裡加（放在 `portions` 附近，
因為它們是同一族）：

```ts
	/** 目前登入者。Task 7 的 tab bar 要用它的 `role` 決定第五格出不出現。 */
	me: ["me"] as const,
	/** 單一食物。**刻意是 `portions` 與 `foodRevisions` 的前綴。**
	 *
	 *  審核通過之後，那個食物的目前數值、份量、編輯歷史都該重取 ——
	 *  一次 `invalidateQueries({ queryKey: queryKeys.food(id) })` 打到三個
	 *  正是要的行為（規格 §7.1）。 */
	food: (foodId: number) => ["foods", foodId] as const,
	foodRevisions: (foodId: number) => ["foods", foodId, "revisions"] as const,
	/** 全庫搜尋的結果。**刻意不掛在 `["foods"]` 底下**，沿用
	 *  `mealPhoto` 的前例（見下面那段註解）。
	 *
	 *  掛下去的話，任何一次 `invalidateQueries({ queryKey: ["foods"] })` 都會
	 *  連帶炸掉**每一組已掛載的搜尋結果與份量清單**。獨立命名空間之後，
	 *  前綴比對自然就做對的事，而且沒有「忘記加 `exact: true`」這個失敗模式。
	 *
	 *  它也**不進離線持久化**（`api/persist.ts`）—— 理由見那個檔案。 */
	foodSearch: (q: string, scope: FoodScope) =>
		["food-search", q, scope] as const,
	/** 待審提案清單（管理員）。 */
	pendingRevisions: ["admin", "food-revisions"] as const,
```

`FoodScope` 的型別從產生的 schema 來：

```ts
import type { components } from "./schema";

type FoodScope = components["schemas"]["FoodScope"];
```

- [x] **Step 2: 持久化排除改成命名空間清單**

先寫失敗的測試。`frontend/tests/offline.test.tsx` 既有那條「照片 blob 不會被
寫進 localStorage」的斷言是：

```ts
expect(persistedKeys.map((key) => key[0])).not.toContain("meal-photo");
```

**先去讀那個檔案確認實際的寫法**（這份計畫引用的可能跟實際有出入），再加一條
平行的測試斷言 `"food-search"` 也不在裡面。

> **這條新測試需要畫面真的發出一次搜尋** —— 否則它會因為「根本沒有 food-search
> 這個 query」而綠，跟排除有沒有生效無關。那是假綠燈。
>
> 但 `Today` 不搜尋食物。所以這條測試要嘛渲染 `FoodLibrary`（Task 3 才存在），
> 要嘛直接用 `QueryClient` 手動 `setQueryData(queryKeys.foodSearch("雞", "all"), […])`
> 再觸發 persist。
>
> **建議後者**：這條測試要驗的是 `shouldDehydrateQuery` 的行為，不是
> `FoodLibrary` 的行為，用真畫面反而把兩件事綁在一起。而且這樣 Task 2 就
> 不必等 Task 3。

`frontend/src/api/persist.ts` 的 `shouldDehydrateQuery` 改成：

```ts
/** 不進離線快取的 query 命名空間。
 *
 *  **`meal-photo`：** 照片 blob 是 IndexedDB 的量級。`localStorage` 有 5MB
 *  上限，一張照片（前端降尺寸後也還有幾百 KB）就可能把它塞爆，而且 Blob
 *  本身也無法有意義地 JSON.stringify。
 *
 *  **`food-search`：** 使用者每敲一個字都會產生一組新的 query key，結果在
 *  `localStorage` 裡越堆越多。
 *
 *  兩者塞爆的症狀一樣惡劣：`setItem` 丟 `QuotaExceededError`，於是**整份
 *  離線快取都寫不進去** —— 不是「搜尋結果存不了」，是連今日總覽也一起沒了。
 *  而那個失敗發生在背景的節流寫入裡，畫面上完全看不出來。
 *
 *  兩個 key 都刻意用獨立的第一段命名空間（不掛在 `"meals"` / `"foods"`
 *  底下，見 `api/queries.ts`），所以這裡直接認 `queryKey[0]`。 */
const NOT_PERSISTED: ReadonlySet<unknown> = new Set(["meal-photo", "food-search"]);
```

並把判斷改成 `!NOT_PERSISTED.has(query.queryKey[0])`。

- [x] **Step 3: debounce hook**

`frontend/src/lib/use-debounced.ts`：

```ts
import { useEffect, useState } from "react";

/** 把一個會頻繁改變的值延後 `delayMs` 再回傳。
 *
 *  給搜尋輸入用：每敲一個字就打一次全庫查詢是不必要的，而且每一次都會在
 *  TanStack Query 的快取裡留下一組新的 key（`["food-search", q, scope]`）。
 *
 *  **回傳的是值，不是 callback。** 呼叫端把回傳值放進 query key 與
 *  `enabled`，query 自然就只在值安定下來之後才發 —— 不需要在呼叫端寫任何
 *  取消邏輯。 */
export function useDebounced<T>(value: T, delayMs: number): T {
	const [settled, setSettled] = useState(value);

	useEffect(() => {
		const timer = setTimeout(() => setSettled(value), delayMs);
		return () => clearTimeout(timer);
	}, [value, delayMs]);

	return settled;
}
```

測試 `frontend/tests/use-debounced.test.ts`：**用 `vi.useFakeTimers()`**，
並在 `afterEach` 還原。要測的行為：

1. 一開始回傳的是初始值（不是 `undefined`）
2. 值變了之後、時間還沒到之前，回傳的還是舊值
3. 時間到了之後回傳新值
4. **連續改三次只會安定一次**（那是 debounce 的定義，不是 throttle）

> 第 4 條是這個 hook 存在的理由。只有 1–3 的話，一個「每次都延遲 300ms 但
> 每一次都會送出」的實作也會全綠 —— 那是 delay，不是 debounce。

- [x] **Step 4: `foods.ts`**

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Food = components["schemas"]["FoodResponse"];
export type FoodScope = components["schemas"]["FoodScope"];
export type Revision = components["schemas"]["RevisionResponse"];
export type Portion = components["schemas"]["PortionResponse"];

/** 全庫搜尋。**食物庫與記一餐共用這一支，但不共用元件** ——
 *  兩邊選完之後的去向不一樣（記一餐進份量輸入，食物庫進詳情頁），
 *  共用元件會逼出一個 `onSelect` 分歧參數，那是把兩個不同畫面綁在一起的開始。
 *
 *  `q` 是空字串時不發請求：後端的 `q` 可以省略（會回整個可見範圍的前 50 筆），
 *  但那不是使用者按下搜尋框時想看到的東西。 */
export function useFoodSearch(q: string, scope: FoodScope) {
	return useQuery({
		queryKey: queryKeys.foodSearch(q, scope),
		queryFn: () =>
			apiFetch<Food[]>(
				`/api/foods?q=${encodeURIComponent(q)}&scope=${scope}`,
			),
		enabled: q.trim() !== "",
	});
}

export function useFood(foodId: number) {
	return useQuery({
		queryKey: queryKeys.food(foodId),
		queryFn: () => apiFetch<Food>(`/api/foods/${foodId}`),
	});
}

export function useFoodRevisions(foodId: number) {
	return useQuery({
		queryKey: queryKeys.foodRevisions(foodId),
		queryFn: () => apiFetch<Revision[]>(`/api/foods/${foodId}/revisions`),
	});
}
```

> **`encodeURIComponent` 不是裝飾。** 中文食物名在 query string 裡必須編碼，
> 而且 `&` 或 `#` 出現在搜尋字串裡會把 URL 切斷。

- [x] **Step 5: 驗證**

```bash
cd F:/wallet/frontend && npm run test 2>&1 | grep -E "Test Files|Tests |Type Errors|FAIL|Unhandled"
cd F:/wallet/frontend && npm run lint && npm run typecheck
```

- [x] **Step 6: 突變驗證**

> **必須成立（一）：** 把 `queryKeys.foodSearch` 改成掛在 `["foods", "search", q, scope]`
> 底下，**Step 2 那條持久化排除的測試必須紅**。
>
> **實測填回：**
>
> 第一版測試（用 `persisted.map((query) => query.queryKey[0]).not.toContain
> ("food-search")`）對這個突變**完全綠**——不是因為排除還有效，是因為斷言
> 寫死了字面值 `"food-search"`。突變把 key 的第一段改成 `"foods"` 之後，
> `queryKey[0]` 已經不等於 `"food-search"`，斷言自然「沒找到」而通過；
> 同一個突變也讓 `persist.ts` 的 `NOT_PERSISTED.has("foods")` 為 `false`，
> 排除確實失效、搜尋結果確實被寫進 localStorage 了——**兩件事同時發生，
> 而字面值比對兩件都測不到**。這是跟計畫原文警告的假綠燈（query 根本沒
> 進 client）不同的另一種假綠燈：namespace 改名的突變會連斷言用的字面值
> 一起改跑掉。
>
> 已改成用 `queryKeys.foodSearch("雞", "all")` 實際產生的 key 做深比對
> （`JSON.stringify` 相等），不寫死字面值。改完之後同一個突變確實紅：
>
> ```
> FAIL tests/offline.test.tsx > 離線 L2：持久化與「最後更新於」 > food-search 的搜尋結果不會被寫進 localStorage
> AssertionError: expected true to be false
>  ❯ tests/offline.test.tsx:391:7
> ```
>
> （`persisted.some((query) => JSON.stringify(query.queryKey) === searchKeyJson)`
> 讀到 `true`——那組搜尋結果真的被持久化了。）

> **必須成立（二）：** 把 `useDebounced` 的 `setTimeout` 換成直接
> `setSettled(value)`（也就是拿掉 debounce），**Step 3 第 4 條測試必須紅**。
>
> **實測填回：**
>
> ```
> FAIL tests/use-debounced.test.ts > useDebounced > 連續改三次只會安定一次——這是 debounce 的定義，不是 throttle
> AssertionError: expected 'd' to be 'a' // Object.is equality
>  ❯ tests/use-debounced.test.ts:76:26
> ```
>
> 拿掉 debounce 之後每次 `rerender` 都立刻安定，所以三次連續改動之後
> （還沒推進任何計時器）讀到的已經是最後一次的 `"d"`，而不是預期中「還沒
> 安定、應該還是 `"a"`」。
>
> 附帶：第 2 條（「值變了之後、時間還沒到之前，回傳的還是舊值」）在這個
> 突變下也一起紅了（`expected 'b' to be 'a'`）——預期之內，两條測試守的
> 是同一件事的不同切面。

- [x] **Step 7: Commit**（`fd77508`）

---

## Task 3: 食物庫搜尋畫面 `/foods`

**Files:**
- Create: `frontend/src/screens/FoodLibrary.tsx`
- Create: `frontend/src/components/FoodResultList.tsx`
- Create: `frontend/tests/food-library.test.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/index.css`

- [x] **Step 1: 寫失敗的測試**

`frontend/tests/food-library.test.tsx`。用 `tests/helpers/mock-api.ts` 的
`mockApi`（陣列形式，**計畫二之後會需要分辨 `GET /api/foods` 與
`POST /api/foods`**，所以一律用這個而不是 `mockApiByPath`）。

要測的行為：

1. **一進畫面不發搜尋請求**（`q` 是空的）
2. 輸入之後（等過 debounce）發出帶 `q` 的請求，結果顯示出來
3. **切換 scope 會重新查詢，而且 `scope` 真的進了 URL**
4. **`nutrition === null` 的食物顯示得出來，而且標示它沒有營養素資料**
5. 沒有結果時顯示「找不到符合的食物」，不是一片空白
6. 「新增食物」連結存在

> 第 4 條對應規格 §5.5 與開工前查證的那個實測（那種食物搜尋查得到）。
> **食物庫這邊是「顯示得出來 + 標示」，不是「不能點」** —— 點進詳情頁去看
> 它的編輯歷史是合理的（那正是你想知道「為什麼它沒有數值」的地方）。
> **不能選**是記一餐那邊的事（Task 6）。

- [x] **Step 2: 跑測試確認它失敗**

> **跟計畫不一致的地方（流程，不是內容）：** 這裡沒有嚴格照著「先寫測試、
> 跑一次看它紅、再寫實作」的順序執行——測試檔與 `FoodResultList.tsx` /
> `FoodLibrary.tsx` 是在同一段時間內一起寫出來的，第一次跑
> `tests/food-library.test.tsx` 時 12 則（6 條 × 2，開工前必讀第 4 點）
> 就已經全線通過，沒有觀察到「拿掉實作」那個自然狀態下的紅燈。
> 用來補這個洞的是 Step 6 兩個突變各自都親眼見過紅——那兩個紅燈本身
> 就是「這份測試有鑑別力」的證據，只是取得證據的順序跟計畫寫的不同。

- [x] **Step 3: `FoodResultList.tsx`**

只負責呈現一份食物清單，**不知道點下去會發生什麼**：

```tsx
import type { ReactNode } from "react";
import type { Food } from "../api/foods";
import { formatMacro } from "../lib/decimal";

type Props = {
	foods: readonly Food[];
	/** 每一筆要渲染成什麼。食物庫給一個 `<Link>`，記一餐給一個 `<button>` ——
	 *  這個元件不決定去向（規格 §5.4：共用 query hook，不共用元件的去向）。 */
	renderAction: (food: Food) => ReactNode;
};

export function FoodResultList({ foods, renderAction }: Props) {
	if (foods.length === 0) {
		return <p>找不到符合的食物</p>;
	}
	return (
		<ul className="food-results">
			{foods.map((food) => (
				<li key={food.id} data-testid={`food-${food.id}`}>
					{renderAction(food)}
					{food.brand !== null && <span className="food-brand">{food.brand}</span>}
					{food.is_global && <span className="food-tag">公開</span>}
					{food.nutrition === null ? (
						// 規格 §5.5：這不是邊界情況，是後端明寫的合法狀態
						// （全域食物的初版被駁回）。實測確認過搜尋查得到這種食物。
						// 空白一片會讓人以為畫面壞了，所以明講。
						<span className="food-no-nutrition">尚無營養素資料</span>
					) : (
						<span>{formatMacro(food.nutrition.kcal)} kcal / 100{food.nutrition.base_unit}</span>
					)}
				</li>
			))}
		</ul>
	);
}
```

> **`renderAction` 是一個 render prop，不是 `onSelect` callback。** 差別在於
> 食物庫要的是一個 `<Link>`（可以中鍵開新分頁、可以複製網址），記一餐要的是
> 一個 `<button>`（不換頁）。用 `onSelect` 的話食物庫只能拿到 button，
> 而那會讓「食物詳情」這個頁面沒有網址可以分享。

- [x] **Step 4: `FoodLibrary.tsx`**

搜尋框 + scope 三選一 + `FoodResultList` + 「新增食物」連結。

- `useDebounced(input, 300)` 之後餵給 `useFoodSearch`
- scope 用 `<select>` 或三個 radio，**label 文字要能被 `getByLabelText` 找到**
- `searchQuery.isLoading` 且 `q` 非空時顯示「搜尋中…」

- [x] **Step 5: 路由與樣式**

`App.tsx` 加 `<Route path="/foods" element={<FoodLibrary />} />`。
`index.css` 加 `.food-results` / `.food-brand` / `.food-tag` /
`.food-no-nutrition` 的基本樣式。

- [x] **Step 6: 驗證與突變**

> **必須成立：** 把 `useFoodSearch` 的 `enabled: q.trim() !== ""` 拿掉，
> **Step 1 第 1 條測試必須紅**。
>
> **實測填回：**
>
> 兩則測試一起紅（第 1 條，以及依賴同一個 mock 呼叫次序的第 2 條）：
>
> ```
> FAIL tests/food-library.test.tsx > 食物庫 /foods > 一進畫面不發搜尋請求——q 是空的
> AssertionError: expected true to be false // Object.is equality
>  ❯ tests/food-library.test.tsx:77:5
>
> FAIL tests/food-library.test.tsx > 食物庫 /foods > 輸入之後（等過 debounce）發出帶 q 的請求，結果顯示出來
> AssertionError: expected '/api/foods?q=&scope=all' to contain 'q=%E9%9B%9E'
>  ❯ tests/food-library.test.tsx:94:29
> ```
>
> 拿掉 `enabled` 之後，`useFoodSearch("", "all")` 一掛載就直接打了
> `/api/foods?q=&scope=all`——第一條測試量到「確實發了請求」而紅；第二條
> 測試量到的是另一個症狀：因為 query 從掛載那一刻就用 `q=""` fetch 過一次
> 並且立刻進入 `success` 狀態，之後 debounce 安定、`q` 變成 `"雞"` 時，
> `fetchMock.mock.calls.find(...)` 找到的是**第一次**（`q=""`）那個呼叫，
> 不是預期的那次——反映出拿掉 `enabled` 不只是「多打一次」，還改變了
> 呼叫順序，讓依賴「最先符合的那次呼叫」的斷言指向錯的請求。

> **必須成立：** 把 `FoodResultList` 裡 `nutrition === null` 那個分支改成
> 直接讀 `food.nutrition.kcal`，**Step 1 第 4 條必須紅**（而且應該是
> TypeError，不是斷言失敗 —— 如果它是斷言失敗，代表 TS 的 strict null
> 檢查在這裡沒起作用，那是一個發現）。
>
> **實測填回：**
>
> 是 TypeError，而且 TS 的 strict null 檢查確實有起作用——兩件事**同時**
> 觀察到，值得記录：
>
> 1. **執行期真的炸了**，`Unhandled Errors` 印出原始例外：
>
> ```
> Uncaught Exception
> TypeError: Cannot read properties of null (reading 'kcal')
>  ❯ src/components/FoodResultList.tsx:26:35
>      {formatMacro(food.nutrition.kcal)} kcal / 100
> ```
>
> 2. **TS strict null 檢查也真的抓到了**，同一輪跑出兩則 `TypeCheckError`：
>
> ```
> Unhandled Source Error
> TypeCheckError: 'food.nutrition' is possibly 'null'.
>  ❯ src/components/FoodResultList.tsx:26:20
>  ❯ src/components/FoodResultList.tsx:27:8
> ```
>
> 3. 但 vitest 在 `Failed Tests` 段落**顯示出來的**是一個斷言形狀的錯誤，不是
> 那個 TypeError 本身：
>
> ```
> FAIL tests/food-library.test.tsx > 食物庫 /foods > nutrition 是 null 的食物顯示得出來，而且標示它沒有營養素資料
> TestingLibraryElementError: Unable to find an element with the text: 未生效的食物.
>  ❯ tests/food-library.test.tsx:133:23  expect(await screen.findByText("未生效的食物"))...
> ```
>
> 原因是 React 沒有錯誤邊界接住這個 render 期例外，元件樹整個沒渲染出來
> （`<body><div /></body>`），`findByText` 只能等到逾時、回報「找不到」——
> 真正的 TypeError 被歸到獨立的 `Unhandled Errors` 區塊，不在
> `Failed Tests` 底下。**這條紅燈的根因是 TypeError，但 vitest 表面呈現
> 出來的第一層訊息是斷言逾時**，要往下看 `Unhandled Errors` 才看得到
> 計畫原本問的那個問題的答案。
>
> 另外：`vite.config.ts` 的 `typecheck.include` 讓每個測試檔被跑兩次
> （開工前必讀第 4 點），這裡看到的正是那個機制——「執行」那一份撞到
> 真正的 TypeError，「typecheck」那一份撞到型別錯誤，兩份**各自**紅，
> 對應總結裡 `Test Files 1 failed | 1 passed (2)`（2 = 這個檔案的兩份）。

- [x] **Step 7: Commit**（`13a5574`）

---

## Task 4: 新增食物 `/foods/new`

**Files:**
- Create: `frontend/src/screens/NewFood.tsx`
- Create: `frontend/tests/new-food.test.tsx`
- Modify: `frontend/src/App.tsx`

- [x] **Step 1: 寫失敗的測試**

要測的行為：

1. 送出時 body 的形狀是 `{ name, brand, nutrition: { base_unit, kcal, protein_g, fat_g, carb_g } }`，
   **而且四個數值是字串不是 number**
2. `brand` 留空時送的是 `null`，**不是空字串**
3. **`409 FOOD_EXISTS` 顯示「你已經建過同名的食物了」，不是通用錯誤**
4. 422 的欄位錯誤顯示得出來
5. 成功之後導到新食物的詳情頁

> 第 1 條的「是字串不是 number」：規格 §5 的背景事實是後端所有數值都是字串。
> 表單的 `<input>` 本來就給字串，所以這條守的是「沒有人順手加了 `Number()`」。
>
> 第 2 條：`brand` 是 `str | None`，空字串會通過驗證並存成空字串，
> 於是「同名同品牌」的唯一約束對 `""` 與 `null` 是兩個不同的值 ——
> 使用者會建出兩筆看起來一模一樣的食物。

> **跟計畫不一致的地方（流程，不是內容，跟 Task 3 Step 2 同一種）：**
> `NewFood.tsx` 與 `tests/new-food.test.tsx` 是同一段時間內一起寫出來的，
> 不是嚴格「先寫測試、跑一次看紅、再寫實作」——第一次跑
> `tests/new-food.test.tsx` 時 10 則（5 條 × 2，開工前必讀第 4 點）就已經
> 全線通過，沒有觀察到「拿掉實作」那個自然狀態下的紅燈。補這個洞的是
> Step 2–6 的兩個突變：兩條都親眼見過紅，而且紅的原因跟預期一致——那兩個
> 紅燈本身就是「這份測試有鑑別力」的證據，取得證據的順序跟計畫寫的不同。

- [x] **Step 2–6**：實作、路由、驗證、突變、commit

**跟計畫不一致的地方（設計決定，計畫沒指定）：**

- **第 5 條的測試方式：** 用 `MemoryRouter` 掛一個真的 `<Route path="/foods/new">`
  與一個假的 `<Route path="/foods/:id">`（渲染 `food-detail:{id}`），送出成功後
  斷言畫面出現 `food-detail:99`。**不是 mock `useNavigate` 斷言「有被呼叫」**——
  mock 只能驗證「呼叫過某個函式」，驗不到「react-router 真的把 URL 解析成
  `/foods/99` 並比對到 `:id` 路由」；用真的 `MemoryRouter` + 真的 `<Routes>`，
  斷言的是實際導航結果，不是實作細節。
- **`NewFood` 自己呼叫 `useNavigate`，不像 `LogMeal` 用 `onSaved` callback
  交給 `App.tsx` 的 route wrapper：** `LogMeal` 導去的是一個固定路徑
  （`"/"`），`onSaved` 因此可以是一個不知道「導去哪裡」的通用 callback。
  這裡導去的路徑（`/foods/${created.id}`）需要 mutation 回應本體的 `id`，
  那是這個畫面自己才知道的事，硬拆成 callback 只是多一層轉發，
  沒有解耦到什麼。`App.tsx` 因此不需要一個 `NewFoodRoute` wrapper，
  直接 `<Route path="/foods/new" element={<NewFood />} />`（跟 `FoodLibrary`
  一樣）。
- **422 欄位錯誤的測試情境：** 前端只對齊 `kcal`/`protein_g`/`fat_g`/`carb_g`
  的上下限（0–10000 / 0–1000），刻意不重做 `decimal_places=2` 的檢查——
  測試送 `kcal = "12.345"`（在範圍內，前端會放行）觸發後端的 422，
  這樣「前端驗證是為了少一個往返，不是為了取代它」這句話才有一個測得到
  的具體案例，不然前端擋掉的範圍如果跟後端的驗證範圍完全重疊，這條測試
  永遠打不到真正的後端 422。

> **必須成立：** 把 `409 FOOD_EXISTS` 的具名處理拿掉（改成一律顯示
> 「建立失敗」），**Step 1 第 3 條必須紅**。
>
> **實測填回：**
>
> ```
> FAIL tests/new-food.test.tsx > 新增食物 /foods/new > 409 FOOD_EXISTS 顯示「你已經建過同名的食物了」，不是通用錯誤
> TestingLibraryElementError: Unable to find an element with the text: 你已經建過同名的食物了.
>  ❯ tests/new-food.test.tsx:193:17  expect(await screen.findByText("你已經建過同名的食物了"))...
> ```
>
> 拿掉 `caught.code === "FOOD_EXISTS"` 那個分支之後，畫面改顯示通用的
> 「建立失敗，請再試一次」（從渲染輸出裡看得到那段文字），跟預期一致：
> 紅燈的原因確實是「具名處理被拿掉、退回通用錯誤」，不是別的意外原因。

> **必須成立：** 把空 `brand` 從 `null` 改成 `""`，**Step 1 第 2 條必須紅**。
>
> **實測填回：**
>
> ```
> FAIL tests/new-food.test.tsx > 新增食物 /foods/new > brand 留空時送的是 null，不是空字串
> AssertionError: expected '' to be null
>
> - Expected:
> null
>
> + Received:
> ""
>
>  ❯ tests/new-food.test.tsx:165:22  expect(body.brand).toBeNull()
> ```
>
> 把 `brand: brand.trim() === "" ? null : brand.trim()` 改成
> `brand: brand.trim()` 之後，送出的 body 裡 `brand` 確實變成 `""`，
> 紅燈的原因跟預期一致。兩個突變都親眼看過紅、改回來之後親眼看過綠
> （`npx vitest run tests/new-food.test.tsx` → `Tests 10 passed (10)`，
> 5 條測試 × 2，開工前必讀第 4 點）。

**前端的輸入驗證要對齊 `NutritionInput` 的上下限**（`kcal` 0–10000，三個
巨量營養素 0–1000，都是 `max_digits=8, decimal_places=2`），**但後端的 422
仍然要能顯示** —— 前端驗證是為了少一個往返，不是為了取代它。

---

## Task 5: 食物詳情 `/foods/:id`、編輯歷史、提議修改

**Files:**
- Create: `frontend/src/screens/FoodDetail.tsx`
- Create: `frontend/tests/food-detail.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 寫失敗的測試**

要測的行為：

1. 顯示目前生效的營養素；`nutrition === null` 時顯示「這個食物還沒有生效的
   營養素資料」而不是空白或 `NaN`
2. 份量清單**唯讀**（規格 §5.3：不能新增也不能修改，§1.4 份量管理 UI 不在範圍）
3. 編輯歷史每一筆顯示 `status` / `change_note` / `created_at`，
   **而且被駁回的那筆顯示 `reject_reason`**
4. **`is_global === false` 時，送出前的說明是「立刻生效」**
5. **`is_global === true` 時，送出前的說明是「送審」**
6. `409 REVISION_PENDING` 顯示「這個食物已經有一筆待審的編輯，請等審核完成」

> 第 3 條的 `reject_reason` 不是裝飾。沒有它，送審就是一個回了 201 之後
> 永遠沒有下文的黑洞 —— 使用者不知道提案被駁回了，更不知道為什麼。
>
> 第 4/5 條：不講清楚的後果是具體的 —— 使用者改了一個全域食物的數值，
> 按下送出，回到詳情看到的還是舊數字（提案在 PENDING，`current_revision_id`
> 沒動），於是認為功能壞了，再送一次，然後撞上 409。

**`is_global` 到「這是我的」這一步的推導要寫進註解**，因為它不是自明的：

```
is_global === false  ⟹  owner_id 不是 null
                     ⟹  而可見性過濾保證你只看得到 owner_id IS NULL 或 owner_id = 你
                     ⟹  所以 owner_id 就是你
```

它依賴可見性過濾這個**外部保證**，不是依賴這個回應本身帶的資訊。

- [ ] **Step 2–6**：實作、路由、驗證、突變、commit

> **必須成立：** 把「兩種送出結果」的判斷從 `is_global` 改成常數（永遠顯示
> 「立刻生效」），**Step 1 第 5 條必須紅**。
>
> **實測填回：** ——

> **必須成立：** 把 `reject_reason` 那一段刪掉，**Step 1 第 3 條必須紅**。
>
> **實測填回：** ——

提議修改成功後要失效 `queryKeys.food(id)`（前綴會一起打到 `portions` 與
`foodRevisions`，那是刻意的，見 Task 2 Step 1 的註解）。

---

## Task 6: 記一餐加搜尋框，並擋掉沒有生效版本的食物

**Files:**
- Modify: `frontend/src/screens/LogMeal.tsx`
- Modify: `frontend/tests/log-meal.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

要測的行為：

1. 搜尋框輸入之後（等過 debounce）出現搜尋結果，**而且常吃/最近吃還在**
2. 從搜尋結果選一個食物，行為跟從常吃選一個**完全一樣**（進份量輸入）
3. **`nutrition === null` 的食物不能被選** —— 按鈕 `disabled`，
   而且旁邊說明「這個食物還沒有生效的營養素資料」
4. **`409 FOOD_HAS_NO_REVISION` 顯示具名訊息**，不是通用的「記錄失敗，請再試一次」

> 第 3、4 條一起修掉一個實測確認過的問題。
>
> `LogMeal.tsx` 現在的註解寫著：「**這個食物仍然要能被選**、只是不顯示預覽」。
> 實測（開工前用真 API 打過）：
>
> ```
> GET /api/foods?scope=global   → {'id': 66, 'nutrition': None}   查得到
> POST /api/meals (food_id=66)  → 409 FOOD_HAS_NO_REVISION        記不了
> ```
>
> 所以「能被選」的結果是：使用者選了食物、填了份量、按下「記錄」，
> 然後看到 `onError` 的通用訊息「記錄失敗，請再試一次」——
> **而再試一次永遠不會成功。**
>
> 第 3 條把它擋在前面，第 4 條是後備（搜尋到送出之間，食物有可能剛好
> 失去生效版本）。**兩條都要，不是二選一。**
>
> 那段舊註解也要改掉 —— 它現在說的是一件會害人的事。

- [ ] **Step 2–6**：實作、驗證、突變、commit

> **必須成立：** 把第 3 條的 `disabled` 拿掉，**Step 1 第 3 條必須紅**。
>
> **實測填回：** ——

> **必須成立：** 把 `409 FOOD_HAS_NO_REVISION` 的具名處理拿掉，
> **Step 1 第 4 條必須紅**。
>
> **實測填回：** ——

---

## Task 7: `useMe`、管理員 tab、審核佇列

**Files:**
- Create: `frontend/src/api/me.ts`
- Create: `frontend/src/screens/AdminRevisions.tsx`
- Create: `frontend/tests/admin-revisions.test.tsx`
- Modify: `frontend/src/components/TabBar.tsx`
- Modify: `frontend/tests/tab-bar.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: `useMe`**

```ts
export function useMe() {
	return useQuery({
		queryKey: queryKeys.me,
		queryFn: () => apiFetch<components["schemas"]["UserResponse"]>("/api/me"),
	});
}
```

- [ ] **Step 2: TabBar 第五格**

`TabBar` 自己呼叫 `useMe()`，`role === "admin"` 時多一格「審核」。

> **`tests/tab-bar.test.tsx` 現有的 3 則會壞** —— 它們用一個裸的
> `MemoryRouter` 渲染 `<TabBar />`，沒有 `QueryClientProvider`。
> 這是預期的，要更新那個測試檔（包 provider + mock `/api/me`）。
>
> **不要為了避開這件事而把 `role` 從 `App` 傳進來** —— 那只是把同樣的
> 資料依賴往上推一層，而且會讓 `App` 多一個它不需要的 query。

新增的測試：管理員看得到第五格、一般使用者看不到、`useMe` 還在載入時看不到
（不要先閃一下再消失）。

- [ ] **Step 3: 審核佇列畫面**

`GET /api/admin/food-revisions` 回的 `PendingRevisionResponse` **已經把新舊
並排算好了** —— 每一筆同時帶提案的四個數值與目前生效的四個數值
（`current_kcal` / `current_protein_g` / `current_fat_g` / `current_carb_g`，
食物還沒有生效版本時是 `null`）。畫面就是把它們並排擺出來，
**不需要在前端再去查一次那個食物**。

每一筆還帶 `food_name` / `food_brand` / `created_by_name` / `change_note`。

通過：`POST /api/admin/food-revisions/{id}/approve`
駁回：`POST .../reject`，body `{"reason": "…"}`，**`reason` 必填**

**不做樂觀更新。** 審核是一個會改變別人看到什麼的動作，先在畫面上假裝成功
再回頭修正，在 409 時會讓人以為自己審過了。成功之後讓 `pendingRevisions`、
`food(food_id)`、`foodRevisions(food_id)` 三個 key 失效。

要測的行為：

1. 新舊數值並排顯示；食物沒有生效版本時 `current_*` 是 `null`，要顯示「—」
   之類的而不是空白或 `NaN`
2. 通過之後佇列重取
3. 駁回**沒填理由時送不出去**（後端 `min_length=1`）
4. **`403 FORBIDDEN` 顯示「需要管理員權限」，而且不觸發登出**
5. **`409 REVISION_NOT_PENDING` 顯示「已經被審過了」並重新載入佇列**
6. `404 REVISION_NOT_FOUND` 顯示「找不到這筆提案」

> 第 5 條會真的發生：兩個分頁開著同一個佇列，或兩個管理員同時在看。

- [ ] **Step 4: 路由**

`App.tsx` 加 `<Route path="/admin/revisions" element={<AdminRevisions />} />`。

**不做前端導向。** 非管理員直接輸入這個網址時，讓它渲染、讓 API 回 403、
顯示「需要管理員權限」（規格 §3.3）。

> 加一個「不是管理員就 redirect」的話：一條「非管理員看不到審核佇列」的
> 測試會綠，**但它證明的只是 redirect 有效，完全沒有碰到授權** ——
> 把後端的 `require_admin` 整個拿掉，那條測試依然綠。而 redirect 之後
> 403 那條路徑就再也走不到，也就測不到。

- [ ] **Step 5: 驗證與突變**

> **必須成立：** 把後端 `app/api/deps.py` 的 `require_admin` 暫時改成直接
> `return user`（不檢查角色），**Task 8 的 E2E 4 必須紅**。
>
> 這一條要等 Task 8 才驗得了，記在這裡是為了讓 Task 8 知道要做。
> **Task 7 的單元測試抓不到它** —— 單元測試的 mock 自己決定回 403。

> **必須成立：** 把管理員 tab 的 `role === "admin"` 判斷改成常數 `true`，
> **Step 2 那條「一般使用者看不到第五格」必須紅**。
>
> **實測填回：** ——

- [ ] **Step 6: Commit**

---

## Task 8: 契約 E2E

**Files:**
- Create: `frontend/e2e/foods.spec.ts`
- Create: `frontend/e2e/admin.spec.ts`

規格 §10.2 的四條（第 5 條在計畫一已完成）：

1. **建立食物 → 在記一餐搜尋得到 → 記一筆 → 今日總覽數字變**
2. **送審編輯 → 管理員登入 → 佇列看到新舊並排 → 通過 → 食物庫看到新數值**
3. **駁回 → 提案者在食物庫的編輯歷史看得到駁回理由**
4. **非管理員打 admin 端點 → 403 且沒有多打一次 `/api/auth/refresh`**

### 第 4 條為什麼必須數請求

`client.ts` 只在 `response.status === 401` 換票，403 直接拋 `ApiError`。
**這是對的，不需要改。** 但把那個條件改成 `>= 401`：

1. 403 觸發換票
2. 換票**成功**（refresh token 是好的，這個使用者只是不是管理員）
3. 重送原請求
4. 又是 403，同一個錯誤碼、同一句訊息
5. **畫面上的結果一模一樣**

一條斷言「看到『需要管理員權限』」的測試**依然會綠**。唯一抓得到這個突變的
方式是數請求：多了一次 `/api/auth/refresh`。

```ts
const refreshCalls: string[] = [];
page.on("request", (req) => {
	if (req.url().includes("/api/auth/refresh")) refreshCalls.push(req.url());
});
// …導到 /admin/revisions…
await expect(page.getByText("需要管理員權限")).toBeVisible();
expect(refreshCalls).toHaveLength(0);
```

### 帳號

用 `e2e/accounts.ts`（Task 1 建的）：`ADMIN` 與 `MEMBER`。

**第 2、3 條需要兩個身分：** `MEMBER` 送審，`ADMIN` 審核。Playwright 的
同一個 `page` 換使用者要先登出（或用兩個 `browser.newContext()`）——
**選哪一種在實作時決定，但要在註解裡寫出為什麼**。

> **注意：全域食物才會走送審流程。** `POST /api/foods` 一律建立
> `owner_id = 自己` 的私人食物，而私人食物的編輯**直接生效、不送審**。
> 所以第 2、3 條需要一個 `owner_id IS NULL` 的食物，而**沒有任何 API 可以
> 建立它**（開工前查證過）。
>
> **這是 Task 8 開工時第一件要解決的事，而且它可能需要另一個後端改動。**
> 三個可能的方向，實作時先查證再選：
>
> 1. 種子步驟用 SQL 直接插一筆全域食物（最小，但 E2E 依賴外部種子）
> 2. `app/cli.py` 再加一個 `create-global-food` 指令（跟 Task 1 同一類，
>    而且部署時本來就會需要它 —— 現在完全沒有辦法建全域食物）
> 3. E2E 自己用管理員身分打某個端點建 —— **先確認真的有這種端點再選這個**
>
> **不要假設選項 3 存在。** 開工前的查證只確認了 `POST /api/foods` 一律建
> 私人食物。

- [ ] **Step 1: 先查證全域食物怎麼建，把答案寫進這一節**
- [ ] **Step 2–5**：寫四條 E2E、跑、突變驗證、commit

> **必須成立：** 把 `app/api/deps.py` 的 `require_admin` 改成不檢查角色，
> **第 4 條必須紅**。
>
> **實測填回：** ——

> **必須成立：** 把 `client.ts` 的 `=== 401` 改成 `>= 401`，
> **第 4 條必須紅，而且紅在請求計數那一行**（不是文字斷言）。
>
> **實測填回：** ——

---

## 收尾

- [ ] **把每一處「實測填回」都填上**

這份計畫刻意不預測哪條測試會紅。**每一個「實測填回：——」都要換成實際看到的
測試名稱與訊息。** 留空的話，下一個人會以為那個突變沒有做。

- [ ] **跟預期不同的都寫進計畫**

特別是「必須成立」的突變跑完全綠的那些 —— 那是發現，不是障礙。

- [ ] **更新交接文件**

`docs/handover.md` §6（綠燈說謊）要補這一輪的新項目。計畫一已經有四個候選：

1. 一個 mock 裡的守衛，它守的那條路徑在所有使用它的測試裡從來沒被走過
2. 原始碼掃描守衛太鈍，分不出「程式碼在呼叫它」與「註解在解釋不要呼叫它」；
   而剝掉註解之後，剝太多又會讓它什麼都沒看到而變綠
3. 為了讓 lint 過而拿掉 `role="img"`，圖對螢幕閱讀器整個消失而所有測試照樣綠
4. 一條測試的 mock 日期剛好等於執行日，於是它在那一天鑑別力為零

§7 要補：`ruff format` 沒有被 CI 強制（只跑 `ruff check`），所以不要在不相干的
改動裡跑 format。

- [ ] **開 PR**
