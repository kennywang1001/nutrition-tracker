import {
	type InfiniteData,
	InfiniteQueryObserver,
	QueryClient,
	QueryClientProvider,
	QueryObserver,
} from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { FriendDay, FriendFeedPage, FriendMeal } from "../src/api/friends";
import {
	markAllRead,
	type NotificationItem,
	useNotifications,
	useUnreadCount,
} from "../src/api/notifications";
import { queryKeys } from "../src/api/queries";
import {
	afterCommentChange,
	afterLikeChange,
	deleteComment,
	patchLikes,
	postComment,
	type SocialMeal,
	setLike,
	useSocialMeal,
} from "../src/api/social";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { json, mockApi } from "./helpers/mock-api";

/** 好友的一餐。有型別標註：後端的白名單多一個必填欄位時，這裡會先紅。 */
function m(id: number): FriendMeal {
	return {
		id,
		user: { id: 2, display_name: "鮑伯" },
		eaten_at: "2026-10-06T04:00:00Z",
		meal_type: "lunch",
		description: null,
		items: [
			{
				food_name: `便當 ${id}`,
				quantity_g: "350.00",
				base_unit: "g",
				kcal: "620.00",
			},
		],
		kcal: "620.00",
		protein_g: "25.00",
		fat_g: "20.00",
		carb_g: "80.00",
		has_photo: false,
		like_count: 0,
		comment_count: 0,
		liked_by_me: false,
	};
}

function socialMeal(id: number): SocialMeal {
	return {
		meal: m(id),
		is_mine: false,
		likes: [{ display_name: "小卡", is_me: false }],
		comments: [
			{
				id: 31,
				display_name: "小卡",
				is_me: false,
				can_delete: false,
				body: "看起來好好吃",
				created_at: "2026-10-06T05:00:00Z",
			},
		],
		comments_truncated: false,
	};
}

function wrapper(client: QueryClient) {
	return ({ children }: { children: ReactNode }) => (
		<QueryClientProvider client={client}>{children}</QueryClientProvider>
	);
}

/** 每一個請求的（方法、網址、body）。`mockApi` 的路由只比對路徑的子字串，
 *  「打的是哪一支、用什麼方法」要看實際送出去的（handover §6 第 43 種）。 */
function sent(spy: ReturnType<typeof mockApi>) {
	return spy.mock.calls.map(([url, init]) => ({
		method: (init?.method ?? "GET").toUpperCase(),
		url: String(url),
		body: typeof init?.body === "string" ? init.body : null,
	}));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("patchLikes：把伺服器回來的讚寫回每一份快取", () => {
	function seeded() {
		const client = new QueryClient();
		client.setQueryData<InfiniteData<FriendFeedPage>>(queryKeys.friendFeed, {
			pages: [
				{ meals: [m(7), m(8)], next_cursor: "x" },
				{ meals: [m(9)], next_cursor: null },
			],
			pageParams: [null, "x"],
		});
		client.setQueryData<FriendDay>(queryKeys.friendDay(2, "2026-10-06"), {
			friend: { id: 2, display_name: "鮑伯" },
			day: "2026-10-06",
			meals: [m(7), m(8)],
		});
		// 讓後端決定今天的那一份（day 是 null）也是「某一天」。
		client.setQueryData<FriendDay>(queryKeys.friendDay(2, null), {
			friend: { id: 2, display_name: "鮑伯" },
			day: "2026-10-06",
			meals: [m(8)],
		});
		client.setQueryData<SocialMeal>(queryKeys.socialMeal(8), socialMeal(8));
		client.setQueryData<SocialMeal>(queryKeys.socialMeal(9), socialMeal(9));
		return client;
	}

	it("動態的每一頁、某一天、餐點頁的第 8 餐都換成伺服器的數字；其他餐與其他欄位不動", () => {
		const client = seeded();

		patchLikes(client, 8, { like_count: 3, liked_by_me: true });

		const feed = client.getQueryData<InfiniteData<FriendFeedPage>>(
			queryKeys.friendFeed,
		);
		expect(feed?.pages[0]?.meals[1]).toEqual({
			...m(8),
			like_count: 3,
			liked_by_me: true,
		});
		// 同一頁的另一餐、另一頁的餐：一個欄位都沒變。
		expect(feed?.pages[0]?.meals[0]).toEqual(m(7));
		expect(feed?.pages[1]?.meals[0]).toEqual(m(9));
		// infinite query 的骨架原封不動（動到就會讓「載入更多」接錯游標）。
		expect(feed?.pageParams).toEqual([null, "x"]);
		expect(feed?.pages.map((page) => page.next_cursor)).toEqual(["x", null]);

		const day = client.getQueryData<FriendDay>(
			queryKeys.friendDay(2, "2026-10-06"),
		);
		expect(day?.meals).toEqual([
			m(7),
			{ ...m(8), like_count: 3, liked_by_me: true },
		]);
		expect(day?.friend).toEqual({ id: 2, display_name: "鮑伯" });
		expect(
			client.getQueryData<FriendDay>(queryKeys.friendDay(2, null))?.meals,
		).toEqual([{ ...m(8), like_count: 3, liked_by_me: true }]);

		expect(client.getQueryData(queryKeys.socialMeal(8))).toEqual({
			...socialMeal(8),
			meal: { ...m(8), like_count: 3, liked_by_me: true },
		});
		// 另一餐的餐點頁不動。
		expect(client.getQueryData(queryKeys.socialMeal(9))).toEqual(socialMeal(9));
	});

	it("沒有那個快取時不會憑空生一個", () => {
		const client = new QueryClient();

		patchLikes(client, 8, { like_count: 3, liked_by_me: true });

		expect(client.getQueryData(queryKeys.socialMeal(8))).toBeUndefined();
		expect(client.getQueryData(queryKeys.friendFeed)).toBeUndefined();
		expect(client.getQueryCache().getAll()).toEqual([]);
	});

	it("query 在但還沒有資料（第一次載入還在路上）：不會炸，也不會塞一份假的進去", () => {
		// 動態第一次載入失敗或還在載入時，人可以在好友的某一天、餐點頁上按讚——
		// 那個 query 存在、`data` 是 undefined。`setQueriesData` 會把 undefined 交給 updater。
		const client = new QueryClient();
		const never = () => new Promise<never>(() => {});
		void client.prefetchInfiniteQuery({
			queryKey: queryKeys.friendFeed,
			queryFn: never,
			initialPageParam: null,
		});
		void client.prefetchQuery({
			queryKey: queryKeys.friendDay(2, null),
			queryFn: never,
		});
		void client.prefetchQuery({
			queryKey: queryKeys.socialMeal(8),
			queryFn: never,
		});
		expect(client.getQueryCache().getAll()).toHaveLength(3);

		expect(() =>
			patchLikes(client, 8, { like_count: 3, liked_by_me: true }),
		).not.toThrow();

		expect(
			client
				.getQueryCache()
				.getAll()
				.map((query) => query.state.data),
		).toEqual([undefined, undefined, undefined]);
	});
});

/** 可以手動放行的 queryFn：每呼叫一次多一個等著的，`answer(i, data)` 放行第 i 次。 */
function manual<T>() {
	const resolvers: Array<(data: T) => void> = [];
	return {
		queryFn: () =>
			new Promise<T>((resolve) => {
				resolvers.push(resolve);
			}),
		calls: () => resolvers.length,
		answer(index: number, data: T) {
			const resolve = resolvers[index];
			if (resolve === undefined) throw new Error(`沒有第 ${index + 1} 次呼叫`);
			resolve(data);
		},
	};
}

/** 讓已經排好的工作（TanStack 的通知、被放行的 promise）都跑完。 */
async function settle() {
	for (let round = 0; round < 3; round += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

describe("afterLikeChange：讚的回應回來之後", () => {
	const LIKED = { like_count: 3, liked_by_me: true };
	const day = (meal: FriendMeal): FriendDay => ({
		friend: { id: 2, display_name: "鮑伯" },
		day: "2026-10-06",
		meals: [meal],
	});
	const feed = (meal: FriendMeal): InfiniteData<FriendFeedPage> => ({
		pages: [{ meals: [meal], next_cursor: null }],
		pageParams: [null],
	});

	it("數字寫回每一份快取；餐點頁重抓（名單變了），掛著的動態與某一天不重抓", async () => {
		const client = new QueryClient();
		const fetched: string[] = [];
		const counted =
			<T,>(name: string, data: T) =>
			() => {
				fetched.push(name);
				return Promise.resolve(data);
			};
		client.setQueryData(queryKeys.friendFeed, feed(m(8)));
		client.setQueryData(queryKeys.friendDay(2, null), day(m(8)));
		client.setQueryData(queryKeys.socialMeal(8), socialMeal(8));
		client.setQueryData(queryKeys.socialMeal(9), socialMeal(9));
		// 四個都掛著（有人在看），資料都還新鮮：只有被失效的才會重抓。
		const fresh = { staleTime: Number.POSITIVE_INFINITY };
		const stop = [
			new InfiniteQueryObserver(client, {
				queryKey: queryKeys.friendFeed,
				queryFn: counted("動態", { meals: [m(8)], next_cursor: null }),
				initialPageParam: null as string | null,
				getNextPageParam: (last: FriendFeedPage) => last.next_cursor,
				...fresh,
			}).subscribe(() => {}),
			new QueryObserver(client, {
				queryKey: queryKeys.friendDay(2, null),
				queryFn: counted("某一天", day(m(8))),
				...fresh,
			}).subscribe(() => {}),
			new QueryObserver(client, {
				queryKey: queryKeys.socialMeal(8),
				queryFn: counted("餐點頁 8", {
					...socialMeal(8),
					meal: { ...m(8), ...LIKED },
				}),
				...fresh,
			}).subscribe(() => {}),
			new QueryObserver(client, {
				queryKey: queryKeys.socialMeal(9),
				queryFn: counted("餐點頁 9", socialMeal(9)),
				...fresh,
			}).subscribe(() => {}),
		];
		await settle();
		expect(fetched).toEqual([]);

		afterLikeChange(client, 8, LIKED);

		// 寫回是同步的：不用等任何重抓。
		expect(
			client.getQueryData<InfiniteData<FriendFeedPage>>(queryKeys.friendFeed)
				?.pages[0]?.meals[0],
		).toEqual({ ...m(8), ...LIKED });
		expect(
			client.getQueryData<FriendDay>(queryKeys.friendDay(2, null))?.meals[0],
		).toEqual({ ...m(8), ...LIKED });
		expect(
			client.getQueryData<SocialMeal>(queryKeys.socialMeal(8))?.meal,
		).toEqual({ ...m(8), ...LIKED });

		await settle();
		// 先等到會重抓的那一個真的抓了，「另外三個沒有」才有意義（第 41 種）。
		expect(fetched).toEqual(["餐點頁 8"]);
		for (const unsubscribe of stop) unsubscribe();
	});

	it("那時候還在路上的重抓重來一次：按讚之前的舊回應不會蓋掉剛寫進去的數字", async () => {
		// 回到分頁（重抓開始）馬上按讚：動態的 GET 可能在讚寫進資料庫之前就讀完了，
		// 但比讚的回應晚到——不重來的話，那份舊的「沒讚」會蓋掉剛寫的「讚」，一直到下一次重抓。
		const client = new QueryClient();
		const feedFn = manual<FriendFeedPage>();
		const dayFn = manual<FriendDay>();
		const idleFn = manual<FriendDay>();
		client.setQueryData(queryKeys.friendFeed, feed(m(8)));
		client.setQueryData(queryKeys.friendDay(2, null), day(m(8)));
		client.setQueryData(queryKeys.friendDay(3, null), day(m(8)));
		const stop = [
			// 動態掛著（有人在看）。
			new InfiniteQueryObserver(client, {
				queryKey: queryKeys.friendFeed,
				queryFn: feedFn.queryFn,
				initialPageParam: null as string | null,
				getNextPageParam: (last: FriendFeedPage) => last.next_cursor,
				staleTime: Number.POSITIVE_INFINITY,
			}).subscribe(() => {}),
			// 另一個好友的某一天掛著、沒有在抓：不該被牽連。
			new QueryObserver(client, {
				queryKey: queryKeys.friendDay(3, null),
				queryFn: idleFn.queryFn,
				staleTime: Number.POSITIVE_INFINITY,
			}).subscribe(() => {}),
		];
		void client.refetchQueries({ queryKey: queryKeys.friendFeed });
		// 某一天沒有人掛著（剛離開那一頁），但它的重抓還在路上。
		client
			.fetchQuery({
				queryKey: queryKeys.friendDay(2, null),
				queryFn: dayFn.queryFn,
			})
			.catch(() => {});
		await settle();
		expect([feedFn.calls(), dayFn.calls(), idleFn.calls()]).toEqual([1, 1, 0]);

		afterLikeChange(client, 8, LIKED);
		await settle();

		// 舊的回應（按讚之前讀的）這時才到：不能蓋掉剛寫的。
		feedFn.answer(0, { meals: [m(8)], next_cursor: null });
		dayFn.answer(0, day(m(8)));
		await settle();
		const liked = () => [
			client.getQueryData<InfiniteData<FriendFeedPage>>(queryKeys.friendFeed)
				?.pages[0]?.meals[0]?.liked_by_me,
			client.getQueryData<FriendDay>(queryKeys.friendDay(2, null))?.meals[0]
				?.liked_by_me,
		];
		expect(liked()).toEqual([true, true]);
		// 在路上的兩個各重來了一次；沒有在抓的那一個不動。
		expect([feedFn.calls(), dayFn.calls(), idleFn.calls()]).toEqual([2, 2, 0]);

		// 重來的那一次回來：伺服器現在的樣子（別人也按了，4 個）。
		const now = { ...m(8), like_count: 4, liked_by_me: true };
		feedFn.answer(1, { meals: [now], next_cursor: null });
		dayFn.answer(1, day(now));
		await settle();
		expect(liked()).toEqual([true, true]);
		expect(
			client.getQueryData<FriendDay>(queryKeys.friendDay(2, null))?.meals[0]
				?.like_count,
		).toBe(4);
		for (const unsubscribe of stop) unsubscribe();
	});
});

describe("社群的請求", () => {
	it("setLike：true 是 PUT、false 是 DELETE，回伺服器的狀態", async () => {
		const spy = mockApi([
			{
				method: "PUT",
				path: "/api/social/meals/8/like",
				handler: () => json({ like_count: 4, liked_by_me: true }),
			},
			{
				method: "DELETE",
				path: "/api/social/meals/8/like",
				handler: () => json({ like_count: 3, liked_by_me: false }),
			},
		]);

		expect(await setLike(8, true)).toEqual({
			like_count: 4,
			liked_by_me: true,
		});
		expect(await setLike(8, false)).toEqual({
			like_count: 3,
			liked_by_me: false,
		});

		expect(sent(spy)).toEqual([
			{ method: "PUT", url: "/api/social/meals/8/like", body: null },
			{ method: "DELETE", url: "/api/social/meals/8/like", body: null },
		]);
	});

	it("postComment：POST 到那一餐的留言，body 是 { body }，回那一則留言", async () => {
		const comment = socialMeal(8).comments[0];
		const spy = mockApi([
			{
				path: "/api/social/meals/8/comments",
				handler: () => json(comment, 201),
			},
		]);

		expect(await postComment(8, "看起來好好吃")).toEqual(comment);

		expect(sent(spy)).toEqual([
			{
				method: "POST",
				url: "/api/social/meals/8/comments",
				body: JSON.stringify({ body: "看起來好好吃" }),
			},
		]);
		expect(
			new Headers(spy.mock.calls[0]?.[1]?.headers).get("content-type"),
		).toBe("application/json");
	});

	it("deleteComment：DELETE 那一餐的那一則；204 沒有 body 也不算錯", async () => {
		const spy = mockApi([
			{
				path: "/api/social/meals/8/comments/31",
				handler: () => new Response(null, { status: 204 }),
			},
		]);

		await expect(deleteComment(8, 31)).resolves.toBeUndefined();

		expect(sent(spy)).toEqual([
			{
				method: "DELETE",
				url: "/api/social/meals/8/comments/31",
				body: null,
			},
		]);
	});

	it("useSocialMeal：讀那一餐；看不到（404）不重試", async () => {
		const spy = mockApi([
			{
				path: "/api/social/meals/8",
				handler: () => json(socialMeal(8)),
			},
			{
				path: "/api/social/meals/9",
				handler: () =>
					json(
						{
							error: {
								code: "MEAL_NOT_FOUND",
								message: "找不到該餐點",
								details: {},
							},
						},
						404,
					),
			},
		]);
		// app 的 client 沒有關掉重試：這裡也不關，才看得到 hook 自己的設定。
		const client = new QueryClient();

		const seen = renderHook(() => useSocialMeal(8), {
			wrapper: wrapper(client),
		});
		await waitFor(() =>
			expect(seen.result.current.data).toEqual(socialMeal(8)),
		);

		const hidden = renderHook(() => useSocialMeal(9), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(hidden.result.current.isError).toBe(true));
		expect(
			sent(spy).filter((call) => call.url === "/api/social/meals/9"),
		).toHaveLength(1);

		const options = client
			.getQueryCache()
			.find({ queryKey: queryKeys.socialMeal(8) })?.observers[0]?.options;
		expect(options?.staleTime).toBe(0);
	});

	it("afterCommentChange：這一餐與各個清單標成過期；別的餐、別的資料不動", async () => {
		const client = new QueryClient();
		const touched = [
			queryKeys.socialMeal(8),
			queryKeys.friendFeed,
			queryKeys.friendDay(2, "2026-10-06"),
			queryKeys.meals,
		];
		const untouched = [
			queryKeys.socialMeal(9),
			queryKeys.dailyStats,
			queryKeys.friends,
			queryKeys.notifications,
		];
		for (const key of [...touched, ...untouched]) {
			client.setQueryData(key, "先放一份");
		}
		const invalidated = (key: readonly unknown[]) =>
			client.getQueryState(key)?.isInvalidated;

		await afterCommentChange(client, 8);

		expect(touched.map(invalidated)).toEqual([true, true, true, true]);
		expect(untouched.map(invalidated)).toEqual([false, false, false, false]);
	});
});

describe("通知的請求", () => {
	const ITEMS: NotificationItem[] = [
		{
			id: 41,
			type: "comment",
			actor_name: "鮑伯",
			meal: { id: 8, meal_type: "lunch", eaten_at: "2026-10-06T04:00:00Z" },
			comment_preview: "看起來好好吃",
			created_at: "2026-10-06T05:00:00Z",
			is_read: false,
		},
		{
			id: 40,
			type: "friend_accepted",
			actor_name: "鮑伯",
			meal: null,
			comment_preview: null,
			created_at: "2026-10-05T05:00:00Z",
			is_read: true,
		},
	];

	it("useNotifications：清單是回應裡的 items，每次打開都重抓", async () => {
		const spy = mockApi([
			{ path: "/api/notifications", handler: () => json({ items: ITEMS }) },
		]);
		const client = new QueryClient();

		const { result } = renderHook(() => useNotifications(), {
			wrapper: wrapper(client),
		});

		await waitFor(() => expect(result.current.data).toEqual(ITEMS));
		expect(sent(spy)).toEqual([
			{ method: "GET", url: "/api/notifications", body: null },
		]);
		const options = client
			.getQueryCache()
			.find({ queryKey: queryKeys.notifications })?.observers[0]?.options;
		expect(options?.staleTime).toBe(0);
	});

	it("markAllRead：帶 up_to，回剩下的未讀數", async () => {
		const spy = mockApi([
			{
				path: "/api/notifications/read-all",
				handler: () => json({ count: 2 }),
			},
		]);

		expect(await markAllRead(41)).toBe(2);

		expect(sent(spy)).toEqual([
			{
				method: "POST",
				url: "/api/notifications/read-all",
				body: '{"up_to":41}',
			},
		]);
		expect(
			new Headers(spy.mock.calls[0]?.[1]?.headers).get("content-type"),
		).toBe("application/json");
	});

	it("未讀數：每 60 秒、只在前景、不重試", async () => {
		const spy = mockApi([
			{
				path: "/api/notifications/unread-count",
				handler: () => json({ count: 3 }),
			},
		]);
		const client = new QueryClient();
		const { result } = renderHook(() => useUnreadCount(), {
			wrapper: wrapper(client),
		});
		await waitFor(() => expect(result.current.data).toBe(3));
		expect(sent(spy)).toEqual([
			{ method: "GET", url: "/api/notifications/unread-count", body: null },
		]);

		// 釘住設定，不用假時鐘去等一分鐘。
		const options = client
			.getQueryCache()
			.find({ queryKey: queryKeys.unreadCount })?.observers[0]?.options;
		expect(options?.refetchInterval).toBe(60_000);
		expect(options?.refetchIntervalInBackground ?? false).toBe(false);
		expect(options?.staleTime).toBe(0);
		expect(options?.retry).toBe(false);
	});

	it("未讀數抓不到：不重試，這一輪就是 error", async () => {
		const spy = mockApi([
			{
				path: "/api/notifications/unread-count",
				handler: () =>
					json(
						{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
						500,
					),
			},
		]);
		const { result } = renderHook(() => useUnreadCount(), {
			wrapper: wrapper(new QueryClient()),
		});

		await waitFor(() => expect(result.current.isError).toBe(true));
		expect(sent(spy)).toHaveLength(1);
	});
});
