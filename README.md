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

tailnet 裡的手機開 `http://100.x.y.z:8000/docs`。

### 更新

程式碼是 build 進映像的（production 沒有原始碼掛載也沒有 `--reload`），
所以**一律用 `up -d --build`，`restart` 不夠**：

```bash
git pull
docker compose $PROD up -d --build
docker compose $PROD exec api python -m alembic upgrade head   # 若這次有 migration
```

### 例行維護

```bash
bash scripts/backup.sh                                          # 資料庫備份（保留最新 7 份）
docker compose $PROD exec api python -m app.cli cleanup-photos  # 清理孤兒照片
```

> 清理照片**必須在容器內執行** —— 照片存在 Docker 的具名 volume 裡，
> 在 host 上跑會看錯目錄、回報「0 個孤兒」而真實的卷一直累積。

排程與還原流程見 [docs/deployment.md](docs/deployment.md)。

## 設計文件

- [P1 設計規格](docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md)
