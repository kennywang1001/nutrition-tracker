import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TrendChart, type TrendDay } from "../src/components/TrendChart";

function macros(kcal: string) {
	return { kcal, protein_g: "0.00", fat_g: "0.00", carb_g: "0.00" };
}

function day(date: string, kcal: string, targetKcal: string | null): TrendDay {
	return {
		date,
		actual: macros(kcal),
		target:
			targetKcal === null
				? null
				: { kcal: targetKcal, protein_g: null, fat_g: null, carb_g: null },
		ratio: null,
	};
}

function bars() {
	return screen.getAllByTestId(/^trend-bar-/);
}

function heightOf(index: number) {
	const bar = bars()[index];
	if (bar === undefined) throw new Error(`沒有第 ${index} 根柱子`);
	return Number(bar.getAttribute("height"));
}

describe("TrendChart", () => {
	it("每一天都有一根柱子，沒吃東西的那天也有", () => {
		// 規格 §4.5（二）：actual 永遠有值，沒吃東西時是 "0.00"，
		// 不是把那天從陣列裡拿掉。後端的 DayTrendResponse docstring
		// 寫著「畫圖要連續」——少畫一根，圖上的七天就變成看起來像六天。
		render(
			<TrendChart
				days={[
					day("2026-09-15", "1800.00", "2000.00"),
					day("2026-09-16", "0.00", "2000.00"),
					day("2026-09-17", "1900.00", "2000.00"),
				]}
			/>,
		);

		expect(bars()).toHaveLength(3);
		expect(screen.getByTestId("trend-bar-2026-09-16")).toBeInTheDocument();
	});

	it("每根柱子都是一個可以按角色找到的 img", () => {
		// **這條補的是一個實作時真的被交易掉過的東西。**
		//
		// Biome 的 a11y/noInteractiveElementToNoninteractiveRole 會把
		// `<rect role="img">` 判成錯（它把 <rect> 當互動元素，那是誤判）。
		// 實作 Task 4 的當下，為了讓 `npm run lint` 過，`role` 被拿掉了 ——
		// **而當時全部 7 則測試照樣綠**，因為它們一律用 getByTestId。
		//
		// 實測過差別（`<svg>` 裡三根 rect，分別用三種寫法）：
		//
		//   <rect aria-label="…">                  → getAllByRole("img") 找不到
		//   <rect role="img" aria-label="…">       → 找到
		//   <rect><title>…</title></rect>          → jsdom 裡 getByTitle 也找不到
		//
		// `aria-label` 放在沒有語意角色的元素上，輔助技術多半忽略它；
		// SVG 的 `<rect>` 預設不對應任何 accessible role。所以拿掉 role
		// 等於把這張圖對螢幕閱讀器的可讀性整個拿掉。
		//
		// 這是 `alt=""` 那一課的同一個形狀：**測試查得到的東西，跟螢幕
		// 閱讀器拿得到的東西，必須真的是同一個。** 缺這條測試不是「role
		// 可以拿掉」的許可，缺這條測試才是缺陷。
		render(
			<TrendChart
				days={[
					day("2026-09-15", "1800.00", "2000.00"),
					day("2026-09-16", "1900.00", "2000.00"),
				]}
			/>,
		);

		expect(screen.getAllByRole("img")).toHaveLength(2);
		expect(
			screen.getByRole("img", { name: "9/15，1800 大卡，目標 2000 大卡" }),
		).toBeInTheDocument();
	});

	it("柱子的高度比例等於數值的比例", () => {
		// **規格 §4.6：這條是唯一真的碰到「那張圖」的斷言。**
		//
		// 下面那條 aria-label 的測試證明的是「我們把資料組成了字串」——
		// 把 height 的計算整個換成常數，它照樣綠。這條不會。
		//
		// 三天：1000 / 500 / 2000，最大值 2000。
		// 高度應該是 1:0.5:2 的比例。
		render(
			<TrendChart
				days={[
					day("2026-09-15", "1000.00", null),
					day("2026-09-16", "500.00", null),
					day("2026-09-17", "2000.00", null),
				]}
			/>,
		);

		expect(heightOf(0) / heightOf(1)).toBeCloseTo(2);
		expect(heightOf(2) / heightOf(0)).toBeCloseTo(2);
	});

	it("每根柱子的 aria-label 帶得出那天的數字", () => {
		render(<TrendChart days={[day("2026-09-15", "1800.00", "2000.00")]} />);

		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，1800 大卡，目標 2000 大卡",
		);
	});

	it("那天沒有目標時，label 說沒有目標，而且不畫目標線", () => {
		// 規格 §4.5（一）第一層 null：target 整個是 null，那一天沒有生效目標。
		render(<TrendChart days={[day("2026-09-15", "1800.00", null)]} />);

		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，1800 大卡，沒有目標",
		);
		expect(
			screen.queryByTestId("trend-target-2026-09-15"),
		).not.toBeInTheDocument();
	});

	it("有目標但熱量那一項沒設，也不畫目標線", () => {
		// 規格 §4.5（一）第二層 null：target 存在，但 target.kcal 是 null。
		//
		// **這跟上一條是不同的事實**，雖然畫面結果一樣。把兩層壓成
		// `target?.kcal ?? 0` 的話，這裡會畫出一條貼地的目標線，
		// 讀起來是「今天的目標是 0 大卡」。
		render(
			<TrendChart
				days={[
					{
						date: "2026-09-15",
						actual: macros("1800.00"),
						target: {
							kcal: null,
							protein_g: "150.00",
							fat_g: null,
							carb_g: null,
						},
						ratio: null,
					},
				]}
			/>,
		);

		expect(
			screen.queryByTestId("trend-target-2026-09-15"),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("trend-bar-2026-09-15")).toHaveAttribute(
			"aria-label",
			"9/15，1800 大卡，沒有目標",
		);
	});

	it("全部是 0 又沒有目標時不會炸，柱子高度都是 0", () => {
		// 規格 §4.5（三）：y 軸上限會是 0，不能拿它當除數。
		render(
			<TrendChart
				days={[
					day("2026-09-15", "0.00", null),
					day("2026-09-16", "0.00", null),
				]}
			/>,
		);

		expect(bars()).toHaveLength(2);
		expect(heightOf(0)).toBe(0);
		expect(heightOf(1)).toBe(0);
	});

	it("目標比實際高時，目標線在柱子上面", () => {
		// SVG 的 y 軸往下增加，所以「比較高」是 y 比較小。
		render(<TrendChart days={[day("2026-09-15", "1000.00", "2000.00")]} />);

		const bar = screen.getByTestId("trend-bar-2026-09-15");
		const line = screen.getByTestId("trend-target-2026-09-15");

		expect(Number(line.getAttribute("y1"))).toBeLessThan(
			Number(bar.getAttribute("y")),
		);
	});
});
