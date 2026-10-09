# 部署到 Synology NAS

透過 SSH + `docker compose` 部署，經由 Tailscale 存取。

**每一步都附「成功長什麼樣」** —— 出錯時才知道是哪一步斷的，而不是拿到一串
指令卻不知道該期待什麼。

---

## 前提

- NAS 已安裝 **Container Manager**（提供 Docker 與 `docker compose`），而且 **Docker Compose 是 v2.20 以上**：

  ```bash
  sudo docker compose version
  ```

  預期輸出像 `Docker Compose version v2.20.x`（或更新）。`scripts/deploy.sh` 一開始也會印出這一行，
  低於 v2.20 就停下來、什麼都不動——到套件中心更新 Container Manager。
  （v2.20.3 實測過 `deploy.sh` 用到的每個子指令與參數都有；更舊的版本沒有驗過。）

  > `docker-compose.prod.yml` 的 `ports: !reset []` 已經在 production 跑過，但那**不代表**
  > NAS 的 Compose 認得 `!reset`：實測 v2.15.1、v2.17.3 會**安靜地忽略** `!reset`（不報錯），v2.18.1 起才有作用。
  > 那一行在舊版上只是剛好無害（共用的 `docker-compose.yml` 本來就沒有 api 的 ports）。
  > 所以 `docker-compose.release.yml` 不用 `!reset`，「不在 NAS 上 build」改靠 `deploy.sh` 的 `--no-build`。
- NAS 已開啟 **SSH**（控制台 → 終端機和 SNMP → 啟動 SSH 功能）
- NAS 已加入你的 **tailnet**（Synology 有 Tailscale 套件）
- 手機也在同一個 tailnet 裡

> **Synology 上 docker 要 root。** 一般使用者沒有 docker 的權限，所以這份手冊裡**每一個**
> `docker`／`docker compose` 指令都寫成 `sudo docker …`，會呼叫 docker 的腳本也是
> `sudo ./scripts/deploy.sh`、`sudo bash scripts/backup.sh`；排程的任務一律用 **root** 跑
> （「三、備份與還原」的排程）。不想每次打 `sudo` 可以先 `sudo -i` 切成 root，但之後 `cd` 要用絕對路徑。

---

## 一、首次部署

### 1. SSH 進 NAS

```bash
ssh your-user@your-nas
```

### 2. 取得原始碼

```bash
mkdir -p ~/apps && cd ~/apps
git clone https://github.com/kennywang1001/nutrition-tracker.git
cd nutrition-tracker
```

### 3. 查出 NAS 的 Tailscale 位址

```bash
tailscale ip -4
```

預期輸出是一個 `100.x.y.z` 的位址。**記下來**，下一步要用。

> 找不到 `tailscale` 指令的話，Synology 的套件把它裝在
> `/var/packages/Tailscale/target/bin/tailscale`，可以用完整路徑，
> 或從 Tailscale 的管理後台看這台機器的位址。

### 4. 產生密鑰並填設定

```bash
cp .env.production.example .env.production
openssl rand -hex 32
```

把產生的 64 字元十六進位字串填進 `.env.production` 的 `JWT_SECRET`：

```
JWT_SECRET=<剛才產生的 64 字元>
BIND_ADDR=127.0.0.1
```

> **`BIND_ADDR` 現在是死設定**（2026-09-26 實測發現）。改走 Task 1 路線 A
> 之後，`docker-compose.prod.yml` 裡 caddy 綁的是寫死的 `127.0.0.1:8080:8080`、
> api 的 ports 是 `!reset []`，**沒有任何地方真的讀 `BIND_ADDR`** ——
> 它只剩下註解裡的兩處提及。`.env.production.example` 還列著它，是漂移。
>
> 填什麼都不影響，填 `127.0.0.1` 是為了讓它至少不誤導（對外入口是
> `tailscale serve`，不是任何一個綁在 tailnet 位址上的埠）。

`.env.production.example` 還有五個選配的 AI 變數（AI 營養素估算）。
**全部留白也沒關係**：`AI_PROVIDER` 沒填，AI 功能就整個關閉（估算端點回
`503 AI_NOT_CONFIGURED`，畫面上說「AI 分析未設定」），其他功能完全不受影響。
「沒有 AI」不是安全性問題，只是少一個功能——不該讓整個 app 因此起不來。

要打開 AI：

| 變數 | 填什麼 |
|---|---|
| `AI_PROVIDER` | `anthropic` 或 `gemini`（小寫）。**填了別的值，api 容器會啟動失敗**——打錯字要大聲說出來 |
| `AI_MODEL` | 那一家的模型名稱。**沒有預設值**：從供應商的文件確認目前可用的名稱再填（Anthropic：https://docs.anthropic.com/en/docs/about-claude/models、Gemini：https://ai.google.dev/gemini-api/docs/models） |
| `ANTHROPIC_API_KEY` | 選 `anthropic` 時必填 |
| `GEMINI_API_KEY` | 選 `gemini` 時必填 |
| `AI_DAILY_LIMIT` | 每人每天最多呼叫幾次 AI。**留白＝20**。要填就填大於 0 的整數；填 0、負數或不是數字，api 容器會啟動失敗 |

選了一家卻沒填它的金鑰或 `AI_MODEL`：端點回 503，訊息會說缺哪一個
（例如「AI 分析未設定：缺 GEMINI_API_KEY」）。前四個變數由
`docker-compose.yml` 用 `${VAR:-}` 傳進 api 容器（空字串＝沒設）；`AI_DAILY_LIMIT` 用的是
`${AI_DAILY_LIMIT:-20}`——它是整數，空字串會讓 app 起不來，所以預設值寫在 compose 裡
（沒設、留白都是 20）。

**換供應商**：改 `AI_PROVIDER` 與 `AI_MODEL`（以及那一家的金鑰），然後用同一個版本
重新部署一次（不是 `restart`，見「二、更新」的「改了 `.env.production` 之後」）。
每日上限（每人每天 20 次）兩家共用、照樣算；記一餐一次估一餐（不管估出幾樣）算一次，
跟新增食物、加一項的單樣估算共用同一個上限。**要調這個數字**：在 `.env.production` 填
`AI_DAILY_LIMIT`（上表），然後重新部署一次（不是 `restart`，同上）。調高等於每個人每天能花的錢變多；
調低時今天已經用超過新上限的人，今天就不能再用了（上限是每次請求當下數 `ai_analyses` 今天的列數）。
畫面上的「今天用了 N/20 次」「今天還能用 N 次」用的是後端當下的上限，不用另外改前端。

**打開之後怎麼確認**：在記一餐打一個食物庫沒有的東西，按「用 AI 估算」——
看到「AI 估算結果」的勾選清單就是通的；看到「AI 分析未設定」就照訊息補設定。金鑰或 `AI_MODEL`
填錯時，供應商會拒絕，端點回 `503 AI_MISCONFIGURED`（「AI 設定有問題（金鑰或模型），
請管理員檢查」），api 容器的 log 有一行「AI 供應商拒絕了設定」帶著供應商的原話；
**這種失敗不算在當天的次數裡**。供應商那邊暫時出問題（連不上、逾時、5xx、限流）
回 `502 AI_UPSTREAM_ERROR`（「AI 服務暫時無法使用，請稍後再試」），**這種照樣算一次**
——請求可能已經計費。畫面上（AI 估算面板）顯示的就是這兩句後端的訊息，
不是通用的「AI 估算失敗，請再試一次」——看到「請管理員檢查」就去看 log、改設定，
看到「請稍後再試」就是供應商那邊的事。

> **不要**把這個檔案改名成 `.env` —— 那個名字是本機開發用的，
> 而且 `docker compose` 只會自動讀 `.env`，兩者混在一起遲早出事。
> 它也已經在 `.gitignore` 裡，不會被提交。

**先確認設定解析得出來，再啟動：**

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo OK
```

預期輸出：`OK`

漏填任何一個必填變數的話，這一步會**指名是哪一個**：

```
error while interpolating services.api.environment.JWT_SECRET:
required variable JWT_SECRET is missing a value: JWT_SECRET is required in
production. Generate one with: openssl rand -hex 32
```

### 5. 啟動（第一次部署）

映像由 CI 做好放在 GHCR，NAS 不 build。先照「二、更新」的
**第一次設定**讓 NAS 拉得到映像（套件設成 Public，或 `docker login ghcr.io`），然後：

```bash
sudo ./scripts/deploy.sh
```

第一次部署時資料庫還不存在（沒有資料庫容器、也沒有資料 volume）：腳本會跳過備份、先起資料庫、
跑完所有 migration，再起 api 與 caddy、等兩個都 `healthy`。最後一行是 `✓ 部署完成：<commit SHA>`。

> 拉不到映像（`denied`／`manifest unknown`）：套件還是私人的、或 CI 還沒做好
> 這個 commit 的映像（GitHub → Actions，看那個 commit 的 `publish` job）。

### 6. 確認容器都健康

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml ps
```

預期輸出（**`healthy` 是重點**，不是 `Up`）：

```
NAME                       SERVICE   STATUS
nutrition-tracker-api-1    api       Up 30 seconds (healthy)
nutrition-tracker-caddy-1  caddy     Up 20 seconds (healthy)
nutrition-tracker-db-1     db        Up 40 seconds (healthy)
```

> **`Up` 不代表活著。** 這個專案實際踩過兩次：uvicorn 的 reloader 父行程
> 在子行程 import 失敗時仍然活著，`docker ps` 顯示 `Up 4 days`
> 而 API 已經死了四天。healthcheck 就是為此存在的 —— 看 `(healthy)`，不要看 `Up`。
> `deploy.sh` 自己也是等到兩個都 `(healthy)` 才算部署成功。
>
> 變成 `(unhealthy)` 的話直接看 log：
> `sudo docker compose ... logs api --tail 50`

### 7. 確認資料庫 migration

`deploy.sh` 已經跑過 `alembic upgrade head`。確認：

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m alembic current
```

預期輸出包含 `(head)`。

### 8. 建立管理員帳號

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli create-admin you@example.com '你的密碼' '你的名字'
```

預期輸出：`管理員帳號已建立：you@example.com (id=1)`

> 如果輸出是「既有帳號已提升為管理員，**密碼已重設**（所有裝置已登出、未使用的重設連結已撤銷）」，
> 代表那個 email 已經存在 —— 打錯 email 會重設別人的密碼、把他所有裝置登出，所以看到這行要停下來確認。

#### 建立一般使用者帳號

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli create-user you@example.com '密碼' '名字'
```

預期輸出：`一般使用者帳號已建立：you@example.com (id=2)`；email 已存在時是
「既有帳號的密碼已重設（所有裝置已登出、未使用的重設連結已撤銷）」。

> **對既有帳號就是重設密碼**，跟「所有帳號」的重設連結做一樣的事：那個人的所有裝置都會登出
> （已經發出去的 access token 最多還能用 15 分鐘），管理員之前替他產生、還沒用的重設連結也一起失效。
> `create-admin` 對既有帳號相同。

> **跟 `create-admin` 刻意不對稱：** `create-admin` 對既有 email 是「提升」
> （拿掉管理員身分需要另外處理），`create-user` 對既有的管理員帳號是**拒絕，
> 而且什麼都不改**（會印錯誤並以非零狀態碼結束）。打錯一個 email 讓管理員被
> 這個指令默默降級，不會有任何畫面顯示出來，要到下一次登入發現進不去審核
> 佇列才知道——提升是可逆的（再跑一次 `create-admin`），不知情的降級不是。
> 真的要把一個管理員降成一般使用者，請直接改資料庫，那至少是一個你知道
> 自己在做的動作。

#### 朋友忘記密碼：不用再 SSH

用管理員帳號登入 →「我的」→「所有帳號」→ 那個人的「產生重設密碼連結」，把連結傳給他。
連結**只顯示這一次**、24 小時內有效、只能用一次；再產生一次，舊的就不能用了。他打開連結設好新密碼之後，
他的所有裝置都會登出（已經發出去的 access token 最多還能用 15 分鐘），再用新密碼自己登入。

- `create-user` 留著當備案（對既有 email 是重設密碼）。
- **管理員帳號不能用重設連結**（「所有帳號」裡管理員那一列寫「用命令列重設」）：
  - 記得自己的密碼 →「我的」→「修改密碼」（其他裝置全部登出，這台繼續用）。
  - 忘記了 → 仍然走上面的 `create-admin`（對既有 email 會重設密碼）。
- 每次產生連結、用連結重設、改密碼，API 的 log 都有一行稽核紀錄（只有使用者 id，沒有連結、密碼、email）：

  ```bash
  sudo docker compose --env-file .env.production \
    -f docker-compose.yml -f docker-compose.prod.yml \
    logs api | grep -E "修改了密碼|產生了使用者|用重設連結"
  ```

### 9. 開對外入口（Task 1 路線 A）

api 與 caddy 都只綁 loopback，所以到這裡為止**從 NAS 以外連不到任何東西**
—— 那是刻意的。對外的唯一入口是 `tailscale serve`：

```bash
tailscale serve --bg --https 443 http://127.0.0.1:8080
tailscale serve status
```

**前置條件（2026-09-26 實測踩過，兩個都要）：**

1. **這個使用者要是 tailscale operator**，否則 `serve` 與 `cert` 都會回
   `Access denied`。一次性設定：
   `sudo tailscale set --operator=$USER`
   （用 `set` 不要用 `up --operator=` —— `set` 只改指定那一項，
   `up` 會重新套用整組設定。）
2. **tailnet 要啟用 HTTPS 憑證**：https://login.tailscale.com/admin/dns
   的 **HTTPS Certificates** → Enable。**預設是關的**，沒開的話
   `tailscale cert` 會回 `500: tailnet does not have HTTPS enabled`。
   啟用會把機器名稱寫進公開的憑證透明度日誌 —— 洩漏的是「存在這個名稱」，
   不是存取權（機器仍然只在 tailnet 內）。

### 10. 從手機確認

手機（在 tailnet 裡）開 `https://<機器名>.<tailnet>.ts.net`。

**而且要在瀏覽器 console 跑這一行：**

```js
console.log(window.isSecureContext, !!navigator.serviceWorker, !!navigator.locks)
```

預期 `true true true`。

> **這一步不能用本機的結果代替。** `localhost` 與 `127.0.0.1` **永遠**是
> secure context，所以在 NAS 上或開發機上怎麼測都會是 `true` ——
> 證明不了手機上的情況。沒有在真機上看到這三個 `true`，
> PWA（service worker、離線快取、加到主畫面）就是裝不起來的。

---

## 二、更新

**NAS 不再 build 映像。** master 上每個 commit 的測試全過之後，CI（`.github/workflows/ci.yml`
的 `publish` job）把兩個映像推到 GHCR，標籤是 commit 的完整 SHA（另外還有 `latest`）：

- `ghcr.io/kennywang1001/nutrition-tracker-api:<sha>`
- `ghcr.io/kennywang1001/nutrition-tracker-web:<sha>`（Caddy＋前端）

amd64 與 arm64 都有，NAS 是哪一種 CPU 都能跑。NAS 上由 `scripts/deploy.sh` 拉映像、部署。
規格：`docs/superpowers/specs/2026-10-08-image-deploy-design.md`。

### 第一次設定

只做一次。

1. **讓 NAS 拉得到映像**——擇一：
   - **套件設成 Public**（建議，NAS 上不用任何權杖）：GitHub → 自己的頁面 → **Packages** →
     `nutrition-tracker-api` → **Package settings** → 最下面 **Danger Zone** → **Change visibility** → Public。
     `nutrition-tracker-web` 再做一次。（套件要等 CI 第一次推過才會出現。）
   - **保持私人**：GitHub → Settings → Developer settings → Personal access tokens (classic)
     → 新增一個**只勾 `read:packages`** 的權杖，然後在 NAS 上：

     ```bash
     sudo docker login ghcr.io -u kennywang1001
     # Password 貼上權杖
     ```

     要用 `sudo` 登入：`deploy.sh` 以 root 跑 docker，登入資訊存在 root 那邊。
2. **確認 `.env.production`** 存在而且解析得出來（「一、首次部署」第 4 步最後那個 `config` 指令印 `OK`）。
   `deploy.sh` 一開始也會檢查，漏填會指名是哪一個變數。
3. **`scripts/deploy.sh` 要可執行**：`ls -l scripts/deploy.sh` 看得到 `x`。沒有的話 `chmod +x scripts/deploy.sh`
   （git 已經把它記成可執行，正常 clone／pull 下來就是）。

> **為什麼用 `sudo`：** Synology 上一般使用者沒有 docker 的權限，所以整支腳本用 root 跑
> （`scripts/backup.sh` 也在裡面一起跑）。腳本裡的 `git` 會自動以 **repo 的擁有者**身分執行——
> root 跑 git 會被「dubious ownership」擋下，就算沒擋，`git pull` 也會在 `.git` 裡留下
> root 的檔案，之後你自己的 `git` 就寫不進去了。

> **從「在 NAS 上 build」換過來的那一次**不用特別處理：腳本會把目前在跑的（NAS 上 build 的）
> 映像標成 `:rollback`，新版起不來就退回它。`deployed-version` 那時還不存在，所以「上一版」
> 會顯示 `unknown`。

### 每次部署

先在 GitHub → Actions 確認那個 master commit 的 `publish` job 是綠的，然後：

```bash
cd ~/apps/nutrition-tracker
sudo ./scripts/deploy.sh
```

腳本做的事（任何一步失敗就停，**舊版照常運作**，只有第 6 步會自動退回）：

| 步驟 | 做什麼 | 失敗時 |
|---|---|---|
| 開始前 | 拿部署鎖；印出並檢查 `docker compose version`（v2.20 以上）；檢查 `.env.production` 存在；檢查這個 compose 專案裡沒有開發環境的容器 | 停，什麼都沒動 |
| 1 | `git pull --ff-only`，版本＝`HEAD` 的 SHA | 停，什麼都沒動 |
| 2 | 拉那個 SHA 的兩個映像 | 「CI 還沒做好這個版本的映像（或測試沒過）」，停 |
| 3 | 把目前的 api、caddy 映像標成本機的 `:rollback`（在跑的容器；沒在跑就用停著的容器） | 停 |
| 4 | 備份資料庫（`scripts/backup.sh`，到 `backups/`）。資料庫停著就先起來再備份；只有「沒有資料庫容器、也沒有資料 volume」才跳過 | 停 |
| 5 | 用**新映像**跑 `alembic upgrade head`；會跨過不能退版的 migration（目前是 `0012`）時印警告、照樣繼續 | 停，還沒切換；整次 upgrade 是一個交易，資料庫沒動 |
| 6 | `up -d --no-build`，等 `api` 與 `caddy` 都 `healthy`（最多 120 秒） | **自動換回 `:rollback`**、印「已退回上一版」、以非零結束 |
| 7 | 把版本寫進 `deployed-version` | — |

> **同一時間只能有一個部署。** 第二個會馬上結束：「另一個部署正在跑」，什麼都不動。
> 鎖是 `flock`（`.deploy.lock`），腳本結束（含被 kill）就自動放掉。沒有 `flock` 的機器
> 改用 `.deploy.lock.d` 資料夾，只有被 `kill -9` 時會留下來——訊息會說怎麼清。

> **第 3 步只有一邊有容器時**（例如 caddy 的容器被刪掉了）：有容器的那一邊照樣標成 `:rollback`，
> 但這次失敗**不會自動退回**——另一邊沒有上一版的映像。腳本會明白說出是哪一邊。

成功時最後幾行長這樣：

```
== [7/7] 紀錄版本
version=<這次的 SHA>
previous=<上一版的 SHA>
deployed_at=2026-10-08T02:31:51Z

✓ 部署完成：<這次的 SHA>（要退回上一版：sudo ./scripts/deploy.sh <上一版的 SHA>）
```

可以覆寫的環境變數（`sudo VAR=值 ./scripts/deploy.sh`）：`HEALTH_TIMEOUT`（秒，正整數，預設 120）、
`ENV_FILE`（預設 `.env.production`）、`COMPOSE_PROJECT_NAME`（預設是目錄名稱）。

> **`0015`（一餐最多一筆餐費）不用再手動先查。** 有重複的餐費時 migration 會失敗，
> 腳本停在第 5 步、舊版照常運作，訊息會列出是哪幾餐。想先看一眼也可以（選配）：
>
> ```bash
> sudo docker compose --env-file .env.production \
>   -f docker-compose.yml -f docker-compose.prod.yml \
>   exec -T db psql -U wallet -d wallet -c \
>   "SELECT meal_id, count(*) FROM expenses WHERE meal_id IS NOT NULL GROUP BY meal_id HAVING count(*) > 1;"
> ```
>
> 顯示 `(0 rows)` 就沒事。有結果的話先到報表刪掉那幾餐多的那筆（不會自動刪錢的紀錄），再重跑 `deploy.sh`。

> **改了 `.env.production`（換 AI 供應商、換 `JWT_SECRET`）之後**，用同一個版本重新部署一次，
> 容器才會帶著新的值重建：
>
> ```bash
> sudo ./scripts/deploy.sh "$(sed -n 's/^version=//p' deployed-version)"
> ```
>
> **`docker compose restart` 不夠**——它只重啟現有容器，不會重新讀設定。這個專案在開發期間踩過：
> 改了環境變數之後 `restart`，容器仍然帶著舊的值進入崩潰迴圈。

> **舊映像會一直留在 NAS 上**（每次部署多兩個）。偶爾清一下：`sudo docker image prune -a`
> 會刪掉所有沒有容器在用的映像——包括 `:rollback`，所以確定這一版沒問題之後再清。
> 之後要退版也沒關係，`deploy.sh <sha>` 會從 GHCR 再拉一次。

### 退版

**自動：** 新版起不來（第 6 步等不到 `healthy`）時，腳本自己換回部署前在跑的映像，不用做任何事。

**手動**（新版起得來、但用了才發現有問題）：

```bash
cat deployed-version                     # previous= 那一行就是上一版
sudo ./scripts/deploy.sh <上一版的 SHA>   # 給 SHA 時不動 git，只換映像
```

> **退版不會倒回 migration。** 新版的 migration 已經套用，舊程式跟新的資料表一起跑。資料庫比要部署的
> 版本新時（舊映像不認得資料庫目前的 migration），腳本會說「這是退到舊版，跳過 migration」，不會失敗。
>
> 所以**退得回去的條件是：新版套用的 migration 不會讓舊程式壞掉**。
>
> - **安全**：加「可為 null 或有預設值（server default）」的欄位、加表、加索引——舊程式不知道它們，
>   INSERT 時不給值也沒關係。例：`0014`（`meals.is_private` 有預設值 false）、`0011`、`0013`（新的表）。
> - **不安全**：加 NOT NULL 又沒有 server default 的欄位、刪欄位、改名。
>   例：**`0012`**——`users.friend_code` 是 NOT NULL、沒有預設值，`0012` 之前的程式建立使用者
>   （註冊、`create-admin`、`create-user`）會失敗。退到 `0012` 之前的版本，app 起得來、登入照常，
>   但**沒辦法建立新帳號**。
> - 介於中間：`0015`（一餐最多一筆餐費的唯一索引）收緊了限制——舊程式替同一餐記第二筆餐費時會出錯，
>   而不是安靜地多一筆。那本來就是要擋的情況，可以接受。
>
> 腳本在第 5 步會比對「這次要套用的 migration」與 `deploy.sh` 裡的 `ROLLBACK_UNSAFE_REVISIONS`
> （目前是 `0012`），會跨過時印「⚠️ 跨過 0012：如果新版起不來被自動退回，舊版無法建立新帳號（好友碼欄位）。」
> ——**照樣繼續**（腳本要能無人值守地跑），自動退回時也會再提醒一次。真的需要退到那之前，
> 只能還原備份（第 4 步剛做的那份，見「三、備份與還原」），會失去部署之後寫入的資料。
> 以後新增這類 migration，記得把它的 revision 加進 `ROLLBACK_UNSAFE_REVISIONS`。

> **退版之後 git 還停在新的 commit 上。** 下一次不帶參數的 `sudo ./scripts/deploy.sh` 會 `git pull`
> 然後部署 `HEAD`——如果 master 上還是那個有問題的 commit，就會再部署它一次。
> 先在 master 上修好（或 revert）、等 CI 做好新映像，再不帶參數部署。

> 給 SHA 部署時，用的是**目前 checkout 的** compose 檔（不是那個 commit 的）。兩者之間 compose 檔
> 有改過的話，要先 `git checkout` 到相符的版本。

### 在 Synology 任務排程表按一下就部署

不想 SSH 進去的話，可以在 DSM 設一個「手動執行」的任務：

1. **控制台 → 任務排程表 → 新增 → 排定的任務 → 使用者定義的指令碼**
2. **一般**：任務名稱 `部署 nutrition-tracker`；使用者選 **root**（docker 要 root；腳本裡的 git
   會自動以 repo 擁有者身分跑）；**取消勾選「已啟用」**——這個任務只手動執行，不要定時跑。
3. **排程**：隨便設（停用的任務不會照排程跑）。
4. **任務設定**：
   - 勾「**透過電子郵件傳送執行詳細資訊**」→「**只在指令碼異常終止時傳送**」（可選；退版、migration 失敗都是非零結束）
   - 使用者定義的指令碼（`YOUR_USER` 換成自己的帳號）：

     ```bash
     cd /var/services/homes/YOUR_USER/apps/nutrition-tracker && mkdir -p backups && bash scripts/deploy.sh >> backups/deploy.log 2>&1
     ```

要部署時：在任務排程表選這個任務 →「**執行**」。跑完看 `backups/deploy.log` 的最後幾行
（或「動作 → 檢視結果」）。退到指定版本這種一次性的事還是用 SSH。

> 任務排程表給的 `PATH` 可能沒有 `/usr/local/bin`（Container Manager 的 `docker` 在那裡）。
> `deploy.sh` 自己會補上，所以這個任務不用另外設；直接呼叫 `docker` 的任務（「三、備份與還原」的排程、
> 「四、清理孤兒照片」）要自己在指令最前面加 `export PATH="$PATH:/usr/local/bin";`。

### 備案：在 NAS 上 build（舊的做法）

GHCR 或 CI 出問題、又急著上線時，還是可以用原始碼在 NAS 上 build（慢；沒有自動退版，
`deployed-version` 也不會更新）：

```bash
cd ~/apps/nutrition-tracker
git pull
sudo bash scripts/backup.sh
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m alembic upgrade head
```

> 這條路**不帶** `-f docker-compose.release.yml`——那個檔案把 `image` 換成 GHCR 的名字、而且要 `APP_VERSION`；
> 帶著它 build 會做出一個掛著 GHCR 名字、其實是 NAS 上原始碼的映像，之後分不清楚。
> 改依賴、加 migration 都要重新 build（`Dockerfile` 是 `COPY . .`，migration 是烤進映像的）。
> CI 恢復之後，下一次照常 `sudo ./scripts/deploy.sh` 就回到正常的路（這次 build 的映像會被標成 `:rollback`）。

### 各版本的升級備註

`deploy.sh` 會跑所有還沒套用的 migration，下面這些不用再各自手動跑 `alembic`。

> **第一次改用映像部署時，可能一次跨過 `0011`～`0015`**（看 NAS 目前在哪個 migration：
> `sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml exec -T db psql -U wallet -d wallet -tAc "SELECT version_num FROM alembic_version"`）。
> 跨過 `0012` 時腳本會印退版警告（見「退版」）：這次如果新版起不來、被自動退回到 NAS 上原本那一版，
> 舊版**無法建立新帳號**——修好新版再部署一次就好，不用還原。`0015` 有重複餐費時會停在第 5 步。

- **`0017_add_meals_description`（AI 多樣估算與餐點描述）**：只加一個可以是空的欄位（`meals.description`），
  `deploy.sh` 會自己跑，**可以退版**（舊版程式不讀也不寫這一欄，不在 `ROLLBACK_UNSAFE_REVISIONS` 裡——那個清單仍然只有
  `0012`，`scripts/deploy.sh` 這一版沒有改；退版期間新寫的描述留在資料庫，舊畫面看不到）。**沒有新的環境變數**：
  多樣估算用的是既有的 `AI_PROVIDER`／`AI_MODEL`／金鑰，每日上限（每人 20 次）跟單樣估算共用、一次估一餐算一次。要調每日上限在
  `.env.production` 填 `AI_DAILY_LIMIT`（compose 這一版開始會把它傳進容器，留白是 20，見「一、首次部署」的變數表）。
  單次呼叫的輸出上限從 1024 提到 8192 token（只有記一餐的多樣估算；多出來的是留給會把思考算進上限的模型）——
  **成本上界約是原本單樣估算的 8 倍**，實際多半遠低於此（答案本身只有 600～800 token，計費看實際輸出）。
  AI 沒設定的話這一版照樣可以部署：記一餐的「描述（選填）」可以自己打，按估算照舊是「AI 分析未設定」。

  **部署完請用有 AI 的帳號在記一餐拍一張有兩三樣菜的照片**：這條路（兩家供應商對巢狀 schema 的實際反應、
  模型照不照提示詞把一餐拆開）**沒有任何自動測試打過真的 API，開發時也沒有手動打過**——開發環境沒有金鑰。
  拍完看三件事：清單有沒有出來、樣數合不合理、
  `sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml logs api | grep -E "AI 供應商|AI 回覆"`
  有沒有新的錯誤。三種要認得的失敗：
  - 畫面是「AI 服務暫時無法使用，請稍後再試」而且**每次都是**、log 有「AI 供應商暫時無法使用」：看那一行後面供應商的
    原話——供應商不收這份 schema（多樣的 schema 是巢狀的，單樣的不是）多半也落在這裡，那不是「稍後再試」會好的事。
    （供應商的訊息裡剛好有 `model` 這個字的 400 會被當成設定錯誤：「AI 設定有問題（金鑰或模型）」、log 是
    「AI 供應商拒絕了設定」、不算額度。單樣估算是好的而只有多樣這樣，就不是金鑰或模型名稱的問題。）
  - 畫面是「AI 這次的回答看不懂，可以再試一次」（`AI_BAD_RESPONSE`）而且**每次都是**：先看 log 有沒有
    「AI 回覆不是正常結束（…）」那一行。有，而且原因是 `stop_reason=max_tokens`（Anthropic）或 `finish_reason=MAX_TOKENS`
    （Gemini）：模型把思考算進了輸出上限、8192 token 之內寫不完——同一行有用掉的 token 數（Gemini 的 `thoughts_tokens`
    就是思考用掉的）。換一個模型，或改 `app/ai/estimator.py` 的 `MAX_MEAL_OUTPUT_TOKENS`（交接文件 §8.2 多樣估算的
    第 3 點）。原因是 `refusal`、`SAFETY`、或 `block_reason` 有值：供應商不回答這張照片，換一張。**那一行只有原因與
    用量，沒有照片、提示詞或模型的輸出。** 沒有那一行：模型正常結束但內容驗證不過（超過 8 樣、某一樣超出範圍、
    不是 JSON）——找「AI 的回覆沒有通過檢查」那一行，它列出是哪幾個欄位、哪一種錯（只有位置與種類，沒有內容）；
    `ai_analyses` 多一列失敗。
  - 畫面是「AI 看不出這一餐有什麼食物，換一張照片或換個說法再試（這一次也算在今天的次數裡）」（`AI_NO_FOOD_FOUND`）：
    模型回答了「沒有食物」，不是壞掉。一張有食物的照片也這樣、而且每次都是，才是提示詞或模型的問題。

  三種都是每試一次算一次當天的額度。新增食物與編輯這一餐的「加一項」走的是原本的單樣估算，不受影響——
  多樣的壞了可以先用它們。
  另外兩件上線後才看得到的事：「加入這 N 樣」建的私人食物是當場建的，加入之後沒有按「記錄」就離開，那幾個食物會
  留在食物庫（沒有刪除的端點）；描述是**好友看得到**的欄位（備註仍然只有自己），畫面上有寫，第一次用的人可以提醒一下。

- **報表看其他月份與匯出資料**：**沒有 migration、沒有新的環境變數，可以直接退版**（舊版只是沒有 `/api/export/*`
  與月份切換）。`pyproject.toml` 的 `fastapi` 下限改成 `>=0.118`（串流匯出時資料庫 session 要活到回應送完），
  lock 檔本來就是 0.141.1，映像裡的套件沒有變。匯出的限速（每人每分鐘 6 次）在記憶體裡，重啟歸零。
  部署完可以用自己的帳號在「我的」→「匯出資料」按一次確認；**iPhone 從主畫面打開的那個模式還沒有實機驗證過**
  （交接文件第 10 節「報表看其他月份與匯出資料」已知限制第 16 點）。

- **`0016_create_password_reset_tokens`（帳號與目標設定）**：只加一張表，`deploy.sh` 會自己跑，**可以退版**
  （舊版程式不讀這張表，不在 `ROLLBACK_UNSAFE_REVISIONS` 裡）。這一版之後朋友忘記密碼用「所有帳號」的重設密碼連結，
  不用 SSH 跑 `create-user`（見「8. 建立管理員帳號」底下的「朋友忘記密碼」）；每個人可以在「我的」自己設每日目標、改名稱、改密碼。

- **`0015`（一餐最多一筆餐費）**：有重複的餐費時 migration 會失敗、部署停住——見上面「每次部署」的備註。
- **`0012`～`0014`（好友關係）**：`0012` 會替既有使用者補好友碼。
- **`0011_create_invites`（邀請連結）**：這一版之後**註冊一定要有邀請**：用管理員帳號登入，
  「我的」→「邀請朋友」產生連結傳給朋友。你的帳號必須是管理員（`create-admin`）。
- **AI 估算的前端**：多了 Python 套件 `google-genai`（已經在映像裡）；要打開 AI，先照
  「4. 產生密鑰並填設定」在 `.env.production` 填好 AI 變數再部署。

---

## 三、備份與還原

### 備份

```bash
cd ~/apps/nutrition-tracker
sudo bash scripts/backup.sh
```

預期輸出是一個 `backups/wallet-YYYYmmdd-HHMMSS.dump` 檔案路徑。
預設保留最新 7 份，可用 `BACKUP_KEEP_COUNT` 覆寫。

**照片不在備份範圍內** —— 它們是 Docker volume 上的一般檔案，
交給 Synology 的 Hyper Backup 備份 `/volume1/@docker/volumes/` 即可。
（這正是規格第 8 節選擇檔案系統而非存進資料庫的理由之一。）

> **`backups/` 裡的檔案是 root 的**（備份要 root 才叫得動 docker，`deploy.sh` 的備份也是 root 做的）。
> 權限是一般的 644，自己的帳號讀得到、複製得走；要刪要 `sudo rm`。`backups/` 這個資料夾本身誰建的都行
> （root 寫得進任何人的資料夾）——建議第一次部署前自己先 `mkdir -p backups`，資料夾就是你的。
> 一般帳號跑不了備份（沒有 docker 權限），所以不用為它把檔案 `chown` 回自己。

### 排程

用 **DSM 的任務排程表**、使用者選 **root**——一般帳號的 `crontab` 沒有 docker 權限，排了也會每天失敗
（而且 DSM 會管 `/etc/crontab`，手改的可能被蓋掉）。

**控制台 → 任務排程表 → 新增 → 排定的任務 → 使用者定義的指令碼**：使用者 **root**、
排程每天 03:00，指令碼（`YOUR_USER` 換成自己的帳號）：

```bash
export PATH="$PATH:/usr/local/bin"; cd /var/services/homes/YOUR_USER/apps/nutrition-tracker && bash scripts/backup.sh >> backups/backup.log 2>&1
```

> 路徑要用**絕對路徑**：任務的工作目錄不是 repo。`export PATH` 是因為任務排程表給的 `PATH`
> 可能沒有 `/usr/local/bin`（`docker` 在那裡），沒有它會出現 `docker: command not found`。
> 勾「透過電子郵件傳送執行詳細資訊 → 只在指令碼異常終止時傳送」，備份失敗才會知道。

### 還原

```bash
# 1. 先確認要還原哪一份
ls -lh backups/

# 2. 還原到一個「新的」資料庫先驗證，不要直接蓋掉正在用的
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db psql -U wallet -d postgres -c "CREATE DATABASE wallet_restore_check"

sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db pg_restore --no-owner -U wallet -d wallet_restore_check \
  < backups/wallet-YYYYmmdd-HHMMSS.dump

# 3. 比對筆數
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db psql -U wallet -d wallet_restore_check \
  -c "select count(*) from users; select count(*) from meals;"

# 4. 確認沒問題之後才丟掉檢查用的
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db psql -U wallet -d postgres -c "DROP DATABASE wallet_restore_check"
```

> `--no-owner` 是必要的 —— 少了它，還原到一個由不同角色建立的資料庫時
> 會噴一堆「role does not exist」。
>
> **一份沒有還原過的備份不算備份。** 建議剛部署完就走一次上面的流程，
> 而不是等到真的需要還原的那天才第一次執行它。

---

## 四、清理孤兒照片

**必須在容器內執行。**

```bash
# 先看會刪什麼
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli cleanup-photos --dry-run

# 確認之後才真的刪
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli cleanup-photos
```

> **不要在 host 上跑這個指令。** 照片存在 Docker 的具名 volume 裡，
> host 上的 `data/photos` 是另一個目錄。在 host 跑會回報「0 個孤兒」
> 而真正的 volume 一直累積 —— 開發期間真的發生過這個混淆。
>
> 預設只刪修改時間超過 24 小時的檔案，避免刪到一張剛寫入、
> 資料庫還沒 commit 的照片。

排程（每週日凌晨 4 點）：跟備份一樣用任務排程表、使用者 **root**，指令碼：

```bash
export PATH="$PATH:/usr/local/bin"; cd /var/services/homes/YOUR_USER/apps/nutrition-tracker && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml exec -T api python -m app.cli cleanup-photos >> backups/cleanup.log 2>&1
```

---

## 五、緊急處置：強制登出

**手機掉了、或懷疑 token 外流時。**

### 先試這個：登出該帳號的所有裝置

```bash
# 用該帳號登入拿一張 access token，然後
curl -X POST https://<你的 tailnet 網域>/api/auth/logout-all \
  -H "Authorization: Bearer <access_token>"
```

撤銷該使用者的**所有** refresh session。之後那些裝置再也換不到新票。

**知道自己的密碼的話，更簡單：**「我的」→「修改密碼」。效果包含登出所有其他裝置（手上這台換一組新票繼續用），
而且偷到舊密碼的人也登不進來了。別人的帳號（一般使用者）可以由管理員在「所有帳號」產生重設密碼連結，他設好新密碼時
所有裝置一起登出。

> **語意要講清楚：撤銷不是即時的。** access token 不查資料庫（那是刻意的
> 設計取捨，見規格 §4），所以撤銷之後，已經發出去的 access token
> **最多還能再用 15 分鐘**。要的是「再也換不到新票」，不是「立刻斷線」。
>
> 如果 15 分鐘不能接受，才走下面換密鑰那條。

### 核彈選項：換 `JWT_SECRET`

```bash
openssl rand -hex 32          # 產生新密鑰
# 編輯 .env.production，把 JWT_SECRET 換成新值，然後用同一個版本重新部署（容器帶新值重建）
sudo ./scripts/deploy.sh "$(sed -n 's/^version=//p' deployed-version)"
```

> 不要用 `docker compose -f docker-compose.yml -f docker-compose.prod.yml up -d`：少了
> `docker-compose.release.yml`，compose 會用 NAS 上的原始碼 build 新映像來換掉 CI 的映像。

所有 access token 與 refresh token 立刻失效，**包含所有其他使用者的** ——
每個人都要重新登入。只有在「連 15 分鐘都不能等」時才用。

### 定期清理過期的 session 紀錄

跟清理孤兒照片一樣**必須在容器內執行**：

```bash
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T api python -m app.cli cleanup-sessions --dry-run   # 先看筆數
sudo docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T api python -m app.cli cleanup-sessions
```

建議的排程（每天一次就夠，過期的列不影響任何功能，只是佔空間）：任務排程表、使用者 **root**，指令碼：

```bash
export PATH="$PATH:/usr/local/bin"; cd /var/services/homes/YOUR_USER/apps/nutrition-tracker && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml exec -T api python -m app.cli cleanup-sessions >> backups/cleanup.log 2>&1
```

> **只刪 `expires_at` 已過的列，不刪「已撤銷但還沒過期」的。** 那一列是
> 「這條 family 是什麼時候、因為什麼而死的」唯一的證據 —— 提早刪掉的話，
> 真正的重用攻擊會被降級成一次普通的 401，日誌裡再也看不出有人在重放。

---

## 五之二、升級到含 session 撤銷的版本：所有人要重新登入一次

這個版本的 refresh token 多了一個 `jti` 欄位，並對應到資料庫裡的一列。
**升級前發出的 refresh token 全部沒有 `jti`，會被拒絕。**

後果：升級後所有裝置都要重新登入一次。這是一次性的、刻意的 ——
相容期間等於舊的缺陷還開著，而那段相容邏輯忘記拿掉就是一個永久的後門。

**先知道這件事**，否則它會表現成「升級後神秘的全員登出」，
而那種症狀沒人會聯想到這次變更。

升級後記得跑 migration（`## 二、更新` 的步驟已包含）：`0007_create_refresh_sessions`。

---

## 六、故障排除

### 容器顯示 `Up` 但連不上

```bash
sudo docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml logs api --tail 50
```

最常見的兩個原因：

1. **依賴變了但映像沒重建** —— 症狀是 `ModuleNotFoundError`。
   用 CI 的映像部署（`sudo ./scripts/deploy.sh`）時不會發生；走「在 NAS 上 build」
   備案時要 `up -d --build`，不是 `restart`。
2. **`JWT_SECRET` 沒設或設成被禁的值** —— 症狀是
   `ValidationError: 1 validation error for Settings`。
   密鑰刻意沒有預設值可以退回（fail closed），
   而且會拒絕 `dev-secret-change-me-in-production`
   那個公開字串。

### 手機連不上，但 NAS 上 `curl` 得到

檢查 `BIND_ADDR` 是不是填成 `127.0.0.1` 了 —— 那樣只有 NAS 自己連得到。
應該填 `tailscale ip -4` 查到的 `100.x.y.z`。

### 資料庫抖動導致 API 被重啟

不會。healthcheck 打的是 `/api/health`（liveness，不碰資料庫），
不是 `/api/health/ready`（readiness，會做 `SELECT 1`）。
這是刻意的：資料庫短暫不可用時重啟 API 並不能解決資料庫的問題，
只會在資料庫恢復期間把 API 也一起弄掉。

要人工確認資料庫連得上時再打 readiness：

```bash
curl http://100.x.y.z:8000/api/health/ready
```

---

## 七、上線驗證清單

分成兩類：**已在開發環境自動驗證過**的，與**只有你在 NAS 上做得到**的。

### 已自動驗證（開發環境，463 個測試 + 實際操作）

- [x] 缺少 `JWT_SECRET` 時 `Settings()` 拋 `ValidationError`
- [x] `JWT_SECRET` 設成公開的開發字串時同樣被拒絕
- [x] compose 缺少必填變數時**指名是哪一個**
- [x] production 映像不含 pytest / mypy / ruff（501MB → 354MB）
- [x] production 沒有 `--reload`（改檔案不會重載）
- [x] production **不發佈資料庫埠**（dev 才有 5433）
- [x] healthcheck 打 liveness；故意讓端點回 500 時真的翻成 `(unhealthy)` 再恢復
- [x] readiness 在資料庫不可用時回 503（不是 500）
- [x] 登入限速生效，且對**不存在的帳號行為完全相同**（不會變成帳號列舉神諭）
- [x] Argon2 不再阻塞 event loop，且並發數量有上限
- [x] 備份 → 還原到另一個資料庫 → 11 張表筆數與內容 md5 全部相符

### 只有你做得到（NAS 上）

- [ ] 從一台**不在 tailnet** 的裝置（例如區網上的另一台電腦）連
      `http://<NAS 的區網 IP>:8000/api/health` —— **必須連不上**

      > 這一項沒有替代做法。AI 無法從外部驗證你的網路，
      > 而它正是「Tailscale 是邊界」這個前提唯一的實證。

- [ ] 從 tailnet 上的手機連 `http://100.x.y.z:8000/docs` —— 打得開
- [ ] `sudo docker compose ... ps` 三個容器都是 `(healthy)`
- [ ] **重開 NAS，容器自己回來**（驗證 `restart: unless-stopped`）
- [ ] 用手機真的記一餐、上傳一張照片、查當日統計
- [ ] 把那張照片下載回來，確認 EXIF 是空的
      （開發環境已驗過，這裡是端到端複驗）
- [ ] 跑一次備份，再照第三節的流程還原到檢查用的資料庫，確認筆數相符
