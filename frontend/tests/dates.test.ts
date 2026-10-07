import { describe, expect, it } from "vitest";
import {
	formatDateTime,
	fromLocalDateTime,
	localDateTime,
} from "../src/lib/dates";

/** 釘住 formatDateTime 的格式：瀏覽器語系與時區、年月日加時分。
 *  原本只驗「有 2026、有 HH:MM、不是 ISO 原文」——`new Date(ts).toString()`
 *  （「Tue Sep 01 2026 08:00:00 GMT+0800 (…)」）也全部滿足。 */
const OPTIONS: Intl.DateTimeFormatOptions = {
	year: "numeric",
	month: "numeric",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
};

// 秒數故意不是 0：格式裡混進秒的話，「37」會出現在輸出裡。
const TIMESTAMP = "2026-09-01T00:00:37Z";

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

	it("等於瀏覽器語系、時區下只帶年月日與時分的 toLocaleString", () => {
		const expected = new Date(TIMESTAMP).toLocaleString(undefined, OPTIONS);

		expect(formatDateTime(TIMESTAMP)).toBe(expected);
		// epoch 毫秒數走同一條路。
		expect(formatDateTime(Date.parse(TIMESTAMP))).toBe(expected);
	});

	it("沒有秒、沒有 GMT 時區字樣", () => {
		const text = formatDateTime(TIMESTAMP);

		expect(text).not.toMatch(/\d{1,2}:\d{2}:\d{2}/);
		expect(text).not.toMatch(/37/);
		expect(text).not.toMatch(/GMT/);
	});
});

// 下面的期望值**只在台北時區對**（測試時區由 vite.config.ts 的 test.env.TZ
// 釘住，tests/timezone-pin.test.ts 守著）：UTC 的 04:30 是台北的 12:30。
// 用 getUTC* 寫錯的話這裡會拿到 04:30。
describe("localDateTime", () => {
	it("一個時刻在這台裝置時區的日期與時間（到分鐘）", () => {
		expect(localDateTime("2026-10-04T04:30:45Z")).toEqual({
			date: "2026-10-04",
			time: "12:30",
		});
	});

	it("UTC 還是前一天、台北已經過午夜：日期是台北的那一天", () => {
		expect(localDateTime("2026-10-03T16:05:00Z")).toEqual({
			date: "2026-10-04",
			time: "00:05",
		});
	});

	it("個位數補零", () => {
		expect(localDateTime("2026-01-04T23:03:00Z")).toEqual({
			date: "2026-01-05",
			time: "07:03",
		});
	});
});

// 同樣只在台北時區對（見上）。
describe("fromLocalDateTime", () => {
	it("裝置時區的日期與時間組成一個時刻", () => {
		expect(fromLocalDateTime("2026-10-04", "12:30")?.toISOString()).toBe(
			"2026-10-04T04:30:00.000Z",
		);
	});

	it("台北的凌晨是 UTC 的前一天", () => {
		expect(fromLocalDateTime("2026-10-04", "00:05")?.toISOString()).toBe(
			"2026-10-03T16:05:00.000Z",
		);
	});

	it("跟 localDateTime 互為反函數（到分鐘）", () => {
		const back = fromLocalDateTime("2026-01-05", "07:03");
		expect(back).not.toBeNull();
		expect(localDateTime(back?.toISOString() ?? "")).toEqual({
			date: "2026-01-05",
			time: "07:03",
		});
	});

	it("兩位數以下的年份照字面，不被當成 19xx", () => {
		// new Date(2, 9, 4) 會是 1902 年。
		expect(fromLocalDateTime("0002-10-04", "12:30")?.getFullYear()).toBe(2);
	});

	it.each([
		["", "12:30"],
		["2026-10-04", ""],
		["2026-02-30", "12:30"],
		["2026-13-01", "12:30"],
		["2026-00-10", "12:30"],
		["2026-10-04", "24:00"],
		["2026-10-04", "12:60"],
		["2026/10/04", "12:30"],
		["2026-10-04", "12:30:00"],
		["2026-10-4", "12:30"],
		["2026-10-04", "1230"],
	])("不是有效的日期與時間（%j %j）回 null", (date, time) => {
		expect(fromLocalDateTime(date, time)).toBeNull();
	});
});
