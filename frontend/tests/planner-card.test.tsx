import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { describe, expect, it } from "vitest";
import type { DailyStats } from "../src/api/stats";
import { PlannerCard } from "../src/components/PlannerCard";

const MACROS = {
	kcal: "1200.00",
	protein_g: "60.00",
	fat_g: "40.00",
	carb_g: "150.00",
};

const WITH_BUDGET: DailyStats = {
	date: "2026-10-15",
	actual: MACROS,
	target: { kcal: "2000.00", protein_g: "90.00", fat_g: null, carb_g: null },
	ratio: { kcal: "0.60", protein_g: "0.67", fat_g: null, carb_g: null },
	breakdown: { food: MACROS, supplement: MACROS },
	exercise_kcal: "0.00",
	exercise_adds_to_budget: true,
	kcal_budget: "2000.00",
};

const NO_TARGET: DailyStats = {
	...WITH_BUDGET,
	target: null,
	ratio: null,
	kcal_budget: null,
};

/** 加運動之前存進離線快取的那一份：物件裡**沒有** `kcal_budget` 這個鍵（`undefined`，不是 null）。 */
function oldCache(target: DailyStats["target"]): DailyStats {
	const {
		kcal_budget: _budget,
		exercise_kcal: _kcal,
		exercise_adds_to_budget: _adds,
		...rest
	} = { ...WITH_BUDGET, target };
	return rest as DailyStats;
}

function StateProbe() {
	const location = useLocation();
	return <pre data-testid="state">{JSON.stringify(location.state)}</pre>;
}

function renderCard(stats: DailyStats) {
	return render(
		<MemoryRouter initialEntries={["/diet"]}>
			<Routes>
				<Route path="/diet" element={<PlannerCard stats={stats} />} />
				<Route path="/meals/new" element={<StateProbe />} />
			</Routes>
		</MemoryRouter>,
	);
}

describe("飲食頁的「今天還能吃什麼」卡片（營養素配餐規格 §7.2）", () => {
	it("有熱量額度：兩個連結；不顯示剩下的數字（D26）", () => {
		renderCard(WITH_BUDGET);

		expect(
			screen.getByRole("heading", { level: 2, name: "今天還能吃什麼" }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "從食物庫配" })).toHaveAttribute(
			"href",
			"/planner",
		);
		expect(screen.getByRole("link", { name: "讓 AI 配一餐" })).toHaveAttribute(
			"href",
			"/meals/new",
		);
		expect(
			screen.queryByRole("link", { name: "設定每日目標" }),
		).not.toBeInTheDocument();
		expect(screen.getByTestId("planner-card")).not.toHaveTextContent("kcal");
	});

	it("「讓 AI 配一餐」帶著 plannerSuggest 到記一餐", async () => {
		renderCard(WITH_BUDGET);

		await userEvent.click(screen.getByRole("link", { name: "讓 AI 配一餐" }));

		expect(screen.getByTestId("state").textContent).toBe(
			'{"plannerSuggest":true}',
		);
	});

	it("沒有熱量額度：只有「設定每日目標」", () => {
		renderCard(NO_TARGET);

		expect(screen.getByRole("link", { name: "設定每日目標" })).toHaveAttribute(
			"href",
			"/me/targets",
		);
		expect(
			screen.queryByRole("link", { name: "從食物庫配" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "讓 AI 配一餐" }),
		).not.toBeInTheDocument();
	});

	it("舊的離線快取（沒有 kcal_budget、目標有熱量）：照樣有兩個動作（退回目標）", () => {
		renderCard(
			oldCache({
				kcal: "1800.00",
				protein_g: null,
				fat_g: null,
				carb_g: null,
			}),
		);

		expect(
			screen.getByRole("link", { name: "從食物庫配" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "設定每日目標" }),
		).not.toBeInTheDocument();
	});

	it("舊的離線快取（沒有 kcal_budget、也沒有目標）：「設定每日目標」", () => {
		// 只看 `kcal_budget === null` 的寫法在這裡會畫出兩個動作（`undefined` 不是 null）。
		renderCard(oldCache(null));

		expect(
			screen.getByRole("link", { name: "設定每日目標" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("link", { name: "從食物庫配" }),
		).not.toBeInTheDocument();
	});
});
