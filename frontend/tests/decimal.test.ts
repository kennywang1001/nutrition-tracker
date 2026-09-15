import { describe, expect, it } from "vitest";
import { formatMacro, ratioOf, sumMacros } from "../src/lib/decimal";

describe("formatMacro", () => {
	it("保留後端給的小數位", () => {
		expect(formatMacro("180.50")).toBe("180.5");
	});

	it("不經過浮點數", () => {
		// 0.1 + 0.2 在 IEEE 754 是 0.30000000000000004。
		// 這條測試的價值不在這個特定的值，而在於它會因為任何
		// 「改用 parseFloat」的實作而變紅。
		expect(sumMacros(["0.1", "0.2"])).toBe("0.3");
	});

	it("大數值不會失去精度", () => {
		expect(sumMacros(["9007199254740993", "1"])).toBe("9007199254740994");
	});
});

describe("ratioOf", () => {
	it("算出比例", () => {
		expect(ratioOf("90", "100")).toBe(0.9);
	});

	it("目標是 null 時回 null，不是 0", () => {
		// 規格 §5.7：「沒有標準可比」跟「0%」是兩件不同的事。
		// 回 0 的話 UI 會畫出一條空的進度條，看起來像「完全沒吃」。
		expect(ratioOf("90", null)).toBeNull();
	});

	it("目標是 0 時回 null，不是 Infinity", () => {
		// 後端在 target 為 0 時已經回 ratio: null（除以 0 沒有意義），
		// 但前端自己算的時候也要守同一條規則——否則 UI 會出現 Infinity%。
		expect(ratioOf("90", "0")).toBeNull();
	});

	it("實際值是 0 時回 0，不是 null", () => {
		// 這條跟上面兩條是一對：「還沒吃」是一個真實的 0，
		// 不是「沒有標準可比」。混為一談的話，今天還沒吃東西的畫面
		// 會顯示成「沒有設定目標」。
		expect(ratioOf("0", "100")).toBe(0);
	});
});
