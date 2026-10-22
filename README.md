# 飲食紀錄系統

記錄每日三大營養素與補劑攝取，支援拍照與 AI 營養素分析。

## 開發環境

需求：Docker Desktop、Python 3.12

```bash
python -m venv .venv
.venv/Scripts/activate          # Windows；macOS/Linux 用 source .venv/bin/activate
pip install -c requirements-lock.txt -e ".[dev]"

cp .env.example .env
docker compose up -d db
alembic upgrade head
```

啟動 API：

```bash
docker compose up -d
```

開 http://localhost:8000/docs 看 API 文件。

## 測試

測試跑**真的 PostgreSQL**，不用 SQLite 代替 —— 因為專案用到 `EXCLUDE` 約束、
`citext`、`pg_trgm`，SQLite 都沒有，用它測等於測了一個跟正式環境不同的系統。

```bash
docker compose up -d db
pytest
```

每個測試包在資料庫交易內、跑完 rollback，因此測試之間完全隔離，也不需要手動清資料。

## 建立管理員帳號

```bash
python -m app.cli create-admin <email> <password> <顯示名稱>
```

> **注意：對一個已存在的 email 重跑這個指令，會重設那個帳號的密碼並把它變成管理員。**
> 沒有確認步驟，也沒有復原機制 —— 打錯 email 就是靜默地接管別人的帳號。
> 指令會印出「已建立」或「已提升」來區分這兩種情況，執行後請確認那行輸出。

## 清理孤兒照片

`meals.photo_path` 是權威來源；`photo_dir` 底下沒被任何一筆 `meals` 引用、
而且修改時間超過 24 小時（避免刪到還沒 commit 的上傳）的檔案視為孤兒。

```bash
python -m app.cli cleanup-photos --dry-run   # 先看會刪什麼，不會真的刪
python -m app.cli cleanup-photos             # 實際刪除
```

`--min-age-hours` 可以覆寫預設的 24 小時緩衝。

## 緊急處置：強制登出所有 session

目前沒有「登出單一裝置」的機制。若需要立即讓所有既有的 token 失效
（例如裝置遺失），**更換 `JWT_SECRET` 並重啟服務**即可 —— 所有 access token
與 refresh token 都會因為簽章驗證失敗而立刻無效。

代價是所有使用者都會被登出，需要重新登入。

（更細緻的作法 —— 只登出單一使用者 —— 見計畫文件的「後續任務：session 撤銷」。）

## 部署到 NAS

透過 SSH + `docker compose`，經由 Tailscale 存取。以下是主要流程；
**每一步的預期輸出、備份還原、緊急處置與故障排除**在
[docs/deployment.md](docs/deployment.md)。

### 前提

NAS 已安裝 Container Manager、已開啟 SSH、已加入你的 tailnet。

### 1. 取得原始碼

```bash
ssh your-user@your-nas
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/kennywang1001/nutrition-tracker.git
cd nutrition-tracker
```

### 2. 查出 NAS 的 Tailscale 位址

```bash
tailscale ip -4          # 輸出類似 100.x.y.z，下一步要用
```

### 3. 產生密鑰並填設定

```bash
cp .env.production.example .env.production
openssl rand -hex 32     # 把輸出填進 JWT_SECRET
```

編輯 `.env.production`：

```
JWT_SECRET=<剛才產生的 64 字元十六進位>
BIND_ADDR=100.x.y.z
```

> `BIND_ADDR` 填 tailnet 位址、**不要填 `0.0.0.0`** —— 那會讓區域網路上的
> 任何裝置都連得到，「Tailscale 是邊界」這個前提就形同虛設。
>
> 這兩個變數都**沒有預設值可以退回**。忘記填的話下一步會直接失敗並指名
> 是哪一個，而不是安靜地用一個可預測的值跑起來。

### 4. 先驗設定，再啟動

```bash
# 設定解析得出來嗎？（缺變數會指名）
docker compose --env-file .env.production   -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo OK

# 啟動（第一次要建映像，NAS 上可能十幾分鐘）
docker compose --env-file .env.production   -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

### 5. 確認健康

```bash
docker compose --env-file .env.production   -f docker-compose.yml -f docker-compose.prod.yml ps
```

**看 `(healthy)`，不要看 `Up`。**

```
NAME            SERVICE   STATUS
wallet-api-1    api       Up 30 seconds (healthy)
wallet-db-1     db        Up 40 seconds (healthy)
```

> `Up` 不代表活著 —— 這個專案實際踩過兩次：uvicorn 的 reloader 父行程
> 在子行程 import 失敗時仍然活著，`docker ps` 顯示 `Up 4 days` 而 API
> 已經死了四天。healthcheck 就是為此存在的。

### 6. 套用 migration 並建立管理員

```bash
PROD="--env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml"

docker compose $PROD exec api python -m alembic upgrade head
docker compose $PROD exec api python -m app.cli create-admin you@example.com '你的密碼' '你的名字'
```

### 7. 從手機確認

tailnet 裡的手機開 `https://<機器名>.<tailnet>.ts.net`（`tailscale serve status` 第一行就是網址；
api 只綁在 NAS 自己的 loopback，從外面連 `100.x.y.z:8000` 是連不到的，那是刻意的）。

### 更新

映像由 GitHub Actions 在測試全綠之後建好、推到 GHCR，NAS 只負責拉下來換上。等 master 那次
push 的 CI 全綠，在 NAS 上跑：

```bash
cd ~/apps/nutrition-tracker && sudo ./scripts/deploy.sh
```

腳本會 `git pull`、拉映像、先備份資料庫、跑 migration、換上新版、等健康檢查，起不來就自動退回上一版。
細節（版本檢查、部署鎖、退版的限制）見 [docs/deployment.md](docs/deployment.md)。

### 例行維護

```bash
bash scripts/backup.sh                                          # 資料庫備份（保留最新 7 份）
docker compose $PROD exec api python -m app.cli cleanup-photos  # 清理孤兒照片
```

> 清理照片**必須在容器內執行** —— 照片存在 Docker 的具名 volume 裡，
> 在 host 上跑會看錯目錄、回報「0 個孤兒」而真實的卷一直累積。

排程與還原流程見 [docs/deployment.md](docs/deployment.md)。

## 開放給朋友使用（Tailscale 分享）

這個 app 只開放給 tailnet 裡的裝置。要讓朋友用，最安全的做法是用 Tailscale 的**分享（Share）**：
朋友用**他自己的** Tailscale 帳號，只看得到你分享的這一台 NAS，看不到你其他的裝置；app 也不會公開在網路上。
陌生人不能自己註冊——每個帳號都要你發的邀請連結。

> Tailscale 管理頁的按鈕名稱可能隨版本略有不同，以畫面上看到的為準。

### 一次性：限制朋友只能連到 app（建議先做）

分享出去的是**整台 NAS**。不加限制的話，朋友的裝置也連得到 NAS 的其他服務（DSM 管理介面、SSH、檔案分享）。
在 Tailscale 的存取規則裡，把「分享進來的人」限制成只能連這台的 443（也就是這個 app）：

1. 在 NAS 上查 Tailscale 的 IP：

   ```bash
   tailscale ip -4
   ```

2. 打開 <https://login.tailscale.com/admin/acls>（Access controls）。**先把整份內容複製存一份備份**。
3. 在 `"hosts"` 裡替 NAS 取個名字（沒有 `"hosts"` 就新增），把 `"acls"` 換成下面這兩條——
   第一條讓**你自己的裝置**照舊什麼都連得到，第二條讓**分享進來的人**只能連 NAS 的 443：

   ```jsonc
   "hosts": {
     "nas": "100.x.y.z"   // 換成第 1 步查到的 IP
   },
   "acls": [
     { "action": "accept", "src": ["autogroup:member"], "dst": ["*:*"] },
     { "action": "accept", "src": ["autogroup:shared"], "dst": ["nas:443"] }
   ],
   ```

   檔案裡其他段落（例如 `"ssh"`、`"tagOwners"`）**照舊留著**，只改 `"hosts"` 與 `"acls"`。
4. 按 **Save**。存檔前頁面會檢查格式；存好之後用你自己的手機打開 app，確認還連得到。
   改壞了就把第 2 步的備份貼回去、再存一次。

### 每加一位朋友

**你要做的：**

1. 打開 <https://login.tailscale.com/admin/machines>，找到 NAS 那一台，點右邊的 **⋯** →
   **Share…**，產生一條分享連結（或直接填朋友的 email 邀請），傳給朋友。
2. 打開這個 app → **我的 → 邀請朋友**，產生一條**建立帳號的邀請連結**，也傳給朋友。
   兩條連結不一樣：第一條讓他連得到 NAS，第二條讓他在 app 裡開帳號。

**朋友要做的：**

1. 在手機或電腦安裝 **Tailscale**（App Store、Google Play，或 <https://tailscale.com/download>），
   用 Google／Apple／Microsoft 帳號登入（個人使用免費）。
2. 打開你傳的**分享連結**，按接受。
3. 在 Tailscale App 裡把連線**打開**（用 app 的時候 Tailscale 要開著，平常一直開著也可以）。
4. 打開你傳的**邀請連結**，設定 email、密碼和名字，建立帳號。
5. 之後都用你給他的網址登入（`https://<機器名>.<tailnet>.ts.net`，你在 NAS 上跑 `tailscale serve status`
   第一行就是）。手機可以「加入主畫面」，用起來就像一般 App。

### 常見問題

- **朋友打不開網址**：確認 Tailscale 是「已連線」，而且在 Tailscale App 的裝置列表裡看得到你的 NAS。
  分享連結要用**他自己登入 Tailscale 的那個帳號**接受。
- **朋友連得到 app、但連不到 NAS 的其他東西**：這是上面存取規則的效果，正常。
- **不想再讓某位朋友用**：
  1. Tailscale 管理頁 → Machines → NAS 那一台 → **⋯ → Share…**（或 Sharing），把那個人移除——他就連不到了；
  2. app 裡他的帳號和資料還在；要改他的密碼用「我的 → 所有帳號 → 產生重設密碼連結」（帳號目前沒有刪除功能）。
- **朋友的資料存在哪**：全部在你的 NAS 上（每天備份到 `backups/`）。邀請朋友前，讓他知道他的飲食、體重和照片會存在你這裡。

## 交接文件

專案全貌、核心設計決定與其理由、踩過的坑、已知缺口、下一步：

**[docs/handover.md](docs/handover.md)**

## 設計文件

- [P1 設計規格](docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md)
