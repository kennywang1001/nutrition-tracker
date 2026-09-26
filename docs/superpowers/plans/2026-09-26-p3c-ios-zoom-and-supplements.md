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

## Task 3: 記一餐變成首頁

### 來源同樣是真實使用

> 「記一餐應該放在首頁 並且加入 常用食物的選項表」

**後半句不用做新東西。** `LogMeal` 已經有常吃／最近吃清單
（`/api/foods/frequent` + `/api/foods/recent`，`dedupeById` 合併）。
使用者看不到內容是因為正式站只有 1 筆記錄 —— 那份清單是從記錄歷史推導的，
用幾天就會長出來。**不要另外做一個「收藏」機制**：後端沒有那個概念，
而使用者要的「常用」跟「最近常吃」在語意上是同一件事。

（如果之後確認要的是手動釘選的最愛，那是另一份規格 —— 要加欄位與端點。）

**Files:**
- Modify: `frontend/src/App.tsx`
- Modify: `frontend/src/components/TabBar.tsx`
- Modify: `frontend/e2e/auth.spec.ts`
- Modify: `frontend/e2e/daily-loop.spec.ts`
- Modify: `frontend/e2e/trend.spec.ts`
- 可能還有：`frontend/tests/app.test.tsx`、`frontend/e2e/*.spec.ts` 其他幾支

### 要改成什麼

| 現在 | 改成 |
|---|---|
| `/` = `Today` | `/` = `LogMeal` |
| `/log` = `LogMeal` | `/today` = `Today` |
| tab：今日總覽・記一餐・趨勢・食物庫 | **記一餐**・今日總覽・趨勢・食物庫 |

### ⚠️ 這個 task 會讓既有 E2E 紅，而且它們**應該**紅

行為真的變了。**逐條看清楚每一條為什麼紅，再決定怎麼改。不要為了讓它綠而改。**

已知會受影響的（寫計畫時查的，**實際情況以你跑出來的為準**）：

- `e2e/auth.spec.ts` 有三處 `getByRole("heading", { name: "今日總覽" })`
  斷言「登入後看到今日總覽」。登入後的落地頁變成記一餐，那三處要改成
  記一餐的 heading —— **而那正是這個 task 要驗的行為**，不是遷就。
- `e2e/daily-loop.spec.ts`、`e2e/trend.spec.ts` 都會點「記一餐」連結、
  然後依賴 `onSaved` 導頁。見下。
- `frontend/tests/app.test.tsx` 有幾則驗登入後顯示什麼。

### `onSaved` 的去向要一起改

`LogMealRoute` 的 `onSaved` 現在 `navigate("/")`。首頁變成記一餐之後，
**記完一餐導回記一餐頁是錯的** —— 使用者要看到數字變了。應該導去 `/today`。

**而那個導向正是 `daily-loop.spec.ts` 與 `trend.spec.ts` 在守的路徑**
（它們送出後等今日總覽出現，那是「存檔完成」的同步點）。改完要確認那兩條
仍然有效，而不是變成「剛好還是綠的」。

### 突變

> **必須成立：** 把 `onSaved` 的導向從 `/today` 改回 `/`，至少一條測試紅。
>
> **實測填回（2026-09-26）：成立。** `frontend/src/App.tsx` 的
> `LogMealRoute` 改成 `navigate("/")` 之後，Playwright 三條 E2E 一起紅
> （`daily-loop.spec.ts`、`foods.spec.ts`、`trend.spec.ts`）：
> ```
> Error: expect(locator).not.toHaveText(expected) failed
> Locator: getByTestId('macro-kcal')
>  ❯ e2e\daily-loop.spec.ts:97:51
> ```
> ```
> Error: expect(locator).toBeVisible() failed
> Locator: getByRole('heading', { name: '今日總覽' })
>  ❯ e2e\foods.spec.ts:53:60
>  ❯ e2e\trend.spec.ts:115:60
> ```
> 三條的訊息都指向正確的地方：記完一餐之後畫面卡在記一餐（因為
> onSaved 導回了自己），今日總覽的 heading／`macro-kcal` 因此永遠等不到。
> 這個 task 沒有任何 vitest 單元測試守這個導向目標（`LogMealRoute` 只在
> `App.tsx` 裡被用到，`tests/log-meal.test.tsx` 測的是 `<LogMeal>` 本身、
> 用 `vi.fn()` 假的 `onSaved`，看不到真正導去哪裡）——**這條突變只能靠
> E2E 驗**，這件事本身也回答了「daily-loop 與 trend 改完之後還守得到
> 原本要守的東西嗎」那個問題：守得到，而且是唯一守得到的地方。
> 驗證後已改回 `navigate("/today")`。

> **必須成立：** 把 tab bar 第一格改回今日總覽（`end: true` 那格），
> 至少一條測試紅。
>
> **實測填回（2026-09-26）：成立。** 把 `TabBar.tsx` 的 `TABS[0]` 改回
> `{ to: "/", label: "今日總覽", end: true }`（`to: "/today"` 那格的
> label 對應改回「記一餐」，`to` 不變——模擬「只有 label 跟語意被改
> 回去、路由沒有一起改」這個最常見的疏漏），`tests/tab-bar.test.tsx`
> 那條「在 /today 時亮的是今日總覽，不是記一餐」紅：
> ```
> Error: expect(element).toHaveAttribute("aria-current", "page")
> Expected the element to have attribute:
>   aria-current="page"
> Received:
>   null
>  ❯ tests/tab-bar.test.tsx:113:5
> ```
> 因為 `to="/today"` 那格的 label 被換成「今日總覽」之後，畫面上再也
> 沒有 `name: "今日總覽"` 的連結精確對應 `/today`（`to="/"` 那格雖然
> `label` 也叫「今日總覽」，但 `end: true` 讓它在 `/today` 不會亮），
> `findByRole("link", { name: "今日總覽" })` 找到的是 `to="/"` 那個
> 未啟用的連結。驗證後已改回 `{ to: "/", label: "記一餐", end: true }`
> 與 `{ to: "/today", label: "今日總覽" }`。

### 一個容易漏的地方

`TabBar` 的 `end` 屬性：現在 `/` 那格是 `{ to: "/", end: true }`。
換成 `/` = 記一餐之後，`end` 仍然要留在 `/` 那一格（不是跟著「今日總覽」
這個標籤走）。**計畫一 Task 3 實測過：`end` 對 `to="/"` 在 react-router 8
其實是無作用的保險**（NavLink 對 `to="/"` 有內建特例），但留著表達意圖。

### 跟計畫不一致 / 執行中額外發現的事（2026-09-26）

**1. 受影響的檔案比計畫列的多得多。** 計畫原文只點名
`e2e/auth.spec.ts`、`e2e/daily-loop.spec.ts`、`e2e/trend.spec.ts`、
`tests/app.test.tsx`。實際跑出來，路由對調（`/` 今日總覽→記一餐、
`/log`→`/today`）牽動了**每一支會經過首頁、或直接斷言「今日總覽」/
「記一餐」的 E2E**：

- `e2e/admin.spec.ts`（第三條測試的落地頁斷言）
- `e2e/foods.spec.ts`（要先切到 `/today` 才讀得到基準熱量）
- `e2e/mobile-form-zoom.spec.ts`（`login()` 的落地頁斷言、`/supplements`
  測試要先切到今日總覽才看得到「新增補劑」入口）
- `e2e/photo-and-limits.spec.ts`（`meal-photo-*` 這個 testid 在
  `/today` 上，登入後不再直接可見）
- `e2e/supplements.spec.ts`（同樣要先切到 `/today`）
- `tests/tab-bar.test.tsx`（`/log` 這個路徑已經不存在，原本守在那裡的
  「不要自己拿 useLocation 比字串」測試改守 `/today`）

跑 vitest 只紅了一條（`tests/tab-bar.test.tsx`），因為 vitest 完全不
碰路由以外的 E2E 斷言；上面這一長串是跑 `npx playwright test` 之後才
浮出來的，跟計畫寫「已知會受影響的」清單的落差本身就是這個 task 標題
說的「實際情況以你跑出來的為準」。

**2. `tests/app.test.tsx` 沒有紅，但那是因為斷言寫得太弱，不是行為沒變。**
「有 token 時顯示今日總覽，而不是登入畫面」原本只斷言
`queryByRole("heading", { name: "登入" })` 不存在——首頁換成記一餐之後
這個斷言照樣成立（登入畫面確實不見了），所以這條測試**不會自動變
紅**。但它的標題與意圖已經跟實際行為脫節（首頁現在顯示的是記一餐，
不是今日總覽）。已經把標題改成「有 token 時顯示記一餐（首頁），而不是
登入畫面」，並加一行 `getByRole("heading", { name: "記一餐" })` 的正面
斷言——這樣行為的意圖有被真的驗到，而不是巧合地綠。

**3. 一個計畫完全沒預料到的競態：首頁與食物庫共用「搜尋食物」這個可
存取名稱，會讓既有的「食物庫」E2E 出現機率性逾時，而且訊息會指向
錯誤的地方。** 這是這個 task 唯一真正花時間除錯的地方，記錄如下：

`e2e/admin.spec.ts` 的「駁回」測試在改完路由之後，Playwright 連跑
15 條裡穩定紅一條，逾時等 `getByRole('link', { name: foodName })`：
```
Error: locator.click: Test ended.
Call log:
  - waiting for getByRole('link', { name: 'E2E 全域食物駁回 ...' })
```
訊息看起來像是「食物庫的搜尋壞了、或者食物沒建成功」。**追下去發現
完全是另一回事：** 測試的寫法是 `login()`（落地在首頁）→ 立刻點
「食物庫」連結 → **不等任何同步訊號** → 立刻 `getByLabel("搜尋食物")
.fill(foodName)`。這個寫法在改路由之前一直是安全的，因為舊首頁
（`Today`）畫面上沒有任何叫「搜尋食物」的欄位——Playwright 的
`getByLabel` 自動等待機制因此**別無選擇，只能等到食物庫真的掛載完成**
才找得到目標，行為正確純屬「首頁沒有同名元素」這個巧合。

**首頁換成記一餐之後，這個巧合消失了**：`LogMeal.tsx` 自己也有一個
`<label htmlFor="food-search-input">搜尋食物</label>`（記一餐的食物
搜尋框）。點下「食物庫」連結之後，react-router 的路由切換不是跟
`.click()` 的 resolve 同步發生的——如果 `.fill()` 在記一餐畫面卸載
完成之前就執行，`getByLabel("搜尋食物")` 會抓到**還沒被卸載的記一餐
搜尋框**、把食物名填在那裡；接著記一餐才真正卸載、食物庫掛載出一個
全新的空白搜尋框，剛剛的 `.fill()` 等於白填。後面等食物連結出現自然
永遠等不到——而逾時訊息只會說「連結找不到」，不會提示「搜尋框其實
是空的」，第一眼很容易誤判成食物庫的搜尋或建立食物本身壞了。

用 debug 腳本（直接用 Playwright API 手動重播同一個流程、印出
`inputValue()`）重現過：拿掉中間的等待、用 `browser.newContext()` +
MEMBER 登入 + 點食物庫 + 立刻填搜尋框，兩秒後讀回的 `inputValue()`
是空字串 `""`，而不是預期的搜尋字串。**跟 `e2e/trend.spec.ts` 那個
「送出就立刻點下一個連結」的坑是同一個類別**：路由/資料還在飛的時候
就跟下一步互動，而且巧合地綠太久，紅的時候訊息還指向錯地方。

**修法：** 在 `e2e/admin.spec.ts` 兩條測試裡、每一次點「食物庫」連結
之後、填「搜尋食物」之前，加一行明確等待
`getByRole("heading", { name: "食物庫" }).toBeVisible()`，強迫
Playwright 確認舊路由（記一餐）真的卸載完、食物庫真的掛載完，才開始
跟搜尋框互動。加完之後 Playwright 連跑三輪（4–6 worker 平行）全部
15/15 綠，沒有再復發。

**這個坑不會出現在計畫原本點名的 `daily-loop.spec.ts` / `trend.spec.ts`
/ `foods.spec.ts` 里**——它們要嘛不透過「食物庫」進場、要嘛在點「食物
庫」之前的畫面（`FoodDetail`、`AdminRevisions`）本來就沒有「搜尋食物」
這個標籤可以搶，所以沒有同一種巧合可以被打破。這正是為什麼計畫的
「已知會受影響的」清單沒漏到它——**這個風險是路由重排之後才第一次
成立的，寫計畫的時候它還不存在。**

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
