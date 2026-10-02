import { useQuery } from "@tanstack/react-query";
import { Coffee, Cookie, type LucideIcon, Moon, Sun } from "lucide-react";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Meal = components["schemas"]["MealResponse"];
export type MealType = components["schemas"]["MealType"];

/** 餐別的中文標籤。`Record` 不是 `Partial`：後端加餐別時漏一個就是編譯錯誤。 */
export const MEAL_TYPE_LABELS: Record<MealType, string> = {
	breakfast: "早餐",
	lunch: "午餐",
	dinner: "晚餐",
	snack: "點心",
};

/** 餐別的圖示（規格 §4.2）。顏色一律用飲食分類的橘色，見 `MealTypeIcon`。 */
export const MEAL_TYPE_ICONS: Record<MealType, LucideIcon> = {
	breakfast: Coffee,
	lunch: Sun,
	dinner: Moon,
	snack: Cookie,
};

/** 今天的餐。**不帶 `date`**：後端用使用者時區的今天。
 *
 *  `MealList` 與總覽共用同一份快取（`queryKeys.meals`）——記一餐之後
 *  `LogMeal` 失效那個 key，兩個畫面一起更新。 */
export function useTodayMeals() {
	return useQuery({
		queryKey: queryKeys.meals,
		queryFn: () => apiFetch<Meal[]>("/api/meals"),
	});
}
