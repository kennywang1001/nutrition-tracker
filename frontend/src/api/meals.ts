import { useQuery } from "@tanstack/react-query";
import { Coffee, Cookie, type LucideIcon, Moon, Sun } from "lucide-react";
import { apiFetch } from "./client";
import { retryUnlessNotFound } from "./errors";
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

/** 餐別在下拉選單裡的順序（一天裡的時間順序）。標籤用 `MEAL_TYPE_LABELS`。 */
export const MEAL_TYPE_ORDER: readonly MealType[] = [
	"breakfast",
	"lunch",
	"dinner",
	"snack",
];

/** 一餐（編輯畫面）。`useParams` 給的 id 可能是 `NaN`——那時不發請求，
 *  畫面自己說「找不到這一餐」（跟 `useFood` 同一個作法）。
 *
 *  404 不重試（`retryUnlessNotFound`）：那一餐在另一台裝置刪掉了，重試
 *  只會讓「找不到這一餐」晚 7 秒出現。 */
export function useMeal(mealId: number) {
	return useQuery({
		queryKey: queryKeys.meal(mealId),
		queryFn: () => apiFetch<Meal>(`/api/meals/${mealId}`),
		enabled: Number.isFinite(mealId),
		retry: retryUnlessNotFound,
	});
}
