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
		// 這條守的是 NavLink 的 `end`。根路由 "/" 是每一個路徑的前綴，
		// 沒有 end 的話「今日總覽」在任何頁面都會是 aria-current，
		// 而上面那條測試（停在 /trend）**照樣會綠**——因為它只檢查趨勢
		// 那一格亮著，沒檢查別格暗著。這條是專門補那個洞的。
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
