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

/** 把 TS 原始碼裡的註解去掉，只留真正會執行的部分。
 *
 *  **為什麼掃描前要做這一步：** 不做的話，`civil-date.ts` 就沒辦法在自己的
 *  docstring 裡寫出它禁止的是什麼 —— 而那正是它最該講清楚的一件事。
 *  第一版就踩到了：計畫給的實作原文在說明段落裡寫了 `getDate()` 當例句，
 *  結果實作照抄就讓掃描紅了，而程式碼本身完全正確。
 *
 *  那個版本的守衛太鈍：**它分不出「程式碼在呼叫這個東西」與「註解在解釋
 *  不要呼叫這個東西」。** 於是模組被迫用迂迴的說法描述自己的規則，
 *  而同一個名字寫在測試檔的註解裡卻完全沒事（掃描只讀 `src/`）——
 *  能講的人不需要講，該講的人不能講。
 *
 *  **這不是通用的 TS parser。** 它假設原始碼裡沒有內含 `//` 的字串字面值
 *  （`civil-date.ts` 目前沒有，它只有兩個純函式）。哪天有了，這個函式會把
 *  那一行後半截誤當成註解丟掉 —— 而那個方向是**少看到東西**，會讓下面的
 *  守衛變鬆變成假綠燈，所以下面第一條測試專門把它釘住。 */
function stripComments(source: string): string {
	return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
}

describe("civil-date.ts 不得依賴本地時區", () => {
	const code = stripComments(readFileSync("src/lib/civil-date.ts", "utf8"));

	it("去掉註解之後，Date.UTC 與兩個函式都還在掃描的視野裡", () => {
		// **這條做兩件事，名字兩件都涵蓋了：**
		//
		// 1. 釘住 `stripComments` 不會吃太多。它吃太多的話，下面那條
		//    「沒有非 UTC accessor」會因為**什麼都沒看到**而變綠 ——
		//    一個典型的說謊綠燈：守衛還在，但它守的東西已經被自己的前處理
		//    清空了。實測過：把 `stripComments` 改成 `return ""`，
		//    那條測試**依然綠**，只有這裡跟下一條紅。
		// 2. 正面斷言這個模組真的在用 `Date.UTC` —— 下面那條是「沒有壞東西」，
		//    這條是「好東西在」。兩者都需要：只有前者的話，一個把整個
		//    `shiftDays` 刪成 `return isoDate` 的實作也會通過。
		expect(code).toContain("Date.UTC");
		expect(code).toContain("toISOString");
		expect(code).toContain("export function shiftDays");
		expect(code).toContain("export function formatCivilDate");
	});

	it("掃描看的是程式碼，不是註解", () => {
		// 這條把上面那條的鑑別力釘在對的位置：禁用的名字寫在註解裡必須合法
		// （模組要能講出自己禁止什麼），寫在程式碼裡才該紅。
		expect(stripComments("// d.getDate()\nconst a = 1;")).not.toContain(
			"getDate",
		);
		expect(stripComments("/* d.setDate() */\nconst a = 1;")).not.toContain(
			"setDate",
		);
		expect(stripComments("d.getDate();")).toContain("getDate");
	});

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

		expect(forbidden.filter((name) => code.includes(name))).toEqual([]);
	});
});
