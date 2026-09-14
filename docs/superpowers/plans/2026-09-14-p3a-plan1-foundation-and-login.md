# P3-A 計畫一：基礎建設到能登入

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 從零建起前端專案，一路到「在手機上用 Tailscale 打開、裝成 PWA、真的登入進去」。

**Architecture:** Vite + React + TypeScript（strict）放在同一個 repo 的 `frontend/`。開發與正式環境**都同源** —— dev 靠 Vite 的 `server.proxy`，prod 靠 caddy，所以跨源問題在任何環境都不存在。型別從後端的 `openapi.json` 產生並進版控，由一個 CI job 守著漂移。認證是被動反應 401，配一把跨分頁的 single-flight 鎖。

**Tech Stack:** Vite · React · TypeScript strict · Biome · Vitest + Testing Library + MSW · Playwright · decimal.js · TanStack Query · React Router · vite-plugin-pwa · Caddy

**規格：** [docs/superpowers/specs/2026-09-11-p3a-frontend-design.md](../specs/2026-09-11-p3a-frontend-design.md)

---

## 這份計畫的範圍，以及為什麼切在這裡

P3-A 規格涵蓋「基礎建設 + 四個畫面」。這份計畫**只做到能登入為止**：

| | 內容 |
|---|---|
| **這一份** | HTTPS、專案骨架、同源代理、型別產生、decimal、API client、認證層、登入畫面、PWA 殼、E2E 與 CI |
| 第二份 | 記一餐、今日總覽、拍照、離線 L2、其餘契約 E2E |

切在這裡是因為**它本身就是可運作的軟體**：走完之後你能在手機上把它裝起來、登入、看到自己的 `display_name`。而且後面三個畫面的細節，在真的用過這一份的產出之前多半會猜錯 —— 那正是 P3-A / P3-B 當初分開的同一個理由。

---

## 寫這份計畫時的一個自我約束

**上一份計畫（session 撤銷）被實作與審查找出七個缺陷，其中至少三個是「我寫了沒跑過的程式碼」。** 那是後端，而且是我熟悉的 stack。這一份是這個 repo 的第一個 TypeScript 專案，猜錯的機率只會更高。

所以這份計畫的前兩個 task 刻意**不逐字提供每一個設定檔**，而是「跑官方的 scaffold 指令，然後改這幾個具體的地方」。那不是偷懶 —— 是承認我不知道 `npm create vite` 在 2026-09 會吐出什麼版本、什麼檔案結構。**照著我瞎編的 `vite.config.ts` 抄，比照著官方 scaffold 改風險更高。**

從 Task 4 開始（我們自己的程式碼）才是完整的逐字程式碼。

**實作者請注意：這份計畫的文字不是權威。** 實測後發現不符，回報 DONE_WITH_CONCERNS 並說明實測結果，不要為了符合計畫而硬湊。

---

## ⚠️ 執行狀態：Task 1 延後，從 Task 2 開始

**2026-09-14：暫時無法操作 NAS**，所以 Task 1（HTTPS）整個延後，先做 Task 2 以後。

盤點過哪些東西真的被卡住 —— 比直覺上少：

| Task | 狀態 |
|---|---|
| **1. HTTPS** | ⏸ **整個延後**，等得到 NAS 再做 |
| 2–8（骨架 → 登入畫面） | ✅ 完全不依賴 NAS，在 `http://localhost:5173` 上開發 |
| 9. caddy | ✅ `:8080` 那份 Caddyfile 能在本機 `curl` 驗證。**路線 B 的 `tls` 是疊在它上面的**，不是取代它 |
| 10. PWA | ⚠️ 設定、建置、確認 `sw.js` 產出來了都能做；**Step 5 的真機驗證卡住** |
| 11. E2E + CI | ✅ 本機 Playwright 與 GitHub Actions 都不需要 NAS |

**沒有 NAS 就驗不了、而且不能用別的東西代替的，只有兩件事：**

1. Task 1 的 `isSecureContext` / `serviceWorker` / `locks` 三個 `true`
2. Task 10 Step 5 的「加到主畫面、standalone 啟動、飛航模式下不是恐龍頁」

**兩件事都不要打勾、不要用 `localhost` 的結果代替。** `http://localhost` 永遠是
secure context，所以本機測出來的 `true` **證明不了任何事** —— 那正是規格
§9.2 第 9 條記錄的那個假綠燈。真機驗證是那條規則唯一的執法點。

Task 6 的 `navigator.locks` 也一樣：jsdom 裡沒有它，程式碼會走 fallback 分支，
所以那條路徑在這個階段完全沒有被執行過。**這不是延後就能解決的，它需要
兩個真實的 context** —— 計畫裡已經標明那個突變預期會存活。

---

## 開始之前

後端已完成並在 master 上（503 個測試全綠）。啟動開發環境：

```bash
docker compose up -d               # api: localhost:8000，db: localhost:5433
curl -s http://localhost:8000/api/health
```

本機工具鏈（已確認）：Node **v24.11.1**、npm **11.6.2**、Docker Compose **v2.40.3**。

dev 資料庫已有可登入的帳號：`kenny.demo@example.com` / `demo-pass-12345`。

---

## 檔案結構

```
frontend/
  package.json            依賴與 scripts
  vite.config.ts          建置設定 + dev 的 /api 代理 + PWA plugin
  tsconfig.json           TypeScript strict
  biome.json              lint + format（見 Task 2 的決策說明）
  index.html
  src/
    main.tsx              進入點：掛 React、Router、QueryClient
    api/
      schema.d.ts         ← openapi-typescript 產生，進版控，不手改
      client.ts           fetch wrapper：Authorization、錯誤信封解析、401 攔截
      errors.ts           錯誤信封的型別與解析（跟 client 分開，因為它是純函式）
    auth/
      store.ts            token 存放（access 在記憶體、refresh 在 localStorage）
      refresh.ts          single-flight 鎖（分頁內 promise + 跨分頁 Web Locks）
    auth/
      session.ts          login / logout 兩個動作
    screens/
      Login.tsx
    test/
      setup.ts            Vitest 全域設定
  tests/                  Vitest 測試（跟 src 平行）
  e2e/                    Playwright
caddy/
  Caddyfile               prod 的同源代理
docker-compose.yml        新增 caddy service
.github/workflows/ci.yml  新增 frontend / contract / e2e job
```

**為什麼 `errors.ts` 跟 `client.ts` 分開：** 錯誤信封的解析是純函式（輸入一個 JSON、輸出一個型別化的錯誤），不需要 `fetch`、不需要 token、可以單獨測。混進 `client.ts` 之後，測試錯誤解析就要先架一個假的 fetch。

**這份計畫刻意不建的東西**（都留給第二份，理由見文末）：`lib/decimal.ts`、
TanStack Query、React Router、MSW。**沒有消費者的抽象層現在建等於猜**，
而這一份的範圍（登入）一個都用不到。

**為什麼 `refresh.ts` 跟 `store.ts` 分開：** `store.ts` 是「token 放在哪裡」，`refresh.ts` 是「票過期時怎麼辦」。後者有跨分頁的並行語意 —— 混在一起兩邊都會變得難測。

---

### Task 1：HTTPS —— **這個 task 有兩條路，跑完指令才知道走哪條**

**這是唯一一個資訊不足的 task，而且它排第一，因為後面的 PWA 與跨分頁鎖都建立在它上面。**

規格 §4.2：瀏覽器判斷 secure context 只看 scheme。目前的部署是 `http://100.x.y.z:8000`，**不是** secure context，於是：

| 需要 secure context | 沒有它 |
|---|---|
| `navigator.serviceWorker` | **PWA 完全裝不起來** |
| `navigator.locks` | Task 7 的跨分頁 single-flight 鎖寫不出來 |
| 「加到主畫面」提示 | 不會出現 |

而這件事 **dev 與 CI 都看不見**（`http://localhost` 是 secure context，Playwright 也是），只有真機會發現 —— 規格 §9.2 第 9 條。

- [ ] **Step 1: 在 NAS 上跑這兩條，決定走哪條路**

```bash
# SSH 進 NAS
tailscale serve --help
# 找不到指令就用完整路徑：
# /var/packages/Tailscale/target/bin/tailscale serve --help

tailscale status --json | jq -r .Self.DNSName        # 記下 MagicDNS 名稱
tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
```

**判斷：**
- `serve` 存在**且** `cert` 成功發憑證 → **走路線 A**
- 其中任一失敗 → **走路線 B**

**走完之後把另一條路線整段從這份計畫刪掉**，不要留著兩份互相矛盾的指示 —— 那正是上一份計畫踩過的坑（docstring 說要取鎖、程式碼範例沒那行）。

---

#### 路線 A：`tailscale serve` 終結 TLS（偏好）

Tailscale 自己申請與續期 `*.ts.net` 的 Let's Encrypt 憑證，NAS 上不需要開 80/443 對公網，也不需要在 caddy 裡管憑證。

- [ ] **A-1: 讓 caddy 只綁 loopback**（Task 9 會建立這個 service，這裡先記下設定值）

`docker-compose.prod.yml` 的 caddy 發佈埠是 `127.0.0.1:8080:8080`，**不是** `${BIND_ADDR}`。

- [ ] **A-2: 開 serve**

```bash
tailscale serve --bg --https 443 http://127.0.0.1:8080
tailscale serve status          # 確認對應關係
```

- [ ] **A-3: 真機驗證 secure context**

用手機開 `https://<機器名>.<tailnet>.ts.net`，在瀏覽器的 console 執行：

```js
console.log(window.isSecureContext, !!navigator.serviceWorker, !!navigator.locks)
```

Expected: `true true true`

> **這一步不能跳過也不能用 dev 環境代替。** `localhost` 永遠是 secure context，所以本機測不出任何東西。**沒有在真機上看到這三個 `true`，就當作這個 task 沒完成。**

- [ ] **A-4: 更新部署手冊**

`docs/deployment.md` 的 `## 一、首次部署`：`BIND_ADDR` 從 tailnet 位址改成 `127.0.0.1`，並新增一節說明 `tailscale serve` 是對外的唯一入口、憑證由 Tailscale 自動續期。

---

#### 路線 B：`tailscale cert` + caddy 自己終結 TLS

`serve` 不可用時的退路。**代價是憑證續期要自己排 cron** —— `tailscale cert` 發的憑證有效期同 Let's Encrypt（90 天）。

- [ ] **B-1: 產出憑證並放到 caddy 讀得到的地方**

```bash
sudo mkdir -p /volume1/docker/nutrition-tracker/caddy/certs
cd /volume1/docker/nutrition-tracker/caddy/certs
sudo tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')"
# 產出 <名稱>.crt 與 <名稱>.key
```

- [ ] **B-2: Caddyfile 用明確的憑證，不要 caddy 自己的 ACME**

Task 9 的 `caddy/Caddyfile` 改成：

```caddyfile
<機器名>.<tailnet>.ts.net {
	tls /etc/caddy/certs/<機器名>.<tailnet>.ts.net.crt /etc/caddy/certs/<機器名>.<tailnet>.ts.net.key

	handle /api/* {
		reverse_proxy api:8000
	}
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

`docker-compose.prod.yml` 的 caddy 掛載 `./caddy/certs:/etc/caddy/certs:ro`，發佈埠是 `${BIND_ADDR}:443:443`。

- [ ] **B-3: 續期 cron**

```
0 3 * * 1 cd /volume1/docker/nutrition-tracker/caddy/certs && tailscale cert "$(tailscale status --json | jq -r .Self.DNSName | sed 's/\.$//')" && docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile
```

> **這條 cron 是路線 B 唯一的持續成本，而它失敗時的症狀是「90 天後某天早上手機打不開」。** 寫進部署手冊的故障排除一節，並且在那裡明說：憑證過期時 caddy 不會自己修好。

- [ ] **B-4: 真機驗證 secure context**

同路線 A 的 A-3，一模一樣的三個 `true`，一樣不能用 dev 代替。

- [ ] **B-5: 更新部署手冊** —— 含 B-3 那條 cron 與它的故障症狀。

---

- [ ] **Step 2: Commit**

```bash
git add docs/deployment.md
git commit -m "docs: P3-A 的 HTTPS 前置——<路線 A 或 B>

瀏覽器判斷 secure context 只看 scheme，而目前的部署是純 HTTP，
所以 service worker 與 navigator.locks 都不可用，PWA 裝不起來。

這件事 dev 與 CI 都看不見（localhost 是 secure context，Playwright 也是），
只有真機會發現——已在手機上確認 isSecureContext / serviceWorker /
locks 三者皆為 true。"
```

---

### Task 2：前端骨架與工具鏈

**Files:**
- Create: `frontend/`（由 scaffold 產生）
- Modify: `.gitignore`

- [ ] **Step 1: 跑官方 scaffold**

```bash
cd F:/wallet
npm create vite@latest frontend -- --template react-ts
cd frontend
npm install
```

> **為什麼不在這裡貼一份我手寫的 `vite.config.ts` / `tsconfig.json`。** 我不知道 `npm create vite` 在 2026-09 會產生什麼版本與檔案結構，照著我瞎編的抄比照官方輸出改**風險更高**。下面只列出要**改**的具體項目。
>
> **scaffold 產生什麼，就先 commit 什麼**（下一個 step），這樣後續每一項修改都在 diff 裡看得見。

- [ ] **Step 2: 先 commit 未修改的 scaffold**

```bash
cd F:/wallet
cat >> .gitignore <<'EOF'

# 前端
frontend/node_modules/
frontend/dist/
frontend/coverage/
frontend/.vite/
frontend/test-results/
frontend/playwright-report/
EOF
git add .gitignore frontend/
git commit -m "chore: vite react-ts scaffold（未修改）

先把官方 scaffold 原樣進版控，後續每一項調整都會在 diff 裡看得見。"
```

- [ ] **Step 3: 把 TypeScript 調到 strict**

檢查 scaffold 產生的 `tsconfig.json`（或 `tsconfig.app.json`）。確認這四項為 `true`，缺的就加：

```json
{
  "compilerOptions": {
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true
  }
}
```

> `noUncheckedIndexedAccess` 不是預設值但值得開：後端的清單端點回陣列，`items[0]` 在空陣列時是 `undefined` —— 沒有這個選項，型別會騙你說它一定有值。

- [ ] **Step 4: 裝 Biome 當 lint + format**

```bash
cd frontend
npm install --save-dev --save-exact @biomejs/biome
npx biome init
```

> **這是規格沒有指定、由這份計畫決定的事，理由寫在這裡：**
>
> 規格 §3 定了建置工具、資料層、型別來源、PWA，但**沒提 lint/format**。選 Biome 的理由是它跟這個專案在 Python 那邊已經做過的取捨同構 —— `ruff` 一個工具取代了 `black` + `flake8` + `isort`，Biome 一個二進位檔取代 `eslint` + `prettier`。同一個 repo 兩邊用同一種形狀的工具，`npm run lint` 與 `ruff check` 在 CI 裡讀起來也一致。
>
> **如果你或審查者認為該用 ESLint + Prettier**（生態系更大、React 專用規則更多），那是合理的不同判斷 —— 改動範圍是 `biome.json`、`package.json` 的 scripts、與 CI 的一行。現在換比之後換便宜。

在 `package.json` 的 `scripts` 加：

```json
{
  "scripts": {
    "lint": "biome check .",
    "format": "biome check --write ."
  }
}
```

- [ ] **Step 5: 裝 Vitest 與 Testing Library**

```bash
npm install --save-dev vitest @vitest/coverage-v8 jsdom \
  @testing-library/react @testing-library/jest-dom @testing-library/user-event
```

`vite.config.ts` 加上 test 區塊（`/// <reference types="vitest" />` 放在檔案第一行）：

```ts
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    globals: true,
  },
```

Create `frontend/src/test/setup.ts`:

```ts
import "@testing-library/jest-dom/vitest";
```

`package.json` 的 scripts 加：

```json
{
  "scripts": {
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 6: 寫第一條測試，確認工具鏈真的通了**

Create `frontend/tests/smoke.test.ts`:

```ts
import { describe, expect, it } from "vitest";

describe("工具鏈", () => {
  it("跑得起來，而且 TypeScript 的 strict 真的開著", () => {
    // 這個斷言本身沒有價值，有價值的是它跑得起來這件事。
    // TypeScript 的 strict 由 `npm run typecheck` 守，不是由這裡守。
    expect(1 + 1).toBe(2);
  });
});
```

- [ ] **Step 7: 跑起來**

```bash
cd frontend
npm run test       # 預期 1 passed
npm run lint       # 預期無錯誤（scaffold 的程式碼可能需要先 npm run format）
npx tsc --noEmit   # 預期無錯誤
```

`package.json` 加 `"typecheck": "tsc --noEmit"`。

- [ ] **Step 8: Commit**

```bash
cd F:/wallet
git add frontend/ .gitignore
git commit -m "chore: 前端工具鏈——TS strict、Biome、Vitest

TypeScript 開 strict 並額外開 noUncheckedIndexedAccess：後端的清單端點
回陣列，items[0] 在空陣列時是 undefined，沒有這個選項型別會騙人。

lint/format 選 Biome 而不是 eslint+prettier：跟這個 repo 在 Python 那邊
已經做過的取捨同構（ruff 一個工具取代 black+flake8+isort）。
規格沒有指定這一項，理由記在計畫 Task 2。"
```

---

### Task 3：dev 同源 —— Vite 的 `/api` 代理

規格決策 1：**開發環境也同源**。跨源只要存在於任何一個環境，就會長出一整類只在那一邊出現的 bug，而那類 bug 在單元測試裡是隱形的。

**Files:**
- Modify: `frontend/vite.config.ts`

- [ ] **Step 1: 加代理設定**

`vite.config.ts` 的 `defineConfig` 裡加：

```ts
  server: {
    proxy: {
      // 規格決策 1：dev 也同源。瀏覽器看到的一律是 http://localhost:5173/api/...，
      // 由 Vite 轉給 localhost:8000 —— 所以 app 的程式碼裡永遠只寫相對路徑
      // "/api/..."，沒有任何地方需要知道後端在哪裡。
      //
      // 這也代表**不需要 CORS**：後端 app/main.py 沒有 CORSMiddleware，
      // 而同源之下也不該有。哪天有人為了「方便」在後端加 CORS，
      // 那是一個訊號：某個地方的同源假設破了。
      "/api": {
        target: "http://localhost:8000",
        changeOrigin: false,
      },
    },
  },
```

- [ ] **Step 2: 手動驗證代理真的通了**

```bash
cd frontend && npm run dev
```

另一個 terminal：

```bash
curl -s http://localhost:5173/api/health
```

Expected: `{"status":"ok"}`（或後端 `/api/health` 實際回的內容）

> **這一步只能手動驗。** Vite 的 dev server 不在單元測試的世界裡 —— 這是規格 §9.2 第 3 條的同一個家族（測試環境裡沒有那個東西）。Task 11 的 Playwright E2E 會是唯一自動守著它的東西。

- [ ] **Step 3: Commit**

```bash
git add frontend/vite.config.ts
git commit -m "feat: dev 走 Vite proxy，前端與 API 同源

app 的程式碼裡永遠只寫相對路徑 /api/...，沒有任何地方知道後端在哪。
這也代表不需要 CORS——後端沒有 CORSMiddleware，同源之下也不該有。"
```

---

### Task 4：型別從 `openapi.json` 產生，並讓漂移變成紅燈

規格決策 5：**與其在交接文件裡第三次警告「數值是字串」，不如讓型別檔自己說 `protein_g: string`。**

**Files:**
- Create: `frontend/src/api/schema.d.ts`（產生物，進版控）
- Modify: `frontend/package.json`
- Create: `frontend/tests/schema.test.ts`

- [ ] **Step 1: 裝工具並產生型別**

```bash
cd frontend
npm install --save-dev openapi-typescript
npx openapi-typescript http://localhost:8000/openapi.json -o src/api/schema.d.ts
```

（後端要起著：`docker compose up -d`）

`package.json` 的 scripts 加：

```json
{
  "scripts": {
    "gen:api": "openapi-typescript http://localhost:8000/openapi.json -o src/api/schema.d.ts"
  }
}
```

- [ ] **Step 2: 寫一條測試，釘住「數值是字串」這件事**

Create `frontend/tests/schema.test.ts`:

```ts
import { describe, expectTypeOf, it } from "vitest";
import type { components } from "../src/api/schema";

describe("後端契約", () => {
  it("營養素是字串，不是數字", () => {
    // 後端把 Decimal 序列化成字串以避免浮點誤差（規格 §5.1）。
    // 這條測試不是在測後端——它在測「產生的型別檔還是我們以為的那樣」。
    // 哪天有人手改 schema.d.ts、或後端改了序列化方式，這裡會紅。
    type Macros = components["schemas"]["MacrosResponse"];
    expectTypeOf<Macros["protein_g"]>().toEqualTypeOf<string>();
    expectTypeOf<Macros["kcal"]>().toEqualTypeOf<string>();
  });

  it("TokenResponse 沒有 expires_in", () => {
    // 規格 §5.5：所以前端不能排程「快過期時先換票」，一律被動反應 401。
    // 哪天後端加了這個欄位，這條測試會紅——那時要回頭讀 §6.2 重新決定，
    // 而不是默默地把排程加回來。
    type Token = components["schemas"]["TokenResponse"];
    expectTypeOf<Token>().not.toHaveProperty("expires_in");
  });
});
```

> `expectTypeOf` 是 Vitest 內建的型別層斷言，跑 `vitest run --typecheck` 才會實際檢查。下一步把它接上。

- [ ] **Step 3: 讓型別測試真的被執行**

`vite.config.ts` 的 `test` 區塊加：

```ts
    typecheck: {
      enabled: true,
      include: ["tests/**/*.test.ts"],
    },
```

Run: `cd frontend && npm run test`
Expected: 型別測試通過。

- [ ] **Step 4: 驗證這條測試真的會紅**

手動把 `src/api/schema.d.ts` 裡 `MacrosResponse` 的 `protein_g` 從 `string` 改成 `number`，重跑：

Expected: **型別測試變紅。**

改回來（或直接 `npm run gen:api` 重新產生），確認回到綠燈。

> **不要跳過這一步。** 這個專案的規矩是「沒有親眼看到紅燈的守衛不算數」——
> 而型別層的斷言特別容易寫成永遠通過的樣子（例如比對 `any`）。

- [ ] **Step 5: Commit**

```bash
git add frontend/
git commit -m "feat: 型別從 openapi.json 產生，產生物進版控

規格決策 5：與其在文件裡第三次警告「數值是字串」，不如讓型別檔自己說
protein_g: string——寫 parseFloat 不會錯，寫 m.protein_g * 2 當場型別錯誤。

兩條型別層測試釘住最容易漂移的兩件事（數值是字串、TokenResponse 沒有
expires_in），而且都實際突變驗證過會變紅。"
```

> **CI 的漂移守衛（`contract` job）在 Task 11 一起接上** —— 它需要在 CI 裡起後端，跟 E2E 的環境需求相同，所以放在一起做比較省。

---

### Task 5：錯誤信封的解析（純函式）

規格 §5.4：**所有**錯誤都是 `{"error": {"code", "message", "details"}}`，包含路由 404 與未處理例外。

**Files:**
- Create: `frontend/src/api/errors.ts`
- Create: `frontend/tests/errors.test.ts`

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/errors.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { ApiError, parseErrorResponse } from "../src/api/errors";

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("parseErrorResponse", () => {
  it("解析後端的錯誤信封", async () => {
    const response = jsonResponse(404, {
      error: { code: "MEAL_NOT_FOUND", message: "找不到該餐點", details: {} },
    });

    const error = await parseErrorResponse(response);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(404);
    expect(error.code).toBe("MEAL_NOT_FOUND");
    expect(error.message).toBe("找不到該餐點");
  });

  it("保留 VALIDATION_ERROR 的欄位層級細節", async () => {
    // 規格 §5.4：details.errors 有 loc / msg / type，前端要對應到欄位。
    // 後端已經移除了 input 欄位，所以這裡不會有使用者送的原始值。
    const response = jsonResponse(422, {
      error: {
        code: "VALIDATION_ERROR",
        message: "輸入資料格式錯誤",
        details: { errors: [{ loc: ["body", "email"], msg: "不是有效的 email", type: "value_error" }] },
      },
    });

    const error = await parseErrorResponse(response);

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error.details.errors).toHaveLength(1);
  });

  it("429 帶的 Retry-After 會被解析成秒數", async () => {
    const response = jsonResponse(
      429,
      { error: { code: "TOO_MANY_LOGIN_ATTEMPTS", message: "登入嘗試次數過多，請稍後再試", details: {} } },
      { "retry-after": "37" },
    );

    const error = await parseErrorResponse(response);

    expect(error.code).toBe("TOO_MANY_LOGIN_ATTEMPTS");
    expect(error.retryAfterSeconds).toBe(37);
  });

  it("沒有 Retry-After 時是 null，不是 0", async () => {
    // 0 會讓 UI 顯示「0 秒後可重試」並立刻放行，那是錯的。
    const response = jsonResponse(429, {
      error: { code: "TOO_MANY_LOGIN_ATTEMPTS", message: "太多次", details: {} },
    });

    const error = await parseErrorResponse(response);

    expect(error.retryAfterSeconds).toBeNull();
  });

  it("body 不是 JSON 時也要回 ApiError，不能讓解析例外漏出去", async () => {
    // 這不是假設情境：caddy 或 Tailscale 在後端掛掉時會回 HTML 錯誤頁。
    // 那時整個 app 不該因為 JSON.parse 炸掉而白畫面。
    const response = new Response("<html>502 Bad Gateway</html>", {
      status: 502,
      headers: { "content-type": "text/html" },
    });

    const error = await parseErrorResponse(response);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.status).toBe(502);
    expect(error.code).toBe("UNPARSEABLE_ERROR");
  });

  it("body 是 JSON 但不是信封形狀時也要回 ApiError", async () => {
    // 後端的四個 handler 涵蓋了所有路徑，所以理論上不會發生——
    // 但「理論上不會發生」的東西如果讓 app 白畫面，代價不對稱。
    const response = jsonResponse(500, { detail: "something else" });

    const error = await parseErrorResponse(response);

    expect(error.code).toBe("UNPARSEABLE_ERROR");
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — `Failed to resolve import "../src/api/errors"`

- [ ] **Step 3: 實作**

Create `frontend/src/api/errors.ts`:

```ts
/** 後端的統一錯誤信封（規格 §5.4）。`app/errors.py` 的四個 handler
 *  涵蓋所有路徑，包含路由 404 與未處理例外，所以任何 4xx/5xx 都應該是這個形狀。 */
export type ErrorEnvelope = {
  error: {
    code: string;
    message: string;
    details: Record<string, unknown>;
  };
};

/** 解析不出信封時用的 code。
 *
 *  不是後端會回的值——它代表「這個回應根本不是後端產生的」，
 *  最可能的來源是反向代理或 Tailscale 的錯誤頁。分成獨立的 code
 *  是為了讓 UI 能說「連不上伺服器」而不是「伺服器說了一句我聽不懂的話」。 */
export const UNPARSEABLE_ERROR = "UNPARSEABLE_ERROR";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown> = {},
    /** 429 的 `Retry-After`，秒。沒有這個標頭時是 `null`，**不是 0** ——
     *  0 會讓 UI 顯示「0 秒後可重試」並立刻放行。 */
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

function parseRetryAfter(response: Response): number | null {
  const raw = response.headers.get("retry-after");
  if (raw === null) return null;
  const seconds = Number.parseInt(raw, 10);
  return Number.isFinite(seconds) ? seconds : null;
}

function isEnvelope(value: unknown): value is ErrorEnvelope {
  if (typeof value !== "object" || value === null) return false;
  const envelope = value as { error?: unknown };
  if (typeof envelope.error !== "object" || envelope.error === null) return false;
  const inner = envelope.error as { code?: unknown; message?: unknown };
  return typeof inner.code === "string" && typeof inner.message === "string";
}

/** 把一個失敗的 `Response` 變成 `ApiError`。**永遠不拋例外** ——
 *  呼叫端已經在處理錯誤路徑了，這裡再拋一次只會把原本的錯誤蓋掉。 */
export async function parseErrorResponse(response: Response): Promise<ApiError> {
  const retryAfter = parseRetryAfter(response);

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return new ApiError(response.status, UNPARSEABLE_ERROR, "無法連線到伺服器", {}, retryAfter);
  }

  if (!isEnvelope(body)) {
    return new ApiError(response.status, UNPARSEABLE_ERROR, "無法連線到伺服器", {}, retryAfter);
  }

  return new ApiError(
    response.status,
    body.error.code,
    body.error.message,
    body.error.details ?? {},
    retryAfter,
  );
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd frontend && npm run test`
Expected: 6 passed（加上前面的測試）

- [ ] **Step 5: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| `parseRetryAfter` 沒有標頭時回 `0` 而不是 `null` | 「沒有 Retry-After 時是 null，不是 0」 |
| `isEnvelope` 直接 `return true` | 兩條「不是信封形狀」的測試 |

每個都：改 → 跑 `npm run test` → 記下輸出 → 改回來 → `git diff` 確認乾淨。

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat: 錯誤信封解析

parseErrorResponse 永遠不拋例外——呼叫端已經在處理錯誤路徑了，
這裡再拋一次只會把原本的錯誤蓋掉。

body 不是 JSON、或不是信封形狀時回 UNPARSEABLE_ERROR。那不是後端會回的
值，它代表「這個回應根本不是後端產生的」（反向代理或 Tailscale 的錯誤頁），
分成獨立的 code 才能讓 UI 說「連不上伺服器」。

Retry-After 缺席時是 null 不是 0：0 會讓 UI 顯示「0 秒後可重試」並立刻放行。"
```

---

### Task 6：認證的 token 存放與 single-flight 鎖

**這個 task 的鎖是後端的重用偵測推過來的硬約束**（規格 §6.4）：同時有兩個 refresh 在飛，其中一個會踩到重用偵測，結果是**使用者莫名其妙被登出**。後端刻意不做寬限期（寬限期會稀釋偵測的鑑別力），所以責任在前端。

**Files:**
- Create: `frontend/src/auth/store.ts`
- Create: `frontend/src/auth/refresh.ts`
- Create: `frontend/tests/auth-store.test.ts`
- Create: `frontend/tests/auth-refresh.test.ts`

- [ ] **Step 1: 寫 store 的失敗測試**

Create `frontend/tests/auth-store.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { clearTokens, getAccessToken, getRefreshToken, setTokens } from "../src/auth/store";

beforeEach(() => {
  localStorage.clear();
  clearTokens();
});

describe("token store", () => {
  it("存得進去也讀得回來", () => {
    setTokens({ access_token: "a", refresh_token: "r" });
    expect(getAccessToken()).toBe("a");
    expect(getRefreshToken()).toBe("r");
  });

  it("access token 不進 localStorage", () => {
    // 規格 §6.1：access token 15 分鐘就死，不值得持久化。
    // 這**不是** XSS 防護——正在執行的 XSS 讀得到模組變數；
    // 差別只在它不留存到下一次開啟。
    setTokens({ access_token: "a", refresh_token: "r" });
    expect(JSON.stringify(localStorage)).not.toContain("a");
  });

  it("refresh token 進 localStorage，重新載入後還在", () => {
    setTokens({ access_token: "a", refresh_token: "r" });
    // 模擬重新載入：清掉記憶體狀態，但 localStorage 留著
    clearTokens({ keepStorage: true });
    expect(getRefreshToken()).toBe("r");
    expect(getAccessToken()).toBeNull();
  });

  it("clearTokens 兩邊都清", () => {
    setTokens({ access_token: "a", refresh_token: "r" });
    clearTokens();
    expect(getAccessToken()).toBeNull();
    expect(getRefreshToken()).toBeNull();
    expect(localStorage.getItem("refresh_token")).toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/auth/store`

- [ ] **Step 3: 實作 store**

Create `frontend/src/auth/store.ts`:

```ts
const REFRESH_TOKEN_KEY = "refresh_token";

/** access token 放記憶體（規格 §6.1）。
 *
 *  15 分鐘就死，不值得持久化。**這不是 XSS 防護** —— 正在執行的 XSS
 *  讀得到這個模組變數；差別只在它不留存到下一次開啟。
 *
 *  誠實記下代價：refresh token 在 localStorage，XSS 就拿得到。
 *  唯一的緩解是後端的重用偵測——攻擊者用了偷來的票之後，合法裝置下一次
 *  換票就會踩到偵測，整條鏈被撤銷、使用者被登出。**那是一個會被察覺的
 *  攻擊，而不是一個安靜的攻擊。** */
let accessToken: string | null = null;

export type Tokens = { access_token: string; refresh_token: string };

export function setTokens(tokens: Tokens): void {
  accessToken = tokens.access_token;
  localStorage.setItem(REFRESH_TOKEN_KEY, tokens.refresh_token);
}

export function getAccessToken(): string | null {
  return accessToken;
}

/** 每次都重新讀 localStorage，不快取。
 *
 *  Task 7 的跨分頁鎖依賴這件事：等到鎖的時候，另一個分頁可能已經換好票了，
 *  這時要用**新的**票，不是自己手上那張舊的（那張已經 used_at 了，
 *  送出去就是自己觸發重用偵測）。 */
export function getRefreshToken(): string | null {
  return localStorage.getItem(REFRESH_TOKEN_KEY);
}

export function clearTokens(options: { keepStorage?: boolean } = {}): void {
  accessToken = null;
  if (!options.keepStorage) {
    localStorage.removeItem(REFRESH_TOKEN_KEY);
  }
}
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd frontend && npm run test`
Expected: 4 passed（store 的部分）

- [ ] **Step 5: 寫 single-flight 的失敗測試**

Create `frontend/tests/auth-refresh.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { refreshTokens, resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

beforeEach(() => {
  localStorage.clear();
  clearTokens();
  resetRefreshStateForTests();
  vi.restoreAllMocks();
});

describe("single-flight refresh", () => {
  it("同時呼叫三次，只會送出一個請求", async () => {
    // 規格 §6.4：後端的重用偵測讓「同時兩個 refresh 在飛」變成會導致
    // 使用者莫名被登出的錯誤。這條測試守的就是那件事。
    setTokens({ access_token: "old", refresh_token: "r1" });

    let calls = 0;
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      calls += 1;
      // 刻意讓它慢一點，確保三個呼叫真的重疊
      await new Promise((resolve) => setTimeout(resolve, 20));
      return new Response(
        JSON.stringify({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });

    const results = await Promise.all([refreshTokens(), refreshTokens(), refreshTokens()]);

    expect(calls).toBe(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(results).toEqual([true, true, true]);
  });

  it("換到新票之後，store 裡是新的那一張", async () => {
    setTokens({ access_token: "old", refresh_token: "r1" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );

    await refreshTokens();

    const { getAccessToken, getRefreshToken } = await import("../src/auth/store");
    expect(getAccessToken()).toBe("new");
    expect(getRefreshToken()).toBe("r2");
  });

  it("沒有 refresh token 時直接回 false，不發請求", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");

    expect(await refreshTokens()).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("後端回 401 時清空 token 並回 false", async () => {
    // INVALID_TOKEN 可能是「票過期了」也可能是「重用偵測撤銷了整條鏈」——
    // 前端分不出來，處理一律相同（規格 §6.5）。
    setTokens({ access_token: "old", refresh_token: "r1" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "INVALID_TOKEN", message: "token 無效或已過期", details: {} } }),
        { status: 401, headers: { "content-type": "application/json" } },
      ),
    );

    expect(await refreshTokens()).toBe(false);

    const { getRefreshToken } = await import("../src/auth/store");
    expect(getRefreshToken()).toBeNull();
  });

  it("一次失敗之後，下一次呼叫會重新嘗試", async () => {
    // in-flight 的 promise 必須在結束後被清掉，否則第一次失敗會把
    // 「已經失敗」這個結果永遠快取住，使用者重新登入也沒用。
    setTokens({ access_token: "old", refresh_token: "r1" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { code: "INVALID_TOKEN", message: "x", details: {} } }), {
          status: 401,
          headers: { "content-type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
      );

    expect(await refreshTokens()).toBe(false);
    setTokens({ access_token: "old", refresh_token: "r3" });
    expect(await refreshTokens()).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
```

- [ ] **Step 6: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/auth/refresh`

- [ ] **Step 7: 實作 single-flight**

Create `frontend/src/auth/refresh.ts`:

```ts
import { clearTokens, getRefreshToken, setTokens } from "./store";

/** 分頁**內**的 single-flight：並行的呼叫者共用同一個 promise。 */
let inFlight: Promise<boolean> | null = null;

/** 只給測試用 —— 模組層的狀態在測試之間會殘留。 */
export function resetRefreshStateForTests(): void {
  inFlight = null;
}

async function performRefresh(): Promise<boolean> {
  // **取得鎖之後要重新讀 localStorage。**
  // 等鎖的期間，另一個分頁可能已經換好票了；這時要用新的那一張，
  // 不是自己進來時手上那張舊的 —— 那張已經被標記 used_at，
  // 送出去就是自己觸發後端的重用偵測，整條 family 會被撤銷（規格 §6.4）。
  const refreshToken = getRefreshToken();
  if (refreshToken === null) return false;

  const response = await fetch("/api/auth/refresh", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ refresh_token: refreshToken }),
  });

  if (!response.ok) {
    // INVALID_TOKEN 可能是「票過期了」，也可能是「重用偵測撤銷了整條鏈」。
    // 前端分不出來，而處理一律相同（規格 §6.5）。
    clearTokens();
    return false;
  }

  const tokens = (await response.json()) as { access_token: string; refresh_token: string };
  setTokens(tokens);
  return true;
}

/** 換一組新的 token。成功回 `true`；失敗（沒有票、或後端拒絕）回 `false` 並清空本地狀態。
 *
 *  **同一時間只會有一個請求在飛**，兩層保證：
 *
 *  1. 分頁內：共用 `inFlight` 的 promise。
 *  2. 跨分頁：`navigator.locks`。這一層不是多餘的 —— 手機上把 app 加到
 *     主畫面之後，PWA 視窗與瀏覽器分頁是兩個 context，共用同一個 localStorage。
 *
 *  `navigator.locks` 需要 secure context，所以它在 `http://100.x.y.z` 上
 *  不存在 —— 那正是 Task 1 的 HTTPS 排在所有前端工作之前的原因之一。 */
export function refreshTokens(): Promise<boolean> {
  if (inFlight !== null) return inFlight;

  const run = async (): Promise<boolean> => {
    if (typeof navigator !== "undefined" && navigator.locks !== undefined) {
      return navigator.locks.request("token-refresh", performRefresh);
    }
    // jsdom 沒有 navigator.locks。退回只有分頁內的保護 ——
    // 在測試環境裡這是對的（只有一個 context），在真機上永遠走不到這條
    // （secure context 是 Task 1 的前置條件）。
    return performRefresh();
  };

  inFlight = run().finally(() => {
    // 一定要清掉，否則第一次的結果會被永遠快取住 ——
    // 失敗之後使用者重新登入也不會有用。
    inFlight = null;
  });

  return inFlight;
}
```

- [ ] **Step 8: 跑測試確認通過**

Run: `cd frontend && npm run test`
Expected: 全部通過。

- [ ] **Step 9: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| `refreshTokens` 拿掉 `if (inFlight !== null) return inFlight` | 「同時呼叫三次，只會送出一個請求」 |
| `.finally(() => { inFlight = null })` 整段拿掉 | 「一次失敗之後，下一次呼叫會重新嘗試」 |
| `performRefresh` 改成用外部傳進來的 token 而不是重讀 `getRefreshToken()` | **預期沒有東西變紅** —— 見下 |

> **第三個突變請務必跑，而且我預期它會存活。** 「取得鎖之後要重新讀 localStorage」這件事只在**真的有兩個 context** 時才有差別，而 jsdom 裡只有一個。
>
> 如果它真的存活，**不要為此硬寫一條假的單元測試** —— 那會是一條看起來在守、實際上測不到那個情境的測試。正確的處置是回報，並且知道這一條只能靠 Task 11 的 E2E（或真機）守。這跟上一輪後端「測試所在的世界裡沒有那個維度」是同一個形狀。

- [ ] **Step 10: Commit**

```bash
git add frontend/
git commit -m "feat: token 存放與跨分頁 single-flight 鎖

後端刻意不做重用偵測的寬限期（寬限期會稀釋偵測的鑑別力），所以
「同一時間只有一個 refresh 在飛」這個約束落在前端。少了它，兩個分頁
同時換票會讓使用者莫名被登出。

兩層：分頁內共用 in-flight promise，跨分頁用 navigator.locks。
第二層不是多餘的——手機把 app 加到主畫面後，PWA 視窗與瀏覽器分頁是兩個
context，共用同一個 localStorage。

取得鎖之後重新讀 localStorage：等鎖期間另一個分頁可能已經換好票，
這時要用新的那張，用舊的就是自己觸發重用偵測。"
```

---

### Task 7：API client —— Authorization 與 401 攔截

規格 §6.2：因為 `TokenResponse` 沒有 `expires_in`（§5.5），流程是**被動反應 401**。

**Files:**
- Create: `frontend/src/api/client.ts`
- Create: `frontend/tests/client.test.ts`

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/client.test.ts`:

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "../src/api/errors";
import { apiFetch } from "../src/api/client";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

function ok(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function unauthorized() {
  return new Response(
    JSON.stringify({ error: { code: "INVALID_TOKEN", message: "token 無效或已過期", details: {} } }),
    { status: 401, headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  localStorage.clear();
  clearTokens();
  resetRefreshStateForTests();
  vi.restoreAllMocks();
});

describe("apiFetch", () => {
  it("帶上 Authorization", async () => {
    setTokens({ access_token: "a", refresh_token: "r" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ ok: true }));

    await apiFetch("/api/me");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer a");
  });

  it("沒有 token 時不帶 Authorization，而不是帶 'Bearer null'", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(ok({ ok: true }));

    await apiFetch("/api/health");

    const init = fetchMock.mock.calls[0]?.[1];
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("401 之後換票並重送一次，成功就回新結果", async () => {
    setTokens({ access_token: "old", refresh_token: "r1" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(
        ok({ access_token: "new", refresh_token: "r2", token_type: "bearer" }),
      )
      .mockResolvedValueOnce(ok({ display_name: "我" }));

    const body = await apiFetch<{ display_name: string }>("/api/me");

    expect(body.display_name).toBe("我");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    // 重送那一次要帶新的 token
    const retryInit = fetchMock.mock.calls[2]?.[1];
    expect(new Headers(retryInit?.headers).get("authorization")).toBe("Bearer new");
  });

  it("重送之後又 401 就不再重試", async () => {
    // 規格 §6.2：重送之後又 401 代表問題不在票過期，
    // 無限重試只會把 429 也一起惹出來。
    setTokens({ access_token: "old", refresh_token: "r1" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(ok({ access_token: "new", refresh_token: "r2", token_type: "bearer" }))
      .mockResolvedValueOnce(unauthorized());

    await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("換票失敗時直接拋，不重送原請求", async () => {
    setTokens({ access_token: "old", refresh_token: "r1" });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(unauthorized())
      .mockResolvedValueOnce(unauthorized()); // refresh 也失敗

    await expect(apiFetch("/api/me")).rejects.toBeInstanceOf(ApiError);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("非 401 的錯誤不會觸發換票", async () => {
    // 404 拿去換票是沒有意義的，而且會白白消耗一次輪替
    // （後端的輪替是一次性的，換一次就少一張）。
    setTokens({ access_token: "a", refresh_token: "r" });
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({ error: { code: "MEAL_NOT_FOUND", message: "找不到", details: {} } }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );

    await expect(apiFetch("/api/meals/1")).rejects.toMatchObject({ code: "MEAL_NOT_FOUND" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("204 不嘗試解析 body", async () => {
    // 登出兩個端點都回 204。對空 body 呼叫 .json() 會拋。
    setTokens({ access_token: "a", refresh_token: "r" });
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));

    await expect(apiFetch("/api/auth/logout-all", { method: "POST" })).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/api/client`

- [ ] **Step 3: 實作**

Create `frontend/src/api/client.ts`:

```ts
import { getAccessToken } from "../auth/store";
import { refreshTokens } from "../auth/refresh";
import { ApiError, parseErrorResponse } from "./errors";

function withAuth(init: RequestInit): RequestInit {
  const token = getAccessToken();
  const headers = new Headers(init.headers);
  if (token !== null) {
    headers.set("authorization", `Bearer ${token}`);
  }
  // 沒有 token 時**不設這個標頭**，而不是設成 "Bearer null" ——
  // 後端的 HTTPBearer 對後者會回 401 INVALID_TOKEN，對前者回
  // 401 NOT_AUTHENTICATED。兩個 code 的意思不一樣，UI 會想分辨。
  return { ...init, headers };
}

async function parseBody<T>(response: Response): Promise<T | null> {
  // 204 沒有 body；對空 body 呼叫 .json() 會拋。
  // 登出的兩個端點都是 204。
  if (response.status === 204) return null;
  return (await response.json()) as T;
}

/** 打後端 API。路徑一律是相對的 `/api/...` —— 前端沒有任何地方知道後端在哪
 *  （dev 走 Vite proxy、prod 走 caddy，兩邊都同源，規格決策 1）。
 *
 *  成功回解析後的 body（204 回 `null`）；失敗拋 `ApiError`。
 *
 *  401 時會換一次票並重送**一次**。重送之後又 401 就直接拋 ——
 *  那代表問題不在票過期，無限重試只會把 429 也一起惹出來（規格 §6.2）。 */
export async function apiFetch<T = unknown>(path: string, init: RequestInit = {}): Promise<T | null> {
  let response = await fetch(path, withAuth(init));

  if (response.status === 401) {
    const refreshed = await refreshTokens();
    if (!refreshed) {
      throw await parseErrorResponse(response);
    }
    response = await fetch(path, withAuth(init));
  }

  if (!response.ok) {
    throw await parseErrorResponse(response);
  }

  return parseBody<T>(response);
}

export { ApiError };
```

- [ ] **Step 4: 跑測試確認通過**

Run: `cd frontend && npm run test`
Expected: 全部通過。

- [ ] **Step 5: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| 401 之後不重送，直接拋 | 「401 之後換票並重送一次」 |
| 重送那次用舊的 init（不重新取 token） | 「重送那一次要帶新的 token」那個斷言 |
| 把 `response.status === 401` 改成 `!response.ok`（任何錯誤都換票） | 「非 401 的錯誤不會觸發換票」 |
| 拿掉 204 的分支 | 「204 不嘗試解析 body」 |

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat: API client——Authorization 與 401 攔截

因為 TokenResponse 沒有 expires_in（規格 §5.5），前端不能排程「快過期時
先換票」，一律被動反應 401。這不是缺陷：主動排程要信任 client 端的時鐘，
被動反應不用，少一個會壞的東西。

重送只做一次。重送之後又 401 代表問題不在票過期，無限重試只會把 429
也一起惹出來。

沒有 token 時不設 Authorization 標頭，而不是設成 'Bearer null'——
後端對兩者回的 code 不一樣（INVALID_TOKEN vs NOT_AUTHENTICATED）。"
```

---

### Task 8：登入畫面

**Files:**
- Modify: `frontend/package.json`（加 react-router）
- Create: `frontend/src/screens/Login.tsx`
- Create: `frontend/src/auth/session.ts`
- Modify: `frontend/src/main.tsx`
- Create: `frontend/tests/login.test.tsx`

> **這一份計畫不裝 TanStack Query，也不裝 React Router。** 規格決策 4 選它的理由是快取與失效
> （`/stats/daily`、記完一餐要讓今日總覽重取），而這一份的範圍裡沒有任何
> 需要快取的東西 —— 登入是一次 mutation。**第二份計畫接三個畫面時再裝。**
> YAGNI：現在裝等於先建一個沒有消費者的抽象層。

- [ ] **Step 1: 寫失敗的測試**

Create `frontend/tests/login.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Login } from "../src/screens/Login";
import { clearTokens } from "../src/auth/store";
import { resetRefreshStateForTests } from "../src/auth/refresh";

function jsonResponse(status: number, body: unknown, headers: HeadersInit = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

beforeEach(() => {
  localStorage.clear();
  clearTokens();
  resetRefreshStateForTests();
  vi.restoreAllMocks();
});

describe("登入畫面", () => {
  it("成功登入後呼叫 onSuccess", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(200, { access_token: "a", refresh_token: "r", token_type: "bearer" }),
    );
    const onSuccess = vi.fn();
    render(<Login onSuccess={onSuccess} />);

    await userEvent.type(screen.getByLabelText("Email"), "kenny.demo@example.com");
    await userEvent.type(screen.getByLabelText("密碼"), "demo-pass-12345");
    await userEvent.click(screen.getByRole("button", { name: "登入" }));

    expect(onSuccess).toHaveBeenCalledTimes(1);
  });

  it("登入失敗時顯示不區分原因的訊息", async () => {
    // 規格 §6.3：後端花了 DUMMY_PASSWORD_HASH 與「按送進來的 email 計數」
    // 兩道功夫關掉這個側通道，前端顯示兩種不同的訊息就是把它從另一頭加回來。
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(401, {
        error: { code: "INVALID_CREDENTIALS", message: "email 或密碼不正確", details: {} },
      }),
    );
    render(<Login onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Email"), "nobody@example.com");
    await userEvent.type(screen.getByLabelText("密碼"), "wrong");
    await userEvent.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("email 或密碼不正確");
    // 不可以出現任何暗示帳號存不存在的字眼
    expect(screen.getByRole("alert").textContent).not.toMatch(/帳號|不存在|未註冊/);
  });

  it("429 時顯示倒數並停用送出鈕", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      jsonResponse(
        429,
        {
          error: {
            code: "TOO_MANY_LOGIN_ATTEMPTS",
            message: "登入嘗試次數過多，請稍後再試",
            details: {},
          },
        },
        { "retry-after": "42" },
      ),
    );
    render(<Login onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("密碼"), "x");
    await userEvent.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("42");
    expect(screen.getByRole("button", { name: /登入/ })).toBeDisabled();
  });

  it("連不上伺服器時說的是連線問題，不是帳密問題", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response("<html>502</html>", { status: 502, headers: { "content-type": "text/html" } }),
    );
    render(<Login onSuccess={vi.fn()} />);

    await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
    await userEvent.type(screen.getByLabelText("密碼"), "x");
    await userEvent.click(screen.getByRole("button", { name: "登入" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("無法連線到伺服器");
  });
});
```

- [ ] **Step 2: 跑測試確認它失敗**

Run: `cd frontend && npm run test`
Expected: FAIL — 找不到 `../src/screens/Login`

- [ ] **Step 3: 實作登入的動作**

Create `frontend/src/auth/session.ts`:

```ts
import { apiFetch } from "../api/client";
import { clearTokens, getRefreshToken, setTokens, type Tokens } from "./store";

export async function login(email: string, password: string): Promise<void> {
  const tokens = await apiFetch<Tokens>("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password }),
  });
  if (tokens === null) throw new Error("登入回應沒有 body");
  setTokens(tokens);
}

/** 登出。**不管伺服器怎麼回都清掉本地狀態**（規格 §6.6）。
 *
 *  網路斷線時「登出」不能失敗 —— 使用者的意圖是「這台裝置上不要留著我的
 *  帳號」，而那件事是本地就能做到的。伺服器端的撤銷會在票過期時自然收斂。 */
export async function logout(): Promise<void> {
  const refreshToken = getRefreshToken();
  try {
    if (refreshToken !== null) {
      await apiFetch("/api/auth/logout", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ refresh_token: refreshToken }),
      });
    }
  } catch {
    // 刻意吞掉
  } finally {
    clearTokens();
  }
}
```

- [ ] **Step 4: 實作畫面**

Create `frontend/src/screens/Login.tsx`:

```tsx
import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "../api/errors";
import { login } from "../auth/session";

type Props = { onSuccess: () => void };

export function Login({ onSuccess }: Props) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cooldown, setCooldown] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (cooldown === null || cooldown <= 0) return;
    const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(timer);
  }, [cooldown]);

  async function handleSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await login(email, password);
      onSuccess();
    } catch (caught) {
      if (caught instanceof ApiError && caught.retryAfterSeconds !== null) {
        setCooldown(caught.retryAfterSeconds);
        setError(`${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`);
      } else if (caught instanceof ApiError) {
        // 後端對「帳號不存在」與「密碼錯誤」回一模一樣的 INVALID_CREDENTIALS
        // （規格 §6.3）。直接顯示它的 message，**不要自己加工成更具體的說法** ——
        // 那會把後端關掉的側通道從 UI 這一頭加回來。
        setError(caught.message);
      } else {
        setError("無法連線到伺服器");
      }
    } finally {
      setBusy(false);
    }
  }

  const lockedOut = cooldown !== null && cooldown > 0;

  return (
    <form onSubmit={handleSubmit}>
      <h1>登入</h1>
      <label htmlFor="email">Email</label>
      <input
        id="email"
        type="email"
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
        required
      />
      <label htmlFor="password">密碼</label>
      <input
        id="password"
        type="password"
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        required
      />
      {error !== null && <p role="alert">{lockedOut ? `${error.split("（")[0]}（${cooldown} 秒後可再試）` : error}</p>}
      <button type="submit" disabled={busy || lockedOut}>
        登入
      </button>
    </form>
  );
}
```

- [ ] **Step 5: 接上 main.tsx**

Replace `frontend/src/main.tsx`:

```tsx
import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { Login } from "./screens/Login";
import { getRefreshToken } from "./auth/store";
import { logout } from "./auth/session";

function App() {
  const [loggedIn, setLoggedIn] = useState(getRefreshToken() !== null);

  if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />;

  return (
    <main>
      <h1>已登入</h1>
      <button
        type="button"
        onClick={async () => {
          await logout();
          setLoggedIn(false);
        }}
      >
        登出
      </button>
    </main>
  );
}

const root = document.getElementById("root");
if (root === null) throw new Error("找不到 #root");
createRoot(root).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
```

> **這裡刻意沒有 React Router，也沒有裝它。** 這一份只有兩個狀態
> （登入 / 已登入），一個 `useState` 就夠。Router 在第二份計畫接第一個
> 真正的多畫面導覽時再加 —— 現在裝等於先建一個只有一條路由的路由器。
>
> 記在這裡是為了讓你知道它被考慮過並被否決了，而不是漏了。

- [ ] **Step 6: 跑測試與型別檢查**

```bash
cd frontend
npm run test        # 預期全部通過
npm run typecheck
npm run lint
```

- [ ] **Step 7: 真機手動驗證**

```bash
docker compose up -d
cd frontend && npm run dev
```

用手機（或桌機瀏覽器）開 dev server，用 `kenny.demo@example.com` / `demo-pass-12345` 登入，確認看到「已登入」，按登出後回到登入畫面。

**然後故意連按 6 次錯誤密碼**，確認第 6 次出現倒數而且送出鈕被停用。

- [ ] **Step 8: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| `catch` 裡把 `INVALID_CREDENTIALS` 改成顯示「帳號不存在或密碼錯誤」 | 「不可以出現任何暗示帳號存不存在的字眼」那個斷言 |
| 拿掉 `disabled={busy \|\| lockedOut}` 的 `lockedOut` | 「429 時停用送出鈕」 |
| 把 `else` 分支的「無法連線到伺服器」改成 `caught.message` | 「連不上伺服器時說的是連線問題」 |

- [ ] **Step 9: Commit**

```bash
git add frontend/
git commit -m "feat: 登入畫面

登入失敗一律顯示後端回的 INVALID_CREDENTIALS 訊息，不自己加工成更具體
的說法——後端花了 DUMMY_PASSWORD_HASH 與「按送進來的 email 計數」兩道
功夫關掉「這個 email 有沒有註冊」這個側通道，UI 多說一句就是把它從
另一頭加回來。

429 讀 Retry-After 做倒數並停用送出鈕。

登出不管伺服器怎麼回都清本地狀態：網路斷線時「登出」不能失敗，使用者的
意圖是「這台裝置上不要留著我的帳號」，那件事本地就能做到。

沒有裝 TanStack Query 與 Router：這一份的範圍裡沒有需要快取的東西，
也只有兩個狀態。第二份接三個畫面時再裝。"
```

---

### Task 9：prod 的同源代理（caddy）

規格決策 1：`/` 給 SPA 靜態檔、`/api/*` 反向代理到 api 容器。**`app/main.py` 一行都不用改。**

**Files:**
- Create: `caddy/Caddyfile`
- Create: `frontend/Dockerfile`
- Modify: `docker-compose.yml`
- Modify: `docker-compose.prod.yml`
- Modify: `docker-compose.override.yml`

- [ ] **Step 1: 寫 Caddyfile**

Create `caddy/Caddyfile`（**路線 A**；走路線 B 的話用 Task 1 B-2 那份）：

```caddyfile
# 只聽 loopback。對外的唯一入口是 `tailscale serve`，由它終結 TLS。
# 綁 127.0.0.1 而不是 0.0.0.0 是刻意的：規格第 3 節「Tailscale 是邊界」，
# 而 0.0.0.0 從沒真的強制過那件事——NAS 在區域網路上的任何裝置都連得到。
:8080 {
	# /api/* 轉給 api 容器。注意這裡**不重寫路徑** ——
	# 後端的所有 router 都掛在 /api 前綴下，兩邊的前綴一致。
	handle /api/* {
		reverse_proxy api:8000
	}

	# 其餘一律回 SPA。try_files 的 fallback 讓前端的 client-side routing
	# 在重新整理時不會 404。
	#
	# **這個 fallback 只在這裡，不在後端。** 規格決策 1 記過：如果 SPA
	# 是由 FastAPI 掛 StaticFiles 服務的，這個 fallback 會讓 /api/typo
	# 回 HTML 而不是 HTTP_ERROR 的錯誤信封。放在 caddy 就沒這個問題 ——
	# 上面的 handle /api/* 先比對到，根本走不到這裡。
	handle {
		root * /srv
		try_files {path} /index.html
		file_server
	}
}
```

- [ ] **Step 2: 前端的多階段建置**

Create `frontend/Dockerfile`:

```dockerfile
FROM node:24-slim AS build
WORKDIR /build
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM caddy:2-alpine
COPY --from=build /build/dist /srv
COPY caddy/Caddyfile /etc/caddy/Caddyfile
```

> `Caddyfile` 的 COPY 路徑是相對於 **build context**，而 context 會設在 repo 根目錄（見下一步），所以是 `caddy/Caddyfile` 而不是 `../caddy/Caddyfile`。

- [ ] **Step 3: compose 加上 caddy service**

`docker-compose.yml` 的 `services` 加：

```yaml
  caddy:
    build:
      # context 是 repo 根目錄，因為映像需要同時看到 frontend/ 與 caddy/。
      context: .
      dockerfile: frontend/Dockerfile
    depends_on:
      api:
        condition: service_healthy
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "-", "http://localhost:8080/api/health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 10s
    restart: unless-stopped
    # ports 刻意不寫在這裡：dev 根本不起 caddy（走 Vite proxy），
    # prod 綁 127.0.0.1。跟 api 的 ports 同一個理由——compose 的 ports
    # 是「合併不取代」，寫在共用檔案 production 就拿不掉（陷阱表第 7 條）。
```

`docker-compose.prod.yml` 加：

```yaml
  caddy:
    ports:
      # 只聽 loopback。對外由 tailscale serve 終結 TLS 之後轉進來。
      - "127.0.0.1:8080:8080"

  api:
    # 決定：api 在 prod 不再發佈任何埠。
    # 之前是 ${BIND_ADDR}:8000:8000，現在唯一的入口是 caddy，
    # 而 caddy 走 compose 網路的 api:8000 連過去。
    # 這讓規格第 3 節「Tailscale 是邊界」又收緊了一層。
    ports: !reset []
```

> `!reset` 是 Compose 的覆寫指令（v2.24+，本機是 v2.40.3），用來清掉一個
> 本來會「合併不取代」的清單。**這是陷阱表第 7 條的正解** —— 在此之前這個
> 專案的做法是「乾脆不要寫在共用檔案」，但 `api.ports` 已經在
> `docker-compose.prod.yml` 裡了，這裡是要拿掉它。
>
> **實作時請先驗證 `!reset` 真的生效**：
> ```bash
> docker compose -f docker-compose.yml -f docker-compose.prod.yml config | grep -A3 "api:"
> ```
> 看 `ports` 是不是真的空的。如果這個版本不支援，退路是把
> `docker-compose.prod.yml` 的 api ports 那一段直接刪掉（它本來就是為了
> 讓 api 對外，現在不需要了）。

`docker-compose.override.yml`（dev）**不加 caddy** —— dev 走 Vite 的 proxy 就同源了，多起一個容器只會讓 HMR 多一層要 debug 的東西。

- [ ] **Step 4: 驗證 prod 疊加後的設定是對的**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml config > /tmp/prod-config.yml
grep -A5 "caddy:" /tmp/prod-config.yml | grep -A2 ports    # 預期 127.0.0.1:8080:8080
grep -A20 "^  api:" /tmp/prod-config.yml | grep ports       # 預期沒有，或空的
```

- [ ] **Step 5: 實際起起來驗證同源**

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --env-file .env.production up -d --build
curl -s http://127.0.0.1:8080/api/health          # 預期 API 的回應
curl -s http://127.0.0.1:8080/ | head -5          # 預期 SPA 的 index.html
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8080/api/nope   # 預期 404
curl -s http://127.0.0.1:8080/api/nope            # **預期錯誤信封 JSON，不是 HTML**
```

> **最後那一條是這個 task 唯一有鑑別力的檢查。** 如果 `/api/nope` 回的是
> SPA 的 HTML，代表 `handle /api/*` 沒有先比對到，SPA 的 fallback 把 API
> 的路由 404 吃掉了 —— 那正是規格決策 1 記錄的那個衝突。
>
> 前三條在設定錯誤時多半也會過，它們證明不了什麼。

- [ ] **Step 6: 確認既有的守衛測試沒有被弄紅**

```bash
cd F:/wallet && .venv/Scripts/python.exe -m pytest -W error -q
```

Expected: **503 passed** —— 特別是 `test_no_static_files_mount_serves_the_photo_directory` 仍然綠。規格決策 1 選 caddy 而不是 FastAPI 掛 `StaticFiles`，就是為了不弱化那個守衛。

- [ ] **Step 7: Commit**

```bash
git add caddy/ frontend/Dockerfile docker-compose.yml docker-compose.prod.yml
git commit -m "feat: prod 用 caddy 同源代理，api 不再對外發佈埠

/api/* 轉給 api 容器、其餘回 SPA。app/main.py 一行都沒動——
規格決策 1 選 caddy 而不是 FastAPI 掛 StaticFiles，就是為了不弱化
test_no_static_files_mount_serves_the_photo_directory 那個守衛。

SPA 的 try_files fallback 只在 caddy 裡。掛在後端的話 /api/typo 會回
HTML 而不是 HTTP_ERROR 的錯誤信封；在 caddy 裡 handle /api/* 先比對到，
根本走不到 fallback。已用 curl /api/nope 驗證回的是 JSON 信封。

api 的 ports 用 !reset 清掉：唯一入口是 caddy，caddy 只聽 127.0.0.1，
對外由 tailscale serve 終結 TLS。"
```

---

### Task 10：PWA 殼（L1）

規格 §8：L1 是「可安裝、離線開啟不是白畫面」。**L2 的讀取離線留給第二份計畫** —— 這一份還沒有任何值得快取的資料。

**Files:**
- Modify: `frontend/vite.config.ts`
- Create: `frontend/public/` 底下的圖示
- Create: `frontend/e2e/pwa.spec.ts`（Task 11 建好 Playwright 之後）

- [ ] **Step 1: 裝 plugin**

```bash
cd frontend && npm install --save-dev vite-plugin-pwa
```

- [ ] **Step 2: 設定**

`vite.config.ts` 的 `plugins` 加：

```ts
    VitePWA({
      registerType: "autoUpdate",
      manifest: {
        name: "飲食紀錄",
        short_name: "飲食",
        start_url: "/",
        display: "standalone",
        background_color: "#ffffff",
        theme_color: "#ffffff",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png" },
        ],
      },
      workbox: {
        // L1：只快取 app shell（建置產物）。
        // **不在這裡加 runtimeCaching 快取 API 回應** —— 那是 L2，
        // 而 L2 需要「顯示陳舊資料時明確標示它是陳舊的」（規格 §8），
        // 那是 UI 的責任，不是 service worker 設定能單獨完成的事。
        // 先快取了資料卻沒有標示，比不快取更糟。
        globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
      },
    }),
```

（`import { VitePWA } from "vite-plugin-pwa";`）

- [ ] **Step 3: 放圖示**

放兩個 PNG 到 `frontend/public/`：`icon-192.png`、`icon-512.png`。隨便一個純色方塊加一個字都行 —— **這一步不要花時間設計**，能裝起來、在主畫面上認得出來就夠，之後要換是一個檔案的事。

- [ ] **Step 4: 建置並確認 service worker 真的產出來了**

```bash
cd frontend && npm run build
ls dist/sw.js dist/manifest.webmanifest
```

Expected: 兩個檔案都存在。

- [ ] **Step 5: 真機驗證 —— 這一步無法用 dev 或 CI 代替**

用手機開 `https://<機器名>.<tailnet>.ts.net`：

1. 瀏覽器選單應該出現「加到主畫面」
2. 加進去、從主畫面開啟，應該是 standalone（沒有網址列）
3. **開飛航模式再從主畫面開啟** —— 應該看到 app shell（登入畫面或「離線中」），**不是**瀏覽器的恐龍頁

> **為什麼一定要真機：** service worker 需要 secure context，而 `localhost`
> 永遠是 secure context、Playwright 也是 —— 所以**這整類問題在 dev 與 CI 裡
> 原理上不會出現**（規格 §9.2 第 9 條）。這一步就是那條規則唯一的執法點。
>
> 第 3 點如果失敗，先確認 Task 1 的 `isSecureContext` 三個 `true` 還是 `true`。

- [ ] **Step 6: Commit**

```bash
git add frontend/
git commit -m "feat: PWA 殼（L1）——可安裝、離線不是白畫面

只快取 app shell，不快取 API 回應。後者是 L2，而 L2 需要「顯示陳舊資料
時明確標示它是陳舊的」——先快取了資料卻沒有標示，比不快取更糟。

真機驗證過三件事：出現「加到主畫面」、standalone 啟動、飛航模式下開啟
看到 app shell 而不是恐龍頁。這三件事 dev 與 CI 都驗不了——localhost
永遠是 secure context，Playwright 也是。"
```

---

### Task 11：Playwright 的契約 E2E 與 CI job

規格 §9.1：**凡是「後端保證 X」的斷言都必須有一條 E2E。** MSW 的 handler 是自己寫的，它證明不了後端的行為。

這一份的範圍裡有兩條：登入流程、401 → refresh → 重送。其餘四條（數值是字串、照片 blob、跨午夜、429 倒數）留給第二份計畫 —— **它們需要的畫面還不存在**。

**Files:**
- Create: `frontend/playwright.config.ts`
- Create: `frontend/e2e/auth.spec.ts`
- Modify: `.github/workflows/ci.yml`

- [ ] **Step 1: 裝 Playwright**

```bash
cd frontend
npm install --save-dev @playwright/test
npx playwright install --with-deps chromium
```

- [ ] **Step 2: 設定**

Create `frontend/playwright.config.ts`:

```ts
import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  use: {
    baseURL: "http://localhost:5173",
    // **一律明確設時區，而且必須設一個跟 UTC 不同的**（規格 §9.2 第 5 條）。
    // CI 的機器是 UTC、本機是 Asia/Taipei——不設的話，「台北宵夜」那一類
    // 跨日界線的缺陷在 CI 上零鑑別力，而那正是後端 §6 第 2 種踩過的坑。
    //
    // 這一份計畫還沒有任何跟日界線有關的畫面，但設定要從一開始就是對的：
    // 第二份加「今日總覽」時，沒有人會記得回來加這一行。
    timezoneId: "Asia/Taipei",
  },
  webServer: {
    command: "npm run dev",
    url: "http://localhost:5173",
    reuseExistingServer: !process.env.CI,
  },
});
```

- [ ] **Step 3: 寫兩條契約 E2E**

Create `frontend/e2e/auth.spec.ts`:

```ts
import { expect, test } from "@playwright/test";

const EMAIL = "kenny.demo@example.com";
const PASSWORD = "demo-pass-12345";

test("登入之後看得到已登入的畫面", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "登入" }).click();

  await expect(page.getByRole("heading", { name: "已登入" })).toBeVisible();
});

test("access token 過期時會自動換票並重送，使用者不會被踢出去", async ({ page }) => {
  // 規格 §9.1：這條守的是「401 → refresh → 重送」這個跟後端的約定。
  // MSW 證明不了它——MSW 的 401 是我們自己寫的。
  await page.goto("/");
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("密碼").fill(PASSWORD);
  await page.getByRole("button", { name: "登入" }).click();
  await expect(page.getByRole("heading", { name: "已登入" })).toBeVisible();

  // 把記憶體裡的 access token 換成一張無效的，模擬它過期。
  // refresh token 留著——這正是「票過期但 session 還活著」的狀態。
  await page.evaluate(() => {
    // biome-ignore lint/suspicious/noExplicitAny: 測試刻意戳進模組狀態
    (window as any).__forceExpireAccessToken?.();
  });

  // 觸發一次需要認證的請求。這裡用登出：它會打 /api/auth/logout，
  // 而那個端點**不需要 access token**——換一個真的需要的。
  // （第二份計畫有「今日總覽」之後改成點那個分頁。）
  const meResponse = page.waitForResponse(
    (response) => response.url().includes("/api/me") && response.status() === 200,
  );
  await page.getByRole("button", { name: "重新整理" }).click();
  await meResponse;

  await expect(page.getByRole("heading", { name: "已登入" })).toBeVisible();
});
```

> **這條測試需要 app 提供兩個東西，Step 4 會加：**
> 一個「重新整理」按鈕（會打 `/api/me`），以及一個只在 dev 建置裡存在的
> `window.__forceExpireAccessToken`。
>
> **為什麼用一個測試專用的後門而不是等 15 分鐘：** 等 15 分鐘不是選項。
> 替代方案是用 Playwright 的 `route` 攔截第一次 `/api/me` 回 401 ——
> 但那樣**攔的是我們自己捏造的 401，就退化成 MSW 了**，而這條 E2E 存在的
> 理由就是要打真的後端。戳掉本地的 token、讓後端回真的 401，才是真的。

- [ ] **Step 4: 加上 E2E 需要的兩個東西**

`frontend/src/auth/store.ts` 末尾加：

```ts
// 只在 dev 建置裡存在的測試後門（`import.meta.env.DEV` 在 production
// 建置時是 false，整段會被 tree-shake 掉）。
//
// E2E 需要製造「access token 過期但 refresh token 還活著」的狀態，
// 而等 15 分鐘不是選項。用 Playwright 的 route 攔截捏造一個 401 也不行——
// 那攔的是我們自己寫的回應，這條 E2E 就退化成 MSW 了。
if (import.meta.env.DEV) {
  (globalThis as unknown as Record<string, unknown>).__forceExpireAccessToken = () => {
    accessToken = "expired.invalid.token";
  };
}
```

`frontend/src/main.tsx` 的已登入畫面加一個按鈕：

```tsx
      <button
        type="button"
        onClick={async () => {
          const me = await apiFetch<{ display_name: string }>("/api/me");
          setDisplayName(me?.display_name ?? null);
        }}
      >
        重新整理
      </button>
      {displayName !== null && <p>{displayName}</p>}
```

（對應的 `const [displayName, setDisplayName] = useState<string | null>(null);` 與 `import { apiFetch } from "./api/client";`）

- [ ] **Step 5: 跑 E2E**

```bash
docker compose up -d          # 後端要起著
cd frontend && npx playwright test
```

Expected: 2 passed

`package.json` 加 `"e2e": "playwright test"`。

- [ ] **Step 6: 突變驗證**

| 突變 | 預期變紅 |
|---|---|
| `apiFetch` 的 401 分支直接拋（不換票重送） | 第二條 E2E |
| `vite.config.ts` 的 `server.proxy` 拿掉 | 兩條 E2E 都紅（請求打不到後端） |

第二個突變特別值得跑 —— **它是「dev 同源」這件事唯一的自動守衛**（Task 3 只能手動驗）。

- [ ] **Step 7: CI 加三個 job**

`.github/workflows/ci.yml`：既有的 `test` job 改名並加 path filter，並新增三個 job。

> **path filter 怎麼加。** GitHub Actions 的 job 層級沒有 `paths:`，
> 那是 workflow 層級的 `on:` 才有的。要讓「只改前端就不跑 463 個 pytest」，
> 有兩條路：
>
> 1. **`dorny/paths-filter` action** —— 加一個 `changes` job 算出哪些路徑變了，
>    其餘 job 用 `needs: changes` + `if: needs.changes.outputs.backend == 'true'`
> 2. **拆成兩個 workflow 檔** —— `ci-backend.yml` 與 `ci-frontend.yml`，
>    各自用 workflow 層級的 `on.push.paths`
>
> **實作時選一條並在 commit 訊息裡說明理由。** 我不在這裡替你選，因為
> 第 2 條會讓 `contract` 與 `e2e`（兩邊都要觸發）變得尷尬 —— 它們得重複
> 出現在兩個檔案裡，或者自成第三個 workflow。那個取捨要看實際的 YAML
> 長出來才好判斷，而我沒有寫過這個 repo 的 workflow 分檔。
>
> **下面的 job 定義本身跟你選哪一條無關**，照抄即可。

```yaml
on:
  push:
  pull_request:

jobs:
  backend:
    # 既有的 `test` job **原封不動**，只改兩件事：
    #   1. job 的 key 從 `test` 改成 `backend`
    #   2. 加上下面的 paths 過濾
    # 裡面的 services / env / steps 一行都不要動——它現在守著 503 個測試、
    # ruff、mypy、alembic 漂移檢查，以及剛加上的 -W error。
    if: true
    runs-on: ubuntu-latest
    # ...（既有內容，見 .github/workflows/ci.yml 的 `test` job）

  frontend:
    runs-on: ubuntu-latest
    defaults:
      run:
        working-directory: frontend
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: npm ci
      - run: npm run lint
      - run: npm run typecheck
      - run: npm run test
      - run: npm run build

  contract:
    # 規格決策 5 的執法者，也是決策 2（同 repo）唯一的實質理由。
    # **必須在前後端任一變更時都觸發** —— 否則「只改後端」這個最常見的
    # 漂移路徑剛好漏掉。
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: wallet
          POSTGRES_PASSWORD: wallet
          POSTGRES_DB: wallet
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U wallet" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql+asyncpg://wallet:wallet@localhost:5432/wallet
      JWT_SECRET: ci-only-not-a-secret-0123456789abcdef
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: pip install -c requirements-lock.txt -e ".[dev]"
      - run: alembic upgrade head
      - name: 起後端
        run: |
          uvicorn app.main:app --host 127.0.0.1 --port 8000 &
          until curl -sf http://127.0.0.1:8000/api/health; do sleep 1; done
      - name: 重新產生型別並比對
        working-directory: frontend
        run: |
          npm ci
          npm run gen:api
          git diff --exit-code src/api/schema.d.ts
      # git diff --exit-code：有差異就 exit 1。
      # 這一行就是「後端改了 schema 但前端型別沒跟上」的紅燈。

  e2e:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16
        env:
          POSTGRES_USER: wallet
          POSTGRES_PASSWORD: wallet
          POSTGRES_DB: wallet
        ports: ["5432:5432"]
        options: >-
          --health-cmd "pg_isready -U wallet" --health-interval 5s
          --health-timeout 5s --health-retries 10
    env:
      DATABASE_URL: postgresql+asyncpg://wallet:wallet@localhost:5432/wallet
      JWT_SECRET: ci-only-not-a-secret-0123456789abcdef
    steps:
      - uses: actions/checkout@v7
      - uses: actions/setup-python@v7
        with:
          python-version: "3.12"
          cache: pip
      - uses: actions/setup-node@v4
        with:
          node-version: "24"
          cache: npm
          cache-dependency-path: frontend/package-lock.json
      - run: pip install -c requirements-lock.txt -e ".[dev]"
      - run: alembic upgrade head
      - name: 種子資料
        # E2E 的兩條測試都用這個帳號登入。create-admin 對已存在的 email
        # 是「提升並重設密碼」，所以重跑 job 不會失敗。
        run: python -m app.cli create-admin kenny.demo@example.com demo-pass-12345 "示範帳號"
      - name: 起後端
        run: |
          uvicorn app.main:app --host 127.0.0.1 --port 8000 &
          until curl -sf http://127.0.0.1:8000/api/health; do sleep 1; done
      - name: Playwright
        working-directory: frontend
        run: |
          npm ci
          npx playwright install --with-deps chromium
          npm run e2e
```

> **`e2e` 與 `contract` 有大段重複，而且是刻意不抽出來的。**
>
> 抽成 composite action 會讓兩個 job 的失敗訊息都指向同一個共用步驟，
> 而它們失敗時要回答的是**不同的問題**：`contract` 紅是「後端改了 schema
> 但前端型別沒跟上」，`e2e` 紅是「端到端壞了」。
>
> **更不要為了 DRY 把兩個 job 合併成一個** —— 合併之後一個紅燈要看 log
> 才知道是哪一種失敗，而這整份計畫的主題就是「紅燈要說得出它為什麼紅」。
>
> 如果哪天這段前置長到真的難以維護，抽出來的單位應該是「起一個可用的後端」
> 這件事本身，而不是「兩個 job 共用的步驟」。

- [ ] **Step 8: 推上去看 CI**

```bash
git add frontend/ .github/
git commit -m "feat: Playwright 契約 E2E 與 CI 的 frontend / contract / e2e job"
git push
```

**這一步的紅綠燈本身就是答案** —— Playwright 在 Linux runner 上跑不跑得起來、`contract` job 抓不抓得到漂移，本機都驗證不了。

- [ ] **Step 9: 驗證 `contract` job 真的會紅**

在一個拋棄式的分支上，手動改 `frontend/src/api/schema.d.ts` 裡任一個型別，推上去，確認 `contract` job **變紅**。然後刪掉那個分支。

> **不要跳過。** 這個 job 是決策 2（同 repo）唯一的實質理由，而
> `git diff --exit-code` 很容易因為換行符或 `.gitattributes` 的設定
> 而永遠是綠的（Windows 上產生 CRLF、CI 上產生 LF）。**這正是這個 repo
> 已經在 `git add` 時看到過的警告。**

---

## 完成標準

- [ ] Task 1 的路線 A 或 B 完成，且**在真機上**看到 `isSecureContext` / `serviceWorker` / `locks` 三個 `true`
- [ ] `frontend/` 的 `npm run lint` / `typecheck` / `test` / `build` 全綠
- [ ] `schema.d.ts` 進版控，`contract` job **實測驗證過會因為漂移而變紅**
- [ ] 兩條契約 E2E 綠，且第二條經過突變驗證（拿掉 401 重送會紅）
- [ ] prod caddy 起得來，`curl /api/nope` 回的是**錯誤信封 JSON 不是 HTML**
- [ ] 後端 503 個測試不因這個階段而變動，`test_no_static_files_mount_*` 仍然綠
- [ ] PWA 在手機上裝得起來，飛航模式下開啟看到 app shell
- [ ] 用 `kenny.demo@example.com` 在手機上真的登入過一次
- [ ] 各 task 的突變全部實際跑過，結果寫回這份文件

---

## 留給第二份計畫

- 三個畫面：記一餐、今日總覽、拍照
- `lib/decimal.ts`（這一份沒有任何需要顯示的數值 —— YAGNI）
- TanStack Query（這一份沒有需要快取的東西）
- React Router（這一份只有兩個狀態）
- 離線 L2：讀取快取 + **「離線資料，最後更新於 X」的標示**
- 其餘四條契約 E2E：數值是字串、照片 blob、跨午夜日界線、429 倒數
- MSW 的 handler（這一份的元件測試直接 mock `fetch` 就夠；MSW 要到有多個端點互相配合時才划算）
