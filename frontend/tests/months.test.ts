/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatYearMonth, isYearMonth, shiftMonth } from "../src/lib/months";

describe("isYearMonth", () => {
	it.each(["2026-10", "1900-01", "2099-12", "2000-02"])(
		"%s 是月份",
		(value) => {
			expect(isYearMonth(value)).toBe(true);
		},
	);

	// 後端的 YEAR_MONTH_PATTERN 不收的，這裡也不收——送出去會是 422。
	it.each([
		"",
		"2026-13",
		"2026-00",
		"2026-1",
		"2026-010",
		"0000-01",
		"1899-12",
		"2100-01",
		" 2026-10",
		"2026-10 ",
		"2026-10-01",
		"2026/10",
		"abcd-ef",
	])("%j 不是月份", (value) => {
		expect(isYearMonth(value)).toBe(false);
	});
});

describe("shiftMonth", () => {
	it("同一年裡往前、往後", () => {
		expect(shiftMonth("2026-10", -1)).toBe("2026-09");
		expect(shiftMonth("2026-09", 1)).toBe("2026-10");
	});

	it("跨年：1 月的上個月是去年 12 月，12 月的下個月是明年 1 月", () => {
		// 一年只有這兩個月會寫錯（後端的 month_bounds 也是在 12 月進位）。
		expect(shiftMonth("2026-01", -1)).toBe("2025-12");
		expect(shiftMonth("2026-12", 1)).toBe("2027-01");
	});

	it("一次推好幾個月", () => {
		expect(shiftMonth("2026-03", -14)).toBe("2025-01");
		expect(shiftMonth("2026-03", 0)).toBe("2026-03");
	});

	it("推出後端收的範圍回 null", () => {
		expect(shiftMonth("1900-01", -1)).toBeNull();
		expect(shiftMonth("2099-12", 1)).toBeNull();
	});

	it("格式不對就拋", () => {
		expect(() => shiftMonth("2026-9", -1)).toThrow();
		expect(() => shiftMonth("", 1)).toThrow();
	});
});

describe("formatYearMonth", () => {
	it("給人看的月份，月份不補零", () => {
		expect(formatYearMonth("2026-09")).toBe("2026年9月");
		expect(formatYearMonth("2026-10")).toBe("2026年10月");
	});

	it("格式不對就拋", () => {
		expect(() => formatYearMonth("2026-13")).toThrow();
	});
});

describe("lib/months.ts 不問現在幾點", () => {
	it("原始碼（去掉註解之後）沒有用到 Date", () => {
		// 「這個月是哪個月」只有後端知道。這個模組哪天長出 `new Date()`，
		// 在台北與 CI（UTC）大部分時候都是對的，只在月初、月底那幾個小時錯
		// ——行為測試擋不住，原始碼掃描擋得住（同 tests/civil-date.test.ts）。
		const code = readFileSync("src/lib/months.ts", "utf8")
			.replace(/\/\*[\s\S]*?\*\//g, "")
			.replace(/\/\/.*$/gm, "");
		expect(code).toContain("export function shiftMonth"); // 真的讀到程式碼了
		expect(code).not.toMatch(/\bDate\b/);
	});
});
