# 營養標示先用手機辨識（OCR）、再決定要不要用 AI

**狀態：** 已實作（2026-11-04，`feat/label-ocr`；審查後的規則以本文 §4 為準，跟這份規格不一樣的地方記在計畫的「執行中發現的差異」，摘要在「與規格的差異」）
**日期：** 2026-10-23
**分支：** `feat/label-ocr`
**前置：** 掃條碼／營養標示（`POST /api/ai/read-label`、`app/ai/label.py`、`app/nutrition_units.py`、條碼 → 新增食物的交接）、
照片＋補充說明（`PhotoHintStep`、`ElapsedSeconds`、`hint`）、掃條碼的 ponyfill（zxing 的 wasm 自己服務、不進預先快取）
**計畫：** `docs/superpowers/plans/2026-10-23-label-ocr.md`
**來源：** 使用者核准的設計（目的：**省 AI 額度與費用**），細節交給執行者；這份規格記下決定、理由與實驗量到的數字。

---

## 1. 範圍

### 1.1 做的事

- 新增食物的「拍營養標示」：選了照片**先在手機上辨識文字**（Tesseract.js，不用額度、照片不離開裝置），文字送到新的
  `POST /api/foods/parse-label-text` 用**確定性的規則**讀出數字（不呼叫 AI、不算額度、不寫 `ai_analyses`）。
  - 四個數字都讀到、而且合理 → 直接填進表單（同 AI 讀標示：每 100、單位、一份「份」），註明「手機辨識的數字，請對照包裝確認」。
  - 讀不完整、讀不出來、手機不能辨識 → 卡片說讀到什麼、缺什麼，主要按鈕「改用 AI 讀（用 1 次額度）」（用**同一張照片**與選填的補充說明打既有的
    `read-label`），次要按鈕「填入讀到的」（有讀到才有：其餘自己填，也不用額度）。
  - 讀完整了但使用者覺得不對：結果那一段有「數字不對？改用 AI 讀（用 1 次額度）」。
- 「貼上營養標示文字」：一個 textarea，貼 iPhone 原況文字（Live Text）或 Google Lens 複製的字，送同一個端點、同樣的結果處理（沒有照片，所以沒有 AI 按鈕）。
- 解析器 `app/label_text.py`：台灣營養標示的格式（每一份量、本包裝含 N 份、每份／每 100 公克（毫升）／每日參考值百分比三種欄）、英文標示、OCR 常見的雜訊。
  換算與合理性檢查跟 AI 讀標示**同一份**（`app/nutrition_units.py`）。
- 條碼找不到帶來的提示改成不提 AI：「找不到這個條碼的資料。拍營養標示讀數字，或自己填。」

### 1.2 明確不做

- 記一餐、編輯這一餐的照片估算不變（那是估算，不是照抄數字，OCR 幫不上）。
- 不在後端跑 OCR（照片不上傳是這個功能的隱私賣點；伺服器是 NAS，CPU 也不值得花在這裡）。
- 不在前端解析（規則只有一份、在 Python、有測試；前端只送文字）。
- 不讀名稱（OCR 的名稱太不可靠；AI 那一條照舊會讀）、不讀鈉與糖（同 AI 讀標示）。
- 不做離線辨識：文字要送到後端解析，沒有網路本來就讀不了，引擎的快取是為了**第二次不用再下載**，不是為了離線。
- 沒有 migration、沒有新的環境變數。端點 108 → **109**。

---

## 2. 決定

| # | 決定 | 理由 |
|---|---|---|
| D1 | **選了照片就自動在手機上辨識**，不先問。卡片一出來就是「手機辨識中…」＋秒數＋「取消」；讀完整 → 卡片收起、表單填好；不完整 → 卡片換成結果＋「改用 AI 讀（用 1 次額度）」 | 省額度最多（每一張都先試免費的那條）、摩擦最少（成功的那條路比今天還少按一次「開始讀取」）。「兩顆按鈕讓人選」會讓習慣按 AI 的人一直按 AI，而且每次都要多想一下。第一次要下載約 3 MB，狀態那一行說明（D13） |
| D2 | 補充說明欄**只在要用 AI 的時候出現**（不完整的結果、或「數字不對？」重新打開卡片） | 說明只影響 AI；辨識中顯示它會讓人以為打了會讓手機讀得比較好 |
| D3 | 「填入讀到的」：讀到的欄位填進去（每 100），**沒讀到的欄位清空**（原本打了數字的也清掉）；單位、「營養標示是」切回每 100、一份照填。結果那一段說「填入了讀到的數字，其餘請自己填」 | 缺一兩項時，自己補一個數字比花一次額度快，也不用等 20 秒。清空而不是留著：填進去的是每 100、單位也可能換了，原本那一格可能是每份或另一個單位的數字，留著會變成一筆數字混在一起、看起來填好了的食物；空著的欄位送出前一定會被擋下來要人補 |
| D4 | 讀完整之後保留那張照片，結果那一段有「數字不對？改用 AI 讀（用 1 次額度）」：按了重新打開卡片（照片＋說明＋AI 按鈕） | 註明「請對照包裝確認」之後，下一步要一按就到；不用重拍 |
| D5 | 端點 `POST /api/foods/parse-label-text`，body `{text}`（1–4000 字），**不完整也是 200**：`complete`、`nutrition`（只有完整時）、`found`（讀到的每 100，讀不到是 null）、`missing`、`reason`、`serving`、`servings_per_package`、`basis`、`base_unit`、`consistency` | 「讀不完整」是這個端點的正常結果，不是錯誤；同掃條碼的「找不到不是 404」。形狀跟 `read-label` 的回應對齊（`nutrition` 是 `NutritionResponse`、`serving` 是 `ServingSize`），前端填表單的程式碼共用 |
| D6 | 每人每分鐘 **30 次**（`KeyedRateLimiter`，鍵是使用者 id，**每一次都算**、在解析之前），429 `TOO_MANY_LABEL_PARSES` | 正常使用一張照片一次；擋的是寫壞的迴圈。同條碼查詢的數字 |
| D7 | **文字不存、不寫 log**；路由沒有任何 log 行；422 的回應本來就不帶 `input`（`_sanitize_validation_errors`） | 標示的文字不敏感，但使用者貼上的可能多貼了別的東西；沒有需要就不留 |
| D8 | 解析器的換算與合理性檢查跟 AI 讀標示同一份：`kj_to_kcal`、`per_100_from_serving`、新的 `plausible_per_100()`（`NutritionInput` 的範圍＋`is_physically_plausible`），`app/ai/label.py` 改用它（行為不變） | 使用者核准的「同一個事實來源」；兩條路對同一張標示不該算出不同的數字 |
| D9 | 每 100 那一欄完整而且合理就用它；否則每份那一欄完整、有每一份量、換算後合理就用它；都不行就是不完整（`reason` 說為什麼）。**每 100 不合理時會退到每份**（AI 那一條不退，見 §4.4） | OCR 少一個小數點常常只壞一欄（實驗：每 100 的「28.0」讀成「2809」） |
| D10 | OCR 引擎 **Tesseract.js 7.0.0**（Apache-2.0）＋`tesseract.js-core` 7.0.0（Apache-2.0）＋**只有 `chi_tra`**（`@tesseract.js-data/chi_tra` 1.0.0 的 `4.0.0_best_int`，1.66 MB）＋`wasm-feature-detect` 1.9.0（Apache-2.0），全部釘版本 | 量過（§6.3）：加 `eng` 多 2.95 MB，台灣的標示沒有變好，英文標示反而把小數點讀掉；在台灣賣的包裝都要有中文標示 |
| D11 | 辨識參數：`PSM 6`（單一區塊）＋`rotateAuto: true`（自動轉正）＋`preserve_interword_spaces`；照片長邊縮到 **2000**（小的不放大）、**不做**灰階與對比 | 量過：PSM 3／4 會把整欄數字丟掉；沒轉正時 1.6° 的歪斜就讓三欄的表整張讀壞；4000 px 原圖慢一倍還會讀錯字；灰階＋對比反而多錯 |
| D12 | worker 與 core 用 Vite 的 `?url`（雜湊檔名，同 zxing）；語言資料用 `vite.config.ts` 裡的小 plugin 放在固定路徑 `/ocr/tessdata-4.0.0_best_int/chi_tra.traineddata.gz`（dev 由 middleware 給、build 時 `emitFile`）。**執行期不打任何第三方** | Tesseract.js 用 `${langPath}/${lang}.traineddata.gz` 組網址，檔名不能有雜湊；另一個寫法 `{code, data}` 在 7.0.0 是壞的（`worker-script/index.js:238` 接的是 `l.data`，實驗看到語言名稱變成亂碼）。路徑帶資料的版本，換版本就是新網址 |
| D13 | 快取：worker（111 KB）**進預先快取**（既有的 `**/*.js` 本來就會抓到）；core（3.9 MB）**不進預先快取**（`globIgnores`；超過 2 MiB 時 vite-plugin-pwa 會讓 build 失敗），用 workbox `runtimeCaching` 的 `CacheFirst`（`ocr-engine`，最多 2 筆）；語言資料用 Tesseract.js **自己的 IndexedDB 快取**（`cacheMethod` 預設的 `write`、`cachePath` 帶版本） | 第二次用不再下載。語言資料走 IndexedDB 不依賴 service worker 有沒有接管 dedicated worker 的請求（iOS 沒驗證過）；core 的雜湊檔名換版本自己失效 |
| D14 | 每次辨識完就 `terminate()` worker，不留著 | 一次新增食物通常只讀一張；留著佔手機上百 MB 記憶體。再建一次（快取裡）在桌機 0.12–0.28 秒 |
| D15 | 取消：`AbortSignal`。按「取消」、換一張照片、離開畫面（卸載）都會中止並 `terminate()`；worker 還沒建好時，等它建好再收掉 | Tesseract.js 的 `recognize` 本身不能取消，只能收掉 worker |
| D16 | `createWorker` 一定要給 `errorHandler`、自己跟它賽跑，外加 **90 秒**上限 | 實驗：語言資料抓不到時 `createWorker` 的 promise **永遠不 resolve 也不 reject**，只有 `errorHandler` 會被叫（172 ms）；沒有 `errorHandler` 它在 `onmessage` 裡丟例外 |
| D17 | 「貼上營養標示文字」：「拍營養標示」旁邊一顆按鈕展開；textarea 16px、6 行、`maxLength` 4000；「讀取文字」「取消」 | 有原況文字的手機，選取表格、拷貝、貼上比拍照快，而且不用下載引擎 |
| D18 | 前端的 OCR 程式碼分兩層：`lib/label-ocr.ts`（在主程式裡，縮圖＋`import()`）與 `lib/label-ocr-engine.ts`（延遲載入，碰 Tesseract.js）。單元測試在 `src/test/setup.ts` mock 掉後者（同 ponyfill），要讀到字的測試 mock 前者 | 主程式不長大；jsdom 不碰 worker 與 wasm |
| D19 | 拍營養標示的流程從 `NewFood` 搬到新的 `components/LabelReader.tsx`，用 `onFill` 把數字交回表單 | NewFood 已經 683 行；OCR、AI、貼上三種來源、三種結果狀態放進去會超過 1000 行 |
| D20 | e2e 跑**真的** Tesseract（Chromium、dev 伺服器）：固定的合成標示照片（62 KB，`e2e/fixtures/nutrition-label.jpg`）。只假造 `/api/ai/read-label` | 實驗：從 dev 伺服器第一次下載＋辨識一張在 2 秒內；證明整條管線（資源路徑、worker、core、語言資料、後端解析） |

---

## 3. 流程與畫面

### 3.1 拍營養標示

```
選照片 ─ 太大（> 10 MB）→ 「照片超過 10MB…」（同今天，不出卡片）
   │
   ▼
卡片「確認照片」：縮圖、「取消」          結果那一段（role="status"）：「手機辨識中…」 N 秒
   │                                     「第一次使用要下載辨識資料（約 3 MB）」
   ├─ 取消 → 中止、卡片收起、焦點回照片按鈕
   ▼
OCR 完 → 沒有字 ─────────────────┐
   │                              │
   ▼                              ▼
POST parse-label-text ─ 失敗（網路、429）→ 卡片：錯誤＋「改用 AI 讀」
   │
   ├─ complete → 填表單、卡片收起、焦點到結果那一段：
   │             「手機辨識的數字，請對照包裝確認」（＋算不太上的警告、本包裝含 N 份）
   │             ＋「數字不對？改用 AI 讀（用 1 次額度）」→ 重新打開卡片（同一張照片）
   │
   └─ 不完整 → 卡片：讀到什麼／缺什麼、「補充說明（選填）」、
                「改用 AI 讀（用 1 次額度）」（主要）、「填入讀到的」（有讀到才有）、「取消」
                   └─ AI：既有的 read-label 流程（「AI 讀取中…」、成功填表單、失敗卡片留著）
```

- 讀的時候（OCR 或 AI）照片按鈕停用（同今天的 AI）。換照片要先取消。
- 「焦點到結果那一段」只在焦點本來在收起來的那一塊裡（卡片、貼上那一塊）、跟著掉到 body 時才移；辨識中使用者去別的欄位
  （例如名稱）打字的話，讀完不搶焦點（不打斷輸入、手機不收鍵盤）。
- 卡片的可及名稱照舊「確認照片」，圖片的替代文字改成「營養標示的照片」（不一定會送給 AI 了）。
- 不完整的說法（`lib/label-text.ts` 的 `describeLabelParse`）：
  - `missing_fields`：「讀到：熱量 514 kcal、蛋白質 6 g（每 100 g）；讀不到：脂肪、碳水化合物」
  - `needs_serving_size`：「只有每份的數字，但讀不到每一份量」
  - `columns_unknown`：「看不出是每份還是每 100 的數字」
  - `implausible`：「讀到的數字不太合理（可能少了小數點）」
  - `no_values`、OCR 沒有字：「手機讀不出這張營養標示」
  - 手機不能辨識（引擎載不起來、逾時）：「這台裝置現在不能用手機辨識」
- 填表單（`onFill`）跟今天的 `applyLabel` 一樣：名稱是空的才填（OCR 沒有名稱，所以只有 AI 會填）、條碼與品牌不動、單位、四個數字、「營養標示是」切回每 100、
  有一份就「份」＋那個量（`filledServing` 的「已帶入包裝上的一份」提示照舊）。

### 3.2 貼上營養標示文字

「拍營養標示」旁邊多一顆「貼上營養標示文字」（`aria-expanded`）。展開：`<label>`「營養標示文字」＋textarea＋「讀取文字」（送出中 `aria-disabled`）＋「取消」。
完整 → 填表單、收起、焦點到結果那一段（「從貼上的文字讀的數字，請對照包裝確認」）；不完整 → 在這一塊說讀到什麼、「填入讀到的」；沒有 AI 按鈕。
讀照片的時候（手機辨識或 AI）可以展開、可以貼，但「讀取文字」與這一塊的「填入讀到的」`aria-disabled`，這一塊的狀態說
「手機辨識或 AI 讀取中，完成或取消後再貼上」（也是「讀取文字」的 `aria-describedby`）：照片的結果晚回來會把貼上的蓋掉，
而且讀的時候結果那一段是收起來的，貼上讀到什麼會看不到。

### 3.3 為什麼不是「兩顆按鈕讓使用者選」

選項會讓每一次都多一個決定，而習慣之後多數人會一直按同一顆——如果那顆是 AI，額度照樣用；如果是手機，失敗了還要再按一次 AI。自動先試手機：成功的那條路少按一次，
失敗的那條路跟今天一樣按一次（「改用 AI 讀」取代「開始讀取」）。代價是第一次會自動下載約 3 MB（狀態那一行說了）。

---

## 4. 解析規則（`app/label_text.py`）

### 4.1 正規化

1. **NFKC**：全形數字與標點（`３５．０`、`％`、`：`、`（）`）、`㎉`→`kcal`、`㎎`→`mg`、`㎖`→`mL`。
2. 表格線變成的 `|`、`｜`、`[`、`]` 換成空白。
3. 小數點兩邊的空白拿掉（`21 .3`、`21. 3` → `21.3`）。**數字中間的空白不合併**：`180 514` 是兩欄，不是 180514。
4. 逗號：後面剛好三位數是千分位（`2,151` → `2151`）；一或兩位是小數點（`21,3` → `21.3`）。
5. 有數字的「數字樣」片段（`0-9`、`O`、`o`、`I`、`l`、`.` 連在一起、至少一個真的數字）裡 `O`／`o` → `0`、`I`／`l` → `1`（`1O.5` → `10.5`、`l2.3` → `12.3`）。
   沒有數字的片段不動（`Oil`、`Information`）。
6. **少了小數點不猜**：`2809` 就是 2809，交給合理性檢查擋。

### 4.2 欄

（Task 1 審查後改過：欄的順序看**表頭那一行**、兩欄**交叉檢查**、`%` 的截斷收緊、很長的數字不算數。原本的「整段文字裡第一次出現的位置」與
「只讀到一種表頭就照衛福部的順序」都會把每份的數字當成每 100、而且是完整、看起來合理的一組。第二輪審查再改：兩個表頭都讀到就不換欄、
至少兩項對得起來才算、容許差收緊、名稱不借每一份量／份數／表頭的數字、單位先看表頭那一行。）

- 表頭的關鍵字：每份＝`每份`、`每一份`（後面都不是「量」）、`per serving／bar／portion`、`per N g／ml`（N ≠ 100，例如 `Per 45g bar`）；
  每 100＝`每 100 公克／克／毫升／g／ml`、`per 100 g／ml`；每日參考值＝`每日參考值`、`參考值百分比`、`%DV`。後面直接是**量（數字＋單位）**的
  （`每份 35 公克`）是每一份量，不是表頭；沒有單位的數字是雜訊（`每份0 每日參考值百分比` 還是表頭）。
- **表頭行**：有上面任一種表頭、而且沒提任何營養素的行（底下的「每日參考值：熱量2000大卡…」不是）。只看**第一列之前**的表頭行（沒有就看全文的第一個）：
  欄的順序看其中**最後一個**有每份／每 100 的那一行（上面的 `每份 35 公克`、說明文字裡的 `per serving and per 100 g` 都不算）；有沒有每日參考值那一欄也只看它們
  （表格底下的 `＊參考值未訂定` 不算）。
- 一列裡的數值：`數字＋單位（可以沒有）`；**帶 `%` 的丟掉**（每日參考值那一欄）。剩下的個數等於欄數 → 照欄的順序分給各欄；**剛好多一個**、表頭有每日參考值、
  而且這一列**自己沒有帶 `%` 的數字** → 去掉最後一個（OCR 把 `%` 讀丟了）；其他情況這一列算讀不到（帶著 `%` 還多出來的是拆開的數字：`1 9.0 公克 6%`）。
  前面是單獨一個小數點的不是數字（`.5`）；點線可以（`熱量......514大卡`）。超過 1e6（`MAX_EXTERNAL_NUMBER`）的數字不算數（30 位數以前讓端點 500）。
- 兩種表頭都在表頭那一行 → 照位置排（**讀到的順序**，交叉檢查不換）。只認得一種（OCR 常把「每份」讀成「每仿」）或都沒有：**沒有**每日參考值那一欄、
  而且**至少兩列**（熱量以外）剛好兩個數字才是兩欄：
  - 只認得一種、同一行**只有一邊**還有像表頭的字（含 `每` 或 `per`）→ 另一欄在那一邊（**推的順序**）：`每仿 每100公克` 每份在前、`每100公克 每仿` 每 100 在前。
  - 其他（沒有表頭、單獨一個表頭、旁邊的字不像表頭，例如 `營養標示 每100公克`）→ **順序讀不到**，交給交叉檢查（§4.4）；沒有每一份量 → `columns_unknown`（不猜）。
  - 有每日參考值時不推：第二個數字可能是讀丟了 `%` 的百分比（「熱量 135 大卡 7」當成每 100 的 7 kcal 是合理的數字，擋不住）。只有一列的時候也不推
    （實驗裡亂碼那張只剩一列「脂肪75公克 3」）。不是兩欄 → 只讀到哪一種就是哪一欄；都沒有 → `columns_unknown`。

### 4.3 列

| 營養素 | 關鍵字（小寫比對） | 排除 | 單位 |
|---|---|---|---|
| 熱量 | `熱量`、`能量`、`熱`、`energy`、`calories` | — | `大卡`／`千卡`／`kcal` 是 kcal；`kj`／`千焦` 換算（`kj_to_kcal`）；數字沒單位時看這一列的名稱（`熱量(大卡)`）；都沒有 → 讀不到 |
| 蛋白質 | `蛋白質`、`蛋白`、`白質`、`protein` | — | 克、`g`、沒單位、讀錯的單位都收；`毫克`／`mg` 不收 |
| 脂肪 | `脂肪`、`脂`、`fat` | `飽和`、`反式`、`不飽和`、`saturated`、`trans`、`mono`、`poly` | 同上 |
| 碳水化合物 | `碳水化合物`、`碳水`、`水化合物`、`化合物`、`carbohydrate`、`carbs` | — | 同上 |

- 一行裡出現兩種營養素的關鍵字（OCR 把兩列併成一行）→ 這一行不用。
- **名稱與數字在相鄰兩行**：名稱那一行沒有數字時，看下一行。下一行不能有任何營養素的關鍵字，也不能是每一份量、份數或表頭行
  （第二輪審查：產品名「高蛋白燕麥」底下的「每一份量 35 公克」不是蛋白質 35；「低脂奶酥」底下的「本包裝含 4 份」不是脂肪 4）。
- 糖、鈉、膳食纖維、飽和脂肪、反式脂肪：沒有自己的規則，碰到也不會被當成上面四種。帶著 `鈉`、`糖`、`纖維`、`參考值`、`sodium`、`salt`、`sugar`、`fibre`、
  `daily value` 的行**不當成**營養素那一列（台灣標示底下的「每日參考值：熱量2000大卡、蛋白質60公克…」），也不讓「相鄰兩行」借走它們的數字。
- 同一種營養素有好幾行：用第一行分得出欄的。
- 熱量那一列同時有 kcal 與 kJ（歐洲的「2151 kJ / 514 kcal」）：kcal 的個數等於欄數就用 kcal，否則 kJ 的個數等於欄數就換算，否則讀不到。

### 4.4 每一份量、份數、單位、選欄

- 每一份量：`每一份量 35 公克`、`每份 35 公克`、`serving size 30 g`（`公克／克／g／毫升／ml`），沒有就用表頭裡的量（`Per 45g bar` → 45 g）；0 < 量 ≤ 10000。
- 份數：`本包裝含 4 份`（`本包` 與數字之間容許 0–3 個字，OCR 常把「裝含」讀錯）、`servings per package/container 10`；0 < 份數 ≤ 1000。
- 單位：**表頭那一行**的每 100 的單位；表頭那一行沒有每 100 才看全文的第一個（上面一句「本產品每100毫升含膳食纖維5公克」不決定單位），
  都沒有就看每一份量的單位，再沒有是 g。`serving` 只在它的單位跟食物一樣時才回（同 OFF 的預填）。
- 數字一律先 `round_cents`（half-up 兩位）。
- **交叉檢查**（審查後加的，第二、三輪改過）：兩欄都有數字、又有每一份量 → 每一項檢查 每 100 ≈ 每份 × 100 ÷ 一份。容許差＝兩邊各自的寬容 ＋ 3%：
  - 每一邊的寬容是那個數字**印出來的半格**，照它自己的位數（第三輪）：整數 0.5、一位小數 0.05、兩位 0.005；熱量也一樣，不再特別處理。
    `round_cents` 之後「6」與「6.0」分不出來，所以位數在讀數字時就記下來。kJ 換成 kcal 時半格一起除以 4.184（整數的 kJ ≈ 0.12 大卡）。
    每份那一邊的半格乘上 100 ÷ 一份。台灣可以印整數或一位小數：只當一位小數看，對的整數標示會被當成讀錯（每份 5 公克對每 100 的 26.8，一份 20 公克）。
  - 印成 0 的那一邊，寬容是半格與「可以標 0」兩者**較大的**（不相加：整數的「0」與「可以標 0」說的是同一件事）：衛福部「包裝食品營養標示應遵行事項」附表二，
    每 100 公克／毫升熱量 ≤ 4 大卡、蛋白質／脂肪／碳水化合物 ≤ 0.5 公克得以「0」標示。門檻是每 100 的量，**不乘** 100 ÷ 一份（之後的修正版沒有逐條核對）。
  - ＋ 兩者較大的 **3%**：每一份量本身也是進位過的（35.4 公克印成 35，每份照 35.4 算）、兩欄各自從沒進位的數字算。一份 35 公克時，每份 2.1 對每 100 的 6.8
    容許差是 0.40，所以 6.0 讀成 6.8 擋得住；每份印到一位小數的 5.0 對 26.8（一份 20 公克）也擋得住，印成整數的 5 才對得起來。
  排反的兩欄差 (100 ÷ 一份)² 倍（35 公克是 8 倍、90 公克也還有 23%），遠在範圍外。
  - **至少兩項**對得起來，那一種排法才算數；一項可能是碰巧（每一份量讀錯時排反的蛋白質；0 對 0 跟任何一份都對得起來）。
  - **讀到的順序**（兩個表頭都讀到）照表頭、不換：一份讀成約 10000 ÷ 真的一份（35 → 286）時，排反的兩欄四項全都「對得起來」。
    **推的**或**讀不到的**順序：對得起來的項目比較多的那一種排法就是順序（排反就換過來）。
  - **對得起來的不到兩項**（每一份量讀錯、或欄根本不是每份／每 100）→ 不完整、`found` 全空：讀到或推的順序 `implausible`，讀不到的 `columns_unknown`。
    每一份量讀錯時每 100 那一欄其實可能是對的——寧可不完整（使用者改用 AI 或自己填），不給一組可能是每份的數字。
  - 已知的洞：順序是推的或讀不到、每一份量又剛好讀成約 10000 ÷ 真的一份 → 會換成錯的一欄，而且是完整的。要兩件事同時讀錯（表頭與一份的量），
    單字元的擾動測試（`ocr-rev1b-fuzz.py`）沒有碰到。
  - 有幾項對不起來：那一項只有一邊在物理上限內（熱量 ≤ 945、營養素 ≤ 100）→ 那一邊對（`2809` 對 `9.8`）；兩邊都在 → 分不出來。
- 選欄（D9）：每 100 完整且 `plausible_per_100` 過、而且對不起來的每一項都是它對 → `per_100`；否則每份（完整、有每一份量、換算後過、對不起來的都是它對）→ `per_serving`；
  否則不完整。不完整時的 `found`：讀到最多項的那一欄（同數時每 100 優先），每份的要有每一份量才換算得出來；單一數字超過物理上限（熱量 > 945、任一營養素 > 100）的、
  對不起來又分不出哪一邊對的，也當成讀不到。
- `reason`：`no_values`（四種都沒讀到）、`columns_unknown`、`needs_serving_size`（只有每份、沒有每一份量）、`implausible`（有完整的欄但都過不了合理性，
  而且不是被對不起來的項目擋下；或兩欄一項都對不起來）、`missing_fields`（其他）。
- `consistency`：完整時用 AI 那一條同一個 `check_consistency`（只標記，不擋）。

### 4.5 三個算例

**每 100 有印**（實驗的 OCR 輸出，`both-photo.jpg`，PSM 6）：

```
營養標示
每一份量 35 公克
本包裝含4份
每份             每100公克
熱量                                    180 大卡               514 大卡
蛋白質           2.1 公克     6.0 公克
脂肪            9.8 公克     28.0 公克
飽和脂肪         3.2 公克     9.1 公克
反式脂肪                             0公克                  0公克
碳水化合物         21.3 公克     60.9 公克
糖                                  1.2 公克               3.4 公克
鈉                                     120 毫克               343 毫克
```

欄：每份、每 100。→ `complete`、`basis: per_100`、`g`、**514.00／6.00／28.00／60.90**、`serving: 35 g`、`servings_per_package: 4`。
（飽和脂肪、反式脂肪被排除；糖、鈉沒有規則；合理性：6 + 28 + 60.9 = 94.9 ≤ 105、514 ≤ 945。）

**只有每份**（每日參考值那一欄的 `%` 丟掉）：

```
每一份量 250 毫升
本包裝含1份
每份     每日參考值百分比
熱量         135 大卡           7%
蛋白質        8.0 公克           13%
脂肪                      7.5 公克                         13%
碳水化合物      9.0 公克           3%
```

欄：每份。→ `per_serving`、`ml`、每 100 ml＝135 × 100 ÷ 250＝**54.00**、8.0 → **3.20**、7.5 → **3.00**、9.0 → **3.60**（`per_100_from_serving`）、`serving: 250 ml`、份數 1。

**只有 kJ**（貼上的英文標示）：

```
Serving size 30 g
per serving   per 100 g
Energy 645 kJ 2151 kJ
Protein 1.8 g 6.0 g
Fat 8.4 g 28.0 g
Carbohydrate 18.3 g 60.9 g
```

→ `per_100`、2151 kJ → **514.10 kcal**（`kj_to_kcal`：2151 ÷ 4.184）、6.00／28.00／60.90、`serving: 30 g`。

---

## 5. 端點

`POST /api/foods/parse-label-text`（要登入）

```jsonc
// request
{ "text": "營養標示\n每一份量 35 公克\n…" }   // 1–4000 字（Python 的 len）；超過 422
// response 200（完整）
{
  "complete": true,
  "base_unit": "g",
  "nutrition": { "base_unit": "g", "kcal": "514.00", "protein_g": "6.00", "fat_g": "28.00", "carb_g": "60.90" },
  "found": { "kcal": "514.00", "protein_g": "6.00", "fat_g": "28.00", "carb_g": "60.90" },
  "missing": [],
  "reason": null,
  "serving": { "amount": "35.00", "unit": "g" },
  "servings_per_package": "4.00",
  "basis": "per_100",
  "consistency": { "atwater_kcal": "519.60", "deviation": "5.60", "flagged": false }
}
// response 200（不完整）：complete false、nutrition null、basis null、consistency null、found 有讀到的、missing 列出缺的、reason
```

- 順序：登入（401）→ 驗證 body（422）→ **限速**（429 `TOO_MANY_LABEL_PARSES`，帶 `Retry-After`）→ 解析。純函式、不碰資料庫、不寫任何列、不呼叫 AI。
- schema 放在新檔 `app/schemas/label_text.py`（要同時用 `app/schemas/food.py` 的 `NutritionResponse`／`ServingSize` 與 `app/schemas/ai.py` 的 `ConsistencyResult`，放進任一邊會循環 import）。
- 改了路由與 schema → 重新產生 `frontend/src/api/schema.d.ts`。

---

## 6. OCR 引擎

### 6.1 版本與授權

| 套件 | 版本 | 授權 | 用途 |
|---|---|---|---|
| `tesseract.js` | 7.0.0（2025-12-15） | Apache-2.0 | 主執行緒 API、`dist/worker.min.js` |
| `tesseract.js-core` | 7.0.0 | Apache-2.0 | wasm（單檔版：wasm 以 base64 包在 `.wasm.js` 裡） |
| `@tesseract.js-data/chi_tra` | 1.0.0 | MIT（包裝）；資料是 tesseract-ocr/tessdata，Apache-2.0 | `4.0.0_best_int/chi_tra.traineddata.gz` |
| `wasm-feature-detect` | 1.9.0（2026-08-11） | Apache-2.0 | 有 SIMD 用 `simd-lstm`，沒有用 `lstm` |

`tesseract.js` 自己的相依（`idb-keyval`、`bmp-js`、`zlibjs`、`is-url`、`node-fetch`、`regenerator-runtime`）只有 Node 那一邊用 `node-fetch`；瀏覽器的延遲載入塊實測 19.70 KB。

### 6.2 大小（`vite build` 實測，scratch 專案、vite 8.3.0）

| 檔案 | 原始 | gzip | 去處 |
|---|---|---|---|
| 延遲載入塊（Tesseract.js 主執行緒＋我們的引擎模組） | 19.70 KB | 8.37 KB | 預先快取（同 ponyfill） |
| `worker.min-*.js` | 111.31 KB | 33.6 KB | 預先快取 |
| `tesseract-core-simd-lstm.wasm-*.js` | 3,899.47 KB | 1,462 KB | 不預先快取；runtime `CacheFirst` |
| `tesseract-core-lstm.wasm-*.js`（沒有 SIMD 的裝置） | 3,896.48 KB | 1,461 KB | 同上（一台裝置只會下載其中一個） |
| `chi_tra.traineddata.gz` | 1,656.24 KB（解開 2,368.6 KB） | 已經是 gzip | 不預先快取；Tesseract.js 的 IndexedDB（存解開的） |
| `eng.traineddata.gz`（**不用**） | 2,952.87 KB（解開 5,199.1 KB） | — | — |

經過 Caddy（`caddy:2-alpine` v2.11.4＋這個 repo 的 Caddyfile，2026-10-23 在本機量）實際傳的：core **1,473,651 B（zstd）**／1,516,876 B（gzip）、
worker 33,681 B（zstd）、`chi_tra.traineddata.gz` 1,656,239 B（不再壓）。第一次用要下載約 **3.17 MB**（瀏覽器不收 zstd 時 3.21 MB）。
主程式 `index-*.js` 的增加要在 Task 4 用 `npm run build` 量（預期只有 `lib/label-ocr.ts` 的幾百 bytes）。

### 6.3 實驗（2026-10-22，這台 Windows 桌機、Chromium（Playwright 1.63）、本機伺服器）

合成標示：用 Playwright 把三種標示畫成 HTML 表格截圖（微軟正黑體、2× 解析度、約 1170 × 900）——乾淨的 PNG，與「像手機拍的」JPEG（轉 −1.6°、模糊 0.7 px、
對比 0.85、米色底、品質 70）：**both**（每份＋每 100 公克）、**serving**（每份＋每日參考值、毫升）、**kj**（英文、只有 kJ）。

| 設定 | both（照片） | serving（照片） | kj（照片） | 每張時間 |
|---|---|---|---|---|
| PSM 3（預設） | 只剩數字、名稱那一欄整欄不見 | 只讀到三列 | 列錯位 | 0.26–0.49 s |
| PSM 6、`chi_tra+eng` | 8 列全對 | 亂碼（信心 34） | kJ 對，**7 個數字掉 6 個小數點**（`2809`、`609g`） | 0.34–1.28 s |
| PSM 6、`chi_tra` | 8 列全對 | 亂碼（信心 25） | 小數點都對，kJ 讀成 `k`／沒有 | 0.34–0.79 s |
| PSM 6、`chi_tra`、灰階＋對比＋放大到 2000 | `太卡`、`公交`、`鈉`→`丙` | 亂碼 | 同上 | 0.58–1.46 s |
| PSM 4、`chi_tra` | 列錯位 | 熱量、蛋白質、脂肪；碳水不見 | Energy 那一列錯位 | 0.33–0.57 s |
| **PSM 6、`chi_tra`、`rotateAuto`** | 8 列對（每份那一欄一個 `公交`，數字對） | **8 列全對**（信心 86；參考值欄 `279%` 不影響） | 小數點對，kJ 讀成 `k`／`p` | 0.45–0.55 s |

PSM 3／4 在**乾淨**的 PNG 上也會把「每份」那一整欄丟掉。大照片（同一張畫成 4088 × 3157）：

| 長邊 | 時間 | 結果 |
|---|---|---|
| 原圖 4088 | 2.17–2.35 s | `蛋白錦`、`臺升`、`磋水化全物` |
| **2000** | **0.91–1.19 s** | 兩張都全對 |
| 1600 | 0.69–0.95 s | 一個 `和蛋白質`（多一個字，關鍵字照樣對得到） |

建 worker（從本機伺服器下載 core 與語言資料、沒有快取）：0.12–0.28 s。Node 22 裡也跑得起來（`chi_tra` 單獨可以；`chi_tra+eng` 從本機目錄載入時 `eng` 載不起來，
訊息是一個亂碼的語言名稱——7.0.0 的另一個毛病，跟 D10 的選擇無關）。

**手機上的時間沒有量過。** 估計：中階手機的 wasm 比這台桌機慢 3–5 倍 → 建 worker 0.5–1.5 s、辨識 3–6 s（長邊 2000）；第一次再加 3.2 MB 的下載（4G 約 3–10 s）。
**合成標示不是真的照片**：沒有反光、彎曲、透視、小字、底色花紋；準確度要在真的包裝上看（§9 第 1 點）。

### 6.4 自己服務、不打第三方

- `tesseract.js` 預設從 jsDelivr 抓 worker、core 與語言資料；三個都改成自己的網址（`workerPath`、`corePath`、`langPath`），`workerBlobURL: false`（同源的 worker 直接用網址，
  不用 blob 包一層，也讓 service worker 看得到它的請求）。實驗裡 Playwright 記下的請求：**第三方 0 個**。
- dev 伺服器：`?url` 給的是 `/node_modules/…` 的網址，語言資料由 plugin 的 middleware 給；實驗在 dev 與 preview 都跑過。
- Caddy（**實測**，同 §6.2 的設定）：`.js` 是 `text/javascript; charset=utf-8`、`Content-Encoding: zstd`（或 gzip）；`.gz` 是 `application/gzip`、
  **沒有** `Content-Encoding`（不在 `encode` 的預設類型裡，不會被再壓一次；就算被壓了，瀏覽器解開傳輸編碼、Tesseract.js 看得出 gzip 的開頭兩個位元組自己再解）。
  兩者都只有 `ETag`／`Last-Modified`，沒有 `Cache-Control`。**檔案不在時 `try_files` 回 `index.html`（200 `text/html`，實測）**：Tesseract.js 初始化失敗、
  走 D16 的錯誤 → 「這台裝置現在不能用手機辨識」＋AI 按鈕。Caddyfile 不改；部署後的檢查寫進 `docs/deployment.md`。

### 6.5 前處理

`shrinkToLongestEdge(file, 2000)`（既有的 `lib/resize-image.ts`，JPEG 0.85；長邊已經 ≤ 2000 原樣回傳）。不做灰階、對比、二值化（§6.3）。轉正交給 `rotateAuto`。

---

## 7. 安全與隱私

- **OCR 這條路照片不離開裝置**：辨識在瀏覽器的 worker 裡；送出去的只有辨識出來的字。照片只有在使用者按「改用 AI 讀」時才送（同今天的 `read-label`）。
- 文字不存、不寫 log（D7）；不寫 `ai_analyses`、不算額度。
- 引擎與語言資料從自己的網域載入（D12）；IndexedDB 裡只有語言資料。
- 限速（D6）。端點不碰資料庫，所以沒有「看不看得到」的問題。
- 沒有 CSP（Caddyfile 沒設）；以後加 CSP 要允許 `wasm-unsafe-eval` 與同源的 worker。

---

## 8. 測試

- **後端**：`tests/test_label_text.py`（正規化的每一條、四種營養素的關鍵字與排除、欄的判斷、相鄰兩行、kcal／kJ、每一份量與份數、三個算例、每一種 `reason`、
  合理性退到每份）；`tests/fixtures/label_text/*.txt` 是**實驗裡真的 OCR 輸出**（§6.3 的幾張，含雜訊），斷言讀出來的數字；`tests/test_foods_parse_label_text.py`
  （401、422 空字串與 4001 字、429 與 `Retry-After`、完整與不完整的回應形狀、**不寫 `ai_analyses`**、**不打 estimator**、沒有 log 帶到文字）；
  `tests/test_nutrition_units.py`（`plausible_per_100`）；`tests/test_ai_label.py` 不改就要綠（重構的守衛）。
- **前端**：`label-text-api`（`parseLabelText`、錯誤的說法、`describeLabelParse`）；`label-ocr`（縮圖、`import()`、取消、沒有字）；`label-reader`（自動辨識、
  完整填表單、不完整的卡片與兩顆按鈕、改用 AI 帶同一張照片與說明、填入讀到的、「數字不對？」、取消與卸載會中止、貼上文字）；`new-food-barcode` 改成先過 OCR
  （預設 mock 讀不到字 → 「改用 AI 讀」）。`mockApi` 裡 `/api/foods/parse-label-text` 要排在 `/api/foods` 前面（子字串比對）。
- **e2e**：`e2e/label-ocr.spec.ts`（新帳號、手機尺寸）：真的 OCR 讀固定照片 → 表單 514.00／6.00／28.00／60.90、份 35 → 建立；`read-label` **0 次**、
  `parse-label-text` 的 body 只有 `text`。讀不出來（`jpeg.ts` 的小圖）→「改用 AI 讀」（假的 read-label 1 次）。貼上文字（每份 → 每 100 ml）。貼上不完整 →「填入讀到的」。
  `barcode.spec.ts`、`ai-photo-hint.spec.ts` 的營養標示改成「改用 AI 讀（用 1 次額度）」。
- **建置**：`npm run build` 之後檢查 `dist/ocr/tessdata-4.0.0_best_int/chi_tra.traineddata.gz` 在、`dist/sw.js` 的**預先快取清單**裡沒有 `tesseract-core`（`sw.js` 裡會有這個字，在 runtime `CacheFirst` 的規則裡，這是故意的）、主程式不含 `tesseract`。

---

## 9. 已知限制

1. **只用合成標示量過**。真的包裝（反光、彎曲、透視、小字、花紋底）的準確度沒有量；`rotateAuto` 只轉小角度、不修透視。
2. **手機上的時間沒有量過**（§6.3 的估計）。iOS Safari 的 wasm、記憶體、service worker 能不能接管 dedicated worker 的請求都沒有實機驗證。
3. 英文標示的 `kJ` 常讀不出來（熱量就算讀不到 → AI 或自己填）；`chi_tra` 單獨讀英文字還可以，但不是為英文訓練的。
4. 少了小數點不猜：每 100 那一欄壞了會退到每份；兩欄都壞就是 `implausible`。某些讀錯（`6.0g` 讀成 `6.09`）合理性擋不住——所以一律「請對照包裝確認」。
5. 原況文字／Google Lens 貼上的格式**沒有實測**。如果它們一欄一欄（先全部名稱、再全部數字）輸出，這一版讀不到（只處理同一行與相鄰兩行）。
6. 語言資料在 IndexedDB 裡存解開的 2.4 MB；換資料版本之後舊的那一筆不會被刪。iOS 的網頁（沒有加到主畫面）七天沒用會被清掉，下次再下載。
7. 第一次辨識會自動下載約 3.2 MB（D1），不先問。
8. `tesseract.js` 7.0.0 的兩個毛病（`{code, data}` 壞掉、載入失敗時 `createWorker` 不 settle）靠 D12、D16 繞過；升版要重看。失敗之後它的 worker 還會在主執行緒
   丟一個 `Cannot read properties of undefined (reading 'resolve')`（實驗看到），所以失敗時一定 `terminate()`。
9. 每張照片只辨識一次（PSM 6）；不自動換 PSM 再試（實驗裡 PSM 4 沒有讀出 PSM 6＋轉正讀不出的東西）。
10. 文字解析在後端：沒有網路時 OCR 做完也讀不了（引擎的快取只是省下載）。

---

## 10. 與原始決定的差異

1. **語言只用 `chi_tra`，不是 `chi_tra+eng`**（D10）：`eng` 多 2.95 MB（比 `chi_tra` 還大），台灣標示沒有變好，英文標示的小數點反而掉了 6 個（§6.3）。
2. **語言資料不用 `?url`**（D12）：Tesseract.js 要固定檔名，`{code, data}` 在 7.0.0 壞掉；改成 `vite.config.ts` 的小 plugin。worker 與 core 照原決定用 `?url`。
3. **快取不是全部 workbox `CacheFirst`**（D13）：語言資料用 Tesseract.js 內建的 IndexedDB（不依賴 service worker 接管 worker 的請求）；worker 進預先快取；只有 core 用 `CacheFirst`。
4. **前處理不做灰階與對比**（D11、§6.5）：量過變差；只縮長邊到 2000，另外加 `rotateAuto`（原設計沒有，量過是 serving 那張讀得出來的關鍵）。
5. **「數字裡的空白」只處理小數點兩邊**（§4.1）：一般的「數字 空白 數字」是欄的分隔，合併會造出不存在的數字。
6. **不完整時的 `found` 一律是每 100**（換算得出來的才算）；只有每份、沒有每一份量 → `needs_serving_size`，`found` 全是 null。
7. **多了「填入讀到的」**（D3）與「數字不對？改用 AI 讀」（D4）：都是為了少用一次額度或少重拍一次。
8. **貼上文字沒有 AI 按鈕**：沒有照片可以送；說明改成「填入讀到的」或自己填。
9. **沒有放進 vitest 的 Node 真 OCR 測試**：vitest 跑在 jsdom，要另外的環境與檔案路徑，而 e2e 已經在真的 Chromium 跑同一條管線（D20）；Node 的實驗記在 §6.3，OCR 的輸出記成後端的 fixture。
10. **worker 用完就收掉**（D14），不在整個 session 留著。

---

## 11. 交付

- 後端：`app/label_text.py`（新）、`app/nutrition_units.py`（`plausible_per_100`）、`app/ai/label.py`（改用它）、`app/schemas/label_text.py`（新）、
  `app/api/routes/foods.py`（端點）、`app/ratelimit.py`（`label_text_rate_limiter`）、`tests/conftest.py`（重置）；測試與 fixture。
- 前端：`package.json`（`tesseract.js` 7.0.0、`tesseract.js-core` 7.0.0、`@tesseract.js-data/chi_tra` 1.0.0、`wasm-feature-detect` 1.9.0，全部釘版本）、
  `vite.config.ts`（語言資料的 plugin、`globIgnores`、`runtimeCaching`）、`src/lib/{label-ocr,label-ocr-engine,label-text}.ts`、`src/api/label-text.ts`、
  `src/components/{LabelReader,HintField}.tsx`（`HintField` 從 `PhotoHintStep` 抽出來，兩邊共用）、`src/screens/NewFood.tsx`、`src/test/setup.ts`、`src/api/schema.d.ts`；測試。
- e2e：`e2e/label-ocr.spec.ts`、`e2e/fixtures/nutrition-label.jpg`、`e2e/fixtures/make-label.mjs`（重畫照片用）；`barcode.spec.ts`、`ai-photo-hint.spec.ts` 的修改。
- 文件：`docs/handover.md`（進度表、第 10 節一段、§8.2 已知限制）、`docs/deployment.md`（OCR 的資源、快取、部署後的檢查）。
