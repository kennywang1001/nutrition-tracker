# P3-A 前端 — 每天會用到的四個畫面

- 日期：2026-09-11
- 階段：P3（介面）的前半
- 狀態：待審

---

## 1. 目標與範圍

P1 規格第 2 節對 P3 只寫了一行：「手機可用的前端（PWA，TypeScript + React）」。
這份規格把那一行展開，但**只展開一半**。

### 為什麼切成 P3-A / P3-B

依「每天真的會用到的次數」排序，前四個畫面走完，這個 app 就真的每天能用；
後三個是「有比較好」而不是「不然沒法用」。而且後三個畫面的細節在沒有真的
用過前四個之前，多半會猜錯 —— 趨勢圖要看什麼、食物庫要怎麼找，這些問題
在累積了兩週真實資料之後才有答案。

| | 內容 |
|---|---|
| **P3-A（這份）** | 基礎建設（反向代理、型別產生、資料層、認證、測試、PWA）+ 登入、記一餐、今日總覽、拍照 |
| P3-B（另一份規格） | 趨勢圖、食物庫管理與編輯送審、管理員審核佇列 |

### 範圍外

- P2 的 AI 分析流程（拍照 → 辨識 → 估算）。P3-A 的拍照只做「上傳並附到一餐」。
- 離線寫入。理由見 §8，不是延後，是有四個前置條件。
- 註冊畫面。單人自用，帳號用 `python -m app.cli create-admin` 開。
  這不是偷懶：註冊畫面要處理 email 驗證、重複 email、密碼強度提示，
  而這個系統的使用者總數是個位數。

---

## 2. 前置條件（硬性）

**[Session 撤銷](2026-09-11-session-revocation-design.md) 必須先完成。**

不是排程偏好，是設計依賴。後端目前沒有登出端點，前端的「登出」只能清掉
localStorage，而那張票在伺服器上還活著 14 天 —— **那是一個看起來有效、
實際上說謊的 UI**。本規格 §6 的整個認證流程（single-flight 鎖、重用偵測後
的強制登出）都建立在那份規格的產出上。

---

## 3. 技術決策

每一條都附理由，因為理由比結論更重要。

### 決策 1：同源，靠反向代理，不用 CORS

多一個 Caddy 容器在最前面：`/` 給 SPA 的靜態檔，`/api/*` 反向代理到 api 容器。

**後端 `app/main.py` 一行都不用改。** 目前完全沒有 `CORSMiddleware`，
而同源之下也不需要加。

另外兩個選項都有具體的代價：

- **FastAPI 掛 `StaticFiles` 服務 SPA** —— 會弄紅
  `tests/test_meals_photo.py::test_no_static_files_mount_serves_the_photo_directory`。
  那個測試斷言的是 `static_mounts == []`（**任何路徑的任何掛載**），
  它是 §4.9「照片不可以有第二條無認證的路」那條規矩唯一的執法者。
  要放行只能把它從「沒有任何掛載」弱化成「沒有掛載服務照片目錄」——
  而弱化守衛正是 §6 第 7 條那一課在講的事。
  另外 SPA fallback（未知路徑回 `index.html`）會跟「路由層 404 要回
  `HTTP_ERROR` 錯誤信封」直接打架，`/api/typo` 會變成回 HTML。
- **跨源 + `CORSMiddleware`** —— 要維護 `allow_origins` 白名單，
  而 tailnet 位址與裝置會變；為單人自用 app 增加一個設定面與一個攻擊面。

**開發環境也同源**：Vite 的 `server.proxy` 把 `/api` 轉到 `localhost:8000`。
這一條是決策 1 真正的價值 —— 跨源只要存在於任何一個環境，就會長出一整類
只在那一邊出現的 bug，而那類 bug 在單元測試裡是隱形的。

production 的埠對外只剩 Caddy 那一個，**api 容器不再發佈任何埠**
（決定 5「Tailscale 是邊界」在這裡自然收緊了一層）。

### 決策 2：同 repo，`frontend/` 目錄

理由不是方便，是**契約漂移只有在同 repo 才守得住**：後端改了 schema，
同一次 CI 就能讓前端的型別檢查跟著紅。分 repo 之後，這個保證沒有任何人守。

代價（規格必須誠實計入）：CI 要分 job 加 path filter，否則改一行 CSS
也要跑 463 個 pytest。

### 決策 3：Vite + React + TypeScript strict，不用 Next.js

SSR 對一個登入後才有內容、跑在 Tailscale 內網、單人使用的 app 沒有價值，
卻要多一個 Node runtime 容器與一整套 server/client 邊界的心智負擔。
P3 的學習目標是「前後端整合」，而 server component 恰好會把那條界線模糊掉。

### 決策 4：TanStack Query 當資料層

不是因為流行，是這個 API 的三個特性把它變成必需品：

1. access token 15 分鐘就過期 → 需要一個**統一的** 401 → refresh → retry 的地方
2. `/api/stats/daily`、`/api/supplements/today` 天然可快取
3. 記完一餐要讓今日總覽失效重取

手寫這三件事等於重寫 TanStack Query 的一半，而且是比較差的一半。

路由用 React Router —— 畫面只有四個，不需要更重的東西。

### 決策 5：型別從 `openapi.json` 產生，產生物進版控

`openapi-typescript` 從 `http://localhost:8000/openapi.json` 產生
`frontend/src/api/schema.d.ts`，**檔案進版控**，CI 重新產生後比對 diff，
有差就紅。

這是 §6 第 7 條（「文件擋不住重蹈覆轍，程式碼可以」）的直接應用。
與其在交接文件裡第三次警告「數值是字串」，不如讓型別檔自己說
`protein_g: string` —— 寫 `parseFloat(m.protein_g)` 不會錯，
但寫 `m.protein_g * 2` 當場型別錯誤。

數值運算一律走 `decimal.js`，包在一個 `frontend/src/lib/decimal.ts` 裡，
**所有 `new Decimal()` 只在這個模組出現**（跟後端把「每 100 單位的 100」
關在 `app/nutrition.py` 是同一個手法）。

### 決策 6：PWA 用 `vite-plugin-pwa`，不手寫 service worker

手寫 SW 看起來比較符合學習目標，但 SW 是前端最容易產生假綠燈的地方 ——
它在 jsdom 測試環境**根本不會被註冊**，所以任何手寫邏輯的預設狀態是
零覆蓋而且測試全綠（§10 陷阱 5）。用 Workbox 的 `generateSW`，
把自訂邏輯壓到最小。

---

## 4. 架構

### 4.1 容器拓撲

```
  手機                ┌── NAS ────────────────────────────────────┐
   │                  │                                           │
   │ https://nas.     │  tailscale serve                          │
   │   tailXXXX.ts.net│    └ TLS 終結（Let's Encrypt 憑證，自動續） │
   └─────────────────▶│         │ 127.0.0.1:8080                  │
                      │  ┌──────▼──────────────────────┐          │
                      │  │ caddy                       │          │
                      │  │   /       → /srv (SPA 靜態) │          │
                      │  │   /api/*  → api:8000        │          │
                      │  └──────┬──────────────────────┘          │
                      │         │ compose 網路                     │
                      │  ┌──────▼───────────┐   ┌──────────┐      │
                      │  │ api (不發佈埠)   │──▶│  db      │      │
                      │  └──────────────────┘   └──────────┘      │
                      └───────────────────────────────────────────┘
```

caddy 只綁 `127.0.0.1:8080`，不對 tailnet 開；對外的唯一入口是
`tailscale serve`。api 與 db 都不再發佈任何埠。

- dev：`docker compose up -d` 起 db + api；前端跑 `npm run dev`（Vite，
  `server.proxy` 轉 `/api`）。**dev 不起 caddy** —— Vite 的 proxy 已經
  提供同源，多起一個容器只會讓 HMR 多一層要 debug 的東西。
- prod：多階段 build 把 SPA 編成靜態檔進 caddy 映像。

### 4.2 HTTPS 是硬需求（這一節差一點被漏掉）

**目前的部署是純 HTTP**：`docs/deployment.md` 教的是把 `BIND_ADDR` 填成
`tailscale ip -4` 查到的 `100.x.y.z`，然後連 `http://100.x.y.z:8000`。
Tailscale 本身有加密，所以從機密性來說這沒問題 —— 但瀏覽器不知道這件事。

瀏覽器判斷 **secure context** 只看 scheme（`https:` 或 `localhost`）。
`http://100.x.y.z:8000` 不是 secure context，於是：

| 需要 secure context 的東西 | 沒有它會怎樣 |
|---|---|
| `navigator.serviceWorker` | **PWA 完全裝不起來** —— 決策 6、§8 的 L1/L2 全部落空 |
| `navigator.locks` | §6.4 的跨分頁 single-flight 鎖寫不出來 |
| 「加到主畫面」的安裝提示 | 不會出現 |

**所以 P3-A 一定要先把 HTTPS 弄出來，而且它排在所有前端工作之前** ——
先寫畫面再來處理這件事，會在最後發現整個 PWA 層要重做。

用 **`tailscale serve`**：Tailscale 對 tailnet 內的機器發 `*.ts.net` 的
Let's Encrypt 憑證，自己處理申請與續期，NAS 上不需要開 80/443 對公網，
也不需要在 Caddy 裡管憑證。

```
tailscale serve --bg --https 443 http://127.0.0.1:8080
```

`https://<機器名>.<tailnet>.ts.net` 就是 secure context，PWA 裝得起來。

**這一步必須在計畫的第一個 task 就實測驗證，不能假設。** 兩件事要親自確認，
不要從文件推論（這個專案 §7 的坑表裡有一半是這樣來的）：

1. Synology 的 Tailscale 套件版本支援 `serve`（舊版沒有這個子指令）
2. tailnet 的 HTTPS 憑證功能已在管理後台啟用（預設是關的）

**若任一項不成立**，退路是 `tailscale cert` 產出憑證檔、掛進 caddy，
由 caddy 終結 TLS —— 代價是續期要自己排 cron。退路一樣能讓 PWA 成立，
只是多一件要維護的事。**不要退到「先不做 PWA」**，那會讓決策 6 與 §8 整段作廢。

`docs/deployment.md` 要跟著改：`BIND_ADDR` 從 tailnet 位址改成
`127.0.0.1`，對外入口換成 `tailscale serve`。

**開發環境不需要 HTTPS**，因為 `http://localhost` 本身就是 secure context。
但這正好製造一個假綠燈：**所有 secure-context 相關的問題在 dev 環境
永遠不會出現**，只能在真機上發現（見 §9.2 第 9 條）。

### 4.3 目錄

```
frontend/
  src/
    api/
      schema.d.ts       ← openapi-typescript 產生，進版控，不手改
      client.ts         ← fetch wrapper：錯誤信封解析、Authorization、401 攔截
      queries.ts        ← TanStack Query 的 query/mutation 定義與 key
    auth/
      store.ts          ← token 存放（§6.1）
      refresh.ts        ← single-flight 鎖（§6.4）
    lib/
      decimal.ts        ← 唯一允許 new Decimal() 的地方
      dates.ts          ← 只做「顯示格式化」，不做日界線計算（§5.3）
    screens/
      Login.tsx  LogMeal.tsx  Today.tsx  MealPhoto.tsx
    components/
  tests/                ← Vitest + RTL
  e2e/                  ← Playwright
```

每個檔案一個清楚的用途。`client.ts` 跟 `refresh.ts` 分開是刻意的：
前者是「怎麼發一個請求」，後者是「票過期時怎麼辦」，後者有跨分頁的
並行語意，混在一起兩邊都會變得難測。

---

## 5. 與後端的契約

以下每一條都是從程式碼讀出來的，不是從交接文件轉述的。

### 5.1 所有數值是字串

`Decimal` 序列化成字串以避免浮點誤差。`"180.50"` 不是 `180.5`。
決策 5 的型別產生讓這件事由編譯器執法。

### 5.2 `photo_path` 不是 URL

`MealResponse.photo_path` 是**相對於 `PHOTO_DIR` 的伺服器端路徑**。
它唯一的用途是判斷「這一餐有沒有照片」。

要拿到圖必須打 `GET /api/meals/{id}/photo`，**帶 token、取 blob**。
不能塞進 `<img src>`，因為那個端點會先驗 JWT 與擁有權。

實作上包一個 `useMealPhoto(mealId)`：`fetch` → `blob()` →
`URL.createObjectURL()`，**且在卸載時 `revokeObjectURL`**（不 revoke 的話
在列表頁滑動會穩定漏記憶體，而這件事不會有任何測試自己變紅）。

### 5.3 日界線一律問伺服器

`?date=` 是純日期，**伺服器用 `users.timezone` 解讀**。
前端絕對不自己算「今天是哪一天」的邊界 —— §4.6 花了整節在講單一來源，
`app/days.py` 是那個來源。

`frontend/src/lib/dates.ts` **只做顯示格式化**。這個限制要寫在檔案頂端的
註解裡，因為它是一條靠人記住就會失守的規矩。

`eaten_at` / `taken_at` 是 `timestamptz`，收發都用 ISO 8601 含時區。

### 5.4 錯誤信封

所有錯誤都是 `{"error": {"code", "message", "details"}}`，
**包含路由 404 與未處理例外**（`app/errors.py` 註冊了四個 handler，
含 `Exception` 的總攔截）。

| code | 意義 | UI |
|---|---|---|
| `HTTP_ERROR` | 路由層 404 —— **網址打錯**，不是資源不存在 | 一般錯誤畫面 |
| `VALIDATION_ERROR` | Pydantic 驗證失敗，`details.errors` 有 `loc`/`msg`/`type` | 對應到欄位層級的錯誤訊息 |
| `INVALID_CREDENTIALS` | 帳號不存在**或**密碼錯誤（刻意無法區分） | 「email 或密碼不正確」，**UI 不得區分兩者** |
| `INVALID_TOKEN` | refresh 失效 | 強制登出（§6.5） |
| 帶語意的 404 code | 資源不存在**或**不是你的（§4.7 刻意相同） | 「找不到」 |
| `TOO_MANY_LOGIN_ATTEMPTS` | 429，**帶 `Retry-After` 標頭** | 倒數並停用送出鈕（§6.3） |

`details.errors` 已經被 `_sanitize_validation_errors` 移除 `input` 欄位，
所以驗證錯誤裡不會有使用者送的原始值 —— 前端要顯示什麼值得自己從 form
state 拿，不要期待後端回傳。

### 5.5 `TokenResponse` 沒有 `expires_in`

`{access_token, refresh_token, token_type: "bearer"}`，就這三個欄位。

所以前端**不能**排程「還有 30 秒過期時先換票」。設計上一律**被動反應 401**
（§6.2）。這不是缺陷 —— 主動排程需要信任 client 端的時鐘，而被動反應
不需要，少一個會壞的東西。

### 5.6 refresh token 放在 body，不是 header

`POST /api/auth/refresh` 收 `{"refresh_token": "..."}`。
（其他所有端點都是 `Authorization: Bearer`。）

### 5.7 `stats/daily` 的 null 有兩層

```
target: null              ← 這一天完全沒有生效的目標
target.protein_g: null    ← 有目標，但蛋白質這一項沒設
```

UI 必須分開處理：第一種顯示「尚未設定目標」，第二種那一項顯示
「未設定」而其他三項照常顯示比例。把兩者混為一談會讓使用者以為
自己沒設目標。

`ratio` 在 `target` 為 0 時也是 `null`（除以 0）。**顯示時一律先判 null，
不要用 `?? 0`** —— `0%` 跟「沒有標準可比」是兩件不同的事，
而這正是 §4.8「統計只回數字，不判斷達成與否」的延伸：判斷在前端，
但前端也不該把「沒有」偽裝成一個數字。

### 5.8 `supplements/today` 的 `plan_id: null`

代表這是一筆臨時記錄（沒有對應的固定計畫），**這種項目一定 `done: true`**。
UI 上它不該有「打卡」按鈕，只該有「取消」。

---

## 6. 認證流程

### 6.1 token 存哪裡

| | 存放 | 理由 |
|---|---|---|
| access token | **記憶體**（模組變數） | 15 分鐘就死，不值得持久化。這**不是** XSS 防護 —— 正在執行的 XSS 讀得到模組變數；差別只在它不留存到下一次開啟 |
| refresh token | **localStorage** | 重開 app 要還能用，否則每次開都要登入 |

後端是 `HTTPBearer`，改成 httpOnly cookie 要動後端的驗證方式，
而 §4.7 的 404 語意、§5.2 的限速設計都是繞著 bearer 建的。
為了前端的方便去動那一層，代價不對稱。

**所以要誠實記下代價：refresh token 在 localStorage，XSS 就拿得到。**
前置條件那份規格的重用偵測是這件事唯一的緩解 —— 攻擊者用了偷來的票之後，
合法裝置下一次換票就會踩到重用偵測，整條鏈被撤銷，使用者被登出。
**這是一個會被察覺的攻擊，而不是一個安靜的攻擊。** 那就是重用偵測的價值。

### 6.2 被動反應 401

因為 `TokenResponse` 沒有 `expires_in`（§5.5），流程是：

```
請求 → 401 → 用 refresh token 換票 → 換到 → 重送原請求
                                    → 沒換到 → 強制登出
```

`api/client.ts` 的攔截器負責這件事。**重送只做一次** —— 重送之後又 401
代表問題不在票過期，無限重試只會把 429 也一起惹出來。

### 6.3 429 的處理

登入失敗 5 次 / 60 秒（`PER_EMAIL_LIMIT = 5`），另有全域 20 次 / 60 秒。
回應帶 `Retry-After`（秒，已無條件進位且至少 1）。

UI 讀 `Retry-After` 做倒數並停用送出鈕。
**不要在 UI 上區分「帳號不存在」與「密碼錯誤」** —— 後端花了
`DUMMY_PASSWORD_HASH` 與「按送進來的 email 計數」兩道功夫把這個側通道關掉
（§5.2），前端顯示兩種不同的訊息就等於把它從另一頭加回來。

### 6.4 single-flight 鎖（前置條件那份規格推過來的約束）

重用偵測讓「同時有兩個 refresh 在飛」變成一個會導致**使用者莫名被登出**
的錯誤。後端刻意不做寬限期（寬限期會直接稀釋重用偵測的鑑別力），
所以這個責任在前端。

兩層：

1. **分頁內**：`refresh.ts` 保存 in-flight 的 promise，並行的呼叫者共用它。
2. **跨分頁**：`navigator.locks.request('token-refresh', ...)`。
   Web Locks 是同源、跨分頁的，正好是這個問題的形狀。

第 2 層不是多餘的 —— 手機上把 app 加到主畫面之後，PWA 視窗與 Safari 分頁
是兩個 context，共用同一個 localStorage。

**取得鎖之後要重新讀一次 localStorage**：等鎖的期間另一個分頁可能已經
換好票了，這時要用新的票，不是自己手上那張舊的（那張已經 `used_at` 了，
送出去就是自己觸發重用偵測）。

### 6.5 強制登出

`INVALID_TOKEN` 的意義可能是「票過期了」，也可能是「重用偵測撤銷了整條鏈」。
前端無法區分，處理一律相同：清空 token、清空 TanStack Query 快取、
導回登入頁。

**必須清 query 快取。** 不清的話下一個登入的人會先看到上一個人的
今日總覽，然後才被重新 fetch 覆蓋掉 —— 那是真正的跨使用者資料外洩，
而且是視覺上的、使用者會看到的那種。

### 6.6 登出按鈕

打 `POST /api/auth/logout`，**然後不管結果如何都清本地狀態**。
網路斷線時「登出」不能失敗 —— 使用者的意圖是「這台裝置上不要留著我的帳號」，
而那件事是本地就能做到的。伺服器端的撤銷會在票過期時自然收斂。

---

## 7. 四個畫面

依「每天真的會走幾次」排序，不是依實作難度。

### 7.1 記一餐（每天走最多次）

P1 規格第 11 節明寫這是主路徑，`GET /api/foods/frequent` 與 `/recent`
的索引在 P1 就為它顧好了。

```
選餐別 → 從「常吃 / 最近吃」點選食物 → 填份量 → 送出
```

- 份量：`quantity` + 可選的 `portion_id`（「1 碗」）。
  **前端不做換算** —— `quantity_g` 由伺服器在寫入當下算好並凍結（§4.3）。
- `POST /api/meals` 接受空的 `items`，但這個畫面一律至少帶一項。
- 送出成功後 invalidate `stats/daily` 與 `meals` 的 query key。

### 7.2 今日總覽

`GET /api/stats/daily`（攝取 vs 目標，注意 §5.7 的兩層 null）
\+ `GET /api/supplements/today`（打卡，注意 §5.8 的 `plan_id: null`）。

打卡是 `POST /api/supplement-intakes`，取消是 `DELETE`。
樂觀更新（optimistic update）在這裡值得做 —— 打卡是一個使用者預期
「按下去就變了」的動作，而失敗時 rollback 的成本很低。

### 7.3 拍照上傳

`POST /api/meals/{id}/photo`（multipart，上限 10MB，伺服器縮到長邊 1280
並去除 EXIF）。

- **上傳前先在前端檢查大小**，超過 10MB 直接擋。不是不信任後端的
  `PayloadTooLargeError` —— 是不要讓手機在慢速連線上傳了 30 秒才被拒。
- 手機拍出來的原圖經常超過 10MB。前端先用 canvas 降尺寸再上傳。
  **降尺寸不是為了取代伺服器的處理**（EXIF 去除仍然由伺服器負責，
  那是安全邊界，不能交給 client）。
- 顯示照片走 §5.2 的 blob 流程。

### 7.4 登入

單一表單。§6.3 的 429 倒數。沒有註冊、沒有忘記密碼（範圍外）。

---

## 8. 離線與 PWA

### 做到 L1 + L2

| 層級 | 內容 |
|---|---|
| **L1** | 可安裝；離線開啟不是白畫面，顯示明確的「離線中」狀態 |
| **L2** | 讀取離線：快取最近一次的今日總覽、常吃/最近吃清單 |

L2 用 TanStack Query 的持久化 + Workbox 的 runtime caching。
**快取的資料一律標示「離線資料，最後更新於 X」** —— 顯示陳舊數字而不說明
它是陳舊的，比不顯示更糟。

### 不做 L3（離線寫入佇列），因為它有四個前置條件

不是「以後再說」，是「要做 L3 必須先做這四件事」：

1. **日界線。** §4.6 明寫「前端不要自己算日界線」。離線寫入時沒有伺服器
   可問，就必須在前端複製一份時區邏輯 —— 那就是第二個事實來源，
   而 §4.6 整節都在講單一來源。
2. **食物版本化。** 離線時選的是快取裡的 revision，回線時它可能已經被
   審核取代。§4.1 的凍結保證是靠「寫入當下」的指標成立的，
   離線佇列會把「當下」拉長到幾小時。
3. **照片。** 10MB 的 blob 要進 IndexedDB 再重送，失敗重試的語意要自己定義。
4. **冪等性。** 後端沒有 idempotency key。**重送就是重複建立一餐。**
   要做 L3 得先改後端。

務實理由也站得住：走 Tailscale 的真實離線情境是「地下室餐廳沒訊號」，
時間很短。L2 讓你還看得到今天吃了什麼，L3 的價值遠低於成本。

---

## 9. 測試策略

§6 那十種綠燈說謊全部是後端的教訓。前端有自己的一整組，而且更容易踩，
因為前端測試預設就跑在一個沒有網路、沒有 service worker、沒有真實時區的
假世界裡。

### 9.1 兩層劃界

| 層 | 工具 | 負責 |
|---|---|---|
| 元件 | Vitest + RTL + MSW | 渲染、互動、錯誤顯示、狀態轉換 |
| 端到端 | Playwright 打真的 compose 後端 | **凡是「跟後端的約定」** |

**劃界的規則只有一條：任何「後端保證 X」的斷言都必須有一條 E2E。**
MSW 的 handler 是自己寫的，它證明不了後端的行為，只能證明前端在
「假設後端這樣回」時的行為。

必須有的 E2E（每一條對應一個後端保證）：

| E2E | 釘住的保證 |
|---|---|
| 登入 → 記一餐 → 今日總覽數字對得上 | 數值是字串、四捨五入規則、query 失效 |
| 照片上傳 → 帶 token 取回 | §5.2，且 `<img src>` 直連必須失敗 |
| 401 → refresh → 重送成功 | §6.2 |
| 登出 → 舊 refresh token 打 API → 401 | 前置規格 §6 陷阱 3 |
| 跨午夜記一餐 → 落在正確的一天 | §4.6 |
| 登入失敗 6 次 → 429 且倒數正確 | §5.2、§6.3 |

種子資料用現成的：`app/cli.py` 加上 dev 資料庫那組刻意有漏的示範資料
（依從率 0.77），不另外造一套。

### 9.2 前端的「綠燈說謊」清單

對照後端那十條逐一推導出來的。新加的任何前端測試都應該對照檢查一次。

| # | 綠燈為何不算數 | 對應後端的哪一條 |
|---|---|---|
| 1 | **MSW handler 回數字而不是字串**（`180.5` vs `"180.50"`）—— decimal.js 的處理零覆蓋，正式環境顯示 `NaN` | 第 5 種：兩個過濾器互相掩護 |
| 2 | **MSW 不檢查 `Authorization` header** —— 「照片要帶 token」零鑑別力 | 第 6 種：測不到有沒有第二條無認證的路 |
| 3 | **service worker 在 jsdom 不註冊** —— 所有離線邏輯零覆蓋而且全綠 | 第 6 種 |
| 4 | **`waitFor(() => expect(x).toBeInTheDocument())` 在元素本來就在時永遠綠** —— 斷言的時間窗跟缺陷的時間窗沒交集 | 第 9 種：兩個視窗沒重疊 |
| 5 | **時區測試用執行環境的當地時區** —— CI 是 UTC、本機是 Asia/Taipei，「台北宵夜」那類缺陷在 CI 上零鑑別力 | 第 2 種：選錯時區，原理上不可能失敗 |
| 6 | **登出只斷言「回到登入頁」** —— 證明的是前端清了狀態，不是伺服器上那張票死了 | 第 3 種：最終狀態對、中途錯 |
| 7 | **快照測試** —— 改壞了就更新快照 | 第 1 種：拿掉正確的修正照樣通過 |
| 8 | **E2E 用 `waitForTimeout()`** —— flaky，而且會掩蓋真正的競態（尤其 §6.4 的鎖） | 第 7 種：問題只在事後顯現 |
| 9 | **dev 與 CI 都跑在 secure context**（`localhost` 是，Playwright 也是）—— 於是 §4.2 那整類問題在自動化測試裡**原理上不可能出現**，只有真機會發現 | 第 2 種：選錯環境，測試在原理上不可能失敗 |

由此長出的三條做法：

1. **MSW 的 handler 必須通過 `schema.d.ts` 的型別檢查**，讓第 1 條在編譯期
   就不可能發生 —— §6 第 7 條：把檢查寫進程式碼，不要寫第三次警告。
2. **MSW 的 handler 一律先驗 `Authorization`**，沒帶就回 401 信封。
3. **Playwright 一律明確設 `timezoneId`，而且必須設一個跟 UTC 不同的**
   （`Asia/Taipei`）。這一條寫進 `playwright.config.ts` 的註解。

### 9.3 突變

沿用後端的規矩：**每個守衛都要突變過，結果寫回計畫文件。**
至少這些：

| 突變 | 必須變紅 |
|---|---|
| `refresh.ts` 拿掉 single-flight 鎖 | 並行 refresh 的 E2E |
| `decimal.ts` 改成 `parseFloat` | 數值精度的元件測試（若沒紅，代表測資挑得太整齊） |
| 照片改用 `<img src="/api/meals/1/photo">` | 照片 E2E |
| `INVALID_TOKEN` 不清 query 快取 | 跨使用者快取外洩測試（§6.5） |

---

## 10. CI

`.github/workflows/ci.yml` 分兩個 job，用 path filter：

| job | 觸發 | 內容 |
|---|---|---|
| `backend` | `app/**`、`tests/**`、`migrations/**`、`pyproject.toml` | 現況不動 |
| `frontend` | `frontend/**` | `tsc --noEmit`、`eslint`、`vitest run`、build |
| `contract` | **兩邊都觸發** | 起 api → 重新產生 `schema.d.ts` → `git diff --exit-code` |
| `e2e` | 兩邊都觸發 | compose 起 db+api → 種子 → `playwright test` |

`contract` job 是決策 5 的執法者，也是決策 2（同 repo）唯一的實質理由。
它必須在兩邊的變更都觸發，否則「只改後端」這個最常見的漂移路徑剛好漏掉。

---

## 11. 延後項目

- **P3-B**：趨勢圖、食物庫管理與編輯送審、管理員審核佇列
- **L3 離線寫入**：見 §8 的四個前置條件
- **照片縮圖**：交接文件 §8.2 說「等前端量到再說」—— P3-A 就是那個量的時機。
  列表頁載入多張 1280px 圖如果真的慢，那是一個後端變更，不要在前端用
  CSS 硬縮（那沒有省下傳輸量）。
- **`meal_items` 的修改端點**：目前改數量 = 刪掉再加，前端先照這個做。
- **註冊畫面 / 忘記密碼**

---

## 12. 完成標準

- [ ] [Session 撤銷](2026-09-11-session-revocation-design.md) 已完成並合併
- [ ] **HTTPS 成立且 secure context 實測確認**（`navigator.serviceWorker` 在
      手機上真的拿得到），部署手冊已更新
- [ ] caddy 容器，dev 走 Vite proxy、prod 走 caddy，**兩邊都同源**
- [ ] `app/main.py` 未被修改；`test_no_static_files_mount_*` 仍然綠
- [ ] api 容器在 prod 不再發佈任何埠
- [ ] `schema.d.ts` 進版控，`contract` job 能在後端改 schema 時變紅（實測驗證）
- [ ] 四個畫面在手機上（Tailscale + 加到主畫面）實際走過一次
- [ ] §9.1 的六條 E2E 全部綠
- [ ] §9.3 的突變全部實際跑過，結果寫回計畫文件
- [ ] 後端 463 個測試不因這個階段而變動
