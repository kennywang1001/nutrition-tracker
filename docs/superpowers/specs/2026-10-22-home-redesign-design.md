# 首頁改版：總覽的熱量圓環與快速記錄、「身體與目標」頁、精簡「我的」

**狀態：** 已實作（2026-10-22，`feat/home-redesign`；跟規格不一樣的地方在計畫的「與規格的差異」，每個 task 的細節在計畫的「執行中發現的差異」）
**日期：** 2026-10-22
**分支：** `feat/home-redesign`
**前置：** 介面改版兩階段（總覽、`TabBar`／`SideNav`、`AddSheet`、`layout.ts`）、身體資料與目標（`TargetsCard`、
`WeightCard`、`BodyProfileCard`、`/weight`）、運動紀錄（`kcalBudgetOf`、`exerciseInBudgetOf`、`ExerciseBudgetSwitch`）、
營養素配餐（`LogMealRoute` 的 router state 交接）、掃條碼（`BarcodeScanEntry`／`BarcodeScanner`）、照片＋補充說明（`PhotoHintStep`）
**計畫：** `docs/superpowers/plans/2026-10-22-home-redesign.md`
**來源：** 使用者從 mockup 選了方案 B；細節交給執行者決定，這份規格記下決定與理由。

---

## 1. 範圍

### 1.1 做的事

- **總覽（`/`）**：「今天熱量」卡片換成**熱量圓環**（還能吃 N kcal／超過 N kcal／還沒有每日目標）＋三大營養素＋一行「已吃・預算」；
  下面一列**四個快速記錄**（拍照記、掃條碼、記運動、記體重）；再下面兩張小卡片並排（本月支出、體重）；時間線不變。
  電腦版兩欄：左＝圓環、快速記錄、小卡片；右＝時間線。
- **新頁「身體與目標」（`/me/health`）**：把「我的」裡的每日目標（含重算提示、運動加回開關）、體重、身體資料三張卡片**原樣搬過來**。
- **「我的」精簡**：拿掉那三張卡片，換成一張「身體與目標」入口卡片（一行摘要）。
- **「＋」選單**：多一個「記體重」，四個入口排成 2×2。
- **體重的折線圖**（使用者後來加的要求）：總覽的體重小卡片多一條最近 30 天的**迷你折線**（裝飾）；`/weight` 的圖改成真的折線圖——
  每天的紀錄連成實線（點照留、照樣有名稱），7 天平均改成淡色虛線，目標線照留。兩張圖的座標換算抽成一份共用的 `lib/weight-plot.ts`。

### 1.2 明確不做

- 分頁不變（總覽／報表／＋／飲食／我的）。報表、飲食頁、其他畫面不變（`/weight` 只改圖與圖例，見 §3.5）。
- **沒有後端改動、沒有 migration、沒有新端點**（仍是 108）。需要的數字全部來自既有的 `GET /api/stats/daily`、`GET /api/weights`、
  `GET /api/expenses/summary`。
- 不自動送出照片估算（見 D8）。不在總覽上放行內的體重表單（見 D11）。

---

## 2. 決定

| # | 決定 | 理由 |
|---|---|---|
| D1 | 身體與目標的路由是 **`/me/health`**；`/me/body`（身體資料表單）、`/me/targets`（每日目標表單）、`/weight` 照舊 | `/me/body` 已經是表單。放在 `/me` 底下：分頁的 `NavLink`（`/me` 沒有 `end`）在這一頁仍然把「我的」標成目前的分頁，未讀數字也在同一格——這一頁是「我的」的子頁。`contentWidthFor` 不用改（預設 narrow 640），只補註解與測試 |
| D2 | `/me/targets` 的手動儲存、套用建議目標、`/me/body` 的儲存，**導回 `/me/health`**（原本是 `/me`） | 三張卡片搬到身體與目標之後，入口在那裡；存好回到「我的」等於回到一個看不到剛改的值的頁面 |
| D3 | 圓環的數字：`kcalBalance(額度, 實際)`（`lib/decimal.ts` 新增）＝`額度 − 實際` **先**四捨五入到整數（half-up，遠離 0）再看正負：負的＝「超過 \|差\| kcal」，其他＝「還能吃 差 kcal」 | 先捨入再判斷，畫面上不會出現「超過 0 kcal」；`-0.4` 是「還能吃 0」。額度一律經過 `kcalBudgetOf`（舊快取退回目標）|
| D4 | 圓環的幾何在 TS 算：`ratioOf(實際, 額度)`（已經是 number）夾在 [0, 1]，`stroke-dasharray = 弧長 圓周`。超過時畫滿。整個 `<svg aria-hidden>`；數字是圓環中間的 HTML 文字 | 跟 `TrendChart`／`WeightChart` 一樣：Decimal 字串只經過 `lib/decimal.ts`，`number` 只用在座標。圓環是裝飾，資訊全在文字裡 |
| D5 | 顏色只用既有的設計變數：底圈 `--color-border`、弧 `--color-accent`、超過時弧與「超過」那行字 `--color-danger` | `--color-danger` 在 `--color-surface` 上已經由 `tests/css-tokens.test.ts` 守著 ≥ 4.5:1（淺色、深色都是）。弧是裝飾（WCAG 1.4.11 的圖形對比不適用於純裝飾），不加新的變數 |
| D6 | 三大營養素直接用 `MacroBar`（蛋白質、脂肪、碳水；實際 / 目標、百分比、進度條；目標是 null 寫「未設定」） | 飲食頁同一個元件、同一套規則（`ratioOf`、夾滿格、沒有比例不畫條） |
| D7 | 圓環卡片保留 `data-testid="today-kcal"`，**意義改變**：整張圓環卡片（含營養素）。標題 `<h2>`「今天熱量」，卡片是 `section aria-labelledby` | 既有 e2e 用它找卡片；文字格式變了，相關斷言逐條改寫（§9） |
| D8 | **拍照記**：總覽上直接放一個 `<label>`＋視覺隱藏的 `<input type=file accept="image/*" capture="environment">`。選好的 `File` 放進記憶體裡的單一暫存（`lib/quick-actions.ts`），router state 只帶一個號碼 `{quickPhoto: n}`；`LogMealRoute` 拿號碼換回檔案，交給 `LogMeal` → `AiMealPanel` 的 `initialPhoto`，一掛載就是「確認照片」卡片（焦點在卡片）。**不自動送出**：使用者看照片、選填說明、按「開始估算」 | iOS 只在使用者手勢裡開檔案選擇器：點 `<label>` 本身就是手勢，所以**一按就開相機**；導頁之後再程式化 `click()` 檔案輸入在 iOS 會被擋。`File` 不放進 history：`history.state` 會被結構化複製、Firefox 有大小上限，重新整理還會把舊照片帶回來——暫存只活在這一次載入裡（重新整理就沒了，同配餐的交接）。不自動送出：照片說明那一步是剛做好的設計（補充說明只有看到照片之後才想得到），而且每送一次算一次 AI 額度 |
| D9 | **掃條碼**：`<Link to="/meals/new" state={{quickScan: true}}>`；`LogMeal` → `FoodPicker` → `BarcodeScanEntry` 的 `startScanning`，一掛載就打開掃描層 | WebKit 的 `getUserMedia` **不要求使用者手勢**（第一次會問權限）；影片是 `muted playsInline autoPlay`，iOS 允許自動播放。打不開相機時掃描層既有的錯誤狀態照樣在（「手動輸入條碼」「從照片讀條碼」一開就有）；「取消」焦點回到記一餐的「掃條碼」，再按一次就是一個手勢。**沒有在 iOS 實機驗證**（同掃條碼的已知限制第 1 點） |
| D10 | **記運動**：連到 `/exercises/new` | 既有的表單 |
| D11 | **記體重**：連到 `/weight`，state `{weightForm: true}`；`WeightRoute`（`App.tsx`）讀一次、清掉，`Weight` 的 `focusForm` → `WeightForm` 的 `focusOnMount` | `/weight` 已經有表單、圖表與清單，存好就看得到趨勢；在總覽上放行內表單要搬一份卡片的展開／收合與焦點邏輯。程式化的 `focus()` 在 iOS 不會跳鍵盤（沒有手勢），但焦點到了、捲到了，再點一下欄位就能打 |
| D12 | 兩張小卡片：**本月支出**（字樣照舊「本月支出」，整張的內容是連到 `/reports` 的連結）、**體重**（`data-testid="weight-glance"`；最新一筆「79 公斤」＋「比 7 天前 -0.4 公斤」，連到 `/weight`；沒有紀錄：「記錄體重」，跟 D11 同一個去處與 state） | 「比 7 天前」用 `lib/weights.ts` 的 `weekChange`／`signedKg`，跟體重卡片同一套 |
| D13 | 「我的」的入口卡片：連結「身體與目標」（44px、右邊 `ChevronRight` 是 `aria-hidden`）＋下面一行摘要（**在連結外面**，用 `aria-describedby` 唸），`data-testid="body-hub-entry"` | 摘要放在連結裡會併進可及名稱（handover §7「`aria-hidden` 與可及名稱」）——名稱跟著資料變，`exact: true` 對不上 |
| D14 | 入口卡片的摘要：「2110 kcal・79 公斤」（目標的熱量用 `roundForDisplay(…, 0)`、最新體重用 `formatMacro`）；只有一個就只寫那一個；都沒有「還沒設定」；還在載入「載入中…」 | 讀 `useDailyStats`（`target.kcal`，不是額度——這裡講的是「目標」）與 `useWeights`，跟搬走的卡片同一個快取 |
| D15 | 「我的」的順序：通知 → 身體與目標 → 帳號 → 好友 → 匯出 → （管理員）審核、邀請、所有帳號 → 重新整理 → 登出 | 通知仍是第一張（分頁上的數字把人帶來）。「重新整理」那張是 `e2e/auth.spec.ts` 驗證自動換票的路徑，照留 |
| D16 | 身體與目標的順序：每日目標（重算提示、`ExerciseBudgetSwitch`）→ 體重 → 身體資料；`h1`「身體與目標」 | 每天會碰的在上面；建議目標由身體資料算，但身體資料最少改 |
| D17 | 「＋」：記帳、記一餐、記運動、**記體重**（DOM 順序＝焦點順序＝2×2 由左到右、由上到下）；記體重的徽章色 `WEIGHT_COLOR`（`IconBadge.tsx`，`CATEGORY_COLORS.transport` 的藍）、圖示 lucide `Weight` | 四個顏色互不相同（記帳 `--color-action`、記一餐 food 橘、記運動綠）；體重不出現在時間線上，不會跟交通的支出列混淆 |
| D18 | 總覽的快速記錄四顆的可及名稱照設計：「拍照記」「掃條碼」「記運動」「記體重」——**跟「＋」選單同名**的兩個（記運動、記體重）在測試裡一律**限定在 `dialog` 裡**找 | 同名對使用者沒有問題（對話框是 `aria-modal`）；但 testing-library 與 Playwright 的 `getByRole` 不看 `aria-modal`，「＋」開著時總覽的同名連結也找得到 |
| D19 | 顯示的捨入：已吃、預算、含運動都 `roundForDisplay(…, 0)`；「還能吃／超過」是 D3 的整數 | 「已吃 732.5」對整數的額度沒有意義。已吃與預算各自捨入，兩數相減可能跟「超過 N」差 1（額度有小數時）；實際的額度都是整數（目標的熱量、運動的估算都是整數），接受 |
| D20 | 沒有每日目標（`kcalBudgetOf` 是 null：沒有目標或熱量沒設）：圓環只有底圈、中間「已吃 N kcal」，下面「還沒有每日目標」＋連結「設定每日目標」到 **`/me/targets`** | 直接到表單（建議目標也在那一頁），不繞身體與目標 |
| D21 | 體重圖的座標換算抽成 **`lib/weight-plot.ts`**：`weightScale(values, pad, start, end, area)`（`paddedExtent` 定 y 範圍、`positionIn` 換比例、`daysBetween` 照日期排 x）與 `polylinePoints(points, scale)`。`WeightChart` 改用它（**座標逐一不變**，既有的 `weight-chart.test.tsx` 不改就要綠）；迷你折線也用它 | 原本這段數學寫在 `WeightChart` 的元件裡（`x`、`y` 兩個閉包）。複製一份給迷你折線會有兩套「照日期排」的寫法；抽出來後兩張圖的 x 一定照日期、y 一定經過 `lib/decimal.ts` |
| D22 | **迷你折線**（`components/WeightSparkline.tsx`，`data-testid="weight-sparkline"`）：最近 30 天（`entriesInSpan(entries, today, 30)`，`today` 是 `GET /api/weights` 回的）的紀錄連成一條 `<polyline>`；**少於 2 筆不畫**（只有字）。`<svg aria-hidden>`、`viewBox="0 0 100 32"`、`preserveAspectRatio="none"`＋`vector-effect: non-scaling-stroke`，寬 100%、高 32px。x 從**這 30 天裡第一筆到最後一筆**（不是從 30 天前），y 範圍各往外 0.5 公斤 | 裝飾：最新一筆與比 7 天前照樣是文字（D12）。390px 寬時小卡片的內容寬約 140px，寬度跟著卡片走、高度固定；拉伸不會讓線變粗（`non-scaling-stroke`）。x 從第一筆開始：只記了最近幾天時，線不會擠在右邊一小段；它不是軸，沒有刻度可以對 |
| D23 | 迷你折線的資料**沿用 `useWeights()`**（同一個 `["body","weights"]`，最近 800 天，進離線快取），在前端篩最近 30 天；**不加新的 query key** | 總覽的小卡片本來就讀這個 query（D12），不多一個請求。另開一個 30 天的 key 等於同一份資料在快取與 localStorage 裡存兩份，記體重之後還要多失效一個（`invalidateBody` 失效的是整個 `["body"]`，前綴蓋得到，但沒有必要）。離線時看到的是快取裡的線，跟總覽頂端的離線提示一致（`OfflineBanner` 已經算它） |
| D24 | **`/weight` 的折線圖**：範圍內每天的紀錄照日期連成**實線**（`data-testid="weight-line"`，`.weight-line`，強調色、2px），點照留（`role="img"`、名稱「10/12，79 公斤」，畫在線的上面）；7 天平均改成**淡色虛線**（`.weight-average`：`stroke-dasharray`、`opacity`，顏色不變）；目標線不變。圖例：「每天的紀錄」（實線＋點的色塊）、「7 天平均」（虛線的色塊）。**沒記的日子照樣連起來**：x 照日期，中間空幾天線就跨過那一段，不斷開、不補 0 | 「折線」是使用者要的；點保留是因為點的名稱是螢幕閱讀器讀得到的資料。平均改虛線：兩條線同時在圖上，實線是真的紀錄、虛線是算出來的。斷開缺的日子要另一套規則（多久算斷？），而 x 已經照日期，跨過的那一段本身就看得出中間沒有點 |

### 與原始決定的差異

1. **路由**：原始建議 `/body`（或 `/me/body`）。`/me/body` 是表單；`/body` 不在 `/me` 底下，「我的」分頁在那一頁不會亮。改用 `/me/health`（D1）。
2. **拍照記「立刻估算」**：改成一按開相機、拍完到記一餐的「確認照片」卡片，再按「開始估算」（D8）。照片說明那一步與 AI 額度的理由見 D8。
3. **拍照記只開相機**：`capture="environment"` 在 iOS 直接開相機，不給「從相簿選」；要從相簿選，用記一餐裡原本的「拍照估算」。
4. **記體重**：不在總覽上行內展開，到 `/weight` 並把焦點放在體重欄位（D11）。
5. **小卡片的字樣**：「本月花費」照舊寫「本月支出」（既有的字、測試與 e2e 都用它）。
6. **「我的」的順序**：邀請（`InviteFriends`）照舊在管理員那一組（審核 → 邀請 → 所有帳號），不搬到好友旁邊；另外保留「重新整理」卡片（D15）。
7. **存好之後的去處**：目標、身體資料、套用建議導回身體與目標，不再是「我的」（D2）。
8. **`today-kcal` 的文字**：「1240 / 2000 kcal」「含運動 +343」換成「還能吃 760 kcal」「已吃 1240・預算 2000」「（含運動 +343）」；
   「熱量進度」那條 `progressbar` 拿掉（圓環是裝飾、不是 progressbar）。受影響的斷言逐條列在 §9。
9. **迷你折線的 x 範圍**：要求是「最近 30 天的紀錄」——資料照這個篩，但 x 從這 30 天裡的第一筆畫到最後一筆，不從 30 天前開始（D22 的理由）。
10. **迷你折線的資料**：沿用既有的 `useWeights()`（800 天）在前端篩，不加 30 天的 query key（D23）。

---

## 3. 總覽

### 3.1 版面

```
總覽
[通知][離線提示]
┌ 今天熱量 ───────────────────────────┐   ← section，data-testid="today-kcal"
│  ◯ 還能吃        蛋白質   60 / 120  50% ▬▬
│    843          脂肪     45   未設定
│    kcal         碳水    180 / 250  72% ▬▬
│  已吃 1500・預算 2343（含運動 +343）
└────────────────────────────────────┘
[📷 拍照記][▦ 掃條碼][🏃 記運動][⚖ 記體重]     ← ul aria-label="快速記錄"，4 欄
[本月支出 $12480.00 ][體重 79 公斤 比 7 天前 -0.4 公斤]   ← 2 欄
今天
[時間線]
```

- 手機：上面這個順序往下排（DOM 順序）。圓環（132px）與營養素同一列；寬度不夠時（< 約 340px）營養素換到圓環下面（`flex-wrap`）。
- 電腦版（`app-desktop`）：`layout.columns` 的左欄＝圓環卡片、快速記錄、小卡片（**兩欄並排**，拿掉原本「電腦版上下疊」的覆寫——左欄約 420px，
  兩張各約 200px 放得下）；右欄＝時間線。

### 3.2 圓環的狀態

| 狀態 | 條件 | 圓環 | 中間 | 下面 |
|---|---|---|---|---|
| 載入中 | `stats` pending | 不畫 | — | 「載入中…」 |
| 讀不到 | 失敗而且沒有資料 | 不畫 | — | 「無法載入今天的熱量」 |
| 一般 | 有額度、`kcalBalance` 不是 over | 底圈＋弧（accent），弧長＝`min(ratio, 1)` | 「還能吃」N「kcal」 | 已吃・預算（含運動） |
| 剛好吃滿 | 差捨入後是 0 | 弧幾乎滿 | 「還能吃」0「kcal」 | 同上 |
| 超過 | `kcalBalance.over` | 整圈（danger），`data-tone="over"` | 「超過」N「kcal」（danger） | 同上 |
| 沒有目標 | `kcalBudgetOf` 是 null | 只有底圈 | 「已吃」N「kcal」 | 「還沒有每日目標」＋「設定每日目標」→ `/me/targets` |

- 營養素在「一般／剛好／超過／沒有目標」四種狀態都畫（沒有目標時三列都是「未設定」）。
- 有資料但重抓失敗：照樣顯示資料，離線提示由總覽頂端那一條負責（`OfflineBanner` 不變，多看一個 `useWeights`，見 §3.4）。

### 3.3 例子（e2e 用的那一組）

目標：熱量 2000、蛋白質 120、碳水 250、脂肪不設；今天手動記一筆運動 343 kcal、「運動消耗加回」開著（預設）；
吃了一餐：每 100 g 500 kcal／蛋白質 20／脂肪 15／碳水 60 的便當 300 g。

- 額度 `kcal_budget` = 2000 + 343 = **2343**；實際 = 500 × 3 = **1500**。
- `kcalBalance("2343.00", "1500.00")` = 843 → **還能吃 843 kcal**。
- `ratioOf("1500.00", "2343.00")` = 0.640204…；圓周 = 2π × 55 = 345.58；弧長 = 221.24 → `stroke-dasharray="221.24 345.58"`。
- 下面：**已吃 1500・預算 2343（含運動 +343）**。
- 營養素：蛋白質 **60 / 120** 50%、脂肪 **45** 未設定、碳水 **180 / 250** 72%。
- 再記同一個便當 200 g（+1000）：實際 2500，差 −157 → **超過 157 kcal**，整圈 danger；下面「已吃 2500・預算 2343（含運動 +343）」。

捨入的邊界（單元測試）：`kcalBalance("2343", "1523.4")` = 還能吃 820；`("700", "732.5")` = 超過 33（−32.5 遠離 0）；
`("2000", "2000.4")` = 還能吃 0（不是超過 0）。

### 3.4 小卡片

- **本月支出**（`data-testid="month-spend"`，不變）：標籤＋金額；金額那一塊是 `<Link to="/reports">`（44px 以上）。讀不到、載入中照舊。
- **體重**（`data-testid="weight-glance"`）：`useWeights()`（同 `["body","weights"]`）。有紀錄：`<Link to="/weight">` 裡「79 公斤」＋（有的話）
  「比 7 天前 -0.4 公斤」；沒有紀錄：`<Link to="/weight" state={WEIGHT_FORM_STATE}>`「記錄體重」；載入中「載入中…」；讀不到「無法載入體重」＋連到 `/weight`。
  有紀錄時，字的下面是迷你折線（D22）：最近 30 天有 2 筆以上才畫。
- `OfflineBanner` 多算 `useWeights()`：體重重抓失敗而手上有資料也是「離線資料」。

### 3.5 `/weight` 的折線圖（D21、D24）

```
81 ┤
   │   ●───╮                     ← 實線＋點：每天的紀錄（點有名稱）
   │ ┄┄┄┄┄┄╰──●┄┄┄┄┄┄┄┄●         ← 淡色虛線：7 天平均
   │               ╲────╱
77 ┤─────────────────────────    ← 目標線（照舊）
   10/1                   今天
```

- 畫的順序（後畫的在上面）：底線 → 目標線 → 平均（虛線）→ 每天的線（實線）→ 點。
- 範圍內只有一筆：沒有線，只有那一點（跟現在一樣）。平均線照現在的規則（範圍內那幾天的平均，可以用到範圍外的紀錄）。
- 線是 `aria-hidden`（同平均線）：資料在點的名稱與圖下面的「最近 7 天平均」「目標」兩行字裡。
- 圖例：`[實線＋點] 每天的紀錄  [虛線] 7 天平均`；色塊是裝飾（`aria-hidden`），字本身就說了。

---

## 4. 快速記錄

| 按鈕 | 元素 | 去處 | 交接 |
|---|---|---|---|
| 📷 拍照記 | `<label for>`＋視覺隱藏的 `<input type=file accept="image/*" capture="environment">`（名稱「拍照記」） | `navigate("/meals/new", { state: stashQuickPhoto(file) })` | `{quickPhoto: n}`；`quickPhotoFrom(state)` 號碼對得上才回 `File`；`LogMealRoute` 讀完、清 history 的 state 時 `releaseQuickPhoto()` |
| ▦ 掃條碼 | `<Link>` | `/meals/new` | `SCAN_STATE = {quickScan: true}`；`quickScanFrom(state)` |
| 🏃 記運動 | `<Link>` | `/exercises/new` | 無 |
| ⚖ 記體重 | `<Link>` | `/weight` | `WEIGHT_FORM_STATE = {weightForm: true}`；`weightFormFrom(state)` |

- 全部在 `lib/quick-actions.ts`（router state 的形狀、暫存）。形狀不對＝沒有（同 `plannerHandoffFrom`）。
- 照片太大：不在總覽擋——交給 `AiMealPanel` 既有的「選的當下就擋」（`pickError`，記一餐上顯示「照片太大…」，不出卡片）。
- 拍照記的「確認照片」卡片：同 `AiMealPanel` 的照片路徑（`pending`、`focusNextRef = "step"`、`focusStepAfterFileDialog`）；「取消」焦點回到記一餐的「拍照估算」。
- 掃條碼：`BarcodeScanEntry` 的 `scanning` 初值是 `startScanning === true`；掃描層自己把焦點放在「取消」。命中、沒命中、取消都照既有的流程；
  「用這個條碼建立食物」去新增食物、回來時 state 是 `{pickedFood}`，不會再打開掃描層。
- 交接只在掛載時讀一次、`replace` 清掉 history 的 state：上一頁、重新整理都不會再開相機或再帶照片。
- 每顆 ≥ 44px（實際約 72px：徽章＋兩到三個字），四欄 `repeat(4, minmax(0, 1fr))`；390px 寬每格約 80px。
  照片那顆的焦點外框畫在 `<label>` 上（`:has(+ input:focus-visible)`，同 `PhotoPickerButton`）。

---

## 5. 身體與目標（`/me/health`）

- `screens/BodyHub.tsx`：`<section>`、`<h1>身體與目標</h1>`、`TargetsCard`、`WeightCard`、`BodyProfileCard`——**卡片本身不改**（只改註解裡的「我的」）。
- 寬度 narrow（640，`contentWidthFor` 的預設）。手機有分頁列（「我的」亮著）；回上一頁用瀏覽器或分頁。
- 三張卡片的查詢、離線快取、重算提示、開關的行為完全不變；`useTargetSuggestion` 只在這一頁打（「我的」不再打）。

---

## 6. 我的

- 拿掉 `TargetsCard`、`BodyProfileCard`、`WeightCard`；在通知後面加 `BodyHubEntry`（`components/BodyHubEntry.tsx`）。
- 「我的」仍然打 `/api/stats/daily` 與 `/api/weights`（摘要用），不再打 `/api/me/body-profile`、`/api/me/target-suggestion`。

---

## 7. 「＋」選單（`AddSheet`）

- 第四個 `<Link to="/weight" state={WEIGHT_FORM_STATE}>` 記體重，`onClick={onNavigate}`。
- `.choices` 改 `repeat(2, minmax(0, 1fr))`；焦點一打開仍在第一個（記帳）；Tab 順序＝DOM 順序。電腦版的對話框照舊最寬 400px、置中。

---

## 8. 無障礙

- 圓環 `<svg aria-hidden="true" focusable="false">`；數字是文字。中間那一塊是一個 `<p>`，三段 `<span>` 之間有空白（唸成「還能吃 843 kcal」）。
- 圓環卡片 `section aria-labelledby` →「今天熱量」（`h2`，`ui.sectionTitle`）；`region` 名稱跟時間線的「今天」不同。
- 「超過」不只靠顏色：字就是「超過」。
- 快速記錄是 `<ul aria-label="快速記錄">`；徽章 `aria-hidden`，名稱只有字。
- 入口卡片：連結名稱固定「身體與目標」，摘要用 `aria-describedby`（D13）。
- 拍照記的檔案輸入不用 `display:none`（鍵盤要能對焦），Playwright 會把它算成 1px 的 button——量觸控高度量 `<label>`（handover §7）。
- 記體重到 `/weight` 焦點在「體重（公斤）」；掃條碼的掃描層焦點在「取消」；拍照記焦點在「確認照片」卡片。

---

## 9. 測試與 e2e 的影響

### 9.1 要改的既有單元測試

| 檔案 | 改什麼 | 怎麼不變弱 |
|---|---|---|
| `tests/overview.test.tsx` | `mockOverview` 多 `/api/weights`；「顯示本月支出與今天熱量」改看「還能吃 760 kcal」；「有目標時畫熱量進度條」改成圓環（`calorie-ring-arc` 存在、`aria-hidden`）；兩格「沒有目標」改看「還沒有每日目標」＋連結；運動那三條的「/ 2343 kcal」改「預算 2343」「（含運動 +343）」，進度條的比例改看 `stroke-dasharray` | 每一條原本守的事（分母是額度、含運動只在設定開時、舊回應退回目標、沒有目標不畫比例）照樣守，只換成新的字 |
| `tests/me.test.tsx` | 「每日目標卡片的重算提示」「每日目標卡片」「身體資料卡片」「體重卡片」四組**整組搬到** `tests/body-hub.test.tsx`（`<Me />` → `<BodyHub />`）；兩條「順序」改成身體與目標裡的順序；新增入口卡片的幾條、「我的」沒有那三張卡片 | 搬，不刪；斷言逐字保留 |
| `tests/exercise-budget-switch.test.tsx` | `<Me />` → `<BodyHub />` | 同上 |
| `tests/targets.test.tsx`、`target-suggestion.test.tsx`、`body-profile.test.tsx` | 存好之後的路由 `/me` → `/me/health`（測試裡的假路由與標題） | 斷言「導到哪裡」照樣在，只換路徑 |
| `tests/tab-bar.test.tsx`、`side-nav.test.tsx` | 面板的連結 `["記帳","記一餐","記運動"]` → 四個；記體重連到 `/weight`、點了面板關掉 | 多一條 |
| `tests/app.test.tsx` | 「從『＋』點『記運動』」的連結改在 `dialog` 裡找（D18） | 範圍變小，不是變鬆 |
| `tests/layout.test.ts` | `/me/health` 是 narrow | 新增 |
| `tests/log-meal-ai.test.tsx`、`log-meal-barcode.test.tsx`、`weight.test.tsx`、`decimal.test.ts` | 新的 props／函式的測試 | 新增 |
| `tests/weight-chart.test.tsx` | **既有的 7 條一個字都不改**（D21 的抽取是純重構，座標逐一不變）；加「每天的線：點的順序與座標＝每個點的 `cx`／`cy`」「跨過沒記的日子（x 照日期）」「只有一筆沒有線」「線與平均都是 `aria-hidden`、平均有 `weight-average` 的 class」 | 新增 |
| `tests/weight.test.tsx` | 圖例的兩段字（「每天的紀錄」「7 天平均」）；切期間之後線只連範圍內的點 | 新增 |
| `tests/overview.test.tsx` | 體重小卡片：2 筆以上有 `weight-sparkline`、0／1 筆沒有、30 天以前的不畫進去 | 新增 |
| `tests/invite-friends.test.tsx` | 不用改（掛 `<Me />`，路由清單多出來的不影響）；跑一次確認 | — |

新的測試檔：`tests/calorie-ring.test.tsx`、`budget-summary.test.tsx`、`quick-actions.test.ts`、`body-hub.test.tsx`、`weight-plot.test.ts`、`weight-sparkline.test.tsx`。

### 9.2 要改的既有 e2e

| spec | 改什麼 |
|---|---|
| `account-settings.spec.ts`（第一條） | 「我的」→ 點「身體與目標」→「修改每日目標」；存好之後的標題「身體與目標」；`today-kcal` 的「/ N kcal」→「預算 N」 |
| `body-targets.spec.ts`（三條） | `openMe` → `openHub`（我的 → 身體與目標）；存好、套用之後等「身體與目標」的標題（四處）；`today-kcal` 的「/ N kcal」→「預算 N」；第三條最後多看總覽的 `weight-glance`「比 7 天前 -0.4 公斤」與迷你折線；第三條（`/weight` 記四天）多看 `weight-line` 一條、它的點數＝範圍內的點數、平均線的 `stroke-dasharray` 不是 `none`（`getComputedStyle`） |
| `exercise.spec.ts` | `openMe` → `openHub`；手動存目標之後的標題；`openAddExercise` 的「記運動」限定在 `dialog`；`today-kcal` 的五處：「/ 2343」→「預算 2343」、「含運動 +N」→「（含運動 +N）」、「/ 2000」→「預算 2000」 |
| `planner.spec.ts` | `today-kcal`「732.5 / 700 kcal」→「已吃 733・預算 700」＋「超過 33 kcal」；精度（白飯照份量算 300 g）改在飲食頁的 `macro-kcal`「732.5 / 700」守 |

只會重跑、不用改的（會走過「我的」或總覽）：`auth`、`admin`、`friends`、`social`、`invites`、`reports-export`、`money-loop`、`daily-loop`、
`desktop-layout`、`touch-targets`、`trend`、`edit-meal`、`foods`、`portions`、`supplements`、`ai-*`、`barcode`。

### 9.3 新的 e2e：`e2e/home.spec.ts`

1. **圓環的數字**（手機）：新帳號，API 設目標（2000／120／null／250）、記一筆手動運動 343、建便當食物、記 300 g → 登入 →「還能吃 843 kcal」「已吃 1500・預算 2343（含運動 +343）」、營養素三列、`data-tone="normal"`；
   API 先記兩天體重（今天 − 3 天 80、今天 79.4）→ 體重小卡片「79.4 公斤」、`weight-sparkline` 在、折線兩個點 →
   「＋」→ 記一餐 → 便當 200 g → 回總覽「超過 157 kcal」、`data-tone="over"`。
2. **沒有目標**：新帳號 →「已吃 0 kcal」「還沒有每日目標」、沒有體重所以沒有 `weight-sparkline` →「設定每日目標」→ 每日目標頁。
3. **快速記錄**（手機，只假造 `POST /api/ai/analyze-meal`）：四顆 ≥ 44px；拍照記（`capture="environment"`）→ 記一餐的「確認照片」卡片有焦點 →「開始估算」→ 結果；
   總覽 → 掃條碼 → 掃描層打開 →「取消」→ 焦點在「掃條碼」；總覽 → 記運動 → 表單；總覽 → 記體重 → 體重欄位有焦點 → 存 70 → 總覽的 `weight-glance`「70 公斤」、只有一筆所以沒有迷你折線；
   「＋」四個入口、記體重到 `/weight`。
4. **身體與目標與精簡的「我的」**（電腦版預設尺寸）：「我的」沒有三張卡片、入口摘要「還沒設定」→ 身體與目標三張卡片的順序 → 記體重 79 → 改目標 2110 → 回到身體與目標 →「我的」的摘要「2110 kcal・79 公斤」。
5. **電腦版版面**（1280×800）：圓環卡片、快速記錄、小卡片都在時間線的左邊；兩張小卡片並排。

---

## 10. 交付

- 前端：`lib/decimal.ts`（`kcalBalance`）、`lib/quick-actions.ts`（新）、`lib/weight-plot.ts`（新）、`components/{CalorieRing,BudgetSummary,QuickActions,WeightSparkline,BodyHubEntry}.{tsx,module.css}`（新）、
  `components/WeightChart.tsx`、`screens/Weight.{tsx,module.css}`、`index.css`（`.weight-line`、`.weight-average` 的虛線）、
  `screens/BodyHub.tsx`（新）、`screens/{Overview,Me,LogMeal,Weight,Targets,BodyProfile}.tsx`、`components/{AiMealPanel,FoodPicker,BarcodeScanEntry,TargetSuggestion,AddSheet,IconBadge}.tsx`、
  `AddSheet.module.css`、`Overview.module.css`、`App.tsx`（`/me/health`、`WeightRoute`、`LogMealRoute`）、`lib/layout.ts`（註解）。
- 測試：§9 的表；e2e 全套跑兩次。
- 截圖：390×844 與 1280×800，淺色與深色——總覽的三種圓環（一般、超過、沒有目標；一般那張要有迷你折線）、身體與目標、「我的」、`/weight`（四筆以上：實線、虛線、點、圖例）。
- 文件：`docs/handover.md`（新的一節、量到的數字、已知限制、§7 新的坑）；這份規格與計畫的「執行中發現的差異」。
- **已知限制（先寫下來的）**：iOS 實機沒有驗證拍照記與掃條碼的自動開相機；拍照記只能拍、不能從相簿選；記一餐重新整理會失去帶進來的照片；
  記體重在 iOS 不會自動跳鍵盤；已吃與預算各自捨入，額度有小數時跟「超過 N」可能差 1；體重的線跨過沒記的日子（不斷開）；迷你折線沒有刻度，只看得出方向。

## 11. 審查後的修正（2026-10-22）

| # | 問題 | 修法 |
|---|---|---|
| M1 | 已經在 `/weight` 時從「＋」點「記體重」：路由不重掛，「要不要搶焦點」只在掛上時讀過一次，表單沒拿到焦點，面板一關焦點掉到 body | `WeightRoute` 記下是哪一次 navigation 要的焦點（`location.key`），用它當 `Weight` 的 key 重掛；`replace` 清 state 那一次 state 是 null、不算數 |
| M2 | 總覽的體重小卡只寫「79 公斤 比 7 天前 −1」：兩個月沒量的人看到的像今天的數字 | 最新一筆不是今天就帶日期（「79 公斤・8/8」，同身體與目標頁的體重卡片）；今天的不帶 |

審查提到、刻意不改：從總覽的「設定每日目標」存好之後回到「身體與目標」（我的分頁）而不是總覽——D2 與 D20 合起來的結果，存目標的人通常也會想看建議與體重。
