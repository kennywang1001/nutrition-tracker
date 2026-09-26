import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { TabBar } from "../src/components/TabBar";
import { json, mockApi } from "./helpers/mock-api";

// TabBar 從 Task 7 開始自己呼叫 useMe()（決定第五格出不出現），所以這裡
// 一定要包 QueryClientProvider，不然 useQuery 會直接炸掉——這是計畫原文
// 講的「這裡的 3 則會壞，是預期的」。

function me(role: "user" | "admin") {
	return {
		id: 1,
		email: "kenny@example.com",
		display_name: "Kenny",
		role,
		timezone: "Asia/Taipei",
	};
}

function wrap(children: ReactNode, path: string) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

function renderAt(path: string, role: "user" | "admin" = "user") {
	mockApi([{ method: "GET", path: "/api/me", handler: () => json(me(role)) }]);
	return render(wrap(<TabBar />, path));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("TabBar", () => {
	it("四個目的地都在", async () => {
		renderAt("/");
		for (const name of ["今日總覽", "記一餐", "趨勢", "食物庫"]) {
			expect(await screen.findByRole("link", { name })).toBeInTheDocument();
		}
	});

	it("目前所在的那一格標成 aria-current", async () => {
		// 用 NavLink 而不是 Link：NavLink 自己會依路由比對加上
		// aria-current="page"。自己用 useLocation 比對字串的話，
		// 「哪一格是亮的」就變成一個要自己維護、而且測試只驗 class
		// 名稱的東西——而 class 名稱跟螢幕閱讀器讀到的東西無關。
		renderAt("/trend");

		expect(await screen.findByRole("link", { name: "趨勢" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "今日總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("在 /log 時亮的是記一餐，不是今日總覽", async () => {
		// 上面那條測試（停在 /trend）只檢查趨勢那一格亮著，**沒檢查別格暗著**
		// ——把每一格都標成 aria-current 的實作照樣會綠。這條補那個洞。
		//
		// ## 它守的不是 `end`（實測過，計畫原本寫錯了）
		//
		// 計畫原本說「拿掉 TABS 裡 `/` 那一格的 `end: true`，這條會紅」。
		// **實測：3 則全綠。** react-router 8.3.1 的 NavLink 對 `to="/"` 有
		// 內建特例，跟 `end` 無關 ——
		// `node_modules/react-router/dist/development/lib/dom/lib.js`：
		//
		//   const endSlashPosition = toPathname !== "/" && toPathname.endsWith("/")
		//     ? toPathname.length - 1 : toPathname.length;
		//   isActive = locationPathname === toPathname
		//     || (!end && locationPathname.startsWith(toPathname)
		//         && locationPathname.charAt(endSlashPosition) === "/");
		//
		// `toPathname === "/"` 時 endSlashPosition 是 1，於是非精確分支要求
		// `locationPathname.charAt(1) === "/"` —— 對 `/log` 那是 "l"，恆為
		// false。**所以 `end` 對根路由那一格是無作用的保險**（留著是因為它
		// 精確表達意圖，而且不排除將來 react-router 改掉這個內建行為）。
		//
		// ## 它真正守的是「不要自己拿 useLocation() 比字串」
		//
		// 那正是 TabBar 的 docstring 主張的架構選擇。實測過的突變：
		// 把 NavLink 換成 `<Link>` 加 `useLocation()` 加
		// `location.pathname.startsWith(tab.to)`，**這條與上面那條都紅**
		// （`/log`.startsWith("/") 為真，今日總覽也亮了）。
		//
		// 也就是說：這條測試有鑑別力，只是標的跟計畫寫的不是同一個。
		renderAt("/log");

		expect(await screen.findByRole("link", { name: "記一餐" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "今日總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("管理員看得到第五格「審核」", async () => {
		renderAt("/", "admin");

		expect(
			await screen.findByRole("link", { name: "審核" }),
		).toBeInTheDocument();
	});

	it("一般使用者看不到「審核」", async () => {
		renderAt("/", "user");

		// 先等一個一定會出現的目的地，確保 useMe() 已經解析完——否則下面
		// 的 queryByRole 只是在證明「還沒 fetch 完」，不是在證明「查完之後
		// 仍然沒有」。
		await screen.findByRole("link", { name: "今日總覽" });

		expect(
			screen.queryByRole("link", { name: "審核" }),
		).not.toBeInTheDocument();
	});

	it("useMe 還在載入時看不到「審核」——不要先閃一下再消失", () => {
		// 不用 mockApi：故意讓 fetch 停在 pending，模擬 useMe() 還沒回來的
		// 那個瞬間。斷言的是「一開始就沒有」，不是「等一下才消失」——
		// isAdmin 用 meQuery.data?.role（TabBar.tsx）在 data 是 undefined
		// 時自然是 false，不需要另外判斷 isLoading 才擋得住。
		vi.spyOn(globalThis, "fetch").mockImplementation(
			() => new Promise(() => {}),
		);

		render(wrap(<TabBar />, "/"));

		expect(screen.getByRole("link", { name: "今日總覽" })).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "審核" }),
		).not.toBeInTheDocument();
	});
});
