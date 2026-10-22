import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { WeightSparkline } from "../src/components/WeightSparkline";

const e = (date: string, weight_kg: string) => ({ date, weight_kg });

/** `points="x1,y1 x2,y2 …"` → [[x1, y1], …]。 */
function pairs(): number[][] {
	return (
		screen.getByTestId("weight-sparkline-line").getAttribute("points") ?? ""
	)
		.split(" ")
		.map((pair) => pair.split(",").map(Number));
}

describe("WeightSparkline（首頁改版規格 D22）", () => {
	it("兩筆：一條線、第一筆在左、最後一筆在右、重的在上面；整張是裝飾", () => {
		const { container } = render(
			<WeightSparkline
				today="2026-10-30"
				entries={[e("2026-10-27", "80"), e("2026-10-30", "79.4")]}
			/>,
		);
		expect(container.querySelector("svg")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(screen.getByTestId("weight-sparkline")).toBeInTheDocument();
		// y 範圍 78–81（各往外 0.5、取整）；畫圖區 2–30（上下各留 2）。
		const [first, last] = pairs();
		expect(first?.[0]).toBeCloseTo(2);
		expect(last?.[0]).toBeCloseTo(98);
		expect(first?.[1]).toBeCloseTo(2 + 28 * (1 - 2 / 3));
		expect(last?.[1]).toBeCloseTo(2 + 28 * (1 - 1.4 / 3));
	});

	it("x 照日期（不是照第幾筆）：中間那一筆在天數的比例上", () => {
		render(
			<WeightSparkline
				today="2026-10-30"
				entries={[
					e("2026-10-20", "80"),
					e("2026-10-28", "79"),
					e("2026-10-30", "79"),
				]}
			/>,
		);
		// 10/20 → 10/30 共 10 天，10/28 在 8/10（照索引的話是 1/2）。
		expect(pairs()[1]?.[0]).toBeCloseTo(2 + (8 / 10) * 96);
	});

	it("只畫最近 30 天（今天 − 29 起）：更早的不算", () => {
		render(
			<WeightSparkline
				today="2026-10-30"
				entries={[
					e("2026-09-30", "90"),
					e("2026-10-01", "80"),
					e("2026-10-30", "79"),
				]}
			/>,
		);
		expect(pairs()).toHaveLength(2);
	});

	it("最近 30 天只有 0 或 1 筆：不畫（只有字）", () => {
		const { container, rerender } = render(
			<WeightSparkline today="2026-10-30" entries={[]} />,
		);
		expect(container).toBeEmptyDOMElement();
		rerender(
			<WeightSparkline
				today="2026-10-30"
				entries={[e("2026-09-01", "80"), e("2026-10-30", "79")]}
			/>,
		);
		expect(container).toBeEmptyDOMElement();
	});
});
