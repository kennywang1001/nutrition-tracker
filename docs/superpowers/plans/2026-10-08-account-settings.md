# 帳號與目標設定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 朋友能自己設每日目標（從今天起生效）、改顯示名稱、改密碼（其他裝置登出）；管理員能替一般使用者產生一次性的重設密碼連結（24 小時），取代 SSH 跑 `create-user`。

**Architecture:** 後端多一張 `password_reset_tokens`（只存 SHA-256，部分唯一索引保證一個人最多一條活連結），規則集中在 `app/password_resets.py`（同 `app/invites.py` 的形狀）；新端點 `PUT /api/targets/today`（後端決定今天、三種狀態一個端點）、`POST /api/me/password`（共用登入限速、撤銷所有 session 再開一條新的）、`GET /api/admin/users`、`POST /api/admin/users/{id}/password-reset`、`POST /api/auth/password-reset-status`、`POST /api/auth/password-reset`。前端：「我的」的帳號卡片（行內改名稱）、每日目標卡片、管理員的「所有帳號」卡片；新頁 `/me/targets`、`/me/password`；沒登入時的 `/reset-password#<碼>`。

**Tech Stack:** FastAPI · Pydantic v2 · SQLAlchemy 2 async · Alembic · PostgreSQL 16 · Argon2 · React 19 · TypeScript strict · TanStack Query v5 · react-router · CSS Modules · Vitest · Playwright · Biome

**依據規格：** `docs/superpowers/specs/2026-10-08-account-settings-design.md`（以下稱「規格」）

---

## 執行環境

- 分支 `feat/account-settings`（已建立，**不要 push**）。
- 後端在 repo 根目錄（Git Bash）：
  - `./.venv/Scripts/python.exe -m pytest -q`（**一定用 `.venv` 的 python**）。需要 dev 的 Postgres：`docker compose up -d`（專案名稱 `wallet`，資料庫在 `localhost:5433`）。測試資料庫每個 session 砍掉重建、`alembic upgrade head`、`alembic check`（`tests/conftest.py`）——migration 跟模型對不上會在 session 一開始就炸。
  - `./.venv/Scripts/python.exe -m ruff check app tests migrations`、`./.venv/Scripts/python.exe -m mypy app`。**不要跑 `ruff format`**（handover §7）。
- 前端在 `frontend/`：`npx vitest run tests/xxx`、`npm run -s typecheck`、`npm run -s lint`（格式問題用 `npx biome check --write <檔案>`）、`npm run -s test`。vitest 的 `Test Files`／`Tests` 是實際數量的**兩倍**；驗證時一起 grep `FAIL` 與 `Unhandled`（handover §7）。
- e2e：先 `docker compose up -d --build api`（新 migration 是烤進映像的），再在 `frontend/` 跑 `npx playwright test …`（會自己起 dev server）。
- 基準線（`79bbc49`）：後端 845 條（`pytest --collect-only -q`）。前端與 e2e 的數字在 Task 6、Task 12 開工前自己量一次記下來。
- **`schema.d.ts` 重新產生**（任何動到 `app/api/routes/*.py` 或 `app/schemas/*.py` 的 task，**連 docstring 也算**，在同一個 commit 做；CI 的 `contract` job 會 `git diff --exit-code`）：

  ```bash
  S=C:/Users/user/AppData/Local/Temp/claude/f--wallet/e7b60c93-fbd5-4a61-9c85-74550ff7244b/scratchpad
  PYTHONUTF8=1 PYTHONIOENCODING=utf-8 ./.venv/Scripts/python.exe -c "import json; from app.main import app; print(json.dumps(app.openapi(), ensure_ascii=False))" > "$S/openapi.tmp.json"; (cd frontend && npx openapi-typescript "$S/openapi.tmp.json" -o src/api/schema.d.ts)
  rm "$S/openapi.tmp.json"
  ```

- **Write／Edit；LF。不要留備份檔或暫存腳本在 repo 裡。** 突變後手動改回並重跑（新檔案的突變 `git checkout --` 救不回來，handover §6 規矩 11）。
- **Commit 規則**：中文 conventional commit（`feat(backend): …`、`feat(frontend): …`、`test(e2e): …`、`docs: …`），訊息寫在 scratchpad 的檔案裡，結尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`，用 `git commit -F "$S/commit-msg.txt"`。**明確列出要 add 的檔案；絕對不要 stage `lunch.jpg`**（不要 `git add -A`／`git add .`）。不要 amend。

## 開工前必讀

1. 「Expected: FAIL」沒有如預期失敗 → 停下來回報。預測的紅燈數對不上 → 照實回報是哪幾條、為什麼。
2. 引用的程式碼對不上現況 → 以現況為準並回報。
3. 先寫測試、看它紅，再寫實作。**紅燈要問為什麼紅**（第 8 條規矩）：崩潰、被約束擋下不等於斷言咬到了。
4. **共用交易看不見 commit**（第 11 種）：`client` 與 `db_session` 共用一個 session。斷言「寫進去了／沒寫進去」之前先 `await db_session.rollback()`；**rollback 之前先把要用的 id、email 取成區域變數**——rollback 會讓 ORM 物件過期，之後讀屬性會炸 `MissingGreenlet`（第 12、28 種）。
5. 只斷言 404 的測試在路由不存在時也是綠的——連 `error.code` 一起斷言（第 32 種）。
6. `ASGITransport` 讓未處理的例外直接從 `client.post()` 冒出來，不是 500 的 response（第 31 種）。
7. Playwright 的名稱預設是**子字串比對**：「新密碼」會對到「再輸入一次新密碼」、「密碼」會對到「修改密碼」——用 `exact: true`。換頁之後的第一個斷言選只有新頁面才有的東西（第 48、53 種）。**新增標題或按鈕之前先 grep `frontend/e2e` 有沒有名稱是它子字串的選擇器**。
8. `tests/helpers/mock-api.ts` 用 `url.includes(path)` 比對：`/api/me` 會對到 `/api/me/password`（第 43 種）——更具體的路徑排前面、而且寫 `method`。
9. 斷言「沒有發生」之前先證明它有機會發生（第 41 種）；「A 集合等於 B 集合」先斷言不是空的（第 44 種）。
10. e2e 登入後**只用點擊換頁**，不要 `page.goto`（access token 只在記憶體，連續整頁載入會在並行時觸發 refresh 重用、被登出）。

## 開工前已經查證過的事實

| 事實 | 出處 |
|---|---|
| `PATCH /api/targets/{id}` 一律「關閉舊期間、開新期間」；`effective_from` 省略＝`today_in_timezone(user.timezone)`；**新的生效日 ≤ 舊的 `effective_from` → `422 EFFECTIVE_DATE_TOO_EARLY`**（今天才開始的那筆改不了）；省略的營養素沿用舊值、顯式 null 清掉 | `app/api/routes/targets.py:96-171` |
| 關閉與插入的順序：先 `target.effective_to = …; await db.flush()`，再插新列（`EXCLUDE` 逐列立即檢查） | 同上 |
| `user_targets`：四個營養素 `Numeric(8,2)` 可 null；`CHECK (effective_to IS NULL OR effective_to > effective_from)`（最終名 `ck_user_targets_effective_range`）；`ex_user_targets_no_overlap`（`daterange(…, '[)')`） | `app/models/target.py` |
| 既有 schema 的上限：`_MAX_KCAL = Decimal("20000")`、`_MAX_GRAMS = Decimal("2000")`，`ge=0`、`max_digits=8, decimal_places=2` | `app/schemas/target.py` |
| `GET /api/stats/daily`（省略 `date`＝使用者的今天）回 `target: {kcal, protein_g, fat_g, carb_g} | null`；帶 `?date=` 可查任何一天 | `app/api/routes/stats.py:56-110` |
| 測試的「今天」：`monkeypatch.setattr("app.api.routes.targets.today_in_timezone", …)`；`create_target(db_session, *, user, kcal=2000, protein_g=None, …, label=None, effective_from=None, effective_to=None)` | `tests/test_targets.py:356-377`、`tests/factories.py:311` |
| `PATCH /api/me`：`UpdateMeRequest`（`display_name` 1–50、`DisplayName` 驗證；顯式 null → 422），回 `UserResponse {id, email, display_name, role, timezone}` | `app/api/routes/me.py`、`app/schemas/user.py` |
| `login`：`login_rate_limiter.check(email)` → `run_in_threadpool(verify_password, …)` → 失敗 `record_failure`、成功 `record_success`；`TOO_MANY_LOGIN_ATTEMPTS` 是 429 帶 `Retry-After` | `app/api/routes/auth.py:105-140`、`app/ratelimit.py` |
| `login_rate_limiter` 是模組層單例，`tests/conftest.py` 的 autouse fixture 每個測試重置 | `tests/conftest.py:83` |
| `start_session(db, user_id)`、`revoke_all_for_user(db, user_id)` **都自己 commit**；`revoke_all_for_user` 先取每使用者的 advisory lock；`start_session` 不能在呼叫前留下不相關的待寫入資料 | `app/security/sessions.py` |
| `MIN_PASSWORD_LENGTH = 8` 只定義在 `app/cli.py`；`RegisterRequest.password` 寫死 `Field(min_length=8, max_length=128)` | `app/cli.py:20`、`app/schemas/auth.py` |
| 邀請的形狀：`app/invites.py`（`_still_usable()` 共用、`redeem_invite` 是條件式 `UPDATE … RETURNING`）、`app/models/invite.py`、`migrations/versions/0011_create_invites.py`、`tests/test_invites_concurrency.py`（兩條真的連線＋`_wait_until_someone_else_is_lock_waiting`） | 同檔 |
| **`invite-status` 沒有限速器**（規格「與原始決定的差異」第 1 點） | `app/api/routes/auth.py:94-100` |
| 部分唯一索引的寫法：模型 `Index("uq_…", "col", unique=True, postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"))`，migration 用 `op.create_index(…, postgresql_where=sa.text(…))`，述詞要一字不差 | `app/models/session.py`、`migrations/versions/0007_create_refresh_sessions.py:55-61` |
| 最新的 migration 是 `0015`（`down_revision = "0014"`） | `migrations/versions/` |
| **uvicorn 預設設定下 `app.*` 的 INFO 不會輸出**（實測：`dictConfig(uvicorn.config.LOGGING_CONFIG)` 後 `logging.getLogger("app.x").info()` 什麼都沒印、`.warning()` 有） | 規格決定 17 |
| `pyproject.toml` 的 pytest 設定沒有 `log_level`（root 是 WARNING） | `pyproject.toml:85` |
| 前端：`useDailyStats()`（key `["stats","daily"]`）、`queryKeys.rangeStatsAll = ["stats","range"]`、`queryKeys.me = ["me"]`、`queryKeys.invites = ["admin","invites"]` | `frontend/src/api/stats.ts`、`queries.ts` |
| `setTokens({access_token, refresh_token})`、`getRefreshToken()`（每次讀 localStorage）、`login()` 在 `auth/session.ts` | `frontend/src/auth/` |
| `apiFetch` 只有 **401** 會換票並重送一次 | `frontend/src/api/client.ts` |
| `lib/decimal.ts` 是唯一能 import `decimal.js` 的檔案（`tests/decimal-containment.test.ts`）；已有 `isPlainPositiveDecimal`、`formatMacro` | 同檔 |
| `contentWidthFor`：`WIDE`、`FORM`（`/expenses/new`、`/meals/new`）兩個 Set，其他 `narrow`；測試 `tests/layout.test.ts` | `frontend/src/lib/layout.ts` |
| `Join.tsx`：`readInviteToken(hash)`、phase 狀態機、成功後 `history.replaceState(null, "", "/")`；`JoinWhileLoggedIn` 用 `navigate("/join", { replace: true })` | `frontend/src/screens/Join.tsx` |
| `App.tsx`：沒登入時 `JOIN_PATHS.has(window.location.pathname)` → `<main className="app-auth"><Join/></main>`，否則 `<Login>` | `frontend/src/App.tsx` |
| `Me.tsx` 的帳號卡片現在**只顯示 email**；`tests/me.test.tsx` 的「重新整理」測試用 `findByText("Kenny")`——帳號卡片一顯示名字就會撞成兩個元素 | `frontend/src/screens/Me.tsx`、`tests/me.test.tsx:94` |
| `e2e/auth.spec.ts:35` 在「我的」用 `getByText(ADMIN.email)`；`e2e/invites.spec.ts` 最後用 `getByText(\`E2E 朋友（${email}）\`)` | 同檔 |
| 沒登入的畫面不能用 `mockApi`（沒帶 Authorization 一律 401），要自己 spy `fetch`（`tests/join.test.tsx` 的 `backend()`） | `frontend/tests/join.test.tsx:41` |
| e2e：`login(page)`（ADMIN）在 `e2e/touch-targets.ts`；`expectTouchTargets(locator, where)`；用 API 開新帳號的寫法在 `e2e/friends.spec.ts:17-45` | 同檔 |
| Playwright 預設 1280×720 是電腦版；`SideNav` 與 `TabBar` 的連結名稱一樣（「總覽」「我的」…） | handover §10「電腦版版面」 |

## 與規格的差異

1. 規格 §7.1 的「並行 409」接縫寫「讓下一筆未來期間的查詢回 None」——計畫把新期間結束日的計算整個抽成
   `_new_period_end(db, user_id, today, current)`，**兩條路（有目前的期間／沒有）都能用同一個接縫**造出撞期，
   而「有目前的期間」那條還能驗證「關閉也一起 rollback」。

### 執行中發現的差異

2. **`MIN_PASSWORD_LENGTH` 的「只有一個定義」測試（Task 1）。** 規格 §7.1 與本計畫寫的是
   `app.cli.MIN_PASSWORD_LENGTH is app.security.password.MIN_PASSWORD_LENGTH`——**這個斷言沒有鑑別力**：CPython 快取
   -5～256 的小整數，`app/cli.py` 自己再寫一行 `MIN_PASSWORD_LENGTH = 8` 也是同一個物件，實測那個突變下 `is` 照樣成立。
   改成兩段：值相等（`== 8`），再用 `ast` 讀 `app/cli.py` 的原始碼——名字不能出現在任何賦值的左邊、必須出現在
   `from app.security.password import …` 裡（`tests/test_password_reset_model.py`）。
3. **`app` logger 的 INFO（Task 3）。** 寫法照計畫：`app/main.py` 在模組層（import 時，不是 lifespan）把 `app` logger 設成
   INFO、沒有 handler 才掛一個 `StreamHandler`，格式模仿 uvicorn（`INFO:     app.api.routes.me: …`），`propagate` 不關。
   要知道的副作用：只有 import `app.main` 的行程才有這個設定——`app/cli.py` 不 import 它（CLI 本來也只寫 WARNING，
   沒有差別）；以後如果有人替 root 掛 handler（例如 uvicorn 的 `--log-config`），每一行稽核紀錄會印兩次。
   實測 dev 容器：`docker compose logs api` 看得到三種稽核紀錄，各一行。改密碼那一行的全文是
   「使用者 {id} 修改了密碼，所有其他 session 已撤銷」（規格 §3.2 只寫了前半句；測試與 grep 都只比前半句）。
4. **`ChangePassword` 成功之後的版面（Task 9）。** 計畫把 `role="status"` 與「回我的」一起包在 `<div>` 裡，連結要自己給
   44px。實作把「回我的」放在 `.screen` 正下方（`<p role="status">` 仍然包在 `<div>` 裡），直接吃 `ui.module.css` 的
   `.screen > a`（44px）——不用寫第三份「44px 的連結」，也就不用抽 `.linkTarget`。
5. **`AccountsAdmin`（Task 10）比計畫多三種狀態。**
   - **等 `useMe` 也回來才畫清單**：計畫的 `filter((user) => user.id !== me?.id)` 在 `useMe` 還沒回來時 `me` 是
     `undefined`，什麼都濾不掉——自己的那一列會先出現一下、再被濾掉。清單回來、`me` 還沒回來時顯示「載入中…」。
   - **清單載入失敗**：`role="alert"`「無法載入帳號清單」（計畫沒寫，原本會是一個空白的卡片）。
   - **沒有其他帳號**：「還沒有其他帳號」。
   - `Created` 不存 `userId`（沒有地方用得到）。
6. **`/reset-password` 的同分頁限制（Task 11）。** 碼在第一次 render 時從 `window.location.hash` 讀一次
   （`useState` 的初始值）。在**同一個分頁**把網址換成只有 `#` 後面不同的另一條連結，瀏覽器不重新載入、app 也不重新讀，
   畫面停在上一條連結的結果（例如「已經失效」）。`/join` 的 `Join` 一模一樣。重新整理或開新分頁就好；e2e 一律開新的
   context 打開連結。沒有修：要修得監聽 `hashchange` 並重設整個狀態機，兩個畫面一起改，不值得。
7. **e2e（Task 12）：計畫的改密碼那條有兩處跟現況不符，其中一處是假綠燈。**
   - **「`pageA.reload()` 之後新票沒存好或被撤銷了，會掉回登入畫面」不成立。** 換票 401 時 `refresh.ts` 清掉 token 與快取，
     但 `App` 的 `loggedIn` 只在開頁時讀一次 localStorage，畫面**不會**切回登入；「修改密碼」「我的」的標題照樣畫得出來，
     「我的」的資料又可能來自離線快取、根本不發請求。實測：照計畫只看標題，「後端 `start_session` 搬到
     `revoke_all_for_user` 之前」與「前端 `changePassword()` 不 `setTokens`」兩個突變**都是綠的**（handover §6 第 18 種）。
     改成：reload 之前先 `waitForResponse("/api/auth/refresh")`，reload → 點「我的」→ 點「重新整理」（直接打 `/api/me`，
     記憶體裡沒有 access token → 401 → 換票），斷言換票的回應是 **200**。兩個突變都在這一行紅（`Received: 401`）。
   - **登出再用新密碼登入之後是「我的」，不是總覽**：登出不換網址，登入之後回到原本的 `/me`。改成等「我的」標題與帳號卡片上的 email。
   - 目標那條的突變（`Targets.tsx` 不失效 `dailyStats`）紅在**「我的」的每日目標卡片**（存完回到「我的」那一刻），
     比計畫預測的總覽早一步——同一個原因（`staleTime` 60 秒，回到「我的」不重抓）。
   - 其他突變照計畫的預測紅：`reset_password` 不撤銷 → `replay` 那行（200 ≠ 401）；`ResetPassword.tsx` 不 `replaceState`
     → `hash` 那行。
   - **審查之後（2026-10-09）「換票失敗不會掉回登入畫面」不再成立**：`App` 訂閱 `auth/store.ts` 的 `onLoggedOut`，換票 401
     會切回登入畫面並顯示「已被登出，請重新登入」。e2e 的 B 裝置多了這一段（access token 過期 → 點「我的」→ 換票 401 →
     登入畫面）；A 的「換票是 200」留著。其餘審查修正（登入重讀雜湊、鎖順序、CLI 撤銷……）見規格的「審查後的修正」
     與 handover 第 10 節。
   - 名稱一律 `exact: true`（「新密碼」⊂「再輸入一次新密碼」、「密碼」⊂「目前的密碼」、「重設密碼」⊂「重設密碼連結」、
     「重設密碼連結」⊂ 每一顆「產生重設密碼連結：…」的可及名稱）；每次換頁之後先等只有新頁面才有的東西
     （點「總覽」之後等「總覽」標題、產生連結之後等「給 {名字} 的重設密碼連結」、「去登入」之後等「登入」按鈕）。

## 檔案結構

| 檔案 | 負責什麼 | Task |
|---|---|---|
| `app/security/password.py`（改） | `MIN_PASSWORD_LENGTH`、`MAX_PASSWORD_LENGTH` 的唯一定義 | 1 |
| `app/cli.py`、`app/schemas/auth.py`（改） | 改用上面那兩個常數 | 1 |
| `app/models/password_reset.py`（新）、`app/models/__init__.py`（改） | `PasswordResetToken` | 1 |
| `migrations/versions/0016_create_password_reset_tokens.py`（新） | | 1 |
| `app/password_resets.py`（新） | 產生、雜湊、「還能用」、查、兌換、撤銷某人的活連結 | 1 |
| `tests/factories.py`（改）、`tests/test_password_reset_model.py`（新） | `create_password_reset`；資料庫約束 | 1 |
| `app/schemas/target.py`、`app/api/routes/targets.py`（改）、`tests/test_targets_today.py`（新） | `PUT /api/targets/today` | 2 |
| `app/main.py`（改）、`tests/test_logging_setup.py`（新） | `app.*` 的 INFO 真的輸出 | 3 |
| `app/schemas/user.py`、`app/api/routes/me.py`（改）、`tests/test_change_password.py`（新） | `POST /api/me/password` | 3 |
| `app/schemas/password_reset.py`（新）、`app/api/routes/admin_users.py`（新）、`app/main.py`（改）、`tests/test_admin_users.py`（新） | 管理員清單、產生連結 | 4 |
| `app/api/routes/auth.py`（改）、`tests/test_password_reset.py`、`tests/test_password_reset_concurrency.py`（新） | 公開的狀態與重設 | 5 |
| `frontend/src/api/schema.d.ts`（每個後端 task 重新產生） | | 1–5 |
| `frontend/src/api/targets.ts`、`admin-users.ts`、`password-reset.ts`（新）；`api/me.ts`、`api/queries.ts`、`auth/session.ts`、`lib/decimal.ts`、`lib/layout.ts`（改）；`lib/link-token.ts`、`lib/targets.ts`（新）；`screens/Join.tsx`（改：轉出 `readLinkToken`） | API 層、檢查、路由寬度 | 6 |
| `frontend/tests/account-api.test.ts`（新）；`decimal.test.ts`、`layout.test.ts`（改） | | 6 |
| `frontend/src/components/AccountCard.tsx`、`TargetsCard.tsx`、`AccountCard.module.css`、`TargetsCard.module.css`（新）；`screens/Me.tsx`、`Me.module.css`（改）；`tests/me.test.tsx`（改） | 「我的」的兩張卡片 | 7 |
| `frontend/src/screens/Targets.tsx`（新）、`App.tsx`（改）、`tests/targets.test.tsx`（新） | `/me/targets` | 8 |
| `frontend/src/screens/ChangePassword.tsx`（新）、`App.tsx`（改）、`tests/change-password.test.tsx`（新） | `/me/password` | 9 |
| `frontend/src/components/AccountsAdmin.tsx`、`AccountsAdmin.module.css`（新）、`screens/Me.tsx`（改）、`tests/accounts-admin.test.tsx`（新） | 「所有帳號」 | 10 |
| `frontend/src/screens/ResetPassword.tsx`（新）、`App.tsx`（改）、`tests/reset-password.test.tsx`（新）、`tests/app.test.tsx`（改） | `/reset-password` | 11 |
| `frontend/e2e/new-account.ts`、`account-settings.spec.ts`（新） | e2e | 12 |
| `docs/handover.md`、`docs/deployment.md`、規格（改） | 文件 | 13 |

---

## Task 1：後端——`password_reset_tokens` 表、模型、規則模組、密碼長度常數

這個 task 沒有端點；它讓 Task 4、5 的測試寫得出來，並把資料庫的保證先釘住。

**Files:**
- Create: `app/models/password_reset.py`、`migrations/versions/0016_create_password_reset_tokens.py`、`app/password_resets.py`、`tests/test_password_reset_model.py`
- Modify: `app/security/password.py`、`app/cli.py`、`app/schemas/auth.py`、`app/models/__init__.py`、`tests/factories.py`

- [ ] **Step 1: 寫失敗的測試** `tests/test_password_reset_model.py`：

```python
"""重設密碼連結的資料庫保證（規格 §4.1）與密碼長度常數（規格決定 20）。"""

from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy.exc import IntegrityError

import app.cli
import app.security.password
from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.password_resets import RESET_LIFETIME, hash_reset_token, new_reset_token
from tests.factories import create_password_reset, create_user


def test_the_minimum_password_length_has_one_definition():
    # cli 仍然叫得到這個名字（既有的引用不變），但它就是 security.password 那一個。
    assert app.cli.MIN_PASSWORD_LENGTH is app.security.password.MIN_PASSWORD_LENGTH
    assert app.security.password.MIN_PASSWORD_LENGTH == 8


def test_a_reset_token_is_random_and_only_its_hash_is_kept():
    first, second = new_reset_token(), new_reset_token()
    assert first != second
    assert len(first) >= 43  # token_urlsafe(32)
    assert hash_reset_token(first) != first
    assert len(hash_reset_token(first)) == 64  # SHA-256 hex


def test_a_link_lives_for_24_hours():
    assert RESET_LIFETIME == timedelta(hours=24)


async def test_the_database_refuses_two_live_links_for_one_user(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    await create_password_reset(db_session, user=user, created_by=admin)

    with pytest.raises(IntegrityError, match="uq_password_reset_tokens_one_live_per_user"):
        await create_password_reset(db_session, user=user, created_by=admin)
    await db_session.rollback()


async def test_used_and_revoked_links_do_not_count_as_live(db_session):
    """部分唯一索引的述詞要兩個條件都在：只寫 `used_at IS NULL` 的話，撤銷過的那條
    會擋住新的（產生新連結的流程就是「先撤銷、再插入」）。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    await create_password_reset(db_session, user=user, created_by=admin, used=True)
    await create_password_reset(db_session, user=user, created_by=admin, revoked=True)
    live, _ = await create_password_reset(db_session, user=user, created_by=admin)
    assert live.id is not None


async def test_the_database_refuses_a_link_both_used_and_revoked(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    now = datetime.now(UTC)
    db_session.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash=hash_reset_token(new_reset_token()),
            created_by=admin.id,
            created_at=now,
            expires_at=now + RESET_LIFETIME,
            used_at=now,
            revoked_at=now,
        )
    )
    with pytest.raises(IntegrityError, match="not_both_used_and_revoked"):
        await db_session.commit()
    await db_session.rollback()


async def test_the_database_refuses_a_link_that_expires_before_it_was_created(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    now = datetime.now(UTC)
    with pytest.raises(IntegrityError, match="expires_after_created"):
        await create_password_reset(
            db_session, user=user, created_by=admin, created_at=now, expires_at=now
        )
    await db_session.rollback()
```

`tests/factories.py` 加（import 補 `from app.models.password_reset import PasswordResetToken` 與
`from app.password_resets import RESET_LIFETIME, hash_reset_token, new_reset_token`）：

```python
async def create_password_reset(
    db_session: AsyncSession,
    *,
    user: User,
    created_by: User,
    created_at: datetime | None = None,
    expires_at: datetime | None = None,
    used: bool = False,
    revoked: bool = False,
) -> tuple[PasswordResetToken, str]:
    """建立一條重設連結，回傳（連結, 明碼）——同 `create_invite`，明碼只存在回傳值裡。

    過期的連結要連 `created_at` 一起往前推：`CHECK (expires_at > created_at)`。"""
    token = new_reset_token()
    created = created_at or datetime.now(UTC)
    reset = PasswordResetToken(
        user_id=user.id,
        token_hash=hash_reset_token(token),
        created_by=created_by.id,
        created_at=created,
        expires_at=expires_at or created + RESET_LIFETIME,
        used_at=created if used else None,
        revoked_at=created if revoked else None,
    )
    db_session.add(reset)
    await db_session.commit()
    await db_session.refresh(reset)
    return reset, token
```

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_password_reset_model.py -q
```

Expected：收集失敗（`ModuleNotFoundError: app.models.password_reset`）。

- [ ] **Step 3: 實作**

`app/security/password.py` 檔頭（`_hasher` 之前）加：

```python
# 密碼長度（帳號設定規格決定 20）。CLI、註冊、改密碼、重設密碼共用這一份。
# 原本只定義在 app/cli.py；schema 要用它，而 schema 不該 import app.cli（會帶進資料庫連線
# 與照片儲存）。上限跟 Argon2 無關（見 RegisterRequest 的說明），是請求體衛生。
MIN_PASSWORD_LENGTH = 8
MAX_PASSWORD_LENGTH = 128
```

`app/cli.py`：刪掉 `MIN_PASSWORD_LENGTH = 8` 那一行，import 改成
`from app.security.password import MIN_PASSWORD_LENGTH, hash_password`（名字留在 `app.cli` 裡，既有的引用不用改）。

`app/schemas/auth.py`：`RegisterRequest.password` 改成
`Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)`（import 自 `app.security.password`；數字不變，OpenAPI 應該不變）。

`app/models/password_reset.py`：

```python
from datetime import datetime

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Identity,
    Index,
    Text,
    func,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class PasswordResetToken(Base):
    """管理員產生的一次性重設密碼連結（帳號設定規格 §4.1）。

    跟 `Invite` 同一個形狀：只存 `token_hash`（SHA-256 hex）；「用掉」「撤銷」「過期」
    是三個獨立欄位（過期由時間決定，不是一次寫入）。
    """

    __tablename__ = "password_reset_tokens"
    __table_args__ = (
        # name= 是命名慣例的輸入，最終名稱 ck_password_reset_tokens_…（handover §7）。
        CheckConstraint("expires_at > created_at", name="expires_after_created"),
        CheckConstraint(
            "used_at IS NULL OR revoked_at IS NULL", name="not_both_used_and_revoked"
        ),
        # **一個人最多一條活連結**（規格決定 14）。產生端點先 FOR UPDATE 那個使用者、
        # 撤銷舊的再插新的——那是程式碼；這個索引讓資料庫再保證一次，哪天流程被改壞，
        # 是一個大聲的 IntegrityError，不是兩條都能用的連結。user_id 當前導欄位，
        # 同時服務「撤銷這個人的活連結」與 ON DELETE CASCADE 的查找。
        # 述詞要跟 migration 一字不差，否則 alembic check 報漂移。
        Index(
            "uq_password_reset_tokens_one_live_per_user",
            "user_id",
            unique=True,
            postgresql_where=text("used_at IS NULL AND revoked_at IS NULL"),
        ),
    )

    id: Mapped[int] = mapped_column(BigInteger, Identity(always=True), primary_key=True)
    user_id: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    token_hash: Mapped[str] = mapped_column(Text, unique=True, nullable=False)
    created_by: Mapped[int] = mapped_column(
        BigInteger, ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    used_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
```

`app/models/__init__.py`：import 並加進 `__all__`（照字母順序放在 `MealType` 之後）。

`migrations/versions/0016_create_password_reset_tokens.py`：

```python
"""create password reset tokens

Revision ID: 0016
Revises: 0015
"""

from collections.abc import Sequence

import sqlalchemy as sa
from alembic import op

revision: str = "0016"
down_revision: str | None = "0015"
branch_labels: Sequence[str] | None = None
depends_on: Sequence[str] | None = None


def upgrade() -> None:
    op.create_table(
        "password_reset_tokens",
        sa.Column("id", sa.BigInteger, sa.Identity(always=True), nullable=False),
        sa.Column("user_id", sa.BigInteger, nullable=False),
        sa.Column("token_hash", sa.Text, nullable=False),
        sa.Column("created_by", sa.BigInteger, nullable=False),
        sa.Column(
            "created_at",
            sa.DateTime(timezone=True),
            nullable=False,
            server_default=sa.func.now(),
        ),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("used_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.PrimaryKeyConstraint("id", name="pk_password_reset_tokens"),
        sa.UniqueConstraint("token_hash", name="uq_password_reset_tokens_token_hash"),
        sa.ForeignKeyConstraint(
            ["user_id"],
            ["users.id"],
            name="fk_password_reset_tokens_user_id_users",
            ondelete="CASCADE",
        ),
        sa.ForeignKeyConstraint(
            ["created_by"],
            ["users.id"],
            name="fk_password_reset_tokens_created_by_users",
            ondelete="CASCADE",
        ),
        # name= 是命名慣例的輸入（同 0011）。
        sa.CheckConstraint("expires_at > created_at", name="expires_after_created"),
        sa.CheckConstraint(
            "used_at IS NULL OR revoked_at IS NULL", name="not_both_used_and_revoked"
        ),
    )
    # 述詞必須跟模型一字不差（同 0007 的說明）。
    op.create_index(
        "uq_password_reset_tokens_one_live_per_user",
        "password_reset_tokens",
        ["user_id"],
        unique=True,
        postgresql_where=sa.text("used_at IS NULL AND revoked_at IS NULL"),
    )


def downgrade() -> None:
    op.drop_table("password_reset_tokens")
```

`app/password_resets.py`：

```python
"""管理員產生的一次性重設密碼連結（帳號設定規格 §3.4–3.6）。

跟 `app/invites.py` 同一個形狀：明碼只在產生的當下存在、資料庫只存 SHA-256；「還能用」的
條件只寫一次，查詢與條件式 UPDATE 共用。用 SHA-256 而不是 Argon2 的理由也相同：256 位元的
亂數沒有字典可查，而查詢要拿雜湊值走唯一索引。
"""

import hashlib
import secrets
from datetime import timedelta

from sqlalchemy import ColumnElement, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.models.password_reset import PasswordResetToken

# 比邀請的 7 天短：握著這條連結就等於握著那個帳號（規格決定 13）。
RESET_LIFETIME = timedelta(hours=24)

RESET_INVALID_MESSAGE = "這個重設密碼連結已經失效，請跟管理員要一個新的"


def new_reset_token() -> str:
    """256 位元的亂數，URL 安全（放在 `/reset-password#` 後面）。"""
    return secrets.token_urlsafe(32)


def hash_reset_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


def _still_usable() -> tuple[ColumnElement[bool], ...]:
    """查詢與條件式 UPDATE 共用（理由同 `app/invites.py` 的 `_still_usable`）。
    `func.now()` 是交易開始的時間：同一個重設交易裡，查與兌換用同一個「現在」。"""
    return (
        PasswordResetToken.used_at.is_(None),
        PasswordResetToken.revoked_at.is_(None),
        PasswordResetToken.expires_at > func.now(),
    )


async def find_usable_reset(db: AsyncSession, token: str) -> PasswordResetToken | None:
    reset: PasswordResetToken | None = await db.scalar(
        select(PasswordResetToken).where(
            PasswordResetToken.token_hash == hash_reset_token(token), *_still_usable()
        )
    )
    return reset


async def redeem_reset(db: AsyncSession, reset_id: int) -> int | None:
    """把連結標成已使用，回傳那條連結的 `user_id`；已經不能用了回 None。**不 commit**——
    跟改密碼、撤銷 session 在同一個交易裡（規格 §3.6 步驟 3）。

    條件寫在 UPDATE 的 WHERE 裡（同 `redeem_invite`）：兩個請求同時用同一條連結，第二個
    等第一個的列鎖，第一個 commit 之後重新評估 WHERE → 0 列。"""
    user_id: int | None = await db.scalar(
        update(PasswordResetToken)
        .where(PasswordResetToken.id == reset_id, *_still_usable())
        .values(used_at=func.now())
        .returning(PasswordResetToken.user_id)
    )
    return user_id


async def revoke_live_resets(db: AsyncSession, user_id: int) -> None:
    """撤銷這個人所有還沒用、還沒撤銷的連結——**包括已經過期的**（部分唯一索引只看
    `used_at`／`revoked_at`，不看時間；過期沒撤銷的那條仍會擋住新的）。**不 commit。**

    兩個呼叫者：產生新連結（先撤銷再插入）、使用者自己改了密碼（管理員之前產生的連結不該還能用）。"""
    await db.execute(
        update(PasswordResetToken)
        .where(
            PasswordResetToken.user_id == user_id,
            PasswordResetToken.used_at.is_(None),
            PasswordResetToken.revoked_at.is_(None),
        )
        .values(revoked_at=func.now())
    )
```

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：`7 passed`；session 開頭的 `alembic check` 沒有報漂移。

- [ ] **Step 5: migration 來回一次**（handover §6 第 29 種：寫了 `downgrade()` 就要真的跑）：

```bash
export DATABASE_URL="postgresql+asyncpg://wallet:wallet@localhost:5433/wallet_test"
./.venv/Scripts/python.exe -m alembic downgrade -1 && ./.venv/Scripts/python.exe -m alembic upgrade head && ./.venv/Scripts/python.exe -m alembic check
unset DATABASE_URL
```

Expected：`Running downgrade 0016 -> 0015`、`Running upgrade 0015 -> 0016`、`No new upgrade operations detected.`

- [ ] **Step 6: 突變**（每個改完跑 Step 2 的指令，確認紅，再改回）：
  - 模型**與** migration 的述詞都改成 `"used_at IS NULL"` → `test_used_and_revoked_links_do_not_count_as_live` 紅（`IntegrityError`：撤銷過的那條擋住了）。這一條的紅是 `IntegrityError` 從 factory 冒出來——它要守的正是「不該撞上」，紅的原因對。
  - `app/cli.py` 改回自己定義 `MIN_PASSWORD_LENGTH = 8` → `test_the_minimum_password_length_has_one_definition` 紅（`is` 不成立）。

- [ ] **Step 7: 全部後端、ruff、mypy，重新產生 `schema.d.ts`**

```
./.venv/Scripts/python.exe -m pytest -q
./.venv/Scripts/python.exe -m ruff check app tests migrations
./.venv/Scripts/python.exe -m mypy app
```

Expected：852 passed（845 + 7）；ruff、mypy 乾淨。重新產生 `schema.d.ts`（指令見「執行環境」）→ `git diff --stat frontend/src/api/schema.d.ts` **應該是空的**（`RegisterRequest` 的數字沒變）。不是空的就照實回報差在哪。

- [ ] **Step 8: Commit**

```
feat(backend): 重設密碼連結的資料表與規則模組

password_reset_tokens 只存 SHA-256、24 小時；部分唯一索引保證一個人最多一條活連結，
CHECK 擋「用掉又撤銷」。規則（產生、雜湊、還能用、兌換、撤銷某人的活連結）集中在
app/password_resets.py。密碼長度常數搬到 app/security/password.py，CLI 與註冊共用。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/security/password.py app/cli.py app/schemas/auth.py app/models/password_reset.py app/models/__init__.py migrations/versions/0016_create_password_reset_tokens.py app/password_resets.py tests/factories.py tests/test_password_reset_model.py
git commit -F "$S/commit-msg.txt"
```

（`schema.d.ts` 沒有差異就不用 add。）

---

## Task 2：後端——`PUT /api/targets/today`

**Files:**
- Create: `tests/test_targets_today.py`
- Modify: `app/schemas/target.py`、`app/api/routes/targets.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試** `tests/test_targets_today.py`：

```python
"""`PUT /api/targets/today`：從使用者的今天起生效，過去的日子不變（規格 §3.1）。

「今天」一律 monkeypatch `app.api.routes.targets.today_in_timezone`：
固定日期（不是執行日——handover §6 第 22 種），並記下它收到的時區（第 2 種）。
"""

from datetime import date
from decimal import Decimal

import pytest
from sqlalchemy import select

from app.models.target import UserTarget
from app.security.tokens import create_access_token
from tests.factories import create_target, create_user

TODAY = date(2019, 7, 4)
YESTERDAY = date(2019, 7, 3)
BODY = {"kcal": "1800", "protein_g": "120", "fat_g": None, "carb_g": None}


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


@pytest.fixture
def seen_timezones(monkeypatch) -> list[str]:
    seen: list[str] = []

    def fake_today(tz_name: str) -> date:
        seen.append(tz_name)
        return TODAY

    monkeypatch.setattr("app.api.routes.targets.today_in_timezone", fake_today)
    return seen


async def _rows(db_session, user_id: int) -> list[tuple]:
    rows = (
        await db_session.scalars(
            select(UserTarget)
            .where(UserTarget.user_id == user_id)
            .order_by(UserTarget.effective_from)
        )
    ).all()
    return [
        (r.effective_from, r.effective_to, r.kcal, r.protein_g, r.fat_g, r.carb_g, r.label)
        for r in rows
    ]


async def test_an_earlier_target_is_closed_and_a_new_one_starts_today(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=2000, protein_g=100, label="減脂期",
        effective_from=date(2019, 1, 1),
    )
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    body = response.json()
    assert (body["effective_from"], body["effective_to"]) == ("2019-07-04", None)
    assert (body["kcal"], body["protein_g"], body["fat_g"]) == ("1800.00", "120.00", None)
    assert body["label"] == "減脂期"  # 沿用
    await db_session.rollback()  # 第 11 種：關閉與新列都要真的 commit 了
    assert await _rows(db_session, user_id) == [
        (date(2019, 1, 1), TODAY, Decimal("2000.00"), Decimal("100.00"), None, None, "減脂期"),
        (TODAY, None, Decimal("1800.00"), Decimal("120.00"), None, None, "減脂期"),
    ]


async def test_yesterday_keeps_the_old_target_and_today_has_the_new_one(
    client, db_session, seen_timezones
):
    """規格的核心保證：趨勢與歷史用的是「那一天生效的目標」。"""
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000, effective_from=date(2019, 1, 1))
    user_id = user.id

    await client.put("/api/targets/today", headers=auth(user_id), json=BODY)
    await db_session.rollback()

    yesterday = await client.get(f"/api/stats/daily?date={YESTERDAY}", headers=auth(user_id))
    today = await client.get(f"/api/stats/daily?date={TODAY}", headers=auth(user_id))
    assert yesterday.json()["target"]["kcal"] == "2000.00"
    assert today.json()["target"]["kcal"] == "1800.00"


async def test_saving_again_on_the_same_day_edits_todays_row_in_place(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2000, effective_from=date(2019, 1, 1))
    user_id = user.id

    first = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)
    second = await client.put(
        "/api/targets/today",
        headers=auth(user_id),
        json={"kcal": "1900", "protein_g": None, "fat_g": "60", "carb_g": None},
    )

    assert second.status_code == 200
    assert second.json()["id"] == first.json()["id"]
    await db_session.rollback()
    assert await _rows(db_session, user_id) == [
        (date(2019, 1, 1), TODAY, Decimal("2000.00"), None, None, None, None),
        (TODAY, None, Decimal("1900.00"), None, Decimal("60.00"), None, None),
    ]


async def test_without_any_target_a_new_open_ended_one_starts_today(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    await db_session.rollback()
    assert await _rows(db_session, user_id) == [
        (TODAY, None, Decimal("1800.00"), Decimal("120.00"), None, None, None),
    ]


async def test_a_future_target_bounds_the_new_period(client, db_session, seen_timezones):
    """畫面造不出未來的期間，API 造得出來；不算結束日的話，存一次就撞期（規格決定 3）。"""
    user = await create_user(db_session)
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2019, 8, 1))
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    assert response.json()["effective_to"] == "2019-08-01"


async def test_a_bounded_current_target_passes_its_end_to_the_new_period(
    client, db_session, seen_timezones
):
    user = await create_user(db_session)
    await create_target(
        db_session, user=user, kcal=2000,
        effective_from=date(2019, 1, 1), effective_to=date(2019, 8, 1),
    )
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2019, 8, 1))
    user_id = user.id

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 200
    await db_session.rollback()
    assert [(r[0], r[1]) for r in await _rows(db_session, user_id)] == [
        (date(2019, 1, 1), TODAY),
        (TODAY, date(2019, 8, 1)),
        (date(2019, 8, 1), None),
    ]


async def test_today_is_the_users_today_not_the_servers(client, db_session, seen_timezones):
    user = await create_user(db_session)
    user.timezone = "America/New_York"
    await db_session.commit()
    user_id = user.id

    await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert seen_timezones == ["America/New_York"]


@pytest.mark.parametrize(
    "patch",
    [
        {"kcal": "0"},
        {"kcal": "-1"},
        {"kcal": "20000.01"},
        {"protein_g": "2000.01"},
        {"fat_g": "12.345"},
        {"carb_g": "abc"},
    ],
)
async def test_bad_values_are_422_and_write_nothing(client, db_session, seen_timezones, patch):
    user = await create_user(db_session)
    user_id = user.id

    response = await client.put(
        "/api/targets/today", headers=auth(user_id), json={**BODY, **patch}
    )

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"
    await db_session.rollback()
    assert await _rows(db_session, user_id) == []


@pytest.mark.parametrize("missing", ["kcal", "protein_g", "fat_g", "carb_g"])
async def test_every_key_must_be_sent(client, db_session, seen_timezones, missing):
    """PUT＝整組取代：省略不能悄悄變成「沿用」（規格決定 4）。"""
    user = await create_user(db_session)
    body = {k: v for k, v in BODY.items() if k != missing}

    response = await client.put("/api/targets/today", headers=auth(user.id), json=body)

    assert response.status_code == 422


async def test_the_upper_bounds_themselves_are_accepted(client, db_session, seen_timezones):
    user = await create_user(db_session)
    response = await client.put(
        "/api/targets/today",
        headers=auth(user.id),
        json={"kcal": "20000", "protein_g": "2000", "fat_g": "0.01", "carb_g": "2000.00"},
    )
    assert response.status_code == 200


async def test_requires_authentication(client):
    response = await client.put("/api/targets/today", json=BODY)
    assert response.status_code == 401


@pytest.mark.parametrize("with_current", [True, False])
async def test_a_clash_is_409_and_writes_nothing(
    client, db_session, seen_timezones, monkeypatch, with_current
):
    """並行時才會發生的撞期，用接縫造出來：讓新期間「不結束」，插入就撞上後面那筆。
    有目前的期間時，**關閉也必須一起 rollback**——否則留下「舊的關了、新的沒開」。"""
    user = await create_user(db_session)
    if with_current:
        await create_target(
            db_session, user=user, kcal=2000,
            effective_from=date(2019, 1, 1), effective_to=date(2019, 8, 1),
        )
    await create_target(db_session, user=user, kcal=2500, effective_from=date(2019, 8, 1))
    user_id = user.id
    await db_session.rollback()
    before = await _rows(db_session, user_id)

    async def never_ends(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.api.routes.targets._new_period_end", never_ends)

    response = await client.put("/api/targets/today", headers=auth(user_id), json=BODY)

    assert response.status_code == 409
    assert response.json()["error"]["code"] == "TARGET_CONFLICT"
    await db_session.rollback()
    assert await _rows(db_session, user_id) == before
```

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_targets_today.py -q
```

Expected：**全部 FAIL**。`/targets/today` 的路徑對得上既有的 `PATCH /targets/{target_id}`（`today` 被當成 path 參數），方法不對 → 405；所以斷言 200、409、422、401 的每一條都紅（包括 `test_bad_values…` 與 `test_every_key_must_be_sent`：405 ≠ 422）。有任何一條在實作前是綠的 → 照實回報是哪條、為什麼。

- [ ] **Step 3: 實作**

`app/schemas/target.py` 加：

```python
class TargetTodayRequest(BaseModel):
    """`PUT /api/targets/today`（帳號設定規格 §3.1）：從使用者時區的今天起，目標是這四個值。

    **四個鍵都必須送**（PUT＝整組取代）：沒有 default 的 `Field(...)` 在 Pydantic v2 是必填，
    值可以是 null（＝不設定）。「省略＝沿用」是 PATCH 的語意，表單送的是整組，混用會讓「清空
    一格」悄悄變成「沿用」。

    **值必須 > 0**（既有的 POST／PATCH 是 `ge=0`，不動）：0 的目標算不出比例（stats 回
    null），畫面上跟「未設定」分不出來。上限沿用 `_MAX_KCAL`／`_MAX_GRAMS`。
    """

    kcal: Decimal | None = Field(gt=0, le=_MAX_KCAL, max_digits=8, decimal_places=2)
    protein_g: Decimal | None = Field(gt=0, le=_MAX_GRAMS, max_digits=8, decimal_places=2)
    fat_g: Decimal | None = Field(gt=0, le=_MAX_GRAMS, max_digits=8, decimal_places=2)
    carb_g: Decimal | None = Field(gt=0, le=_MAX_GRAMS, max_digits=8, decimal_places=2)
```

`app/api/routes/targets.py`：import 補 `from sqlalchemy import func, or_, select`、`TargetTodayRequest`；
在 `list_or_get_target` 之後、`_load_owned_target` 之前加：

```python
async def _new_period_end(
    db: AsyncSession, user_id: int, today: date, current: UserTarget | None
) -> date | None:
    """新期間在哪一天結束（規格決定 3）：有目前的期間就沿用它的結束日；沒有就是下一筆
    未來期間的開始日，再沒有就開放式。

    抽成函式也是測試的接縫：讓它回 None 就造得出「插入撞上別的期間」——平常只有兩台裝置
    同時存才會發生（`test_a_clash_is_409_and_writes_nothing`）。"""
    if current is not None:
        return current.effective_to
    next_start: date | None = await db.scalar(
        select(func.min(UserTarget.effective_from)).where(
            UserTarget.user_id == user_id, UserTarget.effective_from > today
        )
    )
    return next_start


@router.put("/today", response_model=TargetResponse)
async def set_target_from_today(
    payload: TargetTodayRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TargetResponse:
    """從使用者的今天起，目標是這四個值；過去的日子維持原本的目標（帳號設定規格 §3.1）。

    「今天」由後端算（`today_in_timezone`）——前端不能自己算日界線。三種狀態一個端點：

    - **今天才開始的那一筆：原地改。** 期間是 `[from, to)`，它還沒有任何「過去的一天」，
      改它不會改寫歷史（§4.4 的「舊列數值永遠不動」保護的是過去的日子）。`PATCH` 做不到
      這件事——新的生效日 ≤ 舊的生效日會 422。
    - **更早開始的：關閉＋開新**，順序同 `update_target`（先 flush 關閉，EXCLUDE 才看得到）。
    - **沒有：開一筆新的。**

    並行不加鎖：資料庫的 EXCLUDE 保證不重疊，輸的一方整筆 rollback、409，重存一次就會走
    「原地改」（規格決定 5）。
    """
    today = today_in_timezone(user.timezone)
    values = {
        "kcal": payload.kcal,
        "protein_g": payload.protein_g,
        "fat_g": payload.fat_g,
        "carb_g": payload.carb_g,
    }

    current = await db.scalar(
        select(UserTarget).where(
            UserTarget.user_id == user.id,
            UserTarget.effective_from <= today,
            or_(UserTarget.effective_to.is_(None), UserTarget.effective_to > today),
        )
    )

    if current is not None and current.effective_from == today:
        for field, value in values.items():
            setattr(current, field, value)
        await db.commit()
        await db.refresh(current)
        return _to_response(current)

    new_effective_to = await _new_period_end(db, user.id, today, current)
    label = current.label if current is not None else None
    if current is not None:
        current.effective_to = today
        await db.flush()  # 1. 先關舊的——順序不能換，見 update_target

    new_target = UserTarget(
        user_id=user.id,
        label=label,
        effective_from=today,
        effective_to=new_effective_to,
        **values,
    )
    db.add(new_target)
    try:
        await db.flush()  # 2. 再開新的
    except IntegrityError as exc:
        # rollback 連上面的關閉一起復原：不會留下「舊的關了、新的沒開」。
        await db.rollback()
        raise ConflictError(
            "TARGET_CONFLICT", "目標剛被另一台裝置改過，請重新整理再試"
        ) from exc

    await db.commit()
    await db.refresh(new_target)
    return _to_response(new_target)
```

（`UserTarget(**values)` 讓 mypy 抱怨的話，四個欄位逐一寫出來。）

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：全部 PASS（條數照實回報）。

- [ ] **Step 5: 突變**（每個改完跑 Step 2，確認紅，再改回）：
  - 拿掉「今天才開始→原地改」那個 `if`（改成 `if False and …`）→ `test_saving_again_on_the_same_day…` 紅。**紅的形狀是 `IntegrityError`（`ck_user_targets_effective_range`，關閉時 `effective_to = effective_from`）從 `client.put` 冒出來**（第 31 種）——它守的正是「同一天第二次存不能壞」，紅的原因對。
  - 「更早開始的」那條改成原地改（`if current is not None:` 就原地改）→ `test_yesterday_keeps_the_old_target…` 紅（昨天的分母變 1800）。
  - `today_in_timezone(user.timezone)` 改成 `today_in_timezone("UTC")` → `test_today_is_the_users_today…` 紅。
  - 關閉那一步的 `await db.flush()` 改成 `await db.commit()` → `test_a_clash_is_409…[True]` 紅（關閉沒有一起 rollback）。
  - `_new_period_end` 的「下一筆未來期間」改成 `return None` → `test_a_future_target_bounds_the_new_period` 紅（撞期 409）。
  - `label = …` 改成 `label = None` → `test_an_earlier_target_is_closed…` 紅。
  - `TargetTodayRequest.kcal` 的 `gt=0` 改成 `ge=0` → `test_bad_values…[patch0]` 紅。

- [ ] **Step 6: 全部後端、ruff、mypy、重新產生 `schema.d.ts`**

Expected：全綠（852 + 本 task 的條數）；`schema.d.ts` 多了 `/api/targets/today` 的 `put` 與 `TargetTodayRequest`。在 `frontend/` 跑 `npm run -s typecheck`，Expected：乾淨。

- [ ] **Step 7: Commit**

```
feat(backend): PUT /api/targets/today——目標從今天起生效

後端用使用者時區算今天：今天才開始的那筆原地改，更早開始的關閉再開新的，沒有就開一筆；
新期間沿用目前那筆的結束日或下一筆未來期間的開始日。值必須 > 0、四個鍵都要送。
撞期整筆 rollback、409 TARGET_CONFLICT。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/target.py app/api/routes/targets.py tests/test_targets_today.py frontend/src/api/schema.d.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 3：後端——`POST /api/me/password`、讓 `app.*` 的 INFO 真的輸出

**Files:**
- Create: `tests/test_change_password.py`、`tests/test_logging_setup.py`
- Modify: `app/main.py`、`app/schemas/user.py`、`app/api/routes/me.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_logging_setup.py`：

```python
"""稽核紀錄寫 INFO（規格決定 17）。uvicorn 的預設設定只替 uvicorn.* 掛 handler——
`app.*` 的 INFO 會落到 Python 的 lastResort（只輸出 WARNING 以上），寫了等於沒寫。"""

import logging

import app.main  # noqa: F401 — 設定在 import app.main 時發生


def test_app_loggers_emit_info():
    logger = logging.getLogger("app.api.routes.me")
    assert logger.isEnabledFor(logging.INFO)


def test_the_app_logger_has_its_own_handler():
    # 沒有 handler 的話，INFO 一路往上找不到任何 handler，最後交給 lastResort（WARNING）。
    assert logging.getLogger("app").handlers
```

`tests/test_change_password.py`：

```python
"""`POST /api/me/password`（規格 §3.2）。"""

import logging
import threading

import pytest
from sqlalchemy import select

from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.ratelimit import PER_EMAIL_LIMIT
from app.security.password import hash_password, verify_password
from tests.factories import DEFAULT_PASSWORD, create_password_reset, create_user

NEW_PASSWORD = "a-brand-new-password"


async def _login(client, email: str, password: str = DEFAULT_PASSWORD):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def _tokens(client, email: str) -> dict[str, str]:
    response = await _login(client, email)
    assert response.status_code == 200
    return response.json()


def _bearer(access_token: str) -> dict[str, str]:
    return {"Authorization": f"Bearer {access_token}"}


async def _change(client, access_token: str, current: str = DEFAULT_PASSWORD, new: str = NEW_PASSWORD):
    return await client.post(
        "/api/me/password",
        headers=_bearer(access_token),
        json={"current_password": current, "new_password": new},
    )


async def test_every_other_device_is_logged_out_and_this_one_gets_new_tokens(client, db_session):
    user = await create_user(db_session)
    email = user.email
    phone = await _tokens(client, email)
    laptop = await _tokens(client, email)

    response = await _change(client, phone["access_token"])

    assert response.status_code == 200
    fresh = response.json()
    assert fresh["refresh_token"] not in (phone["refresh_token"], laptop["refresh_token"])
    # 第 11 種：撤銷與新 session 都必須真的 commit 了。
    await db_session.rollback()
    for old in (phone, laptop):
        replay = await client.post("/api/auth/refresh", json={"refresh_token": old["refresh_token"]})
        assert replay.status_code == 401
    renewed = await client.post("/api/auth/refresh", json={"refresh_token": fresh["refresh_token"]})
    assert renewed.status_code == 200


async def test_only_the_new_password_works_afterwards(client, db_session):
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)

    await _change(client, tokens["access_token"])
    await db_session.rollback()

    assert (await _login(client, email)).status_code == 401
    assert (await _login(client, email, NEW_PASSWORD)).status_code == 200


async def test_a_wrong_current_password_is_422_and_changes_nothing(client, db_session):
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)

    response = await _change(client, tokens["access_token"], current="not-my-password")

    # **不是 401**：client.ts 對 401 會換票並重送一次——錯的密碼會被驗兩次、算兩次失敗。
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "CURRENT_PASSWORD_INCORRECT"
    await db_session.rollback()
    assert (await _login(client, email)).status_code == 200
    still = await client.post("/api/auth/refresh", json={"refresh_token": tokens["refresh_token"]})
    assert still.status_code == 200


async def test_the_same_password_is_422_without_running_argon2(client, db_session, monkeypatch):
    user = await create_user(db_session)
    tokens = await _tokens(client, user.email)
    calls: list[str] = []

    def spy(password: str, password_hash: str) -> bool:
        calls.append(password)
        return verify_password(password, password_hash)

    monkeypatch.setattr("app.api.routes.me.verify_password", spy)

    response = await _change(client, tokens["access_token"], new=DEFAULT_PASSWORD)

    assert response.status_code == 422
    assert response.json()["error"]["code"] == "PASSWORD_UNCHANGED"
    assert calls == []


async def test_change_password_and_login_share_one_guessing_budget(client, db_session, monkeypatch):
    """偷到 access token 的人不能多一扇猜密碼的門（規格決定 9）。"""
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)  # 成功登入會重置計數，所以先登入
    for _ in range(PER_EMAIL_LIMIT - 2):
        assert (await _login(client, email, "wrong-password")).status_code == 401
    for _ in range(2):
        assert (await _change(client, tokens["access_token"], current="wrong")).status_code == 422

    calls: list[str] = []

    def spy(password: str, password_hash: str) -> bool:
        calls.append(password)
        return verify_password(password, password_hash)

    monkeypatch.setattr("app.api.routes.me.verify_password", spy)

    blocked = await _change(client, tokens["access_token"])

    assert blocked.status_code == 429
    assert blocked.json()["error"]["code"] == "TOO_MANY_LOGIN_ATTEMPTS"
    assert blocked.headers["retry-after"]
    assert calls == []  # 被擋的請求不跑 Argon2
    # 反方向也共用：改密碼的失敗讓登入也被擋。
    assert (await _login(client, email)).status_code == 429


async def test_a_correct_current_password_resets_the_budget(client, db_session):
    user = await create_user(db_session)
    email = user.email
    tokens = await _tokens(client, email)
    for _ in range(PER_EMAIL_LIMIT - 1):
        await _change(client, tokens["access_token"], current="wrong")

    assert (await _change(client, tokens["access_token"])).status_code == 200
    await db_session.rollback()
    for _ in range(PER_EMAIL_LIMIT - 1):
        assert (await _login(client, email, "wrong-password")).status_code == 401


async def test_unused_reset_links_are_revoked(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    reset, _ = await create_password_reset(db_session, user=user, created_by=admin)
    reset_id = reset.id
    tokens = await _tokens(client, user.email)

    await _change(client, tokens["access_token"])
    await db_session.rollback()

    stored = await db_session.scalar(
        select(PasswordResetToken).where(PasswordResetToken.id == reset_id)
    )
    assert stored is not None and stored.revoked_at is not None


async def test_argon2_runs_in_the_threadpool(client, db_session, monkeypatch):
    user = await create_user(db_session)
    tokens = await _tokens(client, user.email)
    main_thread = threading.get_ident()
    seen: list[int] = []

    def verify_spy(password: str, password_hash: str) -> bool:
        seen.append(threading.get_ident())
        return verify_password(password, password_hash)

    def hash_spy(password: str) -> str:
        seen.append(threading.get_ident())
        return hash_password(password)

    monkeypatch.setattr("app.api.routes.me.verify_password", verify_spy)
    monkeypatch.setattr("app.api.routes.me.hash_password", hash_spy)

    assert (await _change(client, tokens["access_token"])).status_code == 200
    assert len(seen) == 2
    assert main_thread not in seen


@pytest.mark.parametrize(
    "body",
    [
        {"current_password": DEFAULT_PASSWORD, "new_password": "short7!"},
        {"current_password": DEFAULT_PASSWORD, "new_password": "x" * 129},
        {"current_password": "", "new_password": NEW_PASSWORD},
        {"new_password": NEW_PASSWORD},
    ],
)
async def test_bad_bodies_are_422(client, db_session, body):
    user = await create_user(db_session)
    tokens = await _tokens(client, user.email)
    response = await client.post(
        "/api/me/password", headers=_bearer(tokens["access_token"]), json=body
    )
    assert response.status_code == 422
    assert response.json()["error"]["code"] == "VALIDATION_ERROR"


async def test_requires_authentication(client):
    response = await client.post(
        "/api/me/password",
        json={"current_password": DEFAULT_PASSWORD, "new_password": NEW_PASSWORD},
    )
    assert response.status_code == 401


async def test_the_change_is_audited_without_secrets(client, db_session, caplog):
    user = await create_user(db_session)
    user_id, email = user.id, user.email
    tokens = await _tokens(client, email)
    caplog.set_level(logging.INFO, logger="app")

    await _change(client, tokens["access_token"])

    assert f"使用者 {user_id} 修改了密碼" in caplog.text
    for secret in (DEFAULT_PASSWORD, NEW_PASSWORD, email):
        assert secret not in caplog.text
```

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_change_password.py tests/test_logging_setup.py -q
```

Expected：`test_logging_setup.py` 兩條 FAIL（`isEnabledFor(INFO)` 是 False、沒有 handler）；`test_change_password.py` 的端點測試 FAIL（`/api/me/password` 不存在 → 404 `HTTP_ERROR` 或 405）。`test_requires_authentication` 也紅（404 ≠ 401）。

- [ ] **Step 3: 實作**

`app/main.py`：`from fastapi import FastAPI` 之前 `import logging`；`app = FastAPI(...)` 之前加：

```python
# 稽核紀錄（帳號設定規格決定 17）：uvicorn 的預設設定只替 uvicorn.* 掛 handler，
# app.* 的 INFO 會落到 Python 的 lastResort（只輸出 WARNING 以上）——實測看不到。
# 這裡讓 app.* 自己輸出 INFO。propagate 照舊：root 沒有 handler 時不會重複印；
# pytest 的 caplog 掛在 root，照樣收得到。
_app_logger = logging.getLogger("app")
_app_logger.setLevel(logging.INFO)
if not _app_logger.handlers:
    _handler = logging.StreamHandler()
    _handler.setFormatter(logging.Formatter("%(levelname)s:     %(name)s: %(message)s"))
    _app_logger.addHandler(_handler)
```

`app/schemas/user.py` 加（import `Field` 已有；補 `from app.models.user import UserRole`、
`from app.security.password import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH`）：

```python
class ChangePasswordRequest(BaseModel):
    """`POST /api/me/password`（帳號設定規格 §3.2）。

    `current_password` 只擋空字串與過長：CLI 建的密碼沒有上限，這裡給寬一點（1024），
    驗證交給 Argon2；不要套新密碼的規則，否則規則改了之後舊密碼連「目前的密碼」都填不進來。
    """

    current_password: str = Field(min_length=1, max_length=1024)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)
```

（`AdminUserItem` 在 Task 4 才加。）

`app/api/routes/me.py`：

```python
import logging

from fastapi import APIRouter, Depends
from sqlalchemy.ext.asyncio import AsyncSession
from starlette.concurrency import run_in_threadpool

from app.api.deps import get_current_user
from app.db import get_db
from app.errors import UnprocessableEntityError
from app.models.user import User
from app.password_resets import revoke_live_resets
from app.ratelimit import login_rate_limiter
from app.schemas.auth import TokenResponse, UserResponse
from app.schemas.user import ChangePasswordRequest, UpdateMeRequest
from app.security.password import hash_password, verify_password
from app.security.sessions import revoke_all_for_user, start_session

logger = logging.getLogger(__name__)

# …read_me、update_me 不動…


@router.post("/me/password", response_model=TokenResponse)
async def change_password(
    payload: ChangePasswordRequest,
    user: User = Depends(get_current_user),
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """改自己的密碼（帳號設定規格 §3.2）。成功後**所有**裝置的 refresh token 失效，
    這台拿到一組新的——已經發出去的 access token 最多還能用 15 分鐘（handover §8.1）。

    錯誤一律不是 401：前端對 401 會換票並重送一次，錯的密碼會被驗兩次、算兩次失敗。
    """
    # 1. 便宜的檢查先做。目前的密碼稍後會被驗證，所以「新＝目前」等價於兩個字串相同；
    #    兩個字串都是呼叫者自己送的，回這個錯誤不洩漏任何東西。
    if payload.new_password == payload.current_password:
        raise UnprocessableEntityError("PASSWORD_UNCHANGED", "新密碼不能跟目前的密碼一樣")

    # 2. 跟登入共用同一份額度（規格決定 9）：偷到 access token 的人不能多一扇猜密碼的門。
    #    鍵是帳號的 email（小寫，同 LoginRequest 的正規化）。被擋的請求不跑 Argon2。
    limiter_key = user.email.lower()
    login_rate_limiter.check(limiter_key)

    # 3. Argon2 在執行緒池（理由見 auth.login 的註解）。
    if not await run_in_threadpool(verify_password, payload.current_password, user.password_hash):
        login_rate_limiter.record_failure(limiter_key)
        raise UnprocessableEntityError("CURRENT_PASSWORD_INCORRECT", "目前的密碼不正確")
    login_rate_limiter.record_success(limiter_key)

    new_hash = await run_in_threadpool(hash_password, payload.new_password)

    # 4. 同一個交易：新雜湊、撤銷還沒用的重設連結、撤銷所有 refresh session。
    #    revoke_all_for_user 會取 advisory lock 並 **commit**——前兩個寫入在它之前、
    #    都還沒 commit，所以三件事一起進去。
    user_id = user.id
    user.password_hash = new_hash
    await revoke_live_resets(db, user_id)
    await revoke_all_for_user(db, user_id)

    # 5. **撤銷之後**才開新的：順序反過來，這一條也會被撤銷。
    issued = await start_session(db, user_id)
    logger.info("使用者 %s 修改了密碼，所有其他 session 已撤銷", user_id)
    return TokenResponse(access_token=issued.access_token, refresh_token=issued.refresh_token)
```

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：全部 PASS。

- [ ] **Step 5: 突變**（每個改完跑 Step 2，確認紅，再改回）：
  - `start_session` 移到 `revoke_all_for_user` 之前 → `test_every_other_device_is_logged_out…` 紅（新的那張 401）。
  - 拿掉 `user.password_hash = new_hash` → `test_only_the_new_password_works_afterwards` 紅。
  - `login_rate_limiter` 換成本模組自己的 `LoginRateLimiter()` 實例 → `test_change_password_and_login_share_one_guessing_budget` 紅。
  - `record_failure` 拿掉 → 同上紅。
  - 把步驟 4 搬到驗證密碼之前 → `test_a_wrong_current_password_is_422_and_changes_nothing` 紅。
  - `run_in_threadpool(verify_password, …)` 改成直接呼叫 → `test_argon2_runs_in_the_threadpool` 紅。
  - 拿掉 `revoke_live_resets` → `test_unused_reset_links_are_revoked` 紅。
  - `app/main.py` 拿掉 `setLevel` → `test_app_loggers_emit_info` 紅；拿掉 `addHandler` → `test_the_app_logger_has_its_own_handler` 紅。

- [ ] **Step 6: 全部後端、ruff、mypy、重新產生 `schema.d.ts`**。Expected：全綠；`schema.d.ts` 多了 `/api/me/password` 與 `ChangePasswordRequest`。

- [ ] **Step 7: Commit**

```
feat(backend): POST /api/me/password——改密碼並登出其他裝置

先比字串（新的不能跟目前的一樣）、再查登入限速（同一個 email 共用額度）、Argon2 在執行緒池。
成功時同一個交易改雜湊、撤銷還沒用的重設連結、撤銷所有 refresh session，再開一條新的回給這台。
錯誤一律 422，不用 401（前端對 401 會換票重送）。app.* 的 INFO 稽核紀錄現在真的會輸出。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/main.py app/schemas/user.py app/api/routes/me.py tests/test_change_password.py tests/test_logging_setup.py frontend/src/api/schema.d.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 4：後端——管理員的帳號清單與產生重設連結

**Files:**
- Create: `app/schemas/password_reset.py`、`app/api/routes/admin_users.py`、`tests/test_admin_users.py`
- Modify: `app/schemas/user.py`、`app/main.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試** `tests/test_admin_users.py`：

```python
"""`GET /api/admin/users`、`POST /api/admin/users/{id}/password-reset`（規格 §3.3、§3.4）。"""

import logging
from datetime import UTC, datetime, timedelta

from sqlalchemy import select

from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.password_resets import find_usable_reset, hash_reset_token
from app.security.tokens import create_access_token
from tests.factories import create_password_reset, create_user


def auth(user_id: int) -> dict[str, str]:
    return {"Authorization": f"Bearer {create_access_token(user_id)}"}


async def _links(db_session, user_id: int) -> list[PasswordResetToken]:
    return list(
        (
            await db_session.scalars(
                select(PasswordResetToken)
                .where(PasswordResetToken.user_id == user_id)
                .order_by(PasswordResetToken.id)
            )
        ).all()
    )


async def test_regular_users_get_403_on_both(client, db_session):
    member = await create_user(db_session)
    other = await create_user(db_session)

    listed = await client.get("/api/admin/users", headers=auth(member.id))
    created = await client.post(
        f"/api/admin/users/{other.id}/password-reset", headers=auth(member.id)
    )

    for response in (listed, created):
        assert response.status_code == 403
        assert response.json()["error"]["code"] == "FORBIDDEN"


async def test_the_list_has_every_account_in_id_order(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN, display_name="管理員")
    friend = await create_user(db_session, display_name="小明")

    response = await client.get("/api/admin/users", headers=auth(admin.id))

    assert response.status_code == 200
    items = response.json()
    assert len(items) >= 2
    ids = [item["id"] for item in items]
    assert ids == sorted(ids)
    mine = {item["id"]: item for item in items}
    assert mine[friend.id] == {
        "id": friend.id, "email": friend.email, "display_name": "小明", "role": "user",
    }
    assert mine[admin.id]["role"] == "admin"


async def test_creating_a_link_returns_the_token_once_and_stores_only_its_hash(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    admin_id, friend_id = admin.id, friend.id

    response = await client.post(
        f"/api/admin/users/{friend_id}/password-reset", headers=auth(admin_id)
    )

    assert response.status_code == 201
    body = response.json()
    assert set(body) == {"token", "expires_at"}
    token = body["token"]
    await db_session.rollback()  # 第 11 種
    (stored,) = await _links(db_session, friend_id)
    assert stored.token_hash == hash_reset_token(token) != token
    assert stored.created_by == admin_id
    assert stored.expires_at - stored.created_at == timedelta(hours=24)
    assert await find_usable_reset(db_session, token) is not None


async def test_a_new_link_revokes_the_previous_one(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    admin_id, friend_id = admin.id, friend.id

    first = await client.post(f"/api/admin/users/{friend_id}/password-reset", headers=auth(admin_id))
    second = await client.post(f"/api/admin/users/{friend_id}/password-reset", headers=auth(admin_id))

    assert (first.status_code, second.status_code) == (201, 201)
    await db_session.rollback()
    assert await find_usable_reset(db_session, first.json()["token"]) is None
    assert await find_usable_reset(db_session, second.json()["token"]) is not None


async def test_an_expired_unrevoked_link_does_not_block_a_new_one(client, db_session):
    """過期但沒撤銷的那條仍然算「活的」（部分唯一索引不看時間）——要先被撤銷掉。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    now = datetime.now(UTC)
    await create_password_reset(
        db_session, user=friend, created_by=admin,
        created_at=now - timedelta(days=2), expires_at=now - timedelta(days=1),
    )

    response = await client.post(f"/api/admin/users/{friend.id}/password-reset", headers=auth(admin.id))

    assert response.status_code == 201


async def test_no_links_for_admin_accounts_including_your_own(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    other_admin = await create_user(db_session, role=UserRole.ADMIN)
    admin_id = admin.id

    for target_id in (admin_id, other_admin.id):
        response = await client.post(
            f"/api/admin/users/{target_id}/password-reset", headers=auth(admin_id)
        )
        assert response.status_code == 422
        assert response.json()["error"]["code"] == "RESET_NOT_FOR_ADMINS"
    await db_session.rollback()
    assert await _links(db_session, admin_id) == []


async def test_an_unknown_user_is_404_with_its_own_code(client, db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)

    response = await client.post(
        "/api/admin/users/999999999/password-reset", headers=auth(admin.id)
    )

    assert response.status_code == 404
    assert response.json()["error"]["code"] == "USER_NOT_FOUND"  # 第 32 種：不是路由不存在


async def test_creating_a_link_is_audited_without_the_token(client, db_session, caplog):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    friend = await create_user(db_session)
    admin_id, friend_id, email = admin.id, friend.id, friend.email
    caplog.set_level(logging.INFO, logger="app")

    response = await client.post(f"/api/admin/users/{friend_id}/password-reset", headers=auth(admin_id))

    assert f"管理員 {admin_id} 產生了使用者 {friend_id} 的重設密碼連結" in caplog.text
    assert response.json()["token"] not in caplog.text
    assert email not in caplog.text
```

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_admin_users.py -q
```

Expected：全部 FAIL（路由不存在：404 `HTTP_ERROR`，連 403 那條也是 404 ≠ 403）。

- [ ] **Step 3: 實作**

`app/schemas/user.py` 加：

```python
class AdminUserItem(BaseModel):
    """`GET /api/admin/users` 的一列（規格 §3.3）。白名單：沒有時區、好友碼、建立時間。"""

    id: int
    email: str
    display_name: str
    role: UserRole
```

`app/schemas/password_reset.py`：

```python
from datetime import datetime

from pydantic import BaseModel, Field

from app.security.password import MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH


class PasswordResetCreatedResponse(BaseModel):
    # 明碼只在這個回應出現一次；資料庫只有雜湊（規格 §3.4）。
    token: str
    expires_at: datetime


class PasswordResetStatusRequest(BaseModel):
    # 上限是請求體衛生（真的碼是 43 字），同 InviteStatusRequest。
    token: str = Field(min_length=1, max_length=100)


class PasswordResetStatusResponse(BaseModel):
    valid: bool


class PasswordResetRequest(BaseModel):
    token: str = Field(min_length=1, max_length=100)
    new_password: str = Field(min_length=MIN_PASSWORD_LENGTH, max_length=MAX_PASSWORD_LENGTH)
```

（後兩個 Task 5 才用到，放在同一個檔案一起建。）

`app/api/routes/admin_users.py`：

```python
import logging
from datetime import UTC, datetime

from fastapi import APIRouter, Depends, status
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.api.deps import require_admin
from app.api.params import ResourceId
from app.db import get_db
from app.errors import NotFoundError, UnprocessableEntityError
from app.models.password_reset import PasswordResetToken
from app.models.user import User, UserRole
from app.password_resets import (
    RESET_LIFETIME,
    hash_reset_token,
    new_reset_token,
    revoke_live_resets,
)
from app.schemas.password_reset import PasswordResetCreatedResponse
from app.schemas.user import AdminUserItem

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/admin/users", tags=["admin"])


@router.get("", response_model=list[AdminUserItem])
async def list_users(
    _: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> list[AdminUserItem]:
    """所有帳號（帳號設定規格 §3.3）。帳號只有個位數，不分頁。"""
    users = (await db.scalars(select(User).order_by(User.id))).all()
    return [
        AdminUserItem(id=u.id, email=u.email, display_name=u.display_name, role=u.role)
        for u in users
    ]


@router.post(
    "/{user_id}/password-reset",
    status_code=status.HTTP_201_CREATED,
    response_model=PasswordResetCreatedResponse,
)
async def create_password_reset(
    user_id: ResourceId,
    admin: User = Depends(require_admin),
    db: AsyncSession = Depends(get_db),
) -> PasswordResetCreatedResponse:
    """替一般使用者產生一次性重設密碼連結（帳號設定規格 §3.4）。

    **FOR UPDATE 那個使用者列**：同一個人的兩次「產生」排隊，後到的看得到先到的那一列並把它
    撤銷——不然兩邊各自撤銷「看得到的」舊連結、各插一條，留下兩條活的。真正的最後一道是
    部分唯一索引 `uq_password_reset_tokens_one_live_per_user`（搶輸會是 IntegrityError）。
    這段 FOR UPDATE 沒有並行測試（要兩條真的連線搶鎖；同 revoke_invite 的取捨）。

    **只給一般使用者**（規格決定 12）：偷到管理員 access token 的人不能用它接管管理員帳號；
    管理員改自己的密碼用 `/api/me/password`，別的管理員用 CLI。
    """
    target = await db.scalar(select(User).where(User.id == user_id).with_for_update())
    if target is None:
        raise NotFoundError("USER_NOT_FOUND", "找不到這個帳號")
    if target.role is UserRole.ADMIN:
        raise UnprocessableEntityError(
            "RESET_NOT_FOR_ADMINS",
            "管理員帳號不能用重設連結：自己的密碼請用「修改密碼」，其他管理員請用命令列",
        )

    await revoke_live_resets(db, target.id)
    token = new_reset_token()
    now = datetime.now(UTC)
    reset = PasswordResetToken(
        user_id=target.id,
        token_hash=hash_reset_token(token),
        created_by=admin.id,
        created_at=now,
        expires_at=now + RESET_LIFETIME,
    )
    db.add(reset)
    await db.commit()
    await db.refresh(reset)
    # 稽核：只寫 id，**不寫碼、不寫 email**（規格 §6）。
    logger.info(
        "管理員 %s 產生了使用者 %s 的重設密碼連結（reset_id=%s）", admin.id, target.id, reset.id
    )
    return PasswordResetCreatedResponse(token=token, expires_at=reset.expires_at)
```

`app/main.py`：import `admin_users`，`app.include_router(admin_users.router, prefix="/api")`（放在 `admin_invites` 之後）。

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：`8 passed`。

- [ ] **Step 5: 突變**（每個改完跑 Step 2，確認紅，再改回）：
  - 拿掉 `revoke_live_resets(db, target.id)` → `test_a_new_link_revokes_the_previous_one` 紅（形狀是 `IntegrityError`：部分唯一索引擋下第二條——這正是那個索引在守的事，回報時寫清楚「紅在索引，不在斷言」）。接著**同時**把模型與 migration 的索引拿掉（只在本機、不要 commit）再跑：斷言那一行紅（第一條還能用）。兩道都證明有咬合力之後全部改回。
  - `revoke_live_resets` 的 `where` 加上 `PasswordResetToken.expires_at > func.now()` → `test_an_expired_unrevoked_link_does_not_block_a_new_one` 紅。
  - `if target.role is UserRole.ADMIN` 改成 `if target.id == admin.id` → `test_no_links_for_admin_accounts…` 紅（另一個管理員那一圈）。
  - 拿掉 `await db.commit()` → `test_creating_a_link_returns_the_token_once…` 紅（rollback 之後沒有列）。

- [ ] **Step 6: 全部後端、ruff、mypy、重新產生 `schema.d.ts`**。Expected：全綠；`schema.d.ts` 多了 `/api/admin/users`、`/api/admin/users/{user_id}/password-reset`、`AdminUserItem`、`PasswordReset*`（後三個 schema 要到 Task 5 被路由用到才會出現，這時只有 `PasswordResetCreatedResponse`）。

- [ ] **Step 7: Commit**

```
feat(backend): 管理員的帳號清單與重設密碼連結

GET /api/admin/users 列出所有帳號；POST /api/admin/users/{id}/password-reset 替一般使用者
產生 24 小時的一次性連結（明碼只回一次），同時撤銷這個人還沒用的舊連結。管理員帳號（含自己）
不能用連結。產生時寫 INFO 稽核紀錄（只有 id）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/schemas/user.py app/schemas/password_reset.py app/api/routes/admin_users.py app/main.py tests/test_admin_users.py frontend/src/api/schema.d.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 5：後端——公開的 `password-reset-status` 與 `password-reset`

**Files:**
- Create: `tests/test_password_reset.py`、`tests/test_password_reset_concurrency.py`
- Modify: `app/api/routes/auth.py`、`frontend/src/api/schema.d.ts`

- [ ] **Step 1: 寫失敗的測試**

`tests/test_password_reset.py`：

```python
"""`POST /api/auth/password-reset-status`、`POST /api/auth/password-reset`（規格 §3.5、§3.6）。"""

import logging
from datetime import UTC, datetime, timedelta

import pytest
from sqlalchemy import select

from app.models.password_reset import PasswordResetToken
from app.models.user import UserRole
from app.password_resets import RESET_INVALID_MESSAGE, new_reset_token
from app.ratelimit import PER_EMAIL_LIMIT
from app.security.password import hash_password
from tests.factories import DEFAULT_PASSWORD, create_password_reset, create_user

NEW_PASSWORD = "reset-new-password"
DEAD_KINDS = ["unknown", "expired", "revoked", "used"]


async def _dead_token(db_session, kind: str) -> str:
    """四種不能用的連結。**過期用時間造**（不是撤銷）：拿掉 `expires_at > now()` 時只有它會紅。"""
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    now = datetime.now(UTC)
    if kind == "unknown":
        return new_reset_token()
    if kind == "expired":
        _, token = await create_password_reset(
            db_session, user=user, created_by=admin,
            created_at=now - timedelta(days=2), expires_at=now - timedelta(seconds=1),
        )
        return token
    if kind == "revoked":
        _, token = await create_password_reset(db_session, user=user, created_by=admin, revoked=True)
        return token
    if kind == "used":
        _, token = await create_password_reset(db_session, user=user, created_by=admin, used=True)
        return token
    raise AssertionError(kind)


async def _live(db_session):
    admin = await create_user(db_session, role=UserRole.ADMIN)
    user = await create_user(db_session)
    reset, token = await create_password_reset(db_session, user=user, created_by=admin)
    return user.id, user.email, reset.id, token


async def _reset(client, token: str, new_password: str = NEW_PASSWORD):
    return await client.post(
        "/api/auth/password-reset", json={"token": token, "new_password": new_password}
    )


async def _login(client, email: str, password: str):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def test_a_reset_sets_the_password_uses_the_link_and_logs_out_everywhere(client, db_session):
    user_id, email, reset_id, token = await _live(db_session)
    phone = (await _login(client, email, DEFAULT_PASSWORD)).json()
    laptop = (await _login(client, email, DEFAULT_PASSWORD)).json()

    response = await _reset(client, token)

    assert response.status_code == 204
    await db_session.rollback()  # 第 11 種
    assert (await _login(client, email, DEFAULT_PASSWORD)).status_code == 401
    assert (await _login(client, email, NEW_PASSWORD)).status_code == 200
    stored = await db_session.scalar(
        select(PasswordResetToken).where(PasswordResetToken.id == reset_id)
    )
    assert stored is not None and stored.used_at is not None
    for old in (phone, laptop):
        replay = await client.post("/api/auth/refresh", json={"refresh_token": old["refresh_token"]})
        assert replay.status_code == 401


async def test_a_link_works_only_once(client, db_session):
    _, _, _, token = await _live(db_session)
    assert (await _reset(client, token)).status_code == 204
    again = await _reset(client, token, "yet-another-password")
    assert again.status_code == 403
    assert again.json()["error"]["code"] == "RESET_LINK_INVALID"


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_a_dead_link_is_403_with_one_message(client, db_session, kind):
    token = await _dead_token(db_session, kind)

    response = await _reset(client, token)

    assert response.status_code == 403
    assert response.json()["error"] == {
        "code": "RESET_LINK_INVALID", "message": RESET_INVALID_MESSAGE, "details": {},
    }


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_a_dead_link_never_reaches_argon2(client, db_session, monkeypatch, kind):
    token = await _dead_token(db_session, kind)
    calls: list[str] = []

    def spy(password: str) -> str:
        calls.append(password)
        return hash_password(password)

    monkeypatch.setattr("app.api.routes.auth.hash_password", spy)

    await _reset(client, token)

    assert calls == []


async def test_losing_the_redeem_race_is_403_and_changes_nothing(client, db_session, monkeypatch):
    """查的時候還能用、兌換時已經被別人用掉（或剛被撤銷）。真的並行在 concurrency 檔。"""
    _, email, _, token = await _live(db_session)

    async def lost(*_args, **_kwargs):
        return None

    monkeypatch.setattr("app.api.routes.auth.redeem_reset", lost)

    response = await _reset(client, token)

    assert response.status_code == 403
    await db_session.rollback()
    assert (await _login(client, email, DEFAULT_PASSWORD)).status_code == 200


async def test_a_failure_after_redeeming_rolls_back_the_password_and_the_link(
    client, db_session, monkeypatch
):
    """兌換、改密碼、撤銷 session 是同一個交易（規格「差異」第 6 點）：撤銷之前出事，
    前兩件也不能留下來。"""
    _, email, reset_id, token = await _live(db_session)

    async def boom(*_args, **_kwargs):
        raise RuntimeError("撤銷失敗")

    monkeypatch.setattr("app.api.routes.auth.revoke_all_for_user", boom)

    with pytest.raises(RuntimeError):  # 第 31 種：例外直接冒出來，不是 500 的 response
        await _reset(client, token)

    await db_session.rollback()
    stored = await db_session.scalar(
        select(PasswordResetToken).where(PasswordResetToken.id == reset_id)
    )
    assert stored is not None and stored.used_at is None
    assert (await _login(client, email, DEFAULT_PASSWORD)).status_code == 200


async def test_a_successful_reset_clears_the_login_lockout(client, db_session):
    _, email, _, token = await _live(db_session)
    for _ in range(PER_EMAIL_LIMIT):
        await _login(client, email, "wrong-password")
    assert (await _login(client, email, "wrong-password")).status_code == 429

    await _reset(client, token)

    assert (await _login(client, email, NEW_PASSWORD)).status_code == 200


@pytest.mark.parametrize(
    "body",
    [
        {"token": "x", "new_password": "short7!"},
        {"token": "", "new_password": NEW_PASSWORD},
        {"token": "x" * 101, "new_password": NEW_PASSWORD},
        {"new_password": NEW_PASSWORD},
    ],
)
async def test_bad_bodies_are_422(client, body):
    response = await client.post("/api/auth/password-reset", json=body)
    assert response.status_code == 422


async def test_status_is_true_for_a_usable_link_and_does_not_use_it(client, db_session):
    _, _, _, token = await _live(db_session)

    response = await client.post("/api/auth/password-reset-status", json={"token": token})

    assert response.status_code == 200
    assert response.json() == {"valid": True}
    assert (await _reset(client, token)).status_code == 204  # 問過之後還能用


@pytest.mark.parametrize("kind", DEAD_KINDS)
async def test_status_is_false_for_a_dead_link(client, db_session, kind):
    token = await _dead_token(db_session, kind)
    response = await client.post("/api/auth/password-reset-status", json={"token": token})
    assert response.json() == {"valid": False}


async def test_the_reset_is_audited_without_secrets(client, db_session, caplog):
    user_id, email, reset_id, token = await _live(db_session)
    caplog.set_level(logging.INFO, logger="app")

    await _reset(client, token)

    assert f"使用者 {user_id} 用重設連結重設了密碼（reset_id={reset_id}）" in caplog.text
    for secret in (token, NEW_PASSWORD, email):
        assert secret not in caplog.text
```

`tests/test_password_reset_concurrency.py`：照抄 `tests/test_invites_concurrency.py` 的結構（`independent_sessions`
fixture、`_wait_until_someone_else_is_lock_waiting`、`finally` 自己清），內容換成：

```python
async def test_only_one_of_two_concurrent_redemptions_wins(independent_sessions):
    admin, user = _user("admin", UserRole.ADMIN), _user("user")
    async with independent_sessions() as setup:
        setup.add_all([admin, user])
        await setup.flush()
        now = datetime.now(UTC)
        reset = PasswordResetToken(
            user_id=user.id,
            token_hash=hash_reset_token(new_reset_token()),
            created_by=admin.id,
            created_at=now,
            expires_at=now + RESET_LIFETIME,
        )
        setup.add(reset)
        await setup.commit()

    try:
        async with independent_sessions() as first, independent_sessions() as second:
            assert await redeem_reset(first, reset.id) == user.id
            first_pid = await first.scalar(select(func.pg_backend_pid()))

            # 第二條在第一條 commit 之前開始兌換——卡在列鎖上，第一條 commit 後重新評估 WHERE、落空。
            second_attempt = asyncio.create_task(redeem_reset(second, reset.id))
            async with asyncio.timeout(5.0):
                await _wait_until_someone_else_is_lock_waiting(first_pid)
            await first.commit()

            assert await second_attempt is None
            await second.commit()
    finally:
        async with independent_sessions() as cleanup:
            await cleanup.execute(delete(User).where(User.id.in_([admin.id, user.id])))
            await cleanup.commit()
```

（`users` 刪掉時 `password_reset_tokens` 會 CASCADE。`_user(label, role)` 照抄邀請那一份，email 換成 `reset-race-…`。邀請那份的 `finally` 只刪邀請、沒刪使用者——照現況抄的話留下的使用者會累積在測試資料庫裡，但測試資料庫每個 session 重建，無害；這裡順手清乾淨。）

- [ ] **Step 2: 跑測試確認失敗**

```
./.venv/Scripts/python.exe -m pytest tests/test_password_reset.py tests/test_password_reset_concurrency.py -q
```

Expected：`test_password_reset.py` 的端點測試全部 FAIL（路由不存在）；`test_bad_bodies_are_422` 四條**也紅**（404 ≠ 422）；**`test_password_reset_concurrency.py` 這時就是綠的**（`redeem_reset` 在 Task 1 已經實作）——那是預期的（第 39 種：它守的是 Task 1 的函式，不是這個 task 的端點），照實回報。

- [ ] **Step 3: 實作** `app/api/routes/auth.py`

import 補：`from sqlalchemy import select, update`；
`from app.password_resets import RESET_INVALID_MESSAGE, find_usable_reset, redeem_reset`；
`from app.schemas.password_reset import PasswordResetRequest, PasswordResetStatusRequest, PasswordResetStatusResponse`。
`logger` 已經有。在 `invite_status` 之後加：

```python
@router.post("/password-reset-status", response_model=PasswordResetStatusResponse)
async def password_reset_status(
    payload: PasswordResetStatusRequest, db: AsyncSession = Depends(get_db)
) -> PasswordResetStatusResponse:
    """重設密碼頁一打開就先問（帳號設定規格 §3.5），同 invite-status。
    碼放在 body，不放網址——不進存取紀錄。不限速：一次 SHA-256 加一次索引查詢。"""
    return PasswordResetStatusResponse(
        valid=await find_usable_reset(db, payload.token) is not None
    )


@router.post("/password-reset", status_code=status.HTTP_204_NO_CONTENT)
async def reset_password(payload: PasswordResetRequest, db: AsyncSession = Depends(get_db)) -> None:
    """用管理員產生的一次性連結設新密碼（帳號設定規格 §3.6）。不自動登入。"""
    # 1. 先查連結，**在 Argon2 之前**（同 register 查邀請）：亂碼或用過的連結只花一次
    #    SHA-256 與一次索引查詢。四種失效同一個錯誤——對方能做的事都一樣：要一個新的。
    reset = await find_usable_reset(db, payload.token)
    if reset is None:
        raise ForbiddenError("RESET_LINK_INVALID", RESET_INVALID_MESSAGE)
    reset_id = reset.id

    password_hash = await run_in_threadpool(hash_password, payload.new_password)

    # 2. 同一個交易：兌換（條件式 UPDATE）→ 新雜湊 → 撤銷所有 session。
    #    revoke_all_for_user 取 advisory lock 之後**自己 commit**——它的 commit 就是這個
    #    交易的 commit；前兩個寫入都還沒 commit，所以三件事一起進去或一起不進去
    #    （test_a_failure_after_redeeming_rolls_back_the_password_and_the_link）。
    #    不要在中間加 commit。
    user_id = await redeem_reset(db, reset_id)
    if user_id is None:
        await db.rollback()
        raise ForbiddenError("RESET_LINK_INVALID", RESET_INVALID_MESSAGE)
    email = await db.scalar(
        update(User)
        .where(User.id == user_id)
        .values(password_hash=password_hash)
        .returning(User.email)
    )
    await revoke_all_for_user(db, user_id)

    # 3. 之前猜錯被限速的人，不用再等一分鐘才能用新密碼登入。
    if email is not None:
        login_rate_limiter.record_success(email.lower())
    # 稽核：只寫 id（規格 §6）。
    logger.info("使用者 %s 用重設連結重設了密碼（reset_id=%s）", user_id, reset_id)
```

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：全部 PASS。

- [ ] **Step 5: 突變**（每個改完跑 Step 2，確認紅，再改回）：
  - `find_usable_reset` 那一段搬到 `hash_password` 之後 → `test_a_dead_link_never_reaches_argon2` 四條紅。
  - `_still_usable()` 拿掉 `expires_at > func.now()`（`app/password_resets.py`）→ `[expired]` 的幾條紅，其他綠。
  - `redeem_reset(...)` 之後加 `await db.commit()` → `test_a_failure_after_redeeming…` 紅。
  - 拿掉 `revoke_all_for_user(...)` → `test_a_reset_sets_the_password…` 紅（舊票還能換）。注意：拿掉之後**沒有任何東西 commit**，密碼那條斷言也會紅——先看是哪一行紅，回報時寫清楚（第 8 條規矩）。再試一次「把 `revoke_all_for_user` 換成 `await db.commit()`」→ 只剩舊票那兩行紅，這才是「撤銷」本身的鑑別力。
  - 拿掉 `login_rate_limiter.record_success` → `test_a_successful_reset_clears_the_login_lockout` 紅。
  - `redeem_reset` 的 `.where(...)` 拿掉 `*_still_usable()` → concurrency 那條紅（第二條也兌換到）。**要跑 concurrency 檔才看得到**。

- [ ] **Step 6: 全部後端、ruff、mypy、重新產生 `schema.d.ts`**。Expected：全綠；`schema.d.ts` 多了兩個公開端點與 `PasswordResetStatus*`、`PasswordResetRequest`。

- [ ] **Step 7: 本機的 api 容器與 dev 資料庫**（之後的 e2e 要用）：

```
docker compose up -d --build api
docker compose exec api python -m alembic upgrade head
docker compose ps
```

Expected：`wallet-api-1` `(healthy)`（看 healthy 不看 Up）；`Running upgrade 0015 -> 0016`（如果容器啟動時已經跑過，就是沒有輸出——用 `docker compose exec -T db psql -U wallet -d wallet -tAc "SELECT version_num FROM alembic_version"` 確認是 `0016`）。

- [ ] **Step 8: Commit**

```
feat(backend): 公開的重設密碼流程

password-reset-status 先問連結還能不能用；password-reset 在 Argon2 之前先查連結，
兌換（條件式 UPDATE）、改密碼、撤銷所有 session 在同一個交易。四種失效同一個 403。
成功不自動登入，清掉那個 email 的登入失敗計數；寫 INFO 稽核紀錄（只有 id）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add app/api/routes/auth.py tests/test_password_reset.py tests/test_password_reset_concurrency.py frontend/src/api/schema.d.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 6：前端——`schema.d.ts` 核對、API 層、`checkTargetInput`、路由寬度

**Files:**
- Create: `frontend/src/api/targets.ts`、`frontend/src/api/admin-users.ts`、`frontend/src/api/password-reset.ts`、`frontend/src/lib/link-token.ts`、`frontend/src/lib/targets.ts`、`frontend/tests/account-api.test.ts`
- Modify: `frontend/src/api/me.ts`、`frontend/src/api/queries.ts`、`frontend/src/auth/session.ts`、`frontend/src/lib/decimal.ts`、`frontend/src/lib/layout.ts`、`frontend/src/screens/Join.tsx`、`frontend/tests/decimal.test.ts`、`frontend/tests/layout.test.ts`

- [ ] **Step 0: 基準線與 `schema.d.ts` 核對**：在 `frontend/` 跑 `npm run -s test`，記下 `Test Files`／`Tests`（除以二）。重新產生 `schema.d.ts` → `git diff --exit-code frontend/src/api/schema.d.ts` 必須是 0（Task 2–5 已經各自產生過）。不是 0 → 停下來回報是哪個 task 漏了。

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/decimal.test.ts` 加一個 `describe`：

```ts
describe("checkTargetInput（每日目標的一格，帳號設定規格 §5.2）", () => {
	it.each([
		["", null],
		["   ", null],
		["1800", null],
		["12.5", null],
		[".5", null],
		["4.", null],
		["20000", null],
		["0.01", null],
		["0", "not-positive-decimal"],
		["0.00", "not-positive-decimal"],
		["-1", "not-positive-decimal"],
		["1e3", "not-positive-decimal"],
		["abc", "not-positive-decimal"],
		["12.345", "too-precise"],
		["20000.01", "too-large"],
	] as const)("%j → %s", (value, expected) => {
		expect(checkTargetInput(value, "20000")).toBe(expected);
	});
});
```

`frontend/tests/layout.test.ts` 的表加兩列：`["/me/targets", "form"]`、`["/me/password", "form"]`（`/me` 仍是 `narrow`）。

`frontend/tests/account-api.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { setTargetFromToday } from "../src/api/targets";
import { updateDisplayName } from "../src/api/me";
import { changePassword } from "../src/auth/session";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import {
	clearTokens,
	getAccessToken,
	getRefreshToken,
	setTokens,
} from "../src/auth/store";
import { readInviteToken } from "../src/screens/Join";
import { readLinkToken } from "../src/lib/link-token";
import { json, mockApi } from "./helpers/mock-api";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "old-a", refresh_token: "old-r" });
});

function bodyOf(spy: ReturnType<typeof mockApi>, index = 0): unknown {
	const init = spy.mock.calls[index]?.[1];
	return JSON.parse(String(init?.body));
}

describe("帳號設定的 API 層", () => {
	it("改密碼成功之後換上新的一組票", async () => {
		const spy = mockApi([
			{
				method: "POST",
				path: "/api/me/password",
				handler: () =>
					json({ access_token: "new-a", refresh_token: "new-r", token_type: "bearer" }),
			},
		]);

		await changePassword("old-password", "new-password-1");

		expect(bodyOf(spy)).toEqual({
			current_password: "old-password",
			new_password: "new-password-1",
		});
		expect(getAccessToken()).toBe("new-a");
		expect(getRefreshToken()).toBe("new-r");
	});

	it("改密碼失敗時票不變", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/me/password",
				handler: () =>
					json(
						{ error: { code: "CURRENT_PASSWORD_INCORRECT", message: "目前的密碼不正確", details: {} } },
						422,
					),
			},
		]);

		await expect(changePassword("wrong", "new-password-1")).rejects.toMatchObject({
			code: "CURRENT_PASSWORD_INCORRECT",
		});
		expect(getRefreshToken()).toBe("old-r");
	});

	it("存目標用 PUT，四個鍵都送", async () => {
		const spy = mockApi([
			{
				method: "PUT",
				path: "/api/targets/today",
				handler: () => json({ id: 1, kcal: "1800.00", protein_g: null, fat_g: null, carb_g: null, label: null, effective_from: "2019-07-04", effective_to: null }),
			},
		]);

		await setTargetFromToday({ kcal: "1800", protein_g: null, fat_g: null, carb_g: null });

		expect(spy.mock.calls[0]?.[1]?.method).toBe("PUT");
		expect(bodyOf(spy)).toEqual({ kcal: "1800", protein_g: null, fat_g: null, carb_g: null });
	});

	it("改名稱只送 display_name", async () => {
		const spy = mockApi([
			{
				method: "PATCH",
				path: "/api/me",
				handler: () => json({ id: 1, email: "k@example.com", display_name: "新名字", role: "user", timezone: "Asia/Taipei" }),
			},
		]);

		const updated = await updateDisplayName("新名字");

		expect(bodyOf(spy)).toEqual({ display_name: "新名字" });
		expect(updated.display_name).toBe("新名字");
	});

	it("連結的碼：# 之後連續的 token_urlsafe 字元；邀請沿用同一個函式", () => {
		expect(readLinkToken("#abc_DEF-123。")).toBe("abc_DEF-123");
		expect(readLinkToken("")).toBe("");
		expect(readInviteToken).toBe(readLinkToken);
	});
});
```

（`json(body, status = 200)` 是 `tests/helpers/mock-api.ts` 既有的 helper。）

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend && npx vitest run tests/decimal.test.ts tests/layout.test.ts tests/account-api.test.ts
```

Expected：`account-api.test.ts` 收集失敗（模組不存在）；`decimal.test.ts` 收集失敗或新的那組 FAIL（`checkTargetInput` 不存在）；`layout.test.ts` 新的兩列 FAIL（目前是 `narrow`）。

- [ ] **Step 3: 實作**

`frontend/src/lib/decimal.ts`（`isPlainPositiveDecimal` 之後）：

```ts
/** 每日目標一格的問題（帳號設定規格 §5.2）。`null`＝沒問題（包括空白＝不設定）。 */
export type TargetInputProblem =
	| "not-positive-decimal"
	| "too-precise"
	| "too-large";

const AT_MOST_TWO_PLACES = /^(\d+(\.\d{0,2})?|\.\d{1,2})$/;

/** 後端 `TargetTodayRequest` 的規則：> 0、最多兩位小數、不超過上限。空白＝不設定。
 *  寫法限制跟 `isPlainPositiveDecimal` 一樣（不收 `1e3`、`+5`）。不丟例外。 */
export function checkTargetInput(
	value: string,
	max: Numeric,
): TargetInputProblem | null {
	const v = value.trim();
	if (v === "") return null;
	if (!isPlainPositiveDecimal(v)) return "not-positive-decimal";
	if (!AT_MOST_TWO_PLACES.test(v)) return "too-precise";
	if (new Decimal(v).greaterThan(max)) return "too-large";
	return null;
}
```

`frontend/src/lib/targets.ts`：

```ts
import type { Numeric } from "./decimal";

/** 每日目標的四格（帳號設定規格 §5.1、§5.2）：「我的」的卡片與 `/me/targets` 共用，
 *  標籤、單位、上限只有這一份。上限跟後端 `app/schemas/target.py` 的 `_MAX_KCAL`／`_MAX_GRAMS` 一致。 */
export const TARGET_FIELDS = [
	{ key: "kcal", label: "熱量", unit: "kcal", max: "20000" },
	{ key: "protein_g", label: "蛋白質", unit: "g", max: "2000" },
	{ key: "fat_g", label: "脂肪", unit: "g", max: "2000" },
	{ key: "carb_g", label: "碳水", unit: "g", max: "2000" },
] as const satisfies readonly {
	key: string;
	label: string;
	unit: string;
	max: Numeric;
}[];

export type TargetKey = (typeof TARGET_FIELDS)[number]["key"];
```

`frontend/src/lib/link-token.ts`：

```ts
/** `#tok` → `tok`：邀請（`/join`）與重設密碼（`/reset-password`）的連結都把碼放在 `#` 後面
 *  （不送到伺服器、不進存取紀錄）。只取開頭連續的 `[A-Za-z0-9_-]`（`token_urlsafe` 的字元）——
 *  聊天軟體常在連結後面黏上句號、空白或自己的 `?參數`。 */
export function readLinkToken(hash: string): string {
	return /^#([A-Za-z0-9_-]*)/.exec(hash)?.[1] ?? "";
}
```

`frontend/src/screens/Join.tsx`：刪掉 `readInviteToken` 的函式本體，改成
`export { readLinkToken as readInviteToken } from "../lib/link-token";`，元件裡的呼叫改用 `readLinkToken`
（import 進來）。`readInviteToken` 的 docstring 搬到 `link-token.ts`（上面已經寫了）。

`frontend/src/lib/layout.ts`：`const FORM = new Set(["/expenses/new", "/meals/new", "/me/targets", "/me/password"]);`，
註解「form 480」那行補上這兩頁是單欄表單。

`frontend/src/api/queries.ts`：`invites` 之後加

```ts
	/** 管理員的「所有帳號」（帳號設定規格 §5.4）。產生重設連結遇到 404／422 時失效它。 */
	adminUsers: ["admin", "users"] as const,
```

`frontend/src/api/me.ts` 加：

```ts
/** 改顯示名稱（帳號設定規格 §5.1）。**只送 `display_name`**——`PATCH /api/me` 省略的欄位不動；
 *  時區不在這次的範圍。 */
export async function updateDisplayName(displayName: string): Promise<Me> {
	const updated = await apiFetch<Me>("/api/me", {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ display_name: displayName }),
	});
	if (updated === null) throw new Error("修改名稱的回應沒有 body");
	return updated;
}
```

`frontend/src/api/targets.ts`：

```ts
import { apiFetch } from "./client";
import type { components } from "./schema";

export type TargetToday = components["schemas"]["TargetTodayRequest"];
export type Target = components["schemas"]["TargetResponse"];

/** 從今天起，目標是這四個值（帳號設定規格 §3.1）。「今天」由後端用使用者的時區算——
 *  前端不帶日期。四個鍵都要送，`null`＝不設定。 */
export async function setTargetFromToday(body: TargetToday): Promise<Target> {
	const saved = await apiFetch<Target>("/api/targets/today", {
		method: "PUT",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (saved === null) throw new Error("儲存目標的回應沒有 body");
	return saved;
}
```

（`TargetTodayRequest` 的欄位在 `schema.d.ts` 裡可能是 `number | string | null`——送字串沒問題。）

`frontend/src/api/admin-users.ts`：

```ts
import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type AdminUser = components["schemas"]["AdminUserItem"];
export type PasswordResetCreated =
	components["schemas"]["PasswordResetCreatedResponse"];

export function useAdminUsers() {
	return useQuery({
		queryKey: queryKeys.adminUsers,
		queryFn: () => apiFetch<AdminUser[]>("/api/admin/users"),
		// 同 useInvites：每次打開「我的」都重抓，新朋友剛註冊就看得到。
		staleTime: 0,
	});
}

export async function createPasswordReset(
	userId: number,
): Promise<PasswordResetCreated> {
	const created = await apiFetch<PasswordResetCreated>(
		`/api/admin/users/${userId}/password-reset`,
		{ method: "POST" },
	);
	if (created === null) throw new Error("產生重設連結的回應沒有 body");
	return created;
}

/** 碼放在 `#` 後面（規格 §6）：不送到伺服器，不進 Caddy 或 Tailscale 的存取紀錄。 */
export function resetLink(token: string): string {
	return `${window.location.origin}/reset-password#${token}`;
}
```

`frontend/src/api/password-reset.ts`：

```ts
import { apiFetch } from "./client";

const JSON_HEADERS = { "content-type": "application/json" };

/** 沒登入時打的兩個端點（帳號設定規格 §3.5、§3.6）。碼一律放 body，不放網址。 */
export async function checkResetLink(token: string): Promise<boolean> {
	const result = await apiFetch<{ valid: boolean }>(
		"/api/auth/password-reset-status",
		{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) },
	);
	return result?.valid === true;
}

export async function resetPassword(
	token: string,
	newPassword: string,
): Promise<void> {
	await apiFetch("/api/auth/password-reset", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ token, new_password: newPassword }),
	});
}
```

`frontend/src/auth/session.ts` 加（放在 `login` 之後）：

```ts
/** 改自己的密碼（帳號設定規格 §3.2、§5.3）。後端撤銷了**所有** refresh session（包括這台
 *  舊的那條），回一組新的——不換上去的話，這台下一次換票就被登出。 */
export async function changePassword(
	currentPassword: string,
	newPassword: string,
): Promise<void> {
	const tokens = await apiFetch<Tokens>("/api/me/password", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({
			current_password: currentPassword,
			new_password: newPassword,
		}),
	});
	if (tokens === null) throw new Error("修改密碼的回應沒有 body");
	setTokens(tokens);
}
```

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：全綠；`npx vitest run tests/join.test.tsx tests/decimal-containment.test.ts` 也綠。

- [ ] **Step 5: 突變**：
  - `checkTargetInput` 拿掉 `AT_MOST_TWO_PLACES` 那一行 → `"12.345"` 那條紅。
  - `changePassword` 拿掉 `setTokens(tokens)` → 「改密碼成功之後換上新的一組票」紅。
  - `updateDisplayName` 的 body 改成 `{ display_name, timezone: "Asia/Taipei" }` → 「只送 display_name」紅。

- [ ] **Step 6: 全部前端檢查**：`npm run -s typecheck`、`npm run -s lint`、`npm run -s test`。Expected：全綠，數字照實回報（記得除以二）。

- [ ] **Step 7: Commit**

```
feat(frontend): 帳號設定的 API 層、目標欄位檢查、新路由的寬度

目標從今天起（PUT /api/targets/today）、改名稱、改密碼（換上新的一組票）、管理員的帳號清單
與重設連結、沒登入的重設流程。checkTargetInput 跟後端同一套規則（> 0、兩位小數、上限）；
/me/targets、/me/password 是 480px 的表單寬度。連結碼的讀法抽成 lib/link-token.ts，邀請共用。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/api/targets.ts frontend/src/api/admin-users.ts frontend/src/api/password-reset.ts frontend/src/api/me.ts frontend/src/api/queries.ts frontend/src/auth/session.ts frontend/src/lib/decimal.ts frontend/src/lib/targets.ts frontend/src/lib/link-token.ts frontend/src/lib/layout.ts frontend/src/screens/Join.tsx frontend/tests/account-api.test.ts frontend/tests/decimal.test.ts frontend/tests/layout.test.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 7：前端——「我的」的帳號卡片與每日目標卡片

**Files:**
- Create: `frontend/src/components/AccountCard.tsx`、`AccountCard.module.css`、`TargetsCard.tsx`、`TargetsCard.module.css`
- Modify: `frontend/src/screens/Me.tsx`、`frontend/src/screens/Me.module.css`、`frontend/tests/me.test.tsx`

- [ ] **Step 1: 改既有的測試、寫失敗的測試** `frontend/tests/me.test.tsx`

1. 檔頭加一組共用的路由，**每一條既有測試**的 `mockApi([...])` 都加上它（「我的」現在會打 `/api/stats/daily`。沒準備的話 mock 丟「測試沒有為這個路徑準備回應」、卡片顯示「無法載入」——既有測試不會因此紅，好友卡片今天就是這樣；但新的目標卡片測試靠它，而且明確準備比依賴「丟例外也沒關係」好讀）：

```ts
const ZERO = { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" };
const STATS = {
	date: "2019-07-04",
	actual: ZERO,
	target: { kcal: "1800.00", protein_g: "120.00", fat_g: null, carb_g: null },
	ratio: { kcal: "0.00", protein_g: "0.00", fat_g: null, carb_g: null },
	breakdown: { food: ZERO, supplement: ZERO },
};

function statsRoute(body: unknown = STATS) {
	return { method: "GET", path: "/api/stats/daily", handler: () => json(body) };
}
```

（`DailyStatsResponse` 的實際形狀以 `schema.d.ts` 為準，對不上就照它補齊欄位。）

2. **刻意改變**「「重新整理」直接打 /api/me 並顯示名稱」：第二次 `/api/me` 回 `display_name: "重新整理後的名字"`，
   斷言 `findByText("重新整理後的名字")`。理由寫進測試的註解：帳號卡片現在也顯示名字，同一個「Kenny」會撞成兩個元素
   （第 38 種），而且分不出畫面上的名字是不是重新整理帶來的（第 52 種）。用 `let calls = 0` 讓 handler 第一次回
   `me("user")`、之後回新名字。

3. 新增：

```ts
describe("我的：帳號卡片", () => {
	it("顯示名字與 email，有「修改密碼」連結", async () => {
		mockApi([statsRoute(), { method: "GET", path: "/api/me", handler: () => json(me("user")) }]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		expect(await screen.findByText("Kenny")).toBeInTheDocument();
		expect(screen.getByText("kenny@example.com")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "修改密碼" })).toHaveAttribute("href", "/me/password");
	});

	it("修改名稱：只送 display_name，存好之後畫面換成新名字，焦點回到「修改名稱」", async () => {
		let current = me("user");
		const spy = mockApi([
			statsRoute(),
			{
				method: "PATCH",
				path: "/api/me",
				handler: () => {
					current = { ...current, display_name: "新名字" };
					return json(current);
				},
			},
			{ method: "GET", path: "/api/me", handler: () => json(current) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await userEvent.click(await screen.findByRole("button", { name: "修改名稱" }));
		const input = screen.getByLabelText("顯示名稱");
		expect(input).toHaveFocus();
		expect(input).toHaveValue("Kenny");
		await userEvent.clear(input);
		await userEvent.type(input, "  新名字 ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("新名字")).toBeInTheDocument();
		const patch = spy.mock.calls.find(([, init]) => init?.method === "PATCH");
		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({ display_name: "新名字" });
		await waitFor(() => expect(screen.getByRole("button", { name: "修改名稱" })).toHaveFocus());
	});

	it("名稱是空白不送；取消不送、焦點回到「修改名稱」", async () => {
		const spy = mockApi([statsRoute(), { method: "GET", path: "/api/me", handler: () => json(me("user")) }]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await userEvent.click(await screen.findByRole("button", { name: "修改名稱" }));
		await userEvent.clear(screen.getByLabelText("顯示名稱"));
		await userEvent.type(screen.getByLabelText("顯示名稱"), "   ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));
		expect(await screen.findByRole("alert")).toHaveTextContent("名稱不能是空白");
		await userEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(screen.getByRole("button", { name: "修改名稱" })).toHaveFocus();
		expect(spy.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
	});

	it("後端 422 顯示欄位訊息", async () => { /* PATCH 回 422 VALIDATION_ERROR，details.errors[0].msg 顯示在 role=alert */ });
});

describe("我的：每日目標卡片", () => {
	it("顯示四個值，沒設的寫「未設定」，連到 /me/targets", async () => {
		mockApi([statsRoute(), { method: "GET", path: "/api/me", handler: () => json(me("user")) }]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		const card = await screen.findByTestId("targets-card");
		expect(await within(card).findByText("1800 kcal")).toBeInTheDocument();
		expect(within(card).getByText("120 g")).toBeInTheDocument();
		expect(within(card).getAllByText("未設定")).toHaveLength(2);
		expect(within(card).getByRole("link", { name: "修改每日目標" })).toHaveAttribute("href", "/me/targets");
	});

	it("今天沒有目標（target 是 null）：四格都是「未設定」", async () => {
		mockApi([statsRoute({ ...STATS, target: null, ratio: null }), { method: "GET", path: "/api/me", handler: () => json(me("user")) }]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		const card = await screen.findByTestId("targets-card");
		await waitFor(() => expect(within(card).getAllByText("未設定")).toHaveLength(4));
	});

	it("讀不到統計：「無法載入目前的目標」", async () => { /* stats 回 500 */ });
});
```

（`within` 從 `@testing-library/react` import。「後端 422」「讀不到統計」兩條照上面的模式寫完整。）

- [ ] **Step 2: 跑測試確認失敗**

```
cd frontend && npx vitest run tests/me.test.tsx
```

Expected：新的帳號卡片、目標卡片幾條 FAIL；既有的全綠。**改過的「重新整理」那條在實作前就是綠的，而且應該是綠的**（第 39 種）：它是迴歸防護——帳號卡片顯示名字之後，舊寫法會撞成兩個元素；新寫法在實作後也要綠。

- [ ] **Step 3: 實作**

`frontend/src/components/AccountCard.tsx`：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { updateDisplayName, useMe } from "../api/me";
import { queryKeys } from "../api/queries";
import styles from "./AccountCard.module.css";
import { Card } from "./Card";
import ui from "./ui.module.css";

/** 「我的」最上面的帳號卡片（帳號設定規格 §5.1）：名字、email、行內改名稱、「修改密碼」。 */
export function AccountCard() {
	const queryClient = useQueryClient();
	const meQuery = useMe();
	const me = meQuery.data;
	const [editing, setEditing] = useState(false);
	const [name, setName] = useState("");
	const [error, setError] = useState<string | null>(null);
	const editButtonRef = useRef<HTMLButtonElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	// 只有「取消」與「存好」才把焦點還給「修改名稱」（同 useConfirmFocus 的旗標）。
	const returnFocus = useRef(false);

	useEffect(() => {
		if (editing) {
			inputRef.current?.focus();
		} else if (returnFocus.current) {
			returnFocus.current = false;
			editButtonRef.current?.focus();
		}
	}, [editing]);

	const save = useMutation({
		mutationFn: (displayName: string) => updateDisplayName(displayName),
		onSuccess: (updated) => {
			queryClient.setQueryData(queryKeys.me, updated);
			void queryClient.invalidateQueries({ queryKey: queryKeys.me });
		},
	});

	function close() {
		returnFocus.current = true;
		setEditing(false);
		setError(null);
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const trimmed = name.trim();
		if (trimmed === "") {
			setError("名稱不能是空白");
			return;
		}
		setError(null);
		save.mutate(trimmed, {
			onSuccess: close,
			onError: (caught: unknown) => {
				setError(
					caught instanceof ApiError && caught.status === 422
						? describeFieldErrors(caught).join("；")
						: "儲存失敗，請再試一次",
				);
			},
		});
	}

	if (meQuery.isPending) return <Card><p>載入中…</p></Card>;
	if (me == null) return <Card><p>無法載入帳號資料</p></Card>;

	return (
		<Card>
			<p className={styles.name}>{me.display_name}</p>
			<p className={styles.email}>{me.email}</p>
			{editing ? (
				<form className={styles.form} onSubmit={handleSubmit} noValidate>
					<label htmlFor="display-name">顯示名稱</label>
					<input
						id="display-name"
						ref={inputRef}
						maxLength={50}
						autoComplete="nickname"
						value={name}
						onChange={(event) => setName(event.target.value)}
					/>
					{error !== null && (
						<p role="alert" className={styles.error}>
							{error}
						</p>
					)}
					<div className={styles.actions}>
						<button type="submit" className={`${ui.secondary} ${ui.primary}`} disabled={save.isPending}>
							儲存
						</button>
						<button type="button" className={ui.secondary} onClick={close}>
							取消
						</button>
					</div>
				</form>
			) : (
				<div className={styles.actions}>
					<button
						ref={editButtonRef}
						type="button"
						className={ui.secondary}
						onClick={() => {
							setName(me.display_name);
							setEditing(true);
						}}
					>
						修改名稱
					</button>
					<Link to="/me/password" className={styles.link}>
						修改密碼
					</Link>
				</div>
			)}
		</Card>
	);
}
```

（`ui.secondary` 給尺寸，`ui.primary` 換成實心——兩者同權重，`.primary` 在 `ui.module.css` 裡寫在後面，所以贏；
用眼睛確認一次。`.form label` 的樣式照 `FriendsCard.module.css` 的 `.form label`：13px、灰色；輸入框 44px 高、
`width: 100%`、邊框與圓角用設計變數。）

`AccountCard.module.css`：`.name`（600、16px、margin 0）、`.email`（`--color-text-muted`、margin 0）、
`.form`（flex column、gap `--space-2`、`margin-top: var(--space-3)`）、`.form label`、`.form input`
（`min-height: 44px; box-sizing: border-box; width: 100%; padding: var(--space-2) var(--space-3); border: 1px solid var(--color-border); border-radius: var(--radius-button); background: var(--color-bg); color: var(--color-text);`）、
`.actions`（flex、wrap、gap `--space-2`、`margin-top: var(--space-3)`）、`.link`（`display: inline-flex; align-items: center; min-height: 44px;`）、
`.error`（`--color-danger`、margin 0）。**只用設計變數**（`tests/css-tokens.test.ts` 會掃）。

`frontend/src/components/TargetsCard.tsx`：

```tsx
import { Link } from "react-router";
import { useDailyStats } from "../api/stats";
import { formatMacro } from "../lib/decimal";
import { TARGET_FIELDS } from "../lib/targets";
import { Card } from "./Card";
import styles from "./TargetsCard.module.css";
import ui from "./ui.module.css";

/** 「我的」的每日目標（帳號設定規格 §5.1）。讀 `stats/daily` 的 `target`——那是後端用使用者的
 *  今天算的「今天生效的目標」；存完 `/me/targets` 失效它，這裡跟總覽、飲食頁一起更新。 */
export function TargetsCard() {
	const stats = useDailyStats();
	const target = stats.data?.target ?? null;

	return (
		<Card testId="targets-card">
			<h2 className={`${ui.sectionTitle} ${styles.title}`}>每日目標</h2>
			{stats.isPending ? (
				<p>載入中…</p>
			) : stats.data == null ? (
				<p>無法載入目前的目標</p>
			) : (
				<dl className={styles.list}>
					{TARGET_FIELDS.map((field) => {
						const value = target?.[field.key] ?? null;
						return (
							<div key={field.key} className={styles.row}>
								<dt>{field.label}</dt>
								<dd>
									{value === null ? "未設定" : `${formatMacro(value)} ${field.unit}`}
								</dd>
							</div>
						);
					})}
				</dl>
			)}
			<Link to="/me/targets" aria-label="修改每日目標" className={styles.link}>
				修改
			</Link>
		</Card>
	);
}
```

`TargetsCard.module.css`：`.title`（margin 0 0 `--space-2`）、`.list`（margin 0）、`.row`（flex、`justify-content: space-between`、
`padding: var(--space-1) 0`）、`.row dd`（margin 0、`font-variant-numeric: tabular-nums`）、`.link`（`display: inline-flex; align-items: center; min-height: 44px;`）。

`frontend/src/screens/Me.tsx`：原本那張只顯示 email 的 `<Card>` 換成 `<AccountCard />`，緊接著 `<TargetsCard />`，
然後 `<FriendsCard />`。`meQuery` 只剩 `isAdmin` 在用（保留）。`Me.module.css` 的 `.email` 沒人用了就刪掉。

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：全綠。

- [ ] **Step 5: 突變**：
  - `handleSubmit` 不 `trim()` → 「只送 display_name」那條紅（body 是 `"  新名字 "`）。
  - `close()` 不設 `returnFocus.current = true` → 兩條焦點斷言紅。
  - `TargetsCard` 的 `target?.[field.key] ?? null` 改成 `target?.[field.key] ?? "0"` → 「未設定」兩條紅。

- [ ] **Step 6: 用眼睛看一次**：`npm run dev`＋Playwright 截圖（或瀏覽器）`/me`，390×844 與 1280×800、淺色與深色，
  打開「修改名稱」各一張，存 scratchpad 的 `me-account-*.png`。看：卡片的內距、44px 的按鈕與連結、`dl` 一列一項左右對齊。

- [ ] **Step 7: 全部前端檢查**（typecheck、lint、test）。另外 **grep e2e**：
  `grep -rn "getByText(ADMIN.email)\|name: \"修改\|name: \"儲存\"\|name: \"取消\"" frontend/e2e` ——確認新加的名字不會讓既有 e2e 撞嚴格模式
  （`touch-targets.spec.ts:111` 的「修改」有 `exact: true`、在別的頁面；`edit-meal.spec.ts:70` 的「儲存」限定在 editor 裡）。

- [ ] **Step 8: Commit**

```
feat(frontend): 「我的」的帳號卡片（行內改名稱）與每日目標卡片

帳號卡片顯示名字與 email、修改名稱（只送 display_name，取消或存好焦點回到按鈕）、修改密碼的連結。
每日目標卡片讀 stats/daily 的 target，沒設的寫「未設定」。me.test 的「重新整理」改用不同的名字：
帳號卡片也顯示名字，同一個字串會撞成兩個元素、也分不出是不是重新整理帶來的。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/AccountCard.tsx frontend/src/components/AccountCard.module.css frontend/src/components/TargetsCard.tsx frontend/src/components/TargetsCard.module.css frontend/src/screens/Me.tsx frontend/src/screens/Me.module.css frontend/tests/me.test.tsx
git commit -F "$S/commit-msg.txt"
```

---

## Task 8：前端——`/me/targets`

**Files:**
- Create: `frontend/src/screens/Targets.tsx`、`frontend/tests/targets.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 寫失敗的測試** `frontend/tests/targets.test.tsx`

用 `mockApi`；`wrap` 用 `MemoryRouter initialEntries={["/me/targets"]}` 加
`<Routes><Route path="/me/targets" element={<Targets />} /><Route path="/me" element={<h1>我的</h1>} /></Routes>`；
QueryClient 由測試建立並傳進去（要讀快取）。測試：

1. **預填**：stats 的 target 是 `{kcal: "1800.00", protein_g: "120.00", fat_g: null, carb_g: null}` →
   `熱量（kcal）` 的值是 `"1800"`、`蛋白質（g）` 是 `"120"`、另外兩格空白。
2. **送出的 body**：清空蛋白質、脂肪填 `60` → 按「儲存」→ PUT body 是
   `{kcal: "1800", protein_g: null, fat_g: "60", carb_g: null}`。
3. **存好之後失效兩個 query 並回到 /me**：QueryClient 設 `staleTime: 60_000`，先
   `client.setQueryData(queryKeys.rangeStats("2019-06-28", "2019-07-04"), {...})` 並用一個掛著的元件（或
   `client.getQueryState(...)?.isInvalidated`）證明它被失效；`dailyStats` 同理（`isInvalidated === true`）。
   最後畫面出現 `<h1>我的</h1>`。**斷言要對 `queryKeys.*` 實際產生的 key**，不要寫死字面值（第 23 種）。
4. **前端檢查擋住、不送**：熱量填 `0` → `role="alert"` 有「熱量要是大於 0 的數字」；`12.345` →「熱量最多兩位小數」；
   `20001` →「熱量不能超過 20000」；三種都**等一下**（`await new Promise(r => setTimeout(r, 50))`）之後斷言沒有 PUT（第 41 種）。
5. **讀不到目前的目標**：stats 回 500 → 「無法載入目前的目標」、**沒有**「儲存」按鈕（先等那句話出現再斷言沒有，第 41 種）。
6. **409** → 顯示後端訊息；**422** → `describeFieldErrors`；**500** → 「儲存失敗，請再試一次」；都留在這一頁。
7. **全部清空也能存**（＝今天起沒有目標）：四個 `null`。

- [ ] **Step 2: 跑測試確認失敗**：`npx vitest run tests/targets.test.tsx`。Expected：收集失敗（`../src/screens/Targets` 不存在）。

- [ ] **Step 3: 實作** `frontend/src/screens/Targets.tsx`：

```tsx
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { useNavigate } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { queryKeys } from "../api/queries";
import { type DailyStats, useDailyStats } from "../api/stats";
import { setTargetFromToday, type TargetToday } from "../api/targets";
import ui from "../components/ui.module.css";
import {
	checkTargetInput,
	formatMacro,
	type TargetInputProblem,
} from "../lib/decimal";
import { TARGET_FIELDS, type TargetKey } from "../lib/targets";

type Values = Record<TargetKey, string>;

function problemText(
	problem: TargetInputProblem,
	label: string,
	max: string,
): string {
	switch (problem) {
		case "not-positive-decimal":
			return `${label}要是大於 0 的數字`;
		case "too-precise":
			return `${label}最多兩位小數`;
		case "too-large":
			return `${label}不能超過 ${max}`;
	}
}

/** `/me/targets`（帳號設定規格 §5.2）。 */
export function Targets() {
	const stats = useDailyStats();
	return (
		<section className={ui.screen}>
			<h1>每日目標</h1>
			{stats.isPending ? (
				<p>載入中…</p>
			) : stats.data == null ? (
				// 不顯示空白表單：空白存下去＝把目標清掉。
				<p role="alert">無法載入目前的目標</p>
			) : (
				<TargetsForm current={stats.data.target} />
			)}
		</section>
	);
}

function initialValues(current: DailyStats["target"]): Values {
	const values = {} as Values;
	for (const field of TARGET_FIELDS) {
		const value = current?.[field.key] ?? null;
		values[field.key] = value === null ? "" : formatMacro(value);
	}
	return values;
}

function TargetsForm({ current }: { current: DailyStats["target"] }) {
	const queryClient = useQueryClient();
	const navigate = useNavigate();
	const [values, setValues] = useState<Values>(() => initialValues(current));
	const [errors, setErrors] = useState<string[]>([]);

	const save = useMutation({
		mutationFn: (body: TargetToday) => setTargetFromToday(body),
		onSuccess: () => {
			// 總覽、飲食頁的分母（今天）與趨勢（每一天生效的目標）都要重抓。
			void queryClient.invalidateQueries({ queryKey: queryKeys.dailyStats });
			void queryClient.invalidateQueries({ queryKey: queryKeys.rangeStatsAll });
		},
	});

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		const problems: string[] = [];
		const body = {} as Record<TargetKey, string | null>;
		for (const field of TARGET_FIELDS) {
			const raw = values[field.key];
			const problem = checkTargetInput(raw, field.max);
			if (problem !== null) {
				problems.push(problemText(problem, field.label, field.max));
			}
			body[field.key] = raw.trim() === "" ? null : raw.trim();
		}
		setErrors(problems);
		if (problems.length > 0) return;
		// 導頁放在 mutate 的 callback：元件卸載之後不會跑（handover §7）。
		save.mutate(body, {
			onSuccess: () => navigate("/me"),
			onError: (caught: unknown) => {
				if (caught instanceof ApiError && caught.status === 409) {
					setErrors([caught.message]);
				} else if (caught instanceof ApiError && caught.status === 422) {
					setErrors(describeFieldErrors(caught));
				} else {
					setErrors(["儲存失敗，請再試一次"]);
				}
			},
		});
	}

	return (
		<form onSubmit={handleSubmit} noValidate>
			<p>留空＝不設定。從今天開始生效，之前的日子維持原本的目標。</p>
			{TARGET_FIELDS.map((field) => (
				<div key={field.key}>
					<label htmlFor={`target-${field.key}`}>
						{field.label}（{field.unit}）
					</label>
					<input
						id={`target-${field.key}`}
						inputMode="decimal"
						autoComplete="off"
						value={values[field.key]}
						onChange={(event) =>
							setValues((prev) => ({ ...prev, [field.key]: event.target.value }))
						}
					/>
				</div>
			))}
			{errors.length > 0 && (
				<ul role="alert">
					{errors.map((message) => (
						<li key={message}>{message}</li>
					))}
				</ul>
			)}
			<button type="submit" disabled={save.isPending}>
				儲存
			</button>
		</form>
	);
}
```

（`<form>` 是 `.screen` 的直接子元素 → 一張卡片；裡面的 `<div>` 不是直接子元素，不會變成卡片。說明文字放在卡片裡。
`ul[role=alert]` 的樣式 `ui.module.css` 已經有。`DailyStats["target"]` 的型別以 `schema.d.ts` 為準。）

`frontend/src/App.tsx`：import `Targets`，`/me` 之後加 `<Route path="/me/targets" element={<Targets />} />`。

- [ ] **Step 4: 跑測試確認通過**：同 Step 2。Expected：全綠。

- [ ] **Step 5: 突變**：
  - 拿掉 `invalidateQueries({ queryKey: queryKeys.rangeStatsAll })` → 第 3 條紅。
  - `body[field.key] = raw.trim() === "" ? null : …` 改成 `raw.trim()` → 第 2、7 條紅（送出 `""`）。
  - `Targets` 的「沒有資料」分支改成畫空白表單（`<TargetsForm current={null} />`）→ 第 5 條紅。

- [ ] **Step 6: 用眼睛看一次**：`/me/targets`，390×844 與 1280×800（電腦版內容最寬 480），淺色與深色，有一個錯誤訊息時各一張。

- [ ] **Step 7: 全部前端檢查**。

- [ ] **Step 8: Commit**

```
feat(frontend): /me/targets——每日目標從今天起生效

預填今天生效的目標；空白＝不設定；前端先擋 0、三位小數、超過上限。存好之後失效今天的統計與
所有期間的趨勢，回到「我的」。讀不到目前的目標時不顯示空白表單（存下去等於清掉）。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/Targets.tsx frontend/src/App.tsx frontend/tests/targets.test.tsx
git commit -F "$S/commit-msg.txt"
```

---

## Task 9：前端——`/me/password`

**Files:**
- Create: `frontend/src/screens/ChangePassword.tsx`、`frontend/tests/change-password.test.tsx`
- Modify: `frontend/src/App.tsx`

- [ ] **Step 1: 寫失敗的測試** `frontend/tests/change-password.test.tsx`（`mockApi`；`MemoryRouter`；`beforeEach` 同 `me.test.tsx`）：

1. **成功**：填「目前的密碼」`old-password`、「新密碼」（`getByLabelText("新密碼", { exact: true })`）`new-password-1`、
   「再輸入一次新密碼」→ 按「更新密碼」→ `role="status"` 是「密碼已更新。其他裝置都已登出，這台不用重新登入。」、
   **有焦點**；`getRefreshToken()` 是 mock 回的 `new-r`；有「回我的」連結（`href="/me"`）；表單不見了。
2. **前端檢查都不送**（各自等一下再斷言沒有 POST）：新密碼 7 字 →「新密碼至少要 8 個字」；兩次不一樣 →「兩次輸入的新密碼不一樣」；
   新＝目前 →「新密碼不能跟目前的密碼一樣」。
3. `422 CURRENT_PASSWORD_INCORRECT` → `role="alert"` 是後端訊息「目前的密碼不正確」；`getRefreshToken()` 還是舊的。
4. `429`（`Retry-After: 42`、`TOO_MANY_LOGIN_ATTEMPTS`、「登入嘗試次數過多，請稍後再試」）→
   「登入嘗試次數過多，請稍後再試（42 秒後可再試）」。
5. 網路錯誤（handler 丟例外）→「修改失敗，請再試一次」。
6. **送出時不會觸發換票**：數 `/api/auth/refresh` 的呼叫次數是 0（422 不是 401，第 18 種的作法）。

- [ ] **Step 2: 跑測試確認失敗**：收集失敗（模組不存在）。

- [ ] **Step 3: 實作** `frontend/src/screens/ChangePassword.tsx`：

```tsx
import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { changePassword } from "../auth/session";
import ui from "../components/ui.module.css";

const MIN_LENGTH = 8; // 後端 MIN_PASSWORD_LENGTH

/** `/me/password`（帳號設定規格 §5.3）。 */
export function ChangePassword() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const doneRef = useRef<HTMLParagraphElement>(null);

	// 表單（連同剛按的送出鈕）整個不見了——焦點要有地方去。
	useEffect(() => {
		if (done) doneRef.current?.focus();
	}, [done]);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		if (next.length < MIN_LENGTH) return setError("新密碼至少要 8 個字");
		if (next !== confirm) return setError("兩次輸入的新密碼不一樣");
		if (next === current) return setError("新密碼不能跟目前的密碼一樣");
		setBusy(true);
		try {
			await changePassword(current, next);
			setDone(true);
		} catch (caught) {
			if (caught instanceof ApiError && caught.retryAfterSeconds !== null) {
				setError(`${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`);
			} else if (
				caught instanceof ApiError &&
				(caught.code === "CURRENT_PASSWORD_INCORRECT" ||
					caught.code === "PASSWORD_UNCHANGED")
			) {
				setError(caught.message);
			} else if (caught instanceof ApiError && caught.status === 422) {
				setError(describeFieldErrors(caught).join("；"));
			} else {
				setError("修改失敗，請再試一次");
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className={ui.screen}>
			<h1>修改密碼</h1>
			{done ? (
				<div>
					<p role="status" tabIndex={-1} ref={doneRef}>
						密碼已更新。其他裝置都已登出，這台不用重新登入。
					</p>
					<Link to="/me">回我的</Link>
				</div>
			) : (
				<form onSubmit={handleSubmit} noValidate>
					<label htmlFor="current-password">目前的密碼</label>
					<input id="current-password" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
					<label htmlFor="new-password">新密碼</label>
					<input id="new-password" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} />
					<label htmlFor="confirm-password">再輸入一次新密碼</label>
					<input id="confirm-password" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={busy}>
						更新密碼
					</button>
				</form>
			)}
		</section>
	);
}
```

（「回我的」在 `<div>` 卡片裡不是 `.screen > a`，要自己給 44px：在這個檔案旁加一個小 module 或用 `AccountCard.module.css`
的 `.link` 那種寫法——**不要**複製到第三份；如果第三次需要「44px 的連結」，抽成 `ui.module.css` 的 `.linkTarget`，
並把 Task 7 的兩處換過去。）

`App.tsx`：`<Route path="/me/password" element={<ChangePassword />} />`。

- [ ] **Step 4: 跑測試確認通過**。

- [ ] **Step 5: 突變**：
  - 拿掉 `next === current` 那一行 → 第 2 條的第三種紅（請求送出去了）。
  - `useEffect` 裡不 `focus()` → 第 1 條的焦點斷言紅。

- [ ] **Step 6: 用眼睛看一次**（390×844、1280×800；淺色、深色；錯誤與成功各一張）。

- [ ] **Step 7: 全部前端檢查**。

- [ ] **Step 8: Commit**

```
feat(frontend): /me/password——改密碼，其他裝置登出、這台換上新的票

前端先擋：至少 8 字、兩次一樣、不能跟目前的一樣。成功後換上後端回的新票、顯示確認並把焦點移過去；
目前的密碼錯、太頻繁（帶秒數）各有訊息。錯誤都是 422／429，不會觸發換票。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/ChangePassword.tsx frontend/src/App.tsx frontend/tests/change-password.test.tsx
git commit -F "$S/commit-msg.txt"
```

（如果抽了 `.linkTarget`，把 `ui.module.css` 與 Task 7 的檔案一起 add，commit 訊息加一行說明。）

---

## Task 10：前端——管理員的「所有帳號」

**Files:**
- Create: `frontend/src/components/AccountsAdmin.tsx`、`AccountsAdmin.module.css`、`frontend/tests/accounts-admin.test.tsx`
- Modify: `frontend/src/screens/Me.tsx`、`frontend/tests/me.test.tsx`

- [ ] **Step 1: 寫失敗的測試** `frontend/tests/accounts-admin.test.tsx`（`mockApi`；`/api/admin/users/…/password-reset` 排在 `/api/admin/users` 前面）：

1. 清單：三個帳號（自己＝管理員 id 1、另一個管理員 id 2、小明 id 3）。`/api/me` 回 id 1。→ **自己不在清單裡**
   （`queryByText("kenny@example.com")` 在卡片內是 null——先等「小明」出現再斷言，第 41 種）；另一個管理員有「管理員」標籤、
   有「用命令列重設」、**沒有**產生按鈕；小明有按鈕「產生重設密碼連結：小明（ming@example.com）」。
   名字與 email 是**分開的元素**：`getByText("小明", { exact: true })` 與 `getByText("ming@example.com")` 都找得到，
   而 `queryByText("小明（ming@example.com）")` 是 null。
2. 產生：按小明的按鈕 → POST `/api/admin/users/3/password-reset` → 標籤「重設密碼連結」的唯讀輸入框值是
   `${location.origin}/reset-password#tok-3`；有「給 小明 的重設密碼連結」與「這個連結只會顯示這一次，24 小時內有效、只能用一次。再產生一次，舊的就不能用了。」
3. 複製：`navigator.clipboard.writeText` 被呼叫一次、參數是那條連結；`role="status"`「已複製」。
4. `422 RESET_NOT_FOR_ADMINS`／`404 USER_NOT_FOUND` → 後端訊息在卡片層（`role="alert"`），清單被重抓（數 GET 次數 +1）。
5. 500 → 「產生失敗，請再試一次」。
6. 「我的」：一般使用者沒有「所有帳號」標題；管理員有（加在 `me.test.tsx`，管理員那幾條的 mock 補 `/api/admin/users`）。

- [ ] **Step 2: 跑測試確認失敗**：收集失敗；`me.test.tsx` 新的那條 FAIL。

- [ ] **Step 3: 實作** `frontend/src/components/AccountsAdmin.tsx`——結構照 `InviteFriends.tsx`（建立後的連結區塊、
分享、複製、`copyStatus`、卡片層的錯誤），差別：

```tsx
type Created = { userId: number; name: string; token: string };

export function AccountsAdmin() {
	const queryClient = useQueryClient();
	const users = useAdminUsers();
	const me = useMe().data;
	const [created, setCreated] = useState<Created | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [copyStatus, setCopyStatus] = useState<string | null>(null);

	const create = useMutation({
		mutationFn: (user: AdminUser) => createPasswordReset(user.id),
		onSuccess: (result, user) => {
			setCreated({ userId: user.id, name: user.display_name, token: result.token });
			setNotice(null);
			setCopyStatus(null);
		},
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && (caught.status === 404 || caught.status === 422)) {
				// 清單是舊的（帳號被刪、剛被升成管理員）：訊息放卡片層，重抓清單。
				setNotice(caught.message);
				void queryClient.invalidateQueries({ queryKey: queryKeys.adminUsers });
			} else {
				setNotice("產生失敗，請再試一次");
			}
		},
	});

	// 不列自己：自己的帳號在最上面的帳號卡片；同一個 email 出現兩次，e2e/auth.spec.ts 的
	// getByText(ADMIN.email) 會撞嚴格模式（帳號設定規格 §5.4）。
	const others = (users.data ?? []).filter((user) => user.id !== me?.id);
	// …h2「所有帳號」、created 區塊（label「重設密碼連結」、input readOnly、分享、複製、說明文字）、
	//   notice（role=alert）、清單：每列 <span>{name}</span><span className={styles.muted}>{email}</span>
	//   管理員：<span className={ui.tag}>管理員</span> 與 <span className={styles.muted}>用命令列重設</span>
	//   一般使用者：<button className={ui.secondary} aria-label={`產生重設密碼連結：${name}（${email}）`} …>產生重設密碼連結</button>
}
```

- 連結用 `resetLink(created.token)`；說明文字寫死上面第 2 條那句。
- 「名字」與「email」**各自一個元素**，不要拼成「名字（email）」（`e2e/invites.spec.ts` 用 `getByText(\`E2E 朋友（${email}）\`)`）。
- 樣式：`AccountsAdmin.module.css` 從 `InviteFriends.module.css` 抄需要的 class（`.title`、`.subtitle`、`.created`、`.actions`、`.list`、`.row`、`.muted`、`.error`），
  按鈕用 `ui.secondary`（44px）。
- `Me.tsx`：`{isAdmin && <InviteFriends />}` 之後加 `{isAdmin && <AccountsAdmin />}`。

- [ ] **Step 4: 跑測試確認通過**。

- [ ] **Step 5: 突變**：
  - 拿掉 `.filter((user) => user.id !== me?.id)` → 第 1 條紅。
  - `onError` 不失效 `adminUsers` → 第 4 條紅。

- [ ] **Step 6: 用眼睛看一次**（管理員登入的 `/me`，390×844 與 1280×800；產生一條連結之後）。

- [ ] **Step 7: 全部前端檢查**；`grep -rn "getByText" frontend/e2e/auth.spec.ts frontend/e2e/invites.spec.ts frontend/e2e/friends.spec.ts`，
  逐一確認在管理員的「我的」上不會因為「所有帳號」多出同樣的字串。

- [ ] **Step 8: Commit**

```
feat(frontend): 「我的」的「所有帳號」——管理員替朋友產生重設密碼連結

列出自己以外的帳號；一般使用者可以產生 24 小時的一次性連結（只顯示一次，可分享、複製），
管理員寫「用命令列重設」。帳號被刪或角色變了時訊息在卡片層並重抓清單。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/components/AccountsAdmin.tsx frontend/src/components/AccountsAdmin.module.css frontend/src/screens/Me.tsx frontend/tests/accounts-admin.test.tsx frontend/tests/me.test.tsx
git commit -F "$S/commit-msg.txt"
```

---

## Task 11：前端——`/reset-password`

**Files:**
- Create: `frontend/src/screens/ResetPassword.tsx`、`frontend/tests/reset-password.test.tsx`
- Modify: `frontend/src/App.tsx`、`frontend/tests/app.test.tsx`

- [ ] **Step 1: 寫失敗的測試**

`frontend/tests/reset-password.test.tsx`——沒登入的畫面，照 `tests/join.test.tsx` 自己 spy `fetch`（`backend({ status, reset })`）：

1. `#` 後面空的 → 失效畫面（「這個重設密碼連結已經失效，請跟管理員要一個新的」＋「去登入」`href="/"`），**沒有打任何 API**。
2. `valid: false` → 失效畫面、沒有表單。
3. `password-reset-status` 回 422 → 失效畫面；回 500 或丟例外 →「無法確認連結，請檢查網路後重新整理」。
4. 有效 → 表單：「新密碼」（`exact: true`）、「再輸入一次新密碼」、按鈕「重設密碼」。7 字 →「新密碼至少要 8 個字」不送；兩次不一樣 →「兩次輸入的新密碼不一樣」不送（等一下再斷言）。
5. 成功（204）→ `role="status"`「密碼已重設，請登入」有焦點、「去登入」`href="/"`；`window.location.pathname` 是 `/`、`hash` 是 `""`；
   **`getRefreshToken()` 是 null**（不自動登入）；送出的 body 是 `{ token: "tok-1", new_password: "…" }`。
6. 重設時 403 `RESET_LINK_INVALID` → 切到失效畫面；422 → `describeFieldErrors`；500 →「重設失敗，請再試一次」。
7. `ResetPasswordWhileLoggedIn`（`MemoryRouter initialEntries={["/reset-password#tok-1"]}`）：說明文字、「回總覽」；沒有打任何 fetch。

`frontend/tests/app.test.tsx` 加一個 `describe("App 的 /reset-password")`，照 `/join` 那三條：沒登入打開 `/reset-password#tok-1`
→ 標題「重設密碼」不是「登入」；`/reset-password/#tok-1` 也是；已登入打開 → 說明文字、不打重設端點、`location.pathname === "/reset-password"` 且 `hash === ""`。

- [ ] **Step 2: 跑測試確認失敗**：`reset-password.test.tsx` 收集失敗；`app.test.tsx` 新的三條 FAIL、既有的綠。

- [ ] **Step 3: 實作** `frontend/src/screens/ResetPassword.tsx`——結構照 `Join.tsx`：

```tsx
export const RESET_INVALID_TEXT = "這個重設密碼連結已經失效，請跟管理員要一個新的";

type Phase = "checking" | "invalid" | "unreachable" | "form" | "done";

/** 用管理員給的一次性連結設新密碼（帳號設定規格 §5.5）。沒登入、網址是 `/reset-password` 時由 `App` 顯示。 */
export function ResetPassword() {
	const [token] = useState(() => readLinkToken(window.location.hash));
	const [phase, setPhase] = useState<Phase>(token === "" ? "invalid" : "checking");
	// …password、confirm、error、busy；doneRef＋useEffect(phase === "done" → focus)…

	useEffect(() => {
		// 同 Join：checkResetLink(token) → valid ? "form" : "invalid"；422 → "invalid"；其他 → "unreachable"；cancelled 旗標
	}, [token]);

	async function handleSubmit(event: FormEvent) {
		// 前端檢查同 ChangePassword 的前兩條
		try {
			await resetPassword(token, password);
		} catch (caught) {
			// RESET_LINK_INVALID → setPhase("invalid")；422 → describeFieldErrors；其他 → "重設失敗，請再試一次"
			return;
		}
		// 碼從網址列消失（同 Join 成功時）。換成 "/"：重新整理會落在登入畫面，不是「連結失效」。
		window.history.replaceState(null, "", "/");
		setPhase("done");
	}

	return (
		<section className={ui.screen}>
			<h1>重設密碼</h1>
			{/* checking：「確認連結中…」；invalid：<p role="alert">{RESET_INVALID_TEXT}</p><a href="/">去登入</a>；
			    unreachable：<p role="alert">無法確認連結，請檢查網路後重新整理</p>；
			    done：<p role="status" tabIndex={-1} ref={doneRef}>密碼已重設，請登入</p><a href="/">去登入</a>；
			    form：新密碼、再輸入一次新密碼（autoComplete="new-password"）、錯誤、<button type="submit">重設密碼</button> */}
		</section>
	);
}

/** 已登入的人打開重設連結：不打任何重設端點（帳號設定規格 §5.5）。 */
export function ResetPasswordWhileLoggedIn() {
	const navigate = useNavigate();
	useEffect(() => {
		// 同 JoinWhileLoggedIn：走 navigate 而不是 history.replaceState（在 BrowserRouter 裡面）。
		navigate("/reset-password", { replace: true });
	}, [navigate]);
	return (
		<section className={ui.screen}>
			<h1>重設密碼連結</h1>
			<p>你已經登入了。這個連結是給忘記密碼的人用的；要改自己的密碼，請到「我的」→「修改密碼」。</p>
			<Link to="/">回總覽</Link>
		</section>
	);
}
```

`App.tsx`：

```tsx
/** 未登入時顯示重設密碼的網址（帳號設定規格 §5.5），同 JOIN_PATHS。 */
const RESET_PATHS = new Set(["/reset-password", "/reset-password/"]);
```

沒登入的分支改成三選一（`JOIN_PATHS` → `<Join>`、`RESET_PATHS` → `<ResetPassword />`、其他 `<Login>`），都包在
`<main className="app-auth">`。**`ResetPassword` 不收 `onSuccess`**——不自動登入，「去登入」是整頁的 `<a href="/">`，
重新載入後 `loggedIn` 是 false，落在登入畫面。登入後的 `<Routes>` 加
`<Route path="/reset-password" element={<ResetPasswordWhileLoggedIn />} />`。

- [ ] **Step 4: 跑測試確認通過**：`git diff frontend/tests/app.test.tsx` 只有新增的 describe。

- [ ] **Step 5: 突變**：
  - 拿掉 `window.history.replaceState(null, "", "/")` → 第 5 條紅。
  - `checkResetLink` 的錯誤分支把 500 也當成 `"invalid"` → 第 3 條紅。
  - `App.tsx` 拿掉 `RESET_PATHS` 那一支 → app.test 的兩條紅（落在登入）。

- [ ] **Step 6: 用眼睛看一次**：用 Task 5 起好的本機 api，以管理員登入產生一條真的連結，截圖 `/reset-password#<碼>`
  與 `/reset-password#bad`，390×844 與 1280×800（`.app-auth` 最寬 400）、淺色與深色。

- [ ] **Step 7: 全部前端檢查**。

- [ ] **Step 8: Commit**

```
feat(frontend): /reset-password——用管理員給的連結設新密碼

碼放在 # 後面；先問連結還能不能用，失效、連不上分開說。成功後碼從網址列消失、顯示「密碼已重設，
請登入」，不自動登入。已登入的人打開只看到說明，不打任何重設端點。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/src/screens/ResetPassword.tsx frontend/src/App.tsx frontend/tests/reset-password.test.tsx frontend/tests/app.test.tsx
git commit -F "$S/commit-msg.txt"
```

---

## Task 12：e2e

**Files:**
- Create: `frontend/e2e/new-account.ts`、`frontend/e2e/account-settings.spec.ts`

- [ ] **Step 0: 準備**：`docker compose up -d --build api`、`docker compose ps` 看到 `(healthy)`；dev 資料庫是 `0016`
  （Task 5 Step 7）。在 `frontend/` 跑一次**既有的整套** `npx playwright test`，記下基準（應該全綠）。

- [ ] **Step 1: 寫 e2e**（前面的 task 已經實作完，「先紅」用 Step 3 的突變證明）

`frontend/e2e/new-account.ts`：

```ts
import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

export type NewAccount = { email: string; password: string; name: string };

/** 每條測試自己開一個帳號（帳號設定規格 §7.3）：這些測試會改密碼、改目標——
 *  動共用的示範帳號會弄壞別的 spec（它們用固定密碼登入、斷言總覽的數字）。 */
export async function newAccount(
	request: APIRequestContext,
	label: string,
): Promise<NewAccount> {
	const login = await request.post("/api/auth/login", {
		data: { email: ADMIN.email, password: ADMIN.password },
	});
	expect(login.ok()).toBe(true);
	const { access_token } = await login.json();
	const invite = await request.post("/api/admin/invites", {
		headers: { authorization: `Bearer ${access_token}` },
		data: { note: `e2e ${label}` },
	});
	expect(invite.status()).toBe(201);
	const { token } = await invite.json();
	const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const account = {
		email: `e2e.${label}.${stamp}@example.com`,
		password: "first-pass-12345",
		name: `E2E ${label} ${stamp}`,
	};
	const register = await request.post("/api/auth/register", {
		data: {
			email: account.email,
			password: account.password,
			display_name: account.name,
			invite_token: token,
		},
	});
	expect(register.status()).toBe(201);
	return account;
}

export async function loginAs(page: Page, account: { email: string; password: string }) {
	await page.goto("/");
	await page.getByLabel("Email").fill(account.email);
	await page.getByLabel("密碼").fill(account.password);
	await page.getByRole("button", { name: "登入" }).click();
	await expect(page.getByRole("heading", { name: "總覽" })).toBeVisible();
}
```

`frontend/e2e/account-settings.spec.ts`：

```ts
import { expect, test } from "@playwright/test";
import { loginAs, newAccount } from "./new-account.ts";
import { expectTouchTargets, login } from "./touch-targets.ts";

const PHONE = { width: 390, height: 844 };

test("每日目標從今天起生效：總覽的分母跟著變，同一天再改一次也行", async ({
	page,
	request,
}) => {
	// 預設 1280×720＝電腦版（SideNav 的連結名稱跟 TabBar 一樣）。
	const account = await newAccount(request, "targets");
	await loginAs(page, account);
	const kcal = page.getByTestId("today-kcal");
	await expect(kcal).toContainText("kcal");
	await expect(kcal).not.toContainText("/");

	for (const value of ["1800", "1900"]) {
		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(page.getByRole("heading", { name: "我的", exact: true })).toBeVisible();
		await page.getByRole("link", { name: "修改每日目標" }).click();
		await expect(page.getByLabel("熱量（kcal）")).toBeVisible(); // 只有目標頁有
		await page.getByLabel("熱量（kcal）").fill(value);
		await page.getByLabel("蛋白質（g）").fill("120");
		await page.getByRole("button", { name: "儲存", exact: true }).click();
		// 回到「我的」：卡片上是新的值（第二圈走的是「今天才開始→原地改」）。
		await expect(page.getByRole("heading", { name: "我的", exact: true })).toBeVisible();
		await expect(page.getByTestId("targets-card")).toContainText(`${value} kcal`);
		await page.getByRole("link", { name: "總覽", exact: true }).click();
		await expect(kcal).toContainText(`/ ${value} kcal`);
	}
});

test.describe("手機尺寸", () => {
	test.use({ viewport: PHONE });

	test("改密碼：其他裝置登出、這台繼續用；之後只認新密碼", async ({
		browser,
		request,
	}) => {
		const account = await newAccount(request, "password");
		const newPassword = "second-pass-12345";
		const deviceA = await browser.newContext({ viewport: PHONE });
		const pageA = await deviceA.newPage();
		await loginAs(pageA, account);
		const deviceB = await browser.newContext({ viewport: PHONE });
		const pageB = await deviceB.newPage();
		await loginAs(pageB, account);
		const refreshB = await pageB.evaluate(() => localStorage.getItem("refresh_token"));
		expect(refreshB).toBeTruthy();

		await pageA.getByRole("link", { name: "我的", exact: true }).click();
		await expect(pageA.getByRole("heading", { name: "我的", exact: true })).toBeVisible();
		await pageA.getByRole("link", { name: "修改密碼" }).click();
		await expect(pageA.getByLabel("目前的密碼")).toBeVisible();
		await expectTouchTargets(pageA.locator("main button:visible"), "修改密碼");
		await pageA.getByLabel("目前的密碼").fill(account.password);
		await pageA.getByLabel("新密碼", { exact: true }).fill(newPassword);
		await pageA.getByLabel("再輸入一次新密碼").fill(newPassword);
		await pageA.getByRole("button", { name: "更新密碼" }).click();
		await expect(
			pageA.getByText("密碼已更新。其他裝置都已登出，這台不用重新登入。"),
		).toBeVisible();

		// B：那張 refresh token 被撤銷了。B 手上的 access token 最多還能用 15 分鐘（刻意的缺口），
		// 所以不看 B 的畫面，看伺服器。
		const replay = await request.post("/api/auth/refresh", {
			data: { refresh_token: refreshB },
		});
		expect(replay.status()).toBe(401);
		await deviceB.close();

		// A：新的那張是活的。**刻意整頁重新載入**——載入時會用 localStorage 的 refresh token 換票；
		// 新票沒存好或被撤銷了，這裡會掉回登入畫面。
		await pageA.reload();
		await expect(pageA.getByRole("heading", { name: "修改密碼" })).toBeVisible();

		await pageA.getByRole("link", { name: "我的", exact: true }).click();
		await expect(pageA.getByRole("heading", { name: "我的", exact: true })).toBeVisible();
		await pageA.getByRole("button", { name: "登出" }).click();
		await expect(pageA.getByRole("button", { name: "登入" })).toBeVisible();
		await pageA.getByLabel("Email").fill(account.email);
		await pageA.getByLabel("密碼").fill(account.password);
		await pageA.getByRole("button", { name: "登入" }).click();
		await expect(pageA.getByText("email 或密碼不正確")).toBeVisible();
		await pageA.getByLabel("密碼").fill(newPassword);
		await pageA.getByRole("button", { name: "登入" }).click();
		await expect(pageA.getByRole("heading", { name: "總覽" })).toBeVisible();
		await deviceA.close();
	});

	test("管理員產生重設密碼連結，朋友用它設新密碼；連結只能用一次", async ({
		page,
		browser,
		request,
	}) => {
		const account = await newAccount(request, "reset");
		const newPassword = "reset-pass-12345";
		// 朋友在別的裝置上本來是登入的：重設之後那張票要失效。
		const before = await request.post("/api/auth/login", {
			data: { email: account.email, password: account.password },
		});
		const oldRefresh = (await before.json()).refresh_token as string;

		await login(page); // ADMIN
		await page.getByRole("link", { name: "我的", exact: true }).click();
		await expect(page.getByRole("heading", { name: "所有帳號" })).toBeVisible();
		await page
			.getByRole("button", {
				name: `產生重設密碼連結：${account.name}（${account.email}）`,
				exact: true,
			})
			.click();
		const link = await page.getByLabel("重設密碼連結", { exact: true }).inputValue();
		expect(link).toContain("/reset-password#");
		await expectTouchTargets(page.locator("main button:visible"), "我的：所有帳號");

		const friend = await browser.newContext({ viewport: PHONE });
		const friendPage = await friend.newPage();
		await friendPage.goto(link);
		await expect(friendPage.getByLabel("再輸入一次新密碼")).toBeVisible();
		await expectTouchTargets(friendPage.locator("button:visible"), "重設密碼");
		await friendPage.getByLabel("新密碼", { exact: true }).fill(newPassword);
		await friendPage.getByLabel("再輸入一次新密碼").fill(newPassword);
		await friendPage.getByRole("button", { name: "重設密碼" }).click();
		await expect(friendPage.getByText("密碼已重設，請登入")).toBeVisible();
		expect(new URL(friendPage.url()).hash).toBe("");

		const replay = await request.post("/api/auth/refresh", {
			data: { refresh_token: oldRefresh },
		});
		expect(replay.status()).toBe(401);

		await friendPage.getByRole("link", { name: "去登入" }).click();
		await loginAs(friendPage, { email: account.email, password: newPassword });
		await friend.close();

		const stranger = await browser.newContext({ viewport: PHONE });
		const strangerPage = await stranger.newPage();
		await strangerPage.goto(link);
		await expect(
			strangerPage.getByText("這個重設密碼連結已經失效，請跟管理員要一個新的"),
		).toBeVisible();
		await expect(strangerPage.getByRole("button", { name: "重設密碼" })).toHaveCount(0);
		await stranger.close();
	});
});
```

（`loginAs` 開頭的 `page.goto("/")` 在「去登入」之後是多餘的一次載入——無害，因為還沒登入。）

- [ ] **Step 2: 跑**

```
cd frontend && npx playwright test e2e/account-settings.spec.ts
```

Expected：3 passed。

- [ ] **Step 3: 突變**（每個改完跑 Step 2，確認紅，再改回；後端的突變要 `docker compose up -d --build api` 才生效，改回之後再 build 一次）：
  - 前端 `Targets.tsx` 拿掉 `invalidateQueries({ queryKey: queryKeys.dailyStats })` → 第一條紅（總覽還是舊的分母——`staleTime` 60 秒、從「我的」點回總覽不會自己重抓）。如果它**沒紅**，先查是不是別的東西重抓了（例如總覽掛載時 `isInvalidated`），照實回報，不要改測試。
  - 後端 `change_password` 把 `start_session` 搬到 `revoke_all_for_user` 之前 → 第二條在 `pageA.reload()` 之後紅（掉回登入畫面）。
  - 前端 `changePassword()` 拿掉 `setTokens(tokens)` → 第二條同一處紅。
  - 後端 `reset_password` 拿掉 `revoke_all_for_user`、改成 `await db.commit()` → 第三條 `replay` 那一行紅。
  - 前端 `ResetPassword.tsx` 拿掉 `replaceState` → 第三條 `hash` 那一行紅。

- [ ] **Step 4: 整套 e2e**：`npx playwright test`。Expected：基準＋3，全綠。**特別看** `auth.spec.ts`、`invites.spec.ts`、`friends.spec.ts`
  （「我的」多了卡片與「所有帳號」）。有紅就先問「是不是新元件的名字或文字讓舊選擇器對到兩個」（第 48、53 種），修選擇器的範圍或新元件，
  不要放寬斷言。

- [ ] **Step 5: 稽核紀錄真的出現**：`docker compose logs api --since 10m | grep -E "修改了密碼|產生了使用者|用重設連結"`。
  Expected：三種各至少一行；**同一段 log 裡 grep 剛才的 email 與連結的碼都找不到**（`grep -c "e2e.reset." ` 為 0）。

- [ ] **Step 6: Commit**

```
test(e2e): 帳號設定——目標、改密碼、管理員的重設連結

每條都自己開帳號（API：邀請＋註冊），不動共用的示範帳號。目標：總覽的分母跟著變、同一天改第二次。
改密碼：另一台的 refresh token 401、這台整頁重新載入還在、舊密碼登不進。重設：連結只能用一次、
舊的 session 失效、網址沒有碼。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add frontend/e2e/new-account.ts frontend/e2e/account-settings.spec.ts
git commit -F "$S/commit-msg.txt"
```

---

## Task 13：文件

**Files:**
- Modify: `docs/handover.md`、`docs/deployment.md`、`docs/superpowers/specs/2026-10-08-account-settings-design.md`

- [ ] **Step 1: `docs/handover.md`**
  - 檔頭「狀態」補一句「帳號與目標設定已實作於 `feat/account-settings`」。
  - §2 的數字：端點（`+6`：`PUT /api/targets/today`、`POST /api/me/password`、`GET /api/admin/users`、`POST /api/admin/users/{id}/password-reset`、`POST /api/auth/password-reset-status`、`POST /api/auth/password-reset`——先 `grep -c "@router\." app/api/routes/*.py` 量現況，不要直接加）、測試數（跑出來的）、資料表 `+1`、Migration 到 `0016`。
  - §2「階段進度」表加一列「帳號與目標設定」：每日目標（從今天起、過去不變）、改名稱、改密碼（其他裝置登出）、管理員的重設密碼連結（24 小時、一次性、只給一般使用者）；規格與計畫的路徑；✅（`feat/account-settings`）。
  - §3「目錄結構」：`password_resets.py` 一行。
  - §10 加一節 `### 帳號與目標設定`（放在「電腦版版面」之後），寫：
    - 機制摘要：`PUT /api/targets/today` 的三種狀態；改密碼共用登入限速、錯誤不用 401、撤銷之後才開新 session；重設連結的形狀與 `app/invites.py` 相同；`revoke_all_for_user` 的 commit 就是重設交易的 commit。
    - **已知限制**：
      1. 改密碼與重設之後，其他裝置的 access token 最多還能用 15 分鐘（§8.1 的既有缺口）。
      2. 「其他裝置」指其他瀏覽器：同一個瀏覽器的其他分頁共用 localStorage，會直接用新的票。極少見的競態：另一個分頁剛好在改密碼的那一刻用舊票換票 → 401 → 清掉 localStorage → 這個瀏覽器也被登出（再登入一次就好）。
      3. 公開的兩個重設端點不限速（同 `invite-status`）。
      4. 管理員帳號不能用重設連結；管理員忘記密碼仍要 SSH 跑 `create-admin`。
      5. 「所有帳號」看不到「這個人有沒有一條還沒用的連結」；再產生一次舊的就失效。
      6. 目標只能「從今天起」；不能設未來的期間、不能編 `label`；新端點不收 0，舊的 `POST`／`PATCH /api/targets` 仍收 0。
      7. 兩台裝置同時存目標 → 後到的 409，重存一次就好。
      8. `app.*` 的 INFO 現在會輸出（`app/main.py`）——以前寫了 INFO 的地方（如果有）現在也會出現在 `docker compose logs api`。
      9. 「所有帳號」的清單跟「邀請朋友」一樣會進離線快取（只在管理員的裝置上）。
  - §6：執行中如果長出新的「綠燈說謊」，照既有格式加一節（編號接著 53）；沒有就不加。
  - §7 的陷阱表：執行中實測到的坑（如果有）。

- [ ] **Step 2: `docs/deployment.md`**
  - 「一、首次部署」第 8 節 `create-user` 的說明後面加一段：「**朋友忘記密碼**：不用再 SSH。用管理員帳號登入 →「我的」→「所有帳號」→ 那個人的「產生重設密碼連結」，把連結傳給他（24 小時、只能用一次，他設好新密碼之後所有裝置登出）。`create-user` 留著當備案；**管理員自己的帳號**仍走 `create-admin`（重設連結不給管理員）。」
  - 「各版本的升級備註」最上面加：「**`0016_create_password_reset_tokens`（帳號與目標設定）**：只加一張表，可以退版。」
  - 「五、緊急處置」的「先試這個」加一句：知道自己的密碼的話，在「我的」→「修改密碼」改掉，效果包含登出所有其他裝置。

- [ ] **Step 3: 規格狀態**：`**狀態：** 設計定稿，待實作` → `**狀態：** 已實作`；執行中跟規格不一樣的地方補在「與原始決定的差異」。

- [ ] **Step 4: 檢查**：`git diff --stat` 只有這三個檔案；用 `newline="\n"` 的工具寫（handover §7：Windows 文字模式會把整份轉成 CRLF）——`git diff` 不該出現整份檔案的變動。

- [ ] **Step 5: Commit**

```
docs: 帳號與目標設定的交接與部署說明

交接文件：進度、數字、機制摘要與已知限制（15 分鐘的 access token、同一瀏覽器的分頁、
公開端點不限速、管理員不能用連結…）。部署手冊：朋友忘記密碼改用重設連結，不用 SSH；0016 可以退版。

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
```

```bash
git add docs/handover.md docs/deployment.md docs/superpowers/specs/2026-10-08-account-settings-design.md
git commit -F "$S/commit-msg.txt"
```

---

## 完成條件

- 後端：`pytest -q` 全綠（845 → 實際數字）、ruff、mypy 乾淨；`alembic check` 乾淨；`downgrade -1`／`upgrade head` 跑過。
- `schema.d.ts` 跟後端一致（重新產生後 `git diff --exit-code` 是 0）。
- 前端：typecheck、lint、test 全綠。
- e2e：整套全綠（基準＋3）。
- 每個 task 的突變都紅過、也都改回了（`git status` 乾淨，除了 `lunch.jpg`）。
- 沒有 push。
