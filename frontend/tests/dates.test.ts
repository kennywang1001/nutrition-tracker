import { describe, expect, it } from "vitest";
import { formatDateTime } from "../src/lib/dates";

describe("formatDateTime", () => {
	it("給人看的日期與時間，不是 ISO 原文", () => {
		const text = formatDateTime("2026-09-01T00:00:00Z");

		expect(text).toMatch(/2026/);
		// 不是原始字串：沒有 T 分隔、沒有 Z、沒有秒以下的位數。
		expect(text).not.toMatch(/T\d|Z$|\.\d{3}/);
	});

	it("有時與分", () => {
		expect(formatDateTime("2026-09-01T00:00:00Z")).toMatch(/\d{1,2}:\d{2}/);
	});
});
