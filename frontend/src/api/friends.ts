import {
	type QueryClient,
	useInfiniteQuery,
	useQuery,
} from "@tanstack/react-query";
import { apiFetch } from "./client";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type Person = components["schemas"]["PersonResponse"];
export type Friend = components["schemas"]["FriendResponse"];
export type FriendRequests = components["schemas"]["FriendRequestsResponse"];
export type FriendRequestResult = components["schemas"]["FriendRequestResult"];
export type FriendMeal = components["schemas"]["FriendMeal"];
export type FriendFeedPage = components["schemas"]["FriendFeedResponse"];
export type FriendDay = components["schemas"]["FriendDayResponse"];

const JSON_HEADERS = { "content-type": "application/json" };

/** 這些端點成功時一定有 body；`apiFetch` 的型別為了 204 多一個 `null`，在這裡收掉。
 *  社群與通知的 API 層（`social.ts`、`notifications.ts`）共用。 */
export async function required<T>(
	response: Promise<T | null>,
	what: string,
): Promise<T> {
	const body = await response;
	if (body === null) throw new Error(`${what}的回應沒有 body`);
	return body;
}

export function useFriendCode() {
	return useQuery({
		queryKey: queryKeys.friendCode,
		queryFn: () =>
			required(apiFetch<{ code: string }>("/api/friends/me/code"), "好友碼"),
	});
}

export function resetFriendCode() {
	return required(
		apiFetch<{ code: string }>("/api/friends/me/code/reset", {
			method: "POST",
		}),
		"重設好友碼",
	);
}

export function sendFriendRequest(code: string) {
	return required(
		apiFetch<FriendRequestResult>("/api/friends/requests", {
			method: "POST",
			headers: JSON_HEADERS,
			body: JSON.stringify({ code }),
		}),
		"送出邀請",
	);
}

/** 每次打開都重抓（`staleTime: 0`）：別人剛送來的邀請就是打開的理由
 *  （同邀請清單——app 預設 60 秒、快取又會持久化）。 */
export function useFriendRequests() {
	return useQuery({
		queryKey: queryKeys.friendRequests,
		queryFn: () =>
			required(apiFetch<FriendRequests>("/api/friends/requests"), "好友邀請"),
		staleTime: 0,
	});
}

export async function acceptFriendRequest(id: number): Promise<void> {
	await apiFetch(`/api/friends/requests/${id}/accept`, { method: "POST" });
}

export async function deleteFriendRequest(id: number): Promise<void> {
	await apiFetch(`/api/friends/requests/${id}`, { method: "DELETE" });
}

export function useFriends() {
	return useQuery({
		queryKey: queryKeys.friends,
		queryFn: () => required(apiFetch<Friend[]>("/api/friends"), "好友名單"),
		staleTime: 0,
	});
}

export async function removeFriend(id: number): Promise<void> {
	await apiFetch(`/api/friends/${id}`, { method: "DELETE" });
}

export function useFriendFeed() {
	return useInfiniteQuery({
		queryKey: queryKeys.friendFeed,
		queryFn: ({ pageParam }) =>
			required(
				apiFetch<FriendFeedPage>(
					pageParam === null
						? "/api/friends/feed"
						: `/api/friends/feed?before=${encodeURIComponent(pageParam)}`,
				),
				"好友動態",
			),
		initialPageParam: null as string | null,
		// null＝沒有下一頁（TanStack v5：回 null 或 undefined 都代表沒有）。
		getNextPageParam: (last) => last.next_cursor,
		staleTime: 0,
	});
}

/** 某個好友的某一天。`day` 是 null＝讓後端用**好友的時區**決定今天
 *  （規格 §4.3；前端不知道好友的時區）。換日期時先顯示上一天的資料。 */
export function useFriendDay(friendId: number, day: string | null) {
	return useQuery({
		queryKey: queryKeys.friendDay(friendId, day),
		queryFn: () =>
			required(
				apiFetch<FriendDay>(
					day === null
						? `/api/friends/${friendId}/meals`
						: `/api/friends/${friendId}/meals?date=${day}`,
				),
				"好友的一天",
			),
		staleTime: 0,
		retry: false,
		placeholderData: (previous) => previous,
	});
}

/** 解除好友之後：這個人的好友資料一律**移除**，不是失效——失效只會標成過期，
 *  資料還在快取與 localStorage 裡（規格 §5.3）。動態整個移除（它混著所有好友）。 */
export function forgetFriend(queryClient: QueryClient, friendId: number): void {
	queryClient.removeQueries({ queryKey: queryKeys.friendFeed });
	queryClient.removeQueries({ queryKey: queryKeys.friendDayAll(friendId) });
	queryClient.removeQueries({ queryKey: queryKeys.friendPhotos(friendId) });
	void queryClient.invalidateQueries({ queryKey: queryKeys.friends });
	void queryClient.invalidateQueries({ queryKey: queryKeys.friendRequests });
}
