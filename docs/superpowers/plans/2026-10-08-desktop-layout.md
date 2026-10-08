# 電腦版版面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 寬度 ≥ 1024px 時改成左側導覽＋總覽／報表／飲食兩欄；比較窄時維持手機版（內容最寬 600px 置中）。

**Architecture:** `useIsDesktop()`（`matchMedia` + `useSyncExternalStore`）是斷點的唯一來源。`LoggedInShell` 依它畫 `SideNav` 或 `TabBar`，電腦版在最外層加 `app-desktop` class；頁面的兩欄 CSS 一律寫成 `:global(.app-desktop) .x`，所以 1024 只出現在 `lib/layout.ts`。內容寬度由外框依路由決定。

**Tech Stack:** React 19、react-router、CSS Modules、Vitest＋Testing Library（jsdom）、Playwright。

**規格：** `docs/superpowers/specs/2026-10-08-desktop-layout-design.md`（先讀）。

**通用規則（每個任務都適用）：**
- 所有指令在 `frontend/` 下跑。每個任務結束前：`npm run test`、`npm run typecheck`、`npm run lint` 全綠。
- CSS Modules 只能用 `src/index.css` 的變數，不能寫色碼（`tests/css-tokens.test.ts` 會掃）。
- 程式註解用中文，風格跟周圍一致（說「為什麼」）。
- 不碰後端、不碰 `src/api/schema.d.ts`。
- commit 訊息用中文 conventional 格式，結尾一行 `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`。用 `git commit -F <檔案>`。**不要** stage `lunch.jpg`（repo 根目錄）。
- jsdom 不做版面計算、CSS Modules 在 Vitest 裡也不套樣式：**幾何（誰在誰右邊、寬度）只能在 e2e 測**。單元測試測結構（哪個導覽、哪個 class、DOM 順序）。

---

## 檔案結構

| 檔案 | 責任 |
|---|---|
| `src/lib/layout.ts`（新） | `DESKTOP_MEDIA_QUERY`、`contentWidthFor(pathname)` |
| `src/lib/use-is-desktop.ts`（新） | `useIsDesktop()` |
| `src/test/media.ts`（新） | 測試用的可控 `matchMedia`：`installMatchMedia()`、`setDesktop()`、`resetDesktop()` |
| `src/test/setup.ts` | 裝上假 `matchMedia`，每個測試前重設成手機版 |
| `src/components/nav-tabs.ts`（新） | 四個目的地的清單（TabBar 與 SideNav 共用） |
| `src/components/use-add-sheet.ts`（新） | 「新增」選單的開關狀態（從 TabBar 抽出來） |
| `src/components/TabBar.tsx` | 改用上面兩個共用模組，行為不變 |
| `src/components/SideNav.tsx`＋`.module.css`（新） | 電腦版左側導覽 |
| `src/components/AddSheet.module.css` | 電腦版改成置中對話框 |
| `src/App.tsx` | `LoggedInShell` 分兩種外框；未登入畫面包 `app-auth` |
| `src/index.css` | `--side-nav-width`、`.app-main` 最寬 600、電腦版外框與內容寬度、`.app-auth` |
| `src/components/layout.module.css`（新） | 共用的兩欄 `.columns` |
| `src/screens/Overview.tsx`／`.module.css` | 兩欄 |
| `src/screens/Expenses.tsx` | 兩欄 |
| `src/screens/Today.tsx`／`.module.css` | grid-areas 兩欄、好友動態最寬 640 |
| `e2e/desktop-layout.spec.ts`（新） | 兩種寬度的幾何與橫向捲軸 |
| `docs/handover.md` | 記錄電腦版版面 |

---

### Task 1: 斷點與 `useIsDesktop`

**Files:**
- Create: `src/lib/layout.ts`, `src/lib/use-is-desktop.ts`, `src/test/media.ts`, `tests/layout.test.ts`, `tests/use-is-desktop.test.tsx`
- Modify: `src/test/setup.ts`

- [ ] **Step 1: 寫 `src/lib/layout.ts` 的失敗測試** `tests/layout.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { contentWidthFor } from "../src/lib/layout";

describe("contentWidthFor", () => {
	it.each([
		["/", "wide"],
		["/reports", "wide"],
		["/diet", "wide"],
		["/diet/", "wide"],
		["/expenses/new", "form"],
		["/expenses/new/", "form"],
		["/meals/new", "form"],
		["/me", "narrow"],
		["/foods", "narrow"],
		["/foods/12", "narrow"],
		["/trend", "narrow"],
		["/meals/3/edit", "narrow"],
		["/friends/2", "narrow"],
		["/admin/revisions", "narrow"],
		["/join", "narrow"],
	] as const)("%s → %s", (path, expected) => {
		expect(contentWidthFor(path)).toBe(expected);
	});
});
```

- [ ] **Step 2: 跑，確認紅**：`npx vitest run tests/layout.test.ts` → 找不到模組。

- [ ] **Step 3: 實作 `src/lib/layout.ts`**

```ts
/** 電腦版版面的斷點（電腦版版面規格 §2）。**整個前端只有這裡寫 1024**：
 *  CSS 不寫 media query，而是看外框的 `app-desktop` class（`useIsDesktop`
 *  決定要不要加），所以斷點不會在 CSS 與 JS 之間漂移。 */
export const DESKTOP_MEDIA_QUERY = "(min-width: 1024px)";

/** 電腦版內容區的最寬寬度（規格 §3）：wide 1100、form 480、narrow 640。 */
export type ContentWidth = "wide" | "form" | "narrow";

const WIDE = new Set(["/", "/reports", "/diet"]);
const FORM = new Set(["/expenses/new", "/meals/new"]);

/** 結尾的斜線不算（`/expenses/new/` 也是記帳，跟 react-router 的比對一致）。 */
export function contentWidthFor(pathname: string): ContentWidth {
	const path = pathname.replace(/\/+$/, "") || "/";
	if (WIDE.has(path)) return "wide";
	if (FORM.has(path)) return "form";
	return "narrow";
}
```

- [ ] **Step 4: 跑，確認綠**：`npx vitest run tests/layout.test.ts`

- [ ] **Step 5: 測試用的假 `matchMedia`** `src/test/media.ts`

```ts
import { DESKTOP_MEDIA_QUERY } from "../lib/layout";

// jsdom 沒有 window.matchMedia。這裡裝一個可以控制的版本：預設不符合
//（＝手機版），所以既有的測試全部照舊；要測電腦版的測試呼叫
// `act(() => setDesktop(true))`，會通知所有 change 監聽者，跟瀏覽器把視窗
// 拉寬時一樣。只有 DESKTOP_MEDIA_QUERY 會符合，其他查詢一律 false。
let desktop = false;
const listeners = new Set<() => void>();

export function setDesktop(value: boolean): void {
	desktop = value;
	for (const listener of [...listeners]) listener();
}

/** 每個測試前呼叫：回到手機版，不通知（上一個測試的元件已經卸載了）。 */
export function resetDesktop(): void {
	desktop = false;
}

export function installMatchMedia(): void {
	window.matchMedia = (query: string): MediaQueryList =>
		({
			get matches() {
				return query === DESKTOP_MEDIA_QUERY && desktop;
			},
			media: query,
			onchange: null,
			addEventListener: (_type: string, listener: () => void) => {
				listeners.add(listener);
			},
			removeEventListener: (_type: string, listener: () => void) => {
				listeners.delete(listener);
			},
			addListener: (listener: () => void) => listeners.add(listener),
			removeListener: (listener: () => void) => listeners.delete(listener),
			dispatchEvent: () => false,
		}) as unknown as MediaQueryList;
}
```

在 `src/test/setup.ts` 最後加上（`beforeEach` 是 vitest 的 global，`globals: true` 已開；為了型別清楚仍然 import）：

```ts
import { beforeEach } from "vitest";
import { installMatchMedia, resetDesktop } from "./media";

// 電腦版版面（規格 §6）：jsdom 沒有 matchMedia；預設是手機版。
installMatchMedia();
beforeEach(() => {
	resetDesktop();
});
```

（import 放到檔案最上面，跟既有的 import 放在一起。）

- [ ] **Step 6: 寫 `useIsDesktop` 的失敗測試** `tests/use-is-desktop.test.tsx`

```tsx
import { act, renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useIsDesktop } from "../src/lib/use-is-desktop";
import { setDesktop } from "../src/test/media";

describe("useIsDesktop", () => {
	it("預設（測試環境＝手機版）是 false", () => {
		const { result } = renderHook(() => useIsDesktop());
		expect(result.current).toBe(false);
	});

	it("一開始就是寬螢幕：第一次 render 就是 true", () => {
		setDesktop(true);
		const { result } = renderHook(() => useIsDesktop());
		expect(result.current).toBe(true);
	});

	it("視窗拉寬、再拉窄：跟著變", () => {
		const { result } = renderHook(() => useIsDesktop());
		act(() => setDesktop(true));
		expect(result.current).toBe(true);
		act(() => setDesktop(false));
		expect(result.current).toBe(false);
	});

	it("沒有 matchMedia 的環境：false，不會丟錯", () => {
		const original = window.matchMedia;
		// @ts-expect-error 模擬沒有 matchMedia 的瀏覽器
		delete window.matchMedia;
		try {
			const { result } = renderHook(() => useIsDesktop());
			expect(result.current).toBe(false);
		} finally {
			window.matchMedia = original;
		}
	});
});
```

- [ ] **Step 7: 跑，確認紅**：`npx vitest run tests/use-is-desktop.test.tsx`

- [ ] **Step 8: 實作 `src/lib/use-is-desktop.ts`**

```ts
import { useSyncExternalStore } from "react";
import { DESKTOP_MEDIA_QUERY } from "./layout";

function query(): MediaQueryList | null {
	return typeof window.matchMedia === "function"
		? window.matchMedia(DESKTOP_MEDIA_QUERY)
		: null;
}

function subscribe(onChange: () => void): () => void {
	const list = query();
	if (list === null) return () => {};
	list.addEventListener("change", onChange);
	return () => list.removeEventListener("change", onChange);
}

function getSnapshot(): boolean {
	return query()?.matches ?? false;
}

/** 寬度 ≥ 1024px（電腦版版面規格 §2）。`useSyncExternalStore`：第一次
 *  render 就是正確的值（不會先畫手機版再跳成電腦版），視窗拉寬拉窄即時更新。 */
export function useIsDesktop(): boolean {
	return useSyncExternalStore(subscribe, getSnapshot, () => false);
}
```

- [ ] **Step 9: 全部測試、型別、lint**：`npm run test && npm run typecheck && npm run lint` → 全綠（既有測試不受影響，因為預設是手機版）。

- [ ] **Step 10: 證明測試有鑑別力**：暫時把 `getSnapshot` 改成 `return false;` → `use-is-desktop.test.tsx` 應該紅兩條；改回來。

- [ ] **Step 11: Commit**：`feat(frontend): 電腦版斷點與 useIsDesktop`

---

### Task 2: 共用的導覽清單、`useAddSheet`、`SideNav`

**Files:**
- Create: `src/components/nav-tabs.ts`, `src/components/use-add-sheet.ts`, `src/components/SideNav.tsx`, `src/components/SideNav.module.css`, `tests/side-nav.test.tsx`
- Modify: `src/components/TabBar.tsx`, `src/components/AddSheet.module.css`, `src/index.css`（`--side-nav-width`）, `tests/css-tokens.test.ts`（加一組對比度）

- [ ] **Step 1: 抽出 `src/components/nav-tabs.ts`**

```ts
import {
	ChartPie,
	CircleUser,
	LayoutDashboard,
	type LucideIcon,
	Salad,
} from "lucide-react";

export type NavTab = { to: string; label: string; icon: LucideIcon; end?: boolean };

/** 四個目的地（介面改版規格 §3.1）。手機的分頁列把「＋」夾在第 2、3 格之間；
 *  電腦版的左側導覽把「新增」放在最上面（電腦版版面規格 §2）。
 *  `/` 的 `end` 在 react-router 8.3.1 是無作用的保險（見 TabBar.tsx）。 */
export const NAV_TABS: readonly NavTab[] = [
	{ to: "/", label: "總覽", icon: LayoutDashboard, end: true },
	{ to: "/reports", label: "報表", icon: ChartPie },
	{ to: "/diet", label: "飲食", icon: Salad },
	{ to: "/me", label: "我的", icon: CircleUser },
];
```

- [ ] **Step 2: 抽出 `src/components/use-add-sheet.ts`**——把 `TabBar` 裡的 `openedAt` 邏輯與它的註解**原樣搬過來**：

```ts
import { useCallback, useRef, useState } from "react";
import { useLocation } from "react-router";

/** 「新增」選單的開關（TabBar 與 SideNav 共用）。
 *
 *  開關狀態由「在哪個 location 打開的」推導，不是單純的 boolean：導覽在
 *  <Routes> 外面，換頁不會 remount。用 boolean 的話，選單開著時按返回手勢
 *  （Android 返回鍵、瀏覽器上一頁）或用 Tab 鍵走到背後的連結，頁面換了
 *  選單卻還蓋在上面。location.key 一變，openedAt 就不等於它，選單自然關上，
 *  不需要 effect。
 *
 *  換頁後把舊的 key 清掉（React 文件的「render 時調整 state」寫法）：
 *  location.key 是每個歷史紀錄各一個，不清的話回到選單當初開著的那一頁，
 *  key 又對上了，選單會自己跳回來。 */
export function useAddSheet() {
	const location = useLocation();
	const [openedAt, setOpenedAt] = useState<string | null>(null);
	if (openedAt !== null && openedAt !== location.key) setOpenedAt(null);
	const open = openedAt === location.key;
	const buttonRef = useRef<HTMLButtonElement>(null);

	const show = useCallback(() => setOpenedAt(location.key), [location.key]);
	// Esc／取消／點背景：留在原頁，焦點回到按鈕。點入口連結是換頁，不走這條。
	const dismiss = useCallback(() => {
		setOpenedAt(null);
		buttonRef.current?.focus();
	}, []);
	const closeForNavigation = useCallback(() => setOpenedAt(null), []);

	return { open, buttonRef, show, dismiss, closeForNavigation };
}
```

- [ ] **Step 3: `TabBar.tsx` 改用共用模組**——`LEFT_TABS = NAV_TABS.slice(0, 2)`、`RIGHT_TABS = NAV_TABS.slice(2)`；`TabLink` 的 prop 型別改用 `NavTab`；元件本體改成：

```tsx
export function TabBar() {
	const sheet = useAddSheet();
	return (
		<>
			<nav className={styles.bar} aria-label="主要導覽">
				{LEFT_TABS.map((tab) => (
					<TabLink key={tab.to} tab={tab} />
				))}
				<div className={styles.addSlot}>
					<button
						ref={sheet.buttonRef}
						type="button"
						className={styles.add}
						aria-label="新增紀錄"
						aria-haspopup="dialog"
						aria-expanded={sheet.open}
						onClick={sheet.show}
					>
						<Plus aria-hidden="true" size={28} />
					</button>
				</div>
				{RIGHT_TABS.map((tab) => (
					<TabLink key={tab.to} tab={tab} />
				))}
			</nav>
			{sheet.open && (
				<AddSheet
					onDismiss={sheet.dismiss}
					onNavigate={sheet.closeForNavigation}
				/>
			)}
		</>
	);
}
```

保留 TabBar 檔頭的說明（NavLink、`end`、「＋」不是路由），把已經搬到 `use-add-sheet.ts` 的那段說明刪掉、改成一句「開關狀態見 `use-add-sheet.ts`」。

- [ ] **Step 4: 既有測試照樣綠**：`npx vitest run tests/tab-bar.test.tsx tests/app.test.tsx` → 全綠（純重構）。

- [ ] **Step 5: 寫 `SideNav` 的失敗測試** `tests/side-nav.test.tsx`

```tsx
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { SideNav } from "../src/components/SideNav";

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<SideNav />
			<Routes>
				<Route path="*" element={null} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("SideNav", () => {
	it("「新增紀錄」是導覽裡的第一個控制項，後面依序是四個目的地", () => {
		renderAt("/");
		const nav = screen.getByRole("navigation", { name: "主要導覽" });
		const controls = within(nav).getAllByRole(/^(button|link)$/);
		expect(controls.map((el) => el.getAttribute("aria-label") ?? el.textContent)).toEqual([
			"新增紀錄",
			"總覽",
			"報表",
			"飲食",
			"我的",
		]);
		for (const [name, href] of [
			["總覽", "/"],
			["報表", "/reports"],
			["飲食", "/diet"],
			["我的", "/me"],
		] as const) {
			expect(within(nav).getByRole("link", { name })).toHaveAttribute("href", href);
		}
	});

	it("在 /diet 時亮的是飲食，不是總覽", () => {
		renderAt("/diet");
		expect(screen.getByRole("link", { name: "飲食" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("「新增紀錄」打開選單（記帳、記一餐），Esc 關掉、焦點回到按鈕", async () => {
		renderAt("/");
		const button = screen.getByRole("button", { name: "新增紀錄" });
		expect(button).toHaveAttribute("aria-expanded", "false");

		await userEvent.click(button);
		expect(screen.getByRole("dialog", { name: "新增紀錄" })).toBeInTheDocument();
		expect(button).toHaveAttribute("aria-expanded", "true");
		expect(screen.getByRole("link", { name: "記帳" })).toHaveAttribute(
			"href",
			"/expenses/new",
		);
		expect(screen.getByRole("link", { name: "記一餐" })).toHaveAttribute(
			"href",
			"/meals/new",
		);

		await userEvent.keyboard("{Escape}");
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(button).toHaveFocus();
	});

	it("點選單裡的「記帳」：換頁，選單關掉", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));
		await userEvent.click(screen.getByRole("link", { name: "記帳" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
```

註：第一條的 `textContent` 對連結是「圖示（aria-hidden 的 svg，沒有文字）＋標籤」，所以會等於標籤文字；按鈕取 `aria-label`。如果實際 DOM 讓這個比較不乾淨，改用 `computeAccessibleName` 等價的作法（例如對每個元素用 `getByRole(..., { name })` 再比 `compareDocumentPosition`），但**順序**這個斷言一定要保留。

- [ ] **Step 6: 跑，確認紅**：`npx vitest run tests/side-nav.test.tsx`

- [ ] **Step 7: 實作 `src/components/SideNav.tsx`**

```tsx
import { Plus } from "lucide-react";
import { NavLink } from "react-router";
import { AddSheet } from "./AddSheet";
import { NAV_TABS } from "./nav-tabs";
import styles from "./SideNav.module.css";
import { useAddSheet } from "./use-add-sheet";

/** 電腦版的左側導覽（電腦版版面規格 §3、§5）。
 *
 *  **名稱跟手機的分頁列一模一樣**（導覽「主要導覽」、按鈕「新增紀錄」、
 *  四個連結）：既有的單元測試與 e2e 用 getByRole 找，兩種版面都找得到。
 *  看得到的字是「新增」，可及名稱「新增紀錄」包含它（WCAG 2.5.3）。
 *
 *  「新增」在最上面——DOM 順序就是 Tab 順序，所以這裡不能跟 TabBar 共用
 *  一份 JSX 再用 CSS 換位置。 */
export function SideNav() {
	const sheet = useAddSheet();
	return (
		<>
			<nav className={styles.side} aria-label="主要導覽">
				<button
					ref={sheet.buttonRef}
					type="button"
					className={styles.add}
					aria-label="新增紀錄"
					aria-haspopup="dialog"
					aria-expanded={sheet.open}
					onClick={sheet.show}
				>
					<Plus aria-hidden="true" size={20} />
					<span aria-hidden="true">新增</span>
				</button>
				<ul className={styles.links}>
					{NAV_TABS.map((tab) => {
						const Icon = tab.icon;
						return (
							<li key={tab.to}>
								<NavLink
									to={tab.to}
									end={tab.end}
									className={({ isActive }) =>
										isActive ? `${styles.link} ${styles.active}` : styles.link
									}
								>
									<Icon aria-hidden="true" size={20} />
									<span>{tab.label}</span>
								</NavLink>
							</li>
						);
					})}
				</ul>
			</nav>
			{sheet.open && (
				<AddSheet
					onDismiss={sheet.dismiss}
					onNavigate={sheet.closeForNavigation}
				/>
			)}
		</>
	);
}
```

`src/components/SideNav.module.css`：

```css
/* 電腦版左側導覽（電腦版版面規格 §3）。寬度用 --side-nav-width，
   index.css 的 .app-main 用同一個變數讓出空間，兩邊不會漂移。 */
.side {
	position: fixed;
	top: 0;
	bottom: 0;
	left: 0;
	z-index: 10;
	box-sizing: border-box;
	width: var(--side-nav-width);
	display: flex;
	flex-direction: column;
	gap: var(--space-4);
	padding: var(--space-4) var(--space-3);
	background: var(--color-surface);
	border-right: 1px solid var(--color-border);
}

.add {
	display: flex;
	align-items: center;
	justify-content: center;
	gap: var(--space-2);
	min-height: 44px;
	border: none;
	border-radius: var(--radius-button);
	background: var(--color-action);
	color: var(--color-on-action);
	font-size: 16px;
	font-weight: 600;
	cursor: pointer;
}

.links {
	list-style: none;
	margin: 0;
	padding: 0;
	display: flex;
	flex-direction: column;
	gap: var(--space-1);
}

.link {
	display: flex;
	align-items: center;
	gap: var(--space-3);
	min-height: 44px;
	padding: 0 var(--space-3);
	border-radius: var(--radius-button);
	color: var(--color-text-muted);
	text-decoration: none;
	font-size: 15px;
}

.link:hover {
	background: var(--color-bg);
	color: var(--color-text);
}

.active,
.active:hover {
	background: var(--color-accent-soft);
	color: var(--color-action);
	font-weight: 600;
}
```

`src/index.css` 的 `:root` 裡、`--tab-bar-height` 附近加：

```css
	/* 電腦版左側導覽的寬度（電腦版版面規格 §3）。SideNav 與 .app-main 共用。 */
	--side-nav-width: 200px;
```

`tests/css-tokens.test.ts` 的 `PAIRS` 加一組（目前那一頁的連結文字壓在 accent-soft 上）：

```ts
	["--color-action", "--color-accent-soft"],
```

- [ ] **Step 8: 「新增」選單在電腦版是置中對話框**——`src/components/AddSheet.module.css` 最後加：

```css
/* 電腦版（外框有 app-desktop，電腦版版面規格 §2）：不是從底部滑上來的面板，
   是畫面中間、最寬 400px 的對話框。AddSheet 沒有用 portal，渲染在外框裡面，
   所以這個祖先選擇器碰得到。 */
:global(.app-desktop) .layer {
	justify-content: center;
	align-items: center;
}

:global(.app-desktop) .sheet {
	box-sizing: border-box;
	width: min(400px, calc(100% - 2 * var(--space-4)));
	border-radius: var(--radius-card);
	padding-bottom: var(--space-4);
}
```

- [ ] **Step 9: 跑**：`npx vitest run tests/side-nav.test.tsx tests/tab-bar.test.tsx tests/css-tokens.test.ts` → 綠。

- [ ] **Step 10: 鑑別力**：暫時把 SideNav 的 `<button>` 搬到 `<ul>` 後面 → 第一條紅；改回。暫時把 `use-add-sheet.ts` 的 `if (openedAt !== null && openedAt !== location.key) setOpenedAt(null);` 刪掉 → 「點記帳換頁、選單關掉」那條（SideNav）與 tab-bar 對應的測試應該有一條紅（若都沒紅，在 side-nav 補一條：開選單 → 換頁 → 選單關掉 → 上一頁 → 選單沒有自己跳回來）；改回。

- [ ] **Step 11: 全部**：`npm run test && npm run typecheck && npm run lint`

- [ ] **Step 12: Commit**：`feat(frontend): 電腦版左側導覽，新增選單的開關抽成共用 hook`

---

### Task 3: 外框——兩種版面、內容寬度、未登入畫面

**Files:**
- Modify: `src/App.tsx`, `src/index.css`, `tests/app.test.tsx`

- [ ] **Step 1: 在 `tests/app.test.tsx` 加失敗測試**（用檔案裡既有的 `mockBackend()`；檔案上方 import `act` 與 `setDesktop`）

```tsx
import { act } from "@testing-library/react";
import { setDesktop } from "../src/test/media";

describe("App 的電腦版外框（電腦版版面規格 §3）", () => {
	beforeEach(() => {
		setTokens({ access_token: "a", refresh_token: "r" });
	});

	it("寬螢幕：左側導覽在外框裡、第一個控制項是「新增紀錄」，外框有 app-desktop", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/");
		render(<App />);

		expect(await screen.findByRole("heading", { name: "總覽" })).toBeInTheDocument();
		const nav = screen.getByRole("navigation", { name: "主要導覽" });
		expect(nav.closest(".app-desktop")).not.toBeNull();
		expect(screen.getByRole("main").closest(".app-desktop")).not.toBeNull();
		expect(screen.getByRole("main").querySelector(".app-content-wide")).not.toBeNull();
		// 只有一個導覽（不是 SideNav＋TabBar 都在）。
		expect(screen.getAllByRole("navigation", { name: "主要導覽" })).toHaveLength(1);
	});

	it("寬螢幕的記帳頁：照樣有左側導覽，內容是表單寬度", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/expenses/new");
		render(<App />);

		expect(await screen.findByRole("button", { name: "記一筆" })).toBeInTheDocument();
		expect(screen.getByRole("navigation", { name: "主要導覽" })).toBeInTheDocument();
		expect(screen.getByRole("main").querySelector(".app-content-form")).not.toBeNull();
	});

	it("其他頁（我的）是窄的內容寬度", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/me");
		render(<App />);

		expect(await screen.findByRole("heading", { name: "我的" })).toBeInTheDocument();
		expect(screen.getByRole("main").querySelector(".app-content-narrow")).not.toBeNull();
	});

	it("視窗從寬拉窄：換回手機版（沒有 app-desktop，記帳頁沒有導覽）", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/expenses/new");
		render(<App />);
		expect(await screen.findByRole("button", { name: "記一筆" })).toBeInTheDocument();
		expect(screen.getByRole("navigation", { name: "主要導覽" })).toBeInTheDocument();

		act(() => setDesktop(false));

		expect(screen.queryByRole("navigation", { name: "主要導覽" })).not.toBeInTheDocument();
		expect(document.querySelector(".app-desktop")).toBeNull();
	});

	it("手機版（預設）：沒有 app-desktop", async () => {
		mockBackend();
		window.history.replaceState(null, "", "/");
		render(<App />);
		expect(await screen.findByRole("heading", { name: "總覽" })).toBeInTheDocument();
		expect(document.querySelector(".app-desktop")).toBeNull();
	});
});
```

（如果這個檔案的其他 `describe` 有 `beforeEach` 會清 token／重設 fetch，沿用同樣的寫法；`window.history.replaceState` 的用法跟既有的「直接打開 /expenses/new」那條一樣。）

- [ ] **Step 2: 跑，確認紅**：`npx vitest run tests/app.test.tsx`

- [ ] **Step 3: 改 `src/App.tsx` 的 `LoggedInShell`**（import `useLocation`、`SideNav`、`useIsDesktop`、`contentWidthFor`）

```tsx
/** 登入後的外框（電腦版版面規格 §3）。
 *
 *  **電腦版（≥ 1024px）**：最外層 `app-desktop`，左側 `SideNav`，每一頁都有
 *  （包括記帳——寬螢幕上沒有「導覽蓋住鍵盤」的問題）。內容區的最寬寬度依路由
 *  決定（`contentWidthFor`）。頁面的兩欄 CSS 看 `app-desktop` 這個 class，
 *  不自己寫 media query——斷點只在 `lib/layout.ts`。
 *
 *  **手機版**：跟以前一樣。記帳（`/expenses/new`）不顯示分頁列（記帳與離線
 *  規格 §2 (b)）：矮螢幕（iPhone SE）上分頁列會蓋住數字鍵盤的最下面幾列。
 *  那一頁是全螢幕的記帳流程，有自己的「關閉」。記一餐不隱藏——它沒有關閉鈕，
 *  在 iOS 主畫面模式下隱藏就出不去了，而且沒有數字鍵盤。`.app-main` 的底部
 *  留白是為分頁列留的，隱藏時一起拿掉（`index.css`）。`useMatch` 而不是比
 *  `pathname` 字串：`/expenses/new/` 也命中同一個路由。 */
function LoggedInShell({ children }: { children: ReactNode }) {
	const isDesktop = useIsDesktop();
	const { pathname } = useLocation();
	const onAddExpense = useMatch("/expenses/new") !== null;

	if (isDesktop) {
		return (
			<div className="app-desktop">
				<SideNav />
				<main className="app-main">
					<div className={`app-content app-content-${contentWidthFor(pathname)}`}>
						{children}
					</div>
				</main>
			</div>
		);
	}

	return (
		<>
			<main
				className={onAddExpense ? "app-main app-main-no-tab-bar" : "app-main"}
			>
				{children}
			</main>
			{!onAddExpense && <TabBar />}
		</>
	);
}
```

**注意：** 兩個分支的 `children` 在不同的父元素底下——拉寬拉窄時頁面會重新掛載（表單裡打到一半的字會不見）。這是可接受的取捨（規格 §5 已接受選單會關），在註解寫一句。

未登入的兩個畫面包 `app-auth`：

```tsx
			) : JOIN_PATHS.has(window.location.pathname) ? (
				// 邀請連結（邀請規格 §4.1）。其他網址照舊一律登入畫面。
				// app-auth：置中、最寬 400px、左右留白（電腦版版面規格 §3）。
				<main className="app-auth">
					<Join onSuccess={() => setLoggedIn(true)} />
				</main>
			) : (
				<main className="app-auth">
					<Login onSuccess={() => setLoggedIn(true)} />
				</main>
			)}
```

先確認 `Login.tsx` 自己沒有 `<main>`（目前根元素是 `<form>`），避免巢狀的 main。

- [ ] **Step 4: `src/index.css`**——在 `.app-main-no-tab-bar` 規則後面加：

```css
/* 手機版的內容最寬 600px、置中（電腦版版面規格 §1）：直立的平板不再拉滿。
   border-box：600 是含左右留白的寬度，e2e 量得到的就是這個數字。 */
.app-main {
	box-sizing: border-box;
	max-width: 600px;
	margin-inline: auto;
}

/* 電腦版外框（≥ 1024px，App.tsx 的 LoggedInShell 加 app-desktop）。
   讓出左側導覽的寬度；沒有分頁列，底部只要一般留白。權重 (0,2,0) 蓋過上面的
   .app-main。 */
.app-desktop .app-main {
	max-width: none;
	margin: 0 0 0 var(--side-nav-width);
	padding: var(--space-4) var(--space-6) var(--space-6);
}

/* 內容區在導覽右邊的空間裡置中；最寬依路由（lib/layout.ts 的 contentWidthFor）。 */
.app-content {
	margin-inline: auto;
}

.app-content-wide {
	max-width: 1100px;
}

.app-content-narrow {
	max-width: 640px;
}

.app-content-form {
	max-width: 480px;
}

/* 登入、建立帳號（未登入，沒有導覽）：兩種寬度都一樣。 */
.app-auth {
	box-sizing: border-box;
	max-width: 400px;
	margin-inline: auto;
	padding: 0 var(--space-3) var(--space-6);
}
```

（`.app-main` 原本那條規則保留它的 padding；新規則寫在後面，只加 `box-sizing`、`max-width`、`margin-inline`——或直接併進原本那條，擇一，不要兩條互相覆蓋 padding。）

- [ ] **Step 5: 跑**：`npx vitest run tests/app.test.tsx tests/login.test.tsx tests/join.test.tsx` → 綠。

- [ ] **Step 6: 鑑別力**：暫時把 `if (isDesktop)` 改成 `if (false)` → 新的電腦版測試紅；改回。暫時把 `contentWidthFor(pathname)` 換成 `"wide"` → 記帳／我的那兩條紅；改回。

- [ ] **Step 7: 全部**：`npm run test && npm run typecheck && npm run lint`

- [ ] **Step 8: Commit**：`feat(frontend): 電腦版外框——左側導覽、依頁面限制內容寬度，手機版最寬 600px`

---

### Task 4: 總覽、報表、飲食的兩欄

**Files:**
- Create: `src/components/layout.module.css`
- Modify: `src/screens/Overview.tsx`, `src/screens/Overview.module.css`, `src/screens/Expenses.tsx`, `src/screens/Today.tsx`, `src/screens/Today.module.css`, `tests/today.test.tsx`

- [ ] **Step 1: 共用的兩欄** `src/components/layout.module.css`

```css
/* 電腦版的兩欄（電腦版版面規格 §4）。只在外框有 app-desktop 時生效；
   手機版是普通的區塊，子元素照原本的順序往下排。
   左右比 2:3、上緣對齊；整頁一起捲，不做各欄獨立捲動。 */
:global(.app-desktop) .columns {
	display: grid;
	grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
	gap: var(--space-6);
	align-items: start;
}

/* 兩欄的第一個標題貼齊上緣，左右兩欄才對得齊。 */
:global(.app-desktop) .columns > * > :first-child {
	margin-top: 0;
}
```

- [ ] **Step 2: 總覽**——`Overview.tsx` 的 return 裡，把卡片與時間線包起來（`import layout from "../components/layout.module.css";`）：

```tsx
			<OfflineBanner />
			<div className={layout.columns}>
				<div className={styles.cards}>
					<MonthSpendCard />
					<TodayKcalCard />
				</div>
				<TodayTimeline />
			</div>
```

`Overview.module.css` 加（左欄窄，兩張卡上下疊）：

```css
/* 電腦版：左欄只有 2/5 寬，兩張數字卡上下疊（電腦版版面規格 §4）。 */
:global(.app-desktop) .cards {
	grid-template-columns: minmax(0, 1fr);
}
```

`TodayTimeline` 的 `<section>` 第一個子元素是 `<h2>`——上面的 `:first-child` 規則讓它貼齊。

- [ ] **Step 3: 報表**——`Expenses.tsx`：

```tsx
			<nav className={styles.links} aria-label="報表相關">
				<Link to="/trend">營養趨勢</Link>
			</nav>

			<div className={layout.columns}>
				<div>
					<h2>這個月花了多少</h2>
					<Card testId="expense-summary">
						<MonthSummary query={summaryQuery} />
					</Card>
				</div>
				<div>
					<h2>這個月</h2>
					<Card>
						{/* …原本的清單內容原樣搬進來… */}
					</Card>
				</div>
			</div>
```

- [ ] **Step 4: 飲食的 DOM 順序測試（先寫）**——在 `tests/today.test.tsx` 用檔案裡既有的 render／mock 方式（有目標、至少一餐、至少一個補劑的資料；照既有的測試抄），加兩條：

```tsx
import { act } from "@testing-library/react";
import { setDesktop } from "../src/test/media";

function expectOrder(...elements: HTMLElement[]) {
	for (let i = 1; i < elements.length; i++) {
		const previous = elements[i - 1] as HTMLElement;
		const current = elements[i] as HTMLElement;
		expect(
			previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	}
}

it.each([false, true])(
	"營養素 → 今日餐點 → 今日補劑 的順序不因版面改變（電腦版＝%s）",
	async (desktop) => {
		setDesktop(desktop);
		/* 照這個檔案既有的方式 render <Today />（含 router 與 QueryClient） */
		const kcal = await screen.findByTestId("macro-kcal");
		expectOrder(
			kcal,
			screen.getByRole("heading", { name: "今日餐點" }),
			screen.getByRole("heading", { name: "今日補劑" }),
		);
	},
);
```

（`macro-kcal` 的 testid 在有目標時來自 `MacroBar`——先確認 `MacroBar` 有沒有這個 testid；沒有的話用有目標時第一個營養素的可及名稱，例如 `getByText("熱量")`。有目標與沒目標兩種 mock 都行，挑一種既有測試已經有的。）

這條在改之前就應該綠（它守的是「改完之後手機版順序沒變」）。先跑一次確認綠。

- [ ] **Step 5: 飲食的兩欄**——`Today.tsx` 的「我的」分支：

```tsx
					<nav className={styles.links} aria-label="飲食相關">
						<Link to="/foods">食物庫</Link>
					</nav>

					{/* 電腦版：營養素與補劑在左欄、餐點在右欄（電腦版版面規格 §4）。
					    DOM 順序維持 營養素 → 餐點 → 補劑（手機版就是這個順序），
					    左右靠 grid-template-areas 擺，不是靠換 DOM 順序。 */}
					<div className={styles.columns}>
						<div className={styles.macros}>
							{/* 原本的 載入中／無法載入／離線提示／營養素卡片 原樣搬進來 */}
						</div>
						<div className={styles.meals}>
							<MealList />
						</div>
						<div className={styles.supplements}>
							<Card>{/* 原本的今日補劑原樣搬進來 */}</Card>
						</div>
					</div>
```

「好友」分支：

```tsx
			{view === "friends" ? (
				<div className={styles.friendFeed}>
					<FriendFeed />
				</div>
			) : (
```

`Today.module.css` 加：

```css
/* 電腦版的兩欄（電腦版版面規格 §4）：左＝營養素＋補劑、右＝餐點（跨兩列）。
   DOM 順序是 營養素、餐點、補劑——手機版照這個順序往下排，不受影響。 */
:global(.app-desktop) .columns {
	display: grid;
	grid-template-columns: minmax(0, 2fr) minmax(0, 3fr);
	grid-template-rows: auto 1fr;
	grid-template-areas:
		"macros meals"
		"supplements meals";
	gap: var(--space-4) var(--space-6);
	align-items: start;
}

:global(.app-desktop) .macros {
	grid-area: macros;
}

:global(.app-desktop) .meals {
	grid-area: meals;
}

:global(.app-desktop) .supplements {
	grid-area: supplements;
}

/* 兩欄的第一個標題／卡片貼齊上緣。 */
:global(.app-desktop) .columns > * > :first-child {
	margin-top: 0;
}

/* 好友動態是單欄，最寬 640px、靠左（跟上面的「看誰的」對齊）。 */
:global(.app-desktop) .friendFeed {
	max-width: 640px;
}
```

- [ ] **Step 6: 跑**：`npx vitest run tests/today.test.tsx tests/overview.test.tsx tests/expenses.test.tsx tests/offline.test.tsx` → 綠。

- [ ] **Step 7: 鑑別力**：暫時把 Today 的補劑 `<div>` 搬到餐點前面 → 順序測試紅；改回。

- [ ] **Step 8: 全部**：`npm run test && npm run typecheck && npm run lint`

- [ ] **Step 9: Commit**：`feat(frontend): 總覽、報表、飲食在電腦版排兩欄`

---

### Task 5: e2e 版面測試、交接文件

**Files:**
- Create: `e2e/desktop-layout.spec.ts`
- Modify: `docs/handover.md`

前置：本機 dev stack 要在跑（`docker compose up -d`，api 用目前的程式碼建置過），e2e 帳號已經種好（見 `e2e/accounts.ts` 的說明）。`login(page)` 在 `e2e/touch-targets.ts`。

- [ ] **Step 1: 寫 `e2e/desktop-layout.spec.ts`**

```ts
import { expect, type Page, test } from "@playwright/test";
import { login } from "./touch-targets.ts";

// 電腦版版面（規格 §6）。jsdom 量不到幾何，這裡量：導覽在哪、誰在誰右邊、
// 有沒有橫向捲軸、鍵盤多寬。

const PAGES = ["/", "/reports", "/diet", "/me", "/expenses/new"] as const;

async function expectNoHorizontalScroll(page: Page, path: string) {
	const overflow = await page.evaluate(
		() => document.documentElement.scrollWidth - document.documentElement.clientWidth,
	);
	expect(overflow, `${path} 有橫向捲軸`).toBeLessThanOrEqual(0);
}

async function box(page: Page, locator: ReturnType<Page["locator"]>) {
	const b = await locator.boundingBox();
	if (b === null) throw new Error("元素不在畫面上");
	return b;
}

test.describe("電腦版 1280×800", () => {
	test.use({ viewport: { width: 1280, height: 800 } });

	test("左側導覽、各頁沒有橫向捲軸", async ({ page }) => {
		await login(page);
		for (const path of PAGES) {
			await page.goto(path);
			const nav = page.getByRole("navigation", { name: "主要導覽" });
			await expect(nav).toBeVisible();
			const b = await box(page, nav);
			expect(b.x).toBe(0);
			expect(b.width).toBeLessThan(260);
			expect(b.height).toBeGreaterThan(700);
			await expectNoHorizontalScroll(page, path);
		}
	});

	test("總覽：時間線在數字卡的右邊", async ({ page }) => {
		await login(page);
		await page.goto("/");
		const card = page.getByTestId("month-spend");
		const timeline = page.getByRole("heading", { name: "今天", exact: true });
		await expect(card).toBeVisible();
		await expect(timeline).toBeVisible();
		const c = await box(page, card);
		const t = await box(page, timeline);
		expect(t.x).toBeGreaterThan(c.x + c.width);
	});

	test("報表：明細在摘要的右邊", async ({ page }) => {
		await login(page);
		await page.goto("/reports");
		const summary = page.getByTestId("expense-summary");
		const list = page.getByRole("heading", { name: "這個月", exact: true });
		const s = await box(page, summary);
		const l = await box(page, list);
		expect(l.x).toBeGreaterThan(s.x + s.width);
	});

	test("飲食：餐點在右欄，補劑在左欄的營養素下面", async ({ page }) => {
		await login(page);
		await page.goto("/diet");
		const meals = page.getByRole("heading", { name: "今日餐點" });
		const supplements = page.getByRole("heading", { name: "今日補劑" });
		const m = await box(page, meals);
		const s = await box(page, supplements);
		expect(m.x).toBeGreaterThan(s.x + s.width);
	});

	test("記帳：數字鍵盤最寬 480px", async ({ page }) => {
		await login(page);
		await page.goto("/expenses/new");
		const keypad = page.getByRole("group", { name: "數字鍵盤" });
		const k = await box(page, keypad);
		expect(k.width).toBeLessThanOrEqual(480);
	});

	test("新增選單是畫面中間的對話框", async ({ page }) => {
		await login(page);
		await page.goto("/");
		await page.getByRole("button", { name: "新增紀錄" }).click();
		const dialog = page.getByRole("dialog", { name: "新增紀錄" });
		const d = await box(page, dialog);
		expect(d.width).toBeLessThanOrEqual(400);
		expect(d.y + d.height).toBeLessThan(800 - 50);
	});
});

test.describe("手機 390×844", () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test("導覽在底部、各頁沒有橫向捲軸", async ({ page }) => {
		await login(page);
		for (const path of PAGES) {
			await page.goto(path);
			await expectNoHorizontalScroll(page, path);
			if (path === "/expenses/new") continue; // 記帳頁手機版沒有分頁列
			const nav = page.getByRole("navigation", { name: "主要導覽" });
			const b = await box(page, nav);
			expect(b.y + b.height).toBeGreaterThan(844 - 2);
			expect(b.width).toBeGreaterThan(380);
		}
	});
});
```

每次 `page.goto` 之後，量東西之前先等該頁獨有的元素出現（handover §6 第 53 種：換頁後的第一個斷言要對準只有那一頁才有的東西）——例如 `/reports` 等 `getByRole("heading", { name: "報表" })`。在迴圈裡加一個 `PAGES` 對應標題的表（`/`→總覽、`/reports`→報表、`/diet`→飲食、`/me`→我的、`/expenses/new`→等 `getByRole("button", { name: "記一筆" })`）。

- [ ] **Step 2: 跑**：`npx playwright test e2e/desktop-layout.spec.ts` → 綠。失敗的話先判斷是版面真的錯，還是量法錯（例如 `/diet` 沒有補劑時「今日補劑」標題還在嗎？——在，那個 Card 一定渲染）。

- [ ] **Step 3: 鑑別力**：暫時把 `layout.module.css` 的 `.columns` 規則註解掉 → 總覽／報表那兩條紅；改回。暫時把 `.app-content-form` 的 `max-width` 改成 `none` → 鍵盤那條紅；改回。

- [ ] **Step 4: 全部 e2e**：`npx playwright test` → 全綠（多數既有 spec 跑在預設 1280×720，現在是電腦版）。有紅的話，先判斷是不是那個 spec 依賴「導覽在底部」之類的手機版假設；是的話替那個 spec 加 `test.use({ viewport: { width: 390, height: 844 } })` **並在 commit 訊息說明**，不要改版面去遷就測試。

- [ ] **Step 5: 交接文件**——`docs/handover.md`：在介面的段落加一小節「電腦版版面」：斷點在 `lib/layout.ts`（唯一一處）、`app-desktop` class 的用法（頁面的電腦版 CSS 一律寫 `:global(.app-desktop) .x`，不要寫 media query）、內容寬度表、`SideNav` 與 `TabBar` 共用 `nav-tabs.ts`／`use-add-sheet.ts`、拉寬拉窄會重新掛載頁面（已接受）、測試環境預設是手機版（`src/test/media.ts` 的 `setDesktop`）。規格 `2026-10-08-desktop-layout-design.md` 的「狀態」改成「已實作（`feat/desktop-layout`）」。

- [ ] **Step 6: Commit**：`test(e2e): 電腦版與手機版的版面幾何；docs: 交接文件記錄電腦版版面`
