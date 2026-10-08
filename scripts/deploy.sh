#!/usr/bin/env bash
#
# 部署：用 CI 做好的映像更新 NAS 上的 app
# （規格 docs/superpowers/specs/2026-10-08-image-deploy-design.md §2.3）。
#
# 使用方式（Synology 上 docker 要 root，所以整支用 sudo 跑；git 會自動以
# repo 擁有者的身分執行，不會在 .git 裡留下 root 的檔案）：
#
#   sudo ./scripts/deploy.sh          # git pull --ff-only，部署 HEAD 那個 commit 的映像
#   sudo ./scripts/deploy.sh <sha>    # 部署指定 commit 的映像（退版用；不動 git）
#
# 步驟（任何一步失敗就停，**舊版照常運作**；只有第 6 步會自動退回上一版）：
#   1. 決定版本、檢查設定解析得出來
#   2. 拉映像（CI 還沒做好就停）
#   3. 把目前正在跑的兩個映像標成 :rollback
#   4. 備份資料庫（scripts/backup.sh；資料庫還沒在跑＝第一次部署，跳過）
#   5. 用**新映像**跑 migration（失敗就停，還沒切換；整次 upgrade 是一個交易，資料庫沒動）
#   6. up -d，等 api 與 caddy 都 healthy；等不到就換回 :rollback 的映像、以非零結束
#   7. 把版本寫進 deployed-version
#
# ⚠️ 退版**不會**倒回 migration：新版的 migration 已經套用，舊程式跟新的資料表一起跑。
# 本專案的 migration 都是加法（加欄位、加表、加索引），舊程式不會碰到它們——
# 哪天出現「刪欄位、改名」這種 migration，那一版就不能靠這支腳本退版。
#
# 可覆寫的環境變數：
#   COMPOSE_PROJECT_NAME   compose 專案名稱（預設：repo 目錄名稱）。本機測試一定要設別的名字，
#                          否則會接管 dev 的容器（交接文件 §7）
#   ENV_FILE               設定檔（預設 .env.production；相對路徑以 repo 根目錄為準）
#   HEALTH_TIMEOUT         等 healthy 的秒數（預設 120），退版時也用同樣的秒數
#   SKIP_PULL=1            不拉映像，用本機已經有的（本機測試用）
#   DEPLOYED_VERSION_FILE  版本紀錄檔（預設 <repo>/deployed-version）
#   BACKUP_DIR 等          原樣傳給 scripts/backup.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 映像名稱：要跟 docker-compose.release.yml、.github/workflows/ci.yml 的 publish job 一致。
API_IMAGE="ghcr.io/kennywang1001/nutrition-tracker-api"
WEB_IMAGE="ghcr.io/kennywang1001/nutrition-tracker-web"
ROLLBACK_TAG="rollback"

ENV_FILE="${ENV_FILE:-.env.production}"
[[ "$ENV_FILE" == /* ]] || ENV_FILE="$REPO_ROOT/$ENV_FILE"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SKIP_PULL="${SKIP_PULL:-0}"
DEPLOYED_VERSION_FILE="${DEPLOYED_VERSION_FILE:-$REPO_ROOT/deployed-version}"

COMPOSE=(
  docker compose
  --project-directory "$REPO_ROOT"
  --env-file "$ENV_FILE"
  -f "$REPO_ROOT/docker-compose.yml"
  -f "$REPO_ROOT/docker-compose.prod.yml"
  -f "$REPO_ROOT/docker-compose.release.yml"
)

usage() {
  cat <<'EOF'
用法：
  sudo ./scripts/deploy.sh          git pull --ff-only，部署 HEAD 那個 commit 的映像
  sudo ./scripts/deploy.sh <sha>    部署指定 commit 的映像（退版用；不動 git）
EOF
}

step() { echo; echo "== [$1/7] $2"; }
die() { echo "✗ $*" >&2; exit 1; }

# docker（Windows 上的 docker.exe）印出來的東西可能帶 \r，比對前先去掉。
clean() { tr -d '\r'; }

# 以 repo 擁有者的身分跑 git：用 sudo 執行這支腳本時，root 跑 git 會被
# 「dubious ownership」擋下，就算沒擋，git pull 也會在 .git 裡留下 root 的檔案，
# 之後一般使用者的 git 就寫不進去了。-H：用擁有者的 HOME（ssh 金鑰、gitconfig）。
git_repo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    local owner
    owner="$(stat -c %U "$REPO_ROOT")"
    if [[ "$owner" != root ]]; then
      sudo -H -u "$owner" git -C "$REPO_ROOT" "$@"
      return
    fi
  fi
  git -C "$REPO_ROOT" "$@"
}

# 某個服務的容器 ID（含沒在跑的；同一個服務只取第一個）。
container_of() {
  "${COMPOSE[@]}" ps -a -q "$1" 2>/dev/null | clean | head -n1 || true
}

running_container_of() {
  "${COMPOSE[@]}" ps --status running -q "$1" 2>/dev/null | clean | head -n1 || true
}

image_id() {
  docker image inspect -f '{{.Id}}' "$1" 2>/dev/null | clean || true
}

# 等到每個服務都「在跑、healthy、而且跑的是預期的映像」，或時間到。
# 參數：截止的 $SECONDS，然後是「服務=映像ID」的清單（映像 ID 空字串＝不檢查映像）。
# 檢查映像是必要的：up 被逾時中斷的話，舊容器可能還在跑、而且是 healthy 的，
# 只看 healthy 會把舊版誤認成新版部署成功。
wait_healthy() {
  local deadline="$1"
  shift
  local spec svc want cid state line all
  while true; do
    all=1
    line=""
    for spec in "$@"; do
      svc="${spec%%=*}"
      want="${spec#*=}"
      cid="$(container_of "$svc")"
      if [[ -z "$cid" ]]; then
        state="沒有容器"
        all=0
      else
        state="$(docker inspect -f '{{.State.Status}}/{{if .State.Health}}{{.State.Health.Status}}{{else}}無健康檢查{{end}}/{{.Image}}' "$cid" 2>/dev/null | clean || echo '查不到')"
        if [[ "$state" != running/healthy/* ]]; then
          all=0
        elif [[ -n "$want" && "${state##*/}" != "$want" ]]; then
          state="舊映像還在跑"
          all=0
        fi
        state="${state%/sha256:*}"
      fi
      line+="  $svc: $state"
    done
    if [[ "$all" -eq 1 ]]; then
      echo "✓ 都 healthy：$line"
      return 0
    fi
    if ((SECONDS >= deadline)); then
      echo "✗ 沒有全部 healthy：$line" >&2
      return 1
    fi
    echo "  等待中（還剩 $((deadline - SECONDS)) 秒）：$line"
    sleep 3
  done
}

# up -d 再等 healthy；整段（含 up 本身）不超過 HEALTH_TIMEOUT 秒。
# up 要加 timeout：caddy 的 depends_on 是 service_healthy，api 一直在重啟的話
# compose 會停在「等 api healthy」那裡，不會自己回來。
up_and_wait() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT))
  local rc=0
  timeout "$HEALTH_TIMEOUT" "${COMPOSE[@]}" up -d --no-build || rc=$?
  if [[ "$rc" -ne 0 ]]; then
    # up 失敗（通常是「dependency failed to start: api is unhealthy」）或逾時：
    # caddy 停在 created、不會再有人啟動它，再等也是白等——只確認一次現況就回報，
    # 讓退版早點開始（每多等一秒都是 app 停著的一秒）。
    if [[ "$rc" -eq 124 ]]; then
      echo "  （up -d 逾時）" >&2
    else
      echo "  （up -d 失敗，結束代碼 $rc）" >&2
    fi
    deadline=$SECONDS
  fi
  wait_healthy "$deadline" "api=$1" "caddy=$2"
}

# ---------------------------------------------------------------------------

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  usage
  exit 0
fi
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 1
fi

docker info >/dev/null 2>&1 ||
  die "連不到 Docker。Synology 上 docker 要 root：用 sudo ./scripts/deploy.sh"

# --- 1. 決定版本 -------------------------------------------------------------
step 1 "決定版本"
[[ -f "$ENV_FILE" ]] || die "找不到設定檔 $ENV_FILE（第一次部署請照 docs/deployment.md 建立 .env.production）"

if [[ $# -eq 0 ]]; then
  echo "git pull --ff-only"
  git_repo pull --ff-only || die "git pull --ff-only 失敗（本機有沒提交的修改，或分支分岔了？）。什麼都沒動。"
  VERSION="$(git_repo rev-parse HEAD)"
else
  # 給的是 commit（完整或縮寫的 SHA、分支名稱）就換成完整 SHA——CI 的標籤是完整 SHA；
  # 不是本機 git 認得的 commit 就當成映像標籤原樣使用。
  if full="$(git_repo rev-parse --verify --quiet "${1}^{commit}" 2>/dev/null)"; then
    VERSION="$full"
  else
    VERSION="$1"
  fi
fi
[[ "$VERSION" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] || die "不是合法的映像標籤：$VERSION"
[[ "$VERSION" != "$ROLLBACK_TAG" ]] || die "「$ROLLBACK_TAG」是退版用的本機標籤，請給 commit SHA"
export APP_VERSION="$VERSION"

PREV_VERSION="unknown"
if [[ -f "$DEPLOYED_VERSION_FILE" ]]; then
  PREV_VERSION="$(sed -n 's/^version=//p' "$DEPLOYED_VERSION_FILE" | head -n1)"
  PREV_VERSION="${PREV_VERSION:-unknown}"
fi

echo "要部署：$VERSION"
echo "目前紀錄的版本：$PREV_VERSION"
echo "compose 專案：${COMPOSE_PROJECT_NAME:-$(basename "$REPO_ROOT")（目錄名稱）}，設定檔：$ENV_FILE"

# 先確認設定解析得出來（漏填 JWT_SECRET 之類會在這裡指名是哪一個）。
"${COMPOSE[@]}" config -q || die "compose 設定解析失敗（見上面的訊息）。什麼都沒動。"

# --- 2. 拉映像 ---------------------------------------------------------------
step 2 "拉映像"
if [[ "$SKIP_PULL" == "1" ]]; then
  echo "SKIP_PULL=1：不拉，用本機已有的映像"
else
  "${COMPOSE[@]}" pull api caddy ||
    die "拉不到 $VERSION 的映像：CI 還沒做好這個版本的映像（或測試沒過），或 GHCR 套件是私人的而這台還沒 docker login ghcr.io。什麼都沒動。"
fi
NEW_API_ID="$(image_id "$API_IMAGE:$VERSION")"
NEW_WEB_ID="$(image_id "$WEB_IMAGE:$VERSION")"
[[ -n "$NEW_API_ID" ]] || die "本機沒有 $API_IMAGE:$VERSION。什麼都沒動。"
[[ -n "$NEW_WEB_ID" ]] || die "本機沒有 $WEB_IMAGE:$VERSION。什麼都沒動。"
echo "✓ $API_IMAGE:$VERSION"
echo "✓ $WEB_IMAGE:$VERSION"

# --- 3. 記下目前的版本 ---------------------------------------------------------
step 3 "把目前在跑的映像標成 :$ROLLBACK_TAG"
HAVE_ROLLBACK=0
OLD_API_CID="$(running_container_of api)"
OLD_WEB_CID="$(running_container_of caddy)"

if [[ -n "$OLD_API_CID" ]]; then
  # 防呆：這個專案名稱底下跑的是開發環境（docker-compose.override.yml 起的）——
  # 繼續下去會在 dev 資料庫上跑 migration、用 production 設定接管 dev 的容器。
  config_files="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$OLD_API_CID" | clean)"
  if [[ "$config_files" == *docker-compose.override.yml* ]]; then
    die "這個 compose 專案正在跑開發環境（$config_files）。本機測試請用 COMPOSE_PROJECT_NAME 指定別的專案名稱。什麼都沒動。"
  fi
fi

if [[ -n "$OLD_API_CID" && -n "$OLD_WEB_CID" ]]; then
  OLD_API_ID="$(docker inspect -f '{{.Image}}' "$OLD_API_CID" | clean)"
  OLD_WEB_ID="$(docker inspect -f '{{.Image}}' "$OLD_WEB_CID" | clean)"
  docker tag "$OLD_API_ID" "$API_IMAGE:$ROLLBACK_TAG"
  docker tag "$OLD_WEB_ID" "$WEB_IMAGE:$ROLLBACK_TAG"
  HAVE_ROLLBACK=1
  echo "✓ api   ${OLD_API_ID:7:12} → $API_IMAGE:$ROLLBACK_TAG"
  echo "✓ caddy ${OLD_WEB_ID:7:12} → $WEB_IMAGE:$ROLLBACK_TAG"
else
  echo "目前沒有在跑的 api＋caddy（第一次部署？）——這次如果失敗，沒有上一版可以自動退回。"
fi

# --- 4. 備份 -----------------------------------------------------------------
step 4 "備份資料庫"
if [[ -n "$(running_container_of db)" ]]; then
  bash "$SCRIPT_DIR/backup.sh" || die "備份失敗。還沒切換版本，舊版照常運作。"
else
  echo "資料庫還沒在跑（第一次部署），沒有東西可以備份，跳過。"
fi

# --- 5. migration ------------------------------------------------------------
step 5 "用新映像跑 migration"
"${COMPOSE[@]}" up -d --no-build db || die "資料庫起不來。還沒切換版本。"
wait_healthy $((SECONDS + HEALTH_TIMEOUT)) "db=" || die "資料庫沒有變成 healthy。還沒切換版本。"

# 退到舊版（./scripts/deploy.sh <舊的 sha>）時，資料庫可能已經在新版的 migration 上，
# 舊映像不認得那個 revision，alembic upgrade head 會直接失敗（Can't locate revision）——
# 退版就永遠退不了。所以先問新映像認不認得資料庫目前的 revision：
#   認得（或資料庫還是空的）→ 照常 upgrade head
#   不認得（exit 3）         → 資料庫比這個版本新＝退版，跳過 migration（不會倒回）
# 其他失敗（映像本身壞了）不算「不認得」，照常往下跑、讓 upgrade 自己報錯。
db_rev="$("${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-wallet}" -d "${POSTGRES_DB:-wallet}" -tAc \
  "SELECT version_num FROM alembic_version" 2>/dev/null | clean | head -n1 || true)"
skip_migration=0
if [[ -n "$db_rev" ]]; then
  echo "資料庫目前的 migration：$db_rev"
  rc=0
  "${COMPOSE[@]}" run --rm --no-deps -T api python -c '
import sys
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util import CommandError
script = ScriptDirectory.from_config(Config("alembic.ini"))
try:
    script.get_revision(sys.argv[1])
except CommandError:
    sys.exit(3)
' "$db_rev" || rc=$?
  if [[ "$rc" -eq 3 ]]; then
    skip_migration=1
  fi
fi

if [[ "$skip_migration" -eq 1 ]]; then
  echo "這個版本不認得資料庫的 migration $db_rev（資料庫比這個版本新）：這是退到舊版，跳過 migration。"
  echo "migration 不會倒回——新版加的欄位、表留著，舊程式不會碰它們。"
elif ! "${COMPOSE[@]}" run --rm --no-deps -T api python -m alembic upgrade head; then
  cat >&2 <<EOF
✗ migration 失敗，沒有切換版本，舊版照常運作。
  整次 upgrade 在同一個交易裡（migrations/env.py），失敗就整個倒回：資料庫沒動。
  如果是 0015（一餐最多一筆餐費）：先照 docs/deployment.md 查出重複的餐費、到報表刪掉多的那筆，再重跑這支腳本。
EOF
  exit 1
fi

# --- 6. 切換 -----------------------------------------------------------------
step 6 "切換到新版並等 healthy（最多 ${HEALTH_TIMEOUT} 秒）"
if ! up_and_wait "$NEW_API_ID" "$NEW_WEB_ID"; then
  echo >&2
  echo "---- 新版的 log（最後 30 行）----" >&2
  "${COMPOSE[@]}" logs --no-color --tail 30 api caddy >&2 || true
  echo "--------------------------------" >&2
  if [[ "$HAVE_ROLLBACK" -ne 1 ]]; then
    die "新版沒有變成 healthy，而且沒有上一版可以退（第一次部署）。看上面的 log。"
  fi
  echo >&2
  echo "== 退回上一版（:$ROLLBACK_TAG，紀錄上是 $PREV_VERSION）" >&2
  export APP_VERSION="$ROLLBACK_TAG"
  if up_and_wait "$OLD_API_ID" "$OLD_WEB_ID"; then
    echo "✗ 新版 $VERSION 沒有變成 healthy，已退回上一版（$PREV_VERSION）。" >&2
    echo "  注意：新版如果有 migration，已經套用、不會倒回（都是加法，舊程式照常運作）。" >&2
    exit 1
  fi
  echo "✗✗ 退回上一版之後也沒有變成 healthy！現在 app 是停的。" >&2
  echo "   看 log：docker compose ... logs api caddy --tail 100；或指定一個確定能跑的版本：sudo ./scripts/deploy.sh <sha>" >&2
  exit 2
fi

# --- 7. 紀錄 -----------------------------------------------------------------
step 7 "紀錄版本"
{
  echo "version=$VERSION"
  echo "previous=$PREV_VERSION"
  echo "deployed_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
} >"$DEPLOYED_VERSION_FILE"
if [[ "$(id -u)" -eq 0 ]]; then
  chown "$(stat -c %U "$REPO_ROOT")" "$DEPLOYED_VERSION_FILE" 2>/dev/null || true
fi
cat "$DEPLOYED_VERSION_FILE"
echo
if [[ "$PREV_VERSION" != unknown ]]; then
  echo "✓ 部署完成：$VERSION（要退回上一版：sudo ./scripts/deploy.sh $PREV_VERSION）"
else
  echo "✓ 部署完成：$VERSION"
fi
