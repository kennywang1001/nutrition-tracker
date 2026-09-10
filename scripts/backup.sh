#!/usr/bin/env bash
#
# 資料庫備份：pg_dump 到一個資料夾，只保留最新 N 份（P4 計畫 Task 7）。
#
# 照片本身已經是 photo volume 上的一般檔案（規格第 8 節的理由之一），
# 交給 Synology 既有的磁碟區備份機制，不是這支腳本的事 —— 這支腳本只管資料庫。
#
# 使用方式（在哪個目錄執行都可以，不需要先 cd 進 repo）：
#   bash scripts/backup.sh
#
# NAS 上資料庫跑在 docker compose 的 db 容器裡，這支腳本完全不需要
# （也不該）在 host 上另外裝 PostgreSQL client —— 一律透過
# `docker compose exec` 呼叫容器裡已經有的 pg_dump / pg_restore。
# --project-directory 明確指到 repo 根目錄：cron 執行時的預設工作目錄
# 通常不是 repo（多半是 $HOME），不明確指定的話會找不到正確的 compose 專案。
#
# 可覆寫的環境變數（預設值對齊 docker-compose.yml）：
#   BACKUP_DIR           備份檔存放目錄（預設 <repo>/backups）
#   BACKUP_KEEP_COUNT     保留最新幾份，其餘刪除（預設 7）
#   COMPOSE_DB_SERVICE    docker compose 裡資料庫服務的名字（預設 db）
#   POSTGRES_USER         連線帳號（預設 wallet，對齊 docker-compose.yml）
#   POSTGRES_DB           要備份的資料庫名稱（預設 wallet）

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

BACKUP_DIR="${BACKUP_DIR:-$REPO_ROOT/backups}"
BACKUP_KEEP_COUNT="${BACKUP_KEEP_COUNT:-7}"
COMPOSE_DB_SERVICE="${COMPOSE_DB_SERVICE:-db}"
POSTGRES_USER="${POSTGRES_USER:-wallet}"
POSTGRES_DB="${POSTGRES_DB:-wallet}"

if ! [[ "$BACKUP_KEEP_COUNT" =~ ^[0-9]+$ ]] || [[ "$BACKUP_KEEP_COUNT" -lt 1 ]]; then
  echo "BACKUP_KEEP_COUNT 必須是正整數，目前是：$BACKUP_KEEP_COUNT" >&2
  exit 1
fi

mkdir -p "$BACKUP_DIR"

timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
dest="$BACKUP_DIR/${POSTGRES_DB}-${timestamp}.dump"
tmp_dest="${dest}.partial"

# pg_dump 失敗（例如服務名稱打錯、容器沒在跑）時，不留下一個沒人會清的
# .partial 檔案 —— trap 保證不管正常結束還是中途失敗都會跑這段，
# 已經改名成功（mv 過）之後 $tmp_dest 不存在，rm -f 是 no-op。
trap 'rm -f "$tmp_dest"' EXIT

echo "備份 ${POSTGRES_DB}（服務：${COMPOSE_DB_SERVICE}）-> ${dest}"

# -Fc：自訂格式。之後可以用 pg_restore 指定還原到「另一個」資料庫名稱，
#   不像純 SQL 搭配 -C 會把原始資料庫名稱寫死在檔案裡、還原時只能蓋回同名資料庫。
# exec -T：關掉虛擬終端機配置 —— pg_dump 輸出是二進位內容，
#   不關的話 TTY 層會弄壞這個串流（實測驗證過：不加 -T，備份檔會壞掉）。
# 先寫到 .partial 再 mv：pg_dump 中途失敗（例如磁碟空間不足）不會留下
#   一份看似完整、實際上被截斷的備份檔混進下面的保留清單。
docker compose --project-directory "$REPO_ROOT" exec -T "$COMPOSE_DB_SERVICE" \
  pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc >"$tmp_dest"
mv "$tmp_dest" "$dest"

echo "備份完成：$(du -h "$dest" | cut -f1) $dest"

echo "保留最新 ${BACKUP_KEEP_COUNT} 份，其餘刪除"
# ls -t：依修改時間新到舊排序；tail -n +$((KEEP+1))：跳過最新的 KEEP 份，
# 其餘（更舊的）逐一刪除。第一次備份、檔案數不到 KEEP 份時，這段不刪任何東西。
ls -1t "$BACKUP_DIR"/"${POSTGRES_DB}"-*.dump 2>/dev/null | tail -n +$((BACKUP_KEEP_COUNT + 1)) |
  while IFS= read -r old; do
    echo "刪除舊備份：$old"
    rm -f "$old"
  done

echo "目前保留的備份："
ls -1t "$BACKUP_DIR"/"${POSTGRES_DB}"-*.dump
