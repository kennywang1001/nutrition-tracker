import { describe, expect, it } from "vitest";
import type { Expense } from "../src/api/expenses";
import type { Meal } from "../src/api/meals";
import { buildTimeline } from "../src/lib/timeline";

function meal(id: number, eatenAt: string): Meal {
	return {
		id,
		eaten_at: eatenAt,
		meal_type: "lunch",
		note: null,
		description: null,
		is_private: false,
		photo_path: null,
		cost: null,
		items: [],
		kcal: "500.00",
		protein_g: "0.00",
		fat_g: "0.00",
		carb_g: "0.00",
	};
}

function expense(
	id: number,
	spentAt: string,
	mealId: number | null = null,
	amount = "100.00",
): Expense {
	return {
		id,
		amount,
		category: mealId === null ? "transport" : "food",
		spent_at: spentAt,
		note: null,
		meal_id: mealId,
	};
}

describe("buildTimeline", () => {
	it("有餐費的那一餐只出現一次，金額併進那一列", () => {
		const rows = buildTimeline(
			[meal(11, "2026-12-15T04:30:00+00:00")],
			[expense(1, "2026-12-15T04:30:00+00:00", 11, "180.00")],
		);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ kind: "meal", cost: "180.00" });
	});

	it("對不上今天任何一餐的支出各自一列", () => {
		// 包括 meal_id 有值、但那一餐不在今天清單裡的（跨日的邊界情況）——
		// 錢不能因為對不上就消失。
		const rows = buildTimeline(
			[meal(11, "2026-12-15T04:30:00+00:00")],
			[
				expense(1, "2026-12-15T01:00:00+00:00"),
				expense(2, "2026-12-15T02:00:00+00:00", 99),
			],
		);

		expect(rows.map((row) => row.kind)).toEqual(["meal", "expense", "expense"]);
	});

	it("沒有餐費的餐 cost 是 null", () => {
		const rows = buildTimeline([meal(11, "2026-12-15T04:30:00+00:00")], []);

		expect(rows[0]).toMatchObject({ kind: "meal", cost: null });
	});

	it("由新到舊排序，餐與支出混在一起排", () => {
		const rows = buildTimeline(
			[meal(11, "2026-12-15T03:00:00+00:00")],
			[
				expense(1, "2026-12-15T01:00:00+00:00"),
				expense(2, "2026-12-15T05:00:00+00:00"),
			],
		);

		expect(rows.map((row) => row.key)).toEqual([
			"expense-2",
			"meal-11",
			"expense-1",
		]);
	});

	it("同一餐有兩筆支出時，第二筆單獨一列——不會有錢消失", () => {
		// 現在的後端一餐最多一筆餐費，但這個函式不該靠那個假設才不丟錢。
		const rows = buildTimeline(
			[meal(11, "2026-12-15T04:30:00+00:00")],
			[
				expense(1, "2026-12-15T04:30:00+00:00", 11, "180.00"),
				expense(2, "2026-12-15T04:31:00+00:00", 11, "20.00"),
			],
		);

		expect(rows).toHaveLength(2);
		expect(rows.find((row) => row.kind === "expense")).toMatchObject({
			key: "expense-2",
		});
	});
});
