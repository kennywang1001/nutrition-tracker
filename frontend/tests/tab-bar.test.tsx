import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, useNavigate } from "react-router";
import { describe, expect, it } from "vitest";
import { TabBar } from "../src/components/TabBar";

// 介面改版：TabBar 不再呼叫 useMe()（管理員的「審核」搬到「我的」，
// 見 tests/me.test.tsx），所以不需要 QueryClientProvider 也不需要 mock API。

function renderAt(path: string) {
	return render(
		<MemoryRouter initialEntries={[path]}>
			<TabBar />
		</MemoryRouter>,
	);
}

describe("TabBar", () => {
	it("四個目的地都在，連到對的路由", () => {
		renderAt("/");

		for (const [name, href] of [
			["總覽", "/"],
			["報表", "/reports"],
			["飲食", "/diet"],
			["我的", "/me"],
		] as const) {
			expect(screen.getByRole("link", { name })).toHaveAttribute("href", href);
		}
	});

	it("目前所在的那一格標成 aria-current，別格沒有", () => {
		renderAt("/reports");

		expect(screen.getByRole("link", { name: "報表" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "飲食" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("在 /diet 時亮的是飲食，不是總覽", () => {
		// 守的是「用 NavLink，不要自己拿 useLocation() 比字串」：
		// "/diet".startsWith("/") 為真，自己比字串的實作會讓總覽也亮起來。
		// （`end` 對根路由那一格在 react-router 8.3.1 是無作用的保險——
		// NavLink 對 to="/" 有內建特例，詳見舊版這個檔案的說明與 TabBar.tsx。）
		renderAt("/diet");

		expect(screen.getByRole("link", { name: "飲食" })).toHaveAttribute(
			"aria-current",
			"page",
		);
		expect(screen.getByRole("link", { name: "總覽" })).not.toHaveAttribute(
			"aria-current",
		);
	});

	it("「新增紀錄」打開面板，裡面有記帳與記一餐兩個入口", async () => {
		// **入口測試。** 這個專案三次蓋好後端卻沒有前端入口（食物、補劑、
		// 記帳——handover §6）。拿掉面板裡任何一個連結，這條會紅。
		renderAt("/");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		const sheet = screen.getByRole("dialog", { name: "新增紀錄" });
		expect(sheet).toBeInTheDocument();
		expect(sheet).toHaveAttribute("aria-modal", "true");
		expect(screen.getByRole("link", { name: "記帳" })).toHaveAttribute(
			"href",
			"/expenses/new",
		);
		expect(screen.getByRole("link", { name: "記一餐" })).toHaveAttribute(
			"href",
			"/meals/new",
		);
	});

	it("按 Esc 關掉面板", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("按「取消」關掉面板", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("點了入口之後面板關掉", async () => {
		// 不關的話，使用者到了記帳畫面，面板還蓋在上面。
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.click(screen.getByRole("link", { name: "記帳" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("面板打開時焦點移到第一個入口", async () => {
		// 鍵盤與螢幕閱讀器的使用者按下「＋」之後，焦點不能留在背後被遮住的按鈕上。
		renderAt("/");

		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		expect(screen.getByRole("link", { name: "記帳" })).toHaveFocus();
	});

	it("按 Esc 關掉之後焦點回到「新增紀錄」", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.keyboard("{Escape}");

		expect(screen.getByRole("button", { name: "新增紀錄" })).toHaveFocus();
	});

	it("點背景關掉面板", async () => {
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.click(screen.getByRole("button", { name: "關閉" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("面板開著時換頁（例如返回手勢、Tab 到背後的連結）面板一定關掉", async () => {
		// TabBar 在 <Routes> 外面不會 remount，單純的 boolean 狀態在換頁後
		// 面板還會蓋在新頁面上。
		renderAt("/");
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));

		await userEvent.click(screen.getByRole("link", { name: "飲食" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("換頁再回到上一頁，面板不會自己跳回來", async () => {
		// location.key 每個歷史紀錄各一個；舊的 key 沒清掉的話，回到當初
		// 開著面板的那一頁，key 又對上了。
		function Back() {
			const navigate = useNavigate();
			return (
				<button type="button" onClick={() => navigate(-1)}>
					上一頁
				</button>
			);
		}
		render(
			<MemoryRouter initialEntries={["/"]}>
				<TabBar />
				<Back />
			</MemoryRouter>,
		);
		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));
		await userEvent.click(screen.getByRole("link", { name: "飲食" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "上一頁" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});

describe("TabBar：「我的」上的未讀數字（社群規格 D17）", () => {
	function renderUnread(unread?: number) {
		return render(
			<MemoryRouter initialEntries={["/"]}>
				<TabBar unread={unread} />
			</MemoryRouter>,
		);
	}

	it("3 則：連結的名稱仍然是「我的」，描述是「3 則新通知」，看得到 3", () => {
		renderUnread(3);

		// 名稱是完整比對：數字只要混進名稱（「我的3」），這一行就找不到。
		const link = screen.getByRole("link", { name: "我的" });
		expect(link).toHaveAccessibleDescription("3 則新通知");
		expect(link).toHaveTextContent(/^我的3$/);
		// 看得到的數字對螢幕閱讀器是藏起來的（它聽到的是描述）。
		expect(within(link).getByText("3")).toHaveAttribute("aria-hidden", "true");
		// 描述的那段字在連結外面：放裡面會併進名稱。
		expect(link).not.toContainElement(screen.getByText("3 則新通知"));
	});

	it("9 則還是寫 9；10 則以上寫「9+」，但唸出來的是真的數字", () => {
		const nine = renderUnread(9);
		expect(screen.getByRole("link", { name: "我的" })).toHaveTextContent(
			/^我的9$/,
		);
		nine.unmount();

		renderUnread(10);
		const link = screen.getByRole("link", { name: "我的" });
		expect(link).toHaveTextContent(/^我的9\+$/);
		expect(link).toHaveAccessibleDescription("10 則新通知");
	});

	it.each([
		["0", 0],
		["沒有傳", undefined],
	])("未讀是%s：不畫數字、沒有描述", (_label, unread) => {
		renderUnread(unread);

		const link = screen.getByRole("link", { name: "我的" });
		expect(link).not.toHaveAttribute("aria-describedby");
		expect(link.textContent).toBe("我的");
		expect(screen.queryByText(/則新通知/)).not.toBeInTheDocument();
	});

	it("數字只在「我的」上：其他三個目的地沒有描述、沒有數字", () => {
		renderUnread(3);

		for (const name of ["總覽", "報表", "飲食"]) {
			const link = screen.getByRole("link", { name });
			expect(link).not.toHaveAttribute("aria-describedby");
			expect(link.textContent).toBe(name);
		}
		expect(screen.getAllByText("3 則新通知")).toHaveLength(1);
	});
});
