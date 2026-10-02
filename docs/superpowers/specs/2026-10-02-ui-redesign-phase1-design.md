# 介面改版第一階段——外觀與記錄流程

**狀態：** 設計定稿，待寫實作計畫
**日期：** 2026-10-02
**前置：** P5（記帳前後端）已上線
**參考：** 記帳 app MOZE 的視覺與操作方式（使用者指定）

---

## 1. 目標與範圍

### 1.1 為什麼要改

使用者看了上線後的記帳畫面，原話：「現在前端很醜」。實際狀況是前端**從來沒有被設計過**——
全站 115 行 CSS、12 個 class，畫面是瀏覽器預設的 HTML 樣式加一排純文字 tab bar。

使用者要的方向：**以 MOZE 那種記帳 app 為主體，飲食紀錄長在它上面**。這跟目前「首頁是記一餐、
記帳是後來加的」正好相反，所以這次會改資訊架構，不只是換皮。

### 1.2 整體拆成三個階段（各自一輪規格→計畫→實作）

| 階段 | 內容 |
|---|---|
| **第 1 階段（這份規格）** | 視覺系統、新 tab bar 與「＋」、記帳畫面（自訂鍵盤）、記一餐畫面（選填金額＋選填照片）、總覽首頁、其餘 tab 的基本落點 |
| 第 2 階段 | 報表的圖表（支出圓環圖、營養趨勢）、其餘畫面（食物庫、補劑、審核、趨勢）全面換上新外觀 |
| 第 3 階段 | 社群（P7）：看得到朋友吃什麼。以 `docs/p7-social-decisions` 分支上的草稿為輸入，重新走一次完整設計——**它會反轉「只看得到自己的資料」這個安全模型**，必須獨立處理 |

順序的理由：社群的動態牆要顯示朋友的餐點卡片。先把外觀與記一餐（含照片）做好，社群可以直接沿用，
不必做完再改一次。

### 1.3 這份規格明確不做的事

- 時間線的列可以點進去
- 記帳選日期（`spent_at` 固定是「現在」——見 §5.3）
- 鍵盤的加減運算（使用者選了「只有數字」）
- 記一餐用自訂鍵盤（金額在那裡是次要欄位）
- 深色模式的手動開關（跟隨系統）
- 圖表（第 2 階段）

---

## 2. 已經做出的決定

每一條都是使用者在 brainstorming 裡選的，mockup 存在 `.superpowers/brainstorm/`（不進版控）。

| 決定 | 選項 | 理由／使用者原話 |
|---|---|---|
| 記帳與記一餐怎麼結合 | **中間「＋」先選要記什麼** | 「吃外食選記一餐」——外食的金額在記一餐裡填 |
| 記一餐的照片 | **選填，記的當下就能拍** | 使用者原話「要能選填要不要拍照記錄」 |
| tab bar | **總覽｜報表｜＋｜飲食｜我的** | 首頁是錢與吃混合的總覽 |
| 總覽時間線的範圍 | **只顯示今天** | 更早的紀錄去報表或飲食看 |
| 主色 | **珊瑚橘**，深色模式跟隨系統 | 一半是在記吃的，暖色合適 |
| 記帳鍵盤 | **只有數字、小數點、刪除** | 加減運算的邊界情況多，真的需要再加 |
| 樣式寫法 | **CSS Modules＋全域設計變數** | Vite/Vitest 內建，不加套件；樣式會從 115 行長到上千行，需要作用域 |
| 圖示 | **`lucide-react`** | emoji 在各平台長得不一樣、不能換色 |

---

## 3. 畫面配置與路由

### 3.1 tab bar

四格加中間的「＋」：**總覽｜報表｜＋｜飲食｜我的**。

「＋」**不是一個路由**，是一顆按鈕：按下去從底部滑出 `AddSheet`，裡面兩個大按鈕「記帳」「記一餐」。

管理員的「審核」**不再佔一格**，移進「我的」。tab bar 因此對所有人都是固定的 4＋1 格——
320px 寬時每格 64px，兩個字的標籤加圖示放得下（P5 規格 §6.1 的問題是四個字的「今日總覽」）。

### 3.2 路由

| 路由 | 畫面 | 內容 |
|---|---|---|
| `/` | 總覽 | 本月支出卡、今天熱量卡、今天的時間線 |
| `/reports` | 報表 | 現有月報表（總額＋分類佔比）＋本月支出清單（可改、刪）。**沒有新增表單**——新增改走「＋」 |
| `/diet` | 飲食 | 今天的營養素、今天的餐（含照片與補傳）、今日補劑、食物庫與補劑管理的入口 |
| `/me` | 我的 | 帳號 email、登出、審核入口（管理員才看得到） |
| `/expenses/new` | 記帳 | 自訂鍵盤、分類圖示格 |
| `/meals/new` | 記一餐 | 選填金額、選填照片 |
| `/trend`、`/foods`、`/foods/new`、`/foods/:id`、`/supplements`、`/admin/revisions` | 原樣保留 | 從報表、飲食、我的進入；第 2 階段才換外觀 |

### 3.3 舊網址

手機上可能有書籤或 PWA 的舊狀態，所以舊網址要轉址，不能直接 404：

- `/today` → `/diet`
- `/expenses` → `/reports`

`/` 從「記一餐」變成「總覽」。這不需要轉址，但**行為改變了**：以前打開 app 就在記一餐，
現在要多按一次「＋」。這是使用者選了「＋ 先選」的直接代價，記下來以免被當成迴歸。

### 3.4 頂端導覽列移除

`App.tsx` 現在的 `<Nav>`（有「登出」的那一條）拿掉，登出移到「我的」。

---

## 4. 視覺系統

### 4.1 設計變數

全部放在 `frontend/src/index.css` 的 `:root`，深色模式在
`@media (prefers-color-scheme: dark)` 底下覆寫同一組名字。**元件只引用變數，不寫死色碼。**

| 變數 | 淺色 | 深色 |
|---|---|---|
| `--color-primary` | `#ff7a59` | `#ff8a6b`（深底上要提亮才看得清楚） |
| `--color-bg` | `#f6f6f8` | `#16161a` |
| `--color-surface`（卡片） | `#ffffff` | `#24242a` |
| `--color-text` | `#222222` | `#eeeeee` |
| `--color-text-muted` | `#777777` | `#999999` |
| `--color-border` | `#e5e5e5` | `#333333` |

圓角：卡片 `12px`、按鈕 `10px`、圖示正圓。間距以 `4px` 為單位。

> 實作時要用對比度工具檢查 `--color-text-muted` 在兩種背景上至少 4.5:1；
> 上表的值是 mockup 的值，不是驗證過的值。不過的話調深／調亮，並在計畫裡記下最後的數字。

### 4.2 分類的顏色與圖示

定義在 `frontend/src/api/expenses.ts`，跟 `CATEGORY_LABELS` 放在一起，型別一樣是
`Record<ExpenseCategory, …>`——後端加分類時，漏了顏色或圖示會**編譯失敗**，不是畫面上少一個圖示。

| 分類 | 色 | lucide 圖示 |
|---|---|---|
| food 飲食 | 橘 `#ff9f43` | `Utensils` |
| transport 交通 | 藍 `#54a0ff` | `Bus` |
| daily 日用 | 綠 `#1dd1a1` | `ShoppingBag` |
| entertainment 娛樂 | 紫 `#a29bfe` | `Gamepad2` |
| medical 醫療 | 紅 `#ff6b6b` | `Pill` |
| housing 居住 | 黃 `#feca57` | `House` |
| other 其他 | 灰 `#8395a7` | `Ellipsis` |

> 圖示名稱以實作時 `lucide-react` 實際匯出的名字為準（版本間有改名過），對不上就換一個意思相近的，並回報。

餐別（breakfast / lunch / dinner / snack）也各有一個圖示，用在時間線上；顏色一律用飲食的橘色。

### 4.3 數字

金額與熱量用 `font-variant-numeric: tabular-nums`，讓清單上下對齊。
記帳畫面的大字金額 `34px`；卡片上的總額 `20px`。

### 4.4 不能被改版破壞的既有規則

- **輸入框字級 ≥ 16px**（iOS Safari 自動放大，P3-C 踩過）。`index.css` 的全域規則保留，
  `e2e/mobile-form-zoom.spec.ts` 繼續守。**元件的 module CSS 不得把 `input` / `select` / `textarea` 的字級設得更小。**
- 可點區域至少 `44px` 高。
- tab bar 底部保留 `env(safe-area-inset-bottom)`。「＋」凸出 tab bar 上緣，
  `.app-main` 的底部留白要把凸出的高度一起算進去，否則會蓋住最後一列內容。

---

## 5. 各畫面與元件

### 5.1 共用元件

每個元件一個檔案、一份 module CSS、一組測試。

**`TabBar`**——四個 `NavLink`（保留 `aria-current="page"`，理由見現有 `TabBar.tsx` 的 docstring）＋中間一顆「＋」按鈕。

**`AddSheet`**——底部滑出的面板，兩個連結「記帳」（`/expenses/new`）、「記一餐」（`/meals/new`）。
要能用「關閉」按鈕、點背景、按 Esc 關掉。開著時用 `role="dialog"`＋`aria-modal="true"`＋`aria-label`。

**`CategoryIcon`**——給一個 `ExpenseCategory`，畫彩色圓形＋白色圖示。圖示加 `aria-hidden`，
旁邊一定有文字標籤（圖示本身不是唯一的資訊來源）。

**`MoneyKeypad`**——畫鍵盤，把按鍵交給一個**純函式**：

```ts
applyKey(current: string, key: KeypadKey): string
```

規則（每一條都要有測試）：

1. 只能有一個小數點；
2. 小數最多兩位，第三位直接忽略；
3. 整數最多 8 位（後端 `numeric(10,2)`）；
4. 開頭的 `0` 會被取代，不會出現 `007`；但 `0.5` 合法；
5. 空字串時按 `.` 變成 `0.`；
6. 刪除鍵刪最後一個字元，空字串時刪除不做事。

✓ 按鈕的可用條件也是純函式：`canSubmit(amount)`，空字串、`0`、`0.`、`0.00` 都是 `false`。
**判斷「是不是 0」要經過 `lib/decimal.ts`**（`decimal-containment.test.ts` 會擋下畫面裡的 `new Decimal()`）。

### 5.2 總覽 `/`

- **本月支出卡**：`useExpenseSummary(null)` 的 `total`，用 `formatMoney`。
- **今天熱量卡**：`dailyStats` 的 `actual.kcal`；有目標時顯示「／目標」與進度條，沒有目標時只顯示數字（沿用 `MacroBar` 兩層 null 的語意）。
- **今天的時間線**：見 §6.2 的合併規則。每一列：餐別或分類圖示、標題、金額或熱量。
  - 餐（無餐費）：「午餐・滷肉飯」＋熱量
  - 餐（有餐費）：「午餐・滷肉飯」＋金額，**只出現一次**
  - 支出：「捷運」（備註或分類名）＋金額
- 三塊各自處理載入中與錯誤，**一塊失敗不拖垮整頁**。
- 列不能點（§1.3）。

### 5.3 記帳 `/expenses/new`

- 版面由上而下：關閉鈕、標題、大字金額、分類圖示格（預設「飲食」）、備註、`MoneyKeypad`。
- 鍵盤一開就在，不需要先點輸入框。
- 送出 `POST /api/expenses`：`amount` 是鍵盤的字串（不經過 `Number()`）、`spent_at` 是 `new Date().toISOString()`（帶 `Z`——後端是 `AwareDatetime`，見 P5 計畫二開頭的地雷）、`note` 空白時送 `null`。
- 成功：失效 `queryKeys.expensesAll`，導回 `/`。
- 失敗：留在原畫面，**金額與分類不清掉**；`VALIDATION_ERROR` 顯示 `AMOUNT_FORMAT_ERROR`，其他顯示「記帳失敗，請再試一次」。
- 送出中 ✓ 停用。

### 5.4 記一餐 `/meals/new`

- **邏輯沿用現有 `LogMeal`**：搜尋、常吃、最近吃、份量、數量、餐別、選填金額、
  「數量錯誤不會被說成金額錯誤」（`isCostValidationError`）。只換外觀、多一個選填照片。
- 照片：`<input type="file" accept="image/*">`（iPhone 會給「拍照」與「從相簿選」）。
  選了之後顯示縮圖與「移除」。**大小檢查沿用 `api/photos.ts` 的 `MAX_PHOTO_BYTES`（10MB）與 `PhotoTooLargeError`，在選的當下就檢查**，不要等到存檔才發現。
- 存檔分兩步：
  1. `POST /api/meals`（含金額）
  2. 成功且有照片時，上傳到 `POST /api/meals/{id}/photo`（沿用 `useUploadMealPhoto`）
- **第 1 步成功、第 2 步失敗**：不算整筆失敗。顯示「這一餐已記錄，照片沒有傳上去，可以到飲食頁的那一餐補傳」，
  然後照常導回 `/`。補傳用 `MealList` 現有的功能。
- 成功：照現有 `LogMeal` 的失效清單（5 個＋`expensesAll`），有照片再加上那一餐的照片與今天的餐；導回 `/`。

### 5.5 飲食 `/diet`

現在 `Today.tsx` 的內容（營養素、`MealList`、今日補劑）換上新外觀，加上「食物庫」「補劑管理」兩個入口。
「記帳」連結**拿掉**（記帳的入口現在是「＋」）。

### 5.6 報表 `/reports`

現在的 `Expenses.tsx` 去掉新增表單，其餘保留：`MonthSummary`、可以改、刪的清單、所有錯誤處理。
加一個「營養趨勢」的入口連到 `/trend`。

### 5.7 我的 `/me`

`useMe()` 的 email、登出按鈕（呼叫 `auth/session.ts` 的 `logout()`，跟現在 `<Nav>` 做的一樣）、
管理員才看得到的「審核」入口。

---

## 6. 資料流程

### 6.1 後端：`GET /api/expenses?date=`

**這是第 1 階段唯一的後端改動。**

- 新增 `date: date | None` 查詢參數。日界線用使用者時區算，做法跟 `GET /api/meals?date=` 一樣（`app/days.py`）。
- 兩個參數都沒帶：**維持現行行為（這個月）**。報表的 `useExpenses(null)` 依賴這個行為，不能改成「今天」。
- **前端怎麼知道「今天」是哪天**：從 `GET /api/stats/daily` 的回應拿 `date`（後端用使用者時區算好的今天），
  再用它呼叫 `?date=`。前端不自己算日界線，後端也只多一個參數。
  代價是時間線的支出要等 `dailyStats` 回來才發請求（`useQuery` 的 `enabled` 依賴），可以接受。
- `date` 與 `month` 同時帶 → 422。
- 後端測試：
  - 使用者時區的日界線（例：`Asia/Taipei` 的 23:59 與隔天 00:01 落在不同天）；
  - 隔離：只拿得到自己的支出，補進 `tests/test_cross_user_isolation.py`；
  - `date` 與 `month` 同時帶回 422；
  - 沒帶參數時行為不變（既有測試應該照樣綠）。
- 改完重新產生 `frontend/src/api/schema.d.ts`（CI 的 contract job 會比對）。

### 6.2 時間線合併（純函式）

```ts
buildTimeline(meals: Meal[], expenses: Expense[]): TimelineRow[]
```

`meals` 來自既有的 `queryKeys.meals`（`GET /api/meals` 不帶 `date`，後端回使用者時區的今天）——
跟 `MealList` 共用同一份快取，不新增 key。`expenses` 來自 §6.1 的 `?date=`。

1. 支出的 `meal_id` 對得上 `meals` 裡某一餐 → 金額併進那一餐的列，那筆支出不另列。
2. 其餘支出各自一列（包括 `meal_id` 有值但那一餐不在今天清單裡的——例如跨日的邊界情況）。
3. 全部依時間（餐用 `eaten_at`、支出用 `spent_at`）由新到舊排序。

### 6.3 query key

新增 `queryKeys.expensesByDate(date: string)` → `["expenses", "day", date]`，**掛在 `["expenses"]` 底下**，
所以既有的 `invalidateQueries({ queryKey: expensesAll })`（記帳、記一餐、報表的改刪）會一起失效它，不必另外處理。
`queries.test.tsx` 要補一條前綴測試，跟 P5 計畫二的 `expensesAll 是清單與報表兩者的前綴` 同一種。

### 6.4 離線

新 key 都在 `"expenses"` 底下，跟現有的支出一樣會被持久化（`persist.ts` 的 `NOT_PERSISTED` 不變）。

---

## 7. 錯誤處理

沿用 P5 計畫二建立的規則，不重新發明：

- 讀取失敗就說失敗：`isPending` → `isError` → 空 → 有資料，**失敗不能顯示成「沒有資料」或永遠的「載入中」**。
- 送出中按鈕停用（防重複記錢）。
- `VALIDATION_ERROR` → `AMOUNT_FORMAT_ERROR`（共用常數，在 `api/expenses.ts`）。
- 記一餐的照片部分失敗見 §5.4。

---

## 8. 測試

### 8.1 單元與元件測試

- `applyKey` / `canSubmit`：§5.1 的每一條規則，各一條測試。
- `buildTimeline`：§6.2 的三條規則，各一條測試。
- 每個新畫面、新元件各有元件測試。關鍵防線一樣做**突變檢查**（故意改壞，確認測試會紅）。

### 8.2 既有測試要搬家

| 現在 | 改版後 |
|---|---|
| `tests/log-meal.test.tsx`（渲染 `<LogMeal>`） | 改測 `/meals/new` 的畫面，原有斷言全部保留，加照片相關 |
| `tests/today.test.tsx` | 改測 `/diet`；「有記帳的入口連結」那條**刪掉**，改由 tab bar／`AddSheet` 的測試守「記帳有一條進得去的路」 |
| `tests/expenses.test.tsx` | 改測 `/reports`；新增相關的測試搬到記帳畫面的測試檔 |
| `tests/tab-bar.test.tsx` | 改成新的四格＋「＋」 |
| `tests/app.test.tsx` | 路由與轉址（`/today`、`/expenses`） |

> **「有入口」這件事的測試不能在搬家過程中消失。** 這個專案已經三次蓋好後端卻沒有前端入口
> （handover §6）。「＋」→「記帳」、「＋」→「記一餐」都要有一條「拿掉就會紅」的測試。

### 8.3 e2e

`frontend/e2e/` 裡會受影響的（全部要改走新路由或新入口）：
`daily-loop`、`mobile-form-zoom`、`photo-and-limits`、`supplements`、`trend`、`foods`、`admin`、`auth`。

`mobile-form-zoom` 要掃到 `/expenses/new` 與 `/meals/new`（含照片欄位）兩個畫面。

### 8.4 自動測試看不到、上線前要人工確認

1. 深色模式的配色（手機切到深色看一次）
2. 320px 寬的版面（記帳的分類格與鍵盤、時間線、tab bar 的「＋」）
3. iPhone 實機：點記一餐的金額欄不會整頁放大；「拍照」選項真的會出現

---

## 9. 交付

一份實作計畫，每個任務一個子代理、每個任務兩階段審查（同 P5 計畫二）。

建議的任務順序：

1. 後端 `?date=`（前端要用它）＋重新產生 `schema.d.ts`
2. 設計變數、深色模式、`lucide-react`、CSS Modules 的第一個元件
3. `CategoryIcon`、`MoneyKeypad`（純函式先）
4. `TabBar`＋`AddSheet`＋路由與轉址＋`<Nav>` 移除＋「我的」
5. 記帳畫面
6. 記一餐畫面（含照片）
7. 總覽（含 `buildTimeline`）
8. 飲食、報表的落點與外觀
9. e2e 搬家

計畫要在每個任務明寫它會讓哪些既有測試失敗、怎麼搬——P5 計畫二的經驗是，**「預期紅幾條」寫錯是常態，要求實作者照實回報**。
