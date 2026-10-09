import {
	type InfiniteData,
	type QueryClient,
	useQuery,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import { retryUnlessNotFound } from "./errors";
import { type FriendDay, type FriendFeedPage, required } from "./friends";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type SocialMeal = components["schemas"]["SocialMealResponse"];
export type MealComment = components["schemas"]["CommentResponse"];
export type LikeState = components["schemas"]["LikeState"];

/** 留言的上限（code point；後端在清理之後量，見 `app/schemas/social.py`）。 */
export const COMMENT_MAX_LENGTH = 200;

/** 一餐與它的讚、留言。自己的餐與看得到的好友的餐都用這個；看不到是 404（不重試）。
 *  `staleTime: 0`：別人隨時會按讚、留言，每次打開都重抓。 */
export function useSocialMeal(mealId: number) {
	return useQuery({
		queryKey: queryKeys.socialMeal(mealId),
		queryFn: () =>
			required(apiFetch<SocialMeal>(`/api/social/meals/${mealId}`), "餐點"),
		enabled: Number.isFinite(mealId),
		staleTime: 0,
		retry: retryUnlessNotFound,
	});
}

/** 按讚（`true`）或收回（`false`）。兩個方向都冪等，回伺服器現在的數字。 */
export function setLike(mealId: number, liked: boolean) {
	return required(
		apiFetch<LikeState>(`/api/social/meals/${mealId}/like`, {
			method: liked ? "PUT" : "DELETE",
		}),
		"讚",
	);
}

export function postComment(mealId: number, body: string) {
	return required(
		apiFetch<MealComment>(`/api/social/meals/${mealId}/comments`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ body }),
		}),
		"留言",
	);
}

export async function deleteComment(
	mealId: number,
	commentId: number,
): Promise<void> {
	await apiFetch(`/api/social/meals/${mealId}/comments/${commentId}`, {
		method: "DELETE",
	});
}

/** 把伺服器回來的讚寫回每一份快取裡的這一餐（好友動態的每一頁、好友的某一天、餐點頁）。
 *
 *  **不用 `invalidateQueries`**：好友動態是 infinite query，失效＝每按一次讚就把載入過的
 *  每一頁重抓一遍。自己的餐點清單（`["meals"]`）不用管：主人不能讚自己的餐。
 *
 *  每個 updater 開頭的 `data &&`：還沒有資料的 query（沒開過、還在載入、失敗了）原樣
 *  留著——回 `undefined` 時 TanStack 不寫入，也不會憑空生出一份快取。 */
export function patchLikes(
	queryClient: QueryClient,
	mealId: number,
	state: LikeState,
): void {
	const apply = <T extends { id: number }>(meal: T): T =>
		meal.id === mealId ? { ...meal, ...state } : meal;
	queryClient.setQueriesData<InfiniteData<FriendFeedPage>>(
		{ queryKey: queryKeys.friendFeed },
		(data) =>
			data && {
				...data,
				pages: data.pages.map((page) => ({
					...page,
					meals: page.meals.map(apply),
				})),
			},
	);
	queryClient.setQueriesData<FriendDay>(
		{ queryKey: queryKeys.friendDays },
		(data) => data && { ...data, meals: data.meals.map(apply) },
	);
	queryClient.setQueryData<SocialMeal>(
		queryKeys.socialMeal(mealId),
		(data) => data && { ...data, meal: apply(data.meal) },
	);
}

/** 留言新增或刪除之後：這一餐重抓；各個清單上的「留言 N」標成過期（掛著的才會重抓——
 *  在餐點頁上時清單沒掛著，回去的時候才抓）。 */
export function afterCommentChange(
	queryClient: QueryClient,
	mealId: number,
): Promise<void> {
	void queryClient.invalidateQueries({ queryKey: queryKeys.friendFeed });
	void queryClient.invalidateQueries({ queryKey: queryKeys.friendDays });
	void queryClient.invalidateQueries({ queryKey: queryKeys.meals });
	return queryClient.invalidateQueries({
		queryKey: queryKeys.socialMeal(mealId),
	});
}

/** 讚的回應回來之後（`LikeButton`）：`state` 是伺服器現在的數字。
 *
 *  1. 寫回每一份快取（`patchLikes`）——清單不重抓。
 *  2. **那一刻還在路上的清單重抓，重來一次。** 回到分頁（重抓開始）馬上按讚時，動態的
 *     GET 可能在讚寫進資料庫之前就讀完了、卻比讚的回應晚到：不重來的話，那份舊的
 *     「沒讚」會蓋掉第 1 步剛寫的數字，畫面停在錯的狀態直到下一次重抓。只挑
 *     `fetchStatus: "fetching"` 的：平常沒有東西在抓，一個請求都不會多。
 *     `refetchType: "all"`：剛離開的那一頁（沒有人掛著，但請求還沒回來）也算。
 *  3. 餐點頁重抓：數字第 1 步寫好了，但「誰按了讚」的名單只有伺服器知道。 */
export function afterLikeChange(
	queryClient: QueryClient,
	mealId: number,
	state: LikeState,
): void {
	patchLikes(queryClient, mealId, state);
	for (const queryKey of [queryKeys.friendFeed, queryKeys.friendDays]) {
		void queryClient.invalidateQueries({
			queryKey,
			fetchStatus: "fetching",
			refetchType: "all",
		});
	}
	void queryClient.invalidateQueries({
		queryKey: queryKeys.socialMeal(mealId),
	});
}
