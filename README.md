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

## 設計文件

- [P1 設計規格](docs/superpowers/specs/2026-09-02-diet-tracker-p1-design.md)
