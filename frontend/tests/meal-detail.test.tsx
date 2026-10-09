import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import type { MealComment, SocialMeal } from "../src/api/social";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { MealDetail } from "../src/screens/MealDetail";
import { type Route as ApiRoute, json, mockApi } from "./helpers/mock-api";

const MEAL_URL = "/api/social/meals/7";

function comment(overrides: Partial<MealComment> = {}): MealComment {
	return {
		id: 31,
		display_name: "鮑伯",
		is_me: false,
		can_delete: false,
		body: "看起來不錯",
		created_at: "2026-10-06T05:00:00Z",
		...overrides,
	};
}

/** 好友（鮑伯）的午餐，愛麗絲在看。`meal` 的欄位另外蓋（不然整個 `meal` 都要重寫）。 */
function socialMeal(
	overrides: Partial<Omit<SocialMeal, "meal">> = {},
	meal: Partial<SocialMeal["meal"]> = {},
): SocialMeal {
	return {
		meal: {
			id: 7,
			user: { id: 2, display_name: "鮑伯" },
			eaten_at: "2026-10-06T04:00:00Z",
			meal_type: "lunch",
			description: "巷口的排骨便當",
			items: [
				{
					food_name: "排骨便當",
					quantity_g: "350.00",
					base_unit: "g",
					kcal: "620.00",
				},
				{
					food_name: "無糖綠茶",
					quantity_g: "500.00",
					base_unit: "ml",
					kcal: "0.00",
				},
			],
			kcal: "620.00",
			protein_g: "25.50",
			fat_g: "20.00",
			carb_g: "80.00",
			has_photo: false,
			like_count: 0,
			comment_count: 0,
			liked_by_me: false,
			...meal,
		},
		is_mine: false,
		likes: [],
		comments: [],
		comments_truncated: false,
		...overrides,
	};
}

/** 愛麗絲自己的午餐。 */
function ownMeal(
	overrides: Partial<Omit<SocialMeal, "meal">> = {},
	meal: Partial<SocialMeal["meal"]> = {},
): SocialMeal {
	return socialMeal(
		{ is_mine: true, ...overrides },
		{ user: { id: 1, display_name: "愛麗絲" }, ...meal },
	);
}

function failure(status: number, code: string, message: string) {
	return new Response(
		JSON.stringify({ error: { code, message, details: {} } }),
		{ status, headers: { "content-type": "application/json" } },
	);
}

function jpeg() {
	return new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }));
}

/** `page`：`GET /api/social/meals/7` 每一次怎麼回（可以讀外面會變的狀態）。
 *  `extra` 排在它前面——留言、讚的網址都「包含」這一餐的網址。 */
function setup(
	page: () => Response | Promise<Response>,
	{
		extra = [],
		path = "/meals/7",
		client = new QueryClient({
			// `useSocialMeal` 自己的 `retry` 函式蓋過這裡的預設值，所以 500 那一條還是會
			// 重試 3 次——等待的時間拿掉就好。
			defaultOptions: { queries: { retryDelay: 0 } },
		}),
	}: { extra?: ApiRoute[]; path?: string; client?: QueryClient } = {},
) {
	const spy = mockApi([
		...extra,
		{ method: "GET", path: MEAL_URL, handler: page },
	]);
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={[path]}>
				<Routes>
					<Route path="/meals/:id" element={<MealDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	const calls = () =>
		spy.mock.calls.map(([url, init]) => ({
			method: (init?.method ?? "GET").toUpperCase(),
			url: String(url),
		}));
	return {
		client,
		calls,
		urls: () => calls().map((call) => call.url),
		/** 這一餐被抓了幾次。 */
		fetches: () =>
			calls().filter((call) => call.method === "GET" && call.url === MEAL_URL)
				.length,
		sent: (method: string) =>
			calls()
				.filter((call) => call.method === method)
				.map((call) => call.url),
	};
}

/** 三則留言：鮑伯（餐的主人）、愛麗絲（我）、小卡。 */
const THREE: MealComment[] = [
	comment({ id: 31, display_name: "鮑伯", body: "看起來不錯" }),
	comment({
		id: 32,
		display_name: "愛麗絲",
		is_me: true,
		can_delete: true,
		body: "哪一家的？",
		created_at: "2026-10-06T05:10:00Z",
	}),
	comment({
		id: 33,
		display_name: "小卡",
		body: "下次一起",
		created_at: "2026-10-06T05:20:00Z",
	}),
];

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("餐點頁：好友的餐", () => {
	it("標題是「鮑伯的午餐」，有讚的按鈕、沒有「編輯」；描述、項目、合計、誰按了讚都在", async () => {
		setup(() =>
			json(
				socialMeal(
					{
						likes: [
							{ display_name: "小卡", is_me: false },
							{ display_name: "愛麗絲", is_me: true },
						],
					},
					{ like_count: 2, liked_by_me: true },
				),
			),
		);

		expect(
			await screen.findByRole("heading", { level: 1, name: "鮑伯的午餐" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "讚，鮑伯的午餐", pressed: true }),
		).toHaveAccessibleDescription("2 個讚");
		expect(
			screen.queryByRole("link", { name: "編輯" }),
		).not.toBeInTheDocument();
		// 名字連到他的那一天（跟動態上的卡片一樣）。
		expect(screen.getByRole("link", { name: "鮑伯" })).toHaveAttribute(
			"href",
			"/friends/2",
		);
		expect(screen.getByText("巷口的排骨便當")).toBeInTheDocument();
		const items = screen.getByRole("list", { name: "這一餐吃了什麼" });
		expect(
			within(items)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual(["排骨便當 · 350 g620 kcal", "無糖綠茶 · 500 ml0 kcal"]);
		// 合計的熱量自己一列（跟上面每一項的熱量對齊在右邊），三大營養素在下面一列。
		expect(screen.getByText("合計").parentElement).toHaveTextContent(
			/^合計620 kcal$/,
		);
		expect(
			screen.getByText("蛋白質 25.5 g · 脂肪 20 g · 碳水 80 g"),
		).toBeInTheDocument();
		// 名單上是我的那一個寫「我」，不寫我的名字。
		expect(screen.getByText("小卡、我 說讚")).toBeInTheDocument();
		// 時間在 <time> 裡，帶機器看得懂的那一份。
		expect(
			document.querySelector('time[datetime="2026-10-06T04:00:00Z"]'),
		).not.toBeNull();
	});

	it("沒有人按讚：不畫名單；沒有描述：不畫空的段落", async () => {
		setup(() => json(socialMeal({}, { description: null })));

		await screen.findByRole("heading", { name: "鮑伯的午餐" });
		expect(screen.queryByText(/說讚/)).not.toBeInTheDocument();
		expect(screen.queryByTestId("meal-description")).not.toBeInTheDocument();
	});

	it("按讚：數字馬上變，名單等這一餐重抓回來之後多一個「我」", async () => {
		let liked = false;
		const page = setup(
			() =>
				json(
					socialMeal(
						{
							likes: [
								{ display_name: "小卡", is_me: false },
								...(liked ? [{ display_name: "愛麗絲", is_me: true }] : []),
							],
						},
						{ like_count: liked ? 2 : 1, liked_by_me: liked },
					),
				),
			{
				extra: [
					{
						method: "PUT",
						path: `${MEAL_URL}/like`,
						handler: () => {
							liked = true;
							return json({ like_count: 2, liked_by_me: true });
						},
					},
				],
			},
		);
		const button = await screen.findByRole("button", {
			name: "讚，鮑伯的午餐",
			pressed: false,
		});
		expect(screen.getByText("小卡 說讚")).toBeInTheDocument();

		await userEvent.click(button);

		expect(await screen.findByText("小卡、我 說讚")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "讚，鮑伯的午餐", pressed: true }),
		).toHaveAccessibleDescription("2 個讚");
		expect(page.sent("PUT")).toEqual([`${MEAL_URL}/like`]);
	});
});

describe("餐點頁：自己的餐", () => {
	it("標題是「我的午餐」，「編輯」連到編輯畫面；沒有讚的按鈕，只有數字與名單", async () => {
		setup(() =>
			json(
				ownMeal(
					{
						likes: [
							{ display_name: "鮑伯", is_me: false },
							{ display_name: "小卡", is_me: false },
						],
					},
					{ like_count: 2 },
				),
			),
		);

		expect(
			await screen.findByRole("heading", { level: 1, name: "我的午餐" }),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "編輯" })).toHaveAttribute(
			"href",
			"/meals/7/edit",
		);
		// 主人不能對自己的餐按讚（後端 422）：沒有按鈕。
		expect(
			screen.queryByRole("button", { name: /^讚/ }),
		).not.toBeInTheDocument();
		expect(screen.getByText("2 個讚")).toBeInTheDocument();
		expect(screen.getByText("鮑伯、小卡 說讚")).toBeInTheDocument();
		// 自己的名字不是連結（沒有「我的那一天」這種好友頁）。
		expect(
			screen.queryByRole("link", { name: "愛麗絲" }),
		).not.toBeInTheDocument();
	});

	it("還沒有人按讚：不畫「0 個讚」", async () => {
		setup(() => json(ownMeal()));

		await screen.findByRole("heading", { name: "我的午餐" });
		expect(screen.queryByText(/個讚/)).not.toBeInTheDocument();
	});
});

describe("餐點頁：照片", () => {
	it("好友的餐走好友的照片端點，不碰 /api/meals", async () => {
		const page = setup(() => json(socialMeal({}, { has_photo: true })), {
			extra: [
				{ method: "GET", path: "/api/friends/2/meals/7/photo", handler: jpeg },
				{ method: "GET", path: "/api/meals/7/photo", handler: jpeg },
			],
		});

		// 先等圖片出現，「沒有請求另一個」才有意義。
		expect(
			await screen.findByRole("img", { name: "鮑伯的午餐" }),
		).toBeInTheDocument();
		expect(
			page
				.urls()
				.some((url) => url.endsWith("/api/friends/2/meals/7/photo?size=thumb")),
		).toBe(true);
		expect(page.urls().some((url) => url.includes("/api/meals/7/photo"))).toBe(
			false,
		);
	});

	it("自己的餐走 /api/meals/{id}/photo，不碰好友的端點", async () => {
		const page = setup(() => json(ownMeal({}, { has_photo: true })), {
			extra: [
				{ method: "GET", path: "/api/friends/", handler: jpeg },
				{ method: "GET", path: "/api/meals/7/photo", handler: jpeg },
			],
		});

		expect(
			await screen.findByRole("img", { name: "我的午餐" }),
		).toBeInTheDocument();
		expect(
			page.urls().some((url) => url.endsWith("/api/meals/7/photo?size=thumb")),
		).toBe(true);
		expect(page.urls().some((url) => url.includes("/api/friends/"))).toBe(
			false,
		);
	});

	it("沒有照片：一張都不抓", async () => {
		const page = setup(() => json(socialMeal()));

		await screen.findByRole("heading", { name: "鮑伯的午餐" });
		expect(page.urls().filter((url) => url.includes("photo"))).toEqual([]);
		expect(screen.queryByRole("img")).not.toBeInTheDocument();
	});
});

describe("餐點頁：留言", () => {
	it("依序列出來：名字、時間、內容；是我的寫「（我）」；只有能刪的有刪除鈕", async () => {
		setup(() => json(socialMeal({ comments: THREE }, { comment_count: 3 })));

		expect(
			await screen.findByRole("heading", { level: 2, name: "留言（3）" }),
		).toBeInTheDocument();
		const rows = within(
			screen.getByRole("list", { name: "留言" }),
		).getAllByRole("listitem");
		expect(rows).toHaveLength(3);
		const [first, second, third] = rows as [
			HTMLElement,
			HTMLElement,
			HTMLElement,
		];
		expect(within(first).getByText("鮑伯")).toBeInTheDocument();
		expect(within(first).getByText("看起來不錯")).toBeInTheDocument();
		expect(within(second).getByText("愛麗絲（我）")).toBeInTheDocument();
		expect(within(second).getByText("哪一家的？")).toBeInTheDocument();
		expect(within(third).getByText("小卡")).toBeInTheDocument();
		expect(within(third).getByText("下次一起")).toBeInTheDocument();
		// 不是我的不寫「（我）」。
		expect(first).not.toHaveTextContent("（我）");
		expect(third).not.toHaveTextContent("（我）");
		// 時間在 <time> 裡。
		expect(first.querySelector("time")).toHaveAttribute(
			"datetime",
			"2026-10-06T05:00:00Z",
		);
		expect(second.querySelector("time")).toHaveAttribute(
			"datetime",
			"2026-10-06T05:10:00Z",
		);
		// 能不能刪照伺服器說的（`can_delete`），不是照「是不是我」猜。
		expect(
			screen.getAllByRole("button", { name: /^刪除 .+ 的留言$/ }),
		).toHaveLength(1);
		expect(
			within(second).getByRole("button", { name: "刪除 愛麗絲 的留言" }),
		).toHaveAccessibleDescription("哪一家的？");
	});

	it("主人看自己的餐：每一則都能刪（別人寫的也是）", async () => {
		setup(() =>
			json(
				ownMeal(
					{
						comments: [
							comment({ id: 31, display_name: "鮑伯", can_delete: true }),
							comment({
								id: 32,
								display_name: "愛麗絲",
								is_me: true,
								can_delete: true,
								body: "謝謝",
							}),
						],
					},
					{ comment_count: 2 },
				),
			),
		);

		expect(
			await screen.findByRole("button", { name: "刪除 鮑伯 的留言" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "刪除 愛麗絲 的留言" }),
		).toBeInTheDocument();
	});

	it("留言的內容只當文字畫，不會變成標籤", async () => {
		const body = "<img src=x onerror=alert(1)>";
		setup(() =>
			json(socialMeal({ comments: [comment({ body })] }, { comment_count: 1 })),
		);

		expect(await screen.findByText(body)).toBeInTheDocument();
		expect(document.querySelector("img[src='x']")).toBeNull();
	});

	it("沒有留言：「還沒有留言」，留言框照樣在", async () => {
		setup(() => json(socialMeal()));

		expect(await screen.findByText("還沒有留言")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: "留言（0）" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("list", { name: "留言" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("textbox", { name: "寫留言" })).toBeInTheDocument();
	});

	it("超過 100 則：寫「只顯示最近 100 則」", async () => {
		setup(() =>
			json(
				socialMeal(
					{ comments: THREE, comments_truncated: true },
					{ comment_count: 140 },
				),
			),
		);
		expect(await screen.findByText("只顯示最近 100 則")).toBeInTheDocument();
		// 標題上是全部的數字，不是畫出來的幾則。
		expect(
			screen.getByRole("heading", { name: "留言（140）" }),
		).toBeInTheDocument();
	});

	it("沒超過 100 則：不寫「只顯示最近 100 則」", async () => {
		setup(() => json(socialMeal({ comments: THREE }, { comment_count: 3 })));

		await screen.findByText("下次一起");
		expect(screen.queryByText("只顯示最近 100 則")).not.toBeInTheDocument();
	});

	it("送出一則：出現在清單最後，標題的數字跟著變", async () => {
		const comments = [...THREE];
		const page = setup(
			() => json(socialMeal({ comments }, { comment_count: comments.length })),
			{
				extra: [
					{
						method: "POST",
						path: `${MEAL_URL}/comments`,
						handler: () => {
							const added = comment({
								id: 34,
								display_name: "愛麗絲",
								is_me: true,
								can_delete: true,
								body: "我也要",
								created_at: "2026-10-06T05:30:00Z",
							});
							comments.push(added);
							return json(added, 201);
						},
					},
				],
			},
		);
		await screen.findByRole("heading", { name: "留言（3）" });

		await userEvent.type(
			screen.getByRole("textbox", { name: "寫留言" }),
			"我也要{Enter}",
		);

		expect(
			await screen.findByRole("heading", { name: "留言（4）" }),
		).toBeInTheDocument();
		const rows = within(
			screen.getByRole("list", { name: "留言" }),
		).getAllByRole("listitem");
		expect(rows.at(-1)).toHaveTextContent("我也要");
		expect(page.sent("POST")).toEqual([`${MEAL_URL}/comments`]);
	});
});

describe("餐點頁：刪留言", () => {
	/** 伺服器上的留言；`DELETE` 怎麼回由每一條測試決定。 */
	function withComments(remove: (id: number) => Response | Promise<Response>) {
		const comments = [...THREE];
		const page = setup(
			() => json(socialMeal({ comments }, { comment_count: comments.length })),
			{
				extra: [
					{
						method: "DELETE",
						path: `${MEAL_URL}/comments/32`,
						handler: () => remove(32),
					},
				],
			},
		);
		return {
			...page,
			/** 伺服器真的把它刪了。 */
			drop: (id: number) => {
				const index = comments.findIndex((item) => item.id === id);
				if (index >= 0) comments.splice(index, 1);
			},
		};
	}

	it("取消：確認框打開時焦點在「取消」；取消之後不送、焦點回到刪除鈕", async () => {
		const page = withComments(() => new Response(null, { status: 204 }));
		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 愛麗絲 的留言" }),
		);

		const dialog = screen.getByRole("alertdialog", { name: "確認刪除留言" });
		const cancel = within(dialog).getByRole("button", { name: "取消" });
		expect(cancel).toHaveFocus();

		await userEvent.click(cancel);

		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(page.sent("DELETE")).toEqual([]);
		expect(
			screen.getByRole("button", { name: "刪除 愛麗絲 的留言" }),
		).toHaveFocus();
		expect(screen.getByText("哪一家的？")).toBeInTheDocument();
	});

	it("確定：送 DELETE，重抓之後那一則不見，焦點在留言的標題上", async () => {
		const page = withComments((id) => {
			page.drop(id);
			return new Response(null, { status: 204 });
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 愛麗絲 的留言" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		await waitFor(() =>
			expect(screen.queryByText("哪一家的？")).not.toBeInTheDocument(),
		);
		expect(page.sent("DELETE")).toEqual([`${MEAL_URL}/comments/32`]);
		// 刪除鈕跟著那一列一起不見了：焦點不能掉到 body。
		const heading = screen.getByRole("heading", { name: "留言（2）" });
		await waitFor(() => expect(heading).toHaveFocus());
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		// 別人的留言還在。
		expect(screen.getByText("看起來不錯")).toBeInTheDocument();
		expect(screen.getByText("下次一起")).toBeInTheDocument();
	});

	it("送出中：「確定刪除」是 aria-disabled（不是 disabled），再按不送第二次；「取消」收不起來", async () => {
		let release: (response: Response) => void = () => {};
		const page = withComments(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 愛麗絲 的留言" }),
		);
		const confirm = screen.getByRole("button", { name: "確定刪除" });
		await userEvent.click(confirm);
		await waitFor(() => expect(page.sent("DELETE")).toHaveLength(1));

		expect(confirm).toHaveAttribute("aria-disabled", "true");
		expect(confirm).not.toHaveAttribute("disabled");
		await userEvent.click(confirm);
		expect(page.sent("DELETE")).toHaveLength(1);
		// 這時候按「取消」：刪除已經送出去了，收起確認框會像是取消成功。
		await userEvent.click(screen.getByRole("button", { name: "取消" }));
		expect(
			screen.getByRole("alertdialog", { name: "確認刪除留言" }),
		).toBeInTheDocument();

		page.drop(32);
		release(new Response(null, { status: 204 }));
		await waitFor(() =>
			expect(screen.queryByText("哪一家的？")).not.toBeInTheDocument(),
		);
	});

	it("失敗：「刪除失敗，請再試一次」，那一則與確認框都還在；再按一次成功", async () => {
		let fail = true;
		const page = withComments((id) => {
			if (fail) return failure(500, "INTERNAL_ERROR", "伺服器錯誤");
			page.drop(id);
			return new Response(null, { status: 204 });
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 愛麗絲 的留言" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"刪除失敗，請再試一次",
		);
		expect(screen.getByText("哪一家的？")).toBeInTheDocument();
		expect(
			screen.getByRole("alertdialog", { name: "確認刪除留言" }),
		).toBeInTheDocument();
		// 失敗不重抓：伺服器上什麼都沒變。
		expect(page.fetches()).toBe(1);

		fail = false;
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		await waitFor(() =>
			expect(screen.queryByText("哪一家的？")).not.toBeInTheDocument(),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("那一則已經不在了（別的裝置刪過，404 COMMENT_NOT_FOUND）：當成刪好了，照樣重抓", async () => {
		const page = withComments((id) => {
			page.drop(id);
			return failure(404, "COMMENT_NOT_FOUND", "找不到這則留言");
		});
		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 愛麗絲 的留言" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		await waitFor(() =>
			expect(screen.queryByText("哪一家的？")).not.toBeInTheDocument(),
		);
		expect(page.fetches()).toBe(2);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		await waitFor(() =>
			expect(screen.getByRole("heading", { name: "留言（2）" })).toHaveFocus(),
		);
	});
});

describe("餐點頁：看不到、載入失敗", () => {
	it("404：「看不到這一餐」與回飲食的連結；只打一次，不重試", async () => {
		const page = setup(() => failure(404, "MEAL_NOT_FOUND", "找不到該餐點"));

		expect(await screen.findByRole("alert")).toHaveTextContent("看不到這一餐");
		expect(
			screen.getByRole("heading", { level: 1, name: "餐點" }),
		).toBeInTheDocument();
		// 為什麼看不到：後端刻意不分是哪一種，所以兩種都說。
		expect(
			screen.getByText("它可能已經刪除了，或是設成只有本人看得到。"),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "回飲食" })).toHaveAttribute(
			"href",
			"/diet",
		);
		expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
		expect(page.fetches()).toBe(1);
	});

	it("快取裡還有這一餐，但重抓是 404（剛被解除好友）：不顯示舊的內容", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retryDelay: 0 } },
		});
		client.setQueryData(
			queryKeys.socialMeal(7),
			socialMeal({ comments: THREE }, { comment_count: 3 }),
		);
		setup(() => failure(404, "MEAL_NOT_FOUND", "找不到該餐點"), { client });

		// 一開始畫的是快取裡的那一份（`staleTime: 0`：同時在重抓）。
		expect(screen.getByText("看起來不錯")).toBeInTheDocument();

		expect(await screen.findByRole("alert")).toHaveTextContent("看不到這一餐");
		expect(screen.queryByText("看起來不錯")).not.toBeInTheDocument();
		expect(screen.queryByText("巷口的排骨便當")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: "寫留言" }),
		).not.toBeInTheDocument();
	});

	it("刪留言時那一餐已經看不到了（404 MEAL_NOT_FOUND）：整頁換成「看不到這一餐」", async () => {
		let gone = false;
		setup(
			() =>
				gone
					? failure(404, "MEAL_NOT_FOUND", "找不到該餐點")
					: json(socialMeal({ comments: THREE }, { comment_count: 3 })),
			{
				extra: [
					{
						method: "DELETE",
						path: `${MEAL_URL}/comments/32`,
						handler: () => {
							gone = true;
							return failure(404, "MEAL_NOT_FOUND", "找不到該餐點");
						},
					},
				],
			},
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 愛麗絲 的留言" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確定刪除" }));

		expect(await screen.findByText("看不到這一餐")).toBeInTheDocument();
		expect(screen.queryByText("刪除失敗，請再試一次")).not.toBeInTheDocument();
	});

	it("送留言時那一餐已經看不到了（404）：整頁換成「看不到這一餐」，不是留著舊的內容", async () => {
		// 開著這一頁的時候被解除好友、或對方把這一餐關起來：留言框回 404。只在框底下
		// 寫一句錯誤的話，上面還是那一餐與所有人的留言——要等回到這個視窗才會換掉。
		let gone = false;
		const page = setup(
			() =>
				gone
					? failure(404, "MEAL_NOT_FOUND", "找不到該餐點")
					: json(socialMeal({ comments: THREE }, { comment_count: 3 })),
			{
				extra: [
					{
						method: "POST",
						path: `${MEAL_URL}/comments`,
						handler: () => {
							gone = true;
							return failure(404, "MEAL_NOT_FOUND", "找不到該餐點");
						},
					},
				],
			},
		);
		await userEvent.type(
			await screen.findByRole("textbox", { name: "寫留言" }),
			"好吃嗎{Enter}",
		);

		expect(await screen.findByText("看不到這一餐")).toBeInTheDocument();
		expect(screen.queryByText("看起來不錯")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("textbox", { name: "寫留言" }),
		).not.toBeInTheDocument();
		expect(page.fetches()).toBe(2);
	});

	it("按讚時那一餐已經看不到了（404）：整頁換成「看不到這一餐」", async () => {
		let gone = false;
		const page = setup(
			() =>
				gone
					? failure(404, "MEAL_NOT_FOUND", "找不到該餐點")
					: json(socialMeal({ comments: THREE }, { comment_count: 3 })),
			{
				extra: [
					{
						method: "PUT",
						path: `${MEAL_URL}/like`,
						handler: () => {
							gone = true;
							return failure(404, "MEAL_NOT_FOUND", "找不到該餐點");
						},
					},
				],
			},
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "讚，鮑伯的午餐" }),
		);

		expect(await screen.findByText("看不到這一餐")).toBeInTheDocument();
		expect(screen.queryByText("看起來不錯")).not.toBeInTheDocument();
		expect(page.fetches()).toBe(2);
	});

	it("按讚失敗但不是 404（429）：這一餐不重抓，錯誤寫在按鈕下面", async () => {
		const page = setup(
			() => json(socialMeal({ comments: THREE }, { comment_count: 3 })),
			{
				extra: [
					{
						method: "PUT",
						path: `${MEAL_URL}/like`,
						handler: () =>
							failure(429, "TOO_MANY_LIKES", "按得太快了，請稍後再試"),
					},
				],
			},
		);
		await userEvent.click(
			await screen.findByRole("button", { name: "讚，鮑伯的午餐" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"按得太快了，請稍後再試",
		);
		expect(screen.getByText("看起來不錯")).toBeInTheDocument();
		expect(page.fetches()).toBe(1);
	});

	it("500 而且沒有快取：「無法載入這一餐」", async () => {
		const page = setup(() => failure(500, "INTERNAL_ERROR", "伺服器錯誤"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"無法載入這一餐",
		);
		expect(screen.queryByText("看不到這一餐")).not.toBeInTheDocument();
		// 不是 404 才重試（1 次＋重試 3 次）。
		expect(page.fetches()).toBe(4);
	});

	it("還在載入：「載入中…」，沒有錯誤", () => {
		setup(() => new Promise<Response>(() => {}));

		expect(screen.getByText("載入中…")).toBeInTheDocument();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it.each(["/meals/abc", "/meals/0", "/meals/1.5", "/meals/-3"])(
		"網址的 id 不是一餐的 id（%s）：看不到這一餐，一個請求都不送",
		(path) => {
			const page = setup(() => json(socialMeal()), { path });

			expect(screen.getByRole("alert")).toHaveTextContent("看不到這一餐");
			expect(page.calls()).toEqual([]);
		},
	);
});
