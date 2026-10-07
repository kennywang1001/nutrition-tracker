import { describe, expect, it } from "vitest";
import { formatDateTime, localDateTime } from "../src/lib/dates";

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

describe("localDateTime", () => {
	it("一個時刻在這台裝置時區的日期與時間（到分鐘）", () => {
		// 用本地時區建構，結果跟測試機的時區無關。
		const instant = new Date(2026, 9, 4, 12, 30, 45).toISOString();

		expect(localDateTime(instant)).toEqual({
			date: "2026-10-04",
			time: "12:30",
		});
	});

	it("個位數補零", () => {
		const instant = new Date(2026, 0, 5, 7, 3).toISOString();

		expect(localDateTime(instant)).toEqual({
			date: "2026-01-05",
			time: "07:03",
		});
	});
});
