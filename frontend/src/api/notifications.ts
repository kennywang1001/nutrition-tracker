import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "./client";
import { required } from "./friends";
import { queryKeys } from "./queries";
import type { components } from "./schema";

export type NotificationItem = components["schemas"]["NotificationItem"];

/** 未讀數多久重抓一次（規格 D16）。沒有推播：這就是「最慢多久看到新通知」。 */
export const UNREAD_POLL_MS = 60_000;

/** 通知的清單（最近 50 則、新的在前）。`staleTime: 0`：打開就是要看新的。 */
export function useNotifications() {
	return useQuery({
		queryKey: queryKeys.notifications,
		queryFn: async () =>
			(
				await required(
					apiFetch<{ items: NotificationItem[] }>("/api/notifications"),
					"通知",
				)
			).items,
		staleTime: 0,
	});
}

/** 分頁上的數字。`staleTime: 0`＋預設的 `refetchOnWindowFocus`：回到這個視窗就重抓；
 *  `refetchInterval`：畫面看得到時每分鐘一次（`refetchIntervalInBackground` 預設 false，
 *  分頁在背景時不抓）。`retry: false`：下一輪自己會再試，不用疊重試。 */
export function useUnreadCount() {
	return useQuery({
		queryKey: queryKeys.unreadCount,
		queryFn: async () =>
			(
				await required(
					apiFetch<{ count: number }>("/api/notifications/unread-count"),
					"未讀數",
				)
			).count,
		staleTime: 0,
		refetchInterval: UNREAD_POLL_MS,
		retry: false,
	});
}

/** 把 `upTo` 以前的標成已讀，回剩下的未讀數。 */
export async function markAllRead(upTo: number): Promise<number> {
	const body = await required(
		apiFetch<{ count: number }>("/api/notifications/read-all", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ up_to: upTo }),
		}),
		"已讀",
	);
	return body.count;
}
