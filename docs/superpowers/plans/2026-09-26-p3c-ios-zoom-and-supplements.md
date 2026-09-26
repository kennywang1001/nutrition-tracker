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

- [ ] **Step 1: 先寫守衛（這次真的先寫，而且它現在就該紅）**

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

- [ ] **Step 2: 跑它，確認它現在就紅**

```bash
cd F:/wallet && docker compose up -d
cd F:/wallet/frontend && npx playwright test e2e/mobile-form-zoom.spec.ts --reporter=list
```

**這一步跟前幾份計畫不同：這條測試在寫實作之前就該紅**，因為缺陷現在真的存在。
如果它一開始就綠，**停下來報告** —— 代表斷言沒抓到東西。

- [ ] **Step 3: 修**

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

- [ ] **Step 4: 跑守衛，確認它綠**

- [ ] **Step 5: 突變驗證**

> **必須成立：** 把 `font-size: 16px` 改成 `15px`，Step 1 那條測試必須紅，
> 而且訊息要指出是哪一個控制項、實際幾 px。
>
> **實測填回：** ——

- [ ] **Step 6: 全套驗證與 commit**

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

- [ ] **Step 1: query key 與資料層**

`queryKeys` 加（`supplementsToday` 已經存在，不要重複）：

```ts
supplementSearch: (q: string) => ["supplement-search", q] as const,
```

> **獨立命名空間**，理由跟 `food-search` 一樣（`api/queries.ts` 裡有那段註解）。
> **而且它也不該進離線持久化** —— 去看 `api/persist.ts` 的 `NOT_PERSISTED`，
> 判斷要不要把它加進去，並在報告裡說明你的判斷。

`frontend/src/api/supplements.ts`：`useSupplementSearch(q)`。
形狀照 `api/foods.ts` 的 `useFoodSearch`（含 `enabled: q.trim() !== ""`
與 `encodeURIComponent`）。

- [ ] **Step 2: 寫測試**

必須成立的行為：

1. `/supplements` 列出搜尋結果；**空字串不發請求**
2. 新增補劑：body 形狀正確，**四個營養素留空時送預設的 `"0"` 而不是省略或 `null`**
   （後端有預設，但前端送什麼要是刻意的決定 —— 在註解寫明你選哪個、為什麼）
3. **「今天吃了」送出的 `plan_id` 是 `null`**，`dose` 是 `"1"`，`taken_at` 是 ISO 字串
4. 記錄成功後 `supplementsToday` 失效（今日總覽要看得到）
5. `today` 清單裡 `plan_id === null` 的項目顯示成「已記錄」而不是「待打卡」

> 第 3 條是這個 task 的核心。`plan_id` 不是 `null` 的話會變成「對某個計畫打卡」，
> 而使用者根本沒有計畫 —— 後端會怎麼回應請實測，不要假設。

- [ ] **Step 3–5: 實作、路由、Today 的入口**

`Today.tsx` 的「今日補劑」區塊加一個連到 `/supplements` 的連結。
文字自己決定，但要讓「我想加一個我在吃的補劑」的人找得到。

- [ ] **Step 6: 突變驗證**

> **必須成立：** 把「今天吃了」送出的 `plan_id` 從 `null` 改成 `1`，
> 至少一條測試紅。
>
> **實測填回：** ——

> **必須成立：** 拿掉 `supplementsToday` 的失效，至少一條測試紅。
>
> **實測填回：** ——

- [ ] **Step 7: 契約 E2E**

一條：**新增一個補劑 → 點「今天吃了」 → 今日總覽看得到它**。

用 `e2e/accounts.ts` 的 `ADMIN`。補劑名稱要帶 `Date.now()`
（`POST /api/supplements` 大概也有唯一約束，**去確認**）。

> **送出後要等存檔完成再導頁。** `e2e/trend.spec.ts` 踩過：按下送出就立刻
> 點下一個連結，請求還在飛的時候元件被卸載，單獨跑永遠綠、平行跑約一半
> 機率紅，而且紅的訊息會指向錯誤的地方。

---

## 收尾

- [ ] 把每一處「實測填回」都填上
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
