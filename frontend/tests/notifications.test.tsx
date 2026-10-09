import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type NotificationItem,
	useUnreadCount,
} from "../src/api/notifications";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Notifications } from "../src/screens/Notifications";
import { json, mockApi } from "./helpers/mock-api";

const LIST_URL = "/api/notifications";
const READ_URL = "/api/notifications/read-all";
const COUNT_URL = "/api/notifications/unread-count";

function item(overrides: Partial<NotificationItem> = {}): NotificationItem {
	return {
		id: 50,
		type: "like",
		actor_name: "鮑伯",
		meal: { id: 7, meal_type: "lunch", eaten_at: "2026-10-06T04:00:00Z" },
		comment_preview: null,
		created_at: "2026-10-06T05:00:00Z",
		is_read: true,
		...overrides,
	};
}

/** 四種各一則，新的在前（後端的順序）。前兩則還沒讀。 */
const FOUR: NotificationItem[] = [
	item({
		id: 54,
		type: "comment",
		actor_name: "小卡",
		meal: { id: 9, meal_type: "dinner", eaten_at: "2026-10-06T11:00:00Z" },
		comment_preview: "看起來不錯",
		created_at: "2026-10-06T12:00:00Z",
		is_read: false,
	}),
	item({ id: 53, type: "like", is_read: false }),
	item({
		id: 52,
		type: "friend_request",
		actor_name: "戴夫",
		meal: null,
		created_at: "2026-10-05T03:00:00Z",
	}),
	item({
		id: 51,
		type: "friend_accepted",
		actor_name: "伊芙",
		meal: null,
		created_at: "2026-10-04T03:00:00Z",
	}),
];

function failure(status: number) {
	return new Response(
		JSON.stringify({
			error: { code: "INTERNAL_ERROR", message: "伺服器錯誤", details: {} },
		}),
		{ status, headers: { "content-type": "application/json" } },
	);
}

type Answer = () => Response | Promise<Response>;

/** `list`：清單每一次怎麼回。`read`：已讀怎麼回（省略＝剩 0 則）。
 *  `count`：未讀數怎麼回——有給才會多掛一個 `useUnreadCount`（像外框那樣）。 */
function setup({
	list,
	read = () => json({ count: 0 }),
	count,
	strict = false,
	client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	}),
}: {
	list: Answer;
	read?: Answer;
	count?: Answer;
	strict?: boolean;
	client?: QueryClient;
}) {
	const spy = mockApi([
		// 越具體的排越前面：這兩個網址都「包含」清單的網址（`mockApi` 用 includes）。
		{ method: "GET", path: COUNT_URL, handler: count ?? (() => failure(500)) },
		{ method: "POST", path: READ_URL, handler: read },
		{ method: "GET", path: LIST_URL, handler: list },
	]);
	function Shell() {
		const unread = useUnreadCount().data;
		return <p data-testid="badge">{unread ?? "還不知道"}</p>;
	}
	const tree = (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/notifications"]}>
				{count !== undefined && <Shell />}
				<Notifications />
			</MemoryRouter>
		</QueryClientProvider>
	);
	render(strict ? <StrictMode>{tree}</StrictMode> : tree);
	const calls = () =>
		spy.mock.calls.map(([url, init]) => ({
			method: (init?.method ?? "GET").toUpperCase(),
			url: String(url),
			body: typeof init?.body === "string" ? init.body : null,
		}));
	return {
		client,
		/** 送出去的已讀（POST 的 body，原始字串），依先後。 */
		reads: () =>
			calls()
				.filter((call) => call.method === "POST" && call.url === READ_URL)
				.map((call) => call.body),
		/** 清單被抓了幾次。 */
		lists: () =>
			calls().filter((call) => call.method === "GET" && call.url === LIST_URL)
				.length,
		unread: () => client.getQueryData(queryKeys.unreadCount),
	};
}

/** 掛著不回的回應，`answer` 放行最早的那一個。 */
function gate() {
	const waiting: Array<(response: Response) => void> = [];
	return {
		handler: () =>
			new Promise<Response>((resolve) => {
				waiting.push(resolve);
			}),
		waiting: () => waiting.length,
		answer: (response: Response) => {
			const first = waiting.shift();
			if (first === undefined) throw new Error("沒有等著的請求可以放行");
			first(response);
		},
	};
}

/** 讓已經排好的 promise 與 timer 都跑完：斷言「沒有發生」之前用。 */
async function settle() {
	await new Promise((resolve) => setTimeout(resolve, 30));
}

function rows() {
	return within(screen.getByRole("list", { name: "通知" })).getAllByRole(
		"listitem",
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("通知頁：清單", () => {
	it("四種通知各有自己的句子與去處：讚、留言到那一餐，好友的兩種到「我的」", async () => {
		setup({ list: () => json({ items: FOUR }) });

		expect(
			await screen.findByRole("heading", { level: 1, name: "通知" }),
		).toBeInTheDocument();
		const links = await screen.findAllByRole("link");
		const expected = [
			["小卡 在你的晚餐留言：看起來不錯", "/meals/9"],
			["鮑伯 對你的午餐按了讚", "/meals/7"],
			["戴夫 想加你為好友", "/me"],
			["伊芙 接受了你的好友邀請", "/me"],
		] as const;
		// 整列是一個連結；順序就是後端給的（新的在前）。
		expect(links).toHaveLength(expected.length);
		expected.forEach(([sentence, href], index) => {
			const link = links[index] as HTMLElement;
			// 完整比對：句子是自己一個元素，後面的時間不混在裡面。
			expect(within(link).getByText(sentence)).toBeInTheDocument();
			expect(link).toHaveAttribute("href", href);
		});
		// 每一列都有時間，帶機器看得懂的那一份。
		expect(
			rows().map((row) => row.querySelector("time")?.getAttribute("datetime")),
		).toEqual([
			"2026-10-06T12:00:00Z",
			"2026-10-06T05:00:00Z",
			"2026-10-05T03:00:00Z",
			"2026-10-04T03:00:00Z",
		]);
	});

	it("還沒讀的那幾列標「未讀」，讀過的沒有", async () => {
		setup({ list: () => json({ items: FOUR }) });
		await screen.findAllByRole("link");

		expect(
			rows().map((row) => within(row).queryByText("未讀") !== null),
		).toEqual([true, true, false, false]);
		// 連結的名稱帶「未讀」：螢幕閱讀器逐一唸連結時聽得到。
		expect(
			screen.getByRole("link", { name: /^未讀.*鮑伯 對你的午餐按了讚/ }),
		).toBeInTheDocument();
	});

	it("留言的預覽只當文字畫，不會變成標籤", async () => {
		const preview = "<img src=x onerror=alert(1)>";
		setup({
			list: () =>
				json({
					items: [item({ type: "comment", comment_preview: preview, id: 60 })],
				}),
		});

		expect(
			await screen.findByText(`鮑伯 在你的午餐留言：${preview}`),
		).toBeInTheDocument();
		expect(document.querySelector("img[src='x']")).toBeNull();
	});

	it("空的：「還沒有通知」，不送已讀", async () => {
		const page = setup({ list: () => json({ items: [] }) });

		expect(await screen.findByText("還沒有通知")).toBeInTheDocument();
		expect(
			screen.queryByRole("list", { name: "通知" }),
		).not.toBeInTheDocument();
		await settle();
		expect(page.reads()).toEqual([]);
	});

	it("載入失敗：「無法載入通知」，不送已讀", async () => {
		const page = setup({ list: () => failure(500) });

		expect(await screen.findByRole("alert")).toHaveTextContent("無法載入通知");
		await settle();
		expect(page.reads()).toEqual([]);
	});

	it("還在載入：「載入中…」", () => {
		setup({ list: () => new Promise<Response>(() => {}) });

		expect(screen.getByText("載入中…")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(screen.queryByText("還沒有通知")).not.toBeInTheDocument();
	});
});

describe("通知頁：已讀", () => {
	it("清單載入之後送一次已讀，帶最新那一則的 id；未讀數換成回來的數字；清單不重抓、剛看到的還標著未讀", async () => {
		const page = setup({
			list: () => json({ items: FOUR }),
			// 剩 1 則：清單載入之後才到的那一則（id 比 54 大），沒有被這一次標掉。
			read: () => json({ count: 1 }),
		});
		// 分頁上原本的數字。
		page.client.setQueryData(queryKeys.unreadCount, 3);

		await waitFor(() => expect(page.unread()).toBe(1));
		expect(page.reads()).toEqual(['{"up_to":54}']);
		await settle();
		// 已讀之後不重抓清單：這一次的畫面上，剛看到的兩則還標著未讀。
		expect(page.lists()).toBe(1);
		expect(page.reads()).toHaveLength(1);
		expect(
			rows().map((row) => within(row).queryByText("未讀") !== null),
		).toEqual([true, true, false, false]);
	});

	it("全部都讀過了：不送已讀", async () => {
		const page = setup({
			list: () =>
				json({ items: FOUR.map((one) => ({ ...one, is_read: true })) }),
		});

		// 先等清單出現，「沒有送」才有意義。
		await screen.findAllByRole("link");
		await settle();
		expect(page.reads()).toEqual([]);
	});

	it("最新的那一則讀過了、舊的還有沒讀的：照樣送，帶的還是最新那一則的 id", async () => {
		const page = setup({
			list: () =>
				json({
					items: [
						item({ id: 54, is_read: true }),
						item({ id: 53, is_read: false }),
					],
				}),
		});

		await waitFor(() => expect(page.reads()).toEqual(['{"up_to":54}']));
	});

	it("StrictMode（effect 跑兩次）：已讀仍然只送一次", async () => {
		const page = setup({ list: () => json({ items: FOUR }), strict: true });

		await waitFor(() => expect(page.reads()).toHaveLength(1));
		await settle();
		expect(page.reads()).toEqual(['{"up_to":54}']);
	});

	it("已讀失敗：沒有未處理的 rejection，未讀數不動；清單下一次回來時再試", async () => {
		let fail = true;
		const page = setup({
			list: () => json({ items: FOUR }),
			read: () => (fail ? failure(500) : json({ count: 0 })),
		});
		page.client.setQueryData(queryKeys.unreadCount, 3);

		await waitFor(() => expect(page.reads()).toHaveLength(1));
		await settle();
		expect(page.unread()).toBe(3);
		// 失敗不是畫面上的錯誤：清單照樣看得到。
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(rows()).toHaveLength(4);

		// 回到這個視窗、清單重抓回來（同一份）：再試一次。
		fail = false;
		await page.client.refetchQueries({ queryKey: queryKeys.notifications });

		await waitFor(() => expect(page.unread()).toBe(0));
		expect(page.reads()).toEqual(['{"up_to":54}', '{"up_to":54}']);
	});

	it("同一份清單重抓回來（回到這個視窗）：不再送一次", async () => {
		const page = setup({ list: () => json({ items: FOUR }) });
		await waitFor(() => expect(page.reads()).toHaveLength(1));

		await page.client.refetchQueries({ queryKey: queryKeys.notifications });
		await settle();

		expect(page.lists()).toBe(2);
		expect(page.reads()).toHaveLength(1);
	});

	it("重抓回來多了一則新的：再送一次，帶新的那一則的 id", async () => {
		let items = FOUR;
		const page = setup({ list: () => json({ items }) });
		await waitFor(() => expect(page.reads()).toEqual(['{"up_to":54}']));

		items = [
			item({ id: 55, actor_name: "伊芙", is_read: false }),
			...FOUR.map((one) => ({ ...one, is_read: true })),
		];
		await page.client.refetchQueries({ queryKey: queryKeys.notifications });

		await waitFor(() =>
			expect(page.reads()).toEqual(['{"up_to":54}', '{"up_to":55}']),
		);
		expect(
			await screen.findByText("伊芙 對你的午餐按了讚"),
		).toBeInTheDocument();
	});

	it("回到通知頁時快取裡是上一次的清單：不照舊的送，等這一次抓回來的", async () => {
		// 上一次看的時候有兩則未讀，那時已經送過已讀了；快取裡的那一份還標著未讀。
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.notifications, FOUR);
		const held = gate();
		const page = setup({ list: held.handler, client });

		// 快取裡的先畫出來，重抓還在路上。
		expect(rows()).toHaveLength(4);
		await waitFor(() => expect(held.waiting()).toBe(1));
		await settle();
		expect(page.reads()).toEqual([]);

		// 伺服器現在的樣子：都讀過了。
		held.answer(
			json({ items: FOUR.map((one) => ({ ...one, is_read: true })) }),
		);
		await waitFor(() =>
			expect(
				rows().some((row) => within(row).queryByText("未讀") !== null),
			).toBe(false),
		);
		await settle();
		expect(page.reads()).toEqual([]);
	});

	it("已讀回來時未讀數的重抓還在路上：晚到的舊數字不會把分頁上的數字蓋回去", async () => {
		// 換到通知頁的那一刻外框會重抓未讀數；那個 GET 可能在已讀寫進資料庫之前就讀完、
		// 卻比已讀的回應晚到。
		const counts = gate();
		const page = setup({
			list: () => json({ items: FOUR }),
			read: () => json({ count: 0 }),
			count: counts.handler,
		});
		await waitFor(() => expect(counts.waiting()).toBe(1));
		expect(screen.getByTestId("badge")).toHaveTextContent("還不知道");

		// 已讀先回來。
		await waitFor(() => expect(page.unread()).toBe(0));
		// 舊的數字這時才到。
		counts.answer(json({ count: 2 }));
		await settle();

		expect(page.unread()).toBe(0);
		expect(screen.getByTestId("badge")).toHaveTextContent(/^0$/);
	});
});
