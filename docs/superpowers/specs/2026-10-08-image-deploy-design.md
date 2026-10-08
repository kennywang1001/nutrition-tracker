# 部署改成「CI 做映像、NAS 拉映像」

**狀態：** 已實作（2026-10-08；CI `publish` job 要等第一次 push 到 master 才驗得到）
**前置：** master `ac2c32a`（已 push，CI 全綠）

## 1. 為什麼

現在的部署：NAS 上 `git pull` → 用原始碼在 NAS 上 build 兩個映像（慢）→ 另外手動跑 migration → 沒有退版。
指令多、容易漏步驟（例如 0015 之前要先查重複餐費），而且 build 在 NAS 上跑。

## 2. 做法

### 2.1 CI：測試全過才做映像（`.github/workflows/ci.yml` 新 job `publish`）

- 只在 **push 到 master** 時跑；`needs: [changes, backend, frontend, contract, e2e]`；
  `if: github.event_name == 'push' && github.ref == 'refs/heads/master' && !failure() && !cancelled()`
  ——被路徑過濾**跳過**的測試算過（純文件的 commit 也會做映像，這樣每個 master commit 都有對應的映像），
  **失敗**或取消就不做。
- 兩個映像推到 GHCR：`ghcr.io/kennywang1001/nutrition-tracker-api` 與 `…-web`（`frontend/Dockerfile`，Caddy＋前端），
  標籤是 **commit 的完整 SHA** 與 `latest`。
- **多架構**（`linux/amd64`、`linux/arm64`，QEMU）：不知道 NAS 是哪一種 CPU，兩種都做。
- `permissions: packages: write`（只有這個 job），用 `GITHUB_TOKEN`，不新增任何 secret。
- 映像加 `org.opencontainers.image.source` 標籤，讓套件連到這個 repo。

### 2.2 NAS：用映像跑（`docker-compose.release.yml`）

新的疊加檔：`api` 與 `caddy` 用 `image: ghcr.io/kennywang1001/nutrition-tracker-{api,web}:${APP_VERSION:?}`。
跟 `docker-compose.yml`＋`docker-compose.prod.yml` 一起用；`--no-build` 保證不會在 NAS 上 build。
倉庫是公開的：套件設成公開後 NAS **不需要任何權杖**（第一次設定時在 GitHub 把套件設成 Public；
或保持私人、在 NAS 上 `docker login ghcr.io` 用只有 `read:packages` 的權杖——部署手冊兩種都寫）。

### 2.3 `scripts/deploy.sh`

```
./scripts/deploy.sh            # git pull --ff-only，部署 HEAD 那個 commit 的映像
./scripts/deploy.sh <sha>      # 部署指定 commit 的映像（退版用；不動 git）
```

步驟（任何一步失敗就停，**舊版照常運作**，除了第 6 步會自動退回）：

1. 決定版本（`git pull --ff-only` 後的 `HEAD`，或參數）；檢查 `.env.production` 存在。
2. `docker compose pull api caddy`（指定版本）。映像不存在 → 「CI 還沒做好這個版本的映像（或測試沒過）」並停止。
3. 記下**目前正在跑**的兩個映像，各打一個本機標籤 `…:rollback`。
4. 備份資料庫（`scripts/backup.sh`）。
5. 用**新映像**跑 migration：`docker compose run --rm --no-deps api python -m alembic upgrade head`
   （`db` 已經在跑）。失敗 → 停止；資料庫沒動（migration 本身是交易，`0015` 的「有重複就失敗」在這裡擋下）。
6. `up -d --no-build`，等 `api` 與 `caddy` 都 healthy（最多 120 秒）。等不到 → 用 `…:rollback` 的映像再 `up -d`，
   印出「已退回上一版」並以非零結束。
7. 印出目前的版本（寫進 `deployed-version` 檔，退版時看得到上一版是哪個 SHA）。

**退版不會倒回 migration**：新版的 migration 已經套用，舊程式要能跟新的資料表一起跑——本專案的
migration 都是加法（加欄位、加表、加索引），舊程式不會碰到它們。腳本與部署手冊明寫這一點。

`COMPOSE_PROJECT_NAME`、檔案路徑可用環境變數覆寫（讓本機能用另一個專案名稱測，不搶 dev 的容器）。

### 2.4 部署手冊

改寫「更新」那一節：第一次設定（套件設成 Public 或 `docker login`、確認 `.env.production`）、
之後每次 `./scripts/deploy.sh`、退版、Synology 任務排程表「手動執行」的設定。舊的「在 NAS 上 build」留作備案。

## 3. 測試

- `bash -n`／shellcheck（有的話）。
- **本機實測 `deploy.sh`**：用另一個 `COMPOSE_PROJECT_NAME` 與本機 build 好、打上 GHCR 名稱的映像
  （`SKIP_PULL=1` 跳過拉映像），跑過：正常部署 → healthy；把 api 的健康檢查弄壞的版本 → 自動退回；
  migration 失敗 → 停在舊版。測完 `down -v` 清掉。不碰 dev 的 `wallet` 專案。
- CI 的 `publish` job：push 後看 GitHub Actions 真的推出兩個映像（兩種架構）。

## 4. 交付

1. CI `publish` job 2. `docker-compose.release.yml`＋`scripts/deploy.sh`＋本機實測 3. 部署手冊、交接文件
