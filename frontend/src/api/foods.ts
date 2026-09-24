import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Food = components["schemas"]["FoodResponse"];
export type FoodScope = components["schemas"]["FoodScope"];
export type Revision = components["schemas"]["RevisionResponse"];
export type Portion = components["schemas"]["PortionResponse"];

/** 全庫搜尋。**食物庫與記一餐共用這一支，但不共用元件** ——
 *  兩邊選完之後的去向不一樣（記一餐進份量輸入，食物庫進詳情頁），
 *  共用元件會逼出一個 `onSelect` 分歧參數，那是把兩個不同畫面綁在一起的開始。
 *
 *  `q` 是空字串時不發請求：後端的 `q` 可以省略（會回整個可見範圍的前 50 筆），
 *  但那不是使用者按下搜尋框時想看到的東西。 */
export function useFoodSearch(q: string, scope: FoodScope) {
	return useQuery({
		queryKey: queryKeys.foodSearch(q, scope),
		queryFn: () =>
			apiFetch<Food[]>(`/api/foods?q=${encodeURIComponent(q)}&scope=${scope}`),
		enabled: q.trim() !== "",
	});
}

export function useFood(foodId: number) {
	return useQuery({
		queryKey: queryKeys.food(foodId),
		queryFn: () => apiFetch<Food>(`/api/foods/${foodId}`),
	});
}

export function useFoodRevisions(foodId: number) {
	return useQuery({
		queryKey: queryKeys.foodRevisions(foodId),
		queryFn: () => apiFetch<Revision[]>(`/api/foods/${foodId}/revisions`),
	});
}
