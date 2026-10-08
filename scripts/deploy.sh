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
# 開始之前（任何東西都還沒動）：拿部署鎖（同一時間只能有一個部署）、
# 檢查 docker compose 是 v2.20 以上、檢查這個 compose 專案不是開發環境。
#
# 步驟（任何一步失敗就停，**舊版照常運作**；只有第 6 步會自動退回上一版）：
#   1. 決定版本、檢查設定解析得出來
#   2. 拉映像（CI 還沒做好就停）
#   3. 把目前的 api、caddy 映像標成 :rollback
#   4. 備份資料庫（scripts/backup.sh）。只有「沒有資料庫容器、也沒有資料 volume」
#      ＝真正的第一次部署才跳過；資料庫停著就先把它起來再備份
#   5. 用**新映像**跑 migration（失敗就停，還沒切換；整次 upgrade 是一個交易，資料庫沒動）
#   6. up -d，等 api 與 caddy 都 healthy；等不到就換回 :rollback 的映像、以非零結束
#   7. 把版本寫進 deployed-version
#
# ⚠️ 退版**不會**倒回 migration：新版的 migration 已經套用，舊程式跟新的資料表一起跑。
# 所以「退得回去」的條件是：新版套用的 migration 不會讓舊程式壞掉。
#   安全：加「可為 null 或有預設值」的欄位、加表、加索引——舊程式不知道它們，也不會被擋。
#   不安全：加 NOT NULL 又沒有 server default 的欄位（舊程式 INSERT 時不會給值，直接失敗）、
#           刪欄位、改名、收緊限制。
# 例：0012 的 users.friend_code 是 NOT NULL、沒有 server default——0012 之前的程式建立
# 使用者（註冊、create-admin、create-user）會失敗。這種 revision 列在下面的
# ROLLBACK_UNSAFE_REVISIONS，部署要跨過它時第 5 步會印警告（照樣繼續：這支腳本要能無人值守地跑）。
#
# 可覆寫的環境變數：
#   COMPOSE_PROJECT_NAME   compose 專案名稱（預設：repo 目錄名稱）。本機測試一定要設別的名字，
#                          否則會接管 dev 的容器（交接文件 §7）
#   ENV_FILE               設定檔（預設 .env.production；相對路徑以 repo 根目錄為準）
#   HEALTH_TIMEOUT         等 healthy 的秒數（正整數，預設 120），退版時也用同樣的秒數
#   SKIP_PULL=1            不拉映像，用本機已經有的（本機測試用）
#   DEPLOYED_VERSION_FILE  版本紀錄檔（預設 <repo>/deployed-version）
#   BACKUP_DIR 等          原樣傳給 scripts/backup.sh

set -euo pipefail

# Synology 的任務排程表（與 sudo 的 secure_path）給的 PATH 可能沒有 /usr/local/bin，
# 而 Container Manager 的 docker 就裝在那裡。
export PATH="$PATH:/usr/local/bin"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

# 映像名稱：要跟 docker-compose.release.yml、.github/workflows/ci.yml 的 publish job 一致。
API_IMAGE="ghcr.io/kennywang1001/nutrition-tracker-api"
WEB_IMAGE="ghcr.io/kennywang1001/nutrition-tracker-web"
ROLLBACK_TAG="rollback"

# 舊程式跟著這些 revision 之後的資料表跑會壞掉的 migration（見檔頭）。
# 新增「不能退版」的 migration 時加進來，並在 rollback_unsafe_reason 寫退版之後會壞什麼。
ROLLBACK_UNSAFE_REVISIONS=(0012)
rollback_unsafe_reason() {
  case "$1" in
    0012) echo "舊版無法建立新帳號（好友碼欄位）" ;;
    *) echo "舊版可能無法正常運作" ;;
  esac
}

# 需要的 docker compose 版本下限。理由見 docs/deployment.md「前提」。
COMPOSE_MIN_MAJOR=2
COMPOSE_MIN_MINOR=20

ENV_FILE="${ENV_FILE:-.env.production}"
[[ "$ENV_FILE" == /* ]] || ENV_FILE="$REPO_ROOT/$ENV_FILE"
HEALTH_TIMEOUT="${HEALTH_TIMEOUT:-120}"
SKIP_PULL="${SKIP_PULL:-0}"
DEPLOYED_VERSION_FILE="${DEPLOYED_VERSION_FILE:-$REPO_ROOT/deployed-version}"
LOCK_FILE="$REPO_ROOT/.deploy.lock"

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

# 部署鎖：兩個部署同時跑（例如任務排程表按了兩次、或 SSH 裡也在跑）會互相
# 打標籤、互相退版。整支腳本在鎖裡跑，拿不到就馬上結束、什麼都不動。
# flock：行程結束（含被 kill）時核心自動放掉，不會留下過期的鎖。
# 沒有 flock 的機器退回用 mkdir（原子操作）：正常結束、失敗、Ctrl-C 都會由 trap 刪掉；
# 只有被 kill -9 才會留下來，訊息會說怎麼清。
acquire_lock() {
  if command -v flock >/dev/null 2>&1; then
    exec 9>"$LOCK_FILE" || die "建立不了部署鎖 $LOCK_FILE"
    flock -n 9 || die "另一個部署正在跑（$LOCK_FILE 被鎖住）。等它跑完再試。什麼都沒動。"
  else
    local dir="$LOCK_FILE.d"
    if ! mkdir "$dir" 2>/dev/null; then
      local holder
      holder="$(cat "$dir/pid" 2>/dev/null || echo '?')"
      die "另一個部署正在跑（$dir 存在，PID $holder）。等它跑完再試；確定沒有部署在跑（例如上次被 kill -9）才手動 rmdir 它：rm -r '$dir'。什麼都沒動。"
    fi
    echo "$$" >"$dir/pid"
    # shellcheck disable=SC2064  # 現在就展開路徑
    trap "rm -rf '$dir'" EXIT
  fi
}

# docker compose 版本：印出來（出事時看 log 就知道是哪一版），低於下限就停。
check_compose_version() {
  local full short
  full="$(docker compose version 2>&1 | clean)" ||
    die "找不到 docker compose（v2 外掛）：$full。需要 Docker Compose v${COMPOSE_MIN_MAJOR}.${COMPOSE_MIN_MINOR} 以上（更新 Container Manager）。什麼都沒動。"
  echo "$full"
  short="$(docker compose version --short 2>/dev/null | clean)" || short=""
  short="${short#v}"
  if [[ ! "$short" =~ ^([0-9]+)\.([0-9]+) ]]; then
    die "看不懂 docker compose 的版本「$short」。需要 v${COMPOSE_MIN_MAJOR}.${COMPOSE_MIN_MINOR} 以上。什麼都沒動。"
  fi
  local major="${BASH_REMATCH[1]}" minor="${BASH_REMATCH[2]}"
  if ((major < COMPOSE_MIN_MAJOR || (major == COMPOSE_MIN_MAJOR && minor < COMPOSE_MIN_MINOR))); then
    die "docker compose 版本太舊（v$short）：這支腳本需要 v${COMPOSE_MIN_MAJOR}.${COMPOSE_MIN_MINOR} 以上。到套件中心更新 Container Manager。什麼都沒動。"
  fi
}

# 以 repo 擁有者的身分跑 git：用 sudo 執行這支腳本時，root 跑 git 會被
# 「dubious ownership」擋下，就算沒擋，git pull 也會在 .git 裡留下 root 的檔案，
# 之後一般使用者的 git 就寫不進去了。-H：用擁有者的 HOME（ssh 金鑰、gitconfig）。
# 9>&-：不把部署鎖的 fd 交給 git——git pull 可能在背景留下 gc／maintenance，
# 拿著 fd 的話部署結束了鎖還在。
git_repo() {
  if [[ "$(id -u)" -eq 0 ]]; then
    local owner
    owner="$(stat -c %U "$REPO_ROOT")"
    if [[ "$owner" != root ]]; then
      sudo -H -u "$owner" git -C "$REPO_ROOT" "$@" 9>&-
      return
    fi
  fi
  git -C "$REPO_ROOT" "$@" 9>&-
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

# 把資料庫起來並等到 healthy（已經在跑就什麼都不做）。
ensure_db() {
  "${COMPOSE[@]}" up -d --no-build db || die "資料庫起不來。還沒切換版本。"
  wait_healthy $((SECONDS + HEALTH_TIMEOUT)) "db=" || die "資料庫沒有變成 healthy。還沒切換版本。"
}

# 防呆：這個 compose 專案底下有開發環境的容器（docker-compose.override.yml 起的）——
# 繼續下去會在 dev 資料庫上跑 migration、用 production 設定接管 dev 的容器。
# 看專案裡**所有**容器（含停著的、任何服務、一次性的 run 容器），不只在跑的 api。
# 只讀不寫；一定要在備份、拉映像、打標籤、up 之前跑。
guard_not_dev_stack() {
  local ids cid files
  ids="$(docker ps -a -q --filter "label=com.docker.compose.project=$PROJECT_NAME" | clean)" ||
    die "列不出 compose 專案 $PROJECT_NAME 的容器（docker ps 失敗）。什麼都沒動。"
  for cid in $ids; do
    files="$(docker inspect -f '{{index .Config.Labels "com.docker.compose.project.config_files"}}' "$cid" | clean)" ||
      die "查不到容器 $cid 的設定（docker inspect 失敗）。什麼都沒動。"
    if [[ "$files" == *docker-compose.override.yml* ]]; then
      die "compose 專案「$PROJECT_NAME」裡有開發環境的容器（$cid，用 $files 起的）。本機測試請用 COMPOSE_PROJECT_NAME 指定別的專案名稱。什麼都沒動。"
    fi
  done
}

# 把某個服務目前的映像標成 :rollback。先找在跑的容器，沒有就找停著的
# （那是上一次部署起的）。印出結果；標了就回傳 0 並設定 TAGGED_ID。
tag_rollback() {
  local svc="$1" image="$2" cid how
  TAGGED_ID=""
  cid="$(running_container_of "$svc")"
  how="在跑"
  if [[ -z "$cid" ]]; then
    cid="$(container_of "$svc")"
    how="沒在跑，用停著的容器"
  fi
  if [[ -z "$cid" ]]; then
    echo "  $svc：沒有容器，沒有東西可以標"
    return 1
  fi
  TAGGED_ID="$(docker inspect -f '{{.Image}}' "$cid" | clean)" ||
    die "查不到 $svc 容器（$cid）用的映像（docker inspect 失敗）。什麼都沒動。"
  docker tag "$TAGGED_ID" "$image:$ROLLBACK_TAG" ||
    die "把 $svc 的映像（${TAGGED_ID:7:12}）標成 $image:$ROLLBACK_TAG 失敗。還沒備份、還沒切換，舊版照常運作。"
  echo "✓ $svc（$how）${TAGGED_ID:7:12} → $image:$ROLLBACK_TAG"
  return 0
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

[[ "$HEALTH_TIMEOUT" =~ ^[1-9][0-9]*$ ]] ||
  die "HEALTH_TIMEOUT 必須是正整數（秒），目前是：$HEALTH_TIMEOUT"

acquire_lock

docker info >/dev/null 2>&1 ||
  die "連不到 Docker。Synology 上 docker 要 root：用 sudo ./scripts/deploy.sh"
check_compose_version

[[ -f "$ENV_FILE" ]] || die "找不到設定檔 $ENV_FILE（第一次部署請照 docs/deployment.md 建立 .env.production）"

# compose 專案名稱（COMPOSE_PROJECT_NAME 或目錄名稱，由 compose 自己決定）。
# 這時還不知道版本，APP_VERSION 先給一個佔位的值，只為了讓設定解析得出來。
PROJECT_NAME="$(APP_VERSION=placeholder "${COMPOSE[@]}" config | clean | sed -n 's/^name: *//p')" ||
  die "compose 設定解析失敗（見上面的訊息）。什麼都沒動。"
PROJECT_NAME="${PROJECT_NAME%%$'\n'*}"
[[ -n "$PROJECT_NAME" ]] || die "算不出 compose 專案名稱。什麼都沒動。"
guard_not_dev_stack

# --- 1. 決定版本 -------------------------------------------------------------
step 1 "決定版本"

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
echo "compose 專案：$PROJECT_NAME，設定檔：$ENV_FILE"

# 先確認設定解析得出來（漏填 JWT_SECRET 之類會在這裡指名是哪一個）。
"${COMPOSE[@]}" config -q || die "compose 設定解析失敗（見上面的訊息）。什麼都沒動。"

# --- 2. 拉映像 ---------------------------------------------------------------
step 2 "拉映像"
if [[ "$SKIP_PULL" == "1" ]]; then
  echo "SKIP_PULL=1：不拉，用本機已有的映像"
else
  # api、caddy 在 docker-compose.yml／prod.yml 裡還有 build（release 疊加檔刻意不用 !reset 拿掉），
  # pull 照樣會拉有 image 的服務（v2.40 實測：拉不到就非零結束）。沒有在每個舊版上驗過
  # 「拉不到、但可以 build」的服務是不是也一定非零，所以下面再確認一次映像真的在本機。
  "${COMPOSE[@]}" pull api caddy ||
    die "拉不到 $VERSION 的映像：CI 還沒做好這個版本的映像（或測試沒過），或 GHCR 套件是私人的而這台還沒 docker login ghcr.io。什麼都沒動。"
fi
NEW_API_ID="$(image_id "$API_IMAGE:$VERSION")"
NEW_WEB_ID="$(image_id "$WEB_IMAGE:$VERSION")"
[[ -n "$NEW_API_ID" ]] || die "本機沒有 $API_IMAGE:$VERSION（拉不到？）。什麼都沒動。"
[[ -n "$NEW_WEB_ID" ]] || die "本機沒有 $WEB_IMAGE:$VERSION（拉不到？）。什麼都沒動。"
echo "✓ $API_IMAGE:$VERSION"
echo "✓ $WEB_IMAGE:$VERSION"

# --- 3. 記下目前的版本 ---------------------------------------------------------
step 3 "把目前的映像標成 :$ROLLBACK_TAG"
HAVE_ROLLBACK=0
OLD_API_ID=""
OLD_WEB_ID=""
if tag_rollback api "$API_IMAGE"; then OLD_API_ID="$TAGGED_ID"; fi
if tag_rollback caddy "$WEB_IMAGE"; then OLD_WEB_ID="$TAGGED_ID"; fi

if [[ -n "$OLD_API_ID" && -n "$OLD_WEB_ID" ]]; then
  HAVE_ROLLBACK=1
elif [[ -z "$OLD_API_ID" && -z "$OLD_WEB_ID" ]]; then
  echo "api、caddy 都沒有容器（第一次部署？）——這次如果失敗，沒有上一版可以自動退回。"
else
  # 只有一邊：:rollback 已經替有容器的那一邊標好（手動退版用得到），但自動退回要兩個映像都有，
  # 另一邊的 :rollback 如果存在，是更早以前的部署留下的，不能拿來用。
  echo "只有一邊有容器（$([[ -n "$OLD_API_ID" ]] && echo api || echo caddy)）——這次如果失敗不會自動退回（另一邊沒有上一版的映像）。"
fi

# --- 4. 備份 -----------------------------------------------------------------
step 4 "備份資料庫"
# 只有「沒有資料庫容器、也沒有資料 volume」才是真正的第一次部署。資料庫停著
# （NAS 重開後沒起來、有人 stop 過、down 過但 volume 還在）時資料還在——先起來再備份，
# 不然第 5 步的 migration 會在沒有備份的資料上跑。
PGDATA_VOLUME="${PROJECT_NAME}_pgdata"
if [[ -z "$(container_of db)" ]] && ! docker volume inspect "$PGDATA_VOLUME" >/dev/null 2>&1; then
  echo "沒有資料庫容器、也沒有 $PGDATA_VOLUME volume（真正的第一次部署），沒有東西可以備份，跳過。"
else
  if [[ -z "$(running_container_of db)" ]]; then
    echo "資料庫沒在跑，但資料還在（容器或 $PGDATA_VOLUME volume 存在）：先把資料庫起來再備份。"
    ensure_db
  fi
  bash "$SCRIPT_DIR/backup.sh" || die "備份失敗。還沒切換版本，舊版照常運作。"
fi

# --- 5. migration ------------------------------------------------------------
step 5 "用新映像跑 migration"
ensure_db

# 退到舊版（./scripts/deploy.sh <舊的 sha>）時，資料庫可能已經在新版的 migration 上，
# 舊映像不認得那個 revision，alembic upgrade head 會直接失敗（Can't locate revision）——
# 退版就永遠退不了。所以先問新映像認不認得資料庫目前的 revision：
#   認得（或資料庫還是空的）→ 照常 upgrade head；順便列出這次會套用哪些 revision
#   不認得（exit 3）         → 資料庫比這個版本新＝退版，跳過 migration（不會倒回）
# 其他失敗（映像本身壞了）不算「不認得」，照常往下跑、讓 upgrade 自己報錯。
db_rev="$("${COMPOSE[@]}" exec -T db psql -U "${POSTGRES_USER:-wallet}" -d "${POSTGRES_DB:-wallet}" -tAc \
  "SELECT version_num FROM alembic_version" 2>/dev/null | clean | head -n1 || true)"
skip_migration=0
pending_revs=()
CROSSED_UNSAFE=()
if [[ -n "$db_rev" ]]; then
  echo "資料庫目前的 migration：$db_rev"
  rc=0
  probe="$("${COMPOSE[@]}" run --rm --no-deps -T api python -c '
import sys
from alembic.config import Config
from alembic.script import ScriptDirectory
from alembic.util import CommandError
script = ScriptDirectory.from_config(Config("alembic.ini"))
try:
    script.get_revision(sys.argv[1])
except CommandError:
    sys.exit(3)
try:
    # iterate_revisions 從 head 往回走；反過來＝套用的順序。
    pending = [s.revision for s in script.iterate_revisions("heads", sys.argv[1])][::-1]
except Exception as exc:
    print(f"列不出待套用的 migration：{exc}", file=sys.stderr)
    sys.exit(4)
for rev in pending:
    print(f"pending:{rev}")
' "$db_rev" | clean)" || rc=$?
  if [[ "$rc" -eq 3 ]]; then
    skip_migration=1
  elif [[ "$rc" -eq 0 ]]; then
    mapfile -t pending_revs < <(sed -n 's/^pending://p' <<<"$probe")
    if [[ ${#pending_revs[@]} -eq 0 ]]; then
      echo "已經是最新的 migration，沒有要套用的。"
    else
      echo "這次會套用：${pending_revs[*]}"
    fi
    for rev in ${pending_revs[@]+"${pending_revs[@]}"}; do
      for unsafe in "${ROLLBACK_UNSAFE_REVISIONS[@]}"; do
        if [[ "$rev" == "$unsafe" ]]; then
          CROSSED_UNSAFE+=("$rev")
        fi
      done
    done
  elif [[ "$rc" -eq 4 ]]; then
    echo "⚠️ 判斷不了這次會不會跨過不能退版的 migration（${ROLLBACK_UNSAFE_REVISIONS[*]}），照常繼續。" >&2
  fi
fi
# ${arr[@]+"${arr[@]}"}：空陣列在 bash 4.4 之前配 set -u 會被當成未定義。
for rev in ${CROSSED_UNSAFE[@]+"${CROSSED_UNSAFE[@]}"}; do
  echo "⚠️ 跨過 $rev：如果新版起不來被自動退回，$(rollback_unsafe_reason "$rev")。" >&2
done

if [[ "$skip_migration" -eq 1 ]]; then
  echo "這個版本不認得資料庫的 migration $db_rev（資料庫比這個版本新）：這是退到舊版，跳過 migration。"
  echo "migration 不會倒回——新版的欄位、表留著。新版有不能退版的 migration（例如 0012）時，舊版會有對應的問題（docs/deployment.md「退版」）。"
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
    die "新版沒有變成 healthy，而且沒有完整的上一版可以自動退回（見第 3 步）。看上面的 log。"
  fi
  echo >&2
  echo "== 退回上一版（:$ROLLBACK_TAG，紀錄上是 $PREV_VERSION）" >&2
  export APP_VERSION="$ROLLBACK_TAG"
  if up_and_wait "$OLD_API_ID" "$OLD_WEB_ID"; then
    echo "✗ 新版 $VERSION 沒有變成 healthy，已退回上一版（$PREV_VERSION）。" >&2
    echo "  注意：新版的 migration 已經套用、不會倒回。" >&2
    for rev in ${CROSSED_UNSAFE[@]+"${CROSSED_UNSAFE[@]}"}; do
      echo "  ⚠️ 這次跨過了 $rev：退回之後$(rollback_unsafe_reason "$rev")。盡快修好新版再部署。" >&2
    done
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
