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
  ——**失敗**或取消就不做。
- **push 到 master 時四個測試 job 一律全跑**（`changes` 不看路徑過濾，直接輸出 `true`）：paths-filter 在 push 上
  比的是上一次 push，不是上一個測試全綠的 commit——上一個 commit 測試紅了、下一個只改文件，過濾會把測試全跳過，
  `!failure()` 就會替紅的程式碼做映像。全跑之後純文件的 commit 也照樣測、照樣做映像（每個 master commit 都有
  對應的映像）。PR 與其他分支照常用路徑過濾；過濾清單也涵蓋 `Dockerfile`、`.dockerignore`、`docker-compose*.yml`、
  `scripts/**`（後端）與 `caddy/**`（前端）。
- `publish` 有 `concurrency: publish-master`（`cancel-in-progress: false`）：一次只推一組映像。它只排隊、不按 commit
  先後，所以 `latest` 偶爾可能指向較舊的 commit；`deploy.sh` 一律用 SHA，不看 `latest`。
- workflow 預設 `permissions: contents: read`；`changes` 另外要 `pull-requests: read`（paths-filter 在 PR 上讀 API）。
- 兩個映像推到 GHCR：`ghcr.io/kennywang1001/nutrition-tracker-api` 與 `…-web`（`frontend/Dockerfile`，Caddy＋前端），
  標籤是 **commit 的完整 SHA** 與 `latest`。
- **多架構**（`linux/amd64`、`linux/arm64`，QEMU）：不知道 NAS 是哪一種 CPU，兩種都做。
- `permissions: packages: write`（只有 `publish`），用 `GITHUB_TOKEN`，不新增任何 secret。
- 映像加 `org.opencontainers.image.source` 標籤，讓套件連到這個 repo。

### 2.2 NAS：用映像跑（`docker-compose.release.yml`）

新的疊加檔：`api` 與 `caddy` 用 `image: ghcr.io/kennywang1001/nutrition-tracker-{api,web}:${APP_VERSION:?}`。
跟 `docker-compose.yml`＋`docker-compose.prod.yml` 一起用；`--no-build` 保證不會在 NAS 上 build。
**不用 `build: !reset null`**：Synology 內建的 Compose 可能比較舊，實測 v2.15.1／v2.17.3 會安靜地忽略 `!reset`
（不報錯、build 照樣在），v2.18.1 起才有作用——寫了等於假裝有保護。`build` 留著無害——`deploy.sh` 的 `up`／`run` 都帶 `--no-build`，`pull` 照樣拉有 `image` 的服務。
`deploy.sh` 要求 Compose **v2.20 以上**（開頭印出版本、太舊就停）。
倉庫是公開的：套件設成公開後 NAS **不需要任何權杖**（第一次設定時在 GitHub 把套件設成 Public；
或保持私人、在 NAS 上 `docker login ghcr.io` 用只有 `read:packages` 的權杖——部署手冊兩種都寫）。

### 2.3 `scripts/deploy.sh`

```
./scripts/deploy.sh            # git pull --ff-only，部署 HEAD 那個 commit 的映像
./scripts/deploy.sh <sha>      # 部署指定 commit 的映像（退版用；不動 git）
```

開始之前（什麼都還沒動）：拿部署鎖（`flock`，沒有就用 `mkdir`；第二個部署馬上結束）、印出並檢查
`docker compose version`（≥ v2.20）、檢查這個 compose 專案裡**任何**容器（含停著的）都不是
`docker-compose.override.yml` 起的（開發環境）。

步驟（任何一步失敗就停，**舊版照常運作**，除了第 6 步會自動退回）：

1. 決定版本（`git pull --ff-only` 後的 `HEAD`，或參數）；檢查 `.env.production` 存在。
2. `docker compose pull api caddy`（指定版本）。映像不存在 → 「CI 還沒做好這個版本的映像（或測試沒過）」並停止。
3. 記下目前的兩個映像（在跑的容器；沒在跑就用停著的容器），各打一個本機標籤 `…:rollback`。
   只有一邊有容器時照樣標那一邊，但這次不自動退回（另一邊沒有上一版）。
4. 備份資料庫（`scripts/backup.sh`）。只有「沒有資料庫容器、也沒有 pgdata volume」＝真正的第一次部署才跳過；
   資料庫停著就先 `up -d db`、等 healthy 再備份。備份失敗就停。
5. 用**新映像**跑 migration：`docker compose run --rm --no-deps api python -m alembic upgrade head`
   （`db` 已經在跑）。失敗 → 停止；資料庫沒動（migration 本身是交易，`0015` 的「有重複就失敗」在這裡擋下）。
6. `up -d --no-build`，等 `api` 與 `caddy` 都 healthy（最多 120 秒）。等不到 → 用 `…:rollback` 的映像再 `up -d`，
   印出「已退回上一版」並以非零結束。
7. 印出目前的版本（寫進 `deployed-version` 檔，退版時看得到上一版是哪個 SHA）。

**退版不會倒回 migration**：新版的 migration 已經套用，舊程式要能跟新的資料表一起跑。退得回去的條件是
**新版套用的 migration 不會讓舊程式壞掉**：加可為 null 或有 server default 的欄位、加表、加索引是安全的；
加 NOT NULL 又沒有 server default 的欄位、刪欄位、改名不是。本專案的 **`0012` 不安全**（`users.friend_code`
NOT NULL、沒有 server default，0012 之前的程式建立使用者會失敗）。`deploy.sh` 有一個
`ROLLBACK_UNSAFE_REVISIONS` 清單（目前 `0012`）：第 5 步用新映像算出「資料庫目前的 revision 到 head 之間」
要套用哪些 revision，跨過清單裡的就印警告，**照樣繼續**（要能無人值守地跑），自動退回時再提醒一次。
腳本與部署手冊明寫這一點。

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
