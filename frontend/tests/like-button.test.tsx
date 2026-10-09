import {
	QueryClient,
	QueryClientProvider,
	useQuery,
} from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch } from "../src/api/client";
import { required } from "../src/api/friends";
import { queryKeys } from "../src/api/queries";
import type { LikeState, SocialMeal } from "../src/api/social";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LikeButton } from "../src/components/LikeButton";
import { json, mockApi } from "./helpers/mock-api";

const LIKE_URL = "/api/social/meals/7/like";
const MEAL_URL = "/api/social/meals/7";
const NOT_LIKED: LikeState = { like_count: 2, liked_by_me: false };

function mealPage(state: LikeState): SocialMeal {
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
			comment_count: 0,
			...state,
		},
		is_mine: false,
		likes: [],
		comments: [],
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

/** 可以手動放行的回應：請求一進來就掛著，`answer`／`cut` 放行**最早**那一個。
 *  「第一個請求還在路上時再按一下」因此是確定的，不靠時間。 */
function gate() {
	const waiting: Array<{
		resolve: (response: Response) => void;
		reject: (error: unknown) => void;
	}> = [];
	const next = () => {
		const first = waiting.shift();
		if (first === undefined) throw new Error("沒有等著的請求可以放行");
		return first;
	};
	return {
		handler: () =>
			new Promise<Response>((resolve, reject) => {
				waiting.push({ resolve, reject });
			}),
		waiting: () => waiting.length,
		answer: (response: Response) => next().resolve(response),
		/** 連 Response 都沒有：斷線。 */
		cut: () => next().reject(new TypeError("network request failed")),
	};
}

/** 從快取拿 props 的按鈕——跟卡片、餐點頁一樣。這樣才看得到「伺服器的回應有沒有
 *  寫回快取」：寫回了，props 才會變。`staleTime: Infinity`：只有失效才重抓。 */
function FromCache() {
	const { data } = useQuery({
		queryKey: queryKeys.socialMeal(7),
		queryFn: () => required(apiFetch<SocialMeal>(MEAL_URL), "餐點"),
		staleTime: Number.POSITIVE_INFINITY,
	});
	if (data === undefined) return null;
	return (
		<LikeButton
			mealId={7}
			label="鮑伯的午餐"
			count={data.meal.like_count}
			liked={data.meal.liked_by_me}
		/>
	);
}

function setup(initial: LikeState = NOT_LIKED) {
	const likes = gate();
	// 伺服器現在的狀態：放行一個成功的回應時跟著改，之後的 GET（名單重抓）回同一個。
	let server = initial;
	const spy = mockApi([
		// 越具體的排越前面（`mockApi` 用 includes 依序比對）。
		{ path: LIKE_URL, handler: likes.handler },
		{ method: "GET", path: MEAL_URL, handler: () => json(mealPage(server)) },
	]);
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	client.setQueryData(queryKeys.socialMeal(7), mealPage(initial));
	const view = render(
		<QueryClientProvider client={client}>
			<FromCache />
		</QueryClientProvider>,
	);
	const calls = () =>
		spy.mock.calls.map(([url, init]) => ({
			method: (init?.method ?? "GET").toUpperCase(),
			url: String(url),
		}));
	return {
		client,
		view,
		pending: likes.waiting,
		answer(state: LikeState) {
			server = state;
			likes.answer(json(state));
		},
		refuse: (response: Response) => likes.answer(response),
		cut: likes.cut,
		/** 讚的請求的方法，依送出的先後。 */
		methods: () =>
			calls()
				.filter((call) => call.url === LIKE_URL)
				.map((call) => call.method),
		/** 餐點頁被重抓了幾次。 */
		refetches: () => calls().filter((call) => call.url === MEAL_URL).length,
		cached: () => {
			const meal = client.getQueryData<SocialMeal>(
				queryKeys.socialMeal(7),
			)?.meal;
			return { like_count: meal?.like_count, liked_by_me: meal?.liked_by_me };
		},
	};
}

function button() {
	return screen.getByRole("button", { name: "讚，鮑伯的午餐" });
}

/** 畫面上的樣子：按下去了沒、看得到的數字、螢幕閱讀器聽到的數字。 */
function expectShown(pressed: boolean, count: number) {
	expect(
		screen.getByRole("button", { name: "讚，鮑伯的午餐", pressed }),
	).toBeInTheDocument();
	expect(button()).toHaveAccessibleDescription(`${count} 個讚`);
	expect(within(button()).getByText(String(count))).toHaveAttribute(
		"aria-hidden",
		"true",
	);
}

/** 按鈕從現在起顯示過的每一個樣子（連續重複的只記一次）。 */
function watch(target: HTMLElement) {
	const seen: string[] = [];
	const record = () => {
		const now = `${target.getAttribute("aria-pressed")}／${
			within(target).getByText(/個讚$/).textContent
		}`;
		if (seen.at(-1) !== now) seen.push(now);
	};
	const observer = new MutationObserver(record);
	observer.observe(target, {
		attributes: true,
		childList: true,
		characterData: true,
		subtree: true,
	});
	return {
		seen,
		stop: () => {
			record();
			observer.disconnect();
		},
	};
}

/** 讓已經排好的工作（React 的 render、TanStack 的通知）都跑完。 */
async function settle() {
	for (let round = 0; round < 3; round += 1) {
		await new Promise((resolve) => setTimeout(resolve, 0));
	}
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("讚的按鈕", () => {
	it("名稱固定、狀態在 aria-pressed、數字在描述裡", () => {
		setup();

		expectShown(false, 2);
		// 名稱不跟著狀態換（D18）：已經按了的也是同一個名字。
		expect(button()).toHaveAttribute("aria-label", "讚，鮑伯的午餐");
		expect(button()).toHaveAttribute("type", "button");
	});

	it("已經按過的：aria-pressed 是 true，名稱一樣", () => {
		setup({ like_count: 3, liked_by_me: true });

		expectShown(true, 3);
	});

	it("按一下：回應還沒回來，畫面已經變了；只送一個 PUT", async () => {
		const page = setup();

		await userEvent.click(button());

		expectShown(true, 3);
		expect(page.methods()).toEqual(["PUT"]);
		expect(page.pending()).toBe(1);
		// 快取還沒被動到：樂觀的數字只在按鈕自己身上。
		expect(page.cached()).toEqual(NOT_LIKED);
	});

	it("回應回來：寫進快取的是伺服器的數字，不是自己加一；餐點頁的名單重抓一次", async () => {
		const page = setup();
		await userEvent.click(button());
		expectShown(true, 3);

		// 別人也剛按了：伺服器說 5，不是樂觀的 3。
		page.answer({ like_count: 5, liked_by_me: true });

		await waitFor(() =>
			expect(page.cached()).toEqual({ like_count: 5, liked_by_me: true }),
		);
		await waitFor(() => expectShown(true, 5));
		await waitFor(() => expect(page.refetches()).toBe(1));
		expect(page.methods()).toEqual(["PUT"]);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("回應回來的那一刻，畫面不會閃回按之前的樣子", async () => {
		// 伺服器的數字寫進快取之後，props 要等 TanStack 通知（晚一拍）才跟上。
		// 這中間如果把樂觀的狀態直接清掉，按鈕會先退回舊的 props（沒讚、2）再變成新的。
		const page = setup();
		await userEvent.click(button());
		expectShown(true, 3);
		const history = watch(button());

		page.answer({ like_count: 5, liked_by_me: true });
		await waitFor(() => expectShown(true, 5));
		await waitFor(() => expect(page.refetches()).toBe(1));
		await settle();
		history.stop();

		expect(history.seen).toEqual(["true／5 個讚"]);
	});

	it("收回：已經按過的再按一下送 DELETE", async () => {
		const page = setup({ like_count: 3, liked_by_me: true });

		await userEvent.click(button());

		expectShown(false, 2);
		expect(page.methods()).toEqual(["DELETE"]);

		page.answer({ like_count: 2, liked_by_me: false });
		await waitFor(() => expect(page.cached()).toEqual(NOT_LIKED));
		expectShown(false, 2);
	});

	it("樂觀的數字不會變成負的（收到互相矛盾的「按過、0 個」時）", async () => {
		setup({ like_count: 0, liked_by_me: true });

		await userEvent.click(button());

		expectShown(false, 0);
	});

	it("連按兩下：請求一次一個，第一個回來才送第二個；最後是沒讚", async () => {
		const page = setup();

		await userEvent.click(button());
		await userEvent.click(button());

		// 畫面照最後一次按的意圖；第二個請求還沒送。
		expectShown(false, 2);
		await settle();
		expect(page.methods()).toEqual(["PUT"]);
		const history = watch(button());

		page.answer({ like_count: 3, liked_by_me: true });
		await waitFor(() => expect(page.methods()).toEqual(["PUT", "DELETE"]));
		// 第一個回應不寫進快取：伺服器的狀態還會變，中間的值不該讓畫面跳一下。
		expect(page.cached()).toEqual(NOT_LIKED);
		expectShown(false, 2);

		page.answer({ like_count: 2, liked_by_me: false });
		await waitFor(() => expect(page.refetches()).toBe(1));
		await settle();
		history.stop();

		expect(page.methods()).toEqual(["PUT", "DELETE"]);
		expect(page.cached()).toEqual(NOT_LIKED);
		expectShown(false, 2);
		// 從第二下之後，畫面一直是「沒讚、2」——沒有被中間那個回應帶去「讚、3」。
		expect(history.seen).toEqual(["false／2 個讚"]);
	});

	it("連按兩下收回再按：最後是讚，第二個請求是 PUT", async () => {
		const page = setup({ like_count: 3, liked_by_me: true });

		await userEvent.click(button());
		await userEvent.click(button());
		expectShown(true, 3);

		page.answer({ like_count: 2, liked_by_me: false });
		await waitFor(() => expect(page.methods()).toEqual(["DELETE", "PUT"]));
		page.answer({ like_count: 3, liked_by_me: true });

		await waitFor(() => expect(page.refetches()).toBe(1));
		expect(page.cached()).toEqual({ like_count: 3, liked_by_me: true });
		expectShown(true, 3);
	});

	it("連按三下：最後的意圖跟伺服器已經一樣，不再送", async () => {
		const page = setup();

		await userEvent.click(button());
		await userEvent.click(button());
		await userEvent.click(button());
		expectShown(true, 3);
		expect(page.methods()).toEqual(["PUT"]);

		page.answer({ like_count: 3, liked_by_me: true });

		await waitFor(() =>
			expect(page.cached()).toEqual({ like_count: 3, liked_by_me: true }),
		);
		await waitFor(() => expect(page.refetches()).toBe(1));
		await settle();
		// 中間那個「收回」沒有送，最後那個「讚」伺服器已經是了（規格 D19：不一樣才再送）。
		expect(page.methods()).toEqual(["PUT"]);
		expect(page.pending()).toBe(0);
		expectShown(true, 3);
	});

	it("第二個請求還在路上時又按一下：等它回來再送第三個", async () => {
		const page = setup();

		await userEvent.click(button());
		await userEvent.click(button());
		page.answer({ like_count: 3, liked_by_me: true });
		await waitFor(() => expect(page.methods()).toEqual(["PUT", "DELETE"]));

		await userEvent.click(button());
		expectShown(true, 3);
		await settle();
		expect(page.methods()).toEqual(["PUT", "DELETE"]);

		page.answer({ like_count: 2, liked_by_me: false });
		await waitFor(() =>
			expect(page.methods()).toEqual(["PUT", "DELETE", "PUT"]),
		);
		page.answer({ like_count: 3, liked_by_me: true });

		await waitFor(() =>
			expect(page.cached()).toEqual({ like_count: 3, liked_by_me: true }),
		);
		expectShown(true, 3);
	});

	it("失敗（500）：先看到錯誤，畫面退回沒讚；快取沒被動到", async () => {
		const page = setup();
		await userEvent.click(button());
		expectShown(true, 3);

		page.refuse(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"沒有送出，請再試一次",
		);
		expectShown(false, 2);
		expect(page.cached()).toEqual(NOT_LIKED);
		// 一個都沒成功：沒有東西要重抓。
		await settle();
		expect(page.refetches()).toBe(0);
	});

	it("斷線：同一句話", async () => {
		const page = setup();
		await userEvent.click(button());

		page.cut();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"沒有送出，請再試一次",
		);
		expectShown(false, 2);
	});

	it("429：伺服器的話，加上幾秒後可以再試", async () => {
		const page = setup();
		await userEvent.click(button());

		page.refuse(
			failure(429, "TOO_MANY_LIKES", "按得太快了，請稍後再試", {
				"retry-after": "12",
			}),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/^按得太快了，請稍後再試（12 秒後可再試）$/,
		);
		expectShown(false, 2);
	});

	it("429 沒有 Retry-After：只有伺服器的話，不寫「0 秒」", async () => {
		const page = setup();
		await userEvent.click(button());

		page.refuse(failure(429, "TOO_MANY_LIKES", "按得太快了，請稍後再試"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/^按得太快了，請稍後再試$/,
		);
	});

	it("404（剛被解除好友、或那一餐關起來了）：不叫人再試一次", async () => {
		const page = setup();
		await userEvent.click(button());

		page.refuse(failure(404, "MEAL_NOT_FOUND", "找不到該餐點"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			/^這一餐已經看不到了$/,
		);
		expectShown(false, 2);
	});

	it("第二個請求失敗：畫面與快取停在伺服器現在的狀態（第一個的回應），不是一開始的", async () => {
		const page = setup();
		await userEvent.click(button());
		await userEvent.click(button());
		expectShown(false, 2);

		page.answer({ like_count: 3, liked_by_me: true });
		await waitFor(() => expect(page.methods()).toEqual(["PUT", "DELETE"]));
		page.refuse(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"沒有送出，請再試一次",
		);
		// 收回沒有成功：伺服器上還是讚。
		await waitFor(() =>
			expect(page.cached()).toEqual({ like_count: 3, liked_by_me: true }),
		);
		await waitFor(() => expectShown(true, 3));
	});

	it("失敗之後還有沒送的意圖：丟掉，不會自己再送", async () => {
		const page = setup();
		await userEvent.click(button());
		await userEvent.click(button());
		await userEvent.click(button());

		page.refuse(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));

		await screen.findByRole("alert");
		await settle();
		expect(page.methods()).toEqual(["PUT"]);
		expect(page.pending()).toBe(0);
		expectShown(false, 2);
	});

	it("失敗之後再按一下：錯誤馬上清掉，成功之後也不回來", async () => {
		const page = setup();
		await userEvent.click(button());
		page.refuse(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));
		await screen.findByRole("alert");

		await userEvent.click(button());

		// 回應還沒回來，上一次的錯誤已經不在了。
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expectShown(true, 3);
		expect(page.methods()).toEqual(["PUT", "PUT"]);

		page.answer({ like_count: 3, liked_by_me: true });
		await waitFor(() =>
			expect(page.cached()).toEqual({ like_count: 3, liked_by_me: true }),
		);
		await settle();
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
		expectShown(true, 3);
	});

	it("按鈕從來不會變成不能按：送出中、失敗之後都一樣", async () => {
		const page = setup();
		const usable = () => {
			expect(button()).toBeEnabled();
			expect(button()).not.toHaveAttribute("disabled");
			expect(button()).not.toHaveAttribute("aria-disabled");
		};
		usable();

		await userEvent.click(button());
		usable();

		page.refuse(failure(500, "INTERNAL_ERROR", "伺服器錯誤"));
		await screen.findByRole("alert");
		usable();
	});

	it("按了就離開畫面：回應回來照樣寫進快取", async () => {
		const page = setup();
		await userEvent.click(button());

		page.view.unmount();
		page.answer({ like_count: 3, liked_by_me: true });

		await waitFor(() =>
			expect(page.cached()).toEqual({ like_count: 3, liked_by_me: true }),
		);
	});

	it("props 不是從那幾份快取來的：成功之後顯示伺服器的數字，直到 props 自己變了", async () => {
		const likes = gate();
		mockApi([{ path: LIKE_URL, handler: likes.handler }]);
		const client = new QueryClient();
		const show = (count: number, liked: boolean) => (
			<QueryClientProvider client={client}>
				<LikeButton mealId={7} label="鮑伯的午餐" count={count} liked={liked} />
			</QueryClientProvider>
		);
		const view = render(show(2, false));

		await userEvent.click(button());
		likes.answer(json({ like_count: 5, liked_by_me: true }));

		// 沒有任何快取會把 props 換掉：按鈕自己記得伺服器說的。
		await waitFor(() => expectShown(true, 5));
		await settle();
		expectShown(true, 5);

		// 上層後來拿到更新的數字（例如清單重抓了）：照 props。
		view.rerender(show(7, true));
		expectShown(true, 7);
		view.rerender(show(6, false));
		expectShown(false, 6);
	});

	it("送出中 props 變了（清單剛好重抓回來）：畫面仍然照按的意圖，回應回來才換成伺服器的", async () => {
		const likes = gate();
		mockApi([{ path: LIKE_URL, handler: likes.handler }]);
		const client = new QueryClient();
		const show = (count: number, liked: boolean) => (
			<QueryClientProvider client={client}>
				<LikeButton mealId={7} label="鮑伯的午餐" count={count} liked={liked} />
			</QueryClientProvider>
		);
		const view = render(show(2, false));

		await userEvent.click(button());
		expectShown(true, 3);

		// 重抓回來的是按之前的快照（別人多按了一個）：不該把剛按的讚蓋掉。
		view.rerender(show(4, false));
		expectShown(true, 3);

		likes.answer(json({ like_count: 5, liked_by_me: true }));
		await waitFor(() => expectShown(true, 5));
	});
});
