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
		["/me/targets", "form"],
		["/me/targets/", "form"],
		["/me/body", "form"],
		["/me/body/", "form"],
		["/weight", "narrow"],
		["/me/password", "form"],
		["/me", "narrow"],
		// 身體與目標（首頁改版規格 D1）：一欄卡片，預設的 narrow——不是 /me/targets、/me/body 那種表單。
		["/me/health", "narrow"],
		["/me/health/", "narrow"],
		["/foods", "narrow"],
		["/foods/12", "narrow"],
		["/trend", "narrow"],
		["/meals/3/edit", "narrow"],
		// 運動規格 D24：記運動是單欄表單；編輯運動同編輯餐點（`contentWidthFor` 只比完整路徑）。
		["/exercises/new", "form"],
		["/exercises/new/", "form"],
		["/exercises/3/edit", "narrow"],
		// 餐點頁（社群規格 §6.1）：唯讀的一餐與留言，不是 `/meals/new` 那種表單寬度。
		["/meals/5", "narrow"],
		["/meals/5/", "narrow"],
		["/notifications", "narrow"],
		// 今天還能吃什麼（營養素配餐規格 D27）：一欄卡片，預設的 narrow。
		["/planner", "narrow"],
		["/planner/", "narrow"],
		["/friends/2", "narrow"],
		["/admin/revisions", "narrow"],
		["/join", "narrow"],
	] as const)("%s → %s", (path, expected) => {
		expect(contentWidthFor(path)).toBe(expected);
	});
});
