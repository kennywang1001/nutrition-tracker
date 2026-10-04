# 修改與刪除已記錄的餐點

**狀態：** 設計定稿，待寫實作計畫
**日期：** 2026-10-04
**前置：** 介面改版第一階段、食物的「一份」已上線（master `417663a`）

---

## 1. 目標與範圍

### 1.1 為什麼要做

記錯一餐現在沒有辦法在 app 裡改——前端沒有任何修改或刪除餐點的介面（handover §8.2）。使用者每天都在用，這是最直接的痛點。後端大部分已經存在：`PATCH /api/meals/{id}`（時間、餐別、備註）、`DELETE /api/meals/{id}`、`POST/DELETE /api/meals/{id}/items`、照片的上傳與刪除。

### 1.2 這份規格做的事

使用者可以：

- **A.** 改某一項的份量或數量
- **B.** 加一項、刪一項
- **C.** 改餐別
- **E.** 改金額（修改、補上、拿掉餐費）
- **F.** 刪除照片
- 刪除整餐——**連餐費一起刪**

### 1.3 明確不做

- **改時間（D）**：要處理時區（`datetime-local` 沒有 offset，後端 `AwareInstant` 會 422）與跨日（這一餐會移到另一天），工作量接近其他項目的總和。記錯日期的情況少，刪掉重記也快。
- 換掉某一項的食物（刪掉那項、再加一項）
- 在總覽時間線上改支出（支出在報表改）
- 「全部儲存」——每個動作各自立即送出（§4.2）

---

## 2. 已經做出的決定

| 決定 | 選項 | 理由 |
|---|---|---|
| 刪一餐時餐費怎麼辦 | **一起刪，同一個交易** | 記錯一餐通常是要整筆撤銷；真的要留那筆錢，到報表另記一筆 |
| 能改什麼 | **A、B、C、E、F**；時間（D）之後 | 見 §1.3 |
| 後端要不要改 | **補後端**：每個動作一次請求、一個交易 | 不補的話改份量是「刪了再加」、改金額要前端自己找對應的支出——都有做一半的狀態 |
| 編輯介面在哪 | **獨立畫面 `/meals/:id/edit`**，飲食頁卡片與總覽時間線都點得進來 | 「加一項」需要選食物的介面，塞進卡片會很擠；總覽是使用者最先看到今天這幾餐的地方 |

---

## 3. 後端

### 3.1 新增 `PATCH /api/meals/{meal_id}/items/{item_id}`

- 請求：`{ quantity?: Decimal, portion_id?: int | null }`（`exclude_unset`；`quantity` 的限制同 `MealItemCreateRequest.quantity`；顯式 `quantity: null` → 422）。
- 擁有權：同 `DELETE .../items/{item_id}`——`_load_owned_meal` 確認是自己的一餐，再確認 `item_id` 屬於**這一餐**；否則 404（body 逐字相同，handover §4.7）。
- **不能換食物**：請求裡沒有 `food_id`。
- `portion_id` 有值時：用 `load_visible_portion` 載入（看不到 → 404），且 `portion.food_id` 必須等於這一項的食物 → 否則 422 `PORTION_FOOD_MISMATCH`（同 `_resolve_item`）。
- `quantity_g` 用新的 `portion` 與 `quantity` 重算（同 `_resolve_item` 的算法：`(portion.grams * quantity)` 四捨五入到分；沒有份量時等於 `quantity`）。
- **`food_revision_id` 不變**——「凍結歷史」（handover §4.3）：改的是「吃了多少」，不是「用哪一版營養素」。
- 回應：整筆 `MealResponse`（同 `POST .../items`）。

### 3.2 `PATCH /api/meals/{meal_id}` 多一個選填 `cost`

| 請求 | 行為 |
|---|---|
| 不帶 `cost` | 不動餐費（既有行為） |
| `cost: "200"`，這一餐**有**餐費 | 改那筆支出的 `amount` |
| `cost: "200"`，這一餐**沒有**餐費 | 新增一筆支出：`category=food`、`spent_at = meal.eaten_at`、`meal_id = meal.id`、`user_id = user.id`（同 `POST /api/meals` 的 `cost`） |
| `cost: null` | 刪掉這一餐的餐費（沒有的話什麼都不做） |

- `cost` 的限制同 `MealCreateRequest.cost`（`gt=0, max_digits=10, decimal_places=2`）。
- 跟餐別、備註在**同一個交易**。

**前提：一餐最多一筆餐費。** `POST /api/meals` 只會建一筆；`PATCH /api/expenses/{id}` 不能改 `meal_id`（P5 規格 §5.1）；手動記帳的 `meal_id` 一律是 NULL。實作時要在程式裡寫明這個前提，並用「`meal_id = meal.id` 的第一筆（依 id）」作為那筆餐費。

### 3.3 `MealResponse` 多一個 `cost: Decimal | None`

- 這一餐的餐費金額，沒有就是 `null`。
- `GET /api/meals`（清單）、`GET /api/meals/{id}`、`PATCH`、`POST .../items`、`PATCH .../items/{id}` 的回應都要帶。
- 清單要**一次查完**（`meal_id IN (...)`），不是每一餐各查一次——跟 `list_meals` 查項目同一個作法。

### 3.4 `DELETE /api/meals/{meal_id}` 連餐費一起刪

- 同一個交易：先刪掉 `meal_id = meal.id` 的支出，再刪餐點；照片清理維持在 commit 之後（既有行為）。
- **不改 `expenses.meal_id` 的 `ON DELETE SET NULL`**：那條約束仍然守著「錢不會因為別的路徑刪了餐點而無聲消失」（P5 規格 §2.3）。

### 3.5 後端測試

- **改項目**：改數量重算 `quantity_g`；換份量重算；`food_revision_id` 不變（食物有新版本之後改數量，仍是舊版本）；別人的餐 404；別餐的項目 404；份量不屬於這個食物 422；`quantity: null` 422。
- **改金額**：§3.2 表格的四種情況各一條；`cost` 格式錯誤 422 且餐點沒有被改（同一個交易）。
- **刪一餐**：餐費被刪；**只刪這一餐的**（同一天另一餐的餐費、手動記帳的支出都還在）。突變：拿掉刪支出那一步 → 紅。
- **`cost` 回應**：清單與單筆都正確；沒有餐費時是 `null`。
- 跨使用者隔離：改別人的餐的 `cost` → 404，且別人的支出沒被動。

### 3.6 `schema.d.ts`

重新產生（Windows 上加 `PYTHONUTF8=1 PYTHONIOENCODING=utf-8`）。

---

## 4. 前端

### 4.1 先抽出兩個共用元件

- **`FoodPicker`**：搜尋框＋常吃／最近吃清單，選了之後回呼 `onSelect(food)`。從 `LogMeal` 原樣搬出（包括 `nutrition === null` 的食物不能選、`NO_REVISION_MESSAGE`）。
- **`PortionQuantityFields`**：份量下拉＋數量＋單位提示，包含食物份量規格 §6 的規則與「動過數量就鎖住」（提交 `778afb1`）。

`LogMeal` 改用這兩個元件，**行為一個字都不變**——**`tests/log-meal.test.tsx` 一條都不改**就是證明。e2e 依賴的文字（「搜尋食物」「份量」「份量選項」「已選擇：{名稱}」「記錄」）全部保留。

### 4.2 編輯畫面 `/meals/:id/edit`（`EditMeal.tsx`）

由上而下：

1. **標題列**：✕（回上一頁）、「編輯這一餐」。
2. **這一餐**：餐別下拉、金額（選填）、備註，一顆「儲存」→ `PATCH /api/meals/{id}`（只送有改的欄位；金額清空 → `cost: null`）。
3. **項目**：每一列顯示「食物名 · 份量／數量 · kcal」，兩個動作：
   - 「修改」→ 展開 `PortionQuantityFields`（帶入目前的份量與數量）＋「儲存」→ `PATCH .../items/{item_id}`；「放棄」收起。
   - 「刪除」→ 確認 → `DELETE .../items/{item_id}`。
   - 清單最後「＋ 加一項」→ `FoodPicker` → 選了食物之後 `PortionQuantityFields` → 「加入」→ `POST .../items`。
   - 沒有項目時：「這一餐沒有項目」。
4. **照片**：有照片時顯示，「換照片」（既有的 `useUploadMealPhoto`）、「刪除照片」（確認 → `DELETE /api/meals/{id}/photo`）；沒有照片時只有「加照片」。
5. **「刪除這一餐」**（最下面）：確認（`role="alertdialog"`）。有餐費時寫「這一餐的餐費 $X 也會一起刪除」。刪完 `navigate(-1)`（沒有上一頁時回 `/`）。

**每個動作各自立即送出**，沒有「全部儲存」。

### 4.3 入口

- 飲食頁每張餐點卡片（`MealList`）加「編輯」連結。
- 總覽時間線的**餐點列**變成連到 `/meals/{id}/edit` 的連結；支出列不變（介面改版規格 §1.3「列不能點」只對支出列保留）。

### 4.4 資料流

- 新增 `useMeal(id)`：key `["meals", id]`——掛在 `queryKeys.meals`（`["meals"]`）底下，既有的失效會一起打到它。
- **注意 `queryKeys.mealPhoto` 是 `["meal-photo", id]`，不在 `["meals"]` 底下**（介面改版最終審查查證過），照片要另外失效。

| 動作 | 失效 |
|---|---|
| 改餐別／備註 | `meals`（前綴，含這一餐） |
| 改金額 | ＋ `expensesAll` |
| 改／加／刪項目 | `meals`、`dailyStats`、`rangeStatsAll`、`frequentFoods`、`recentFoods` |
| 刪除這一餐 | 以上全部＋ `expensesAll`＋這一餐的 `mealPhoto` |
| 刪除照片／換照片 | `meals`、這一餐的 `mealPhoto` |

### 4.5 錯誤處理

- 讀取失敗說失敗；`404` → 「找不到這一餐」（可能在另一台裝置上刪了）。
- 送出中按鈕停用。
- 金額 `VALIDATION_ERROR`（`loc` 含 `cost`）→ `AMOUNT_FORMAT_ERROR`；數量／份量的 422 → 指到那一項（不能說成金額錯誤——同 `LogMeal` 的 `isCostValidationError`）。
- `PORTION_FOOD_MISMATCH` → 「這個份量不屬於這個食物」。
- 每個區塊的錯誤顯示在那個區塊裡，不是整頁一個。

---

## 5. 測試

### 5.1 前端單元／元件

- `FoodPicker`、`PortionQuantityFields` 各自的測試（從 `log-meal.test.tsx` 的行為推得出的最小集合）。
- **`log-meal.test.tsx` 一條都不改，全部綠**（重構的證明）。
- `EditMeal`：
  - 改餐別送出的 body 只有 `meal_type`；改金額送 `cost`；金額清空送 `cost: null`。
  - 改項目送 `PATCH .../items/{id}`，body 是 `quantity` 與 `portion_id`。
  - 刪項目、刪照片、刪一餐都要先確認；取消就不送。
  - 刪一餐的確認文字：有餐費時含金額，沒有時不提餐費。
  - 每個動作的失效（spy `invalidateQueries`）。
  - 404 → 「找不到這一餐」；金額 422 → `AMOUNT_FORMAT_ERROR`；數量 422 不說成金額錯誤。
- **入口測試**：`MealList` 卡片的「編輯」連結、總覽時間線的餐點列連結——拿掉就紅。

### 5.2 e2e

記一餐（有金額）→ 從總覽點那一列進編輯 → 改數量 → 回飲食頁確認那一項的公克數變了 → 再進編輯刪除這一餐 → 報表裡那筆餐費不見了。打真的後端；用唯一的食物名稱與備註斷言（平行執行）。

---

## 6. 交付

建議順序：

1. 後端：`cost` 回應欄位＋刪一餐連餐費
2. 後端：`PATCH /api/meals/{id}` 的 `cost`
3. 後端：`PATCH .../items/{item_id}`＋重新產生 `schema.d.ts`
4. 前端：抽出 `FoodPicker`、`PortionQuantityFields`（`LogMeal` 行為不變）
5. 前端：`useMeal`＋編輯畫面（這一餐、項目、照片、刪除）
6. 前端：入口（`MealList`、總覽時間線）
7. e2e
