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
