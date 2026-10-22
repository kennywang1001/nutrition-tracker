import { describe, expect, it } from "vitest";
import {
	averageOf,
	checkRangeInput,
	checkTargetInput,
	differenceOf,
	formatMacro,
	formatMoney,
	isPlainPositiveDecimal,
	isPositiveAmount,
	isZero,
	kcalBalance,
	paddedExtent,
	percentOf,
	perServingToPer100,
	positionIn,
	ratioOf,
	roundForDisplay,
	sumMacros,
	toWholeNumber,
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

describe("checkTargetInput（每日目標的一格，帳號設定規格 §5.2）", () => {
	it.each([
		["", null],
		["   ", null],
		["1800", null],
		["12.5", null],
		[".5", null],
		["4.", null],
		["20000", null],
		["0.01", null],
		["0", "not-positive-decimal"],
		["0.00", "not-positive-decimal"],
		["-1", "not-positive-decimal"],
		["1e3", "not-positive-decimal"],
		["abc", "not-positive-decimal"],
		["12.345", "too-precise"],
		["20000.01", "too-large"],
	] as const)("%j → %s", (value, expected) => {
		expect(checkTargetInput(value, "20000")).toBe(expected);
	});
});

describe("differenceOf", () => {
	it("字串進字串出，正負號都留著", () => {
		expect(differenceOf("78.50", "80.00")).toBe("-1.5");
		expect(differenceOf("80.1", "80")).toBe("0.1");
		expect(differenceOf("80", "80.00")).toBe("0");
	});
});

describe("paddedExtent", () => {
	it("最小值往下、最大值往上各留 pad，再取整", () => {
		expect(paddedExtent(["72.4", "70.2", "71"], "1")).toEqual({
			lo: "69",
			hi: "74",
		});
	});
	it("全部一樣也有範圍", () => {
		expect(paddedExtent(["70"], "1")).toEqual({ lo: "69", hi: "71" });
	});
	it("空陣列是 null", () => {
		expect(paddedExtent([], "1")).toBeNull();
	});
});

describe("positionIn", () => {
	it("lo 是 0、hi 是 1、中間照比例", () => {
		expect(positionIn("69", "69", "74")).toBe(0);
		expect(positionIn("74", "69", "74")).toBe(1);
		expect(positionIn("71.5", "69", "74")).toBe(0.5);
	});
	it("範圍是 0 時回 0.5，不除以零", () => {
		expect(positionIn("70", "70", "70")).toBe(0.5);
	});
});

describe("checkRangeInput", () => {
	const weight = { min: "25", max: "350", places: 2 } as const;
	it.each([
		["", "empty"],
		["abc", "not-decimal"],
		["1e2", "not-decimal"],
		["-70", "not-decimal"],
		["70.123", "too-precise"],
		["24.99", "out-of-range"],
		["350.01", "out-of-range"],
		["25", null],
		[" 350 ", null],
		["72.4", null],
	] as const)("%j → %j", (raw, problem) => {
		expect(checkRangeInput(raw, weight)).toBe(problem);
	});
	it("places 0 只收整數", () => {
		expect(
			checkRangeInput("1990.5", { min: "1900", max: "2100", places: 0 }),
		).toBe("too-precise");
		expect(
			checkRangeInput("1990", { min: "1900", max: "2100", places: 0 }),
		).toBeNull();
	});
});

describe("isZero", () => {
	it.each([
		["0.00", true],
		["0", true],
		["-0", true],
		["343.00", false],
		["0.01", false],
	] as const)("%j → %j", (value, zero) => {
		expect(isZero(value)).toBe(zero);
	});
});

describe("toWholeNumber", () => {
	it.each([
		["30", 30],
		[" 600 ", 600],
		["1", 1],
	] as const)("%j → %j", (value, number) => {
		expect(toWholeNumber(value)).toBe(number);
	});
});

describe("percentOf（後端算好的比例 → 百分比；營養素配餐規格 D13）", () => {
	it.each([
		["1.05", "105%"],
		["0.985", "99%"],
		["0.984", "98%"],
		["0", "0%"],
		["0.00", "0%"],
		["2", "200%"],
	] as const)("%j → %j", (ratio, text) => {
		expect(percentOf(ratio)).toBe(text);
	});
});

describe("roundForDisplay（只給畫面看的四捨五入；營養素配餐 /planner）", () => {
	it.each([
		// half-up，不是 half-even：192.5 → 193（half-even 會是 192）、49.25 → 49.3（half-even 會是 49.2）。
		["192.50", 0, "193"],
		["732.50", 0, "733"],
		["236.25", 0, "236"],
		["824.25", 0, "824"],
		["540.00", 0, "540"],
		["49.25", 1, "49.3"],
		["60.98", 1, "61"],
		["4.13", 1, "4.1"],
		["120.00", 1, "120"],
		["0.04", 1, "0"],
		["12", 1, "12"],
	] as const)("%j 到 %i 位 → %j", (value, places, text) => {
		expect(roundForDisplay(value, places)).toBe(text);
	});
});

describe("kcalBalance（首頁改版規格 D3）", () => {
	it.each([
		["2343.00", "1500.00", false, "843"],
		["2343", "1523.4", false, "820"],
		// 819.5 → 820（half-up）
		["2343", "1523.5", false, "820"],
		// −32.5 → −33（遠離 0）：「超過 33」
		["700", "732.5", true, "33"],
		// −0.4 → −0：還能吃 0，不是「超過 0」
		["2000", "2000.4", false, "0"],
		["2000", "2000.5", true, "1"],
		["2000", "2000", false, "0"],
		["2343.00", "2500.00", true, "157"],
	])("額度 %s、實際 %s → over %s、%s", (budget, actual, over, amount) => {
		expect(kcalBalance(budget, actual)).toEqual({ over, amount });
	});
});
