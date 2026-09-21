# P3-B 前端 — 趨勢圖、食物庫、審核佇列

- 日期：2026-09-21
- 階段：P3（介面）的後半
- 狀態：待審

---

## 1. 目標與範圍

### 1.1 這份規格是在一個沒有成立的前提下寫的

P3-A 規格 §1 對這份規格留了一句警告：

> 後三個畫面的細節在沒有真的用過前四個之前，多半會猜錯 —— **趨勢圖要看什麼、
> 食物庫要怎麼找，這些問題在累積了兩週真實資料之後才有答案。**

**那個前提沒有成立。** P3-A 的程式碼全部寫完並通過 CI，但它從來沒有被部署到
NAS，也就沒有被真的每天用過。Plan 1 Task 1 的 HTTPS、真機的
`isSecureContext` / `serviceWorker` / `navigator.locks` 驗證、PWA 安裝與飛航
模式檢查、以及一次真的用手機登入 —— 四件事全部仍然待辦。

寫這份規格時的選擇是：**做，但讓依賴品味的部分縮到最小，而且明講它為什麼小。**

三個畫面對「真的用過」的依賴程度差很多：

| 畫面 | 依賴程度 | 理由 |
|---|---|---|
| 管理員審核佇列 | 幾乎不依賴 | 後端 `GET /api/admin/food-revisions` 已經把「新舊數值並排」算好了（`current_kcal` 等四個欄位）。畫面就是把它擺出來加上通過／駁回，做錯了看得出來。 |
| 食物庫管理 | 有一點 | 「怎麼找」要猜，但 `GET /api/foods` 的 `scope=all / global / mine` 已經把主要的分法定死。 |
| 趨勢圖 | 最高 | 「要看什麼」完全是品味問題，而 `GET /api/stats/range` 一次回最多 366 天的逐日資料，怎麼呈現有十幾種都合理的答案。 |

所以 **趨勢圖刻意做最小**：七天、一個指標、實際對目標。這不是省事，是把一個
會猜錯的決定延後到有依據的時候再做。§12 記下了刻意不做的部分。

### 1.2 動手之前發現的事：這個 app 現在建立不了食物

摸後端表面時撞到的，比範圍問題更要緊：

- `LogMeal.tsx` 只讀 `/api/foods/frequent` 與 `/api/foods/recent`，
  而這兩支端點的查詢都以 `Meal.user_id == user.id` 起手 ——
  **它們只回「你已經記錄過的食物」**。
- `POST /api/foods` 存在（`app/api/routes/foods.py:42`），但前端沒有任何地方呼叫。
- `app/cli.py` 只有 `create-admin`、`cleanup-photos`、`cleanup-sessions`，
  **沒有建立食物的指令**。

也就是說：`foods` 資料表是空的時候，記一餐會看到兩個空清單，然後就沒有下一步。
要吃一個沒吃過的東西，唯一的辦法是自己用 curl 打 API。

**這改變了食物庫在 P3 裡的分類。** P3-A 規格把它歸在「有比較好」，但它其實是
P3-A 那四個畫面現在跑不完整的原因。所以這份規格把「全庫搜尋」與「新增食物」
放進必做，而且在記一餐畫面也加一個搜尋框 —— 在需要它的當下就能用，不必先
跳去別的畫面建好再回來。

順帶一提，這也是為什麼審核佇列非有「送審」不可：沒有人送得出提案，佇列永遠
是空的，「使用者送審 → 管理員審核」這條完整路徑在 P3-B 結束時就依然沒被走過。

### 1.3 範圍

三個新畫面：

- **趨勢** —— 最近七天的熱量實際對目標，加一行補劑依從率
- **食物庫** —— 全庫搜尋、新增食物、提議修改、看自己提案的審核結果
- **審核佇列** —— 管理員看待審提案（新舊並排）、通過或駁回

兩處既有畫面的修改：

- **記一餐** —— 加一個搜尋框，走跟食物庫同一支查詢
- **導覽** —— 從兩條連結換成底部 tab bar

### 1.4 範圍外

- **份量管理 UI**（`POST /api/foods/{id}/portions`）。記一餐已經會讀份量清單，
  但沒有 UI 就永遠只能敲公克數。不做的理由是它會再帶進兩條規則（只有管理員
  能建全域份量、預設份量的唯一性），而那兩條跟 P3-B 的主線無關。
- **P2 的 AI 分析流程**。跟 P3-A 一樣不在這裡。
- 見 §12 的完整清單。

---

## 2. 前置條件

**P3-A 必須先完成。** 已完成：PR #9 於 2026-09-21 合併進 `master`，
後端 503 個測試、前端 138 個測試加型別層檢查、6 條 Playwright 契約 E2E 全綠。

**NAS 相關的四件事仍未完成，但不擋 P3-B**（它們擋的是「真的每天用」，
而那正是 §1.1 說的那個沒有成立的前提）：

1. Plan 1 Task 1 的 HTTPS（`tailscale serve` 或 `tailscale cert` + caddy）
2. 真機的 `isSecureContext` / `serviceWorker` / `navigator.locks` 驗證
3. PWA 安裝、standalone、飛航模式檢查
4. 一次真的用手機登入

**這四件事不得以 localhost 的結果代替標記完成。** `127.0.0.1` 是 secure
context，所以在本機上這些能力全部可用 —— 那個綠燈證明不了手機上的情況。

---

## 3. 導覽

### 3.1 底部 tab bar

畫面從兩個變成五個，一排頂部連結在手機寬度下會擠到換行，而且在螢幕最上方 ——
單手拿手機時拇指最遠的位置。每天要按好幾次的「記一餐」不該放在那裡。

```
┌────────────────────────┐
│  今日總覽            登出 │
├────────────────────────┤
│                        │
│   熱量  1850 / 2000    │
│   ██████████░░░  93%   │
│                        │
├────────────────────────┤
│ ●今日  記一餐  趨勢  食物庫│
└────────────────────────┘
   管理員時多一格：
│今日 記一餐 趨勢 食物庫 審核│
```

**兩個必須處理的版面細節：**

- **`env(safe-area-inset-bottom)`。** 有 home indicator 的機子（iPhone X 之後）
  最底下一排會被系統的手勢區遮掉一截。tab bar 要墊高這個量。
- **`main` 要補等高的 `padding-bottom`。** 不然 tab bar 會蓋住內容最後一行，
  而「今天最後吃的那一餐」正好就在那個位置。

### 3.2 路由

| 路由 | 畫面 | 狀態 |
|---|---|---|
| `/` | 今日總覽 | 既有，不改 |
| `/log` | 記一餐 | 既有，加搜尋框（§5.4） |
| `/trend` | 趨勢 | 新 |
| `/foods` | 食物庫（搜尋 + 清單） | 新 |
| `/foods/new` | 新增食物 | 新 |
| `/foods/:id` | 食物詳情 | 新 |
| `/admin/revisions` | 審核佇列 | 新 |

### 3.3 管理員 tab 的顯示，以及它為什麼不是授權

審核 tab 只在 `GET /api/me` 回的 `role === "admin"` 時出現
（`UserRole` 是 `"user"` / `"admin"`，見 `app/models/user.py:11`）。

**非管理員直接輸入 `/admin/revisions` 時不做前端導向。** 讓它渲染、讓 API
回 403、顯示「需要管理員權限」。

理由：**前端藏起連結是外觀，不是授權。** 真正的守衛是後端的
`require_admin`（`app/api/deps.py:33`）。如果在前端加一個「不是管理員就
redirect 回首頁」，那麼：

- 一條「非管理員看不到審核佇列」的測試會綠 —— 但它證明的只是 redirect 有效，
  **完全沒有碰到授權**。把後端的 `require_admin` 整個拿掉，那條測試依然綠。
- 而 redirect 之後 403 那條路徑就再也走不到，也就測不到。

所以：連結按 `role` 隱藏（那是可用性），路由永遠可達（那是為了讓真正的
邊界被測到）。

---

## 4. 趨勢

### 4.1 日期錨點 —— 這一節是這個畫面最容易做錯的地方

`GET /api/stats/range` 的 `from` 與 `to` **都是必填**
（`app/api/routes/stats.py:145-146`，`Query(alias="from")` 沒有 default）。
這跟 `GET /api/stats/daily` 不一樣 —— 後者省略 `date` 時會用
`today_in_timezone(user.timezone)` 幫你算今天。

於是「最近七天」需要先知道今天是幾號，而計畫二 Task 4 立下的規矩是
**前端永遠不自己算日界線**。

**解法：拿 `stats/daily` 回應裡的 `date` 當錨點。**

```
GET /api/stats/daily          → { date: "2026-09-21", ... }   ← 伺服器算的今天
                                        ↓ shiftDays(date, -6)
GET /api/stats/range?from=2026-09-15&to=2026-09-21
```

`DailyStatsResponse.date` 就是伺服器對「這個使用者的今天是哪一天」的答案。
前端沒有重新推導它，只是讀回來。

區間**兩端都含**（`app/api/routes/stats.py` 的 `get_range_stats` docstring：
「使用者說『9/1 到 9/7』預期的是 7 天」），所以七天是 `-6` 不是 `-7`。

**代價：冷快取時有一次瀑布式等待。** 趨勢的 query 在錨點回來之前
`enabled: false`。實務上今日總覽已經在打同一支查詢、結果已經在快取裡
（`staleTime: 60_000`），所以通常不會真的多一個往返。離線時 `stats/daily`
在持久化快取裡，錨點一樣拿得到。

### 4.2 `shiftDays` —— 為什麼它不違反「前端不算日界線」

`src/lib/dates.ts` 目前的定位是「只做格式化，不做日界線計算」。加進去的
`shiftDays(isoDate: string, delta: number): string` 看起來像是破例，其實不是：

- **日界線計算**是「現在這個瞬間，在某個時區裡算哪一天」—— 需要問裝置現在
  幾點、需要知道時區。那件事只有伺服器做。
- **`shiftDays` 做的是曆法加減** —— 輸入是一個**伺服器已經決定好的**日曆日
  字串，輸出是另一個日曆日字串。它從頭到尾不問裝置今天幾號。

界線就是這個：**這個函式裡不得出現 `new Date()`（無參數）或 `Date.now()`。**

> **`dates.ts` 的檔頭註解必須同時更新。** 它現在寫著「所以這裡沒有
> `today()`、沒有 `startOfDay()`，**將來也不該有**」。加進 `shiftDays`
> 而不動那段話，文件就跟程式碼互相矛盾 —— 而這個專案已經在三份計畫裡
> 撞過五次「同一份文件裡兩處講同一件事，然後漂移」。
>
> 要改成的意思是：禁止的是**「問現在幾點」**，不是「碰 `Date`」。
> `today()` / `startOfDay()` 依然不該有；`shiftDays` 可以有，因為它的
> 輸入輸出都是伺服器已經決定好的日曆日。

### 4.3 陷阱：`shiftDays` 必須用 UTC accessor，而你的時區剛好遮住這個 bug

`new Date("2026-09-21")` 依 ECMAScript 規範把只有日期的 ISO 字串解析成
**UTC 午夜**。接下來如果用本地時間的 accessor：

```ts
const d = new Date("2026-09-21");
d.setDate(d.getDate() - 6);        // ❌
return d.toISOString().slice(0, 10);
```

在 UTC 以西的時區，`getDate()` 回的是**前一天**：在 `America/New_York`，
UTC 的 2026-09-21 00:00 是當地的 2026-09-20 20:00，`getDate()` 回 20。
整條計算差一天。

正確的寫法用 UTC accessor：

```ts
const d = new Date(`${isoDate}T00:00:00Z`);
d.setUTCDate(d.getUTCDate() + delta);   // ✅
return d.toISOString().slice(0, 10);
```

> **而你在 `Asia/Taipei`（UTC+8，沒有日光節約），剛好看不到這個 bug。**
> UTC 以東時 `getDate()` 回的是同一天，錯誤的寫法在你的機器上、在你的手機上
> 都會給出正確答案。**時區把它遮住了。**
>
> 這代表：一條只在本機跑、只在 CI（UTC）跑的測試**不會紅**。要擋住它，測試
> 必須在一個 UTC 以西的時區下執行。
>
> **而「在 Node 裡改 `process.env.TZ` 會不會真的生效」這件事本身要驗，不能
> 假設。** V8 會快取時區；Node 在某些版本會在 `process.env.TZ` 改變時讓它
> 失效，某些不會。實作時必須先用突變證明這條測試真的紅得起來 —— 用本地
> accessor 的版本跑一次，看到它紅，才算數。如果證明不了，就改成在 vitest
> 設定層設定 `TZ` 的獨立測試專案。

其他必測的邊界：跨月（`2026-03-01` 減 1 天 → `2026-02-28`，2026 不是閏年）、
跨年（`2026-01-01` 減 1 天 → `2025-12-31`）。

### 4.4 圖怎麼畫：手寫 SVG

七根 `<rect>` 加一條目標線，加一行文字的補劑依從率。不引入圖表庫。

**為什麼不用圖表庫，理由裡有一條是這個專案特有的：**

| 選項 | 否決理由 |
|---|---|
| Chart.js（canvas） | **jsdom 沒有 canvas。** 單元測試只能斷言「有一個 `<canvas>`」，斷言不了上面畫了什麼 —— 正好是這個專案一路在抵抗的那種綠燈。`src/lib/resize-image.ts` 當初被隔離出來就是同一個原因。 |
| Recharts（SVG） | 底層是 SVG 所以測得到，但它依賴 `ResizeObserver` 與容器寬度，而 jsdom 裡寬度恆為 0，實務上要 mock 才畫得出東西。gzip 後約 100KB —— 這是一個跑在 Tailscale 上、要預快取給離線用的 PWA。 |
| 手寫 SVG | bundle 增加 0KB；每根柱子可以自己帶 `role` / `aria-label`，Testing Library 查得到、突變得了；跟既有的 `MacroBar.tsx` 同一個作法。代價是度量輸、點選提示都要自己做，之後要的東西變多會有一個轉折點。 |

### 4.5 三個必須處理的資料狀態

**（一）兩層 null。** `DayTrendResponse.target` 的型別是
`NullableMacrosResponse | None`：

- `target` 整個是 `null` —— **那一天沒有生效的目標**
- `target.kcal` 是 `null` —— **有目標，但熱量這一項沒設**

兩者在畫面上的結果一樣（那天不畫目標線），但它們是不同的事實，型別上要分開
看，不能用 `target?.kcal ?? 0` 把兩層壓成一層 —— `0` 會被當成「目標是 0 大卡」
而畫出一條貼地的線。

**（二）沒資料的那天照樣畫。** `actual` 永遠有值，沒吃東西時是 `0.00`
而不是把那一天從陣列裡拿掉（`app/schemas/stats.py` 的
`DayTrendResponse` docstring：「畫圖要連續」）。柱子高度是 0，但那根柱子
**要在**，它的 `aria-label` 也要在。

**（三）全都是 0 又沒有目標。** y 軸上限會是 0，不能拿它當除數。

所有數字都是字串（後端的 `Decimal` 序列化成 JSON 字串），一律走
`src/lib/decimal.ts` —— 那是整個前端唯一允許 `new Decimal()` 的地方。

### 4.6 無障礙標籤，以及它帶來的新一種綠燈說謊

每根柱子帶 `aria-label`，例如
`"9月15日，1850 大卡，目標 2000 大卡"`。這讓 Testing Library 查得到、讓
螢幕閱讀器讀得到。

> **但 `aria-label` 上的數字，跟 `rect` 的高度，可以完全不一致而測試全綠。**
>
> 一份只讀 `aria-label` 的測試證明的是「我們把資料組成了字串」，
> **完全沒有碰到那張圖**。把 `height` 的計算整個改成常數，所有斷言依然綠。
>
> 這是計畫三 `alt=""` 那一課的推廣版：**測試查得到的那個東西，跟使用者看到
> 的那個東西，必須真的是同一個。**
>
> 所以至少要有一條斷言落在幾何上：取兩根柱子，斷言它們的 `height` 比例等於
> 它們數值的比例。這條斷言要用突變證明 —— 把高度改成常數，它必須紅。

### 4.7 補劑依從率

`RangeStatsResponse.adherence` 本來就在同一個回應裡，不另外查。用一行文字呈現
（不畫圖）：

- 有值 → 「補劑依從率 85%」
- `null` → 「這段期間沒有補劑計畫」

**`null` 不能顯示成 0%。** `app/schemas/stats.py` 的 docstring 已經寫明：
0 會讀成「一次都沒吃」，1 會讀成「全部做到」，而 `null` 的意思是「沒有計畫，
這個比率沒有定義」。

---

## 5. 食物庫

### 5.1 搜尋（`/foods`）

`GET /api/foods?q=&scope=&limit=`（`app/api/routes/foods.py:114`）：

- `q` 可省略；有值時是 `Food.name ILIKE %q%`（**只比對名稱，不比對品牌**）
- `scope` 是 `all`（預設）／ `global` ／ `mine`
- `limit` 預設 50，最大 200

畫面：搜尋框 + scope 三選一 + 結果清單 + 「新增食物」按鈕。

### 5.2 新增食物（`/foods/new`）

`POST /api/foods`，body 是 `FoodCreateRequest`：`name`、`brand`（可 null）、
`nutrition`（`base_unit` 預設 `g`，加四個每 100g / 100ml 的數值）。

四個數值的上下限在 `NutritionInput`：`kcal` 是 0–10000，三個巨量營養素是
0–1000，都是 `max_digits=8, decimal_places=2`。前端的輸入驗證要對齊這些，
但**後端的 422 仍然要能顯示** —— 前端驗證是為了少一個往返，不是為了取代它。

### 5.3 食物詳情（`/foods/:id`）與提議修改

畫面內容：目前生效的營養素、份量清單、編輯歷史、「提議修改」。

份量清單**唯讀** —— 只顯示 `GET /api/foods/{id}/portions` 的結果，不能新增
也不能修改（§1.4：份量管理 UI 不在這次範圍內）。

編輯歷史來自 `GET /api/foods/{id}/revisions`（`RevisionResponse` 清單，
新到舊）。每一筆顯示 `status`、`change_note`、`created_at`、`is_current`，
**以及 `reject_reason`**。

> **`reject_reason` 不是裝飾。** 沒有它，送審就是一個回了 201 之後永遠沒有
> 下文的黑洞 —— 使用者不知道提案被駁回了，更不知道為什麼。

**提議修改有兩種結果，UI 必須在按下去之前就講清楚是哪一種：**

```
is_global === false  → 自己的私人食物，立刻生效
is_global === true   → 全域食物，送審，狀態 PENDING
```

後端的判斷是 `is_own_private_food = food.owner_id == user.id`
（`app/api/routes/foods.py` 的 `propose_revision`）。但 `FoodResponse`
**沒有 `owner_id` 欄位** —— 它只有 `is_global`（由 `_to_response` 算成
`food.owner_id is None`）。

所以前端的推導是：

```
is_global === false  ⟹  owner_id 不是 null
                     ⟹  而可見性過濾保證你只看得到 owner_id IS NULL 或 owner_id = 你
                     ⟹  所以 owner_id 就是你
```

**這一步要寫進程式碼註解，因為它不是自明的** —— 它依賴可見性過濾這個外部
保證，而不是依賴這個回應本身帶的資訊。

**不講清楚的後果是具體的**：使用者改了一個全域食物的數值，按下送出，回到
食物詳情看到的還是舊數字（因為提案在 PENDING，`current_revision_id` 沒動），
於是認為功能壞了，再送一次 —— 然後撞上 `409 REVISION_PENDING`。

### 5.4 記一餐的搜尋框

在既有的「常吃 / 最近」上面加一個搜尋框。輸入後走 `useFoodSearch(q, scope)` ——
**跟食物庫共用同一支 query hook，不共用元件。** 兩邊選完之後的去向不一樣
（記一餐進份量輸入，食物庫進詳情頁），共用元件會逼出一個 `onSelect` 分歧
參數，而那正是把兩個不同的畫面綁在一起的開始。

需要 debounce（每敲一個字打一次全庫查詢是不必要的）。

### 5.5 `nutrition === null` 必須擋

`FoodResponse.nutrition` 的型別是 `NutritionResponse | None`，註解寫著
「沒有生效版本時為 None —— 全域食物的初版被駁回就會是這個狀態」。

這種食物**記不了**（沒有 `current_revision_id` 可以釘）。所以：

- 食物詳情要顯示「這個食物還沒有生效的營養素資料」，而不是一片空白或 `NaN`
- **搜尋結果裡這種食物不能被選** —— 在記一餐與食物庫兩邊都是

---

## 6. 審核佇列

### 6.1 畫面

`GET /api/admin/food-revisions`（`app/api/routes/admin_foods.py:19`）回
`PendingRevisionResponse` 清單，依 `created_at` 由舊到新。

**後端已經把新舊並排算好了** —— 每一筆同時帶提案的四個數值與目前生效的四個
數值（`current_kcal` / `current_protein_g` / `current_fat_g` / `current_carb_g`，
食物還沒有生效版本時是 `null`）。畫面就是把它們並排擺出來，不需要在前端再去
查一次那個食物。

每一筆還帶 `food_name`、`food_brand`、`created_by_name`、`change_note`。

### 6.2 通過與駁回

- `POST /api/admin/food-revisions/{id}/approve`
- `POST /api/admin/food-revisions/{id}/reject`，body 是
  `{"reason": "..."}`，**`reason` 必填**（`min_length=1`，最多 500 字）

**不做樂觀更新。** 審核是一個會改變別人看到什麼的動作，先在畫面上假裝成功再
回頭修正，在失敗（尤其是 §6.3 的 409）時會讓人以為自己審過了。成功之後讓
`pendingRevisions`、`food(food_id)`、`foodRevisions(food_id)` 三個 key 失效。

### 6.3 三種失敗必須分開，409 不是邊角料

| 狀況 | 回應 | UI |
|---|---|---|
| 非管理員 | `403 FORBIDDEN`「需要管理員權限」 | 顯示權限不足，不要重試、不要登出 |
| 提案不存在 | `404 REVISION_NOT_FOUND` | 找不到這筆提案 |
| 已經審核過了 | `409 REVISION_NOT_PENDING`「這筆提案已經審核過了」 | 重新載入佇列，並說明它已經被處理掉了 |

**409 會真的發生：** 兩個分頁開著同一個佇列，或兩個管理員同時在看。
`_load_pending` 在 `revision.status is not PENDING` 時拋這個錯
（`app/api/routes/admin_foods.py` 的 `_load_pending`），那是正確的行為 ——
前端要做的是把佇列重取，而不是顯示一句通用的「操作失敗」。

### 6.4 403 與 404 的分界（交接文件 §4.7）

> 「不是你的」與「不存在」必須無法區分。角色不足（非管理員）才是 403。

審核端點符合這條規則：`require_admin` 在任何查詢之前就擋下來，所以非管理員
**永遠**拿到 403，不會因為提案存不存在而有差別。而已經登入的管理員查一個不
存在的 id 才會拿到 404。兩條路徑不交叉。

---

## 7. 資料層

### 7.1 Query key：巢狀是一個決定，不是一個意外

新增的 key：

```ts
me:               ["me"] as const,
rangeStats:       (from: string, to: string) => ["stats", "range", from, to] as const,
food:             (id: number) => ["foods", id] as const,
foodRevisions:    (id: number) => ["foods", id, "revisions"] as const,
foodSearch:       (q: string, scope: FoodScope) => ["food-search", q, scope] as const,
pendingRevisions: ["admin", "food-revisions"] as const,
```

TanStack Query 的 `invalidateQueries` 是**前綴比對**，所以每加一個 key 都要
回答一個問題：**它願不願意被它的前綴連帶失效？**

- **`["foods", id]` 是 `["foods", id, "revisions"]` 與既有
  `["foods", id, "portions"]` 的前綴 —— 這是刻意的。** 審核通過之後，那個
  食物的目前數值、份量、編輯歷史都該重取，一次 `invalidateQueries` 打到三個
  正是要的行為。
- **`foodSearch` 刻意不掛在 `["foods"]` 底下**，沿用計畫三 `meal-photo` 的
  前例。掛下去的話，任何一次 `invalidateQueries({ queryKey: ["foods"] })` 都會
  連帶炸掉**每一組已掛載的搜尋結果與份量清單**。
  獨立命名空間之後，前綴比對自然就做對的事，**而且沒有「忘記加 `exact: true`」
  這個失敗模式** —— 計畫三就是在 `exact` 被漏掉一處之後改用這個作法的。

### 7.2 一條新的失效，它是唯一的守衛

記一餐成功之後，除了既有的四個失效，**要新增一行**：

```ts
queryClient.invalidateQueries({ queryKey: ["stats", "range"] });
```

不加的話，記完一餐切到趨勢，今天那根柱子還是舊的。

這裡用前綴比對是刻意的：`rangeStats` 的 key 帶 `from` / `to` 兩個參數，
要失效的是「所有期間」，而 `["stats", "range"]` 不會碰到
`["stats", "daily"]`。

**而這一行是那條路徑唯一的守衛。** `staleTime: 60_000` 讓切換路由的
unmount／remount 不會自動重取（計畫二 Task 6 為此補上的），所以刪掉這一行，
「記一餐 → 趨勢圖今天那根柱子變高」的 E2E 必須紅。**這個預測要用突變證明。**

### 7.3 離線：`food-search` 不進持久化快取

`me` 與 `rangeStats` 進（都很小，離線時看得到趨勢是好事）。

**`food-search` 不進。** 理由跟照片 blob 同一類：使用者每敲一個字都會產生一組
新的 query key，結果在 `localStorage` 裡越堆越多。撐爆之後 `setItem` 丟
`QuotaExceededError`，**整份離線快取一起寫不進去** —— 不是「搜尋結果存不了」，
是連今日總覽也一起沒了。而那個失敗發生在背景的節流寫入裡，畫面上完全看不出來。

用同一個 `shouldDehydrateQuery` 機制擋。目前那裡是
`query.queryKey[0] !== "meal-photo"`，改成一組排除清單（`meal-photo` 與
`food-search`），用同一種守衛測試：斷言持久化下來的 key 裡不含這兩個命名空間。

---

## 8. 兩件不能動的既有事實

實作時最容易被「順手整理掉」的兩樣東西：

### 8.1 `Nav` 的「重新整理」按鈕要保留，連寫法一起保留

它現在直接呼叫 `apiFetch<{display_name}>("/api/me")`。看起來像是應該換成
`useMe()` 的 `refetch`，**但不能換**。

計畫一有一條 E2E 靠它驗證「access token 過期時會自動換票並重送」，而那條
測試需要一個**由使用者觸發、一定會真的發出請求**的動作。換成
`useMe()` 的 `refetch` 之後會被 `staleTime: 60_000` 擋掉 —— 按下去什麼都不
發生，那條 E2E 會**無聲地失去意義**（它不會紅，它只是不再測到任何東西）。

tab bar 需要 `role`，所以會另外引入 `useMe()` 這個 query。**兩者並存，
不要合併。**

### 8.2 `client.ts` 只在 `=== 401` 換票 —— 而這件事測起來會說謊

已確認：`fetchWithAuthRetry` 的條件是 `response.status === 401`，403 直接落到
`!response.ok` 分支拋 `ApiError`。所以非管理員打 admin 端點不會觸發換票、
不會被強制登出。**這是對的，不需要改。**

> **但這裡有第二種綠燈說謊。** 把那個條件改成 `>= 401`：
>
> 1. 403 觸發換票
> 2. 換票**成功**（refresh token 是好的，這個使用者只是不是管理員）
> 3. 重送原請求
> 4. 又是 403，同一個錯誤碼、同一句訊息
> 5. **畫面上的結果一模一樣**
>
> 一條斷言「看到『需要管理員權限』」的測試**依然會綠**。唯一抓得到這個突變的
> 方式是數請求：多了一次 `/api/auth/refresh`。
>
> 所以那條測試必須斷言請求次數，不能只斷言畫面文字。

---

## 9. 錯誤處理對照

前端需要具名處理、不能落進通用錯誤訊息的回應：

| 端點 | 狀態 | code | UI |
|---|---|---|---|
| `POST /api/foods/{id}/revisions` | 409 | `REVISION_PENDING` | 這個食物已經有一筆待審編輯，請等審核完成 |
| `POST .../approve` `.../reject` | 409 | `REVISION_NOT_PENDING` | 已經被審過了，重新載入佇列 |
| `POST .../approve` `.../reject` | 404 | `REVISION_NOT_FOUND` | 找不到這筆提案 |
| 任何 admin 端點 | 403 | `FORBIDDEN` | 需要管理員權限（不重試、不登出） |
| `GET /api/stats/range` | 422 | `INVALID_RANGE` | 結束日期不能早於開始日期 |
| `GET /api/stats/range` | 422 | `RANGE_TOO_LONG` | 期間最多 366 天 |

最後兩條在「最近七天」這個固定區間下**打不到**，因為 `shiftDays` 算出來的
`from` 永遠早於 `to`、永遠是 7 天。列在這裡是因為 §12 的期間切換做進來之後
它們就會變成可達的，屆時不該從零開始想。

---

## 10. 測試

### 10.1 單元（Vitest + Testing Library）

- 趨勢圖：`target` 整個 null、`target.kcal` 單項 null、全 0 無目標、
  某一天 `actual` 是 0（柱子與標籤都要在）
- **趨勢圖的幾何斷言**（§4.6）：兩根柱子的高度比例等於數值比例
- `shiftDays`：跨月、跨年、閏年、**非 UTC 時區**（§4.3，這條要先證明它紅得起來）
- 食物詳情：`is_global` 兩種值各自的送審措辭
- `nutrition === null` 的食物不能被選
- 審核佇列：409 之後佇列被重取
- 持久化排除：`meal-photo` 與 `food-search` 都不在持久化下來的 key 裡

### 10.2 契約 E2E（Playwright，真後端）

1. 建立食物 → 在記一餐搜尋得到 → 記一筆 → 今日總覽數字變
2. 送審編輯 → 管理員登入 → 佇列看到新舊並排 → 通過 → 食物庫看到新數值
3. 駁回 → 提案者在食物庫的編輯歷史看得到駁回理由
4. 非管理員打 admin 端點 → 403 **且沒有多打一次 `/api/auth/refresh`**（§8.2）
5. 記一餐 → 趨勢圖今天那根柱子變高（守 §7.2 那一行）

需要兩個帳號（一般 + 管理員）。`python -m app.cli create-admin` 已經有了。

> **本機重複跑 E2E 會撞到登入限速。** `GLOBAL_LIMIT = 20` / 60 秒，而且是
> 所有 email 共用 —— 連續跑幾輪之後**全部**測試會一起失敗，而症狀看起來
> 像是功能壞了。解法：`docker compose restart api`。CI 每次都是全新容器，
> 不受影響。（計畫三踩過。）

### 10.3 突變

每一個守衛都要被突變過，綠燈在被觀察到失敗之前不算證據。至少這幾個：

| 突變 | 預期 |
|---|---|
| 柱子高度改成常數 | §10.1 的幾何斷言紅 |
| `shiftDays` 改用本地 accessor | 非 UTC 時區那條紅 |
| 刪掉 `invalidateQueries(["stats","range"])` | E2E 5 紅 |
| `client.ts` 的 `=== 401` 改成 `>= 401` | E2E 4 紅（**靠請求計數，不是靠文字**） |
| `foodSearch` 的 key 改掛回 `["foods", ...]` 底下 | 持久化排除那條紅 |
| 拿掉 `target` 兩層 null 的其中一層判斷 | §10.1 對應那條紅 |

---

## 11. 綠燈說謊（P3-B 新增）

延續 P3-A 規格 §9.2 的九條。這份規格新增四條：

1. **`aria-label` 跟圖畫的東西可以不一致**（§4.6）。查得到標籤不代表圖是對的。
   計畫三 `alt=""` 那一課的推廣版。
2. **前端藏起連結不是授權**（§3.3）。把後端 `require_admin` 拿掉，一條只檢查
   「連結沒顯示」的測試依然全綠。
3. **403 換票的突變不會改變畫面文字**（§8.2）。換票成功、重送、又 403，
   使用者看到的一模一樣。只有請求計數抓得到。
4. **時區遮住了 `shiftDays` 的 bug**（§4.3）。錯誤的實作在 `Asia/Taipei` 與
   CI（UTC）都給出正確答案，只在 UTC 以西壞掉。**測試在正確的環境下跑之前，
   它的綠燈什麼都不代表。**

---

## 12. 不做

| 項目 | 為什麼現在不做 |
|---|---|
| 趨勢圖的指標切換（蛋白／脂肪／碳水） | §1.1：要看什麼是品味問題，沒有真實資料就是猜 |
| 趨勢圖的期間切換（7／30／90 天） | 同上。做進來時 §9 最後兩條錯誤會變成可達 |
| 趨勢圖的自由日期選取 | 同上 |
| 份量管理 UI | 會帶進兩條與主線無關的規則（全域份量的權限、預設份量唯一性） |
| 食物刪除 | 後端沒有這個端點。而且已經被記錄過的食物不能真的刪，要先設計「停用」的語意 |
| 編輯自己已送出的提案 | 後端沒有這個端點。目前只能等審核結果 |
| 補劑相關畫面 | 從 P3-A 起就不在 P3 範圍內 |

**趨勢圖的最小版是刻意的。** 等真的每天用過兩週，再回來擴它 —— 到那個時候
「要看什麼」才會是一個有答案的問題，而不是一個猜測。
