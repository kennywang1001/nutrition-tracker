# 報表看其他月份、匯出資料（CSV）

**狀態：** 已實作（`feat/reports-month-export`）
**日期：** 2026-10-09
**分支：** `feat/reports-month-export`
**前置：** 記帳（`2026-09-28-p5-expenses-design.md`）、電腦版版面（`2026-10-08-desktop-layout-design.md`）、
安全補強（`2026-10-07-hardening-design.md`，`KeyedRateLimiter`）、帳號與目標設定（`2026-10-08-account-settings-design.md`）
**計畫：** `docs/superpowers/plans/2026-10-09-reports-month-export.md`

---

## 1. 範圍

### 1.1 為什麼要做

- **報表只看得到這個月。** 月初打開報表是空的；想知道「上個月花了多少」沒有地方看。後端從 P5 就收 `?month=`，前端固定傳 `null`
  （P5 規格 §8 把「看別的月份」列為範圍外）。
- **資料拿不出來。** 記了一個多月的餐點、花費、補劑只存在這個 app 的資料庫裡——想用試算表算點別的、想備份、哪天不用了想帶走，都做不到。

### 1.2 這份規格做的事

**A. 報表看其他月份。** 報表頂端多一排「‹ 上個月｜2026年10月｜下個月 ›」。看哪個月寫在網址上（`?month=YYYY-MM`，沒有就是這個月），
總額、甜甜圈、分類、清單都跟著換；重新整理、上一頁、下一頁都對。

**B. 匯出資料。** 「我的」多一張「匯出資料」卡片，三顆按鈕「餐點」「花費」「補劑」，各下載**自己**全部歷史的 CSV（Excel 直接打開中文不亂碼）。

### 1.3 明確不做

- 月份選擇器、跳到某一年、自訂日期範圍、年報。一次翻一個月。
- 在過去的月份補記一筆、改一筆花費的日期（既有限制：`spent_at` 不在可改欄位，`Expenses.tsx` 的註解）。記帳永遠記在「現在」。
- 匯入；CSV 以外的格式（JSON、xlsx）；只匯出某一段期間；匯出照片；匯出好友的資料；目標、食物庫、補劑計畫的匯出。
- 背景產生檔案、寄信、下載連結。按了就當場下載。
- 讓清單一次超過 100 筆（既有落差：`GET /api/expenses` 的 `limit` 預設 100，報表算的是整個月——見 §8）。

---

## 2. 決定

### A. 報表的月份

| # | 決定 | 理由 |
|---|---|---|
| A1 | 看哪個月在網址上：`/reports?month=YYYY-MM`；**沒有參數＝這個月** | 重新整理、上一頁／下一頁、書籤免費得到。「沒有＝這個月」讓平常的網址不變，而且跨月之後自動是新的月份 |
| A2 | **「這個月」是後端說的**：報表畫面永遠掛著 `useExpenseSummary(null)`，回應的 `month` 就是 `this_month_in_timezone(user.timezone)`。「下個月」到它為止、網址上的月份有沒有超過，都跟它比 | 前端不算今天、不算這個月（`lib/dates.ts` 檔頭）。那個 query 總覽本來就在用、已經在離線快取裡，不多一個端點 |
| A3 | **後端不改。** `GET /api/expenses` 與 `/summary` 已經收 `month`（`YEAR_MONTH_PATTERN` 驗證、`_resolve_month` 用 `month_bounds` 切使用者時區的月界線）。只補兩條測試 | 查證過（§3.1）。缺的是「明確帶月份時，清單與報表切在同一個地方」的釘子——以前前端不會走到這條路 |
| A4 | 月份的加減與顯示在 `lib/months.ts`：純字串運算（`shiftMonth`、`formatYearMonth`、`isYearMonth`），**不用 `Date`** | 同 `lib/civil-date.ts`：輸入是已經決定好的月份，不問裝置現在幾點；原始碼掃描測試守著 |
| A5 | 能翻到的範圍是後端收的範圍：`1900-01`～`2099-12`，而且不超過這個月。推出範圍 `shiftMonth` 回 `null`、按鈕停用 | 送出去會是 422。實務上沒有人會翻到 1900 年 |
| A6 | 網址上的月份**不能用就當成沒帶，並用 `replace` 清掉**：格式不對 → 馬上；比這個月後面 → 等後端回了這個月才知道，那時才清 | 上一頁不該回到一個只會再被清掉的網址。格式不對的值不拿去問後端（會 422） |
| A7 | 網址上的月份**剛好等於這個月：不清**，照樣顯示成「這個月」、「下個月」停用 | 「這個月」可能來自離線快取、是舊的（跨月那一刻）：照舊值把網址清掉，會把人從他要看的月份帶走。不清的代價只是同一個月有兩個 query key（都在 `["expenses"]` 底下，一起失效） |
| A8 | 換月份 **push**（一筆歷史紀錄）；翻到這個月時把參數**拿掉**而不是寫 `?month=這個月` | 上一頁回到剛才看的月份。拿掉參數才會跟著後端的「這個月」走 |
| A9 | **還不知道這個月是哪個月**（載入中、失敗）：沒帶月份 → 兩顆都停用、標籤寫「這個月」；帶了合法的月份 → 照樣顯示那個月，「上個月」可按、「下個月」停用 | 不猜。帶了月份時往前翻只是字串減一，不需要知道今天 |
| A10 | query key 不動：`["expenses","list"｜"summary", month]`，`month` 是 `null` 或 `"YYYY-MM"`。**離線持久化不改**——過去月份跟這個月走同一條規則（`["expenses"]` 不在 `NOT_PERSISTED`） | 改刪之後失效 `expensesAll`（前綴）本來就打到每一個月 |
| A11 | `keepPreviousData` 放在 `useExpenses`／`useExpenseSummary` 裡；換月份時卡片內容包一層 `aria-busy`＋`.stale`（`opacity: var(--opacity-stale)`） | 同趨勢頁換期間。`month` 固定的呼叫端（總覽）碰不到這條路；新的月份失敗時沒有資料可留，照舊顯示錯誤 |
| A12 | 標題：這個月維持「這個月花了多少」「這個月」；其他月份「2026年9月花了多少」「2026年9月」。空的與失敗的文字也換：「2026年9月沒有支出」「2026年9月沒有記錄花費」「無法載入2026年9月的報表」 | 「這個月還沒有支出」放在九月底下是錯的。這個月的文字一個字都不動（既有測試、`e2e/desktop-layout.spec.ts` 的 `這個月`） |
| A13 | 切換器的標記：`<div role="group" aria-label="切換月份">`，兩顆 `<button>`（箭頭 `aria-hidden`，名稱就是「上個月」「下個月」），月份是 `<p role="status">`；停用用原生 `disabled`；外觀用 `ui.secondary`（44px） | `role="status"`＝`aria-live="polite"`：換月份時唸出新的月份。不用標題：會跟清單的 `<h2>2026年9月</h2>` 同名 |
| A14 | 切換器最寬 420px，手機與電腦版都是一列 | 電腦版內容區 1100px，兩顆按鈕不該被推到兩端。不寫 media query |

### B. 匯出

| # | 決定 | 理由 |
|---|---|---|
| B1 | 三個端點 `GET /api/export/{meals,expenses,supplements}.csv`，需要登入，各回**呼叫者自己**的全部歷史 | 網址就是檔名的樣子；三種資料的欄位差太多，不合成一個檔 |
| B2 | 回應：`text/csv; charset=utf-8`、**開頭 UTF-8 BOM**、`Content-Disposition: attachment; filename="meals-2026-10-09.csv"`（日期是 `today_in_timezone(user.timezone)`）、`Cache-Control: no-store` | Excel 靠 BOM 認 UTF-8。檔名的日期由後端算（前端不算今天）。個人資料不進中間的快取 |
| B3 | **CSV 的寫法只有一份**（`app/csv_export.py`）：`csv.writer`、CRLF、`encode_header`／`encode_rows`。**儲存格的型別決定怎麼寫**：`str`＝文字（開頭是公式字元加單引號）、`Decimal`＝數字（`format(v, "f")`，不加）、`None`＝空 | 呼叫端不用記「哪幾欄要擋」；數字不可能是公式，加了單引號試算表就不能加總。資料庫的 CHECK 保證金額、份量、劑量 > 0、營養素 ≥ 0——查過，沒有會是負數的數字欄 |
| B4 | 公式字元：`=` `+` `-` `@`、Tab、CR，**外加 LF** | OWASP 的清單加一個同類的（開頭的控制字元被試算表吃掉之後，後面的 `=` 變成開頭） |
| B5 | **分塊的 keyset 查詢**（`(時間, id) > 上一塊最後一列`、`LIMIT`），不是 server-side cursor；一塊 500 列（餐點一塊 200 餐）；`StreamingResponse` 吃 async generator | 記憶體不隨資料量長。不握著一個跨整個下載的 cursor；在測試的 savepoint 夾具裡也照常運作。排序鍵帶 `id`：同一個時刻的列不會被跳過或重複 |
| B6 | 串流用的就是 `Depends(get_db)` 那個 session。**依賴 FastAPI ≥ 0.118**（`yield` 依賴在回應送完之後才收尾）；`pyproject.toml` 的下限跟著改，並有一條測試守著順序 | `tests/conftest.py` 的規矩：所有資料庫存取都經過 `get_db`。實測（0.141.1）：預設範圍是「串流完才收尾」，`scope="function"` 是「第一塊之前就收尾」——後者就是那條測試的突變 |
| B7 | 時間用**帳號時區**（`users.timezone`）的當地時間，`YYYY-MM-DD` 與 `HH:MM` 兩欄 | 跟報表、今日總覽算「哪一天」同一個時區；宵夜落在對的那一天 |
| B8 | 餐點的營養素用 `item_join_query()`＋`scale()`——跟 `GET /api/meals` 同一份 join（項目釘住的那一版）、同一套四捨五入 | 匯出的數字跟 app 裡看到的一樣，而且是同一份實作保證的，不是另外算一次 |
| B9 | 餐點多一欄**「餐點編號」＝`meals.id`**；其他 id 都不匯出 | 一餐多個項目是多列，沒有編號就分不出同一個時刻的兩餐、也沒辦法在試算表裡依餐加總。`meals.id` 本來就在網址上（`/meals/:id/edit`），而且兩次匯出之間不變 |
| B10 | 餐點的「份量」＝`quantity_g`（換算後的量）、「單位」＝那一版的 `base_unit`（`g`／`ml`）；不匯出「幾份」 | `quantity_g` 是記錄當時凍結的；份量（`food_portions`）可以事後改名、改重量、刪掉，不是歷史 |
| B11 | 分類、餐別匯出**中文標籤**；後端自己有一份對照表（`dict[Enum, str]`），測試守「每個成員都有標籤」 | 標題是中文，內容不該是 `transport`。前端也有一份（`api/expenses.ts`、`api/meals.ts`）——兩份，見 §8 |
| B12 | 限速：`KeyedRateLimiter`，**每人每分鐘 6 次、三個端點共用**，鍵是 `str(user.id)`；`hit` 在 handler 裡、碰資料庫之前。超過 → `429 TOO_MANY_EXPORTS`「匯出太頻繁，請稍後再試」＋`Retry-After` | 每次匯出是整段歷史讀一遍、握著一條連線。三顆各按一次是 3 次，手滑再一輪還在額度內。鍵分端點的話額度實際是三倍。沒登入的請求在依賴那一層就 401，不算次數 |
| B13 | 前端：`fetchDownload()`（跟 `apiFetch`、`fetchPhotoBlob` 共用 `fetchWithAuthRetry`）拿成 `Blob`，檔名讀 `Content-Disposition`；`lib/save-file.ts` 的 `saveBlob()` 用暫時的 object URL＋`<a download>` 存檔，40 秒後 `revokeObjectURL` | `<a href>` 帶不了 `Authorization`（同照片）。先拿成 Blob 的好處：下載到一半斷線是「下載失敗」，不是一個被截斷卻看起來正常的檔案 |
| B14 | iOS 主畫面模式（`navigator.standalone === true`）而且 `navigator.canShare({ files })` → 改用 `navigator.share`；使用者關掉分享面板不算錯誤；其他拒絕退回連結 | 那個模式下 `<a download>` 指到 `blob:` 不可靠（§4.3） |
| B15 | 卡片不用 `useMutation`，用 `useState`；下載中**三顆一起停用**，按的那顆寫「下載中…」 | mutation 在離線時會暫停、恢復連線才送——下載不該在人離開之後自己冒出來。一次一個請求，也不會連按把額度用掉 |
| B16 | 卡片放在「好友」之後、管理員的幾張卡片之前 | 「所有帳號」可能很長（dev 一百多個帳號），匯出不該被推到最下面 |
| B17 | OpenAPI 寫明回應是 `text/csv`（`response_class=StreamingResponse`＋`responses=`） | 預設會寫成 `application/json`。`schema.d.ts` 跟著多三條路徑 |

### 與原始決定的差異

1. **後端的月份參數不用加**（A3）。原始指示是「沒有就加」——已經有、有驗證、月界線用既有的 helper。Task 1 只加兩條測試，不動程式。
2. **「沒有下限」實際上是 `1900-01`**（A5）：後端的 `YEAR_MONTH_PATTERN` 不收更早的。翻到底時「上個月」停用。
3. **`?month=` 剛好是這個月時不清網址**（A7）；**從過去翻回這個月時拿掉參數**（A8）。原始指示只講了「無效或未來的退回並清掉」。
4. **分享只在 iOS 主畫面模式用**（B14），不是「有 `canShare` 就用」。桌面的 Chrome／Edge、Android 的 Chrome 也有 `canShare({ files })`，
   而它們的下載是好的——在那裡跳分享面板是退步，e2e 也收不到下載事件。
5. **餐點 CSV 多兩欄：最前面的「餐點編號」、倒數第二的「備註」**（`meals.note`，編輯畫面可以填）。「份量」「單位」的定義見 B10。
6. **補劑 CSV 多「品牌」與四個營養素**（打卡當時的快照）；「劑量/份數」那一欄叫「份數」（`supplement_intakes.dose`）。
7. **公式字元多擋 LF**（B4）。
8. **下載中三顆按鈕一起停用**（B15），不只是按的那一顆。
9. **e2e 會記帳的兩條各自開新帳號**，不用示範帳號：總額與 CSV 的列數才是確定的（別的 worker 同時在示範帳號記帳）。手機尺寸那條只看不改，用示範帳號。
10. **「過去月份跟這個月一樣進離線快取」是同一條規則，不是同樣的保留時間**（§8 第 7 點）：TanStack 預設 5 分鐘沒人看的 query 會被回收，
    下一次寫入就從 localStorage 拿掉。沒有改 `persist.ts`。

### 執行中發現的差異

行為跟這份規格沒有出入；下面是實作時多出來或量到不一樣的（細節在計畫的「執行中發現的差異」）。

1. **§6.2 的匯出卡片多一條測試**：「先成功、再按一次失敗：上一次的『已下載』不會留在錯誤旁邊」。§4.2 寫的是
   「再按一次先清掉上一次的訊息」，原本列的測試只守「成功清掉上一次的錯誤」這一個方向；反方向的突變存活，所以補上。
2. **§7 的數字**：實作完量到的是後端、前端（vitest 印出來的數字）、e2e 各自寫在 `docs/handover.md` §2；前端比這裡寫的
   1631 多 2（就是上面那一條，執行與型別各算一次）。
3. **§8 第 16 點到交接時仍然成立**：iOS 主畫面模式沒有在實機上按過。

---

## 3. API

錯誤一律是既有的信封。

### 3.1 月份參數（既有，不改）

`GET /api/expenses?month=YYYY-MM` 與 `GET /api/expenses/summary?month=YYYY-MM`：

- `month` 省略 → `this_month_in_timezone(user.timezone)`；回應（summary）的 `month` 是正規化過的 `YYYY-MM`。
- 格式 `^(19|20)\d{2}-(0[1-9]|1[0-2])$`，不符 → `422 VALIDATION_ERROR`。
- 月界線：`month_bounds(year, month, user.timezone)`（建立在 `day_bounds` 上，半開區間）。兩個端點共用 `_resolve_month()`。
- **未來的月份是合法的**：`200`、空清單、`total: "0.00"`。前端在知道這個月之前可能先問一次（手打的未來月份）。
- 清單 `limit` 預設 100、最多 500，由新到舊；報表不受 `limit` 影響。

### 3.2 `GET /api/export/meals.csv`、`/expenses.csv`、`/supplements.csv`（需要登入）

| | |
|---|---|
| 成功 | `200`，body 是串流的 CSV |
| `Content-Type` | `text/csv; charset=utf-8` |
| `Content-Disposition` | `attachment; filename="{meals｜expenses｜supplements}-{YYYY-MM-DD}.csv"`，日期＝`today_in_timezone(user.timezone)` |
| `Cache-Control` | `no-store` |
| 沒登入 | `401 NOT_AUTHENTICATED`（不算限速的次數） |
| 超過限速 | `429 TOO_MANY_EXPORTS`「匯出太頻繁，請稍後再試」，`Retry-After`（秒） |

沒有任何資料 → 只有 BOM 與標題列。

### 3.3 CSV 的格式（`app/csv_export.py`）

- UTF-8，檔案開頭一個 BOM（`EF BB BF`）；逗號分隔；每列 CRLF 結尾；含逗號、雙引號、換行的儲存格用雙引號包起來，裡面的雙引號寫兩個（RFC 4180，`csv.writer` 的預設方言）。
- 儲存格的三種型別：

| 型別 | 寫成 | 例 |
|---|---|---|
| `str` | 原樣；**第一個字元**是 `=` `+` `-` `@` Tab CR LF 的，前面加一個 `'` | `=SUM(A1)` → `'=SUM(A1)`；`a=b` 不動；` =1` 不動 |
| `Decimal` | `format(value, "f")`：資料庫存的小數位數，不會是科學記號；**不加 `'`** | `180.50`、`100` |
| `None` | 空的儲存格 | |

- 日期（`2026-10-09`）、時間（`23:30`）、中文標籤、`是`／`否`、餐點編號都是 `str`（它們的開頭不會是公式字元）。

### 3.4 欄位

**餐點**（一個項目一列；同一餐的幾列有同一個餐點編號；**沒有項目的一餐也有一列**，食物到碳水八欄空著）。
順序：`eaten_at`、`meals.id`，同一餐裡照 `meal_items.id`。

| 欄 | 來源 |
|---|---|
| 餐點編號 | `meals.id` |
| 日期、時間 | `meals.eaten_at`，帳號時區 |
| 餐別 | `meal_type` → 早餐／午餐／晚餐／點心 |
| 食物、品牌 | `foods.name`、`foods.brand`（**現在的**名稱；食物名稱不版本化） |
| 份量 | `meal_items.quantity_g` |
| 單位 | 項目釘住的那一版的 `base_unit`：`g` 或 `ml` |
| 熱量(kcal)、蛋白質(g)、脂肪(g)、碳水(g) | `scale(revision, quantity_g)`（釘住的那一版，四捨五入到兩位） |
| 備註 | `meals.note` |
| 只有我看得到 | `is_private` → 是／否 |

**花費**（一筆一列）。順序：`spent_at`、`id`。

| 欄 | 來源 |
|---|---|
| 日期、時間 | `expenses.spent_at`，帳號時區 |
| 分類 | `category` → 飲食／交通／日用／娛樂／醫療／居住／其他 |
| 金額 | `amount` |
| 備註 | `note` |
| 是否餐費 | `meal_id IS NOT NULL` → 是／否。**現在**還掛在一餐上才算：那一餐被刪掉、這筆錢留著的（`ON DELETE SET NULL`），是「否」 |

**補劑**（一次打卡一列）。順序：`taken_at`、`id`。

| 欄 | 來源 |
|---|---|
| 日期、時間 | `supplement_intakes.taken_at`，帳號時區 |
| 補劑、品牌 | `supplements.name`、`brand`（**現在的**；打卡只存 `supplement_id`） |
| 份數 | `dose` |
| 熱量(kcal)、蛋白質(g)、脂肪(g)、碳水(g) | 打卡當時寫死的快照（已經乘過份數） |

**不匯出**：照片路徑、使用者 id、`food_id`／`food_revision_id`／`portion_id`／`plan_id`／`supplement_id`、花費的 `id` 與 `meal_id`、`created_at`、餐費金額（在花費那個檔）。

### 3.5 分塊（`app/export.py`）

三支 async generator `meal_csv`／`expense_csv`／`supplement_csv(db, *, user_id, tz_name)`：先吐標題，然後重複「查一塊 → 寫成位元組 → 吐出去」，
查不到為止。游標是上一塊最後一列的 `(時間, id)`，條件是 row value 比較 `(時間, id) > (:t, :id)`。花費與補劑選**欄位**不選 ORM 物件；餐點先選這一塊的餐
（欄位，**沒有 `photo_path`**），再用 `meal_id IN (…)` 一次拿這些餐的項目。每個查詢都從 `user_id == 呼叫者` 出發。

### 3.6 限速

`app/ratelimit.py`：`export_rate_limiter = KeyedRateLimiter(limit=6, window_seconds=60, code="TOO_MANY_EXPORTS", …)`，
`tests/conftest.py` 的 autouse fixture 每個測試重置。記憶體、單容器（同其他限速器，handover §5.2）。

---

## 4. 前端

### 4.1 報表（`screens/Expenses.tsx`）

順序：h1 → 「營養趨勢」連結 → **月份切換** → 兩欄（摘要｜清單）。

狀態（`raw`＝網址上的 `month`；`current`＝`useExpenseSummary(null).data?.month`，可能還不知道）：

| 網址 | `current` | 看的月份 | 標籤 | 上個月 | 下個月 | 網址 |
|---|---|---|---|---|---|---|
| 沒有 `month` | 知道 | 這個月（query 的 `month` 是 `null`） | `current` 的月份 | 可按 | 停用 | 不動 |
| 沒有 `month` | 不知道 | 這個月 | 「這個月」 | 停用 | 停用 | 不動 |
| 合法、早於 `current` | 知道 | 那個月 | 那個月 | 可按 | 可按 | 不動 |
| 合法、等於 `current` | 知道 | 那個月（顯示成「這個月」） | 那個月 | 可按 | 停用 | 不動 |
| 合法、晚於 `current` | 知道 | 這個月 | `current` | 可按 | 停用 | `replace` 拿掉 `month` |
| 合法 | 不知道 | 那個月 | 那個月 | 可按 | 停用 | 不動（知道之後照上面三列） |
| 格式不對 | — | 這個月 | 同第一、二列 | | | `replace` 拿掉 `month`，**不拿它問後端** |

- 「上個月」＝`shiftMonth(看的月份, -1)`，push。「下個月」＝`shiftMonth(看的月份, +1)`；結果等於 `current` → 拿掉參數，否則設成它。
- 載入中（`isPlaceholderData`）：摘要與清單各自的內容層 `aria-busy="true"`＋`.stale`；月份標籤與兩個標題已經是新的月份。
- 改金額、刪除：行為不變，失效 `queryKeys.expensesAll`。
- 測試定位：摘要卡片 `data-testid="expense-summary"`（既有），內容層 `month-summary`、`month-list`。

### 4.2 「我的」的匯出資料（`components/ExportCard.tsx`）

`Card`（`data-testid="export-card"`）：`h2.sectionTitle`「匯出資料」；說明一行；`role="group"`（`aria-labelledby` 標題）裡三顆
`ui.secondary` 按鈕「餐點」「花費」「補劑」。

- 按下：三顆停用，按的那顆寫「下載中…」→ `downloadExport(kind)`（`GET /api/export/{kind}.csv`）→ `saveBlob(blob, filename, "text/csv")`。
- 檔名用後端給的；沒有 `Content-Disposition` 就退回 `{kind}.csv`（前端不算日期）。
- 存成檔案（`downloaded`）→ `role="status"`「已下載 {檔名}」。交給分享面板、或使用者關掉分享面板 → 不顯示。
- 失敗 → `role="alert"`：429 是「{後端訊息}（{N} 秒後可再試）」（同改密碼）；其他一律「下載失敗，請再試一次」。再按一次先清掉上一次的訊息。

### 4.3 存檔（`lib/save-file.ts`）

`saveBlob(blob, filename, mimeType): Promise<"downloaded" | "shared" | "cancelled">`

1. `navigator.standalone === true`（只有 iOS Safari 有，從主畫面打開才是 true）而且有 `navigator.canShare`：把 blob 包成 `File`，
   `canShare({ files: [file] })` 是 true → `await navigator.share({ files: [file] })` → `shared`。拒絕的原因是 `AbortError`（使用者關掉）→ `cancelled`；
   其他（多半是使用者手勢過期的 `NotAllowedError`——檔案是按了之後才抓的）→ 往下走第 2 步。
2. `URL.createObjectURL(blob)` → 建 `<a href download={filename}>`、掛進 `document.body`、`click()`、拿掉 → `REVOKE_DELAY_MS`（40 秒）後 `revokeObjectURL` → `downloaded`。

**iOS 的限制（寫在檔頭）**：主畫面模式沒有下載管理員，`<a download>`＋`blob:` 在不同版本上可能沒反應、或整個畫面被換成檔案預覽回不來；
所以那個模式優先用分享面板。這兩條路**沒有實機的自動測試**——單元測試守的是「走哪一條路」。

### 4.4 共通

只用 `index.css` 的設計變數與 `ui.module.css` 的 class；按鈕 ≥ 44px；手機與電腦版都能用，不寫 media query。

---

## 5. 安全與隱私

- **只有自己的**：三個端點沒有任何「誰的資料」參數，`user_id` 一律來自 token；每個查詢的第一個條件是 `user_id == 呼叫者`。好友的資料、別人的食物、管理員的清單都不在裡面。
- **照片路徑不匯出**——那一欄根本沒有被 SELECT。內部 id 只有「餐點編號」（B9）。
- **CSV injection**：所有文字儲存格都過 `guard_text`（備註、食物與補劑的名稱與品牌都是使用者打的字）；數字欄的型別是 `Decimal`，不可能帶公式。匯出的檔案可能被轉給別人、用別的試算表打開。
- **限速**在認證之後、資料庫之前；鍵是使用者不是端點（B12）。
- **不進快取**：`Cache-Control: no-store`；service worker 只快取 app shell，不碰 `/api/*`；前端不把 CSV 放進 query 快取或 localStorage——Blob 用完就放掉（40 秒後 revoke）。
- **偷到 access token 的人**可以匯出那個人的全部歷史。這不是新的洞（同一張票本來就能逐日讀出同樣的資料），但變方便了；限速把它壓在每分鐘 6 次，access token 15 分鐘過期。
- **不寫稽核紀錄**：匯出的是自己的資料，跟「管理員替別人產生重設連結」不同類。
- 月份切換沒有新的後端面：`month` 的驗證與擁有權都是既有的。

---

## 6. 測試

### 6.1 後端

- **月份**（補在 `tests/test_expenses_summary.py`）：台北 11/30 23:59:59 與 12/01 00:00:00 兩筆（UTC 都是 11/30）——`?month=2026-11` 與 `2026-12` 的清單與報表各拿到對的那一筆；
  未來的月份是 200 的空結果。**動工前就是綠的**（釘子），突變 `_resolve_month(month, "UTC")` 證明咬得到。
- **`tests/test_csv_export.py`**（純函式）：七種公式開頭各加單引號；`a=b`、` =1`、全形等號不動；逗號／引號／換行（含 CRLF）round-trip 而且真的照 RFC 4180 寫；
  引號裡的公式照樣擋；`Decimal` 不是科學記號、負數不加單引號；`None` 是空的；標題有 BOM、資料列沒有。
- **`tests/test_export.py`**：
  - 三個端點各自的標頭、BOM、檔名（`today_in_timezone` 換成 spy：固定日期、記下收到的時區）、空資料只有標題列；沒登入 401；OpenAPI 是 `text/csv`。
  - 花費：最新的先建（id 與時間反向）→ 由舊到新；逗號、引號、換行、四種公式、CJK＋emoji、沒有備註；`180.5` 匯出成 `180.50`；分類中文；是否餐費。
  - 餐點：兩個項目兩列同一個編號、`g` 與 `ml`、沒有項目的一餐一列空欄、備註與「只有我看得到」；數字跟 `GET /api/meals/{id}` 一樣。
  - 補劑：份數與快照；品牌是公式開頭。
  - **時區**：同一個時刻、台北與紐約兩個帳號、三個端點（紐約的宵夜落在前一天）；台北午夜後 30 分落在新的一天。
  - **只有自己的**：alice 與 bob 各有三種資料，alice 的三個檔都只有自己那一列；照片路徑不在裡面。
  - **分塊**（直接測 generator——`ASGITransport` 把回應收完才交回來，端點層看不到）：塊的大小調成 2，逐塊記「這一塊幾列、到目前為止查了幾次」→ 查一次吐一塊；
    同一個時刻的五列不漏不重複（三支都測）；餐點一塊兩餐、每塊兩次查詢。
  - **session 活到最後一塊**：`get_db` 換成會記「收尾了」的版本、generator 包一層記「吐了一塊」→ 順序是 塊、塊、收尾。
  - **限速**：三個端點輪流共 6 次 → 第 7 次 429（code、`Retry-After`）；別人不受影響。
  - 標籤對照表涵蓋每個 enum 成員。

### 6.2 前端（Vitest）

- `tests/months.test.ts`：`isYearMonth`（後端不收的都不收）、`shiftMonth`（跨年、範圍外是 `null`、格式不對拋）、`formatYearMonth`；原始碼沒有 `Date`。
- `tests/expenses-month.test.tsx`：§4.1 那張表的每一列；上個月→網址、請求、標題、資料；下個月回到沒有參數；上一頁回到上個月（push）；
  載入中 `aria-busy`＋`.stale`、焦點沒跑掉；重新整理停在過去的月份（不問這個月的清單）；格式不對與未來的月份用 replace 清掉（上一頁回到進報表之前那一頁）；
  過去月份的空白與失敗文字；在過去的月份刪一筆 → 重抓那個月。
- `tests/offline.test.tsx`：過去月份的清單與報表進 localStorage，離線、全新的 `QueryClient`、同一個網址 → 資料還在（不改 `persist.ts` 就該是綠的）。
- `tests/save-file.test.ts`：一般瀏覽器走連結（檔名、掛在文件上才點、點完拿掉、40 秒後才 revoke 同一個 URL）；有分享 API 但不是主畫面模式 → 不分享；
  主畫面模式：分享同一份內容的 `File`、`AbortError` → `cancelled` 不下載、`NotAllowedError` → 退回連結、`canShare` false 或不存在 → 連結。
- `tests/export-card.test.tsx`：三顆各打各的端點、帶著票、把位元組（BOM 還在）與後端的檔名交給 `saveBlob`；下載中三顆停用；429 的訊息與秒數、再按一次成功會清掉；
  500／斷線／存檔失敗；沒有檔名的退回值；`shared`／`cancelled` 不說「已下載」。
- `tests/client.test.ts`：`fetchDownload` 的檔名、位元組、401 換票重送、429 的 `retryAfterSeconds`。`tests/me.test.tsx`：卡片在「我的」、畫出來時不打匯出端點。

### 6.3 e2e（`e2e/reports-export.spec.ts`）

1. **月份**（電腦版尺寸、新帳號）：記一筆 123.45 → 報表「總計 123.45」、那一筆在、「下個月」停用 → 上個月：網址 `?month=YYYY-MM`、「總計 0.00」、沒有那一筆 →
   `reload()`：還在那個月 → 下個月：網址沒有 `month`、那一筆在 → 瀏覽器上一頁：回到上個月。
2. **匯出**（電腦版尺寸、新帳號）：記一筆備註 `=e2e-export-…` → 我的 → 按「花費」→ 下載事件：檔名 `expenses-YYYY-MM-DD.csv`、開頭三個位元組是 BOM、
   剛好標題＋一列、那一列是 `日期,時間,交通,123.45,'=e2e-export-…,否`、畫面上「已下載 …」。
3. **手機尺寸**（示範帳號，只看不改）：切換器的按鈕 ≥ 44px、三個元素排成一列、沒有橫向捲軸；翻到上個月之後也是；匯出的三顆 ≥ 44px。

---

## 7. 交付

1. 後端：月份參數的查證與兩條釘子（只加測試）
2. 前端：`lib/months.ts`
3. 前端：報表的月份切換
4. 後端：CSV 的寫法（`app/csv_export.py`）
5. 後端：三支匯出端點、分塊、限速（重新產生 `schema.d.ts`）
6. 前端：`fetchDownload` 與 `saveBlob`
7. 前端：「我的」的匯出資料卡片
8. e2e
9. 交接文件

**計畫裡的程式碼已經跑過一次。** 寫計畫時在一個用完就刪的 git worktree 把每一段照抄進去：後端 980 條、前端（vitest 印出來的數字）1631 條、e2e 44 條全綠，突變的結果列在計畫的每個 task 裡。repo 裡沒有留下任何實作——只有這份規格與計畫。

**部署：沒有 migration、沒有新的環境變數，可以直接退版。** `pyproject.toml` 的 `fastapi` 下限改成 `>=0.118`（lock 檔已經是 0.141.1，映像不變）。

---

## 8. 已知限制

1. **清單最多 100 筆**（既有落差，`list_expenses` 的 docstring）：報表的總額算整個月，清單被 `limit` 截斷時兩者對不起來，而且沒有訊號。看過去的月份一樣。
2. 一次只能翻一個月；沒有月份選擇器。翻到這個月為止。
3. 記帳永遠記在「現在」：過去的月份不能補記、不能改一筆的日期。
4. **還不知道這個月是哪個月時**（離線而且沒有快取、或那個請求失敗）：沒帶月份的報表不能翻。
5. **跨月的那一刻**：快取裡的「這個月」還是上個月時（`staleTime` 60 秒內、或剛從離線快取還原），標籤與「下個月」的界線是舊的，重抓回來才更正；
   那段時間從更早的月份按「下個月」翻到「快取以為的這個月」，會落在真的這個月上（多按一次「上個月」）。
6. 手打未來的月份：前端在知道這個月之前會先照它問一次後端（空的結果），然後退回這個月。
7. **離線時看得到的過去月份只有最近看過的**：5 分鐘沒有畫面在用的 query 會被 TanStack 回收（預設 `gcTime`），下一次寫入就從 localStorage 拿掉。
   這是照預設值推論的，沒有另外量；這個月的清單也是同一條規則。
8. 匯出是「全部歷史、一種一個檔」：沒有日期範圍；餐點的檔沒有餐費，花費的檔沒有餐點編號，兩個檔之間沒有可以對起來的鍵。
9. **後端的記憶體是平的，瀏覽器的不是**：整份 CSV 先變成一個 Blob 才存檔（幾 MB 的量級）。
10. **匯出期間握著一條資料庫連線**（連線池 5＋10）；下載很慢的用戶端會一直佔著。限速每人每分鐘 6 次。
11. **不是同一個時間點的快照**：每一塊是分開的查詢。匯出途中新增或刪除的列可能有、可能沒有；被改了時間的那一列可能出現兩次或不出現。
12. 串流開始之後才出錯（例如資料庫斷線）：狀態碼已經是 200，只能中斷連線。前端的 `response.blob()` 會失敗、顯示「下載失敗」；用 curl 的人會拿到被截斷的檔案。沒有測試。
13. 食物、補劑的名稱與品牌是**現在的**（名稱不版本化）；營養素與份量是當時的。
14. 分類與餐別的中文標籤前後端各一份；加分類時兩邊都要改（後端有測試會紅，前端是編譯錯誤）。
15. 開頭是公式字元的文字，匯出之後前面多一個看得到的 `'`。全形的 `＝＋－＠` 不擋（沒有驗證過試算表會不會把它們當公式）。
16. **iOS 主畫面模式沒有實機驗證**。分享面板要使用者手勢還有效，資料很多、抓太久時會退回 `<a download>`——在那個模式下不保證有用。
17. 匯出的限速在記憶體裡，重啟歸零（同其他限速器）。
