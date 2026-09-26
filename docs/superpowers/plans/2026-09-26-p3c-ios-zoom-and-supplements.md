# P3-C：iOS 輸入框放大，與補劑的新增／臨時記錄 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修掉手機上「要往旁邊滑」的實際原因，並補上補劑的新增與「今天吃了就點一下」。

**Architecture:** 表單控制項一律最低 16px（iOS 門檻），由一條在真瀏覽器跑的 Playwright 守衛釘住。補劑沿用食物庫既有的形狀（`useSupplements` + 一個管理畫面），**但完全不碰「固定計畫」** —— 使用者要的是臨時記錄，而後端的 `plan_id: null` 就是為那件事存在的。

**Tech Stack:** React 19 · react-router 8 · TanStack Query 5 · Biome · Vitest + Testing Library · Playwright

---

## 這份計畫的來源不一樣：它來自真實使用

前面每一份計畫都是「規格推導出來的」。**這一份的兩條需求都來自 app 第一次被真的用**
（2026-09-26，第一次部署到 NAS 並用手機開啟）：

> 「手機版 UI 無法顯示完整功能 要往旁邊滑」
> 「補劑類 我想要能新增我有在使用的 當天有吃就點一份進去就好」

P3-A 規格 §1.1 說過「趨勢圖要看什麼、食物庫要怎麼找，這些問題在累積了兩週
真實資料之後才有答案」。**那個前提到今天才開始成立。**

---

## 開工前必讀

### 1. 計畫的文字不是權威

發現實際情況跟這份計畫寫的不一樣就**停下來報告**，不要硬做，也不要自己悄悄
改方向繼續。前兩份計畫每一個 task 的最有價值產出都是這種回報。

### 2. 突變步驟不預測哪一條測試會紅

> **必須成立：** 把 X 改成 Y 之後，至少一條測試紅，原因是 Z。
>
> **實測填回：** ——

**跑完全綠是一個發現，不是障礙。** 停下來報告。

### 3. 驗證輸出要一起看 `FAIL` 與 `Unhandled`

```bash
cd F:/wallet/frontend && npm run test 2>&1 | grep -E "Test Files|Tests |Type Errors|FAIL|Unhandled"
```

一個 transform parse error 會讓 vitest **同時**印出 `FAIL x.test.tsx (0 test)` 與
`Tests 8 passed (8)`。只看後者會以為全綠。

### 4. `Test Files` / `Tests` 都是實際數量的兩倍

`typecheck.include` 跟一般 include 蓋到同一組檔案。**算數字要除以二。**

開工基準線：

```
 Test Files  54 passed (54)
      Tests  268 passed (268)
Type Errors  no errors
Playwright  11 passed
```

### 5. `// biome-ignore` 在 JSX children 位置會變成文字

要用 `{/* biome-ignore … */}`。`return (` 之後屬於運算式位置，`//` 合法。

---

## 開工前已經查證過的事實

**每一項都是實際讀原始碼或實際量測確認的。**

### iOS 放大這件事是量出來的，不是推論

在**已部署的正式站**（`https://kennywang.tailc1f9e9.ts.net`）用 Playwright
量每個表單控制項的 computed font-size：

```
登入畫面 Email 輸入框     13.3333px
登入畫面 密碼輸入框       13.3333px
記一餐 / 食物庫 搜尋框     13.3333px
食物庫的三個 scope radio   13.3333px
```

`frontend/src/index.css`（102 行）**從來沒有給 `input` / `select` / `textarea`
設過字級** —— 它們用的是瀏覽器預設。

**iOS Safari 在使用者點進一個 computed font-size < 16px 的輸入框時，會自動
把整頁放大。** 放大之後版面就比視窗寬，於是要往旁邊滑。

**而橫向溢出本身不存在。** 同一次量測在 320 / 360 / 390px 三種寬度下，
每一個畫面的 `scrollWidth` 都等於 `clientWidth`（連塞了一個 12 字的食物名
與一筆餐點之後也是）。所以：

- **這不是版面寬度問題，不要去改 layout**
- Chromium 不做這個自動放大，**Playwright 測不到那個症狀**
- 這是規格 §9.2 第 9 條那一類：**只有真機會發現**

> **守衛要釘的是規則（字級 ≥ 16px），不是症狀（頁面有沒有被放大）。**
> 症狀在 Chromium 裡永遠不會出現，拿它當斷言就是一個永遠綠的測試。

### 補劑：後端已經完整支援，缺的純粹是介面

| 端點 | 用途 | 前端有沒有用 |
|---|---|---|
| `POST /api/supplements` | 新增補劑 | **沒有** |
| `GET /api/supplements?q=&scope=` | 搜尋補劑 | **沒有** |
| `GET /api/supplements/today` | 今日清單 | ✅ `Today.tsx` |
| `POST /api/supplement-intakes` | 記一次攝取 | ✅ 但只用在「對既有計畫項目打卡」 |
| `DELETE /api/supplement-intakes/{id}` | 取消 | ✅ |
| `POST /api/supplement-plans` 等 | 固定計畫 | 沒有，**這份計畫也不做** |

**`plan_id: null` 就是使用者要的東西。** `SupplementIntakeCreateRequest` 的
註解逐字寫著：

> `# NULL = 臨時記錄，不屬於任何固定計畫（規格第 6.4 節）`

而 `TodaySupplementItem` 的 docstring：

> `plan_id` 為 None 代表這是一筆臨時記錄（沒有對應的固定計畫），
> 這種項目一定是 `done=True`

所以「當天有吃就點一份進去」**不需要建任何計畫**，直接 POST 一筆
`plan_id: null` 的 intake 即可，而 `GET /api/supplements/today` 會把它列出來。

### 相關 schema（查證過，不要從記憶裡拿）

`SupplementCreateRequest`：

```
name          str, 1–100
brand         str | null, ≤100
serving_unit  str, 1–50    ← 開放集合（'capsule'、'g'、'ml'、'IU'…），純顯示，不參與計算
serving_size  Decimal, >0, ≤10000, max_digits=8, decimal_places=2
kcal          Decimal, 預設 0, 0–10000     ← 四個都有預設 0
protein_g     Decimal, 預設 0, 0–1000         「只想記錄吃了沒、不記熱量的補劑
fat_g         Decimal, 預設 0, 0–1000          （例如魚油）不用每次特地填 0」
carb_g        Decimal, 預設 0, 0–1000
```

`SupplementResponse`：`id` / `name` / `brand` / `is_global` / `serving_unit` /
`serving_size` / `kcal` / `protein_g` / `fat_g` / `carb_g`

`SupplementIntakeCreateRequest`：`supplement_id` / `plan_id`（可 null）/
`dose`（>0，≤1000）/ `taken_at`（datetime）

`TodaySupplementItem`：`plan_id` / `supplement_id` / `supplement_name` /
`dose` / `time_of_day` / `done` / `intake_id`

> **`SupplementResponse` 有 `is_global`，跟 `FoodResponse` 一樣沒有 `owner_id`。**
> 全域補劑的建立權限請去讀 `app/api/routes/supplements.py` 的 `create_supplement`
> 確認（食物那邊是 Task 8 才加 `is_global`，補劑不一定有）。
>
> **實測填回（2026-09-26，Task 2）：確認過，補劑完全沒有全域建立的路徑。**
> `create_supplement`（`app/api/routes/supplements.py`）不分角色，一律
> `owner_id=user.id`：
> ```python
> supplement = Supplement(
>     name=payload.name,
>     brand=payload.brand,
>     owner_id=user.id,
>     ...
> )
> ```
> 對照食物的 `create_food`（`app/api/routes/foods.py`）：那邊 `FoodCreateRequest`
> 有 `is_global` 欄位，`is_global=True` 且非管理員會被擋成
> `403 FORBIDDEN`（`只有管理員能建立全域食物`），`owner_id = None if
> payload.is_global else user.id`。**`SupplementCreateRequest` 根本沒有
> `is_global` 這個欄位**——不是「管理員才能建全域補劑」，是「這個 API
> 目前完全沒有建立全域補劑的手段」，即使是管理員也一樣。`Supplement`
> model 的欄位註解寫「NULL = 全域補劑（管理員維護）」，暗示曾經設計過
> 這個角色，但目前的路由沒有實作它。
>
> 對這個 task 的影響：`Supplements.tsx` 的「新增補劑」表單**不需要、也不
> 應該**有任何 `is_global` 或角色相關的 UI——後端目前唯一支援的建立方式
> 就是私人補劑，跟 `NewFood.tsx` 的私人食物創建同一個形狀。

### 既有前端形狀

| 事實 | 出處 |
|---|---|
| `Today.tsx` 已有「今日補劑」區塊，`plan_id !== null && !done` 才顯示打卡按鈕 | `frontend/src/screens/Today.tsx` |
| `plan_id === null` 的項目一定 `done=true`，只顯示「取消」 | 同上 |
| `apiFetch<T>` 回 `Promise<T \| null>`，`=== undefined` narrow 不掉 `null`。慣例是 truthy 判斷 | `frontend/src/api/client.ts` |
| `FoodResultList` 用 render prop（`renderAction`），食物庫給 `<Link>`、記一餐給 `<button>` | `frontend/src/components/FoodResultList.tsx` |
| `useDebounced(value, ms)` 可直接重用 | `frontend/src/lib/use-debounced.ts` |
| tab bar 目前 4 格（管理員 5 格） | `frontend/src/components/TabBar.tsx` |

---

## 檔案結構

**新增：**

| 檔案 | 責任 |
|---|---|
| `frontend/src/api/supplements.ts` | `useSupplementSearch`、`useTodaySupplements` |
| `frontend/src/screens/Supplements.tsx` | `/supplements`：清單 + 新增 + 「今天吃了」 |
| `frontend/tests/supplements.test.tsx` | Task 2 |
| `frontend/e2e/mobile-form-zoom.spec.ts` | Task 1 的守衛 |

**修改：**

| 檔案 | 改什麼 | Task |
|---|---|---|
| `frontend/src/index.css` | 表單控制項最低 16px | 1 |
| `frontend/src/api/queries.ts` | 補劑的 query key | 2 |
| `frontend/src/screens/Today.tsx` | 「今日補劑」區塊加一個連到 `/supplements` 的入口 | 2 |
| `frontend/src/App.tsx` | 加 `/supplements` 路由 | 2 |

**不做**：固定計畫（`supplement-plans`）的任何介面。使用者明講「當天有吃就
點一份進去就好」——那是臨時記錄，不是排程。

---

## Task 1: 表單控制項最低 16px

**Files:**
- Modify: `frontend/src/index.css`
- Create: `frontend/e2e/mobile-form-zoom.spec.ts`

- [x] **Step 1: 先寫守衛（這次真的先寫，而且它現在就該紅）**

建 `frontend/e2e/mobile-form-zoom.spec.ts`。

**它要斷言的是規則，不是症狀**：在手機視窗下走過每一個有表單的畫面，
斷言每一個 `input` / `select` / `textarea` 的 computed font-size **≥ 16px**。

```ts
// iOS Safari 在使用者點進 computed font-size < 16px 的輸入框時，會自動把
// 整頁放大——放大之後版面比視窗寬，使用者得往旁邊滑才看得到其他東西。
//
// **這條測試斷言的是規則（≥16px），不是症狀（頁面被放大）。**
// Chromium 不做那個自動放大，所以「頁面有沒有變寬」在這裡永遠是「沒有」，
// 拿它當斷言就是一個永遠綠的測試。
//
// 實測（2026-09-26，對已部署的正式站量的）：登入畫面兩個輸入框、
// 記一餐與食物庫的搜尋框、食物庫的三個 scope radio，全部都是 13.3333px。
// 而同一次量測確認橫向溢出【不存在】——320/360/390px 三種寬度下
// scrollWidth 都等於 clientWidth。所以這不是 layout 問題，不要去改版面。
```

要走過的畫面至少：登入、記一餐、食物庫、新增食物、`/supplements`（Task 2 之後）。

`button` 不在此限（iOS 不會因為按鈕字級放大），但**如果你想一起納入也可以** ——
在註解裡說明你的選擇。

- [x] **Step 2: 跑它，確認它現在就紅**

```bash
cd F:/wallet && docker compose up -d
cd F:/wallet/frontend && npx playwright test e2e/mobile-form-zoom.spec.ts --reporter=list
```

**這一步跟前幾份計畫不同：這條測試在寫實作之前就該紅**，因為缺陷現在真的存在。
如果它一開始就綠，**停下來報告** —— 代表斷言沒抓到東西。

**實測填回（2026-09-26，修 CSS 之前）：** 兩條測試都紅。

```
Error: 登入畫面 的 <input id="email" name="" type="email"> computed font-size 是 13.3333px，
低於 iOS Safari 的 16px 門檻——會觸發自動放大。
```
```
Error: 食物庫畫面 的 <input id="food-search-input" name="" type="text"> computed font-size 是 13.3333px，
低於 iOS Safari 的 16px 門檻——會觸發自動放大。
```

跟開工前查證的量測值（13.3333px）完全吻合。

- [x] **Step 3: 修**

`frontend/src/index.css` 加：

```css
/* **iOS Safari 的門檻值，不是品味。** computed font-size < 16px 的輸入框
   被點進去時，iOS Safari 會自動把整頁放大——版面因此比視窗寬，使用者得
   往旁邊滑。這是 app 第一次被真的用（2026-09-26）回報的第一個問題。

   Chromium 不做這個放大，所以本機、CI、Playwright 全部看不見。
   守衛在 e2e/mobile-form-zoom.spec.ts，它釘的是「字級 ≥ 16px」這條規則，
   不是「頁面有沒有被放大」那個在 Chromium 裡永遠不會發生的症狀。 */
input,
select,
textarea {
	font-size: 16px;
}
```

**放在哪裡、要不要一併調整周邊間距由你決定** —— 16px 比原本的 13.33px 大，
表單會變高一點。如果那讓某個畫面變得難看，一起調，並在報告裡說明。

- [x] **Step 4: 跑守衛，確認它綠**（連跑兩次確認不是碰巧綠一次）

- [x] **Step 5: 突變驗證**

> **必須成立：** 把 `font-size: 16px` 改成 `15px`，Step 1 那條測試必須紅，
> 而且訊息要指出是哪一個控制項、實際幾 px。
>
> **實測填回：** 成立。兩條測試都紅：
>
> ```
> Error: 登入畫面 的 <input id="email" name="" type="email"> computed font-size 是 15px，
> 低於 iOS Safari 的 16px 門檻——會觸發自動放大。
> ```
> ```
> Error: 食物庫畫面 的 <input id="food-search-input" name="" type="text"> computed font-size 是 15px，
> 低於 iOS Safari 的 16px 門檻——會觸發自動放大。
> ```
>
> 訊息同時指出控制項（id/tag/type）與實際 px。驗證後已改回 16px。

- [x] **Step 6: 全套驗證與 commit**

```bash
cd F:/wallet/frontend && npm run test 2>&1 | grep -E "Test Files|Tests |Type Errors|FAIL|Unhandled"
npm run lint && npm run typecheck
npx playwright test --reporter=list
```

> 既有的 E2E 可能會因為版面變高而受影響（例如某個元素被 tab bar 蓋住）。
> **真的紅了要看清楚原因**，不要直接改測試。

---

## Task 2: 補劑的新增與「今天吃了」

**Files:**
- Create: `frontend/src/api/supplements.ts`
- Create: `frontend/src/screens/Supplements.tsx`
- Create: `frontend/tests/supplements.test.tsx`
- Modify: `frontend/src/api/queries.ts`
- Modify: `frontend/src/screens/Today.tsx`
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/index.css`

### 使用者要的是什麼（原文）

> 「補劑類 我想要能新增我有在使用的 當天有吃就點一份進去就好」

拆成兩件事：

1. **新增我有在使用的** → `POST /api/supplements`
2. **當天有吃就點一份進去** → `POST /api/supplement-intakes` 帶
   **`plan_id: null`**、`dose: 1`、`taken_at: 現在`

**「就好」是範圍的一部分**：不要做固定計畫、不要做每日排程、不要做時段
（`time_of_day`）。那些是 `supplement-plans` 的事，而使用者明講不需要。

### 不要加第六個 tab

tab bar 現在 4 格（管理員 5 格）。加到 6 格在 320px 寬度下每格只剩 53px，
中文標籤會擠爆（實測過 320px 時每格是 64px，4 個中文字約 56px，已經很緊）。

**改成從「今日補劑」那一區進去** —— 那是使用者會看到補劑的地方，也是他們
想「加一個」的當下。

- [x] **Step 1: query key 與資料層**

`queryKeys` 加了 `supplementSearch`（`supplementsToday` 沒有重複定義）。

> **獨立命名空間**，理由跟 `food-search` 一樣（`api/queries.ts` 裡有那段註解）。
> **而且它也不該進離線持久化** —— 去看 `api/persist.ts` 的 `NOT_PERSISTED`，
> 判斷要不要把它加進去，並在報告裡說明你的判斷。
>
> **判斷（2026-09-26）：加進去了。** 理由跟 `food-search` 完全一樣——
> `useSupplementSearch` 每敲一個字就是一組新的 query key，會在
> `localStorage` 裡累積出跟食物搜尋一模一樣的失敗模式：`setItem` 丟
> `QuotaExceededError` 時炸的是**整份**離線快取，不只是補劑搜尋本身。
> 已加進 `frontend/src/api/persist.ts` 的 `NOT_PERSISTED`。

`frontend/src/api/supplements.ts`：`useSupplementSearch(q)` 與
`useTodaySupplements()`。形狀照 `api/foods.ts` 的 `useFoodSearch`（含
`enabled: q.trim() !== ""` 與 `encodeURIComponent`），但**刻意沒有 `scope`
參數**——`Supplements.tsx` 不做食物庫那種三選一，後端 `scope` 省略時
預設 `all` 已經夠用。

- [x] **Step 2: 寫測試**

必須成立的行為：

1. `/supplements` 列出搜尋結果；**空字串不發請求**
2. 新增補劑：body 形狀正確，**四個營養素留空時送預設的 `"0"` 而不是省略或 `null`**
   （後端有預設，但前端送什麼要是刻意的決定 —— 在註解寫明你選哪個、為什麼）
3. **「今天吃了」送出的 `plan_id` 是 `null`**，`dose` 是 `"1"`，`taken_at` 是 ISO 字串
4. 記錄成功後 `supplementsToday` 失效（今日總覽要看得到）
5. `today` 清單裡 `plan_id === null` 的項目顯示成「已記錄」而不是「待打卡」

> 第 3 條是這個 task 的核心。`plan_id` 不是 `null` 的話會變成「對某個計畫打卡」，
> 而使用者根本沒有計畫 —— 後端會怎麼回應請實測，不要假設。
>
> **實測填回（2026-09-26）：** `app/api/routes/supplement_intakes.py` 的
> `create_intake`：`plan_id` 非 null 時會呼叫 `_load_owned_plan` 依擁有權
> 載入該計畫，找不到或不是自己的一律 `404 NOT_FOUND`；找得到但
> `plan.supplement_id != supplement.id` 則是 `422
> PLAN_SUPPLEMENT_MISMATCH`。也就是說對一個沒有任何計畫的使用者，隨便塞
> 一個 `plan_id`（例如 `1`）幾乎必然打到 `404`（那個 id 對這個使用者不
> 存在）。這個 task 的測試沒有走真的後端（vitest 是 mock fetch），所以
> 這個行為在單元測試層是「假設後端這樣做」，但這個假設已經對照原始碼
> 逐行確認過，不是憑空猜的。

`frontend/tests/supplements.test.tsx` 六則測試涵蓋以上 5 條行為
（第 3 條拆成「送出的 body 形狀」與「supplementsToday 失效」兩則）。

- [x] **Step 3–5: 實作、路由、Today 的入口**

`Today.tsx` 的「今日補劑」區塊加了一個連到 `/supplements` 的連結，文字是
「新增補劑」。

- [x] **Step 6: 突變驗證**

> **必須成立：** 把「今天吃了」送出的 `plan_id` 從 `null` 改成 `1`，
> 至少一條測試紅。
>
> **實測填回（2026-09-26）：成立。** `tests/supplements.test.tsx` 的
> 「「今天吃了」送出的 plan_id 是 null，dose 是 "1"，taken_at 是 ISO 字串」
> 這條紅：
> ```
> AssertionError: expected 1 to be null
> - Expected: null
> + Received: 1
>  ❯ tests/supplements.test.tsx:208:24
>    expect(body.plan_id).toBeNull();
> ```
> 驗證後已改回 `null`。

> **必須成立：** 拿掉 `supplementsToday` 的失效，至少一條測試紅。
>
> **實測填回（2026-09-26）：成立。** 把 `checkIn` mutation 的
> `onSuccess` 裡 `invalidateQueries({ queryKey: queryKeys.supplementsToday })`
> 整段拿掉（只留 `dailyStats` 那一行），「記錄成功後 supplementsToday
> 失效——今日總覽要看得到新記的這一筆」這條紅在：
> ```
> await waitFor(() => expect(todayCallCount).toBeGreaterThanOrEqual(2));
> ```
> （`todayCallCount` 停在 1，代表 `/api/supplements/today` 沒有被重新
> fetch。）驗證後已加回那一行 `invalidateQueries`。

- [x] **Step 7: 契約 E2E**

一條：**新增一個補劑 → 點「今天吃了」 → 今日總覽看得到它**
（`e2e/supplements.spec.ts`）。

用 `e2e/accounts.ts` 的 `ADMIN`。補劑名稱帶 `Date.now()`
（`POST /api/supplements` 大概也有唯一約束，**去確認**）。

> **實測填回（2026-09-26）：確認過，唯一約束存在。**
> `app/models/supplement.py` 的 `Supplement.__table_args__`：
> `UniqueConstraint("owner_id", "name", "brand", name=
> "uq_supplements_owner_id_name_brand", postgresql_nulls_not_distinct=True)`。
> 違反時 `create_supplement` 捕捉 `IntegrityError`，回
> `409 SUPPLEMENT_EXISTS`（「你已經建過同名同品牌的補劑了」）。跟食物的
> `FOOD_EXISTS` 是同一種形狀。補劑名稱帶 `Date.now()` 是必要的，不是保險。

> **送出後要等存檔完成再導頁。** `e2e/trend.spec.ts` 踩過：按下送出就立刻
> 點下一個連結，請求還在飛的時候元件被卸載，單獨跑永遠綠、平行跑約一半
> 機率紅，而且紅的訊息會指向錯誤的地方。
>
> **實作方式：** `e2e/supplements.spec.ts` 沒有用「等某個 UI 訊號出現」
> 這種間接的同步點，而是直接用 `page.waitForResponse` 等
> `POST /api/supplements` 與 `POST /api/supplement-intakes` 兩次請求各自
> 的回應完成，再往下一步走。

### 跟計畫不一致 / 執行中額外發現的事（2026-09-26）

這三件都是計畫沒寫、實作過程中撞到才發現的，照第 2 條鐵律停下來記在這裡，
不是悄悄修掉當作沒發生過：

1. **`Today.tsx` 加了 `<Link>` 之後，兩個既有測試檔直接炸掉。**
   `tests/today.test.tsx` 與 `tests/offline.test.tsx` 原本的 `wrap()`
   都只包 `QueryClientProvider`（`offline.test.tsx` 還多包一層
   `PersistQueryClientProvider`），沒有 `MemoryRouter`。`<Link>`
   在沒有 Router context 時會直接拋錯（`Cannot destructure property
   'basename' of 'React$1.useContext(...)' as it is null`），兩個檔案
   全部測試（5 + 5 則）一次全紅。已經在兩個檔案的 `wrap()` 裡各加一層
   `MemoryRouter`，兩邊都補了註解說明理由，修完後兩個檔案照原本的行為
   全綠。這不是這個 task 測試範圍內的東西，但既有測試被我加的程式碼
   連帶弄壞，屬於「發現跟預期不一樣就要處理」，不能放著不管。

2. **`e2e/mobile-form-zoom.spec.ts` 新增的 `/supplements` 測試第一次執行
   時真的紅了，但紅的原因不是產品碼，是測試自己的同步點不夠。** 錯誤是
   `<input id="meal-photo-upload-208" ...>` 的 computed font-size 是空
   字串（NaN），而這個 `id` 屬於 `Today.tsx` 的 `MealList` /
   `MealPhotoUpload`，不該出現在 `/supplements` 畫面。追下去發現：
   ADMIN 帳號跑過大量 e2e 之後累積了很多筆歷史餐點，`MealList` 因此掛著
   為數不少的隱藏 `<input type="file">`；換頁時 React 移除舊路由子樹
   跟掛載新路由是同一次 commit，但 DOM 量大時，原本「等新畫面的 heading
   出現」這個同步點（沿用自食物庫那幾條測試、原本夠用）在這裡不夠——
   斷言拿到的是舊畫面正在被拆除過程中的一個瞬間快照，`.evaluate()`
   真正執行時節點已經被拔掉。**修法：改成明確等 `Today.tsx` 專屬的
   `<h2>今日補劑</h2>`（`exact: true`）從畫面上消失，而不是只等新畫面
   的 heading 出現**——前者保證整棵舊子樹（含所有 file input）真的卸載
   完了。修好後連續本機跑了 4 次、平行跑了 2 次全綠，沒有再復發。
   這也印證了第 1 條鐵律：這條紅燈第一次出現時，訊息（file input 的
   font-size 是 NaN）差點被誤讀成「新增補劑表單有欄位漏設定字級」，
   實際原因完全是另一回事。

3. **`Supplements.tsx` 的搜尋區塊標題與輸入框的 label 原本都寫「搜尋
   補劑」，重複的可存取名稱雖然不會讓 `getByLabelText` 失準（它只認
   `<label>`），但為了避免之後任何人用 `getByRole("heading", ...)` 或
   `getByText` 時撞名，已經把 `<h2>` 的文字改成「找補劑，今天吃了就點
   一份」，label 維持「搜尋補劑」。這不是紅燈逼出來的，是寫測試時手動
   注意到的，記在這裡是因為它跟第 2 點是同一類風險（accessible name
   的字串重疊）。

---

## 收尾

- [x] 把每一處「實測填回」都填上
- [ ] **部署到 NAS 並請使用者在真機確認**：

```bash
ssh wangkc1001@100.96.244.42
cd ~/apps/nutrition-tracker && git pull
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

- [ ] **真機驗收（只有使用者做得到）**：點進登入畫面的輸入框，**頁面不該放大**
- [ ] `docs/handover.md` §6 補一條：**在 Chromium 裡永遠不會發生的症狀，
  不能拿來當斷言** —— 要斷言的是造成那個症狀的規則
