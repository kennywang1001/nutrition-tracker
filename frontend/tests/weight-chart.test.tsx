import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
	PAD_X,
	PLOT_LEFT,
	VIEW_HEIGHT,
	VIEW_WIDTH,
	WeightChart,
} from "../src/components/WeightChart";
import { movingAverage } from "../src/lib/weights";

const entries = [
	{ date: "2026-10-01", weight_kg: "80" },
	{ date: "2026-10-08", weight_kg: "78" },
	{ date: "2026-10-14", weight_kg: "79" },
];

function chart(props: Partial<Parameters<typeof WeightChart>[0]> = {}) {
	return render(
		<WeightChart
			entries={entries}
			average={movingAverage(entries)}
			start="2026-10-01"
			end="2026-10-14"
			today="2026-10-14"
			targetKg={null}
			{...props}
		/>,
	);
}

function attr(testId: string, name: string): number {
	return Number(screen.getByTestId(testId).getAttribute(name));
}

/** `points="x1,y1 x2,y2 …"` → [[x1, y1], …]。 */
function points(testId: string): number[][] {
	return (screen.getByTestId(testId).getAttribute("points") ?? "")
		.split(" ")
		.map((pair) => pair.split(",").map(Number));
}

const RIGHT = VIEW_WIDTH - PAD_X;

describe("WeightChart", () => {
	it("每筆一個點，可以按角色找到，名稱是日期與體重", () => {
		chart();

		const dots = screen.getAllByRole("img");
		expect(dots).toHaveLength(3);
		expect(dots.map((dot) => dot.getAttribute("aria-label"))).toEqual([
			"10/1，80 公斤",
			"10/8，78 公斤",
			"10/14，79 公斤",
		]);
	});

	it("x 照日期（不是照第幾筆）、y 照體重（重的在上面）", () => {
		chart();

		// 第一點在左邊界、最後一點在右邊界；10/08 在 7/13 的位置（照索引的話是 1/2）。
		expect(attr("weight-point-2026-10-01", "cx")).toBeCloseTo(PLOT_LEFT);
		expect(attr("weight-point-2026-10-14", "cx")).toBeCloseTo(RIGHT);
		expect(attr("weight-point-2026-10-08", "cx")).toBeCloseTo(
			PLOT_LEFT + (7 / 13) * (RIGHT - PLOT_LEFT),
		);
		// y 軸是 77–81（各往外留 1 公斤、取整）：80 在 3/4 高、78 在 1/4 高。
		expect(attr("weight-point-2026-10-01", "cy")).toBeCloseTo(
			VIEW_HEIGHT * (1 - 3 / 4),
		);
		expect(attr("weight-point-2026-10-08", "cy")).toBeCloseTo(
			VIEW_HEIGHT * (1 - 1 / 4),
		);
	});

	it("平均線：每個點一組座標，10/14 的值是 10/08–10/14 的平均 78.5（不是 79）", () => {
		chart();

		const line = points("weight-average");
		expect(line).toHaveLength(3);
		expect(line[2]?.[0]).toBeCloseTo(RIGHT);
		expect(line[2]?.[1]).toBeCloseTo(VIEW_HEIGHT * (1 - 1.5 / 4));
		expect(screen.getByTestId("weight-average")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});

	it("目標線：y 在目標的位置，而且 y 軸把目標包進去；沒有目標就沒有線", () => {
		const { unmount } = chart({ targetKg: "72" });

		// 71–81：72 在 1/10 高。
		expect(attr("weight-target", "y1")).toBeCloseTo(VIEW_HEIGHT * (1 - 1 / 10));
		expect(attr("weight-point-2026-10-01", "cy")).toBeCloseTo(
			VIEW_HEIGHT * (1 - 9 / 10),
		);
		unmount();

		chart();
		expect(screen.queryByTestId("weight-target")).not.toBeInTheDocument();
	});

	it("y 軸也把範圍外紀錄拉進來的平均包進去，平均線不會畫出圖外", () => {
		// 只畫 10/14 一點（78），但它的平均用到範圍外的 10/10（82）＝80。
		const all = [
			{ date: "2026-10-10", weight_kg: "82" },
			{ date: "2026-10-14", weight_kg: "78" },
		];
		chart({
			entries: all.slice(1),
			average: movingAverage(all),
			start: "2026-10-12",
		});

		// 77–81：平均 80 在 3/4 高、點 78 在 1/4 高。
		expect(points("weight-average")[0]?.[1]).toBeCloseTo(
			VIEW_HEIGHT * (1 - 3 / 4),
		);
		expect(attr("weight-point-2026-10-14", "cy")).toBeCloseTo(
			VIEW_HEIGHT * (1 - 1 / 4),
		);
	});

	it("只有一筆、起點就是今天：不除以零，點畫在左邊界", () => {
		const one = [{ date: "2026-10-14", weight_kg: "70" }];
		chart({ entries: one, average: one, start: "2026-10-14" });

		expect(attr("weight-point-2026-10-14", "cx")).toBeCloseTo(PLOT_LEFT);
		expect(attr("weight-point-2026-10-14", "cy")).toBeCloseTo(VIEW_HEIGHT / 2);
	});

	it("每天的紀錄連成實線：照日期由舊到新，每一組座標就是那一點的 cx／cy", () => {
		chart();

		const line = points("weight-line");
		expect(line).toHaveLength(3);
		entries.forEach((entry, i) => {
			const testId = `weight-point-${entry.date}`;
			expect(line[i]?.[0]).toBeCloseTo(attr(testId, "cx"));
			expect(line[i]?.[1]).toBeCloseTo(attr(testId, "cy"));
		});
	});

	it("沒記的日子照樣連起來（x 照日期）：一條線，不斷開", () => {
		chart();

		expect(screen.getAllByTestId("weight-line")).toHaveLength(1);
		// 10/01 → 10/08 中間空了 6 天：第二組在 7/13 的位置（照索引的話是 1/2）。
		expect(points("weight-line")[1]?.[0]).toBeCloseTo(
			PLOT_LEFT + (7 / 13) * (RIGHT - PLOT_LEFT),
		);
	});

	it("只有一筆：沒有線，只有那一點", () => {
		const one = [{ date: "2026-10-14", weight_kg: "70" }];
		chart({ entries: one, average: movingAverage(one), start: "2026-10-14" });

		expect(screen.queryByTestId("weight-line")).not.toBeInTheDocument();
		expect(screen.getByTestId("weight-point-2026-10-14")).toBeInTheDocument();
	});

	it("線與平均都是裝飾；畫的順序是 平均 → 每天的線 → 點（點在最上面）", () => {
		chart();

		const daily = screen.getByTestId("weight-line");
		const average = screen.getByTestId("weight-average");
		expect(daily).toHaveAttribute("aria-hidden", "true");
		expect(average).toHaveAttribute("aria-hidden", "true");
		// 全域 class（index.css）：實線與虛線的樣子在那裡。
		expect(daily).toHaveClass("weight-line");
		expect(average).toHaveClass("weight-average");
		const firstPoint = screen.getByTestId("weight-point-2026-10-01");
		expect(
			average.compareDocumentPosition(daily) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			daily.compareDocumentPosition(firstPoint) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("圖的名稱是「體重」；刻度與日期是裝飾", () => {
		chart();

		expect(screen.getByRole("group", { name: "體重" })).toBeInTheDocument();
		expect(screen.getByTestId("weight-axis-hi")).toHaveTextContent("81");
		expect(screen.getByTestId("weight-axis-lo")).toHaveTextContent("77");
		expect(screen.getByTestId("weight-axis-hi")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		expect(screen.getByTestId("weight-date-start")).toHaveTextContent("10/1");
		expect(screen.getByTestId("weight-date-end")).toHaveTextContent("今天");
	});
});
