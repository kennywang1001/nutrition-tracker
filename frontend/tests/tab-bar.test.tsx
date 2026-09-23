import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { TabBar } from "../src/components/TabBar";

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<TabBar />
		</MemoryRouter>,
	);
}

describe("TabBar", () => {
	it("四個目的地都在", () => {
		renderAt("/");
		for (const name of ["今日總覽", "記一餐", "趨勢", "食物庫"]) {
			expect(screen.getByRole("link", { name })).toBeInTheDocument();
		}
	});

	it("目前所在的那一格標成 aria-current", () => {
		// 用 NavLink 而不是 Link：NavLink 自己會依路由比對加上
		// aria-current="page"。自己用 useLocation 比對字串的話，
		// 「哪一格是亮的」就變成一個要自己維護、而且測試只驗 class
		// 名稱的東西——而 class 名稱跟螢幕閱讀器讀到的東西無關。
		renderAt("/trend");

		expect(screen.getByRole("link", { name: "趨勢" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "今日總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("在 /log 時亮的是記一餐，不是今日總覽", () => {
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

		expect(screen.getByRole("link", { name: "記一餐" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "今日總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});
});
