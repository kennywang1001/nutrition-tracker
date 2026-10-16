import type { Food } from "../../src/api/foods";

/** 有型別的 `FoodResponse`（掃條碼規格 §10.3）：新測試用它，`barcode` 預設 null。
 *  既有測試裡沒有標註型別的食物物件不改——它們沒有 `barcode`，正好是離線快取裡舊食物的樣子。 */
export function makeFood(overrides: Partial<Food> = {}): Food {
	return {
		id: 1,
		name: "洋芋片",
		brand: null,
		barcode: null,
		is_global: false,
		nutrition: {
			base_unit: "g",
			kcal: "514.29",
			protein_g: "6.00",
			fat_g: "28.00",
			carb_g: "60.86",
		},
		...overrides,
	};
}
