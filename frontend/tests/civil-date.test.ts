/// <reference types="node" />
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { formatCivilDate, shiftDays } from "../src/lib/civil-date";

describe("shiftDays", () => {
	it("往回推六天就是最近七天的起點", () => {
		// 區間兩端都含（app/api/routes/stats.py 的 get_range_stats：
		// 「使用者說『9/1 到 9/7』預期的是 7 天」），所以七天是 -6 不是 -7。
		expect(shiftDays("2026-09-21", -6)).toBe("2026-09-15");
	});

	it("delta 是 0 時原樣回傳", () => {
		expect(shiftDays("2026-09-21", 0)).toBe("2026-09-21");
	});

	it("跨月", () => {
		// 2026 不是閏年
		expect(shiftDays("2026-03-01", -1)).toBe("2026-02-28");
	});

	it("跨閏日", () => {
		expect(shiftDays("2024-03-01", -1)).toBe("2024-02-29");
	});

	it("跨年", () => {
		expect(shiftDays("2026-01-01", -1)).toBe("2025-12-31");
		expect(shiftDays("2026-12-31", 1)).toBe("2027-01-01");
	});

	it("格式不對就拋，不要靜默給出 Invalid Date", () => {
		// 這個函式的輸入永遠來自後端的 date 欄位。哪天那個形狀變了，
		// 要在這裡炸掉，而不是讓 "Invalid Date" 一路流進 query key。
		expect(() => shiftDays("2026-9-21", -1)).toThrow();
		expect(() => shiftDays("", -1)).toThrow();
	});
});

describe("formatCivilDate", () => {
	it("給人看的短日期", () => {
		expect(formatCivilDate("2026-09-05")).toBe("9/5");
		expect(formatCivilDate("2026-12-31")).toBe("12/31");
	});
});

describe("civil-date.ts 不得依賴本地時區", () => {
	it("整個模組沒有任何非 UTC 的 Date accessor", () => {
		// **這條測試是 shiftDays 正確性的真正守衛，行為測試不是。**
		//
		// 規格 §4.3 / §11.4：用本地 accessor 的錯誤實作，在 Asia/Taipei
		// （UTC+8）與 CI（UTC）都會給出正確答案——上面那六條行為測試
		// 全部照樣綠。它只在 UTC 以西壞掉：在 America/New_York，
		// new Date("2026-09-21") 是當地的 9/20 20:00，getDate() 回 20，
		// 整條計算差一天。
		//
		// 也就是說：時區把這個 bug 遮住了，而我們跑測試的兩個環境剛好
		// 都在被遮住的那一側。與其去架一個「在正確的時區下跑」的環境
		// （Node 在 Windows 上對執行期改 process.env.TZ 的支援不可靠），
		// 不如讓那個寫法根本進不了這個檔案。
		//
		// 手法跟 tests/decimal-containment.test.ts 一樣：文件擋不住
		// 重蹈覆轍，紅燈可以。
		const source = readFileSync("src/lib/civil-date.ts", "utf8");
		const forbidden = [
			"getDate",
			"setDate",
			"getMonth",
			"setMonth",
			"getFullYear",
			"setFullYear",
			"getHours",
			"getDay",
			"toLocaleDateString",
			"Date.now",
			"new Date()",
		];

		expect(forbidden.filter((name) => source.includes(name))).toEqual([]);
	});
});
