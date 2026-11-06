# 拍營養標示的入口、改名「吃什麼」與新圖示、掃條碼載入失敗後重試

**狀態：** 設計（2026-11-06，使用者核准拆解；之後的決定用推薦的，記在這裡）
**日期：** 2026-11-06
**分支：** `feat/label-entry-rename`
**前置：** 標示 OCR（`LabelReader`、`POST /api/foods/parse-label-text`）、掃條碼（`BarcodeScanEntry`、新增食物的交接 `lib/new-food-handoff.ts`）、
總覽的快速記錄（`lib/quick-actions.ts` 的照片暫存）、掃描層的「技術細節」（`fix/barcode-detector-detail`）
**計畫：** `docs/superpowers/plans/2026-11-06-label-entry-rename.md`

---

## 1. 為什麼

1. 使用者要「不靠 AI、用影像處理讀營養標示」。這件事**已經有了**（新增食物的「拍營養標示」：手機上 Tesseract 辨識＋後端確定性的規則），
   但使用者在記一餐只看得到「掃條碼」「拍照估算」「讓 AI 配一餐」——入口藏在新增食物的表單裡，找不到。
2. 改名「吃什麼」，換新圖示（使用者從四個候選裡選了 C：盤子＋問號）。
3. 2026-11-06 iPhone 上掃條碼一直是「這台裝置不能用相機掃條碼」，部署帶「技術細節」的版本、重開 app 之後就好了。原因沒抓到，
   但不管原因是什麼，**zxing 會記住失敗的那一次**（`prepareZXingModule` 把被拒絕的 promise 留在快取裡），整個 app 關掉重開之前
   每一次掃條碼都拿同一個失敗。暫時的失敗（網路剛好斷一下、Tailscale 剛醒）不該變成要重開 app 才好。

## 2. 範圍

### 2.1 做的事

- **A. 拍營養標示的入口**：記一餐、編輯這一餐的「加一項」、食物庫，在「掃條碼」下面多一顆「拍營養標示」（開後鏡頭）＋一行說明
  「在手機上讀數字，不用 AI 額度」。選好照片 → 到新增食物、**一進去就在手機上辨識那張照片**（同在新增食物裡按「拍營養標示」）→
  數字填好、使用者打名稱、建立 → 回到記一餐（或這一餐）、那個食物選好。食物庫來的：建立之後照舊到食物詳情頁。
- **B. 改名與新圖示**：app 名稱、主畫面上的名稱、分頁標題都是「吃什麼」；新圖示（C），含 iPhone 主畫面用的 `apple-touch-icon`、
  Android 的 maskable、分頁用的 SVG。圖示從一份 SVG 原稿用腳本產生。
- **C. 掃條碼載入失敗後重試**：ponyfill 載不起來時清掉 zxing 記住的模組，下一次打開掃描層重新載。

### 2.2 明確不做

- 總覽的四個快速記錄不加第五個（排版是四格；入口放在記一餐就是使用者找的地方）。
- 不在記一餐裡讀完直接記、不建食物：OCR 讀不出名稱，總要有地方打名稱；建成食物下次可以直接搜尋。
- 記一餐跳到新增食物、**記一餐在跳之前填的東西會不見**——同掃條碼的「用這個條碼建立食物」（掃條碼規格 D21、§12 第 3 點），同一套交接。
- 不改辨識本身（準確度、參數、解析規則）。
- 後端不動：沒有 migration、沒有新的環境變數、端點數不變（109）。
- 動態 `import()` 的 ponyfill 模組本身抓不到時，瀏覽器可能也會記住那次失敗（模組對應表）；這個不處理——它在預先快取裡，
  離線也拿得到。

## 3. 決定

| # | 決定 | 理由 |
|---|---|---|
| D1 | 入口是**檔案選擇的標籤**（`PhotoPickerButton`，`capture="environment"`，灰色虛線 `muted`），不是連到新增食物再自動打開相機 | iOS 只在使用者手勢裡開檔案選擇器；導頁之後程式化 `click()` 會被擋（同總覽的「拍照記」，首頁改版規格 D8）。一按就開相機，少按一次 |
| D2 | 放在 `FoodPicker` 裡、`BarcodeScanEntry` 的下面，另起一列：按鈕＋說明「在手機上讀數字，不用 AI 額度」。`FoodPicker` 多一個選填的 `onLabelPhoto(file)`，有給才畫（記一餐、編輯這一餐都給）。食物庫自己畫一顆（它不用 `FoodPicker`） | 「掃條碼」旁邊就是使用者在找的地方；說明讓人知道這條路跟「拍照估算」（AI、算額度）不一樣 |
| D3 | 照片交給新增食物：沿用總覽「拍照記」的**照片暫存**（`File` 不進 history，state 只帶號碼；重新整理就沒有了）。暫存從 `lib/quick-actions.ts` 抽成 `lib/photo-stash.ts`（一格），`quick-actions` 的三個函式改成呼叫它、行為不變 | `history.state` 會被結構化複製（Firefox 有大小上限），重新整理還會把舊照片帶回來（首頁改版規格 D8 已經記過）。一格就夠：一次只會有一張照片在路上 |
| D4 | router state `{labelPhoto: <號碼>, returnTo}`（`labelPhotoState(file, returnTo)` 暫存照片、組出 state）。`newFoodHandoffFrom` 認兩種：有條碼的（照舊）或有照片的；`NewFoodHandoff` 多 `labelPhoto: File \| null`。號碼對不上暫存（舊的 history、重新整理）→ 沒有照片；沒有條碼也沒有照片 → `null`（同今天） | 同一個交接：`returnTo` 白名單、去與回都 `replace`、「取消，回到記一餐」連結、存好帶 `pickedFood` 回去，全部不用重寫 |
| D5 | 去：記一餐與編輯這一餐用 `replace`（同掃條碼 D20），食物庫用一般的 push、沒有 `returnTo` | 同掃條碼：history 裡不會多出兩個一樣的記一餐；食物庫存好照舊到詳情頁 |
| D6 | `NewFoodRoute` 讀一次 state、`replace` 清掉的那一刻**放掉暫存**（同 `LogMealRoute` 的 `releaseQuickPhoto`） | 照片已經在新增食物自己的 state 裡；不留一張可能好幾 MB 的檔案 |
| D7 | `LabelReader` 多一個 `initialPhoto?: File`（**只在掛載時讀**）：掛上就走跟「選了一張照片」**同一段**——太大（> 10 MB）→ 照舊在按鈕下面說「照片超過 10MB…」、不出卡片；否則出卡片、自動手機辨識、焦點到卡片 | 一份程式碼、同樣的結果處理（完整就填表單、不完整給「改用 AI 讀」與「填入讀到的」）。太大在新增食物說，跟在那裡選照片一樣（總覽「拍照記」也是到了記一餐的 AI 面板才擋） |
| D8 | StrictMode 的「掛、卸、再掛」：卸載時中止辨識（今天就有），再掛時重新開始；只有最後那一次的結果會用（`runOcr` 一開始就中止前一次） | 開發時不會跑兩次辨識後互相蓋掉；正式版只跑一次 |
| D9 | 新增食物的「找不到這個條碼的資料。拍營養標示讀數字，或自己填。」只在**有條碼、沒有預填**時出現（照片來的不出現） | 那句話是給掃條碼沒命中的人的 |
| D10 | 名稱：manifest 的 `name` 與 `short_name` 都是「吃什麼」、`<title>吃什麼</title>`、`<meta name="apple-mobile-web-app-title" content="吃什麼">` | 三個字主畫面放得下，不用另外一個短名稱。iOS 加到主畫面時預設用 `apple-mobile-web-app-title` |
| D11 | 圖示原稿 `frontend/public/icon.svg`（512×512、**不透明、不靠字型**：問號是路徑，不是 `<text>`）。腳本 `frontend/scripts/render-icons.mjs`（`npm run icons`，用已經有的 Playwright Chromium）產生：`apple-touch-icon.png`（180）、`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`（同一張圖縮到 80% 置中、底色鋪滿，內容在 maskable 的安全圓裡）。產生的 PNG 進 git | 不透明：iOS 會把透明的地方填黑。不靠字型：哪台機器跑腳本都一樣。PNG 進 git：build 與 CI 不用跑 Chromium。maskable 另一張：Android 會把圖示裁成圓形或圓角，原圖的叉子與湯匙會被切掉 |
| D12 | `index.html` 加 `<link rel="apple-touch-icon" href="/apple-touch-icon.png">` 與 `<link rel="icon" href="/icon.svg" type="image/svg+xml">`；manifest 的 `icons`：192、512（`purpose: "any"`）、maskable 512（`purpose: "maskable"`） | 今天沒有 `apple-touch-icon`，iPhone 靠 manifest 的圖示（舊版 iOS 會拿畫面截圖）；分頁今天沒有圖示 |
| D13 | 圖示的顏色：底 `#fff4ef`、盤子 `#ff7a59`（app 的 `--color-accent`）、盤心白、問號與叉子湯匙 `#b8432a`（`--color-action`） | 跟畫面同一套顏色；舊的綠色圖示跟 app 不搭 |
| D14 | 已經加到 iPhone 主畫面的 app **不會自己換名稱與圖示**：部署後要刪掉主畫面上的圖示、從 Safari 重新「加入主畫面」，要重新登入一次（主畫面 app 的儲存跟 Safari 分開，刪掉就清了；資料都在伺服器上）。寫進 `docs/deployment.md` 與交接 | 使用者會以為沒部署成功 |
| D15 | 重試：`createPonyfillDetector` 載入失敗時呼叫 `barcode-detector/ponyfill` 的 `purgeZXingModule()`，再丟出錯誤（訊息照舊接 zxing 印的那幾行）。每一次載入前清掉 `loadLog`（清掉模組之後下一次會重新印） | zxing 的 `prepareZXingModule` 用淺比較沿用快取裡的 `[overrides, promise]`——被拒絕的 promise 也沿用。`purgeZXingModule` 是套件公開的、刪掉那一筆快取。下一次打開掃描層（`useBarcodeScanner` 每次掛載都重新 `loadDetector()`）就是真的重新載入 |
| D16 | 重試不自動在背景一直試：失敗就顯示 `no-detector`（照舊，有「技術細節」），**下一次按「掃條碼」**才重新載 | 使用者按了才試：不會在背景一直打網路、耗電 |

## 4. 畫面

```
記一餐
  搜尋食物 [          ]
  [▦ 掃條碼]  查不到時，條碼可能會送到 Open Food Facts 查詢
  [📷 拍營養標示]  在手機上讀數字，不用 AI 額度          ← 新的
  （AI 面板：拍照估算、讓 AI 配一餐 …）
```

- 編輯這一餐的「加一項」同一個樣子（同一個 `FoodPicker`）。
- 食物庫：「新增食物」連結、掃條碼，下面同一列「拍營養標示」＋說明。
- 新增食物（照片來的）：跟在新增食物裡選了照片一樣——卡片「確認照片」、「手機辨識中…」＋秒數；有 `returnTo` 時頂上照舊有
  「取消，回到記一餐」（或「回到這一餐」）。
- 按鈕的可及名稱是「拍營養標示」（input 的 id 每個地方不同，不撞新增食物的 `label-photo`），說明用 `aria-describedby` 接在 input 上。

## 5. 測試

- 單元：
  - `lib/photo-stash`：存、拿（號碼對才給）、放掉；`quick-actions` 的既有測試照過。
  - `lib/new-food-handoff`：照片的 state → 交接（號碼對、號碼不對、條碼與照片都沒有、`returnTo` 白名單）。
  - `LabelReader` 的 `initialPhoto`：掛上就辨識（完整 → 填表單）、太大 → 錯誤不出卡片、沒給就跟今天一樣。
  - `FoodPicker`／`LogMeal`／`EditMealItems`／`FoodLibrary`：有入口、選了照片呼叫 `onLabelPhoto`（或導頁、state 對）；`NewFood` 帶照片的交接 → `LabelReader` 拿到、不出「找不到這個條碼」那句。
  - ponyfill：失敗 → `purgeZXingModule` 被叫、錯誤照舊帶 zxing 印的；第二次載入的錯誤**只**帶第二次印的（`loadLog` 每次清）。既有的「zxing 記住了失敗、第二次沒有再印」那一條改掉（行為換了）。
- e2e（Chromium、dev）：
  - 記一餐 →「拍營養標示」放固定的標示照片（`e2e/fixtures/nutrition-label.jpg`，真的 Tesseract、真的後端解析）→ 到新增食物、數字填好 → 打名稱、建立 → 回到記一餐、那個食物選好。
  - 掃條碼：wasm 抓不到 → `no-detector`；關掉、放行 wasm、再按「掃條碼」→ 不是 `no-detector`（相機那條在測試裡是假的「沒有相機」，所以是「沒有相機」那句）。
  - 標題是「吃什麼」；`/apple-touch-icon.png`、`/icon.svg` 拿得到（200、對的 content-type）。
- build：`dist/manifest.webmanifest` 的名稱與四個圖示；圖示檔在 `dist/`。

## 6. 文件

- 交接（`docs/handover.md`）：名稱、入口、重試、測試數字；iPhone 要重新加入主畫面（D14）。
- `docs/deployment.md`：改名稱或圖示之後 iPhone 主畫面的處理（D14）。
- README 標題：「吃什麼 —— 飲食紀錄系統」。
