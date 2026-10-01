import { describe, expect, it } from "vitest";
import {
	formatMacro,
	formatMoney,
	ratioOf,
	sumMacros,
} from "../src/lib/decimal";

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

describe("formatMoney", () => {
	it("保留兩位小數——錢的 250.50 不能顯示成 250.5", () => {
		// 這是 formatMacro 不能拿來用的原因：它走 .toString()，
		// 而 Decimal 會把尾數的 0 正規化掉（已用 node 實測）。
		// 營養素顯示成 250.5 沒問題，金額顯示成 250.5 是錯的。
		expect(formatMoney("250.50")).toBe("250.50");
	});

	it("整數也補到兩位", () => {
		expect(formatMoney("250")).toBe("250.00");
	});

	it("零是 0.00，不是 0", () => {
		// 後端空月份回的就是 "0.00"（app/api/routes/expenses.py 的 _ZERO）。
		expect(formatMoney("0.00")).toBe("0.00");
		expect(formatMoney("0")).toBe("0.00");
	});

	it("不因浮點誤差失真", () => {
		// 0.1 + 0.2 的經典問題：這個函式只做格式化不做運算，
		// 但它必須忠實呈現後端送來的字串，不能中途變成 number。
		expect(formatMoney("0.30")).toBe("0.30");
		expect(formatMoney("99999999.99")).toBe("99999999.99");
	});
});

describe("formatMacro 與 formatMoney 的差別（這就是不能共用的證據）", () => {
	it("同一個輸入，兩者輸出不同", () => {
		expect(formatMacro("250.50")).toBe("250.5");
		expect(formatMoney("250.50")).toBe("250.50");
	});
});
