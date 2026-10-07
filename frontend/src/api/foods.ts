import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { retryUnlessNotFound } from "./errors";
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
		queryFn: () => searchFoods(q, scope),
		enabled: q.trim() !== "",
	});
}

/** `GET /api/foods?q=`：名稱子字串比對（不分大小寫）、依名稱排序。`limit`
 *  省略時是後端的預設 50（上限 200）。不經過快取——AI 面板存食物之前的
 *  同名檢查要的是此刻的食物庫。 */
export async function searchFoods(
	q: string,
	scope: FoodScope,
	limit?: number,
): Promise<Food[]> {
	const params = `q=${encodeURIComponent(q)}&scope=${scope}`;
	const result = await apiFetch<Food[]>(
		`/api/foods?${params}${limit === undefined ? "" : `&limit=${limit}`}`,
	);
	return result ?? [];
}

/** `useParams()`（Task 5）回傳的是 `string | undefined`——`Number(undefined)`
 *  是 `NaN`，沒有這個 `enabled` 的話會真的打出 `/api/foods/NaN`。呼叫端
 *  傳一個非法的 `foodId` 時，這支 hook 就是不發請求，而不是各自在畫面裡
 *  重複判斷一次。
 *
 *  404 不重試（`retryUnlessNotFound`，同 `useMeal`）。 */
export function useFood(foodId: number) {
	return useQuery({
		queryKey: queryKeys.food(foodId),
		queryFn: () => apiFetch<Food>(`/api/foods/${foodId}`),
		enabled: Number.isFinite(foodId),
		retry: retryUnlessNotFound,
	});
}

export function useFoodRevisions(foodId: number) {
	return useQuery({
		queryKey: queryKeys.foodRevisions(foodId),
		queryFn: () => apiFetch<Revision[]>(`/api/foods/${foodId}/revisions`),
		enabled: Number.isFinite(foodId),
	});
}
