import { describe, expect, it } from "vitest";
import {
	averageOf,
	formatMacro,
	formatMoney,
	isPlainPositiveDecimal,
	isPositiveAmount,
	perServingToPer100,
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

describe("isPositiveAmount", () => {
	it.each(["", "0", "0.", "0.00", "abc", "-1"])(
		"%s 不是正數（也不丟例外）",
		(value) => {
			// 鍵盤打到一半的字串是常態，不是錯誤——✓ 按鈕每次重繪都會問一次。
			expect(isPositiveAmount(value)).toBe(false);
		},
	);

	it.each(["0.01", "5.", "12345678.99"])("%s 是正數", (value) => {
		expect(isPositiveAmount(value)).toBe(true);
	});
});

describe("perServingToPer100", () => {
	it("每份換算成每 100，四捨五入到小數兩位", () => {
		// 包裝標示：每一份量 45 公克，熱量 210 大卡 → 每 100 公克 466.666…
		expect(perServingToPer100("210", "45")).toBe("466.67");
	});

	it("剛好 100 的份量不變", () => {
		expect(perServingToPer100("12.5", "100")).toBe("12.50");
	});

	it("四捨五入是 half-up，不是無條件捨去", () => {
		// 2 / 3 × 100 = 66.666… → 66.67（無條件捨去會是 66.66）
		expect(perServingToPer100("2", "3")).toBe("66.67");
	});

	it("前後空白會先去掉", () => {
		expect(perServingToPer100(" 210 ", " 45 ")).toBe("466.67");
	});

	it("「4.」與「.5」是合法的寫法", () => {
		expect(perServingToPer100("4.", "100")).toBe("4.00");
		expect(perServingToPer100(".5", "100")).toBe("0.50");
	});

	it("剛好在中間的值進位（half-up，不是 half-even）", () => {
		expect(perServingToPer100("1.005", "100")).toBe("1.01");
	});

	it("0 也是合法的營養素值", () => {
		expect(perServingToPer100("0", "45")).toBe("0.00");
	});

	it.each([
		["210", "0"],
		["210", ""],
		["210", "-5"],
		["210", "abc"],
		["", "45"],
		["abc", "45"],
		["-1", "45"],
		["1e3", "45"],
		["0x10", "45"],
		["+5", "45"],
		["Infinity", "45"],
		["NaN", "45"],
		["210", "1e3"],
		["210", "Infinity"],
	])("(%s, %s) 不能換算時回 null，不丟例外、不除以零", (value, grams) => {
		expect(perServingToPer100(value, grams)).toBeNull();
	});
});

describe("isPlainPositiveDecimal", () => {
	it.each([
		[" 45 ", true],
		["12.5", true],
		["4.", true],
		[".5", true],
		["0", false],
		["0.0", false],
		["1e3", false],
		["abc", false],
		["", false],
		["-1", false],
		["+5", false],
	])("%j → %s", (value, expected) => {
		expect(isPlainPositiveDecimal(value)).toBe(expected);
	});
});

describe("averageOf", () => {
	it("小數的平均不經過浮點數", () => {
		// 0.1 + 0.2 用浮點是 0.30000000000000004，除以 2 會變成
		// 0.15000000000000002；Decimal 算出來是剛好的 0.15。
		expect(averageOf(["0.1", "0.2"])).toBe("0.15");
	});

	it("兩組不同的資料算出各自的平均（寫死的數字過不了）", () => {
		expect(averageOf(["1800.00", "2100.00", "1500.00"])).toBe("1800");
		expect(averageOf(["60.5", "80"])).toBe("70.25");
	});

	it("空陣列回 null，不是 0——沒有資料就沒有平均", () => {
		expect(averageOf([])).toBeNull();
	});

	it("除不盡時四捨五入到小數兩位（half-up），不是印出 20 位小數", () => {
		// 後端的營養素都是兩位小數。不四捨五入的話，三天平均 1000、1000、1001
		// 會顯示成「1000.3333333333333333 kcal」——實作摘要時的突變測試
		// 真的印出過 942.85714285714285714。
		expect(averageOf(["1000", "1000", "1001"])).toBe("1000.33");
		expect(averageOf(["0.01", "0.02"])).toBe("0.02");
		expect(averageOf(["2", "2", "1.99"])).toBe("2");
	});
});
