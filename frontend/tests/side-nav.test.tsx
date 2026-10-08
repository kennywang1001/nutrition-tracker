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
