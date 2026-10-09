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
		["/me/password", "form"],
		["/me", "narrow"],
		["/foods", "narrow"],
		["/foods/12", "narrow"],
		["/trend", "narrow"],
		["/meals/3/edit", "narrow"],
		// 餐點頁（社群規格 §6.1）：唯讀的一餐與留言，不是 `/meals/new` 那種表單寬度。
		["/meals/5", "narrow"],
		["/meals/5/", "narrow"],
		["/friends/2", "narrow"],
		["/admin/revisions", "narrow"],
		["/join", "narrow"],
	] as const)("%s → %s", (path, expected) => {
		expect(contentWidthFor(path)).toBe(expected);
	});
});
