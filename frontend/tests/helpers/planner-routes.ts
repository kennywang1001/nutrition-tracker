import type { LibrarySuggestions } from "../../src/api/planner";
import { json, type Route } from "./mock-api";

/** 雞胸：沒有預設份量（量是 g）。每 100 g 110／23／1.5／0（營養素配餐規格 §4.5 的 e2e 那一組）。 */
export const CHICKEN = {
	id: 1,
	name: "雞胸",
	brand: null,
	is_global: false,
	nutrition: {
		base_unit: "g" as const,
		kcal: "110.00",
		protein_g: "23.00",
		fat_g: "1.50",
		carb_g: "0.00",
	},
};

/** 白飯：預設份量「1 碗」200 g。每 100 g 180／3／0.5／40。 */
export const RICE = {
	id: 2,
	name: "白飯",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g" as const,
		kcal: "180.00",
		protein_g: "3.00",
		fat_g: "0.50",
		carb_g: "40.00",
	},
};

/** 剩 700 kcal／蛋白質 50（脂肪、碳水沒設目標＝不考慮），兩組。第一組就是規格 §4.5 的 e2e 那一組：
 *  雞胸 175 g＋白飯 1.5 份＝732.5 kcal、蛋白質 49.25。數字是後端 `scale()` 會給的，前端不算。 */
export const OK_SUGGESTIONS: LibrarySuggestions = {
	date: "2026-10-15",
	status: "ok",
	remaining: { kcal: "700.00", protein_g: "50.00", fat_g: null, carb_g: null },
	combos: [
		{
			items: [
				{
					food: CHICKEN,
					portion: null,
					quantity: "175",
					quantity_g: "175",
					nutrition: {
						kcal: "192.50",
						protein_g: "40.25",
						fat_g: "2.63",
						carb_g: "0.00",
					},
				},
				{
					food: RICE,
					portion: { id: 9, label: "1 碗", grams: "200.00" },
					quantity: "1.5",
					quantity_g: "300",
					nutrition: {
						kcal: "540.00",
						protein_g: "9.00",
						fat_g: "1.50",
						carb_g: "120.00",
					},
				},
			],
			total: {
				kcal: "732.50",
				protein_g: "49.25",
				fat_g: "4.13",
				carb_g: "120.00",
			},
			fill: { kcal: "1.05", protein_g: "0.99", fat_g: null, carb_g: null },
		},
		{
			items: [
				{
					food: CHICKEN,
					portion: null,
					quantity: "300",
					quantity_g: "300",
					nutrition: {
						kcal: "330.00",
						protein_g: "69.00",
						fat_g: "4.50",
						carb_g: "0.00",
					},
				},
			],
			total: {
				kcal: "330.00",
				protein_g: "69.00",
				fat_g: "4.50",
				carb_g: "0.00",
			},
			fill: { kcal: "0.47", protein_g: "1.38", fat_g: null, carb_g: null },
		},
	],
};

/** 其他四種狀態的回應（`combos` 只有 `ok` 有東西；`remaining` 只有 `no_target` 是 null）。 */
export function suggestionsWithStatus(
	status: Exclude<LibrarySuggestions["status"], "ok">,
): LibrarySuggestions {
	return {
		date: "2026-10-15",
		status,
		remaining:
			status === "no_target"
				? null
				: {
						kcal: status === "full" ? "20.00" : "700.00",
						protein_g: "50.00",
						fat_g: null,
						carb_g: null,
					},
		combos: [],
	};
}

/** `GET /api/planner/library-suggestions` 的路由。跟其他路徑互不包含，放哪裡都不會搶別人的請求。 */
export function plannerRoutes(
	body: LibrarySuggestions = OK_SUGGESTIONS,
): Route[] {
	return [
		{
			method: "GET",
			path: "/api/planner/library-suggestions",
			handler: () => json(body),
		},
	];
}
