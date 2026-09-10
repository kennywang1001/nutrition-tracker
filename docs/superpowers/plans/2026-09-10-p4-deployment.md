# P4：部署到 NAS（含上線前的安全補強）

規格：`docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md`
前置：P1 全部五個計畫皆已合併進 master。

起點：424 個測試、42 個端點、覆蓋率 98.40%、10 張資料表。

**目標：把這套 API 真的跑在 NAS 上，讓手機透過 Tailscale 用得到。**

部署方式已確定：**SSH 進 NAS + `docker compose`**（不是 Container Manager GUI）。
所以本計畫的手冊要寫成**可以直接貼上去執行的指令**，每一步都附預期輸出。

---

## 這個計畫的一個前提，先講清楚

**執行者（AI）沒有 NAS 的存取權。** 本計畫能做的是：

- 改好程式碼、Dockerfile、compose
- 在**本機**把每一項都驗證過（包含「模擬 production 設定」的驗證）
- 產出一份可貼上執行的部署手冊，每步附預期輸出

**實際在 NAS 上跑的那幾步由使用者執行。** 手冊要寫清楚每一步「成功長什麼樣」，
好讓出錯時知道是哪一步 —— 而不是只給一串指令。

Task 9 的驗證清單裡有幾項**只有使用者做得到**（例如「從不在 tailnet 的裝置確認連不上」），
那些要明確標示出來，不要混在 AI 可以自動驗證的項目裡。

---

## 這份計畫從 P1 繼承的規矩

1. **綠燈在被觀察到失敗之前不算證據。** P1 累積了八種「綠燈說謊」的機制。
   本計畫每一個守衛都要突變過。
2. **測試一個清理動作，就必須在它之後再做一件需要乾淨狀態的事。**
3. **`try` 的邊界要對齊「例外實際會從哪裡拋出」。**
4. **權限失敗 404、角色失敗 403**，body 逐字相同。
5. **知道一條規則，跟在具體情境裡認出它適用，是兩種能力。**
   計畫 4b Task 9 實測踩到：與其在文件裡再寫一次警告，
   **不如把檢查寫進程式碼，讓錯誤的選擇在執行時就爆掉。**

---

## 本計畫確立的五個決定

### 決定 1：速率限制按「提交的 email」+ 全域上限，**不按 IP**

**實測發現，這不是偏好問題：** 容器裡看到的 client IP 全部是 `172.19.0.1`
（Docker bridge 的 gateway）。

```
INFO: 172.19.0.1:50578 - "GET /api/health HTTP/1.1" 200 OK
INFO: 172.19.0.1:50590 - "GET /api/me HTTP/1.1" 401 Unauthorized
```

Docker 的 userland proxy 對發佈的埠做 SNAT，所以 **tailnet 上每一個人在應用程式
眼中都是同一個來源**。按 IP 限速會把所有使用者算成同一個人 —— 一個人被限速，
全部的人一起被限。

所以改成兩層：

| 層 | 鍵 | 用途 |
|---|---|---|
| 每帳號 | **提交的 email 字串** | 擋針對單一帳號的密碼猜測 |
| 全域 | 無 | 擋大量帳號的橫向嘗試 |

**每帳號那層對登入暴力破解其實比按 IP 更對** —— 它保護的是「被攻擊的那個帳號」，
不管攻擊來自哪裡。代價是可能被拿來擾人（一直打某人的帳號讓他登不進去），
所以**不能鎖帳號，只能延遲**：短視窗、成功登入立刻重置、永不永久鎖定。

### 決定 2：限速要按「提交的 email」而非「存在的帳號」

**只對存在的帳號限速，會變成帳號列舉神諭。**

如果不存在的 email 永遠不會觸發 429、存在的會，那攻擊者只要送 11 次就能問出
「這個 email 有沒有註冊」。這跟計畫 1 花力氣消掉的登入時序側通道
（`DUMMY_PASSWORD_HASH`，實測 66.85ms vs 68.16ms）是同一類洩漏，
而且新做的防護不能把它加回來。

**所以計數的鍵是使用者送進來的 email 字串本身，帳號存不存在完全不影響行為。**

### 決定 3：liveness 與 readiness 分開，`/api/health` 不動

- `GET /api/health` —— **liveness**，維持現狀（不碰資料庫）
- `GET /api/health/ready` —— **readiness**，做 `SELECT 1`

Docker healthcheck 打 **liveness**。理由（計畫 1 就記過）：
兩者混在一起，資料庫短暫抖動會觸發容器重啟，**而重啟並不能解決資料庫的問題** ——
只會在資料庫恢復期間把 API 也一起弄掉。

readiness 給人／腳本判斷「現在能不能服務」用，不接到自動重啟上。

### 決定 4：production 用 compose override 疊加，不是另一份完整檔案

```
docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d
```

不寫成獨立的完整 compose，是因為兩份完整檔案會各自演化，
而「開發環境能跑、production 壞掉」的差異只會在部署當下才發現。
override 只寫**差異**，共同部分永遠只有一份。

production 的差異：拿掉 `--reload`、拿掉原始碼掛載、密鑰走環境變數、
加 `restart: unless-stopped`、加 healthcheck、綁定位址收窄（決定 5）。

### 決定 5：發佈埠綁到 Tailscale 的位址，不是 `0.0.0.0`

規格第 3 節寫「Tailscale 是邊界」，但目前 `ports: "8000:8000"` 綁的是 `0.0.0.0` ——
**那個前提其實沒有被強制**，NAS 在區域網路上的任何裝置都連得到。

production override 改成綁到 NAS 的 tailnet 位址：

```yaml
ports:
  - "${BIND_ADDR:?BIND_ADDR is required}:8000:8000"
```

`:?` 語法讓「忘記設」變成**大聲的啟動失敗**，而不是安靜地退回 `0.0.0.0`。
這是決定 6（fail closed）的同一個原則用在 compose 層。

> **Task 9 有一項只有使用者做得到的驗證：**
> 從一台**不在 tailnet** 的裝置（例如同一個區域網路上的另一台電腦）
> 連 `http://<NAS 區網 IP>:8000/api/health`，**必須連不上**。
> 這一項沒有替代做法 —— AI 無法從外部驗證別人的網路。

---

## 五個必須在動手前講清楚的陷阱

### 陷阱 1：單獨修掉 Argon2 阻塞，會拿掉一道意外的保護

計畫 1 實測過：

| 情境 | 登入嘗試速率 |
|---|---|
| 序列 | 約 16–17 次/秒 |
| 20 並發 | 約 14.9 次/秒 |
| 50 並發 | 約 16.1 次/秒 |

**並發完全不會提升攻擊者的吞吐量** —— 因為 `verify_password` 是同步的 CPU 密集
呼叫，寫在 `async def` 裡，event loop 把它序列化了。這構成一個粗糙的**全域**
速率上限（約 140 萬次/天），不管攻擊者開幾條連線。

代價是：**一個人狂試登入，tailnet 上所有人的所有請求都會變慢**
（實測 `/api/health` 從 2.40ms 變成平均 67.27ms、最高 378.73ms）。

**所以這兩件事必須一起做。** 只修阻塞 = 拿掉保護、速率限制還沒補上，
攻擊者的吞吐量會直接跳上去。只加限速 = 延遲問題還在。

### 陷阱 2：拿掉 `jwt_secret` 的預設值會炸掉所有測試與開發流程

`app/config.py` 目前是：

```python
jwt_secret: str = "dev-secret-change-me-in-production"
```

改成必填之後，**任何沒有設 `JWT_SECRET` 的地方都會在 import 時就崩** ——
包含 `pytest`、`alembic`、CI、以及 `docker compose up` 的開發用法。

這正是我們要的行為（fail closed），但**要把每一個入口都補上**，
否則這個 task 會變成「改一行、然後修二十個地方」的泥沼。動手前先盤點：

- `tests/conftest.py`（或 `pytest.ini` / `pyproject.toml` 的環境變數設定）
- `.github/workflows/ci.yml`
- `docker-compose.yml`（開發用的，仍然可以寫死一個明顯是開發用的值）
- `.env.example`
- `migrations/env.py`（它讀 `settings`）

**盤點要在寫任何程式碼之前做完並回報**，不要邊修邊發現。

### 陷阱 3：`extra="ignore"` 與密鑰預設值是同一個問題的兩面

打成 `JWT_SECERT=...` 不會有任何警告，程式用預設值跑起來。

改成 `extra="forbid"` **不可行** —— `.env.example` 裡有 `TEST_DATABASE_URL`，
那是刻意不放進 `Settings` 的（測試直接讀 `os.environ`），`forbid` 會讓它直接炸掉。

**所以解法就是決定 6 本身：只要密鑰沒有可用的預設值，拼錯就會變成大聲的
啟動失敗。** 兩項一起修才完整，分開修兩邊都不到位。

### 陷阱 4：Dockerfile 把測試依賴裝進 production 映像

```dockerfile
RUN pip install --no-cache-dir -c requirements-lock.txt -e ".[dev]"
```

`[dev]` 包含 pytest、mypy、ruff、httpx、pytest-cov。它們在 production 沒有用途，
只是把映像變大、把攻擊面變寬。

改成 production 不裝 `[dev]`。**但要注意：CI 需要 `[dev]`**，
所以不能只是把 `[dev]` 拿掉了事 —— 要確認 CI 仍然裝得到（CI 是直接 pip install，
不走 Dockerfile，所以應該不受影響，**但要實際確認而不是假設**）。

### 陷阱 5：孤兒照片清理要「先查 DB、再刪檔」，而且不能刪到正在上傳的

規格第 8 節：兩種孤兒的嚴重性不對稱 —— 多一個沒人引用的檔案只是浪費磁碟，
少一個被引用的檔案是壞掉的功能。

清理工作要掃 `photo_dir` 下的檔案，比對 `meals.photo_path`，刪掉沒被引用的。
**但有一個競態：** 一張剛寫入、DB 還沒 commit 的照片，在掃描眼中就是孤兒。

所以**只刪修改時間超過某個閾值（例如 24 小時）的檔案** ——
上傳與 commit 之間的間隔是毫秒級，24 小時的緩衝足夠寬。

---

## Task 1: fail-closed 的設定（密鑰必填）

**Files:** `app/config.py`、`tests/conftest.py`（或 pytest 設定）、
`.github/workflows/ci.yml`、`docker-compose.yml`、`.env.example`

- [ ] **Step 0（先做，不寫程式碼）：盤點所有入口並回報**

見陷阱 2。找出所有會建立 `Settings()` 的路徑，列出來，**回報之後再動手**。

- [ ] **Step 1: 測試**

`Settings` 在沒有 `JWT_SECRET` 時拋 `ValidationError`；
有設就正常；設成開發預設值那個字面字串時 —— **決定要不要擋，並在測試裡釘住**
（建議擋掉，因為那個字串是公開的，等於沒有密鑰）。

- [ ] **Step 2: 實作 + 把每個入口補上**

開發用的 `docker-compose.yml` 仍然可以寫死一個明顯是開發用的值 ——
重點是**沒有預設值可以退回**，不是「不准有值」。

- [ ] **Step 3: 驗收**

`pytest -W error`、`ruff`、`mypy app`、`alembic check`、
**以及 `docker compose config` 能跑通**。

Commit: `feat: 密鑰改為必填，缺少時在啟動就失敗`

---

## Task 2: `GET /api/health/ready`

**Files:** `app/api/routes/health.py`、`tests/test_health.py`

見決定 3。`/api/health` **不動**。

- [ ] **測試（約 5 個）**

`/api/health` 不碰資料庫（可用 monkeypatch 讓 DB 爆掉，確認它仍然 200）；
`/api/health/ready` 正常時 200；資料庫不通時回 **503**（不是 500）；
兩者都不需要認證；`/health/ready` 真的有下 `SELECT 1`（用查詢計數確認）。

> 「`/api/health` 不碰資料庫」那個測試是本 task 的重點：
> 它守的是決定 3 —— 日後有人「順手」把 DB 檢查加進 liveness 時會變紅。

Commit: `feat: 新增與 liveness 分開的 readiness 檢查`

#### Task 1 / 2 實測發現：fail-closed 當場咬了自己一口（這是好事）

Task 1 合併後，**跑著的 dev 容器立刻進入崩潰迴圈** ——
而且是本計畫要修的每一個問題同時上演：

```
$ docker ps
wallet-api-1   Up 2 days          <- 看起來完全正常
$ curl localhost:8000/api/health
(連不上)
$ docker logs wallet-api-1
ValidationError: JWT_SECRET 不能是原始碼裡公開過的開發預設值
```

發生了什麼：`docker-compose.yml` 裡寫死的 `JWT_SECRET` 就是那個被新驗證器
禁掉的公開字串。原始碼是掛載進去的、`--reload` 有效，所以 `app/config.py`
一改動容器就重載 → `Settings()` → 拒絕啟動。

**三件事同時被證實：**

1. **fail-closed 真的有效。** 它拒絕用一個公開的字串當密鑰啟動 ——
   這正是設計意圖，而且是在**啟動當下**大聲失敗，不是安靜跑起來。
2. **容器狀態會謊報存活**（決定 3 與陷阱的核心）。`Up 2 days` 完全沒有反映
   應用程式已經死了兩分鐘。**Task 5 的 healthcheck 就是在修這個。**
3. **改了環境變數必須重建容器，`restart` 不夠。**
   `docker compose up -d api` 才會用新的 compose 設定重建。
   這條計畫 1 就記過，這次是第二次咬人。

> **值得記的是這次的因果方向：** 不是我們寫錯而被 fail-closed 擋下，
> 而是 fail-closed 一上線就找出了一個**既有的**問題（dev compose 用公開字串
> 當密鑰）。一個好的守衛在導入的當天就會抓到東西 ——
> 如果導入之後什麼都沒發生，反而要懷疑它有沒有真的接上。

**順帶修掉的狀態不一致：** dev 資料庫還停在 `0004`，計畫 4a / 4b 的
`0005`（補劑三表）與 `0006`（user_targets）從來沒套用上去 ——
容器上的 API 打補劑或目標端點會直接炸。已升級到 `0006`，
示範資料（4 使用者、3 食物、2 餐、3 個餐點項目）完全不受影響
（兩個 migration 的 upgrade 都是純 `create_table`）。

---

## Task 3: Argon2 移出 event loop + 速率限制（**必須一起**）

**Files:** `app/security/password.py`、`app/ratelimit.py`（新增）、
`app/api/routes/auth.py`、`tests/test_rate_limit.py`

見陷阱 1、決定 1、決定 2。

- [ ] **Step 1: 先量測現況**

對跑起來的容器重跑計畫 1 的量測（序列、20 並發、50 並發的登入速率，
以及並發登入下 `/api/health` 的延遲），**回報數字**。
這是「修改前」的基準，Task 9 要拿它對照。

- [ ] **Step 2: 測試**

限速（約 9 個）：
同一個 email 連續失敗達上限 → **429**；
上限之下正常回 401；
**不存在的 email 跟存在的 email 行為完全相同**（決定 2 —— 這是最重要的一個）；
成功登入重置該 email 的計數；
不同 email 各自獨立計數；
全域上限觸發 → 429；
429 的 body 走既有的錯誤信封；
視窗過期後恢復；
`Retry-After` 標頭存在且合理。

不阻塞（約 5 個）：
`verify_password` 在執行緒裡跑（用 `asyncio.to_thread` 或 `run_in_threadpool`）；
註冊時的 `hash_password` 同樣處理；
**並發登入時其他端點的延遲不受影響**（這個測試要量測，不是只看狀態碼）。

- [ ] **Step 3: 實作**

計數器放記憶體（單一容器，重啟後歸零 —— 這個規模可以接受，
**但要在程式碼註解裡寫明**，免得日後有人以為它是持久的）。

> **突變要求：** 拿掉「不存在的 email 也計數」那段，
> 確認決定 2 的那個測試變紅。若沒變紅，代表測試沒有真的比較兩條路徑。

- [ ] **Step 4: 重跑量測並對照**

修改後再跑一次 Step 1 的量測，**回報前後對照表**。
預期：登入吞吐量在限速下大幅下降、`/api/health` 的延遲回到接近平時。

Commit: `feat: 登入速率限制與 Argon2 移出 event loop`

---

## Task 4: Dockerfile 分離 production 與開發依賴

見陷阱 4。

- [ ] **Step 1: 改 Dockerfile**，production 不裝 `[dev]`
- [ ] **Step 2: 實測映像大小前後對照**，回報數字
- [ ] **Step 3: 確認 CI 仍然裝得到 `[dev]`** —— 實際看 workflow 怎麼裝的，不要假設
- [ ] **Step 4: 確認建出來的映像跑得起來**（`docker compose up` + 打 `/api/health`）

Commit: `build: production 映像不再包含測試依賴`

---

## Task 5: `docker-compose.prod.yml`

見決定 4、決定 5。

override 要包含：拿掉 `--reload` 與原始碼掛載、
`restart: unless-stopped`（兩個服務都要）、
api 的 healthcheck（打 liveness）、
密鑰與 `BIND_ADDR` 走 `${VAR:?...}`、
`.env.production.example` 範本。

- [ ] **驗證（本機做得到的部分）**

`docker compose -f docker-compose.yml -f docker-compose.prod.yml config`
在缺少必要環境變數時**失敗並指名是哪一個**；補齊之後 `config` 輸出正確；
**在本機用 production 設定實際跑起來一次**（`BIND_ADDR=127.0.0.1`），
確認 API 可用、`--reload` 確實沒有生效（改一個檔案，確認 API 沒有重載）。

Commit: `feat: 新增 production 的 compose override`

---

## Task 6: 孤兒照片清理

**Files:** `app/cli.py`（既有）、`tests/test_photo_cleanup.py`

見陷阱 5。做成 CLI 子指令，讓 NAS 上用 cron 排程。

- [ ] **測試（約 8 個）**

被引用的檔案不刪；沒被引用且夠舊的刪掉；
**沒被引用但很新的不刪**（競態緩衝）；
`--dry-run` 不刪任何東西但回報會刪什麼；
資料夾裡有非預期的檔案時不炸；
`photo_dir` 不存在時不炸；
回報刪除數量；
**刪不掉的檔案（例如權限問題）不讓整個指令失敗**。

Commit: `feat: 新增孤兒照片清理指令`

---

## Task 7: 資料庫備份

**Files:** `scripts/backup.sh`（新增）、手冊

`pg_dump` 到 NAS 的一個資料夾，保留 N 份。照片本身已經是檔案系統上的普通檔案
（規格第 8 節的理由之一），交給 Synology 既有的備份機制。

- [ ] **驗證：實際做一次「備份 → 還原到另一個資料庫 → 比對資料筆數」**

> 一個沒有還原過的備份不算備份。這一步要真的跑，不是寫個腳本就算完。

Commit: `feat: 新增資料庫備份腳本`

---

## Task 8: 部署手冊

**Files:** `docs/deployment.md`（新增）、`README.md`（改）

**寫成可以直接貼上執行的指令，每一步附預期輸出。**

要涵蓋：SSH 進 NAS、clone、產生密鑰（`openssl rand -hex 32`）、
填 `.env.production`、找出 tailnet 位址、啟動、確認、
以及**更新流程**（區分「只改程式碼」與「改了依賴」，見計畫 1 的 P4 記錄）。

還要收錄既有的維運程序：
**換掉 `JWT_SECRET` 可以強制登出所有 session**（計畫 1 記錄的緊急處置）、
建立管理員帳號的指令、備份與還原、孤兒照片清理的排程。

---

## Task 9: 上線驗證清單

分成兩欄：**AI 可自動驗證** 與 **只有使用者做得到**。

AI 可驗證（在本機用 production 設定）：
缺少密鑰時啟動失敗、`--reload` 沒生效、映像不含 pytest、
healthcheck 有效、readiness 在資料庫斷線時回 503、
限速生效且對不存在的帳號行為相同、備份還原成功。

只有使用者做得到（NAS 上）：
- [ ] 從**不在 tailnet** 的裝置連 NAS 的區網 IP → **連不上**
- [ ] 從 tailnet 上的手機連 → 可用
- [ ] `docker compose ps` 顯示兩個容器都 healthy
- [ ] 重開 NAS → 容器自己回來（`restart: unless-stopped` 生效）
- [ ] 用手機真的記一餐、上傳一張照片、查當日統計
- [ ] 確認照片下載回來 EXIF 是空的（P1 已在本機驗過，這裡是端到端複驗）

---

## 完成驗收

- [ ] `pytest -v -W error` 全部通過，測試數 ≥ 455
- [ ] `ruff check .`、`mypy app` 無錯誤
- [ ] `pytest --cov=app --cov-fail-under=80` 通過
- [ ] `alembic check` 乾淨
- [ ] 缺少 `JWT_SECRET` 時，`Settings()` 拋 `ValidationError`
- [ ] production compose 在缺少必要環境變數時失敗並指名
- [ ] production 映像不含 pytest（`docker run ... pip show pytest` 失敗）
- [ ] 登入限速的前後量測對照已回報
- [ ] 備份 → 還原 → 比對筆數，實際做過一次
- [ ] Task 9 的「使用者驗證」清單已交付（不是由 AI 打勾）

---

## 這份計畫刻意不做的事

- **session 撤銷**（計畫 1 明確說「不要拖到 P4，要自己一個 task」）。
  緊急處置（換 `JWT_SECRET`）會寫進手冊。
- **HTTPS / 憑證。** Tailscale 本身已經加密，NAS 上再包一層 TLS 對這個
  威脅模型沒有增益。
- **多容器擴展、負載平衡。** 單機單容器。
- **監控 / 告警系統。** healthcheck 讓 Docker 知道狀態就夠了；
  真要告警是 P5 的事。
- **日誌集中化。** `docker logs` 對這個規模夠用。

---

## 下一步

P4 之後 API 就在線上了。接著依規格第 2 節：

- **P2**：AI 分析（照片 → 辨識 → 查庫 → 估算 → **驗證層** → 落庫）。
  規格第 11 節說驗證層「是這個作品集最有價值的部分」。
- **P3**：前端。

**真實使用會很快告訴你 P2 與 P3 哪個該先做** —— 這也是先做 P4 的理由。
