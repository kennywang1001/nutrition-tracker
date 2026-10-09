import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { SideNav } from "../src/components/SideNav";

// 電腦版的左側導覽（電腦版版面規格 §3、§5）。開關狀態的細節（換頁自動關、
// 返回不會跳回來）跟 TabBar 共用 use-add-sheet.ts，tab-bar.test.tsx 守得更細；
// 這裡守的是 SideNav 自己的結構與它真的接上了那個 hook。

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
		// DOM 順序就是 Tab 順序：「新增」在最上面，不能是 CSS 換位置的結果。
		renderAt("/");
		const nav = screen.getByRole("navigation", { name: "主要導覽" });
		// getAllByRole 只吃單一角色字串：按鈕與連結分開找，再照 DOM 順序排。
		const controls = [
			...within(nav).getAllByRole("button"),
			...within(nav).getAllByRole("link"),
		].sort((a, b) =>
			a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
		);
		expect(
			controls.map((el) => el.getAttribute("aria-label") ?? el.textContent),
		).toEqual(["新增紀錄", "總覽", "報表", "飲食", "我的"]);
		for (const [name, href] of [
			["總覽", "/"],
			["報表", "/reports"],
			["飲食", "/diet"],
			["我的", "/me"],
		] as const) {
			expect(within(nav).getByRole("link", { name })).toHaveAttribute(
				"href",
				href,
			);
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
		expect(
			screen.getByRole("dialog", { name: "新增紀錄" }),
		).toBeInTheDocument();
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

describe("SideNav：「我的」上的未讀數字（社群規格 D17）", () => {
	function renderUnread(unread?: number) {
		return render(
			<MemoryRouter initialEntries={["/"]}>
				<SideNav unread={unread} />
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
