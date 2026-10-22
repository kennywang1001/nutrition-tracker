import { render, screen } from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { DailyStats } from "../src/api/stats";
import { BudgetSummary } from "../src/components/BudgetSummary";

/** 規格 §3.3 那一組：目標 2000／120／不設／250、運動 343、加回開著、吃了 1500。 */
const BASE = {
	date: "2026-10-22",
	actual: {
		kcal: "1500.00",
		protein_g: "60.00",
		fat_g: "45.00",
		carb_g: "180.00",
	},
	target: {
		kcal: "2000.00",
		protein_g: "120.00",
		fat_g: null,
		carb_g: "250.00",
	},
	ratio: { kcal: "0.75", protein_g: "0.50", fat_g: null, carb_g: "0.72" },
	breakdown: {
		food: {
			kcal: "1500.00",
			protein_g: "60.00",
			fat_g: "45.00",
			carb_g: "180.00",
		},
		supplement: { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" },
	},
	exercise_kcal: "343.00",
	exercise_adds_to_budget: true,
	kcal_budget: "2343.00",
};

function stats(overrides: Record<string, unknown> = {}): DailyStats {
	return { ...BASE, ...overrides } as DailyStats;
}

function renderSummary(value: DailyStats) {
	return render(
		<MemoryRouter>
			<BudgetSummary stats={value} />
		</MemoryRouter>,
	);
}

describe("BudgetSummary（首頁改版規格 §3.2）", () => {
	it("一般：還能吃 843、已吃・預算（含運動）、弧照額度的比例、三大營養素", () => {
		const { container } = renderSummary(stats());
		// 三段 <span> 分開：看整塊的 textContent（toHaveTextContent 會壓空白），不用 getByText。
		expect(container).toHaveTextContent("還能吃 843 kcal");
		expect(container).toHaveTextContent("已吃 1500・預算 2343（含運動 +343）");
		const arc = screen.getByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "normal");
		expect(arc).toHaveAttribute("stroke-dasharray", "221.24 345.58");
		expect(screen.getByTestId("macro-protein_g")).toHaveTextContent("60 / 120");
		expect(screen.getByTestId("macro-fat_g")).toHaveTextContent("未設定");
		expect(screen.getByTestId("macro-carb_g")).toHaveTextContent("180 / 250");
		expect(
			screen.queryByRole("link", { name: "設定每日目標" }),
		).not.toBeInTheDocument();
	});

	it("超過：超過 157 kcal、整圈、中間的字也標成 over", () => {
		const { container } = renderSummary(
			stats({ actual: { ...BASE.actual, kcal: "2500.00" } }),
		);
		expect(container).toHaveTextContent("超過 157 kcal");
		expect(container).toHaveTextContent("已吃 2500・預算 2343（含運動 +343）");
		const arc = screen.getByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "over");
		expect(arc).toHaveAttribute("stroke-dasharray", "345.58 345.58");
		expect(screen.getByText("超過").parentElement).toHaveAttribute(
			"data-tone",
			"over",
		);
	});

	it("剛好：差 −0.4 捨入成 0，是還能吃 0（不是超過 0）", () => {
		const { container } = renderSummary(
			stats({ actual: { ...BASE.actual, kcal: "2343.40" } }),
		);
		expect(container).toHaveTextContent("還能吃 0 kcal");
		expect(container).not.toHaveTextContent("超過");
		expect(screen.getByTestId("calorie-ring-arc")).toHaveAttribute(
			"data-tone",
			"normal",
		);
	});

	it("捨入：還能吃是先減再捨入；已吃、預算各自捨入到整數", () => {
		const { container } = renderSummary(
			stats({ actual: { ...BASE.actual, kcal: "1523.40" } }),
		);
		expect(container).toHaveTextContent("還能吃 820 kcal");
		expect(container).toHaveTextContent("已吃 1523・預算 2343");
	});

	it("運動加回關掉：預算是目標，沒有「含運動」", () => {
		const { container } = renderSummary(
			stats({ exercise_adds_to_budget: false, kcal_budget: "2000.00" }),
		);
		expect(container).toHaveTextContent("預算 2000");
		expect(container).toHaveTextContent("還能吃 500 kcal");
		expect(container).not.toHaveTextContent("含運動");
	});

	it("舊回應（離線快取沒有運動的三個欄位）：預算退回目標，沒有「含運動」", () => {
		const {
			exercise_kcal: _kcal,
			exercise_adds_to_budget: _adds,
			kcal_budget: _budget,
			...old
		} = BASE;
		const { container } = renderSummary(old as unknown as DailyStats);
		expect(container).toHaveTextContent("預算 2000");
		expect(container).toHaveTextContent("還能吃 500 kcal");
		expect(container).not.toHaveTextContent("含運動");
	});

	it("沒有目標：中間寫已吃，下面「還沒有每日目標」＋連到每日目標表單；只有底圈、三列都未設定", () => {
		const { container } = renderSummary(
			stats({ target: null, ratio: null, kcal_budget: null }),
		);
		expect(container).toHaveTextContent("已吃 1500 kcal");
		expect(screen.getByText("還沒有每日目標")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "設定每日目標" })).toHaveAttribute(
			"href",
			"/me/targets",
		);
		expect(screen.queryByTestId("calorie-ring-arc")).not.toBeInTheDocument();
		expect(screen.getAllByText("未設定")).toHaveLength(3);
		expect(container).not.toHaveTextContent("/");
	});

	it("有目標但熱量沒設：熱量同沒有目標，營養素照目標", () => {
		const { container } = renderSummary(
			stats({
				target: { ...BASE.target, kcal: null },
				ratio: { ...BASE.ratio, kcal: null },
				kcal_budget: null,
			}),
		);
		expect(container).toHaveTextContent("已吃 1500 kcal");
		expect(screen.getByText("還沒有每日目標")).toBeInTheDocument();
		expect(screen.queryByTestId("calorie-ring-arc")).not.toBeInTheDocument();
		expect(screen.getByTestId("macro-protein_g")).toHaveTextContent("60 / 120");
	});
});
