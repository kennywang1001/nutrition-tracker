# 首頁改版 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 總覽換成熱量圓環（還能吃／超過／沒有目標）＋三大營養素＋四個快速記錄＋兩張小卡片；每日目標、體重、身體資料三張卡片搬到新頁「身體與目標」（`/me/health`）；「我的」只留一張入口卡片；「＋」多一個記體重；體重小卡片多一條最近 30 天的迷你折線，`/weight` 的圖改成折線圖（實線＋點、7 天平均虛線）。

**Architecture:** 純前端，沒有後端改動。`lib/decimal.ts` 多 `kcalBalance`；新元件 `CalorieRing`（SVG，`aria-hidden`）、`BudgetSummary`（圓環＋中間的字＋`MacroBar`×3＋已吃・預算）、`QuickActions`、`BodyHubEntry`；新畫面 `BodyHub`。快速記錄的交接走 router state（`lib/quick-actions.ts`），照片本身放在記憶體裡的單一暫存、state 只帶號碼；`LogMealRoute` 把照片與「開掃描層」交給 `LogMeal`（→ `AiMealPanel` 的 `initialPhoto`、`FoodPicker`／`BarcodeScanEntry` 的 `startScanning`），新的 `WeightRoute` 把「焦點放在體重」交給 `Weight`。

**Tech Stack:** React 19 · TypeScript strict · TanStack Query v5 · react-router 8 · CSS Modules · lucide-react 1.50 · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-22-home-redesign-design.md`（以下稱「規格」；D1…D20 指它的 §2）

---

## 執行中發現的差異

（實作時每個 task 寫一小節：commit、條數、突變結果、跟計畫不一樣的地方。）

### Task 1（`1c1390f`）

- 條數照計畫：decimal 多 8 格、calorie-ring 10、budget-summary 8。整套 `Test Files 214 passed`、`Tests 3148 passed`。
- 突變 11/11。兩條跟計畫寫的不一樣：
  - **第 6 條**（`tone === "over" ? 1 : ratio` → `ratio`）**不會**紅 budget-summary 的「超過」：那一條是 2500 / 2343 > 1，
    `ringDasharray` 本來就夾到 1，對那份資料是等價突變。殺掉它的是 calorie-ring 的「超過：畫滿」（比例 0.2）。
  - **第 8 條**照寫（`stats.target?.kcal ?? null`）會讓 `kcalBudgetOf` 的 import 沒人用，tsc 的 `noUnusedLocals` 紅、工具標成 TYPE-ERROR。
    改成 `kcalBudgetOf({ ...stats, kcal_budget: null })`（同樣退回目標，型別乾淨）。第 9 條用 `exerciseInBudgetOf(stats) ?? "0"`。
- `.noTarget` 的 `margin-top: var(--space-2)` 直接寫進那一條（計畫 Step 9 的補充）。

### Task 1B（`4e236f9`）

- **重構那一步單獨跑過**：`WeightChart` 改用 `weightScale`／`polylinePoints` 之後、加線之前，`weight-chart.test.tsx` 沒改一個字就全綠；
  整個 task 結束時那個檔案的 diff 是 50 加、0 刪（只有新的 4 條）。
- 條數：weight-plot **6**（計畫 5）——多一條「y 從 `area.top` 開始算」：`WeightChart` 的 `top` 是 0，沒有它的話 `area.top +` 拿掉也不會紅
  （突變 3b 證明）。weight-chart 多 4、weight 多 2。整套 `216 passed`、`3172 passed`。
- **圖例的寫法改了**：計畫的 `getByText("每天的紀錄")` 對計畫的 markup 對不上——testing-library 把**同一個元素自己的文字節點**接起來比，
  `<p>` 的文字是「每天的紀錄7 天平均」。每一項（色塊＋字）包成一個 `.legendItem`（`inline-flex`、`nowrap`）：測試對得上，換行時色塊也不會跟字分開。
  `.swatchAverage` 的 `margin-left` 拿掉，兩項的距離由 `.legend` 的 `gap`（橫向改 `--space-4`）管。測試斷言 `daily.querySelector("span")` 是 `aria-hidden`。
- 「只有一筆：沒有線」在加線之前就是綠的（那時根本沒有線）——它守的是 `>= 2`，突變 5 證明。
- 「切期間」的資料用 7/1、9/1、10/1、10/10 四筆：30 天內要有兩筆以上才有線。
- 突變 9/9（計畫的 7 條＋3b `area.top`＋8 每天的線的 `aria-hidden`）。第 1 條（y 上下顛倒）**也紅了 weight-chart 既有的**
  「x 照日期（不是照第幾筆）、y 照體重（重的在上面）」——`WeightChart` 真的接上了共用的幾何。

### Task 2（`fb63395`、截圖修正 `9e8a9e9`）

- 條數：weight-sparkline **4**（計畫 3；多一條「x 照日期：中間那一筆在天數的比例上」）；overview 既有的照 Step 1 逐條改、新的 **10** 條
  （計畫 9；「體重」拆成「兩筆以上有迷你折線」與「只有一筆沒有」兩條）。整套 `218 passed`、`3200 passed`。
- **連結名稱的空白**：小卡片的標籤與數字之間加 `{" "}`。jsdom（dom-accessibility-api）把行內的 `<span>` 直接接起來，名稱會是「體重79 公斤比 7 天前…」；
  有空白才是「體重 79 公斤 比 7 天前 -1 公斤」「本月支出 $12480.00」「體重 記錄體重」。欄排版（flex column）裡空白不佔位置，畫面不變。
- `.label` 的 margin 改 0（`.glance` 的 `gap` 接手）；`.unit`、`.progress`、`.budgetNote` 拿掉。
- 測試檔：react-router 的 `Route` 跟 `mock-api` 的 `type Route` 撞名 → `Route as RouterRoute`；比順序的小函式叫 `precedes`
  （叫 `before` 會被 Biome 的 `noDuplicateTestHooks` 當成 vitest 的 hook）。
- 沒有體重時的 state 先寫死 `{ weightForm: true }`（註解寫明 Task 3 換成 `WEIGHT_FORM_STATE`）。
- 突變 12/12。型別過不了的寫法換掉（工具會把 tsc 的紅標成 TYPE-ERROR，不算）：第 2 條 → `weekChange([])`；第 3 條 `state={undefined}` 會讓 `empty`
  沒人用 → `!empty`；第 4 條拿掉 `weightsQuery` 也是沒人用 → `...[weightsQuery].filter(() => false)`；第 8 條 `31` 不在 `WeightSpan`（30 | 90 | "all"）
  → `90`；第 9 條 `shiftDays` 沒 import → `entriesInSpan(entries, today, SPARKLINE_DAYS).start`（就是今天 − 29）。另外多兩條：6b 拿掉名稱裡的空白、
  11 `aria-labelledby` 指到不存在的 id。
- **截圖抓到的**（`9e8a9e9`）：兩張小卡片並排時 grid 把矮的本月支出拉成跟體重一樣高，連結卻只有 44px（390 寬實測 145×44，卡片約 103 高），
  下半張點了沒反應。`.glance` 加 `box-sizing: border-box; height: 100%`，之後兩個連結都是整張（1280 寬 164×103）。
- 量到的：圓環 132×132；「設定每日目標」96×44；迷你折線 145×32（390 寬）、164×32（1280 寬）；兩種寬度都沒有水平捲動。
- **深色模式**：`--color-accent` 與 `--color-action` 在深色是同一個色（`#ff8a6b`），`/weight` 的 7 天平均跟每天的線只差虛線與 `opacity`。
  看截圖分得出來；規格 D24 是「顏色不變」，沒有加新的變數。
- 截圖（不進 repo）：`$S/home/{m,d}-*.png`（`m` 390×844、`d` 1280×800；1 一般、1-full 整頁、2 體重小卡片、3／3b `/weight`、4 超過、5 沒有目標、
  6 深色總覽〔a 一般、c 超過〕、7 深色 `/weight`），腳本 `$S/home-fe1-shots.cjs`。

### Task 3（`825ec8a`）

- 條數：quick-actions **4**（照計畫；多兩個斷言：掃條碼與記體重的形狀互不相認、新號碼跟舊號碼不同）、log-meal-ai **4**（計畫 3；多
  「卡片按『取消』焦點回到『拍照估算』」——規格 §4 寫了，沒有測試守）、log-meal-barcode 2、weight 2、overview 新 **5**（計畫 3；多
  「順序：圓環卡片 → 快速記錄 → 本月支出」，掃條碼與記體重的 state 拆成兩條，不用 `cleanup` 串在一條裡）＋Task 2 第 5 條改
  `JSON.stringify(WEIGHT_FORM_STATE)`、app 新 3＋「從＋點記運動」改在 dialog 裡找。整套 `220 passed`、`3240 passed`。
- 拍照記第 1 條的「沒有 hint」寫成 `toEqual([{ kind: "image", image_base64: btoa("x") }])`（整個比，多一個鍵就紅；resize 的 mock 回原檔）。
- `AiMealPanel` 的 `pending` 初值用計畫給的第一種寫法 `initialFits && initialPhoto !== undefined ? … : null`，typecheck 乾淨。
- `Weight` 的 `Props` 放在說明註解的前面（不然 JSDoc 黏到型別上）；`focusForm` 的說明併進 `Weight` 的註解。
- 總覽的「快速記錄（Task 3）」佔位註解換掉；`WeightGlanceCard` 的暫時 state 換成 `WEIGHT_FORM_STATE`。
- **StrictMode／重複套用**：`LogMealRoute` 的 `useState` 初值函式讀照片（讀了不清），清 history 的 effect 才 `releaseQuickPhoto()`；
  照片進了 `AiMealPanel` 自己的 `pending`，`LogMeal` 裡 `AiMealPanel` 沒有 `key`、不會重掛，所以不會套用兩次。上一頁回到記一餐時 state
  已經是 null（`replace`），暫存也放了。掃描層的相機在 `use-barcode-scanner.ts` 已經處理 StrictMode 的「掛、卸、再掛」與卸載時停掉串流，沒改。
- 突變 **14/14**（計畫 11 條＋8b 記體重的 state、12 `App` 的 `startScanning={scan}`）。型別乾淨的寫法：5 `useState(startScanning === false)`
  （先試的 `=== true && false` 讓 `useState` 推成 `false` 型別，`setScanning(true)` 型別錯，工具標 TYPE-ERROR）、6／10 `focusForm && false`、
  8 `{ ...SCAN_STATE, quickScan: false }`、9 `photo === null ? undefined : undefined`、9b `void releaseQuickPhoto;`、
  11 `(stashQuickPhoto(file), navigate("/meals/new"))`（拿掉 state 會讓 `stashQuickPhoto` 的 import 沒人用）。

### Task 4（`48a2638`）

- 搬測試用腳本（`$S/home-fe2-t4-move.py`）。驗證：`git diff` 裡 me.test 刪掉的每一行在 body-hub.test 都找得到，例外只有兩條順序測試、
  `<Me />` 與四個 `describe` 名稱。me＋body-hub 的 `it` 33 → 32（−2 順序＋1 頁面）。
- 頁面那一條的開關要 `findByRole`：`ExerciseBudgetSwitch` 等 `/api/me` 回來才畫（計畫寫 `getByRole`，紅）；最後等身體資料「還沒有填」免得 act 警告。
- 多加的：tab-bar、side-nav 各一條「在 /me/health 亮的是我的」（守「我的」那一格沒有 `end`）；layout 兩格（含結尾斜線）；app 那一條也看導覽的
  `aria-current`。三個檔案的測試名稱「回 /me」改「回 /me/health」，body-profile、targets 裡提到「我的」卡片的註解也改了。
- 突變 **8/8**（計畫 6＋4b 標題、7 `nav-tabs.ts` 的「我的」加 `end: true` → 紅 tab-bar、side-nav、app）。第 5 條改成 `path="/me/healthz"`
  （拿掉整條會讓 `BodyHub` 的 import 沒人用）。整套 `222 passed`、`3246 passed`。

### Task 5（`df01a4d`）

- me 入口 **6** 條（計畫 5；多「載入中…，連結照樣在」）。`WEIGHT_79` 改成兩筆（80.2 → 79）：只有一筆時「最新一筆」寫成 `at(0)` 也綠（突變 4b 證明）。
- 「沒有三張卡片」那一條先等帳號的 email（`useMe` 回來）再看沒有卡片、沒有打 body-profile／target-suggestion。
- 突變 **10/10**（計畫 6＋4b 最新一筆、4c「還沒設定」、4d「載入中…」、7 連結去處）。第 4 條寫成 `stats.data?.kcal_budget ?? stats.data?.target?.kcal`；
  第 5 條加回 `<TargetsCard />` 要動 import，改成加一個 `<div data-testid="targets-card" />`。整套 `3258 passed`。

### Task 6（`95bc91c`）

- tab-bar 的新那一條另外印 router state（守 `WEIGHT_FORM_STATE`）；side-nav 那一條也比四個入口的順序。app「從＋點記體重」限定在 dialog 裡。
- 突變：state、href、入口的名稱 **3/3**。**拿掉 `onClick={onNavigate}` 是等價突變**（計畫寫會紅）：`use-add-sheet.ts` 在 render 時看到
  `location.key` 變了就把 `openedAt` 清掉，任何導頁都會關、上一頁也不會跳回來；記運動那一顆一樣。照樣留著 onClick（跟另外三顆一致）。
  `.choices` 的欄數只有 e2e 量得到（截圖量到 2×2）。整套 `222 passed`、`3264 passed`。

### Task 3–6 的截圖

- `$S/home/t3-{m,d}-*.png`（`m` 390×844、`d` 1280×800；1 總覽、1-full 整頁、2 精簡的「我的」、3 身體與目標、4「＋」2×2、5 拍照記 → 確認照片
  〔`setInputFiles` 在快速記錄的輸入〕、6 掃條碼 → 掃描層〔Chromium 的假相機〕、7 記體重 → `/weight`）、`t3-dark-m-{1-overview,3-hub}.png`；
  腳本 `$S/home-fe2-shots.cjs`。
- 量到的：快速記錄每格 86×82（390 寬）、95×82（1280 寬）；入口連結 334×44、608×44；「＋」每格 173×104、178×104。焦點：確認照片卡片、掃描層的
  「取消」、取消之後記一餐的「掃條碼」、`/weight` 的體重欄位都對；`/me/health` 上「我的」是 `aria-current="page"`。
- 「我的」在 390 寬有水平捲動：帳號卡片的 email 不換行（截圖帳號的 email 49 個字）。既有的，跟這次的改動無關，沒改。
- 深色：掃條碼的徽章 `--color-action`（深色 `#ff8a6b`）跟拍照記的 food 橘接近，看得出是兩個顏色；規格 D17 沒要求快速記錄四色互異，沒加變數。

### Task 7（`0e58fe0`）

- 四個 spec 照 Step 1–4 改。多的斷言：account-settings 每一圈多看「還能吃 N kcal」（新帳號沒吃東西，還能吃的就是整個目標）；
  body-targets 第三條的總覽小卡片看的是迷你折線**兩個點**（`weight-sparkline-line` 的 `points` 對 `/^\S+ \S+$/`），不只是在不在——寫之前看過那四個日期：
  刪掉 2 天前、40 天前在 30 天外，剩今天與 7 天前兩筆。planner 的兩行註解（「總覽照舊印 732.5」「總覽：今天 732.5」）跟著改。
- `desktop-layout.spec.ts` 不用改：第 117 行量的 `month-spend` 照樣在左欄、時間線在它右邊；兩張小卡片並排之後還是成立。`auth.spec.ts` 也不用改。
  六個 spec 一起跑 `20 passed`。
- 突變 **3/3**（`$S/home-e2e-mutations-t7.json`，工具 `$S/home-e2e-mutate.py`：每一項自己帶要跑的 spec）：「預算 」→「額度 」紅四個 spec 各一條；
  `Targets.tsx` 導回 `/me` 紅 account-settings 與 exercise（等不到「身體與目標」的標題）；`.weight-average` 拿掉 `stroke-dasharray` 紅 body-targets 第三條
  （`not.toBe("none")`）。
- 前端整套 `222 passed`、`3264 passed`（沒有新的單元測試）。

### Task 8（`15517f4`）

- `e2e/home.spec.ts` **6 條**（計畫 5；多「「我的」（手機）：入口卡片、長 email 換行不撐出水平捲動」，見下面）。跟計畫的程式不一樣的地方：
  - **圓環那一條的體重改成 8 天前 80.3、今天 79.4**（計畫 3 天前 80）：小卡片才有「比 7 天前 -0.9 公斤」，斷言**整個連結名稱**
    「體重 79.4 公斤 比 7 天前 -0.9 公斤」（迷你折線是 `aria-hidden`、不進名稱）。迷你折線的兩點拆開比：x 往右、8 天前比較重畫得比較高（y 小）；左緣也在卡片裡。
    最後點小卡片到 `/weight`：點 2 個、實線的組數＝點數、平均是虛線、**實線不是虛線**（`strokeDasharray` 是 `none`）。脂肪那一列多看「45」。
  - 沒有目標：小卡片的名稱「體重 記錄體重」、「設定每日目標」≥ 44px、卡片裡沒有「還能吃」。
  - 快速記錄：四顆的字照順序（`toHaveText`）、輸入的 `id` 是 `quick-photo`；確認照片卡片上「取消」在、按「開始估算」之前 `sent` 是 0（不自動送，D8）；
    掃描層一打開焦點就在「取消」（計畫只看取消之後）；三個連結**限定在「快速記錄」清單裡**找；「＋」的 2×2 多看第二個在第一個右邊、同一列。
  - 身體與目標：入口連結的 `href` 是 `/me/health`；三張卡片先 `toHaveCount(3)` 再 `evaluateAll`（`evaluateAll` 不會等）；回「我的」先等標題再看摘要。
  - 電腦版：先等「已吃 0 kcal」「記錄體重」（載入中的卡片比較矮）再量；本月支出在快速記錄下面。`box()` 一律先 `toBeVisible()`。
- **「我的」在 390 寬的水平捲動修了**（Task 3–6 截圖看到的既有問題）：`AccountCard.module.css` 的 `.email` 加 `overflow-wrap: anywhere`。
  先寫測試：第一版的帳號 label 是 `home-me-long-email`，**沒有紅**——「-」後面可以換行，email 在連字號那裡斷開了。截圖帳號的 email 沒有連字號，
  改成 `homemelongemailwraps`；另外第一版量 `<p>` 的 `boundingBox()`，區塊的外框永遠是容器的寬，溢出量不到——改量 `scrollWidth - clientWidth`。
  修之前紅（溢出 **153px**），修之後綠；突變 e9（拿掉 `overflow-wrap`）紅。
- `npx playwright test e2e/home.spec.ts` → `6 passed`（約 8 秒）。
- 突變 **11/11**（`$S/home-e2e-mutations.json`）：計畫的 8 條照寫全紅（1 已吃後面的「・」→「，」、2 拿掉 `capture`、3 `startScanning={false}`、
  4 「＋」`repeat(4, …)`、5 電腦版小卡片上下疊、6 拿掉 `aria-describedby`、7 迷你折線要 3 筆、8 高 64px）；多三條：e9 email 不換行、
  e10 `WeightRoute` 不給 `focusForm`（紅「快速記錄」的 `toBeFocused`）、e11 迷你折線拿掉 `aria-hidden`。每一條之後 `git status`／`git diff` 只有要改的。
- **完整的 e2e 兩次**（`docker compose up -d --build api` 之後，預設 6 個 workers）：`68 passed`（43.7 秒）、`68 passed`（42.8 秒），68 條、26 個檔案。
  `docker compose logs api --since 20m | grep 重用` 沒有任何一行（api 容器這次重建過，log 只有這次的）；也沒有 error／traceback。
- **截圖**：`$S/home/t8/{m,md,d,dd}-*.png`（`m` 390×844 淺色、`md` 390×844 深色、`d` 1280×800 淺色、`dd` 1280×800 深色；1 一般、1-full 整頁、
  2 超過、3 沒有目標、4「我的」、5 身體與目標〔整頁〕、6／6b `/weight`、7「＋」），腳本 `$S/home-e2e-shots.cjs`，拼圖 `$S/home-e2e-sheet.py`。
  計畫寫「A 再用 API 記 200 g 拍超過」：每一種組合都開新帳號，A 要留著拍「我的」與身體與目標，超過改用帳號 C（目標、運動一樣，便當 300 g＋200 g）。
  A 的五天體重照計畫（20、10、6、3 天前與今天）。
- 量到的：快速記錄每格 86×82（390）／95×82（1280）；圓環 132×132；迷你折線 145×32／164×32；小卡片的連結 145×103／164×103；「＋」每格 173×104／178×104；
  入口連結 334×44／608×44；「設定每日目標」96×44；`/weight` 的圖 334×210／608×382。**28 張都沒有水平捲動**（含 390 寬的「我的」）。
- 看過的：圓環中間的字不跟圓環重疊；超過的紅字在深色看得清楚；四顆在 390 寬不換行；「已吃 1500・預算 2343（含運動 +343）」在 390 寬一行放得下；
  「＋」2×2；迷你折線在小卡片裡、線寬沒變粗；`/weight` 的實線與虛線在深色分得出來（同色、只差虛線與 `opacity`，Task 2 記過）。
  「我的」的長 email 斷在「@exampl／e.com」（`anywhere` 斷在任何字元），記進 handover 的已知限制。沒有要修的 CSS。

### Task 9（這個 commit）

- handover：§2 的測試數字（前端 `Test Files 222`、`Tests 3264`；e2e 68 條、26 個檔案；後端沒改、沿用 2237）、階段進度一列；§10 新的一節
  「首頁改版：熱量圓環、快速記錄、身體與目標」；「身體資料與目標」「運動紀錄」兩節裡過時的格子補一句指到新的一節（存好的去處、卡片搬家、`/weight` 是折線圖、
  「＋」四個、總覽的字樣）；§7「畫出『我的』的單元測試」改成身體與目標與「我的」，加四列（`getByRole` 不看 `aria-modal`、行內 `<span>` 的名稱沒有空白、
  grid 拉伸的卡片連結、重現不換行的長字串）；§8.2「首頁改版的已知限制」10 點（含 iOS 實機沒驗證、深色模式的顏色接近、長 email 斷在任何字元）。
- 規格的狀態改「已實作」。沒有另外的審查，所以沒有「審查後的修正」一節。
- 前端整套最後一次：`222 passed`、`3264 passed`，typecheck、lint 綠（文件 commit 前跑的）。

## 與規格的差異（寫計畫時決定的）

1. **體重小卡片放在 `Overview.tsx` 裡**（`WeightGlanceCard`），不是規格 §10 寫的 `components/WeightGlanceCard.tsx`：它跟本月支出共用
   `Overview.module.css` 的 `.glance`／`.label`／`.total`，元件去 import 畫面的 CSS 模組不好。
2. **既有的單元測試在改動它的那個 task 裡一起改**（每個 commit 都是綠的）；建議的「Task 7：更新受影響的測試」只剩既有的 **e2e**。
3. 小卡片的連結名稱含標籤（「本月支出 $12480.00」「體重 79 公斤 比 7 天前 -0.4 公斤」「體重 記錄體重」）：標籤在連結裡，整塊都能點；
   e2e 一律先用 testid 找卡片、再 `getByRole("link")`。

實作時多出來的：

4. **首頁的 e2e 是 6 條**（規格 §9.3 五條）：多一條「我的」（手機）的長 email——順手修了「我的」在 390 寬的水平捲動（帳號卡片的 email `overflow-wrap: anywhere`），規格沒有提，是 Task 3–6 的截圖看到的既有問題。
5. **圓環那一條的體重是 8 天前 80.3、今天 79.4**（規格 §9.3 第 1 條是 3 天前 80）：才有「比 7 天前」，可以斷言小卡片的整個連結名稱；同一條多看 `/weight` 的實線與虛線（規格 §9.3 把它放在 body-targets 第三條，兩邊都有）。
6. **超過的截圖用另一個帳號**（規格 §10 沒指定怎麼拍；計畫寫同一個帳號再記 200 g）：見 Task 8。

## 執行環境

- 分支 `feat/home-redesign`（已建立，**不要 push**）。`S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad`。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（格式 `npx biome check --write <檔案>`）。
  **三個分開跑**；驗證時一起 grep `FAIL` 與 `Unhandled`（handover §7：只看 `Tests` 那一行會漏掉整個檔案沒編譯）。測試預設是手機版面
  （`src/test/setup.ts`）；電腦版 `act(() => setDesktop(true))`。
- `tests/helpers/mock-api.ts` 依序用 `url.includes` 比對：`/api/me` 吃掉 `/api/me/body-profile`、`/api/meals` 含 `/api/me`——**具體的排前面**。
  `bodyRoutes()`（`tests/helpers/body-routes.ts`）放最前面；`exerciseRoutes()` 放在單筆 `/api/exercises/…` 的後面。
- **沒有後端改動**：不用重新產生 `schema.d.ts`。e2e 之前 `docker compose up -d --build api`（dev 的 `api` 容器），**絕對不要 `down -v`**。
- **突變**：`cp "$S/hint-fe-mutate.py" "$S/home-fe-mutate.py"`（格式見檔頭：`{"name","file","old","new","tests","expect"}`，`old` 必須剛好出現一次，
  存原始位元組 → 替換 → 跑 vitest → 還原 → 逐位元組比對）。規格寫成 `$S/home-mut-t<N>.json`。e2e 的：`cp "$S/hint-e2e-mutate.py" "$S/home-e2e-mutate.py"`，
  把裡面跑的 spec 換成 `e2e/home.spec.ts`（Task 8）。**新的、還沒追蹤的檔案** `git checkout --` 救不回來：突變之前先 `cp` 一份。每一批之後 `git status`／`git diff`。
- **Commit**：中文 conventional commit。訊息用 Write 工具寫到 `$S/home-<task>-msg.txt`（每次不同檔名），最後一行
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，`git commit -F`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**
  （不要 `git add -A`／`.`）。不要 amend。
- **看不見的字元**：腳本一律用 Write 工具寫成檔案（不用 heredoc）。`$S/home-scan.py` 已經在（從 `hint-scan.py` 複製；掃 Cc〔Tab、LF 除外〕、Cf、Zl、Zp、
  CR、BOM，找到就 `exit 1`）。commit 一律：

  ```bash
  cd /f/wallet && ./.venv/Scripts/python.exe -I "$S/home-scan.py" $(git diff --cached --name-only) "$S/home-<task>-msg.txt" && git commit -F "$S/home-<task>-msg.txt"
  ```

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。紅在 import（元件還不存在）也算，但斷言的咬合力由每個 task 的突變證明。
2. 引用的程式碼對不上現況 → 以現況為準，記進「執行中發現的差異」。
3. **Decimal 字串只經過 `lib/decimal.ts`**（`tests/decimal-containment.test.ts`）。`number` 只用在 SVG 座標（`ratioOf` 回的比例）。
4. **顏色只用 `index.css` 的設計變數**（`tests/css-tokens.test.ts` 擋元件 CSS 的色碼）；觸控目標 44px；輸入框 16px；會在焦點正在它身上時停用的按鈕用
   `aria-disabled`（這次沒有新的）。頁面的電腦版 CSS 寫 `:global(.app-desktop) .x`，不寫寬度的 media query。
5. **`LogMeal` 不碰 router**（handover §7）：導頁、讀 router state 都在 `App.tsx` 的 `LogMealRoute`；`LogMeal` 只收 props。
6. **同名的連結**（規格 D18）：總覽的「記運動」「記體重」跟「＋」選單同名；testing-library 與 Playwright 的 `getByRole` **不看 `aria-modal`**——
   「＋」開著時一律 `within(dialog)`／`page.getByRole("dialog", { name: "新增紀錄" }).getByRole(…)`。
7. Playwright：名稱一律 `exact: true`；登入之後只用點擊換頁、換頁後先等那一頁獨有的標題；只假造 AI 端點；`expectTouchTargets` 之前先等元素出現
   （它用 `count()`，不會等）。量照片那顆的高度量 `<label>`（隱藏的檔案輸入算 button、高 1px）。
8. 新的字（「今天熱量」「還能吃」「超過」「已吃」「預算」「還沒有每日目標」「設定每日目標」「快速記錄」「拍照記」「記體重」「身體與目標」「還沒設定」）
   寫完 `grep -rn` 一次 `frontend/src` 與 `frontend/e2e`，確認不跟既有**不帶 `exact`** 的名稱互為子字串（寫計畫時查過：「身體與目標」「記體重」「拍照記」
   在 `src` 裡沒有；「設定每日目標」已經在 `PlannerCard`，不同頁）。

## 寫計畫時實測過的事（沒有整份試跑）

這份計畫**沒有**整份跑過。「Expected: PASS」的條數是照測試清單數的；對不上照實回報。

1. **decimal.js**（`node`，frontend 的 `node_modules`）：`kcalBalance` 的寫法對 `("2000","2000.4")` → `[false,"0"]`、`("2000","2000.5")` → `[true,"1"]`、
   `("700","732.5")` → `[true,"33"]`、`("2343","1523.4")`／`("2343","1523.5")` → `[false,"820"]`、`("2343.00","2500.00")` → `[true,"157"]`、
   `("2343.00","1500.00")` → `[false,"843"]`；`Decimal("-0").abs().toString()` 是 `"0"`；`roundForDisplay("732.5", 0)` 是 `"733"`。
2. **圓環**：`2π × 55` = `345.58`；`× 1500/2343` = `221.24`；`× 0.5` = `172.79`。
3. **lucide-react 1.50.0** 有 `Weight`、`Camera`、`ScanBarcode`、`Dumbbell`、`ChevronRight`（`dist/lucide-react.d.ts` 裡各一個 `declare const`）。
4. 讀過的現況：`Overview.tsx`、`Me.tsx`、`App.tsx`（`LogMealRoute`）、`AiMealPanel.tsx`（`pending`／`pickError`／`focusNextRef`）、`BarcodeScanEntry.tsx`
   （`scanning`）、`FoodPicker.tsx`、`Weight.tsx`（`WeightBody` 裡的 `<WeightForm today={today} />`）、`WeightForm.tsx`（`focusOnMount`）、`AddSheet.tsx`、
   `TargetsCard`／`WeightCard`／`BodyProfileCard`、`lib/layout.ts`、`tests/{overview,me,app,tab-bar,side-nav,log-meal-ai,log-meal-barcode,weight}.test.tsx`、
   `e2e/{account-settings,body-targets,exercise,planner,desktop-layout,ai-photo-hint,barcode}.spec.ts`。

## 檔案結構

| 檔案 | Task | 內容 |
|---|---|---|
| `frontend/src/lib/decimal.ts`、`tests/decimal.test.ts` | 1 | `kcalBalance` |
| `frontend/src/components/CalorieRing.{tsx,module.css}`（新）、`tests/calorie-ring.test.tsx`（新） | 1 | 圓環 |
| `frontend/src/components/BudgetSummary.{tsx,module.css}`（新）、`tests/budget-summary.test.tsx`（新） | 1 | 圓環卡片的內容 |
| `frontend/src/lib/weight-plot.ts`（新）、`tests/weight-plot.test.ts`（新） | 1B | 體重圖共用的座標換算 |
| `frontend/src/components/WeightChart.tsx`、`src/index.css`、`screens/Weight.module.css`、`tests/weight-chart.test.tsx` | 1B | `/weight` 的折線、虛線的平均、圖例 |
| `frontend/src/screens/Weight.tsx`、`tests/weight.test.tsx` | 1B、3 | 圖例；`focusForm` |
| `frontend/src/components/WeightSparkline.{tsx,module.css}`（新）、`tests/weight-sparkline.test.tsx`（新） | 2 | 迷你折線 |
| `frontend/src/screens/Overview.{tsx,module.css}`、`tests/overview.test.tsx` | 2、3 | 版面、圓環卡片、小卡片（含迷你折線）；快速記錄 |
| `frontend/src/lib/quick-actions.ts`（新）、`tests/quick-actions.test.ts`（新） | 3 | router state、照片暫存 |
| `frontend/src/components/QuickActions.{tsx,module.css}`（新）、`IconBadge.tsx` | 3 | 四顆；`WEIGHT_COLOR` |
| `frontend/src/screens/LogMeal.tsx`、`components/{AiMealPanel,FoodPicker,BarcodeScanEntry}.tsx`、`tests/{log-meal-ai,log-meal-barcode}.test.tsx` | 3 | `initialPhoto`、`startScanning` |
| `frontend/src/App.tsx`、`tests/app.test.tsx` | 3、4、6 | `LogMealRoute`、`WeightRoute`、`/me/health` |
| `frontend/src/screens/BodyHub.tsx`（新）、`tests/body-hub.test.tsx`（新）、`lib/layout.ts`、`tests/layout.test.ts` | 4 | 身體與目標 |
| `frontend/src/screens/{Targets,BodyProfile}.tsx`、`components/TargetSuggestion.tsx`、`tests/{targets,target-suggestion,body-profile,exercise-budget-switch}.test.tsx` | 4 | 存好導回 `/me/health` |
| `frontend/src/components/{TargetsCard,WeightCard,BodyProfileCard}.tsx` | 4 | 只改註解 |
| `frontend/src/components/BodyHubEntry.{tsx,module.css}`（新）、`screens/Me.tsx`、`tests/me.test.tsx` | 5 | 入口卡片、精簡 |
| `frontend/src/components/AddSheet.{tsx,module.css}`、`tests/{tab-bar,side-nav}.test.tsx` | 6 | 記體重、2×2 |
| `frontend/e2e/{account-settings,body-targets,exercise,planner}.spec.ts` | 7 | 既有 e2e |
| `frontend/e2e/home.spec.ts`（新）、`$S/home-fe-shots.cjs`（不進 repo） | 8 | 新 e2e、截圖 |
| `docs/handover.md`、規格、這份計畫 | 9 | 文件 |

---

## Task 1：`kcalBalance`、`CalorieRing`、`BudgetSummary`

**Files:** `frontend/src/lib/decimal.ts`、`frontend/src/components/{CalorieRing,BudgetSummary}.{tsx,module.css}`（新）；
`frontend/tests/decimal.test.ts`、`tests/{calorie-ring,budget-summary}.test.tsx`（新）

- [ ] **Step 1：`tests/decimal.test.ts` 加一組**（import 加 `kcalBalance`）：

```ts
describe("kcalBalance（首頁改版規格 D3）", () => {
	it.each([
		["2343.00", "1500.00", false, "843"],
		["2343", "1523.4", false, "820"],
		// 819.5 → 820（half-up）
		["2343", "1523.5", false, "820"],
		// −32.5 → −33（遠離 0）：「超過 33」
		["700", "732.5", true, "33"],
		// −0.4 → −0：還能吃 0，不是「超過 0」
		["2000", "2000.4", false, "0"],
		["2000", "2000.5", true, "1"],
		["2000", "2000", false, "0"],
		["2343.00", "2500.00", true, "157"],
	])("額度 %s、實際 %s → over %s、%s", (budget, actual, over, amount) => {
		expect(kcalBalance(budget, actual)).toEqual({ over, amount });
	});
});
```

- [ ] **Step 2：`tests/calorie-ring.test.tsx`。**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalorieRing, ringDasharray } from "../src/components/CalorieRing";

describe("ringDasharray（規格 D4）", () => {
	it.each([
		[null, "0.00 345.58"],
		[0, "0.00 345.58"],
		[-0.2, "0.00 345.58"],
		[0.5, "172.79 345.58"],
		[1500 / 2343, "221.24 345.58"],
		[1, "345.58 345.58"],
		[1.3, "345.58 345.58"],
	])("比例 %s → %s", (ratio, expected) => {
		expect(ringDasharray(ratio)).toBe(expected);
	});
});

describe("CalorieRing", () => {
	it("整張是裝飾（aria-hidden）；一般：弧照比例、data-tone normal", () => {
		const { container } = render(<CalorieRing ratio={0.5} tone="normal" />);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		const arc = screen.getByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "normal");
		expect(arc).toHaveAttribute("stroke-dasharray", "172.79 345.58");
	});

	it("超過：畫滿，不看比例", () => {
		render(<CalorieRing ratio={0.2} tone="over" />);
		const arc = screen.getByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "over");
		expect(arc).toHaveAttribute("stroke-dasharray", "345.58 345.58");
	});

	it("沒有額度：只有底圈", () => {
		const { container } = render(<CalorieRing ratio={null} tone="none" />);
		expect(screen.queryByTestId("calorie-ring-arc")).not.toBeInTheDocument();
		expect(container.querySelectorAll("circle")).toHaveLength(1);
	});
});
```

- [ ] **Step 3：`tests/budget-summary.test.tsx`**（`MemoryRouter` 包住；用一個 `stats()` 組資料）：

```tsx
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DailyStats } from "../src/api/stats";
import { BudgetSummary } from "../src/components/BudgetSummary";

/** 規格 §3.3 那一組：目標 2000／120／不設／250、運動 343、加回開著、吃了 1500。 */
const BASE = {
	date: "2026-10-22",
	actual: { kcal: "1500.00", protein_g: "60.00", fat_g: "45.00", carb_g: "180.00" },
	target: { kcal: "2000.00", protein_g: "120.00", fat_g: null, carb_g: "250.00" },
	ratio: { kcal: "0.75", protein_g: "0.50", fat_g: null, carb_g: "0.72" },
	breakdown: {
		food: { kcal: "1500.00", protein_g: "60.00", fat_g: "45.00", carb_g: "180.00" },
		supplement: { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" },
	},
	exercise_kcal: "343.00",
	exercise_adds_to_budget: true,
	kcal_budget: "2343.00",
};

function stats(overrides: Record<string, unknown> = {}): DailyStats {
	return { ...BASE, ...overrides } as DailyStats;
}

function renderSummary(value: DailyStats) {
	return render(
		<MemoryRouter>
			<BudgetSummary stats={value} />
		</MemoryRouter>,
	);
}
```

  `BASE` 的形狀照 `DailyStatsResponse`（`schema.d.ts`）；少了欄位的話照型別補（`as DailyStats` 只是為了讓「舊回應」那一條能拿掉欄位）。各一條：
  1. **一般**：`container` 的 `textContent` 含「還能吃 843 kcal」（用 `toHaveTextContent`，不要 `getByText`——三個 `<span>` 分開，見 handover §7 testing-library 的文字比對）、
     「已吃 1500・預算 2343（含運動 +343）」；`calorie-ring-arc` 的 `data-tone` 是 `normal`、`stroke-dasharray` 是 `"221.24 345.58"`；
     `macro-protein_g` 含「60 / 120」、`macro-fat_g` 含「未設定」、`macro-carb_g` 含「180 / 250」；沒有「設定每日目標」的連結。
  2. **超過**：`actual.kcal` 2500 →「超過 157 kcal」、`data-tone` `over`、`stroke-dasharray` `"345.58 345.58"`；中間那個 `<p>` 的 `data-tone` 也是 `over`
     （`screen.getByText("超過").parentElement`）。**不要斷言 CSS Modules 的 class 名稱**（既有的測試只斷言全域 class；模組的 class 在 vitest 裡長什麼樣沒有人量過）——
     紅字由截圖（Task 8）看。
  3. **剛好**：`actual.kcal` `"2343.40"` →「還能吃 0 kcal」、`data-tone` `normal`。
  4. **捨入**：`actual.kcal` `"1523.40"` →「還能吃 820 kcal」「已吃 1523・預算 2343」。
  5. **設定關掉**：`exercise_adds_to_budget: false`、`kcal_budget: "2000.00"` →「預算 2000」，`not.toHaveTextContent("含運動")`。
  6. **舊回應**（離線快取，沒有三個欄位）：拿掉 `exercise_kcal`、`exercise_adds_to_budget`、`kcal_budget` →「預算 2000」「還能吃 500 kcal」、沒有「含運動」。
  7. **沒有目標**（`target: null`、`ratio` 全 null、`kcal_budget: null`）：「已吃 1500 kcal」、「還沒有每日目標」、連結「設定每日目標」`href="/me/targets"`；
     沒有 `calorie-ring-arc`；`getAllByText("未設定")` 三個；`not.toHaveTextContent("/")`。
  8. **有目標但熱量沒設**（`target.kcal: null`、`kcal_budget: null`）：同 7 的熱量部分，但 `macro-protein_g` 含「60 / 120」。

- [ ] **Step 4：跑，看它紅** → `npx vitest run tests/decimal.test.ts tests/calorie-ring.test.tsx tests/budget-summary.test.tsx`。Expected: FAIL（`kcalBalance` 與兩個元件不存在）。

- [ ] **Step 5：`lib/decimal.ts`**（放在 `roundForDisplay` 後面）：

```ts
/** 今天的熱量額度還剩多少（首頁改版規格 D3）：`額度 − 實際` **先**四捨五入到整數（half-up：.5 遠離 0），再看正負。
 *  負的＝超過（`over: true`，`amount` 是絕對值）；0 與正的＝還能吃。先捨入再判斷，畫面上不會出現「超過 0 kcal」：
 *  −0.4 捨入成 −0，`lessThan(0)` 是 false，`abs()` 印成 "0"。 */
export function kcalBalance(
	budget: Numeric,
	actual: Numeric,
): { over: boolean; amount: string } {
	const diff = new Decimal(budget)
		.minus(actual)
		.toDecimalPlaces(0, Decimal.ROUND_HALF_UP);
	return { over: diff.lessThan(0), amount: diff.abs().toString() };
}
```

- [ ] **Step 6：`components/CalorieRing.tsx`。**

```tsx
import styles from "./CalorieRing.module.css";

/** viewBox 的邊長與線寬：半徑＝(120 − 10) / 2 = 55。畫出來多大由 CSS 決定。 */
const SIZE = 120;
const STROKE = 10;
const RADIUS = (SIZE - STROKE) / 2;
const CENTER = SIZE / 2;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** `normal`：照比例畫弧；`over`：超過額度，整圈、危險色；`none`：沒有額度，只有底圈。 */
export type RingTone = "normal" | "over" | "none";

/** `ratioOf()` 的比例 → `stroke-dasharray`（「弧長 圓周」，兩位小數）。null 與負的畫 0、超過 1 夾在 1。
 *  `number` 只用在座標（同 `TrendChart` 的 `positionIn`）：Decimal 字串在 `ratioOf` 那一步就換好了。 */
export function ringDasharray(ratio: number | null): string {
	const fraction = ratio === null ? 0 : Math.min(Math.max(ratio, 0), 1);
	return `${(CIRCUMFERENCE * fraction).toFixed(2)} ${CIRCUMFERENCE.toFixed(2)}`;
}

type Props = {
	/** `ratioOf(實際, 額度)`；沒有額度是 null。`tone` 是 `over` 時不看它（畫滿）。 */
	ratio: number | null;
	tone: RingTone;
};

/** 熱量圓環（首頁改版規格 D4、D5）。**整張是裝飾**（`aria-hidden`）：數字是呼叫端放在中間的文字，
 *  圓環不是 progressbar——念出來的是「還能吃 843 kcal」，不是一個百分比。
 *  弧從 12 點鐘方向順時針畫（`rotate(-90)`）。 */
export function CalorieRing({ ratio, tone }: Props) {
	return (
		<svg
			className={styles.ring}
			viewBox={`0 0 ${SIZE} ${SIZE}`}
			aria-hidden="true"
			focusable="false"
		>
			<circle
				className={styles.track}
				cx={CENTER}
				cy={CENTER}
				r={RADIUS}
				strokeWidth={STROKE}
			/>
			{tone !== "none" && (
				<circle
					data-testid="calorie-ring-arc"
					data-tone={tone}
					className={tone === "over" ? `${styles.arc} ${styles.over}` : styles.arc}
					cx={CENTER}
					cy={CENTER}
					r={RADIUS}
					strokeWidth={STROKE}
					strokeDasharray={ringDasharray(tone === "over" ? 1 : ratio)}
					transform={`rotate(-90 ${CENTER} ${CENTER})`}
				/>
			)}
		</svg>
	);
}
```

  Biome 對 `<circle>` 報 `noAriaHiddenOnFocusable` 之類的誤判時（handover §7：`<text>`、`<polyline>` 踩過），照 `WeightChart.tsx` 加 `biome-ignore` 與理由；
  JSX children 位置要用 `{/* biome-ignore … */}`。

- [ ] **Step 7：`components/CalorieRing.module.css`。**

```css
/* 熱量圓環（CalorieRing.tsx；首頁改版規格 D4、D5）。大小由外層決定（BudgetSummary 的 .ringBox）。
   顏色只用設計變數：底圈是框線色、弧是強調色，超過額度時弧用危險色——「超過」兩個字也是危險色，
   顏色不是唯一的線索。圓環是裝飾（aria-hidden），不需要圖形對比。 */

.ring {
	display: block;
	width: 100%;
	height: 100%;
}

.track {
	fill: none;
	stroke: var(--color-border);
}

.arc {
	fill: none;
	stroke: var(--color-accent);
}

/* 寫在 .arc 之後：同權重靠順序。 */
.over {
	stroke: var(--color-danger);
}
```

- [ ] **Step 8：`components/BudgetSummary.tsx`。**

```tsx
import { Link } from "react-router";
import { type DailyStats, exerciseInBudgetOf, kcalBudgetOf } from "../api/stats";
import { kcalBalance, ratioOf, roundForDisplay } from "../lib/decimal";
import styles from "./BudgetSummary.module.css";
import { CalorieRing, type RingTone } from "./CalorieRing";
import { MacroBar } from "./MacroBar";

/** 總覽「今天熱量」卡片的內容（首頁改版規格 §3）：圓環＋中間的字、三大營養素、一行「已吃・預算」。
 *
 *  - 額度一律經過 `kcalBudgetOf`（目標＋運動，設定關掉是目標；離線快取的舊回應退回目標）；「含運動」經過
 *    `exerciseInBudgetOf`——不直接碰 `stats.kcal_budget`（運動規格的規矩）。
 *  - 「還能吃／超過」是 `kcalBalance` 的整數（D3）；已吃、預算、含運動只是顯示，`roundForDisplay(…, 0)`（D19）。
 *  - 沒有額度（沒有目標，或熱量沒設）：中間寫已吃，下面「還沒有每日目標」＋「設定每日目標」（D20）。
 *  - 載入中、讀不到由呼叫端處理（總覽的 `TodayBudgetCard`），這裡一定有 `stats`。 */
export function BudgetSummary({ stats }: { stats: DailyStats }) {
	const budget = kcalBudgetOf(stats);
	const added = exerciseInBudgetOf(stats);
	const eaten = roundForDisplay(stats.actual.kcal, 0);
	const balance = budget === null ? null : kcalBalance(budget, stats.actual.kcal);
	const tone: RingTone =
		balance === null ? "none" : balance.over ? "over" : "normal";
	// `target` 整個是 null＝今天沒有目標：三列都是「未設定」（MacroBar 的 target 傳 null）。
	const target = stats.target;

	return (
		<div>
			<div className={styles.top}>
				<div className={styles.ringBox}>
					<CalorieRing
						ratio={budget === null ? null : ratioOf(stats.actual.kcal, budget)}
						tone={tone}
					/>
					{/* 三段之間的空白是念出來的一部分：「還能吃 843 kcal」。 */}
					<p
						data-tone={tone}
						className={
							tone === "over" ? `${styles.center} ${styles.centerOver}` : styles.center
						}
					>
						<span className={styles.centerLabel}>
							{balance === null ? "已吃" : balance.over ? "超過" : "還能吃"}
						</span>{" "}
						<span className={styles.centerNumber}>
							{balance === null ? eaten : balance.amount}
						</span>{" "}
						<span className={styles.centerUnit}>kcal</span>
					</p>
				</div>
				<div className={styles.macros}>
					<MacroBar
						field="protein_g"
						label="蛋白質"
						actual={stats.actual.protein_g}
						target={target?.protein_g ?? null}
					/>
					<MacroBar
						field="fat_g"
						label="脂肪"
						actual={stats.actual.fat_g}
						target={target?.fat_g ?? null}
					/>
					<MacroBar
						field="carb_g"
						label="碳水"
						actual={stats.actual.carb_g}
						target={target?.carb_g ?? null}
					/>
				</div>
			</div>
			{budget === null ? (
				<div className={styles.noTarget}>
					<p className={styles.line}>還沒有每日目標</p>
					{/* 直接到表單（建議目標也在那一頁），不繞身體與目標（D20）。 */}
					<Link to="/me/targets" className={styles.link}>
						設定每日目標
					</Link>
				</div>
			) : (
				// 「・」放在前一段的尾巴：放在下一段開頭的話段與段之間沒有地方換行（handover §7）。
				<p className={styles.line}>
					<span className={styles.nowrap}>已吃 {eaten}・</span>
					<span className={styles.nowrap}>預算 {roundForDisplay(budget, 0)}</span>
					{added !== null && (
						<span className={styles.nowrap}>
							（含運動 +{roundForDisplay(added, 0)}）
						</span>
					)}
				</p>
			)}
		</div>
	);
}
```

- [ ] **Step 9：`components/BudgetSummary.module.css`。**

```css
/* 總覽的熱量卡片內容（BudgetSummary.tsx；首頁改版規格 §3.1）。
   圓環 132px 與營養素同一列；寬度不夠（約 340px 以下）時營養素換到下面。 */

.top {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	gap: var(--space-4);
}

.ringBox {
	position: relative;
	flex: none;
	width: 132px;
	height: 132px;
}

/* 疊在圓環正中間的字。是真的文字（圓環是 aria-hidden）。 */
.center {
	position: absolute;
	inset: 0;
	margin: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	text-align: center;
	font-variant-numeric: tabular-nums;
}

.centerLabel,
.centerUnit {
	font-size: 12px;
	color: var(--color-text-muted);
}

.centerNumber {
	font-size: var(--font-size-total);
	font-weight: 700;
	line-height: 1.2;
	overflow-wrap: anywhere;
}

/* 超過：字也是危險色（不只靠圓環的顏色）。寫在上面兩條之後，權重 (0,2,0) 也比較高。 */
.centerOver .centerLabel,
.centerOver .centerNumber {
	color: var(--color-danger);
}

.macros {
	flex: 1 1 160px;
	min-width: 0;
}

.line {
	margin: var(--space-3) 0 0;
	font-size: 14px;
	color: var(--color-text-muted);
	font-variant-numeric: tabular-nums;
}

.nowrap {
	white-space: nowrap;
}

.noTarget {
	display: flex;
	flex-wrap: wrap;
	align-items: center;
	column-gap: var(--space-3);
}

.noTarget .line {
	margin: 0;
}

.link {
	display: inline-flex;
	align-items: center;
	min-height: 44px;
	color: var(--color-action);
	font-weight: 600;
}
```

  `.noTarget` 在 `.top` 下面要有距離：`.noTarget { margin-top: var(--space-2); }`（加進上面那條）。

- [ ] **Step 10：跑** → 三個檔案 PASS（decimal 多 8 格、calorie-ring 10、budget-summary 8）。再跑 `npm run -s typecheck`、`npm run -s lint`。

- [ ] **Step 11：突變**（`$S/home-mut-t1.json`；`tests` 填這三個檔案）：
  1. `kcalBalance`：`diff.lessThan(0)` → `diff.lessThanOrEqualTo(0)` → 紅「2000.4」「2000」兩格。
  2. `kcalBalance`：拿掉 `.toDecimalPlaces(0, Decimal.ROUND_HALF_UP)` → 紅「1523.4」「2000.4」。
  3. `kcalBalance`：`ROUND_HALF_UP` → `ROUND_HALF_EVEN` → 紅「732.5」。
  4. `ringDasharray`：`Math.max(ratio, 0)` → `ratio` → 紅 `-0.2`。
  5. `ringDasharray`：`Math.min(…, 1)` 拿掉 → 紅 `1.3`。
  6. `CalorieRing`：`tone === "over" ? 1 : ratio` → `ratio` → 紅「超過：畫滿」與 budget-summary 2。
  7. `CalorieRing`：拿掉 `aria-hidden="true"` → 紅第一條。
  8. `BudgetSummary`：`kcalBudgetOf(stats)` → `stats.target?.kcal ?? null` → 紅 1（預算 2343）。
  9. `BudgetSummary`：`added !== null &&` → `true &&`（用 `added ?? "0"`）→ 紅 5、6。
  10. `BudgetSummary`：`to="/me/targets"` → `to="/me/health"` → 紅 7。
  11. `BudgetSummary`：中間的 `{" "}` 拿掉一個 → 紅 1（「還能吃843 kcal」）。

- [ ] **Step 12：Commit。** `git add frontend/src/lib/decimal.ts frontend/src/components/CalorieRing.tsx frontend/src/components/CalorieRing.module.css frontend/src/components/BudgetSummary.tsx frontend/src/components/BudgetSummary.module.css frontend/tests/decimal.test.ts frontend/tests/calorie-ring.test.tsx frontend/tests/budget-summary.test.tsx`；
  訊息 `feat(frontend): 熱量圓環與「還能吃／超過」的卡片內容（首頁改版 Task 1）`。

---

## Task 1B：體重圖的共用幾何（`lib/weight-plot.ts`）與 `/weight` 的折線圖

**Files:** `frontend/src/lib/weight-plot.ts`（新）、`components/WeightChart.tsx`、`src/index.css`、`screens/Weight.{tsx,module.css}`；
`frontend/tests/weight-plot.test.ts`（新）、`tests/{weight-chart,weight}.test.tsx`

規格 D21、D24、§3.5。**先重構、再加線**：Step 1–4 是純重構（`weight-chart.test.tsx` 既有的 7 條一個字都不改、全部要綠），Step 5 之後才加新的線。

- [ ] **Step 1：`tests/weight-plot.test.ts`。**

```ts
import { describe, expect, it } from "vitest";
import { polylinePoints, weightScale } from "../src/lib/weight-plot";

const AREA = { left: 10, right: 110, top: 0, bottom: 40 };

describe("weightScale（首頁改版規格 D21）", () => {
	it("x 照日期：起點在左、終點在右、中間照天數比例（不是照第幾筆）", () => {
		const scale = weightScale(["80"], "1", "2026-10-01", "2026-10-11", AREA);
		if (scale === null) throw new Error("應該有比例尺");
		expect(scale.x("2026-10-01")).toBeCloseTo(10);
		expect(scale.x("2026-10-11")).toBeCloseTo(110);
		expect(scale.x("2026-10-04")).toBeCloseTo(10 + (3 / 10) * 100);
	});

	it("起點就是終點：不除以零，畫在左邊界", () => {
		const scale = weightScale(["80"], "1", "2026-10-01", "2026-10-01", AREA);
		expect(scale?.x("2026-10-01")).toBeCloseTo(10);
	});

	it("y：範圍是 paddedExtent（各往外 pad、取整），重的在上面", () => {
		const scale = weightScale(["78", "80"], "1", "2026-10-01", "2026-10-02", AREA);
		if (scale === null) throw new Error("應該有比例尺");
		expect([scale.lo, scale.hi]).toEqual(["77", "81"]);
		expect(scale.y("81")).toBeCloseTo(0);
		expect(scale.y("77")).toBeCloseTo(40);
		expect(scale.y("80")).toBeCloseTo(40 * (1 - 3 / 4));
	});

	it("範圍是 0（pad 0、值都一樣）：畫在正中間；沒有值是 null", () => {
		const flat = weightScale(["80", "80"], "0", "2026-10-01", "2026-10-02", AREA);
		expect(flat?.y("80")).toBeCloseTo(20);
		expect(weightScale([], "1", "2026-10-01", "2026-10-02", AREA)).toBeNull();
	});
});

describe("polylinePoints", () => {
	it("照傳進來的順序，每一點「x,y」、空白隔開", () => {
		const scale = { x: (date: string) => Number(date.slice(8)), y: (kg: string) => Number(kg) };
		expect(
			polylinePoints(
				[
					{ date: "2026-10-01", weight_kg: "80" },
					{ date: "2026-10-05", weight_kg: "79.5" },
				],
				scale,
			),
		).toBe("1,80 5,79.5");
		expect(polylinePoints([], scale)).toBe("");
	});
});
```

- [ ] **Step 2：跑，看它紅** → `npx vitest run tests/weight-plot.test.ts`。Expected: FAIL（模組不存在）。

- [ ] **Step 3：`lib/weight-plot.ts`。**

```ts
import { daysBetween } from "./civil-date";
import { type Numeric, paddedExtent, positionIn } from "./decimal";
import type { WeightPoint } from "./weights";

/** 畫圖的那一塊（viewBox 座標）：`left`／`right` 是 x 的起訖，`top`／`bottom` 是 y 的上下。 */
export type PlotArea = { left: number; right: number; top: number; bottom: number };

export type WeightScale = {
	lo: Numeric;
	hi: Numeric;
	x: (date: string) => number;
	y: (value: Numeric) => number;
};

/** 體重圖的座標換算（首頁改版規格 D21）：`/weight` 的 `WeightChart` 與總覽的迷你折線共用。
 *
 *  - **x 照日期**（`daysBetween`），不是照第幾筆：記錄的日子不連續，照索引平均分配會把一週的空白畫成跟一天一樣寬。
 *    起點就是終點時除數是 1——點畫在左邊界，不除以零。
 *  - **y 經過 `lib/decimal.ts`**：範圍是 `paddedExtent(values, pad)`（各往外 `pad`、取整），比例是 `positionIn`；這裡只把 0–1 的比例
 *    換成座標（`number` 只用在座標，同 `TrendChart`）。重的在上面。
 *  - `values` 是空的回 `null`（沒有東西可畫）。 */
export function weightScale(
	values: readonly Numeric[],
	pad: Numeric,
	start: string,
	end: string,
	area: PlotArea,
): WeightScale | null {
	const extent = paddedExtent(values, pad);
	if (extent === null) return null;
	const days = Math.max(daysBetween(start, end), 1);
	const width = area.right - area.left;
	const height = area.bottom - area.top;
	return {
		lo: extent.lo,
		hi: extent.hi,
		x: (date) => area.left + (daysBetween(start, date) / days) * width,
		y: (value) =>
			area.top + height * (1 - positionIn(value, extent.lo, extent.hi)),
	};
}

/** `<polyline points>`：照傳進來的順序（由舊到新），每一點「x,y」。 */
export function polylinePoints(
	points: readonly WeightPoint[],
	scale: Pick<WeightScale, "x" | "y">,
): string {
	return points
		.map((point) => `${scale.x(point.date)},${scale.y(point.weight_kg)}`)
		.join(" ");
}
```

  算式的順序跟 `WeightChart` 原本的 `x`、`y` 閉包一樣（`PLOT_LEFT + (d / days) * plotWidth`；`0 + VIEW_HEIGHT * (1 - p)`）——浮點數逐位元相同，既有測試的 `toBeCloseTo` 不受影響。

- [ ] **Step 4：`components/WeightChart.tsx` 改用它（純重構）**：拿掉 `daysBetween`、`paddedExtent`、`positionIn` 的 import（`formatCivilDate`、`formatMacro`、`Numeric` 照留），
  import `polylinePoints`、`weightScale`；`extent`／`days`／`plotWidth`／`x`／`y`／`line` 那一段換成：

```tsx
	const scale = weightScale(values, AXIS_PAD_KG, start, end, {
		left: PLOT_LEFT,
		right: VIEW_WIDTH - PAD_X,
		top: 0,
		bottom: VIEW_HEIGHT,
	});
	if (scale === null) return null;
	const { x, y } = scale;
	const averageLine = polylinePoints(shownAverage, scale);
```

  `{extent.hi}`／`{extent.lo}` → `{scale.hi}`／`{scale.lo}`；`line` → `averageLine`。檔頭說明的「幾何」那一段改成「座標換算在 `lib/weight-plot.ts`（跟總覽的迷你折線共用）」。
  跑 `npx vitest run tests/weight-chart.test.tsx tests/weight.test.tsx tests/weight-plot.test.ts` → **全部綠、既有的測試沒改**。

- [ ] **Step 5：新的測試**：
  - `tests/weight-chart.test.tsx` 加（用檔案既有的 `chart()`、`points()`、`attr()`）：
    1. 「每天的紀錄連成實線：照日期由舊到新，每一組座標就是那一點的 cx／cy」：`points("weight-line")` 長度 3，第 i 組＝`[attr("weight-point-<日期>", "cx"), attr(…, "cy")]`
       （日期照 `entries` 的順序）。
    2. 「沒記的日子照樣連起來（x 照日期）」：同一份資料，`weight-line` 只有一條（`getAllByTestId` 長度 1），第二組的 x 是 `PLOT_LEFT + (7 / 13) * (RIGHT - PLOT_LEFT)`。
    3. 「只有一筆：沒有線，只有那一點」：`chart({ entries: [一筆], average: movingAverage([一筆]), start: 那天, end: 那天 })` → `queryByTestId("weight-line")` 是 null、點在。
    4. 「線與平均都是裝飾；畫的順序是 平均 → 每天的線 → 點（點在最上面）」：兩條 `aria-hidden="true"`；`weight-line` 有 `weight-line` 的 class、`weight-average` 有 `weight-average`
       （全域 class，`index.css`）；`compareDocumentPosition`：平均在線之前、線在第一個點之前。
  - `tests/weight.test.tsx` 加：
    5. 「圖例：每天的紀錄、7 天平均，色塊是裝飾」：`weight-chart-card` 裡 `getByText("每天的紀錄")`、`getByText("7 天平均")`；圖例裡的兩個色塊 `aria-hidden="true"`。
    6. 「切期間：線只連範圍內的點」：用一份跨過 30 天的資料，切到 30 天 → `weight-line` 的組數＝`dots()` 的個數。

- [ ] **Step 6：跑，看它紅** → Expected: FAIL（沒有 `weight-line`；圖例的色塊還是舊的、可能已經綠——綠的那條照實記，它守的是之後別改壞）。

- [ ] **Step 7：`WeightChart.tsx` 加每天的線**：`averageLine` 下面加

```tsx
	// 每天的紀錄連成實線（規格 D24）：照日期由舊到新，沒記的日子照樣連起來（x 照日期，跨過的那一段本身就看得出中間沒有點）。
	// 一筆畫不成線。
	const dailyLine = entries.length >= 2 ? polylinePoints(entries, scale) : "";
```

  在平均線的 `<polyline>` **後面**、點的 `entries.map` **前面**：

```tsx
			{dailyLine !== "" && (
				// biome-ignore lint/a11y/noAriaHiddenOnFocusable: SVG <polyline> 不能聚焦（同平均線）；線是裝飾，資料在每個點的名稱裡
				<polyline
					data-testid="weight-line"
					className="weight-line"
					points={dailyLine}
					aria-hidden="true"
				/>
			)}
```

  平均線那一行註解改「7 天平均：淡色虛線（規格 D24）」。

- [ ] **Step 8：`src/index.css`**（體重圖那一段）：`.weight-average` 換成、`.weight-line` 新增（只用變數；`opacity` 不是色碼）：

```css
/* 每天的紀錄連成的實線（首頁改版規格 D24）：跟點同色，點畫在它上面。 */
.weight-line {
	fill: none;
	stroke: var(--color-accent);
	stroke-width: 2;
	stroke-linejoin: round;
	stroke-linecap: round;
}

/* 7 天平均：淡色虛線——實線是真的紀錄，虛線是算出來的。 */
.weight-average {
	fill: none;
	stroke: var(--color-action);
	stroke-width: 1.5;
	stroke-dasharray: 4 3;
	stroke-linejoin: round;
	opacity: 0.6;
}
```

  檔頭那一行「點、7 天移動平均、刻度、底線」改「點、每天的線、7 天平均（虛線）、刻度、底線」。

- [ ] **Step 9：圖例**：`screens/Weight.tsx` 的圖例改成（字不變，換色塊的 class）：

```tsx
						<p className={styles.legend}>
							<span className={styles.swatchDaily} aria-hidden="true" />
							每天的紀錄
							<span className={styles.swatchAverage} aria-hidden="true" />7 天平均
						</p>
```

  `screens/Weight.module.css`：`.swatchPoint`、`.swatchLine` 換成

```css
/* 「每天的紀錄」：實線＋中間一個點（同圖上的樣子）。 */
.swatchDaily {
	position: relative;
	display: inline-block;
	width: 16px;
	height: 2px;
	background: var(--color-accent);
}

.swatchDaily::after {
	content: "";
	position: absolute;
	top: 50%;
	left: 50%;
	width: 8px;
	height: 8px;
	margin: -4px 0 0 -4px;
	border-radius: 50%;
	background: var(--color-accent);
}

/* 「7 天平均」：淡色虛線（同 index.css 的 .weight-average）。 */
.swatchAverage {
	display: inline-block;
	width: 16px;
	margin-left: var(--space-2);
	border-top: 2px dashed var(--color-action);
	opacity: 0.6;
}
```

- [ ] **Step 10：跑** → 三個檔案 PASS（weight-plot 5、weight-chart 7＋4、weight 既有＋2）；整套、`typecheck`、`lint`。

- [ ] **Step 11：突變**（`$S/home-mut-t1b.json`）：
  1. `weightScale`：`(1 - positionIn(…))` → `positionIn(…)` → 紅 weight-plot 的 y，**也紅 weight-chart 既有的「重的在上面」**（證明 `WeightChart` 真的接上了共用的幾何）。
  2. `weightScale`：`daysBetween(start, date)` → `daysBetween(start, date) + 1` → 紅 x 的幾條。
  3. `weightScale`：`Math.max(…, 1)` 拿掉 → 紅「起點就是終點」。
  4. `WeightChart`：`polylinePoints(entries, scale)` → `polylinePoints(shownAverage, scale)` → 紅 1。
  5. `WeightChart`：`entries.length >= 2` → `>= 1` → 紅 3。
  6. `WeightChart`：每天的線搬到點的後面 → 紅 4。
  7. `Weight.tsx`：圖例的 `swatchDaily` 的 `aria-hidden` 拿掉 → 紅 5。

- [ ] **Step 12：Commit。** `git add frontend/src/lib/weight-plot.ts frontend/src/components/WeightChart.tsx frontend/src/index.css frontend/src/screens/Weight.tsx frontend/src/screens/Weight.module.css frontend/tests/weight-plot.test.ts frontend/tests/weight-chart.test.tsx frontend/tests/weight.test.tsx`；
  訊息 `feat(frontend): 體重圖的座標換算抽成共用的 weight-plot；/weight 改成折線圖（實線＋點、7 天平均虛線）（首頁改版 Task 1B）`。

  **注意**：Task 3 也改 `Weight.tsx`（`focusForm`）與 `weight.test.tsx`；照順序做不會衝突。

---

## Task 2：總覽的版面、圓環卡片、兩張小卡片

**Files:** `frontend/src/screens/Overview.{tsx,module.css}`、`frontend/src/components/WeightSparkline.{tsx,module.css}`（新）；
`frontend/tests/overview.test.tsx`、`tests/weight-sparkline.test.tsx`（新）

- [ ] **Step 0：迷你折線（規格 D22、D23）**——先做元件，Step 4 再放進體重小卡片。
  - `tests/weight-sparkline.test.tsx`：

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeightSparkline } from "../src/components/WeightSparkline";

const e = (date: string, weight_kg: string) => ({ date, weight_kg });

/** `points="x1,y1 x2,y2 …"` → [[x1, y1], …]。 */
function pairs(): number[][] {
	return (screen.getByTestId("weight-sparkline-line").getAttribute("points") ?? "")
		.split(" ")
		.map((pair) => pair.split(",").map(Number));
}

describe("WeightSparkline（首頁改版規格 D22）", () => {
	it("兩筆：一條線、第一筆在左、最後一筆在右、重的在上面；整張是裝飾", () => {
		const { container } = render(
			<WeightSparkline
				today="2026-10-30"
				entries={[e("2026-10-27", "80"), e("2026-10-30", "79.4")]}
			/>,
		);
		expect(container.querySelector("svg")).toHaveAttribute("aria-hidden", "true");
		expect(screen.getByTestId("weight-sparkline")).toBeInTheDocument();
		// y 範圍 78–81（各往外 0.5、取整）；畫圖區 2–30（上下各留 2）。
		const [first, last] = pairs();
		expect(first?.[0]).toBeCloseTo(2);
		expect(last?.[0]).toBeCloseTo(98);
		expect(first?.[1]).toBeCloseTo(2 + 28 * (1 - 2 / 3));
		expect(last?.[1]).toBeCloseTo(2 + 28 * (1 - 1.4 / 3));
	});

	it("只畫最近 30 天（今天 − 29 起）：更早的不算", () => {
		render(
			<WeightSparkline
				today="2026-10-30"
				entries={[
					e("2026-09-30", "90"),
					e("2026-10-01", "80"),
					e("2026-10-30", "79"),
				]}
			/>,
		);
		expect(pairs()).toHaveLength(2);
	});

	it("最近 30 天只有 0 或 1 筆：不畫（只有字）", () => {
		const { container, rerender } = render(
			<WeightSparkline today="2026-10-30" entries={[]} />,
		);
		expect(container).toBeEmptyDOMElement();
		rerender(
			<WeightSparkline
				today="2026-10-30"
				entries={[e("2026-09-01", "80"), e("2026-10-30", "79")]}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
```

  - `components/WeightSparkline.tsx`：

```tsx
import { polylinePoints, weightScale } from "../lib/weight-plot";
import { entriesInSpan, type WeightPoint } from "../lib/weights";
import styles from "./WeightSparkline.module.css";

/** viewBox：寬 100、高 32，上下左右各留 2（線的圓頭不被切掉）。畫出來的寬度跟著卡片、高度固定 32px。 */
const VIEW_WIDTH = 100;
const VIEW_HEIGHT = 32;
const INSET = 2;
const PAD_KG = "0.5";
export const SPARKLINE_DAYS = 30;

type Props = {
	/** `GET /api/weights` 的紀錄（由舊到新）。 */
	entries: readonly WeightPoint[];
	/** 後端給的今天：「最近 30 天」從它往回算（前端不算今天）。 */
	today: string;
};

/** 總覽體重小卡片的迷你折線（首頁改版規格 D22）。**整張是裝飾**（`aria-hidden`）：最新一筆與比 7 天前是旁邊的字。
 *
 *  - 最近 30 天（`entriesInSpan`）少於 2 筆不畫——一筆畫不成線。
 *  - x 從這 30 天裡的**第一筆到最後一筆**（不是從 30 天前）：只記了最近幾天時線不會擠在右邊；它沒有軸、沒有刻度。
 *  - 座標換算跟 `/weight` 的圖同一份（`lib/weight-plot.ts`，D21）。
 *  - `preserveAspectRatio="none"`：寬度跟著卡片拉伸；線寬用 `vector-effect: non-scaling-stroke`，拉伸不會變粗。 */
export function WeightSparkline({ entries, today }: Props) {
	const recent = entriesInSpan(entries, today, SPARKLINE_DAYS).entries;
	const first = recent[0];
	const last = recent.at(-1);
	if (recent.length < 2 || first === undefined || last === undefined) {
		return null;
	}
	const scale = weightScale(
		recent.map((entry) => entry.weight_kg),
		PAD_KG,
		first.date,
		last.date,
		{ left: INSET, right: VIEW_WIDTH - INSET, top: INSET, bottom: VIEW_HEIGHT - INSET },
	);
	if (scale === null) return null;

	return (
		<svg
			className={styles.sparkline}
			viewBox={`0 0 ${VIEW_WIDTH} ${VIEW_HEIGHT}`}
			preserveAspectRatio="none"
			aria-hidden="true"
			focusable="false"
			data-testid="weight-sparkline"
		>
			<polyline
				data-testid="weight-sparkline-line"
				className={styles.line}
				points={polylinePoints(recent, scale)}
			/>
		</svg>
	);
}
```

  - `components/WeightSparkline.module.css`：

```css
/* 總覽體重小卡片的迷你折線（WeightSparkline.tsx；首頁改版規格 D22）。390px 寬時卡片內容約 140px：寬度跟著卡片、高度固定。 */

.sparkline {
	display: block;
	width: 100%;
	height: 32px;
	margin-top: var(--space-1);
}

.line {
	fill: none;
	stroke: var(--color-accent);
	stroke-width: 2;
	stroke-linejoin: round;
	stroke-linecap: round;
	vector-effect: non-scaling-stroke;
}
```

  跑 `npx vitest run tests/weight-sparkline.test.tsx`：先紅（元件不存在）、寫完 PASS（3 條）。
  數字：`entriesInSpan(…, "2026-10-30", 30)` 的起點是 `2026-10-01`（今天 − 29），所以 `2026-09-30` 不算——這就是第二條的邊界。

- [ ] **Step 1：改 `tests/overview.test.tsx` 既有的測試**（規格 §9.1）：
  - import `NO_WEIGHTS` from `./helpers/body-routes`；`mockOverview` 的預設多一行 `"/api/weights": () => json(NO_WEIGHTS),`（跟其他路徑互不包含）。
    「離線」那一條的 `seed` 多 `seed(queryKeys.weights, NO_WEIGHTS);`（不然體重是「失敗而且沒有資料」，那一條本來就不看它，但 `/無法載入/` 那一行會紅）。
  - 「顯示本月支出與今天熱量」：多斷言 `expect(kcal).toHaveTextContent("還能吃 760 kcal")`、`toHaveTextContent("已吃 1240・預算 2000")`（`/1240/`、`/2000/` 留著）。
  - 「有目標時畫熱量進度條」→ 改名「有目標時畫圓環（裝飾）」：`within(kcal).getByTestId("calorie-ring-arc")` 的 `data-tone` 是 `normal`，
    `kcal.querySelector("svg")` 有 `aria-hidden="true"`，`queryByRole("progressbar", { name: "熱量進度" })` 不在。
  - `it.each` 沒有目標的兩格 → 改名「%s：還沒有每日目標，有『設定每日目標』，沒有『/』也沒有圓弧」：`findByText("還沒有每日目標")`、連結 `href="/me/targets"`、
    `not.toHaveTextContent("/")`、沒有 `calorie-ring-arc`、沒有 `progressbar`。
  - 運動那三條：`findByText("/ 2343 kcal")` → `await waitFor(() => expect(kcal).toHaveTextContent("預算 2343"))`；「含運動 +343」→「（含運動 +343）」；
    進度條的 `toBeCloseTo(1240 / 2343, 5)` → `calorie-ring-arc` 的 `stroke-dasharray` 是 `ringDasharray(1240 / 2343)`（import 它）——比例的來源照樣是額度；
    兩條「/ 2000 kcal」→「預算 2000」，`not.toHaveTextContent("含運動")` 留著。

- [ ] **Step 2：新的測試**（同一個檔案，`describe("總覽：圓環卡片與小卡片（首頁改版規格 §3）")`）：
  1. 圓環卡片是 `region`「今天熱量」，`data-testid="today-kcal"` 在它上面（`screen.getByRole("region", { name: "今天熱量" })` 的 `dataset.testid`）。
  2. 超過：`stats` 的 `actual.kcal` 是 `"2400.00"`、`kcal_budget` 是 `"2343.00"` →「超過 57 kcal」、`data-tone` `over`。
  3. 本月支出是連到 `/reports` 的連結：`within(spend).getByRole("link")` 的 `href`，名稱含 `$12480.00`。
  4. 體重：`/api/weights` 回 `{ today: "2026-10-14", entries: [{2026-10-07, "80.00"}, {2026-10-10, "79.60"}, {2026-10-14, "79.00"}] }`（跟 `me.test.tsx` 的 `WEIGHTS` 一樣）→
     `weight-glance` 含「79 公斤」「比 7 天前 -1 公斤」，連結 `href="/weight"`；卡片裡有 `weight-sparkline`（三筆都在 30 天內）、`aria-hidden`，
     連結的可及名稱裡沒有多出東西（`getByRole("link", { name: "體重 79 公斤 比 7 天前 -1 公斤" })`——照實際的空白調整，重點是線不進名稱）。
     另一格：只有一筆 → 有「79 公斤」、**沒有** `weight-sparkline`。
  5. 沒有體重：「記錄體重」、沒有 `weight-sparkline`，**點了帶著 `{weightForm: true}` 到 `/weight`**——用 `Routes`：`/` 是 `<Overview />`、`/weight` 是一個印出 `useLocation().state` 的元件，
     點連結之後印出 `{"weightForm":true}`（Task 3 才有 `WEIGHT_FORM_STATE`：這一條先寫死 `{ weightForm: true }`，Task 3 改 import）。
  6. 體重讀不到（500、沒有快取）：「無法載入體重」，時間線照常（`timeline-row` 兩列）。
  7. 只有體重重抓失敗、手上有資料：離線提示出現（同運動那一條的寫法，`client.setQueryData(queryKeys.weights, …)`）。
  8. DOM 順序：`today-kcal` 在 `month-spend` 前面，`month-spend` 在 `weight-glance` 前面，`weight-glance` 在 `heading「今天」` 前面（`compareDocumentPosition`）。
  9. stats 讀不到（500、沒有快取）：圓環卡片說「無法載入今天的熱量」（`within(getByTestId("today-kcal"))`），沒有 `calorie-ring-arc`。

- [ ] **Step 3：跑，看它紅** → `npx vitest run tests/overview.test.tsx`。Expected: FAIL（新的字、region、`weight-glance` 都還沒有）。

- [ ] **Step 4：`screens/Overview.tsx`。**
  - import：拿掉 `RatioProgress`、`exerciseInBudgetOf`、`kcalBudgetOf`、`ratioOf`；加 `useWeights`（`../api/body`）、`BudgetSummary`、`WeightSparkline`、`formatMacro`、
    `signedKg`／`weekChange`（`../lib/weights`）。資料**沿用 `useWeights()`**（`["body","weights"]`、800 天、進離線快取），迷你折線自己篩 30 天——不加 query key（D23）。
  - `MonthSpendCard` 換成：

```tsx
/** 本月支出（規格 D12）：整塊是連到報表的連結。字樣照舊「本月支出」。 */
function MonthSpendCard() {
	const summaryQuery = useExpenseSummary(null);
	const summary = summaryQuery.data;

	return (
		<Card testId="month-spend">
			<Link to="/reports" className={styles.glance}>
				<span className={styles.label}>本月支出</span>
				{summaryQuery.isPending ? (
					<span>載入中…</span>
				) : summary != null ? (
					<span className={styles.total}>${formatMoney(summary.total)}</span>
				) : (
					<span>無法載入本月支出</span>
				)}
			</Link>
		</Card>
	);
}
```

  - `TodayKcalCard` 換成：

```tsx
/** 今天熱量（首頁改版規格 §3）：圓環、三大營養素、已吃・預算。`data-testid="today-kcal"` 沿用（意義變成整張卡片，D7）。
 *  資料優先於錯誤：重抓失敗時照樣顯示快取，離線提示由頂端那一條負責。 */
function TodayBudgetCard() {
	const statsQuery = useDailyStats();
	const stats = statsQuery.data;

	return (
		<section
			aria-labelledby="overview-budget"
			data-testid="today-kcal"
			className={styles.budgetCard}
		>
			<h2 id="overview-budget" className={`${ui.sectionTitle} ${styles.budgetTitle}`}>
				今天熱量
			</h2>
			{statsQuery.isPending ? (
				<p>載入中…</p>
			) : stats == null ? (
				<p>無法載入今天的熱量</p>
			) : (
				<BudgetSummary stats={stats} />
			)}
		</section>
	);
}

/** 體重（規格 D12）：最新一筆、比 7 天前（同「身體與目標」的體重卡片，`lib/weights.ts`），整塊連到 `/weight`。
 *  沒有紀錄：「記錄體重」，跟快速記錄的記體重同一個去處（焦點放在體重欄位，D11）。 */
function WeightGlanceCard() {
	const weights = useWeights();
	const data = weights.data;
	const latest = data?.entries.at(-1);
	const change = data == null ? null : weekChange(data.entries);
	const empty = data != null && latest === undefined;

	return (
		<Card testId="weight-glance">
			<Link
				to="/weight"
				state={empty ? { weightForm: true } : undefined}
				className={styles.glance}
			>
				<span className={styles.label}>體重</span>
				{weights.isPending ? (
					<span>載入中…</span>
				) : data == null ? (
					<span>無法載入體重</span>
				) : latest === undefined ? (
					<span className={styles.action}>記錄體重</span>
				) : (
					<>
						<span className={styles.total}>{formatMacro(latest.weight_kg)} 公斤</span>
						{change !== null && (
							<span className={styles.sub}>
								比 7 天前 {signedKg(change.change)} 公斤
							</span>
						)}
						{/* 最近 30 天的迷你折線（D22）：裝飾，不進連結的名稱；少於 2 筆它自己不畫。 */}
						<WeightSparkline entries={data.entries} today={data.today} />
					</>
				)}
			</Link>
		</Card>
	);
}
```

  - `OfflineBanner`：多 `const weightsQuery = useWeights();`，放進 `stale` 的陣列。註解「任何一個 query」照舊。
  - `Overview` 的 return 裡 `layout.columns` 那一段換成：

```tsx
			{/* 手機往下排、電腦版左欄（首頁改版規格 §3.1）：圓環 → 快速記錄（Task 3）→ 兩張小卡片並排；右欄是時間線。 */}
			<div className={layout.columns}>
				<div className={styles.left}>
					<TodayBudgetCard />
					<div className={styles.cards}>
						<MonthSpendCard />
						<WeightGlanceCard />
					</div>
				</div>
				<TodayTimeline />
			</div>
```

  - 檔頭與 `Overview` 的說明註解改成新的內容（總覽：圓環、快速記錄、兩張小卡片、時間線；各自處理載入與錯誤）。

- [ ] **Step 5：`screens/Overview.module.css`**：
  - 拿掉 `:global(.app-desktop) .cards { grid-template-columns: minmax(0, 1fr); }`（左欄約 420px，兩張並排放得下，規格 §3.1）與它的註解；
    拿掉不再用的 `.progress`、`.budgetNote`。
  - 加：

```css
/* 圓環卡片 → 快速記錄 → 兩張小卡片（首頁改版規格 §3.1）。手機是頁面的上半部，電腦版是左欄。
   間距由這裡管，子元素自己的 margin 歸零（Card 有上下 margin）。 */
.left {
	display: flex;
	flex-direction: column;
	gap: var(--space-3);
}

.left > * {
	margin: 0;
}

/* 圓環卡片是 <section>（要 region 的名稱），外觀同 Card。 */
.budgetCard {
	padding: var(--space-3) var(--space-4);
	border-radius: var(--radius-card);
	background: var(--color-surface);
}

.budgetTitle {
	margin: 0 0 var(--space-2);
}

/* 小卡片的整塊連結（本月支出、體重）。 */
.glance {
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
	min-height: 44px;
	color: inherit;
	text-decoration: none;
}

.sub {
	font-size: 12px;
	color: var(--color-text-muted);
	font-variant-numeric: tabular-nums;
}

.action {
	color: var(--color-action);
	font-weight: 600;
}
```

  `.label` 原本是 `<p>` 的 margin：在 flex 欄裡 `<span>` 的 margin 照樣生效，留著；`.gap` 與 `.label` 的 margin 疊起來太鬆就把 `.label` 的 margin 改 0（看截圖決定，Task 8）。

- [ ] **Step 6：跑** → `npx vitest run tests/overview.test.tsx` PASS（既有的條數＋8）。整套 `npm run -s test`（`app.test.tsx` 的 `mockBackend` 已經有 `/api/weights`）、
  `typecheck`、`lint`。

- [ ] **Step 7：突變**（`tests/overview.test.tsx`）：
  1. `TodayBudgetCard`：「無法載入今天的熱量」→「載入中…」→ 紅 9。
  2. `WeightGlanceCard`：拿掉 `change !== null &&` 那一段 → 紅 4。
  3. `WeightGlanceCard`：`state={empty ? … : undefined}` → `state={undefined}` → 紅 5。
  4. `OfflineBanner`：陣列拿掉 `weightsQuery` → 紅 7。
  5. `MonthSpendCard`：`to="/reports"` → `to="/"` → 紅 3。
  6. `Overview`：`<WeightGlanceCard />` 移到 `<TodayTimeline />` 後面（`layout.columns` 的第三個子元素）→ 紅 8。
  7. `WeightSparkline`：`recent.length < 2` → `recent.length < 1` → 紅 weight-sparkline「0 或 1 筆」、overview「只有一筆」。
  8. `WeightSparkline`：`SPARKLINE_DAYS = 30` → `31` → 紅「只畫最近 30 天」。
  9. `WeightSparkline`：`first.date` → 傳 `shiftDays(today, -29)`（從 30 天前畫起）→ 紅第一條的 x。
  10. `WeightSparkline`：拿掉 `aria-hidden="true"` → 紅第一條。

- [ ] **Step 8：Commit。** `git add frontend/src/screens/Overview.tsx frontend/src/screens/Overview.module.css frontend/src/components/WeightSparkline.tsx frontend/src/components/WeightSparkline.module.css frontend/tests/overview.test.tsx frontend/tests/weight-sparkline.test.tsx`；
  訊息 `feat(frontend): 總覽換成熱量圓環，本月支出與體重兩張小卡片並排（首頁改版 Task 2）`。

---

## Task 3：快速記錄與交接（拍照記、掃條碼、記運動、記體重）

**Files:** `frontend/src/lib/quick-actions.ts`（新）、`components/QuickActions.{tsx,module.css}`（新）、`components/IconBadge.tsx`、`screens/Overview.tsx`、
`screens/LogMeal.tsx`、`components/{AiMealPanel,FoodPicker,BarcodeScanEntry}.tsx`、`screens/Weight.tsx`、`App.tsx`；
`frontend/tests/quick-actions.test.ts`（新）、`tests/{overview,log-meal-ai,log-meal-barcode,weight,app}.test.tsx`

- [ ] **Step 1：`tests/quick-actions.test.ts`。**

```ts
import { describe, expect, it } from "vitest";
import {
	quickPhotoFrom,
	quickScanFrom,
	releaseQuickPhoto,
	SCAN_STATE,
	stashQuickPhoto,
	WEIGHT_FORM_STATE,
	weightFormFrom,
} from "../src/lib/quick-actions";

function photo(name: string) {
	return new File(["x"], name, { type: "image/jpeg" });
}

describe("快速記錄的 router state（首頁改版規格 §4）", () => {
	it("掃條碼與記體重：只認自己的形狀", () => {
		expect(quickScanFrom(SCAN_STATE)).toBe(true);
		expect(weightFormFrom(WEIGHT_FORM_STATE)).toBe(true);
		for (const bad of [null, undefined, "x", {}, { quickScan: "true" }, { weightForm: 1 }]) {
			expect(quickScanFrom(bad)).toBe(false);
			expect(weightFormFrom(bad)).toBe(false);
		}
	});

	it("照片：state 只有號碼，換回同一個 File；讀了不清掉（StrictMode 的初值函式跑兩次）", () => {
		const file = photo("a.jpg");
		const state = stashQuickPhoto(file);
		expect(Object.keys(state)).toEqual(["quickPhoto"]);
		expect(typeof state.quickPhoto).toBe("number");
		expect(quickPhotoFrom(state)).toBe(file);
		expect(quickPhotoFrom(state)).toBe(file);
	});

	it("一次只留一張：舊的號碼換不到新的照片", () => {
		const first = stashQuickPhoto(photo("a.jpg"));
		const second = photo("b.jpg");
		const secondState = stashQuickPhoto(second);
		expect(quickPhotoFrom(first)).toBeNull();
		expect(quickPhotoFrom(secondState)).toBe(second);
	});

	it("release 之後換不到；形狀不對是 null", () => {
		const state = stashQuickPhoto(photo("a.jpg"));
		releaseQuickPhoto();
		expect(quickPhotoFrom(state)).toBeNull();
		for (const bad of [null, {}, { quickPhoto: "1" }]) {
			expect(quickPhotoFrom(bad)).toBeNull();
		}
	});
});
```

- [ ] **Step 2：`tests/log-meal-ai.test.tsx` 加一組**（`describe("記一餐：總覽的拍照記帶來的照片（首頁改版規格 D8）")`，用檔案既有的 `wrap`、`mockLogMeal`）：
  1. `render(wrap(<LogMeal onSaved={vi.fn()} initialPhoto={new File(["x"], "lunch.jpg", { type: "image/jpeg" })} />))` →
     `findByRole("region", { name: "確認照片" })`、`await waitFor(() => expect(region).toHaveFocus())`、`img` 的 `alt` 是「要送給 AI 的照片」；
     按卡片裡的「開始估算」→ 打了 `POST /api/ai/analyze-meal`、body 的 `kind` 是 `"image"`、**沒有 `hint` 這個 key**（斷言照這個檔案既有的「拍照估算」那一條寫）→
     結果的 region「AI 估算結果」出現。
  2. 太大：`Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 })`（同 `ai-meal-panel.test.tsx` 的寫法）→ `findByRole("alert")` 是「照片太大」那句
     （`new PhotoTooLargeError().message`），沒有「確認照片」的 region，沒有打任何 AI 端點。
  3. 沒有 `initialPhoto`：沒有「確認照片」的 region（守「平常不會自己打開」）。

- [ ] **Step 3：`tests/log-meal-barcode.test.tsx` 加兩條**（用檔案既有的 `routes()`、`wrap`）：
  1. `startScanning`：`render(wrap(<LogMeal onSaved={vi.fn()} startScanning />))` → `findByRole("dialog", { name: "掃條碼" })`；
     焦點在掃描層的「取消」（`waitFor`）；按「取消」→ 掃描層不見、焦點在記一餐的「掃條碼」按鈕。
  2. 沒有 `startScanning`：等「搜尋食物」出現之後 `queryByRole("dialog")` 是 null。

- [ ] **Step 4：`tests/weight.test.tsx` 加兩條**（用檔案既有的 `renderScreen`，加一個參數讓 route 的 element 可以換成 `<Weight focusForm />`）：
  1. `focusForm`：資料回來之後 `await waitFor(() => expect(screen.getByLabelText("體重（公斤）")).toHaveFocus())`。
  2. 沒有 `focusForm`：資料回來之後焦點不在那一格（`not.toHaveFocus()`）。

- [ ] **Step 5：`tests/overview.test.tsx` 加一組**（`describe("總覽：快速記錄（首頁改版規格 §4）")`）：
  1. `getByRole("list", { name: "快速記錄" })` 有 4 個 `listitem`；連結「掃條碼」`href="/meals/new"`、「記運動」`/exercises/new`、「記體重」`/weight`；
     「拍照記」是檔案輸入（`getByLabelText("拍照記")`）：`type="file"`、`accept="image/*"`、`capture="environment"`。
  2. 掃條碼、記體重帶的 state：同 Task 2 的 `Routes`＋印 state 的元件（`/meals/new`、`/weight` 兩條路由），點了印出 `{"quickScan":true}`、`{"weightForm":true}`。
  3. 拍照記：`userEvent.upload(screen.getByLabelText("拍照記"), file)` → 到 `/meals/new`，印出來的 state 只有 `quickPhoto` 一個 key，
     `quickPhotoFrom(JSON.parse(印出來的字))` 是**同一個** `file`（`toBe`）。
  4. Task 2 第 5 條的 `{ weightForm: true }` 改 import `WEIGHT_FORM_STATE`。

- [ ] **Step 6：`tests/app.test.tsx` 加四條**（放在配餐那一組旁邊，用 `foodLists`、`openWithState`；`beforeEach` 已經清 history）：
  1. 「總覽的拍照記：到記一餐、確認照片的卡片已經打開，history 的 state 清掉、暫存的照片放掉」：`setTokens`、`mockBackend(foodLists)`、`render(<App />)`、
     等「總覽」。**先量下一個號碼**：`const probe = stashQuickPhoto(new File(["p"], "p.jpg", { type: "image/jpeg" })); releaseQuickPhoto();`——號碼是遞增的，
     上傳那一張會是 `probe.quickPhoto + 1`。→ `userEvent.upload(screen.getByLabelText("拍照記"), file)` → `findByRole("heading", { level: 1, name: "記一餐" })`、
     region「確認照片」→ `await waitFor(() => expect(window.history.state?.usr ?? null).toBeNull())` →
     `expect(quickPhotoFrom({ quickPhoto: probe.quickPhoto + 1 })).toBeNull()`（`LogMealRoute` 清 state 時放掉了；畫面上的卡片照樣在——它在 `AiMealPanel` 的 state 裡）。
  2. 「從總覽的掃條碼：記一餐一打開就是掃描層」：`openWithState("/meals/new", SCAN_STATE)`、`render(<App />)` → `findByRole("dialog", { name: "掃條碼" })`；
     history 的 state 清掉。`HTMLMediaElement.prototype.play = vi.fn(async () => undefined)`（同 `log-meal-barcode.test.tsx`）。
  3. 「從總覽的記體重：到 /weight、焦點在體重欄位」：在總覽點「記體重」→ `findByRole("heading", { level: 1, name: "體重" })` →
     `waitFor` 焦點在「體重（公斤）」→ history 的 state 清掉。
  4. 既有的「從『＋』點『記運動』到得了表單」：第二個 `click` 改成
     `within(screen.getByRole("dialog", { name: "新增紀錄" })).getByRole("link", { name: "記運動" })`（規格 D18；總覽現在也有一個「記運動」）。

- [ ] **Step 7：跑，看它紅** → `npx vitest run tests/quick-actions.test.ts tests/log-meal-ai.test.tsx tests/log-meal-barcode.test.tsx tests/weight.test.tsx tests/overview.test.tsx tests/app.test.tsx`。
  Expected: FAIL（模組、props、元件都還沒有；`app.test` 的第 4 條在 Step 8 之前是綠的——它在加了總覽的「記運動」之後才會紅，先改是為了不留紅燈）。

- [ ] **Step 8：`lib/quick-actions.ts`。**

```ts
/** 總覽的快速記錄帶給下一頁的 router state（首頁改版規格 §4）。state 是 unknown：任何頁面都可能 navigate 過來，
 *  history 裡也可能是舊版本存的形狀——不對就當作沒有（同 `plannerHandoffFrom`）。讀一次、清掉 history 的 state
 *  由 `App.tsx` 的 `LogMealRoute`／`WeightRoute` 做。 */

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

/** 掃條碼：記一餐一打開就開掃描層（D9）。 */
export const SCAN_STATE = { quickScan: true } as const;

export function quickScanFrom(state: unknown): boolean {
	return isRecord(state) && state.quickScan === true;
}

/** 記體重：`/weight` 一打開焦點就在體重欄位（D11）。 */
export const WEIGHT_FORM_STATE = { weightForm: true } as const;

export function weightFormFrom(state: unknown): boolean {
	return isRecord(state) && state.weightForm === true;
}

/** 拍照記的照片（D8）。**`File` 不放進 history**：`history.state` 會被結構化複製（Firefox 有大小上限），重新整理
 *  還會把舊照片帶回來。state 只帶號碼，檔案留在這個模組的記憶體裡、一次只留一張——重新整理（模組重新載入）
 *  就沒有了，跟配餐的交接一樣，刻意。 */
let stash: { id: number; file: File } | null = null;
let nextId = 1;

export function stashQuickPhoto(file: File): { quickPhoto: number } {
	const id = nextId;
	nextId += 1;
	stash = { id, file };
	return { quickPhoto: id };
}

/** 號碼對得上才回檔案。**讀了不清掉**：`useState` 的初值函式在 StrictMode 會被呼叫兩次，清掉的話其中一次拿到 null。
 *  清的時機是 `LogMealRoute` 清 history 的 state 那一刻（`releaseQuickPhoto`）。 */
export function quickPhotoFrom(state: unknown): File | null {
	if (!isRecord(state) || typeof state.quickPhoto !== "number") return null;
	return stash !== null && stash.id === state.quickPhoto ? stash.file : null;
}

export function releaseQuickPhoto(): void {
	stash = null;
}
```

- [ ] **Step 9：`components/IconBadge.tsx`** 在 `EXERCISE_COLOR` 後面加：

```ts
/** 體重的徽章色（總覽的快速記錄、「＋」的記體重；首頁改版規格 D17）。借交通的藍：體重不出現在時間線上，不會跟
 *  交通的支出列混淆；「＋」的四個入口（記帳 `--color-action`、記一餐 food 橘、記運動綠、記體重藍）互不相同。 */
export const WEIGHT_COLOR = CATEGORY_COLORS.transport;
```

- [ ] **Step 10：`components/QuickActions.tsx`。**

```tsx
import { Camera, Dumbbell, ScanBarcode, Weight } from "lucide-react";
import type { ChangeEvent } from "react";
import { Link } from "react-router";
import { CATEGORY_COLORS } from "../api/expenses";
import { SCAN_STATE, WEIGHT_FORM_STATE } from "../lib/quick-actions";
import { EXERCISE_COLOR, IconBadge, WEIGHT_COLOR } from "./IconBadge";
import styles from "./QuickActions.module.css";

type Props = {
	/** 拍照記選好了一張照片（太大不在這裡擋：記一餐的 AI 面板選的當下就擋，同一個地方說）。 */
	onPhoto: (file: File) => void;
};

/** 總覽的四個快速記錄（首頁改版規格 §4）。
 *
 *  **拍照記是 `<label>`＋視覺隱藏的檔案輸入**，不是連到記一餐再自動打開相機：iOS 只在使用者手勢裡開檔案選擇器，
 *  點標籤本身就是那個手勢——一按就開相機；導頁之後再程式化 `click()` 會被擋（D8）。`capture="environment"`：
 *  直接開後鏡頭（從相簿選用記一餐裡的「拍照估算」）。輸入框不用 `display:none`：鍵盤要能對焦。
 *
 *  掃條碼、記運動、記體重是普通的連結；掃條碼與記體重帶 router state（`lib/quick-actions.ts`）。
 *  「記運動」「記體重」跟「＋」選單同名（D18）。 */
export function QuickActions({ onPhoto }: Props) {
	function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：取消導頁回來（或同一張再選一次）時 change 才會再觸發。
		event.target.value = "";
		if (file !== undefined) onPhoto(file);
	}

	return (
		<ul className={styles.actions} aria-label="快速記錄">
			<li>
				<label htmlFor="quick-photo" className={styles.action}>
					<IconBadge icon={Camera} color={CATEGORY_COLORS.food} size="large" />
					拍照記
				</label>
				<input
					id="quick-photo"
					type="file"
					accept="image/*"
					capture="environment"
					className={styles.fileInput}
					onChange={handlePhoto}
				/>
			</li>
			<li>
				<Link to="/meals/new" state={SCAN_STATE} className={styles.action}>
					<IconBadge icon={ScanBarcode} color="var(--color-action)" size="large" />
					掃條碼
				</Link>
			</li>
			<li>
				<Link to="/exercises/new" className={styles.action}>
					<IconBadge icon={Dumbbell} color={EXERCISE_COLOR} size="large" />
					記運動
				</Link>
			</li>
			<li>
				<Link to="/weight" state={WEIGHT_FORM_STATE} className={styles.action}>
					<IconBadge icon={Weight} color={WEIGHT_COLOR} size="large" />
					記體重
				</Link>
			</li>
		</ul>
	);
}
```

- [ ] **Step 11：`components/QuickActions.module.css`。**

```css
/* 總覽的快速記錄（QuickActions.tsx；首頁改版規格 §4）。四欄：390px 寬每格約 80px，徽章＋三個字放得下。 */

.actions {
	list-style: none;
	margin: 0;
	padding: 0;
	display: grid;
	grid-template-columns: repeat(4, minmax(0, 1fr));
	gap: var(--space-2);
}

.action {
	box-sizing: border-box;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: var(--space-1);
	height: 100%;
	min-height: 44px;
	padding: var(--space-2) var(--space-1);
	border-radius: var(--radius-card);
	background: var(--color-surface);
	color: var(--color-text);
	font-size: 14px;
	font-weight: 600;
	text-align: center;
	text-decoration: none;
	cursor: pointer;
}

.action:hover,
.action:active {
	background: var(--color-accent-soft);
}

/* 視覺上藏起來但仍可用鍵盤對焦（同 PhotoPickerButton.module.css 的 .input），對焦外框畫在前面的標籤上。 */
.fileInput {
	position: absolute;
	width: 1px;
	height: 1px;
	opacity: 0;
}

.action:has(+ .fileInput:focus-visible) {
	outline: 2px solid var(--color-action);
	outline-offset: 2px;
}
```

- [ ] **Step 12：`screens/Overview.tsx`**：import `QuickActions` 與 `stashQuickPhoto`；`TodayBudgetCard` 與 `.cards` 中間放

```tsx
					<QuickActions
						onPhoto={(file) =>
							navigate("/meals/new", { state: stashQuickPhoto(file) })
						}
					/>
```

  （`navigate` 已經有。）`WeightGlanceCard` 的 `{ weightForm: true }` 換成 `WEIGHT_FORM_STATE`。

- [ ] **Step 13：`components/BarcodeScanEntry.tsx`**：`Props` 加

```ts
	/** 一掛載就打開掃描層（總覽的「掃條碼」，首頁改版規格 D9）。只在掛載時讀。 */
	startScanning?: boolean;
```

  解構加 `startScanning`；`useState(false)` → `useState(startScanning === true)`。掃描層自己把焦點放在「取消」；「取消」之後 `closeScanner` 把焦點還給「掃條碼」——
  不用改。

- [ ] **Step 14：`components/FoodPicker.tsx`**：`Props` 加同一個 `startScanning?: boolean`（註解「交給 `BarcodeScanEntry`」），`<BarcodeScanEntry … startScanning={startScanning} />`。

- [ ] **Step 15：`components/AiMealPanel.tsx`**：
  - `Props` 加：

```ts
	/** 一開始就選好的照片（總覽的「拍照記」，首頁改版規格 D8）：一掛載就是「確認照片」卡片、焦點在卡片。
	 *  太大的同「選的當下就擋」——說太大、不出卡片。只在掛載時讀。 */
	initialPhoto?: File;
```

  - 解構加 `initialPhoto`。`pending` 與 `pickError` 的初值改成：

```ts
	// 總覽帶來的照片跟這裡選的照片同一套規則（規格 D8；照片說明規格 D9：太大在選的當下就擋）。
	const initialFits =
		initialPhoto !== undefined && initialPhoto.size <= MAX_PHOTO_BYTES;
	const [pending, setPending] = useState<{ file: File; hint: string } | null>(
		() => (initialFits ? { file: initialPhoto, hint: "" } : null),
	);
	const [pickError, setPickError] = useState<string | null>(() =>
		initialPhoto !== undefined && !initialFits
			? new PhotoTooLargeError().message
			: null,
	);
```

    （`initialFits` 為 true 時 TypeScript 收窄不到 `initialPhoto`——寫成 `initialFits && initialPhoto !== undefined ? … : null`，或把判斷收成一個
    `function fitting(file?: File): File | null`；照 typecheck 的結果選一種，記進差異。）
  - `focusNextRef` 的初值：`startSuggesting === true ? "preference" : initialFits ? "step" : null`（`"step"` 的分支用 `focusStepAfterFileDialog`，掛載時也對）。

- [ ] **Step 16：`screens/LogMeal.tsx`**：`Props` 加

```ts
	/** 總覽「拍照記」選好的照片（首頁改版規格 D8）：交給 AI 面板，一打開就是「確認照片」卡片。只在掛載時讀。 */
	initialPhoto?: File;
	/** 總覽「掃條碼」來的：一打開就是掃描層（D9）。只在掛載時讀。 */
	startScanning?: boolean;
```

  解構加兩個；`<FoodPicker … startScanning={startScanning}>`、`<AiMealPanel … initialPhoto={initialPhoto}>`。**這一張照片不直接當這一餐的照片**：估算加入之後
  照既有的規則（`onItemsReady` 的 `source.image`，已經有就不覆蓋）放進來——跟在面板裡選的一樣。

- [ ] **Step 17：`screens/Weight.tsx`**：

```tsx
type Props = {
	/** 快速記錄或「＋」的「記體重」來的（首頁改版規格 D11）：資料回來、表單掛上去時焦點放在體重欄位。 */
	focusForm?: boolean;
};

export function Weight({ focusForm = false }: Props) {
```

  `WeightBody` 多 `focusForm: boolean` prop（呼叫端傳下去），`<WeightForm today={today} focusOnMount={focusForm} />`。說明註解加一句。

- [ ] **Step 18：`App.tsx`**：
  - import `quickPhotoFrom`、`quickScanFrom`、`releaseQuickPhoto`、`weightFormFrom`（`./lib/quick-actions`）。
  - `LogMealRoute`：

```tsx
	// 總覽的快速記錄（首頁改版規格 D8、D9）：同一套「讀一次、清掉 history 的 state」。照片在 `lib/quick-actions` 的暫存裡，
	// 清 state 的同時放掉它（state 只有號碼）。
	const [photo] = useState(() => quickPhotoFrom(location.state));
	const [scan] = useState(() => quickScanFrom(location.state));
	useEffect(() => {
		if (location.state == null) return;
		releaseQuickPhoto();
		navigate(`${location.pathname}${location.search}`, {
			replace: true,
			state: null,
		});
	}, [location.state, location.pathname, location.search, navigate]);
```

    （`releaseQuickPhoto()` 加進既有的那個 effect，不要另開一個。）`<LogMeal … initialPhoto={photo ?? undefined} startScanning={scan} />`。說明註解加一段。
  - 新的 `WeightRoute`（放在 `NewFoodRoute` 後面）：

```tsx
/** `/weight`：快速記錄與「＋」的「記體重」帶 `{weightForm: true}`（首頁改版規格 D11）——讀一次、`replace` 清掉，
 *  上一頁或重新整理不會再搶焦點。 */
function WeightRoute() {
	const navigate = useNavigate();
	const location = useLocation();
	const [focusForm] = useState(() => weightFormFrom(location.state));
	useEffect(() => {
		if (location.state == null) return;
		navigate(`${location.pathname}${location.search}`, {
			replace: true,
			state: null,
		});
	}, [location.state, location.pathname, location.search, navigate]);
	return <Weight focusForm={focusForm} />;
}
```

    `<Route path="/weight" element={<Weight />} />` → `element={<WeightRoute />}`，路由的註解加「入口：總覽的快速記錄、『＋』的記體重」。

- [ ] **Step 19：跑** → Step 7 那幾個檔案 PASS；整套 `npm run -s test`、`typecheck`、`lint`。

- [ ] **Step 20：突變**（`$S/home-mut-t3.json`）：
  1. `quickPhotoFrom`：拿掉 `stash.id === state.quickPhoto &&` 的比較（`stash !== null ? stash.file : null`）→ 紅 quick-actions「一次只留一張」。
  2. `releaseQuickPhoto`：函式體清空 → 紅「release 之後」。
  3. `AiMealPanel`：`focusNextRef` 初值的 `"step"` → `null` → 紅 log-meal-ai 1。
  4. `AiMealPanel`：`initialFits` 改成 `initialPhoto !== undefined` → 紅 log-meal-ai 2。
  5. `BarcodeScanEntry`：`useState(startScanning === true)` → `useState(false)` → 紅 log-meal-barcode 1、app 2。
  6. `Weight`：`focusOnMount={focusForm}` 拿掉 → 紅 weight 1、app 3。
  7. `QuickActions`：拿掉 `capture="environment"` → 紅 overview 快速記錄 1。
  8. `QuickActions`：掃條碼的 `state={SCAN_STATE}` 拿掉 → 紅 overview 2。
  9. `App.tsx`：`initialPhoto={photo ?? undefined}` → `initialPhoto={undefined}` → 紅 app 1。
  9b. `App.tsx`：拿掉 effect 裡的 `releaseQuickPhoto();` → 紅 app 1（最後一行）。
  10. `App.tsx`：`WeightRoute` 的 `focusForm={focusForm}` → `focusForm={false}` → 紅 app 3。
  11. `Overview`：`navigate("/meals/new", { state: stashQuickPhoto(file) })` → `navigate("/meals/new")` → 紅 overview 3。

- [ ] **Step 21：Commit。** add 上面列的檔案（`lib/quick-actions.ts`、`QuickActions.{tsx,module.css}`、`IconBadge.tsx`、`Overview.tsx`、`LogMeal.tsx`、
  `AiMealPanel.tsx`、`FoodPicker.tsx`、`BarcodeScanEntry.tsx`、`Weight.tsx`、`App.tsx` 與六個測試檔）；
  訊息 `feat(frontend): 總覽的快速記錄——拍照記一按開相機、掃條碼直接開掃描層、記體重焦點在表單（首頁改版 Task 3）`。

---

## Task 4：身體與目標（`/me/health`）

**Files:** `frontend/src/screens/BodyHub.tsx`（新）、`App.tsx`、`lib/layout.ts`、`screens/{Targets,BodyProfile}.tsx`、`components/TargetSuggestion.tsx`、
`components/{TargetsCard,WeightCard,BodyProfileCard}.tsx`（註解）；`frontend/tests/body-hub.test.tsx`（新）、
`tests/{me,exercise-budget-switch,targets,target-suggestion,body-profile,layout,app}.test.tsx`

- [ ] **Step 1：搬測試到 `tests/body-hub.test.tsx`**（規格 §9.1：搬，不刪；斷言逐字保留）：
  1. 新檔的開頭照 `me.test.tsx`：同樣的 import（`Me` 換成 `import { BodyHub } from "../src/screens/BodyHub";`）、`me()`、`ZERO`、`STATS`、`statsRoute`、`wrap`、
     `beforeEach`——**複製**，不要從 `me.test.tsx` import（handover §7：會把那個檔案的 `describe` 一起註冊）。
  2. 從 `me.test.tsx` **剪下**四個 `describe`：「我的：每日目標卡片的重算提示（身體資料規格 §6.6）」「我的：每日目標卡片」「我的：身體資料卡片」「我的：體重卡片」，
     貼進新檔；`describe` 名稱的「我的：」改「身體與目標：」；裡面每一個 `render(wrap(<Me />))` 換 `render(wrap(<BodyHub />))`。
  3. 兩條「順序」（身體資料卡片的「每日目標之後、好友之前」、體重卡片的「身體資料之後、好友之前」）刪掉，換成一條（放在新檔最後）：

```tsx
describe("身體與目標：頁面（首頁改版規格 D16）", () => {
	it("標題「身體與目標」；順序：每日目標 → 體重 → 身體資料", async () => {
		mockApi([
			...bodyRoutes(),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));

		expect(
			screen.getByRole("heading", { level: 1, name: "身體與目標" }),
		).toBeInTheDocument();
		const targets = await screen.findByTestId("targets-card");
		const weight = screen.getByTestId("weight-card");
		const body = screen.getByTestId("body-profile-card");
		expect(
			targets.compareDocumentPosition(weight) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			weight.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// 運動加回的開關照樣在每日目標卡片的底部（搬家，不是改功能）。
		expect(
			within(targets).getByRole("switch", { name: "運動消耗加回今天的熱量額度" }),
		).toBeInTheDocument();
	});
});
```

  4. `me.test.tsx` 剩下的 import 裡用不到的（`cleanup`、`EMPTY_PROFILE`、`READY_SUGGESTION`、`Route` 型別……）照 lint 拿掉。

- [ ] **Step 2：`tests/exercise-budget-switch.test.tsx`**：`import { Me }` → `import { BodyHub } from "../src/screens/BodyHub"`，`<Me />` → `<BodyHub />`；檔頭的「「我的」」註解改「身體與目標」。

- [ ] **Step 3：存好之後的去處**（規格 D2）：
  - `tests/targets.test.tsx`、`tests/target-suggestion.test.tsx`、`tests/body-profile.test.tsx`：假路由 `<Route path="/me" element={<h1>我的</h1>} />` →
    `<Route path="/me/health" element={<h1>身體與目標</h1>} />`；`grep -n '"我的"' ` 這三個檔案，每一個「導回我的」的斷言（`findByRole("heading", { name: "我的" })` 之類）
    改成「身體與目標」，測試名稱裡的「回到 /me」改「回到 /me/health」。
  - `tests/layout.test.ts`：`contentWidthFor("/me/health")` 是 `"narrow"`（加進既有的那一組 `it.each`，或新的一條）。
  - `tests/app.test.tsx` 加一條：「『我的』的『身體與目標』：到 /me/health，三張卡片都在，電腦版內容寬度是 narrow」——`setDesktop(true)`、在總覽點導覽的「我的」→
    點「身體與目標」→ `findByRole("heading", { level: 1, name: "身體與目標" })`、`targets-card`／`weight-card`／`body-profile-card` 都在、
    `screen.getByRole("main").querySelector(".app-content-narrow")` 不是 null、導覽的「我的」有 `aria-current="page"`。
    **這一條在 Task 5 之前點不到入口**（「我的」還沒有那張卡片）：先用 `window.history.replaceState(null, "", "/me/health")` 直接打開，Task 5 再改成點擊。

- [ ] **Step 4：跑，看它紅** → `npx vitest run tests/body-hub.test.tsx tests/exercise-budget-switch.test.tsx tests/targets.test.tsx tests/target-suggestion.test.tsx tests/body-profile.test.tsx tests/layout.test.ts tests/app.test.tsx`。
  Expected: FAIL（`BodyHub` 不存在、存好還是導回 `/me`、沒有 `/me/health` 路由）。`layout.test` 的那一格這時是綠的（預設就是 narrow）——它守的是「不要被加進 FORM」。

- [ ] **Step 5：`screens/BodyHub.tsx`。**

```tsx
import { BodyProfileCard } from "../components/BodyProfileCard";
import { TargetsCard } from "../components/TargetsCard";
import { WeightCard } from "../components/WeightCard";

/** 身體與目標（`/me/health`，首頁改版規格 §5）：從「我的」搬過來的三張卡片，**卡片本身不改**。
 *
 *  - 順序（D16）：每日目標（重算提示、運動加回的開關）→ 體重（每天會碰的）→ 身體資料（最少改）。
 *  - 路由在 `/me` 底下（D1）：分頁的「我的」在這一頁照樣亮著（`NavLink` 沒有 `end`），未讀數字也在同一格。
 *    `/me/body`（身體資料表單）、`/me/targets`（每日目標表單）存好之後導回這裡（D2）。
 *  - 寬度是 `contentWidthFor` 的預設 narrow。 */
export function BodyHub() {
	return (
		<section>
			<h1>身體與目標</h1>
			<TargetsCard />
			<WeightCard />
			<BodyProfileCard />
		</section>
	);
}
```

- [ ] **Step 6：`App.tsx`**：import `BodyHub`；在 `/me/targets` 那一條前面加

```tsx
							{/* 身體與目標（首頁改版規格 §5）：每日目標、體重、身體資料三張卡片。入口是「我的」的入口卡片。
									在 `/me` 底下，分頁的「我的」照樣亮著（D1）。 */}
							<Route path="/me/health" element={<BodyHub />} />
```

  `/me/targets`、`/me/body`、`/weight` 那幾條註解裡的「入口是『我的』的…卡片」改成「身體與目標的…卡片」。

- [ ] **Step 7：`lib/layout.ts`**：檔頭註解加一句「`/me/health`（身體與目標）是一欄卡片，用預設的 narrow（首頁改版規格 D1）——刻意不列進下面兩組。」

- [ ] **Step 8：存好之後導回 `/me/health`**：`screens/Targets.tsx:146`、`screens/BodyProfile.tsx:159`、`components/TargetSuggestion.tsx:106` 的
  `navigate("/me")` → `navigate("/me/health")`；三處旁邊（或函式的說明）的「導回 /me」改「導回身體與目標（首頁改版規格 D2）」。
  `TargetsCard`、`WeightCard`、`BodyProfileCard` 的說明註解裡「「我的」的…」改「身體與目標的…」（行為不動）。

- [ ] **Step 9：跑** → Step 4 那幾個檔案 PASS；`npx vitest run tests/me.test.tsx tests/invite-friends.test.tsx`（`Me` 還沒改，照樣綠）；整套、`typecheck`、`lint`。

- [ ] **Step 10：突變**（`$S/home-mut-t4.json`）：
  1. `Targets.tsx`：`navigate("/me/health")` → `navigate("/me")` → 紅 targets。
  2. `TargetSuggestion.tsx`：同上 → 紅 target-suggestion。
  3. `BodyProfile.tsx`：同上 → 紅 body-profile。
  4. `BodyHub`：`<WeightCard />` 與 `<BodyProfileCard />` 對調 → 紅 body-hub 的順序。
  5. `App.tsx`：拿掉 `/me/health` 那一條 → 紅 app。
  6. `layout.ts`：`FORM` 加 `"/me/health"` → 紅 layout、app（`.app-content-narrow`）。

- [ ] **Step 11：Commit。** `git add frontend/src/screens/BodyHub.tsx frontend/src/App.tsx frontend/src/lib/layout.ts frontend/src/screens/Targets.tsx frontend/src/screens/BodyProfile.tsx frontend/src/components/TargetSuggestion.tsx frontend/src/components/TargetsCard.tsx frontend/src/components/WeightCard.tsx frontend/src/components/BodyProfileCard.tsx frontend/tests/body-hub.test.tsx frontend/tests/me.test.tsx frontend/tests/exercise-budget-switch.test.tsx frontend/tests/targets.test.tsx frontend/tests/target-suggestion.test.tsx frontend/tests/body-profile.test.tsx frontend/tests/layout.test.ts frontend/tests/app.test.tsx`；
  訊息 `feat(frontend): 新頁「身體與目標」（/me/health），每日目標、體重、身體資料搬過去；存好導回這裡（首頁改版 Task 4）`。

  **注意**：這個 commit 之後、Task 5 之前，「我的」同時有三張卡片、身體與目標也有——中間狀態，不會被部署（不 push）。`me.test.tsx` 這時已經沒有那四組測試，
  但 `Me` 還畫著那三張卡片：Task 5 拿掉。

---

## Task 5：精簡「我的」、入口卡片

**Files:** `frontend/src/components/BodyHubEntry.{tsx,module.css}`（新）、`screens/Me.tsx`；`frontend/tests/me.test.tsx`、`tests/app.test.tsx`

- [ ] **Step 1：`tests/me.test.tsx` 加一組**：

```tsx
describe("我的：身體與目標的入口（首頁改版規格 D13–D15）", () => {
	const WEIGHT_79 = {
		today: "2019-07-04",
		entries: [{ date: "2019-07-04", weight_kg: "79.00" }],
	};

	function renderWith(stats: unknown, weights: unknown) {
		const spy = mockApi([
			...bodyRoutes({ weights }),
			statsRoute(stats),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me />));
		return { spy, card: screen.getByTestId("body-hub-entry") };
	}

	it("連結的名稱固定「身體與目標」、連到 /me/health；摘要是說明（不在名稱裡）", async () => {
		const { card } = renderWith(STATS, WEIGHT_79);
		expect(await within(card).findByText("1800 kcal・79 公斤")).toBeInTheDocument();
		const link = within(card).getByRole("link", { name: "身體與目標" });
		expect(link).toHaveAttribute("href", "/me/health");
		expect(link).toHaveAccessibleDescription("1800 kcal・79 公斤");
	});

	it("只有目標、只有體重、都沒有", async () => {
		const first = renderWith(STATS, NO_WEIGHTS).card;
		expect(await within(first).findByText("1800 kcal")).toBeInTheDocument();
		cleanup();
		vi.restoreAllMocks();

		const second = renderWith({ ...STATS, target: null }, WEIGHT_79).card;
		expect(await within(second).findByText("79 公斤")).toBeInTheDocument();
		cleanup();
		vi.restoreAllMocks();

		const third = renderWith({ ...STATS, target: null }, NO_WEIGHTS).card;
		expect(await within(third).findByText("還沒設定")).toBeInTheDocument();
	});

	it("「我的」沒有每日目標、體重、身體資料三張卡片，也不打身體資料與建議的端點", async () => {
		const { spy, card } = renderWith(STATS, NO_WEIGHTS);
		await within(card).findByText("1800 kcal");
		expect(screen.queryByTestId("targets-card")).not.toBeInTheDocument();
		expect(screen.queryByTestId("weight-card")).not.toBeInTheDocument();
		expect(screen.queryByTestId("body-profile-card")).not.toBeInTheDocument();
		const urls = spy.mock.calls.map(([input]) => String(input));
		expect(urls.some((url) => url.includes("/api/me/body-profile"))).toBe(false);
		expect(urls.some((url) => url.includes("/api/me/target-suggestion"))).toBe(false);
	});

	it("摘要寫的是目標，不是額度（含運動的那個數字）", async () => {
		const { card } = renderWith(
			{
				...STATS,
				exercise_kcal: "343.00",
				exercise_adds_to_budget: true,
				kcal_budget: "2143.00",
			},
			NO_WEIGHTS,
		);
		expect(await within(card).findByText("1800 kcal")).toBeInTheDocument();
	});

	it("順序：通知 → 身體與目標 → 帳號（D15）", async () => {
		const { card } = renderWith(STATS, NO_WEIGHTS);
		const notifications = screen.getByTestId("notifications-card");
		const account = await screen.findByText("kenny@example.com");
		expect(
			notifications.compareDocumentPosition(card) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			card.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});
});
```

  （`NO_WEIGHTS` 從 `./helpers/body-routes` import；通知卡片要 `/api/notifications/unread-count` 的話照檔案裡通知那一組的 `unreadRoute` 補上。）
  既有的「有新通知…是『我的』裡的第一張卡片」那一條（`nextElementSibling` 是通知卡片）照舊，不用改。

- [ ] **Step 2：`tests/app.test.tsx`**：Task 4 那一條改成點擊——在總覽點導覽的「我的」→ 點連結「身體與目標」（不再 `replaceState`）。

- [ ] **Step 3：跑，看它紅** → `npx vitest run tests/me.test.tsx tests/app.test.tsx`。Expected: FAIL（沒有入口卡片；「我的」還畫著三張卡片）。

- [ ] **Step 4：`components/BodyHubEntry.tsx`。**

```tsx
import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { useWeights } from "../api/body";
import { useDailyStats } from "../api/stats";
import { formatMacro, type Numeric, roundForDisplay } from "../lib/decimal";
import styles from "./BodyHubEntry.module.css";
import { Card } from "./Card";

/** 摘要（首頁改版規格 D14）：目標的熱量（不是額度——這裡講的是「目標」）、最新一筆體重；只有一個就寫一個，都沒有「還沒設定」。 */
export function hubSummary(kcal: Numeric | null, weightKg: Numeric | null): string {
	const parts = [
		kcal === null ? null : `${roundForDisplay(kcal, 0)} kcal`,
		weightKg === null ? null : `${formatMacro(weightKg)} 公斤`,
	].filter((part): part is string => part !== null);
	return parts.length === 0 ? "還沒設定" : parts.join("・");
}

/** 「我的」的身體與目標入口（規格 D13）。
 *
 *  **摘要在連結外面、用 `aria-describedby` 唸**：放在連結裡會併進可及名稱，名稱就跟著資料變（handover §7
 *  「`aria-hidden` 與可及名稱」）。箭頭是裝飾。讀的是跟身體與目標同一個快取（`dailyStats`、`["body","weights"]`）；
 *  離線快取裡的舊回應少欄位一律 `?? null`。 */
export function BodyHubEntry() {
	const id = useId();
	const summaryId = `${id}-summary`;
	const stats = useDailyStats();
	const weights = useWeights();

	let summary: string;
	if (stats.isPending || weights.isPending) {
		summary = "載入中…";
	} else if (stats.data == null && weights.data == null) {
		summary = "無法載入";
	} else {
		summary = hubSummary(
			stats.data?.target?.kcal ?? null,
			weights.data?.entries.at(-1)?.weight_kg ?? null,
		);
	}

	return (
		<Card testId="body-hub-entry">
			<Link
				to="/me/health"
				className={styles.link}
				aria-describedby={summaryId}
			>
				身體與目標
				<ChevronRight aria-hidden="true" size={18} />
			</Link>
			<p id={summaryId} className={styles.summary}>
				{summary}
			</p>
		</Card>
	);
}
```

  `hubSummary` 只在這個檔案用的話不用 export（lint 不會抱怨 export）；留 export 給之後的單元測試。

- [ ] **Step 5：`components/BodyHubEntry.module.css`。**

```css
/* 「我的」的身體與目標入口（BodyHubEntry.tsx；首頁改版規格 D13）。 */

.link {
	display: flex;
	align-items: center;
	justify-content: space-between;
	min-height: 44px;
	color: var(--color-text);
	font-weight: 600;
	text-decoration: none;
}

.summary {
	margin: 0;
	color: var(--color-text-muted);
	font-variant-numeric: tabular-nums;
}
```

- [ ] **Step 6：`screens/Me.tsx`**：拿掉 `BodyProfileCard`、`TargetsCard`、`WeightCard` 的 import 與 JSX（連同它們的註解）；`<NotificationsCard />` 後面加

```tsx
			{/* 每日目標、體重、身體資料搬到「身體與目標」（首頁改版規格 §6）；這裡只留入口與一行摘要。 */}
			<BodyHubEntry />
```

  檔頭說明改成「我的：通知、身體與目標的入口、帳號、好友、匯出資料、管理員的審核、邀請與所有帳號、登出（…、首頁改版規格 §6）」。

- [ ] **Step 7：跑** → `me.test.tsx`、`app.test.tsx`、`invite-friends.test.tsx` PASS；整套、`typecheck`、`lint`。

- [ ] **Step 8：突變**（`$S/home-mut-t5.json`）：
  1. `hubSummary`：`join("・")` → `join("，")` → 紅入口 1。
  2. `BodyHubEntry`：拿掉 `aria-describedby={summaryId}` → 紅入口 1。
  3. `BodyHubEntry`：`<p>` 搬進 `<Link>` 裡 → 紅入口 1（名稱變了）。
  4. `BodyHubEntry`：`stats.data?.target?.kcal ?? null` → `stats.data == null ? null : kcalBudgetOf(stats.data)` → 紅「是目標，不是額度」。
  5. `Me.tsx`：把 `<TargetsCard />` 加回去 → 紅「沒有三張卡片」。
  6. `Me.tsx`：`<BodyHubEntry />` 移到 `<AccountCard />` 後面 → 紅順序。

- [ ] **Step 9：Commit。** `git add frontend/src/components/BodyHubEntry.tsx frontend/src/components/BodyHubEntry.module.css frontend/src/screens/Me.tsx frontend/tests/me.test.tsx frontend/tests/app.test.tsx`；
  訊息 `feat(frontend): 我的只留身體與目標的入口卡片（一行摘要）（首頁改版 Task 5）`。

---

## Task 6：「＋」選單的記體重

**Files:** `frontend/src/components/AddSheet.{tsx,module.css}`；`frontend/tests/{tab-bar,side-nav,app}.test.tsx`

- [ ] **Step 1：測試**：
  - `tests/tab-bar.test.tsx`：「面板裡有『記運動』…」那一條的 `toEqual(["記帳", "記一餐", "記運動"])` → 加「記體重」；新的一條「面板裡有『記體重』，連到 /weight；點了面板關掉」
    （照「記運動」那一條寫）。
  - `tests/side-nav.test.tsx`：同上（照它的「記運動」那一條寫）。
  - `tests/app.test.tsx`：「從『＋』點『記體重』：到 /weight、焦點在體重欄位」——在總覽按「新增紀錄」→ `within(dialog).getByRole("link", { name: "記體重" })` →
    heading「體重」→ `waitFor` 焦點在「體重（公斤）」。

- [ ] **Step 2：跑，看它紅** → `npx vitest run tests/tab-bar.test.tsx tests/side-nav.test.tsx tests/app.test.tsx`。Expected: FAIL。

- [ ] **Step 3：`components/AddSheet.tsx`**：import 加 `Weight`（lucide）、`WEIGHT_COLOR`、`WEIGHT_FORM_STATE`；「記運動」後面加

```tsx
					{/* 記體重（首頁改版規格 §7）：跟總覽的快速記錄同一個去處——/weight、焦點在體重欄位。 */}
					<Link
						to="/weight"
						state={WEIGHT_FORM_STATE}
						className={styles.choice}
						onClick={onNavigate}
					>
						<IconBadge icon={Weight} color={WEIGHT_COLOR} size="large" />
						記體重
					</Link>
```

  說明註解「記帳、記一餐或記運動」→「記帳、記一餐、記運動或記體重（…；首頁改版規格 §7）」。

- [ ] **Step 4：`components/AddSheet.module.css`**：`.choices` 的 `repeat(3, minmax(0, 1fr))` → `repeat(2, minmax(0, 1fr))`，註解改成
  「四個入口 2×2（首頁改版規格 §7）：DOM 順序＝焦點順序＝由左到右、由上到下。」

- [ ] **Step 5：跑** → PASS；整套、`typecheck`、`lint`。

- [ ] **Step 6：突變**：拿掉記體重的 `state={WEIGHT_FORM_STATE}` → 紅 app；拿掉 `onClick={onNavigate}` → 紅 tab-bar／side-nav 的「面板關掉」。
  `.choices` 的欄數只有 e2e 量得到（Task 8 的 2×2 斷言）。

- [ ] **Step 7：Commit。** `git add frontend/src/components/AddSheet.tsx frontend/src/components/AddSheet.module.css frontend/tests/tab-bar.test.tsx frontend/tests/side-nav.test.tsx frontend/tests/app.test.tsx`；
  訊息 `feat(frontend): 「＋」多一個記體重，四個入口排成 2×2（首頁改版 Task 6）`。

---

## Task 7：既有的 e2e

**Files:** `frontend/e2e/{account-settings,body-targets,exercise,planner}.spec.ts`

先 `docker compose up -d --build api`（**不要 `down -v`**），dev 伺服器由 Playwright 的 `webServer` 起（或沿用已經在跑的）。

- [ ] **Step 1：`e2e/account-settings.spec.ts` 第一條**：
  - 迴圈裡「我的」標題出現之後，多點一次 `page.getByRole("link", { name: "身體與目標", exact: true })`，等 `heading「身體與目標」`（`exact: true, level: 1`），再點「修改每日目標」。
  - 存好之後等的標題「我的」→「身體與目標」（註解「回到『我的』」→「回到身體與目標（首頁改版規格 D2）」）。
  - `await expect(kcal).toContainText(\`/ ${value} kcal\`)` → `toContainText(\`預算 ${value}\`)`。開頭的 `toContainText("kcal")`、`not.toContainText("/")` 照舊
    （新帳號：「已吃 0 kcal」、營養素都是「未設定」）。

- [ ] **Step 2：`e2e/body-targets.spec.ts`**：
  - `openMe` 換成：

```ts
/** 我的 → 身體與目標（首頁改版規格 §5、§6）：三張卡片搬到那一頁了。 */
async function openHub(page: Page) {
	await page.getByRole("link", { name: "我的", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "我的", exact: true, level: 1 }),
	).toBeVisible();
	await page.getByRole("link", { name: "身體與目標", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "身體與目標", exact: true, level: 1 }),
	).toBeVisible();
}
```

    每一個 `openMe(page)` 換 `openHub(page)`；`recordWeightOnMe` 改名 `recordWeightOnHub`（呼叫端一起改）。
  - `applySuggestion` 與第 161、217、255 行附近「存好之後等『我的』的標題」→「身體與目標」（`grep -n '"我的"' e2e/body-targets.spec.ts` 逐一看，**只改存好之後的那幾個**；
    `openHub` 裡那一個是真的去「我的」）。
  - 第 179 行 `toContainText(\`/ ${kcal} kcal\`)` → `toContainText(\`預算 ${kcal}\`)`。
  - 第三條最後（卡片「比 7 天前 -0.4 公斤」之後）加：點導覽「總覽」→ `getByTestId("weight-glance")` 含「79 公斤」與「比 7 天前 -0.4 公斤」（規格 D12：同一套 `weekChange`），
    卡片裡有 `weight-sparkline`（那條測試記的四天裡至少兩天在最近 30 天內——**寫之前看一次那四個日期**，不夠的話斷言 `toHaveCount(0)` 並在註解說明）。
  - 第三條（`/weight` 記四天、切期間、改一筆、刪一筆）在「刪一筆」之後加（規格 D24；用那條測試已經有的 `chart`、`points` 兩個 locator）：

```ts
	// 折線圖：每天的紀錄連成一條實線，組數＝看得到的點數；7 天平均是虛線。
	const daily = chart.getByTestId("weight-line");
	await expect(daily).toHaveCount(1);
	const pairs = ((await daily.getAttribute("points")) ?? "").split(" ").length;
	expect(pairs).toBe(await points.count());
	const dash = await chart
		.getByTestId("weight-average")
		.evaluate((node) => getComputedStyle(node).strokeDasharray);
	expect(dash).not.toBe("none");
	await expect(page.getByText("每天的紀錄", { exact: true })).toBeVisible();
	await expect(page.getByText("7 天平均", { exact: true })).toBeVisible();
```

    （`points` 是那條測試裡數點的 locator，名稱照現況；圖例的兩段字跟色塊在同一個 `<p>` 裡，`exact: true` 對不上的話照 handover §7「`getByText`：testing-library 與 Playwright 不一樣」改用不帶 `exact` 的。）

- [ ] **Step 3：`e2e/exercise.spec.ts`**：
  - `openMe` → 同 Step 2 的 `openHub`（每一個呼叫都換：1. 目標、6b. 體重更正、7. 開關，都在身體與目標上）。
  - 「1. 目標 2000」手動存好之後等的「我的」標題 →「身體與目標」。
  - `openAddExercise` 的第二行 → `page.getByRole("dialog", { name: "新增紀錄", exact: true }).getByRole("link", { name: "記運動", exact: true }).click()`（規格 D18）。
  - `todayKcal` 的斷言：`/ ${2000 + thirty} kcal` → `預算 ${2000 + thirty}`；`含運動 +${thirty}` → `（含運動 +${thirty}）`；`sixty` 的兩組同樣；`"/ 2000 kcal"` → `"預算 2000"`；
    `not.toContainText("含運動")` 照舊。

- [ ] **Step 4：`e2e/planner.spec.ts`**：`toContainText("732.5 / 700 kcal")` 換成

```ts
	// 總覽顯示到整數（首頁改版規格 D19）：已吃 733、超過 33。「白飯照份量算 300 g」的精度改在飲食頁的熱量列守（732.5）。
	const todayKcal = page.getByTestId("today-kcal");
	await expect(todayKcal).toContainText("已吃 733・預算 700");
	await expect(todayKcal).toContainText("超過 33 kcal");
```

  並在同一條後面「飲食頁那一餐」的步驟（進了飲食頁之後）加 `await expect(page.getByTestId("macro-kcal")).toContainText("732.5 / 700");`。

- [ ] **Step 5：`cd frontend && npm run -s typecheck`**（Playwright 不做型別檢查，handover §7），再跑這四個 spec：
  `npx playwright test e2e/account-settings.spec.ts e2e/body-targets.spec.ts e2e/exercise.spec.ts e2e/planner.spec.ts` → PASS。

- [ ] **Step 6：突變**（手動，各跑對應的 spec，跑完 `git diff` 確認還原）：`BudgetSummary` 的「預算 」改成「額度 」→ 四個 spec 都紅；
  `Targets.tsx` 導回 `/me` → account-settings、exercise 紅；`index.css` 的 `.weight-average` 拿掉 `stroke-dasharray: 4 3;` → body-targets 第三條紅（虛線）。

- [ ] **Step 7：Commit。** `git add frontend/e2e/account-settings.spec.ts frontend/e2e/body-targets.spec.ts frontend/e2e/exercise.spec.ts frontend/e2e/planner.spec.ts`；
  訊息 `test(e2e): 三張卡片搬到身體與目標、總覽的熱量改成「還能吃／已吃・預算」，既有的 e2e 跟著改（首頁改版 Task 7）`。

---

## Task 8：新的 e2e、截圖

**Files:** `frontend/e2e/home.spec.ts`（新）；`$S/home-fe-shots.cjs`（不進 repo）

- [ ] **Step 1：`e2e/home.spec.ts`。**

```ts
import {
	type APIRequestContext,
	expect,
	type Locator,
	type Page,
	test,
} from "@playwright/test";
import type { components } from "../src/api/schema.d.ts";
import { generateJpegBuffer } from "./jpeg.ts";
import { loginAs, type NewAccount, newAccount } from "./new-account.ts";
import { expectTouchTargets } from "./touch-targets.ts";

type AnalyzeMealResponse = components["schemas"]["AnalyzeMealResponse"];

// 首頁改版（規格 §9.3）。設定資料用 API，要驗的行為用畫面；登入之後只用點擊換頁。只假造 AI 端點。
const PHONE = { width: 390, height: 844 };

async function tokenOf(request: APIRequestContext, account: NewAccount) {
	const login = await request.post("/api/auth/login", {
		data: { email: account.email, password: account.password },
	});
	expect(login.ok()).toBe(true);
	return ((await login.json()) as { access_token: string }).access_token;
}

function auth(token: string) {
	return { authorization: `Bearer ${token}` };
}

/** 熱量 2000、蛋白質 120、脂肪不設、碳水 250（`TargetTodayRequest` 四個鍵都必填）。 */
async function setTargets(request: APIRequestContext, token: string) {
	const response = await request.put("/api/targets/today", {
		headers: auth(token),
		data: { kcal: "2000", protein_g: "120", fat_g: null, carb_g: "250" },
	});
	expect(response.ok()).toBe(true);
}

/** 每 100 g：500 kcal／蛋白質 20／脂肪 15／碳水 60。回 id。 */
async function createBento(request: APIRequestContext, token: string, name: string) {
	const response = await request.post("/api/foods", {
		headers: auth(token),
		data: {
			name,
			nutrition: { base_unit: "g", kcal: "500", protein_g: "20", fat_g: "15", carb_g: "60" },
		},
	});
	expect(response.status()).toBe(201);
	return ((await response.json()) as { id: number }).id;
}

/** 「YYYY-MM-DD」加減幾天（UTC，同 body-targets.spec 的 `shiftDays`）。起點是後端給的今天。 */
function shiftDays(date: string, days: number): string {
	const [y, m, d] = date.split("-").map(Number);
	return new Date(Date.UTC(y ?? 0, (m ?? 1) - 1, (d ?? 1) + days))
		.toISOString()
		.slice(0, 10);
}

/** 記幾天體重（`PUT /api/weights/{date}`）。日期從 `GET /api/weights` 的 `today` 往回算——使用者的今天，不是這台機器的。 */
async function logWeights(
	request: APIRequestContext,
	token: string,
	byDaysAgo: ReadonlyArray<readonly [number, string]>,
) {
	const list = await request.get("/api/weights", { headers: auth(token) });
	expect(list.ok()).toBe(true);
	const { today } = (await list.json()) as { today: string };
	for (const [daysAgo, kg] of byDaysAgo) {
		const response = await request.put(`/api/weights/${shiftDays(today, -daysAgo)}`, {
			headers: auth(token),
			data: { weight_kg: kg },
		});
		expect(response.ok()).toBe(true);
	}
}

/** 一分鐘前：不是「未來」。跨午夜的風險同 exercise.spec 的已知限制。 */
function aMinuteAgo() {
	return new Date(Date.now() - 60_000).toISOString();
}

async function logMeal(
	request: APIRequestContext,
	token: string,
	foodId: number,
	grams: string,
) {
	const response = await request.post("/api/meals", {
		headers: auth(token),
		data: {
			eaten_at: aMinuteAgo(),
			meal_type: "lunch",
			items: [{ food_id: foodId, quantity: grams }],
		},
	});
	expect(response.status()).toBe(201);
}

/** 手動的 343 kcal（不用體重）。 */
async function logRun(request: APIRequestContext, token: string) {
	const response = await request.post("/api/exercises", {
		headers: auth(token),
		data: { activity: "running", minutes: 30, performed_at: aMinuteAgo(), kcal: "343" },
	});
	expect(response.status()).toBe(201);
}

async function openOverview(page: Page) {
	await page.getByRole("link", { name: "總覽", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
	).toBeVisible();
}

async function box(locator: Locator) {
	const value = await locator.boundingBox();
	if (value === null) throw new Error("量不到");
	return value;
}

test.describe("手機 390×844", () => {
	test.use({ viewport: PHONE });

	test("圓環：還能吃、已吃・預算（含運動）、營養素；再吃一餐就超過", async ({ page, request }) => {
		const account = await newAccount(request, "home-ring");
		const token = await tokenOf(request, account);
		const bento = `E2E 便當 ${Date.now()}`;
		await setTargets(request, token);
		const foodId = await createBento(request, token, bento);
		await logRun(request, token);
		await logMeal(request, token, foodId, "300");
		// 兩天體重（3 天前 80、今天 79.4）：迷你折線有兩點（規格 D22）。
		await logWeights(request, token, [
			[3, "80"],
			[0, "79.4"],
		]);
		await loginAs(page, account);

		// 規格 §3.3：額度 2000 + 343 = 2343、吃了 1500。
		const card = page.getByTestId("today-kcal");
		await expect(card).toContainText("還能吃 843 kcal");
		await expect(card).toContainText("已吃 1500・預算 2343（含運動 +343）");
		await expect(card.getByTestId("macro-protein_g")).toContainText("60 / 120");
		await expect(card.getByTestId("macro-fat_g")).toContainText("未設定");
		await expect(card.getByTestId("macro-carb_g")).toContainText("180 / 250");
		const arc = card.getByTestId("calorie-ring-arc");
		await expect(arc).toHaveAttribute("data-tone", "normal");
		await expect(arc).toHaveAttribute("stroke-dasharray", "221.24 345.58");
		await expect(
			page.getByRole("region", { name: "今天熱量", exact: true }),
		).toBeVisible();

		// 體重小卡片：字照樣在（最新一筆；3 天前不到 7 天，沒有「比 7 天前」），下面一條兩點的迷你折線，是裝飾、放得進 390 寬的小卡片。
		const glance = page.getByTestId("weight-glance");
		await expect(glance).toContainText("79.4 公斤");
		const spark = glance.getByTestId("weight-sparkline");
		await expect(spark).toHaveAttribute("aria-hidden", "true");
		await expect(spark.getByTestId("weight-sparkline-line")).toHaveAttribute(
			"points",
			/^\S+ \S+$/,
		);
		const [sparkBox, glanceBox] = [await box(spark), await box(glance)];
		expect(sparkBox.width).toBeGreaterThan(50);
		expect(sparkBox.x + sparkBox.width).toBeLessThanOrEqual(glanceBox.x + glanceBox.width);
		expect(Math.round(sparkBox.height)).toBe(32);

		// 再記 200 g（今天記過，在常吃的清單裡）：1500 + 1000 = 2500 → 超過 157。
		await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
		await page
			.getByRole("dialog", { name: "新增紀錄", exact: true })
			.getByRole("link", { name: "記一餐", exact: true })
			.click();
		await expect(
			page.getByRole("heading", { name: "記一餐", exact: true, level: 1 }),
		).toBeVisible();
		await page.getByRole("button", { name: bento, exact: true }).click();
		await page.getByLabel("份量", { exact: true }).fill("200");
		await page.getByRole("button", { name: "記錄", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "總覽", exact: true, level: 1 }),
		).toBeVisible();
		await expect(card).toContainText("超過 157 kcal");
		await expect(card).toContainText("已吃 2500・預算 2343（含運動 +343）");
		await expect(arc).toHaveAttribute("data-tone", "over");
		await expect(arc).toHaveAttribute("stroke-dasharray", "345.58 345.58");
	});

	test("沒有目標：已吃 0、還沒有每日目標，連到每日目標頁", async ({ page, request }) => {
		const account = await newAccount(request, "home-empty");
		await loginAs(page, account);
		const card = page.getByTestId("today-kcal");
		await expect(card).toContainText("已吃 0 kcal");
		await expect(card).toContainText("還沒有每日目標");
		await expect(card.getByTestId("calorie-ring-arc")).toHaveCount(0);
		await expect(page.getByTestId("weight-glance")).toContainText("記錄體重");
		await expect(page.getByTestId("weight-sparkline")).toHaveCount(0);
		await card.getByRole("link", { name: "設定每日目標", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "每日目標", exact: true, level: 1 }),
		).toBeVisible();
	});

	test("快速記錄：拍照記到確認照片、掃條碼開掃描層、記運動、記體重；「＋」四個入口", async ({ page, request }) => {
		const account = await newAccount(request, "home-quick");
		const stamp = Date.now();
		const estimate = {
			// 形狀照 ai-photo-hint.spec.ts 第一條的 `estimate`（一樣、`library_food: null`），名稱與描述帶 stamp。
		} satisfies AnalyzeMealResponse;
		const sent: Array<Record<string, unknown>> = [];
		await page.route("**/api/ai/analyze-meal", async (route) => {
			sent.push(route.request().postDataJSON() as Record<string, unknown>);
			await route.fulfill({ json: estimate });
		});
		await loginAs(page, account);

		const actions = page.getByRole("list", { name: "快速記錄", exact: true });
		await expect(actions.getByRole("listitem")).toHaveCount(4);
		await expectTouchTargets(actions.locator("a, label"), "快速記錄");

		// 拍照記：一按就是檔案輸入（iOS 開相機，規格 D8）→ 記一餐的確認照片卡片、焦點在卡片 → 開始估算。
		const photo = page.getByLabel("拍照記", { exact: true });
		await expect(photo).toHaveAttribute("capture", "environment");
		await photo.setInputFiles({
			name: "lunch.jpg",
			mimeType: "image/jpeg",
			buffer: await generateJpegBuffer(page),
		});
		await expect(
			page.getByRole("heading", { name: "記一餐", exact: true, level: 1 }),
		).toBeVisible();
		const step = page.getByRole("region", { name: "確認照片", exact: true });
		await expect(step).toBeFocused();
		await step.getByRole("button", { name: "開始估算", exact: true }).click();
		await expect(
			page.getByRole("region", { name: "AI 估算結果", exact: true }),
		).toContainText(estimate.description);
		expect(sent).toHaveLength(1);
		expect(sent[0]?.kind).toBe("image");
		expect(String(sent[0]?.image_base64).length).toBeGreaterThan(100);
		expect(sent[0]).not.toHaveProperty("hint");

		// 掃條碼：記一餐一打開就是掃描層（headless 沒有相機：錯誤狀態，手動輸入照樣在）→ 取消 → 焦點在「掃條碼」。
		await openOverview(page);
		await page.getByRole("link", { name: "掃條碼", exact: true }).click();
		const scanner = page.getByRole("dialog", { name: "掃條碼", exact: true });
		await expect(scanner).toBeVisible();
		await expect(
			scanner.getByRole("button", { name: "手動輸入條碼", exact: true }),
		).toBeVisible();
		await scanner.getByRole("button", { name: "取消", exact: true }).click();
		await expect(scanner).toHaveCount(0);
		await expect(
			page.getByRole("button", { name: "掃條碼", exact: true }),
		).toBeFocused();

		// 記運動：表單。
		await openOverview(page);
		await page.getByRole("link", { name: "記運動", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "記運動", exact: true, level: 1 }),
		).toBeVisible();

		// 記體重：/weight、焦點在體重欄位 → 存 70 → 總覽的小卡片。
		await openOverview(page);
		await page.getByRole("link", { name: "記體重", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
		).toBeVisible();
		const kg = page.getByLabel("體重（公斤）", { exact: true });
		await expect(kg).toBeFocused();
		await kg.fill("70");
		await page
			.getByTestId("weight-form")
			.getByRole("button", { name: "儲存", exact: true })
			.click();
		await expect(
			page.getByRole("list", { name: "體重紀錄", exact: true }).getByRole("listitem"),
		).toHaveCount(1);
		await openOverview(page);
		await expect(page.getByTestId("weight-glance")).toContainText("70 公斤");
		// 只有一筆：沒有迷你折線，只有字（規格 D22）。
		await expect(page.getByTestId("weight-sparkline")).toHaveCount(0);

		// 「＋」：四個入口、2×2（第三個在第一個下面）、記體重同一個去處。
		await page.getByRole("button", { name: "新增紀錄", exact: true }).click();
		const sheet = page.getByRole("dialog", { name: "新增紀錄", exact: true });
		const links = sheet.getByRole("link");
		await expect(links).toHaveText(["記帳", "記一餐", "記運動", "記體重"]);
		await expectTouchTargets(links, "新增選單");
		const [first, third] = [await box(links.nth(0)), await box(links.nth(2))];
		expect(third.y).toBeGreaterThan(first.y + first.height - 1);
		expect(Math.abs(third.x - first.x)).toBeLessThan(2);
		await sheet.getByRole("link", { name: "記體重", exact: true }).click();
		await expect(
			page.getByRole("heading", { name: "體重", exact: true, level: 1 }),
		).toBeVisible();
		await expect(page.getByLabel("體重（公斤）", { exact: true })).toBeFocused();
	});
});

test("身體與目標與精簡的「我的」（電腦版）", async ({ page, request }) => {
	// 預設 1280×720＝電腦版（SideNav 的連結名稱跟 TabBar 一樣）。
	const account = await newAccount(request, "home-hub");
	await loginAs(page, account);
	const nav = page.getByRole("navigation", { name: "主要導覽" });

	await nav.getByRole("link", { name: "我的", exact: true }).click();
	await expect(page.getByRole("heading", { name: "我的", exact: true, level: 1 })).toBeVisible();
	const entry = page.getByTestId("body-hub-entry");
	await expect(entry).toContainText("還沒設定");
	for (const id of ["targets-card", "weight-card", "body-profile-card"]) {
		await expect(page.getByTestId(id)).toHaveCount(0);
	}
	const hubLink = entry.getByRole("link", { name: "身體與目標", exact: true });
	await expect(hubLink).toHaveAccessibleDescription("還沒設定");

	await hubLink.click();
	await expect(
		page.getByRole("heading", { name: "身體與目標", exact: true, level: 1 }),
	).toBeVisible();
	// 在 /me 底下：「我的」照樣是目前的分頁（規格 D1）。
	await expect(nav.getByRole("link", { name: "我的", exact: true })).toHaveAttribute(
		"aria-current",
		"page",
	);
	const order = await page
		.locator('main [data-testid="targets-card"], main [data-testid="weight-card"], main [data-testid="body-profile-card"]')
		.evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-testid")));
	expect(order).toEqual(["targets-card", "weight-card", "body-profile-card"]);

	// 體重卡片記 79（同 body-targets.spec 的 recordWeightOnHub 的步驟）。
	const weightCard = page.getByTestId("weight-card");
	await weightCard.getByRole("button", { name: "記錄體重", exact: true }).click();
	await weightCard.getByLabel("體重（公斤）", { exact: true }).fill("79");
	await weightCard.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(weightCard).toContainText("79 公斤");

	// 手動存目標 2110 → 回到身體與目標（D2）。
	await page.getByRole("link", { name: "修改每日目標", exact: true }).click();
	const manual = page.getByRole("region", { name: "自己設定", exact: true });
	await manual.getByLabel("熱量（kcal）", { exact: true }).fill("2110");
	await manual.getByRole("button", { name: "儲存", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "身體與目標", exact: true, level: 1 }),
	).toBeVisible();
	await expect(page.getByTestId("targets-card")).toContainText("2110 kcal");

	await nav.getByRole("link", { name: "我的", exact: true }).click();
	await expect(entry).toContainText("2110 kcal・79 公斤");
	await expect(hubLink).toHaveAccessibleDescription("2110 kcal・79 公斤");
});

test.describe("電腦版 1280×800", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("總覽：圓環、快速記錄、小卡片在時間線左邊；兩張小卡片並排", async ({ page, request }) => {
		const account = await newAccount(request, "home-desktop");
		await loginAs(page, account);
		const ring = await box(page.getByTestId("today-kcal"));
		const actions = await box(page.getByRole("list", { name: "快速記錄", exact: true }));
		const spend = await box(page.getByTestId("month-spend"));
		const weight = await box(page.getByTestId("weight-glance"));
		const timeline = await box(page.getByRole("heading", { name: "今天", exact: true }));
		for (const left of [ring, actions, spend, weight]) {
			expect(timeline.x).toBeGreaterThan(left.x + left.width);
		}
		expect(weight.x).toBeGreaterThan(spend.x + spend.width - 1);
		expect(Math.abs(weight.y - spend.y)).toBeLessThan(2);
		expect(actions.y).toBeGreaterThan(ring.y + ring.height - 1);
	});
});
```

  `estimate` 的內容照 `ai-photo-hint.spec.ts` 第一條補完（`analysis_id`、`description: \`E2E 首頁拍照 ${stamp}\``、`remaining_today`、一樣 `items`）。
  「手動輸入條碼」是不是 button 照 `barcode.spec.ts` 第 44 行（是）。`box` 用到 `Locator` 型別（import 已列）。等數字卡片畫出來再量（`box` 前先 `await expect(…).toBeVisible()`，handover §7）。

- [ ] **Step 2：`npm run -s typecheck`**，再 `npx playwright test e2e/home.spec.ts` → 5 passed。

- [ ] **Step 3：e2e 突變**（`$S/home-e2e-mutate.py`，規格 `$S/home-e2e-mutations.json`）：
  1. `BudgetSummary`：`已吃 {eaten}・` → `已吃 {eaten}，` → 紅「圓環」。
  2. `QuickActions`：拿掉 `capture="environment"` → 紅「快速記錄」。
  3. `App.tsx`：`startScanning={scan}` → `startScanning={false}` → 紅「快速記錄」（掃描層沒開）。
  4. `AddSheet.module.css`：`repeat(2, …)` → `repeat(4, …)` → 紅「快速記錄」（2×2）。
  5. `Overview.module.css`：加回 `:global(.app-desktop) .cards { grid-template-columns: minmax(0, 1fr); }` → 紅「電腦版」（並排）。
  6. `BodyHubEntry`：拿掉 `aria-describedby` → 紅「身體與目標」。
  7. `WeightSparkline`：`recent.length < 2` → `recent.length < 3` → 紅「圓環」（兩筆時沒有線）。
  8. `WeightSparkline.module.css`：`height: 32px` → `height: 64px` → 紅「圓環」（高度）。

- [ ] **Step 4：完整的 e2e 跑兩次**（同一個 dev 資料庫，`docker compose up -d --build api` 之後）：`npx playwright test > "$S/home-e2e-full1.log" 2>&1`、`…full2.log`。
  兩次都全綠；記下 passed 的條數與時間。只在某幾個 worker 數紅的照實記（handover §6「掃條碼」那一條 6 個 worker 的先例）。

- [ ] **Step 5：截圖**：`cp "$S/hint-fe-shots.cjs" "$S/home-fe-shots.cjs"`，改成：
  - 兩個新帳號（同檔案的 `newAccount`）：A 用 API 設 §3.3 那一組（目標、運動、便當 300 g），B 什麼都不設。
  - 每一種組合跑一次：`{390×844, 1280×800} × {light, dark}`（`browser.newContext({ viewport, colorScheme })`）。
  - A 另外用 API 記五天體重（20、10、6、3 天前與今天：80.2、79.8、79.9、79.4、79.0），迷你折線與 `/weight` 的折線才有東西看。
  - 拍：A 的總覽（一般，體重小卡片有迷你折線）→ A 再用 API 記 200 g、點別的分頁再回總覽（重抓）→ 總覽（超過）；B 的總覽（沒有目標、沒有線）；A 的「我的」；
    A 的身體與目標（`fullPage`）；A 的 `/weight`（實線、點、虛線的平均、目標線、圖例）。
  - 每張印出有沒有水平捲動（腳本已經有 `shot()`）；量快速記錄四顆的高度（`heights()`）。
  `node "$S/home-fe-shots.cjs" "$S/home-shots" 390 844 phone`、`… 1280 800 desktop`；dark 用第五個參數或兩份腳本。**看每一張**：
  圓環中間的字不跟圓環重疊、超過的紅字在深色模式看得清楚、四顆在 390 寬不換行、「已吃・預算」換行在「・」之後、2×2 的「＋」、
  迷你折線在 390 寬的小卡片裡不溢出、線寬沒有被拉粗、`/weight` 的實線與虛線分得出來（深色模式的虛線看得到）。看到問題就修（CSS），修完重拍、
  重跑相關的單元測試與 e2e，記進「執行中發現的差異」。

- [ ] **Step 6：Commit。** `git add frontend/e2e/home.spec.ts`（加上截圖之後修的 CSS 檔）；
  訊息 `test(e2e): 首頁改版——圓環的數字、沒有目標、快速記錄、身體與目標、電腦版的兩欄（首頁改版 Task 8）`。

---

## Task 9：文件

**Files:** `docs/handover.md`、`docs/superpowers/specs/2026-10-22-home-redesign-design.md`、這份計畫

- [ ] **Step 1：`docs/handover.md`**：
  - §2 的數字（前端測試檔數／條數照 vitest 印的、e2e 條數；**照 vitest 印出來的寫**，不要自己除以二，§7）與階段進度加一行「首頁改版」。
  - §10 最後加一節「### 首頁改版：熱量圓環、快速記錄、身體與目標」（同「照片＋補充說明」那一節的格式）：規格與計畫的路徑、**沒有 migration、沒有新端點、沒有新的環境變數**；
    總覽（圓環的狀態、`kcalBalance`、`today-kcal` 的意義變了）、快速記錄（四個的機制與 iOS 的理由、`lib/quick-actions.ts` 的暫存）、身體與目標（`/me/health`、
    存好導回這裡）、「我的」（入口卡片、`aria-describedby`）、「＋」（2×2）、體重的折線（`lib/weight-plot.ts` 兩張圖共用、迷你折線沿用 `useWeights` 不加 key、
    `/weight` 的實線＋點與虛線的平均、跨過沒記的日子）；新的東西在哪裡（檔案、測試、e2e）。「身體資料與目標」那一節 `/weight` 那一格補一句「首頁改版之後是折線圖」。
  - 「身體資料與目標」那一節的前端表格裡「「我的」的順序：通知 → 帳號 → 每日目標 → 身體資料 → 體重…（D21）」改成指到新的一節（三張卡片在身體與目標）；
    「運動紀錄」那一節「入口：`AddSheet.tsx` 三個（`repeat(3, …)`）」「總覽：今天熱量的分母…」兩格補一句「首頁改版之後見…」。
  - §7 的表：「畫出『我的』的單元測試」那一列改成「畫出**身體與目標**的單元測試」（`bodyRoutes()` 放最前面的規矩搬到 `body-hub.test.tsx`；「我的」只剩 `/api/weights`
    與 `/api/stats/daily`）；加新的坑（實作中真的踩到的才寫；至少：「`getByRole` 不看 `aria-modal`：『＋』開著時總覽的同名連結也找得到」）。
  - §8.2 加「首頁改版的已知限制」：iOS 實機沒有驗證拍照記（一按開相機）與掃條碼（一打開就開相機）；拍照記只能拍、不能從相簿選；記一餐重新整理會失去帶進來的照片；
    記體重在 iOS 不會自動跳鍵盤；已吃與預算各自捨入，額度有小數時跟「超過 N」可能差 1；「本月支出」的連結名稱含金額；
    體重的線跨過沒記的日子（不斷開）；迷你折線沒有刻度、x 從 30 天裡的第一筆開始，只看得出方向。
- [ ] **Step 2：規格**：狀態改「已實作（日期，`feat/home-redesign`；跟規格不一樣的地方在計畫的『與規格的差異』）」；有審查的話加「審查後的修正」一節。
- [ ] **Step 3：計畫**：「執行中發現的差異」每個 task 一節；「與規格的差異」補實作時多出來的。
- [ ] **Step 4：前端整套最後一次**：`npm run -s test`、`npm run -s typecheck`、`npm run -s lint`（grep `FAIL`／`Unhandled`）。
- [ ] **Step 5：Commit。** `git add docs/handover.md docs/superpowers/specs/2026-10-22-home-redesign-design.md docs/superpowers/plans/2026-10-22-home-redesign.md`；
  訊息 `docs: 首頁改版的交接、已知限制，規格與計畫記下實作的差異（首頁改版 Task 9）`。

---

## 完成條件

- 十個 task（1、1B、2–9）的 commit 都在 `feat/home-redesign` 上（沒有 push）；`git status` 只剩 `lunch.jpg`。
- 前端整套、typecheck、lint 綠；e2e 全套連續兩次綠。
- 每個 task 的突變都被抓到（沒抓到的照實記，補測試再跑）。
- 截圖 2 尺寸 × 2 主題 × （總覽三種、身體與目標、我的、`/weight`）都看過。
- handover 的數字是量出來的。
