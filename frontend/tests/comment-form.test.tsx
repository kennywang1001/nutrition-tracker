import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	type MealComment,
	type SocialMeal,
	useSocialMeal,
} from "../src/api/social";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { CommentForm } from "../src/components/CommentForm";
import { json, mockApi } from "./helpers/mock-api";

const MEAL_URL = "/api/social/meals/7";
const COMMENTS_URL = "/api/social/meals/7/comments";

function mealPage(comments: MealComment[]): SocialMeal {
	return {
		meal: {
			id: 7,
			user: { id: 2, display_name: "鮑伯" },
			eaten_at: "2026-10-06T04:00:00Z",
			meal_type: "lunch",
			description: null,
			items: [],
			kcal: "620.00",
			protein_g: "25.00",
			fat_g: "20.00",
			carb_g: "80.00",
			has_photo: false,
			like_count: 0,
			comment_count: comments.length,
			liked_by_me: false,
		},
		is_mine: false,
		likes: [],
		comments,
		comments_truncated: false,
	};
}

function failure(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
) {
	return new Response(
		JSON.stringify({ error: { code, message, details: {} } }),
		{ status, headers: { "content-type": "application/json", ...headers } },
	);
}

/** 餐點頁的最小替身：掛著 `useSocialMeal`（失效之後才會真的重抓）、把留言畫出來，
 *  底下是留言框。旁邊另外一顆按鈕——「送出中焦點移到別的地方」要有地方可以去。 */
function Page() {
	const { data } = useSocialMeal(7);
	return (
		<>
			<ol>
				{data?.comments.map((comment) => (
					<li key={comment.id}>{comment.body}</li>
				))}
			</ol>
			<button type="button">別的地方</button>
			<CommentForm mealId={7} />
		</>
	);
}

type Answer = () => Response | Promise<Response>;

/** `post`：留言的 POST 怎麼回。省略＝伺服器收下來（201），之後的 GET 看得到那一則。 */
function setup(post?: Answer) {
	const comments: MealComment[] = [];
	const spy = mockApi([
		// 越具體的排越前面（`mockApi` 用 includes 依序比對）。
		{
			method: "POST",
			path: COMMENTS_URL,
			handler:
				post ??
				(() => {
					const sent = JSON.parse(String(spy.mock.calls.at(-1)?.[1]?.body)) as {
						body: string;
					};
					const comment: MealComment = {
						id: 40 + comments.length,
						display_name: "愛麗絲",
						is_me: true,
						can_delete: true,
						body: sent.body,
						created_at: "2026-10-06T05:00:00Z",
					};
					comments.push(comment);
					return json(comment, 201);
				}),
		},
		{ method: "GET", path: MEAL_URL, handler: () => json(mealPage(comments)) },
	]);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<Page />
		</QueryClientProvider>,
	);
	const calls = () =>
		spy.mock.calls.map(([url, init]) => ({
			method: (init?.method ?? "GET").toUpperCase(),
			url: String(url),
			body: typeof init?.body === "string" ? init.body : null,
		}));
	return {
		/** 送出去的留言（POST 的 body，原始字串），依先後。 */
		posts: () =>
			calls()
				.filter((call) => call.method === "POST")
				.map((call) => call.body),
		/** 這一餐被抓了幾次（第一次是掛上去的那一次）。 */
		fetches: () =>
			calls().filter((call) => call.method === "GET" && call.url === MEAL_URL)
				.length,
		input: () => screen.getByRole("textbox", { name: "寫留言" }),
		submit: () => screen.getByRole("button", { name: /^送出/ }),
	};
}

/** 一次填進去（不是一個字一個字打：200 個字太慢）。 */
function fill(input: HTMLElement, value: string) {
	fireEvent.change(input, { target: { value } });
}

/** 掛著不回的回應，`answer` 放行。 */
function gate() {
	let release: (response: Response) => void = () => {};
	let waiting = 0;
	return {
		handler: () =>
			new Promise<Response>((resolve) => {
				waiting += 1;
				release = resolve;
			}),
		waiting: () => waiting,
		answer: (response: Response) => release(response),
	};
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("留言框", () => {
	it("空的：送出鍵是 aria-disabled（不是 disabled），按下去不送、焦點到輸入框", async () => {
		const page = setup();
		await waitFor(() => expect(page.fetches()).toBe(1));

		expect(page.submit()).toHaveAttribute("aria-disabled", "true");
		// 原生的 disabled 在按鈕停用的那一刻會把焦點丟掉（Chromium）；jsdom 不會，
		// 所以守的是機制：不是原生的 disabled。
		expect(page.submit()).not.toHaveAttribute("disabled");

		await userEvent.click(page.submit());

		expect(page.posts()).toEqual([]);
		expect(page.input()).toHaveFocus();
	});

	it("只有空白：一樣不能送", async () => {
		const page = setup();
		await userEvent.type(page.input(), "   ");

		expect(page.submit()).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(page.submit());
		await userEvent.type(page.input(), "{Enter}");

		expect(page.posts()).toEqual([]);
		expect(page.input()).toHaveFocus();
	});

	it("剩 20 個字以內才提示還能打幾個字；剛好 200 個字可以送", () => {
		const page = setup();
		const input = page.input();

		fill(input, "字".repeat(179));
		expect(input).toHaveAccessibleDescription("");
		fill(input, "字".repeat(180));
		expect(input).toHaveAccessibleDescription("還可以輸入 20 個字");
		fill(input, "字".repeat(181));
		expect(input).toHaveAccessibleDescription("還可以輸入 19 個字");
		fill(input, "字".repeat(200));
		expect(input).toHaveAccessibleDescription("還可以輸入 0 個字");
		expect(input).toHaveAttribute("aria-invalid", "false");
		expect(page.submit()).toHaveAttribute("aria-disabled", "false");
	});

	it("201 個字：寫超過幾個字、輸入框標成 invalid、不能送", async () => {
		const page = setup();
		fill(page.input(), "字".repeat(201));

		expect(page.input()).toHaveAccessibleDescription("超過 1 個字");
		expect(page.input()).toHaveAttribute("aria-invalid", "true");
		expect(page.submit()).toHaveAttribute("aria-disabled", "true");

		await userEvent.click(page.submit());
		expect(page.posts()).toEqual([]);
		// 字還在：超過了要自己刪，不是被清掉。
		expect(page.input()).toHaveValue("字".repeat(201));
	});

	it("字數用 code point 算：200 個表情符號可以送，201 個是超過 1 個字", async () => {
		// 一個表情符號的 `.length` 是 2：用 UTF-16 的長度算的話 100 個就滿了，
		// 而後端（Python 的 `len`）算的是 200 個。
		const smile = String.fromCodePoint(0x1f600);
		expect(smile.length).toBe(2);
		const page = setup();

		fill(page.input(), smile.repeat(201));
		expect(page.input()).toHaveAccessibleDescription("超過 1 個字");

		fill(page.input(), smile.repeat(200));
		expect(page.input()).toHaveAccessibleDescription("還可以輸入 0 個字");
		expect(page.submit()).toHaveAttribute("aria-disabled", "false");
		await userEvent.click(page.submit());

		await waitFor(() => expect(page.posts()).toHaveLength(1));
		expect(JSON.parse(page.posts()[0] ?? "")).toEqual({
			body: smile.repeat(200),
		});
	});

	it("頭尾的空白不算字數，也不送出去", async () => {
		const page = setup();
		// 前後各 30 個空白：算進去的話是 260 個字。
		fill(page.input(), `${" ".repeat(30)}${"字".repeat(200)}${" ".repeat(30)}`);
		expect(page.input()).toHaveAccessibleDescription("還可以輸入 0 個字");

		fill(page.input(), "  好吃嗎  ");
		await userEvent.click(page.submit());

		await waitFor(() => expect(page.posts()).toEqual(['{"body":"好吃嗎"}']));
	});

	it("送出：清空、焦點留在輸入框、說「已送出」，這一餐重抓一次、新留言出現", async () => {
		const page = setup();
		await waitFor(() => expect(page.fetches()).toBe(1));
		await userEvent.type(page.input(), "好吃嗎");

		// 用點的：焦點在送出鍵上，送完要回到輸入框（Enter 送出的話焦點本來就在輸入框）。
		await userEvent.click(page.submit());

		expect(await screen.findByText("好吃嗎")).toBeInTheDocument();
		expect(page.posts()).toEqual(['{"body":"好吃嗎"}']);
		expect(page.input()).toHaveValue("");
		await waitFor(() => expect(page.input()).toHaveFocus());
		expect(screen.getByRole("status")).toHaveTextContent("已送出");
		expect(page.fetches()).toBe(2);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("「已送出」在開始打下一則時消失", async () => {
		const page = setup();
		await userEvent.type(page.input(), "第一則{Enter}");
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent("已送出"),
		);

		await userEvent.type(page.input(), "第");

		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("按 Enter 送出", async () => {
		const page = setup();
		await userEvent.type(page.input(), "嗨{Enter}");

		expect(await screen.findByText("嗨")).toBeInTheDocument();
		expect(page.posts()).toEqual(['{"body":"嗨"}']);
		expect(page.input()).toHaveValue("");
		expect(page.input()).toHaveFocus();
	});

	it("送出中：送出鍵 aria-disabled、寫「送出中…」，再按、再按 Enter 都不送第二次", async () => {
		const held = gate();
		const page = setup(held.handler);
		await userEvent.type(page.input(), "好吃嗎");
		await userEvent.click(page.submit());
		await waitFor(() => expect(held.waiting()).toBe(1));

		expect(page.submit()).toHaveTextContent("送出中…");
		expect(page.submit()).toHaveAttribute("aria-disabled", "true");
		expect(page.submit()).not.toHaveAttribute("disabled");

		await userEvent.click(page.submit());
		await userEvent.type(page.input(), "{Enter}");

		expect(page.posts()).toHaveLength(1);
		// 送出中輸入框的字還在：失敗的話不用重打。
		expect(page.input()).toHaveValue("好吃嗎");

		held.answer(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));
		await waitFor(() => expect(page.submit()).toHaveTextContent(/^送出$/));
		expect(page.posts()).toHaveLength(1);
	});

	it("429：顯示幾秒後可以再試，字還在、焦點回到輸入框", async () => {
		const page = setup(() =>
			failure(429, "TOO_MANY_COMMENTS", "留言太頻繁，請稍後再試", {
				"retry-after": "30",
			}),
		);
		await userEvent.type(page.input(), "好吃嗎");
		await userEvent.click(page.submit());

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"留言太頻繁，請稍後再試（30 秒後可再試）",
		);
		expect(page.input()).toHaveValue("好吃嗎");
		await waitFor(() => expect(page.input()).toHaveFocus());
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("429 沒有 Retry-After：只顯示訊息，不寫「0 秒」", async () => {
		const page = setup(() =>
			failure(429, "TOO_MANY_COMMENTS", "留言太頻繁，請稍後再試"),
		);
		await userEvent.type(page.input(), "好吃嗎{Enter}");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(/^留言太頻繁，請稍後再試$/);
	});

	it("500：「沒有送出，請再試一次」，字還在；再送一次成功，錯誤消失", async () => {
		let fail = true;
		const comments: string[] = [];
		const page = setup(() => {
			if (fail) return failure(500, "INTERNAL_ERROR", "伺服器錯誤");
			comments.push("ok");
			return json(
				{
					id: 41,
					display_name: "愛麗絲",
					is_me: true,
					can_delete: true,
					body: "好吃嗎",
					created_at: "2026-10-06T05:00:00Z",
				},
				201,
			);
		});
		await userEvent.type(page.input(), "好吃嗎");
		await userEvent.click(page.submit());

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/^沒有送出，請再試一次$/,
		);
		expect(page.input()).toHaveValue("好吃嗎");
		await waitFor(() => expect(page.input()).toHaveFocus());

		fail = false;
		await userEvent.click(page.submit());

		await waitFor(() => expect(page.input()).toHaveValue(""));
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expect(page.posts()).toHaveLength(2);
	});

	it("斷線（連回應都沒有）：一樣是「沒有送出，請再試一次」", async () => {
		const page = setup(() =>
			Promise.reject(new TypeError("network request failed")),
		);
		await userEvent.type(page.input(), "好吃嗎{Enter}");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"沒有送出，請再試一次",
		);
		expect(page.input()).toHaveValue("好吃嗎");
	});

	it("404（剛被解除好友、那一餐關起來了）：說看不到了，不叫人再試", async () => {
		const page = setup(() => failure(404, "MEAL_NOT_FOUND", "找不到該餐點"));
		await userEvent.type(page.input(), "好吃嗎{Enter}");

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("這一餐已經看不到了，沒有送出");
		expect(alert).not.toHaveTextContent("再試");
	});

	it("送出中焦點移到別的地方：送完不把它搶回輸入框", async () => {
		// 送出鍵是 aria-disabled，送出中焦點還在它身上；送完移回輸入框是為了接著打。
		// 但人已經去按別的東西了（例如某一則留言的「刪除」）就不該搶。
		const held = gate();
		const page = setup(held.handler);
		await userEvent.type(page.input(), "好吃嗎");
		await userEvent.click(page.submit());
		await waitFor(() => expect(held.waiting()).toBe(1));

		const elsewhere = screen.getByRole("button", { name: "別的地方" });
		await userEvent.click(elsewhere);
		held.answer(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));

		expect(await screen.findByRole("alert")).toBeInTheDocument();
		expect(elsewhere).toHaveFocus();
	});

	it("還來不及重畫就送出兩次（同一拍裡兩個 submit）：只送一次", async () => {
		// 「送出中」是 state，要等重畫才看得到；同一拍裡的第二個 submit 看到的還是
		// 舊的畫面。擋它的是一個 ref。包在同一個 act 裡：兩個事件之間 React 不重畫。
		const held = gate();
		const page = setup(held.handler);
		fill(page.input(), "好吃嗎");
		const form = page.input().closest("form");
		if (form === null) throw new Error("輸入框不在表單裡");

		act(() => {
			fireEvent.submit(form);
			fireEvent.submit(form);
		});

		await waitFor(() => expect(held.waiting()).toBe(1));
		expect(page.posts()).toHaveLength(1);
	});
});
