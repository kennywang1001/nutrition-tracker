# 部署到 Synology NAS

透過 SSH + `docker compose` 部署，經由 Tailscale 存取。

**每一步都附「成功長什麼樣」** —— 出錯時才知道是哪一步斷的，而不是拿到一串
指令卻不知道該期待什麼。

---

## 前提

- NAS 已安裝 **Container Manager**（提供 Docker 與 `docker compose`）
- NAS 已開啟 **SSH**（控制台 → 終端機和 SNMP → 啟動 SSH 功能）
- NAS 已加入你的 **tailnet**（Synology 有 Tailscale 套件）
- 手機也在同一個 tailnet 裡

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

把產生的 64 字元十六進位字串填進 `.env.production` 的 `JWT_SECRET`，
把上一步的 `100.x.y.z` 填進 `BIND_ADDR`：

```
JWT_SECRET=<剛才產生的 64 字元>
BIND_ADDR=100.x.y.z
```

> **不要**把這個檔案改名成 `.env` —— 那個名字是本機開發用的，
> 而且 `docker compose` 只會自動讀 `.env`，兩者混在一起遲早出事。
> 它也已經在 `.gitignore` 裡，不會被提交。

**先確認設定解析得出來，再啟動：**

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml config >/dev/null && echo OK
```

預期輸出：`OK`

漏填任何一個必填變數的話，這一步會**指名是哪一個**：

```
error while interpolating services.api.environment.JWT_SECRET:
required variable JWT_SECRET is missing a value: JWT_SECRET is required in
production. Generate one with: openssl rand -hex 32
```

### 5. 啟動

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

第一次會建映像，視 NAS 的效能可能要十幾分鐘。

### 6. 確認兩個容器都健康

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml ps
```

預期輸出（**`healthy` 是重點**，不是 `Up`）：

```
NAME            SERVICE   STATUS
wallet-api-1    api       Up 30 seconds (healthy)
wallet-db-1     db        Up 40 seconds (healthy)
```

> **`Up` 不代表活著。** 這個專案實際踩過兩次：uvicorn 的 reloader 父行程
> 在子行程 import 失敗時仍然活著，`docker ps` 顯示 `Up 4 days`
> 而 API 已經死了四天。healthcheck 就是為此存在的 —— 看 `(healthy)`，不要看 `Up`。
>
> 停在 `(health: starting)` 是正常的，`start_period` 是 10 秒。
> 變成 `(unhealthy)` 的話直接看 log：
> `docker compose ... logs api --tail 50`

### 7. 套用資料庫 migration

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m alembic upgrade head
```

預期輸出是一連串 `Running upgrade 0001 -> 0002, ...` 直到 `0006`。

確認：

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m alembic current
```

預期輸出包含 `0006 (head)`。

### 8. 建立管理員帳號

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli create-admin you@example.com '你的密碼' '你的名字'
```

預期輸出：`管理員帳號已建立：you@example.com (id=1)`

> 如果輸出是「既有帳號已提升為管理員，**密碼已重設**」，代表那個 email
> 已經存在 —— 打錯 email 會靜默重設別人的密碼，所以看到這行要停下來確認。

### 9. 從手機確認

手機（在 tailnet 裡）開 `http://100.x.y.z:8000/docs`，應該看得到 API 文件。

---

## 二、更新

**「只改程式碼」與「改了依賴」是兩件不同的事，混淆會得到最難查的那種故障。**

production 沒有原始碼掛載也沒有 `--reload`，程式碼是 build 進映像的，
所以**兩種情況都要重建映像**：

```bash
cd ~/apps/nutrition-tracker
git pull
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml up -d --build
```

如果這次的更新有 migration：

```bash
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m alembic upgrade head
```

> **`docker compose restart` 不夠。** 它只是重啟現有容器，不會換映像、
> 也不會重新讀 compose 設定。改了環境變數或程式碼一律用 `up -d`。
> 這個專案在開發期間踩過：改了 `docker-compose.yml` 的環境變數之後
> `restart`，容器仍然帶著舊的值進入崩潰迴圈。

---

## 三、備份與還原

### 備份

```bash
cd ~/apps/nutrition-tracker
bash scripts/backup.sh
```

預期輸出是一個 `backups/wallet-YYYYmmdd-HHMMSS.dump` 檔案路徑。
預設保留最新 7 份，可用 `BACKUP_KEEP_COUNT` 覆寫。

**照片不在備份範圍內** —— 它們是 Docker volume 上的一般檔案，
交給 Synology 的 Hyper Backup 備份 `/volume1/@docker/volumes/` 即可。
（這正是規格第 8 節選擇檔案系統而非存進資料庫的理由之一。）

### 排程（cron）

```bash
crontab -e
```

加入（每天凌晨 3 點）：

```
0 3 * * * cd /var/services/homes/YOUR_USER/apps/nutrition-tracker && bash scripts/backup.sh >> backups/backup.log 2>&1
```

> 路徑要用**絕對路徑**。cron 的工作目錄通常是 `$HOME`，不是 repo。

### 還原

```bash
# 1. 先確認要還原哪一份
ls -lh backups/

# 2. 還原到一個「新的」資料庫先驗證，不要直接蓋掉正在用的
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db psql -U wallet -d postgres -c "CREATE DATABASE wallet_restore_check"

docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db pg_restore --no-owner -U wallet -d wallet_restore_check \
  < backups/wallet-YYYYmmdd-HHMMSS.dump

# 3. 比對筆數
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec -T db psql -U wallet -d wallet_restore_check \
  -c "select count(*) from users; select count(*) from meals;"

# 4. 確認沒問題之後才丟掉檢查用的
docker compose --env-file .env.production \
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
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli cleanup-photos --dry-run

# 確認之後才真的刪
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml \
  exec api python -m app.cli cleanup-photos
```

> **不要在 host 上跑這個指令。** 照片存在 Docker 的具名 volume 裡，
> host 上的 `data/photos` 是另一個目錄。在 host 跑會回報「0 個孤兒」
> 而真正的 volume 一直累積 —— 開發期間真的發生過這個混淆。
>
> 預設只刪修改時間超過 24 小時的檔案，避免刪到一張剛寫入、
> 資料庫還沒 commit 的照片。

排程（每週日凌晨 4 點）：

```
0 4 * * 0 cd /var/services/homes/YOUR_USER/apps/nutrition-tracker && docker compose --env-file .env.production -f docker-compose.yml -f docker-compose.prod.yml exec -T api python -m app.cli cleanup-photos >> backups/cleanup.log 2>&1
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

> **語意要講清楚：撤銷不是即時的。** access token 不查資料庫（那是刻意的
> 設計取捨，見規格 §4），所以撤銷之後，已經發出去的 access token
> **最多還能再用 15 分鐘**。要的是「再也換不到新票」，不是「立刻斷線」。
>
> 如果 15 分鐘不能接受，才走下面換密鑰那條。

### 核彈選項：換 `JWT_SECRET`

```bash
openssl rand -hex 32          # 產生新密鑰
# 編輯 .env.production，把 JWT_SECRET 換成新值
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml up -d
```

所有 access token 與 refresh token 立刻失效，**包含所有其他使用者的** ——
每個人都要重新登入。只有在「連 15 分鐘都不能等」時才用。

### 定期清理過期的 session 紀錄

跟清理孤兒照片一樣**必須在容器內執行**：

```bash
docker compose exec -T api python -m app.cli cleanup-sessions --dry-run   # 先看筆數
docker compose exec -T api python -m app.cli cleanup-sessions
```

建議的 cron（每天一次就夠，過期的列不影響任何功能，只是佔空間）：

```
30 4 * * * cd /volume1/docker/nutrition-tracker && docker compose exec -T api python -m app.cli cleanup-sessions
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
docker compose --env-file .env.production \
  -f docker-compose.yml -f docker-compose.prod.yml logs api --tail 50
```

最常見的兩個原因：

1. **依賴變了但映像沒重建** —— 症狀是 `ModuleNotFoundError`。
   用 `up -d --build`，不是 `restart`。
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
- [ ] `docker compose ... ps` 兩個容器都是 `(healthy)`
- [ ] **重開 NAS，容器自己回來**（驗證 `restart: unless-stopped`）
- [ ] 用手機真的記一餐、上傳一張照片、查當日統計
- [ ] 把那張照片下載回來，確認 EXIF 是空的
      （開發環境已驗過，這裡是端到端複驗）
- [ ] 跑一次備份，再照第三節的流程還原到檢查用的資料庫，確認筆數相符
