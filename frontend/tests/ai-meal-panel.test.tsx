import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { AiMealPanel } from "../src/components/AiMealPanel";
import { json, mockApi, type Route } from "./helpers/mock-api";

// 照片會先經過 shrinkToLongestEdge。**回另一個 File**：這樣才分得出交回的是
// 原始的那一張，還是縮過的（handover §6 第 51 種）。
const SHRUNK = new File(["shrunk"], "shrunk.jpg", { type: "image/jpeg" });
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn(() => Promise.resolve(SHRUNK)),
}));

// 白飯：食物庫有同名的，而且熱量跟 AI 估的不同（260 對 280）——分得出清單上顯示的
// 是哪一個。滷雞腿：食物庫沒有。
const RICE = {
	name: "白飯",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "200.00",
		kcal: "140.00",
		protein_g: "2.50",
		fat_g: "0.25",
		carb_g: "31.00",
		serving_kcal: "280.00",
		serving_protein_g: "5.00",
		serving_fat_g: "0.50",
		serving_carb_g: "62.00",
	},
	confidence: "0.80",
	consistency: { atwater_kcal: "272.50", deviation: "7.50", flagged: false },
	library_food: {
		food_id: 7,
		name: "白飯",
		base_unit: "g",
		serving_kcal: "260.00",
	},
};

const CHICKEN = {
	name: "滷雞腿",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "150.00",
		kcal: "200.00",
		protein_g: "18.00",
		fat_g: "13.33",
		carb_g: "2.00",
		serving_kcal: "300.00",
		serving_protein_g: "27.00",
		serving_fat_g: "20.00",
		serving_carb_g: "3.00",
	},
	confidence: "0.60",
	consistency: { atwater_kcal: "300.00", deviation: "0.00", flagged: false },
	library_food: null,
};

const ESTIMATE = {
	analysis_id: 41,
	description: "一碗白飯、滷雞腿一隻",
	items: [RICE, CHICKEN],
	remaining_today: 18,
};

const LIBRARY_RICE = {
	id: 7,
	name: "白飯",
	brand: null,
	is_global: true,
	nutrition: {
		base_unit: "g",
		kcal: "130.00",
		protein_g: "2.50",
		fat_g: "0.30",
		carb_g: "28.00",
	},
};

const CREATED_CHICKEN = {
	id: 30,
	name: "滷雞腿",
	brand: null,
	is_global: false,
	nutrition: {
		base_unit: "g",
		kcal: "200.00",
		protein_g: "18.00",
		fat_g: "13.33",
		carb_g: "2.00",
	},
};

function serverError() {
	return json(
		{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
		500,
	);
}

function apiError(status: number, code: string, message: string) {
	return json({ error: { code, message, details: {} } }, status);
}

type Options = {
	estimate?: () => Response;
	/** `POST /api/foods`。 */
	createFood?: () => Response | Promise<Response>;
	/** `GET /api/foods?q=`（改名之後的同名檢查）。 */
	search?: () => Response;
	extra?: Route[];
};

/** 路徑順序：mockApi 依序用 `url.includes` 比對，具體的排前面。
 *  **沒有 `/api/ai/analyze` 的路由**——這個面板打到單樣端點的話，mock 會直接炸
 *  （`/api/ai/analyze-meal` 這個路徑只接得住它自己）。 */
function mockPanel(options: Options = {}) {
	return mockApi([
		...(options.extra ?? []),
		{
			method: "POST",
			path: "/api/ai/analyze-meal",
			handler: options.estimate ?? (() => json(ESTIMATE)),
		},
		{
			method: "GET",
			path: "/api/foods?q=",
			handler: options.search ?? (() => json([])),
		},
		{ method: "GET", path: "/api/foods/7", handler: () => json(LIBRARY_RICE) },
		{
			method: "GET",
			path: "/api/foods/30",
			handler: () => json(CREATED_CHICKEN),
		},
		{
			method: "POST",
			path: "/api/foods",
			handler: options.createFood ?? (() => json(CREATED_CHICKEN, 201)),
		},
	]);
}

type FetchMock = ReturnType<typeof mockApi>;

function calls(fetchMock: FetchMock, method: string, path: string) {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes(path),
	);
}

function createdBodies(fetchMock: FetchMock): Array<Record<string, unknown>> {
	return fetchMock.mock.calls
		.filter(
			([input, init]) =>
				(init?.method ?? "GET").toUpperCase() === "POST" &&
				String(input).endsWith("/api/foods"),
		)
		.map(([, init]) => JSON.parse(String(init?.body)));
}

function renderPanel(text = "雞腿便當") {
	const onFoodPicked = vi.fn();
	const onItemsReady = vi.fn();
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const { unmount } = render(
		<QueryClientProvider client={client}>
			<AiMealPanel
				text={text}
				onFoodPicked={onFoodPicked}
				onItemsReady={onItemsReady}
			/>
		</QueryClientProvider>,
	);
	return { onFoodPicked, onItemsReady, unmount };
}

/** 按文字估算，等清單出來。 */
async function estimate(text = "雞腿便當") {
	await userEvent.click(
		screen.getByRole("button", { name: `用 AI 估算「${text}」` }),
	);
	return screen.findByRole("region", { name: "AI 估算結果" });
}

function checkbox(name: RegExp) {
	return screen.getByRole("checkbox", { name });
}

/** 等到面板收起：勾著的都加入了、食物已經交回。 */
async function waitUntilClosed() {
	await waitFor(() =>
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument(),
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("AI 多樣估算面板：清單", () => {
	it("文字估算打 /api/ai/analyze-meal；清單有描述、每一樣的量與熱量、今天還能用幾次", async () => {
		const fetchMock = mockPanel();
		renderPanel();

		const card = await estimate();

		const [call] = calls(fetchMock, "POST", "/api/ai/analyze-meal");
		expect(String(call?.[0])).toBe("/api/ai/analyze-meal");
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			kind: "text",
			text: "雞腿便當",
		});
		expect(within(card).getByText("一碗白飯、滷雞腿一隻")).toBeInTheDocument();
		expect(within(card).getByText("今天還能用 18 次")).toBeInTheDocument();
		// 白飯用食物庫的：顯示的是食物庫的 260，不是 AI 的 280。
		expect(checkbox(/^白飯 200 g · 260 kcal$/)).toBeChecked();
		expect(checkbox(/^滷雞腿 150 g · 300 kcal$/)).toBeChecked();
		expect(within(card).getAllByText("用食物庫的")).toHaveLength(1);
		expect(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		).toHaveAttribute("aria-disabled", "false");
		// 不顯示模型自己說的信心值。
		expect(card).not.toHaveTextContent("0.8");
	});

	it("一致性有疑慮的那一樣標出來；用食物庫的那一樣不標（記下去的不是 AI 的數字）", async () => {
		const flagged = {
			atwater_kcal: "100.00",
			deviation: "200.00",
			flagged: true,
		};
		mockPanel({
			estimate: () =>
				json({
					...ESTIMATE,
					items: [
						{ ...RICE, consistency: flagged },
						{ ...CHICKEN, consistency: flagged },
					],
				}),
		});
		renderPanel();

		const card = await estimate();

		expect(
			within(card).getAllByText("⚠ 熱量跟三大營養素對不太起來，建議看一眼"),
		).toHaveLength(1);
	});

	it("取消勾選的那一樣不算在「加入這 N 樣」裡；全部取消就不能按", async () => {
		const fetchMock = mockPanel();
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(checkbox(/^滷雞腿/));
		expect(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		).toBeInTheDocument();
		await userEvent.click(checkbox(/^白飯/));

		const add = within(card).getByRole("button", { name: "加入這 0 樣" });
		expect(add).toHaveAttribute("aria-disabled", "true");
		// aria-disabled 不擋點擊：點了也不能有任何事發生。
		await userEvent.click(add);
		expect(calls(fetchMock, "GET", "/api/foods/")).toHaveLength(0);
		expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(0);
		expect(onItemsReady).not.toHaveBeenCalled();
	});

	it("「收起」清掉結果，不建任何東西", async () => {
		const fetchMock = mockPanel();
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(within(card).getByRole("button", { name: "收起" }));

		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument();
		expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(0);
		expect(onItemsReady).not.toHaveBeenCalled();
	});
});

describe("AI 多樣估算面板：加入", () => {
	it("用食物庫的那一樣拿食物庫的食物（不建）；其餘各建一個私人食物；一次交回", async () => {
		const fetchMock = mockPanel();
		const { onItemsReady, onFoodPicked } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(1);
		// 只建了一個：滷雞腿。內容跟單樣流程的「確認」同一個形狀。
		expect(createdBodies(fetchMock)).toEqual([
			{
				name: "滷雞腿",
				brand: null,
				nutrition: {
					base_unit: "g",
					kcal: "200.00",
					protein_g: "18.00",
					fat_g: "13.33",
					carb_g: "2.00",
				},
				default_portion: { label: "一份", grams: "150.00" },
				source: "ai",
				ai_confidence: "0.60",
				ai_raw_response: {
					analysis_id: 41,
					food_id: null,
					name: "滷雞腿",
					brand: null,
					nutrition: CHICKEN.nutrition,
					confidence: "0.60",
					consistency: CHICKEN.consistency,
					remaining_today: 18,
				},
			},
		]);
		expect(onItemsReady).toHaveBeenCalledTimes(1);
		expect(onItemsReady).toHaveBeenCalledWith(
			[
				{ food: LIBRARY_RICE, quantity: "200" },
				{ food: CREATED_CHICKEN, quantity: "150" },
			],
			{ image: null, description: "一碗白飯、滷雞腿一隻" },
		);
		expect(onFoodPicked).not.toHaveBeenCalled();
	});

	it("沒勾的那一樣不會被加入，也不會被建成食物", async () => {
		const fetchMock = mockPanel();
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(checkbox(/^滷雞腿/));
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toEqual([]);
		expect(onItemsReady).toHaveBeenCalledWith(
			[{ food: LIBRARY_RICE, quantity: "200" }],
			expect.anything(),
		);
	});

	it("「改用 AI 的數字」：那一樣改成建一個食物，用的是 AI 的營養素；焦點到它的「修改」", async () => {
		const fetchMock = mockPanel({
			createFood: () =>
				json({ ...LIBRARY_RICE, id: 31, is_global: false }, 201),
		});
		renderPanel();
		const card = await estimate();
		await userEvent.click(checkbox(/^滷雞腿/));

		await userEvent.click(
			within(card).getByRole("button", { name: "白飯：改用 AI 的數字" }),
		);

		expect(within(card).queryByText("用食物庫的")).not.toBeInTheDocument();
		expect(checkbox(/^白飯 200 g · 280 kcal$/)).toBeChecked();
		expect(
			within(card).getByRole("button", { name: "修改 白飯" }),
		).toHaveFocus();
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		await waitUntilClosed();
		expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(0);
		expect(createdBodies(fetchMock)).toMatchObject([
			{ name: "白飯", source: "ai", nutrition: { kcal: "140.00" } },
		]);
	});

	it("拍照估算：交回的是原始的那一張照片，不是縮過的", async () => {
		const fetchMock = mockPanel();
		const { onItemsReady } = renderPanel("");
		const photo = new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		const card = await screen.findByRole("region", { name: "AI 估算結果" });
		// 送去估算的是縮過的那一張。
		const [call] = calls(fetchMock, "POST", "/api/ai/analyze-meal");
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			kind: "image",
			image_base64: btoa("shrunk"),
		});
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(onItemsReady.mock.calls[0]?.[1].image).toBe(photo);
	});

	it("同一輪有兩樣同名：只建一次，兩樣用同一個食物", async () => {
		const egg = { ...CHICKEN, name: "滷蛋" };
		const created = { ...CREATED_CHICKEN, id: 32, name: "滷蛋" };
		const fetchMock = mockPanel({
			estimate: () =>
				json({
					...ESTIMATE,
					items: [
						egg,
						{
							...egg,
							name: " 滷蛋 ",
							nutrition: { ...egg.nutrition, serving_grams: "55.00" },
						},
					],
				}),
			createFood: () => json(created, 201),
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toHaveLength(1);
		expect(onItemsReady).toHaveBeenCalledWith(
			[
				{ food: created, quantity: "150" },
				{ food: created, quantity: "55" },
			],
			expect.anything(),
		);
	});

	it("連按兩下只跑一輪：每一樣只建一次、只交回一次", async () => {
		let release: (response: Response) => void = () => {};
		const fetchMock = mockPanel({
			createFood: () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();
		const add = within(card).getByRole("button", { name: "加入這 2 樣" });

		// **同一個 act 裡點兩下**：兩下之間 React 沒有重畫，第二下的 handler 看到的
		// `adding` 還是 false——擋它的只有 ref。分開點（兩次 fireEvent）的話，React 在
		// 兩下之間就重畫了，`adding` 自己擋得住，拿掉 ref 這條測試照樣綠（寫計畫時
		// 實測：突變存活）。
		act(() => {
			add.click();
			add.click();
		});
		// 跑的時候：按鈕是 aria-disabled（它正在焦點上，不用原生 disabled）、勾選框停用。
		await waitFor(() =>
			expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(1),
		);
		const running = within(card).getByRole("button", { name: "加入中…" });
		expect(running).toHaveAttribute("aria-disabled", "true");
		expect(running).not.toBeDisabled();
		expect(checkbox(/^滷雞腿/)).toBeDisabled();
		expect(screen.getByRole("status")).toHaveTextContent("加入中…");
		// 跑到一半再點一次也不會開第二輪。
		fireEvent.click(running);
		release(json(CREATED_CHICKEN, 201));
		await waitUntilClosed();

		expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(1);
		expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(1);
		expect(onItemsReady).toHaveBeenCalledTimes(1);
	});

	it("加入到一半就離開畫面：之後才建好的食物不再交回", async () => {
		let release: (response: Response) => void = () => {};
		const fetchMock = mockPanel({
			createFood: () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		});
		const { onItemsReady, unmount } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitFor(() =>
			expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(1),
		);
		unmount();
		const response = json(CREATED_CHICKEN, 201);
		release(response);
		// 先等「如果會交回，這時候已經交回了」的訊號（handover §6 第 41 種）：回應的
		// 內容被讀走＝建食物那一步跑完了，再讓剩下的 microtask 跑完。
		await waitFor(() => expect(response.bodyUsed).toBe(true));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		expect(onItemsReady).not.toHaveBeenCalled();
	});

	it("加入到一半就離開畫面：還沒輪到的那幾樣不再建食物、也不再讀食物庫", async () => {
		// 三樣依序：滷雞腿（建）、滷蛋（建）、白飯（讀食物庫）。第一樣建到一半時離開。
		// 上一條守的是「不再交回」；這一條守的是「不再往下做」——交回擋住了，但迴圈
		// 照樣跑完的話，剩下的每一樣都會留下一個沒有人要的私人食物（審查 M3）。
		const egg = { ...CHICKEN, name: "滷蛋" };
		let release: (response: Response) => void = () => {};
		const fetchMock = mockPanel({
			estimate: () => json({ ...ESTIMATE, items: [CHICKEN, egg, RICE] }),
			createFood: () =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		});
		const { onItemsReady, unmount } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 3 樣" }),
		);
		await waitFor(() =>
			expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(1),
		);
		unmount();
		const response = json(CREATED_CHICKEN, 201);
		release(response);
		// 同上一條：等第一樣那一步跑完，再讓「如果會往下做」的那些請求有機會送出去。
		await waitFor(() => expect(response.bodyUsed).toBe(true));
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});
		await act(async () => {
			await new Promise((resolve) => setTimeout(resolve, 0));
		});

		// 已經送出去的那一個收不回來；之後沒有第二個 POST，也沒有去讀食物庫。
		expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(1);
		expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(0);
		expect(onItemsReady).not.toHaveBeenCalled();
	});

	it.each([
		["第二樣", 1],
		["第一樣", 0],
	])(
		"兩樣同名，%s改用 AI 的數字、另一樣用食物庫的：各用各的，不共用",
		async (_which, switched) => {
			// 同名只是名稱一樣，選擇是一樣一樣做的（審查 M4）：按了「改用 AI 的數字」的那
			// 一樣要建一個食物、用 AI 的營養素；另一樣要拿食物庫的那一筆。之前這一輪
			// 先做的那一樣會被後面同名的那一樣悄悄沿用。
			const small = {
				...RICE,
				nutrition: { ...RICE.nutrition, serving_grams: "80.00" },
			};
			const createdRice = { ...CREATED_CHICKEN, id: 33, name: "白飯" };
			const fetchMock = mockPanel({
				estimate: () => json({ ...ESTIMATE, items: [RICE, small] }),
				createFood: () => json(createdRice, 201),
			});
			const { onItemsReady } = renderPanel();
			const card = await estimate();

			const useAi = within(card).getAllByRole("button", {
				name: "白飯：改用 AI 的數字",
			})[switched];
			if (useAi === undefined) throw new Error("沒有那一顆「改用 AI 的數字」");
			await userEvent.click(useAi);
			await userEvent.click(
				within(card).getByRole("button", { name: "加入這 2 樣" }),
			);
			await waitUntilClosed();

			// 各一次：食物庫的那一樣讀食物庫，改用 AI 的那一樣建一個（AI 的每 100 是 140）。
			expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(1);
			expect(createdBodies(fetchMock)).toHaveLength(1);
			expect(createdBodies(fetchMock)[0]).toMatchObject({
				name: "白飯",
				nutrition: { kcal: "140.00" },
			});
			const expected =
				switched === 1
					? [
							{ food: LIBRARY_RICE, quantity: "200" },
							{ food: createdRice, quantity: "80" },
						]
					: [
							{ food: createdRice, quantity: "200" },
							{ food: LIBRARY_RICE, quantity: "80" },
						];
			expect(onItemsReady).toHaveBeenCalledWith(expected, expect.anything());
		},
	);

	it("兩樣同名都用食物庫的：兩樣都拿食物庫的那一筆，不建", async () => {
		const small = {
			...RICE,
			nutrition: { ...RICE.nutrition, serving_grams: "80.00" },
		};
		const fetchMock = mockPanel({
			estimate: () => json({ ...ESTIMATE, items: [RICE, small] }),
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toEqual([]);
		expect(onItemsReady).toHaveBeenCalledWith(
			[
				{ food: LIBRARY_RICE, quantity: "200" },
				{ food: LIBRARY_RICE, quantity: "80" },
			],
			expect.anything(),
		);
	});

	it("改名之後跟同一輪剛建好的那一樣同名：直接用那一個，不問、不再建", async () => {
		// 滷蛋先建好；滷雞腿改名成「滷蛋」。這時去查同名會查到剛建的那一個——
		// 那不是「食物庫裡已經有」，是這一輪自己建的：沿用它，不停下來問。
		const egg = { ...CHICKEN, name: "滷蛋" };
		const createdEgg = { ...CREATED_CHICKEN, id: 32, name: "滷蛋" };
		const fetchMock = mockPanel({
			estimate: () => json({ ...ESTIMATE, items: [egg, CHICKEN] }),
			createFood: () => json(createdEgg, 201),
			search: () => json([createdEgg]),
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "修改 滷雞腿" }),
		);
		const form = within(card).getByRole("form", { name: "修改 滷雞腿" });
		const name = within(form).getByLabelText("食物名稱");
		await userEvent.clear(name);
		await userEvent.type(name, "滷蛋");
		await userEvent.click(within(form).getByRole("button", { name: "套用" }));
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toHaveLength(1);
		expect(calls(fetchMock, "GET", "/api/foods?q=")).toHaveLength(0);
		expect(onItemsReady).toHaveBeenCalledWith(
			[
				{ food: createdEgg, quantity: "150" },
				{ food: createdEgg, quantity: "150" },
			],
			expect.anything(),
		);
	});
});

describe("AI 多樣估算面板：部分失敗", () => {
	it("一樣失敗：成功的照樣交回並標「已加入」，失敗的留著；再按一次只做失敗的那一樣", async () => {
		let attempts = 0;
		const fetchMock = mockPanel({
			createFood: () => {
				attempts += 1;
				return attempts === 1 ? serverError() : json(CREATED_CHICKEN, 201);
			},
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);

		expect(
			await within(card).findByText("存成食物失敗，請再試一次"),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(
			"已加入 1 樣，1 樣沒有成功",
		);
		expect(onItemsReady).toHaveBeenCalledTimes(1);
		expect(onItemsReady).toHaveBeenLastCalledWith(
			[{ food: LIBRARY_RICE, quantity: "200" }],
			expect.anything(),
		);
		// 白飯：已加入，不能再勾、不能再改。
		expect(within(card).getByText("已加入")).toBeInTheDocument();
		expect(checkbox(/^白飯/)).toBeDisabled();
		expect(
			within(card).queryByRole("button", { name: "白飯：改用 AI 的數字" }),
		).not.toBeInTheDocument();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		await waitUntilClosed();

		// 白飯沒有被再拿一次；滷雞腿建了兩次（第一次失敗）。
		expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(1);
		expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(2);
		expect(onItemsReady).toHaveBeenCalledTimes(2);
		expect(onItemsReady).toHaveBeenLastCalledWith(
			[{ food: CREATED_CHICKEN, quantity: "150" }],
			{ image: null, description: "一碗白飯、滷雞腿一隻" },
		);
	});

	it("讀食物庫的那一筆失敗：說的是讀取失敗，不是存成食物失敗", async () => {
		mockPanel({
			extra: [{ method: "GET", path: "/api/foods/7", handler: serverError }],
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);

		expect(
			await within(card).findByText("讀取食物失敗，請再試一次"),
		).toBeInTheDocument();
		// 另一樣照樣加入。
		expect(onItemsReady).toHaveBeenCalledWith(
			[{ food: CREATED_CHICKEN, quantity: "150" }],
			expect.anything(),
		);
	});

	it("撞到自己的同名食物（409）：「用現有的」拿那一筆，不再建", async () => {
		const fetchMock = mockPanel({
			createFood: () =>
				json(
					{
						error: {
							code: "FOOD_EXISTS",
							message: "你已經建過同名的食物了",
							details: { food_id: 30 },
						},
					},
					409,
				),
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);

		expect(
			await within(card).findByText("你已經有「滷雞腿」了"),
		).toBeInTheDocument();
		expect(
			within(card).getByRole("button", { name: "改名" }),
		).toBeInTheDocument();
		await userEvent.click(
			within(card).getByRole("button", { name: "用現有的" }),
		);
		await waitUntilClosed();

		expect(calls(fetchMock, "GET", "/api/foods/30")).toHaveLength(1);
		expect(calls(fetchMock, "POST", "/api/foods")).toHaveLength(1);
		expect(onItemsReady).toHaveBeenLastCalledWith(
			[{ food: CREATED_CHICKEN, quantity: "150" }],
			expect.anything(),
		);
	});

	it("撞到自己的同名食物：「改名」開修改表單，改完再加入就建得出來", async () => {
		let attempts = 0;
		const renamed = { ...CREATED_CHICKEN, id: 33, name: "滷雞腿（便當店）" };
		const fetchMock = mockPanel({
			createFood: () => {
				attempts += 1;
				return attempts === 1
					? json(
							{
								error: {
									code: "FOOD_EXISTS",
									message: "你已經建過同名的食物了",
									details: { food_id: 30 },
								},
							},
							409,
						)
					: json(renamed, 201);
			},
		});
		const { onItemsReady } = renderPanel();
		const card = await estimate();
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);

		await userEvent.click(
			await within(card).findByRole("button", { name: "改名" }),
		);
		const name = within(card).getByLabelText("食物名稱");
		expect(name).toHaveFocus();
		await userEvent.clear(name);
		await userEvent.type(name, "滷雞腿（便當店）");
		await userEvent.click(within(card).getByRole("button", { name: "套用" }));
		// 改過就不是剛才問的那一樣了：提問收起來。
		expect(
			within(card).queryByText("你已經有「滷雞腿」了"),
		).not.toBeInTheDocument();
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)[1]).toMatchObject({
			name: "滷雞腿（便當店）",
			source: "user",
		});
		expect(onItemsReady).toHaveBeenLastCalledWith(
			[{ food: renamed, quantity: "150" }],
			expect.anything(),
		);
	});
});

describe("AI 多樣估算面板：修改一樣", () => {
	async function openChickenForm() {
		const card = await estimate();
		await userEvent.click(
			within(card).getByRole("button", { name: "修改 滷雞腿" }),
		);
		return {
			card,
			form: within(card).getByRole("form", { name: "修改 滷雞腿" }),
		};
	}

	async function retype(form: HTMLElement, label: string, value: string) {
		const field = within(form).getByLabelText(label);
		await userEvent.clear(field);
		await userEvent.type(field, value);
	}

	it("開表單焦點到「食物名稱」；套用之後清單顯示改過的值，加入時送的每一個欄位都是改過的", async () => {
		const created = { ...CREATED_CHICKEN, id: 34, name: "烤雞腿" };
		const fetchMock = mockPanel({ createFood: () => json(created, 201) });
		const { onItemsReady } = renderPanel();
		const { card, form } = await openChickenForm();

		expect(within(form).getByLabelText("食物名稱")).toHaveFocus();
		// 表單的初始值是 AI 的那一組。
		expect(within(form).getByLabelText("一份的重量（g）")).toHaveValue("150");
		// **每一個欄位都改**（handover §6 第 52 種）：只改一個的話，其他欄位送 AI 的原值
		// 也看不出來。
		await retype(form, "食物名稱", "烤雞腿");
		await retype(form, "一份的重量（g）", "180");
		await retype(form, "一份的熱量（kcal）", "333");
		await retype(form, "一份的蛋白質（g）", "30");
		await retype(form, "一份的脂肪（g）", "22");
		await retype(form, "一份的碳水化合物（g）", "1");
		await userEvent.click(within(form).getByRole("button", { name: "套用" }));

		expect(checkbox(/^烤雞腿 180 g · 333 kcal$/)).toBeChecked();
		expect(
			within(card).getByRole("button", { name: "修改 烤雞腿" }),
		).toHaveFocus();
		// 套用只是記在清單上：還沒建任何東西。
		expect(createdBodies(fetchMock)).toEqual([]);

		await userEvent.click(checkbox(/^白飯/));
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		await waitUntilClosed();

		// 改了名稱：加入前查一次同名（食物庫沒有）。
		expect(calls(fetchMock, "GET", "/api/foods?q=")).toHaveLength(1);
		expect(createdBodies(fetchMock)).toMatchObject([
			{
				name: "烤雞腿",
				// 一份的值換算成每 100：333／30／22／1 ÷ 180 × 100。
				nutrition: {
					base_unit: "g",
					kcal: "185.00",
					protein_g: "16.67",
					fat_g: "12.22",
					carb_g: "0.56",
				},
				default_portion: { label: "一份", grams: "180" },
				source: "user",
				ai_confidence: "0.60",
			},
		]);
		expect(onItemsReady).toHaveBeenCalledWith(
			[{ food: created, quantity: "180" }],
			expect.anything(),
		);
	});

	it("表單驗證不過：顯示訊息、表單留著、清單不變", async () => {
		mockPanel();
		renderPanel();
		const { form } = await openChickenForm();

		await userEvent.clear(within(form).getByLabelText("食物名稱"));
		await userEvent.click(within(form).getByRole("button", { name: "套用" }));

		expect(within(form).getByRole("alert")).toHaveTextContent("請輸入名稱");
		expect(checkbox(/^滷雞腿 150 g · 300 kcal$/)).toBeInTheDocument();
	});

	it("放棄修改：清單不變，焦點回到那一列的「修改」", async () => {
		mockPanel();
		renderPanel();
		const { card, form } = await openChickenForm();

		await retype(form, "食物名稱", "烤雞腿");
		await userEvent.click(
			within(form).getByRole("button", { name: "放棄修改" }),
		);

		expect(checkbox(/^滷雞腿 150 g · 300 kcal$/)).toBeInTheDocument();
		expect(
			within(card).getByRole("button", { name: "修改 滷雞腿" }),
		).toHaveFocus();
	});

	it("只改數字、沒改名稱：加入前不查同名", async () => {
		const fetchMock = mockPanel();
		renderPanel();
		const { card, form } = await openChickenForm();

		await retype(form, "一份的熱量（kcal）", "333");
		await userEvent.click(within(form).getByRole("button", { name: "套用" }));
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(calls(fetchMock, "GET", "/api/foods?q=")).toHaveLength(0);
		expect(createdBodies(fetchMock)).toMatchObject([{ source: "user" }]);
	});

	const LIBRARY_LEG = {
		...CREATED_CHICKEN,
		id: 44,
		name: "雞腿",
		is_global: true,
	};

	async function renameToLibraryName() {
		const { card, form } = await openChickenForm();
		await retype(form, "食物名稱", "雞腿");
		await userEvent.click(within(form).getByRole("button", { name: "套用" }));
		await userEvent.click(checkbox(/^白飯/));
		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 1 樣" }),
		);
		expect(
			await within(card).findByText("食物庫裡已經有「雞腿」"),
		).toBeInTheDocument();
		return card;
	}

	it("改名之後跟食物庫的同名：先問；「用食物庫的」拿那一筆，不建", async () => {
		const fetchMock = mockPanel({
			search: () => json([LIBRARY_LEG]),
			extra: [
				{
					method: "GET",
					path: "/api/foods/44",
					handler: () => json(LIBRARY_LEG),
				},
			],
		});
		const { onItemsReady } = renderPanel();
		const card = await renameToLibraryName();

		// 問的時候還沒建、也還沒交回。
		expect(createdBodies(fetchMock)).toEqual([]);
		expect(onItemsReady).not.toHaveBeenCalled();
		await userEvent.click(
			within(card).getByRole("button", { name: "用食物庫的" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toEqual([]);
		expect(onItemsReady).toHaveBeenCalledWith(
			[{ food: LIBRARY_LEG, quantity: "150" }],
			expect.anything(),
		);
	});

	it("改名之後跟食物庫的同名：「還是建一個」照改過的內容建，不再問", async () => {
		const created = { ...CREATED_CHICKEN, id: 35, name: "雞腿" };
		const fetchMock = mockPanel({
			search: () => json([LIBRARY_LEG]),
			createFood: () => json(created, 201),
		});
		const { onItemsReady } = renderPanel();
		const card = await renameToLibraryName();

		await userEvent.click(
			within(card).getByRole("button", { name: "還是建一個" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toMatchObject([
			{ name: "雞腿", source: "user" },
		]);
		// 第二次沒有再查同名。
		expect(calls(fetchMock, "GET", "/api/foods?q=")).toHaveLength(1);
		expect(onItemsReady).toHaveBeenCalledWith(
			[{ food: created, quantity: "150" }],
			expect.anything(),
		);
	});

	it("同名檢查失敗（查不到）：照樣建——那只是提醒，不是守衛", async () => {
		const fetchMock = mockPanel({ search: serverError });
		renderPanel();
		const { card, form } = await openChickenForm();
		await retype(form, "食物名稱", "雞腿");
		await userEvent.click(within(form).getByRole("button", { name: "套用" }));

		await userEvent.click(
			within(card).getByRole("button", { name: "加入這 2 樣" }),
		);
		await waitUntilClosed();

		expect(createdBodies(fetchMock)).toMatchObject([{ name: "雞腿" }]);
	});
});

describe("AI 多樣估算面板：不呼叫 AI 的路與錯誤", () => {
	const SHORTCUT = {
		analysis_id: null,
		description: "白飯",
		items: [
			{
				...RICE,
				nutrition: {
					...RICE.nutrition,
					kcal: "130.00",
					serving_grams: "100",
					serving_kcal: "130.00",
				},
				library_food: { ...RICE.library_food, serving_kcal: "130.00" },
			},
		],
		remaining_today: 20,
	};

	it("整段文字就是食物庫裡的食物：「用這個」交回那個食物，不進清單", async () => {
		const fetchMock = mockPanel({ estimate: () => json(SHORTCUT) });
		const { onFoodPicked, onItemsReady } = renderPanel("白飯");

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「白飯」" }),
		);
		const hit = await screen.findByRole("region", { name: "食物庫裡的食物" });
		expect(hit).toHaveTextContent("食物庫裡已經有「白飯」");
		expect(hit).toHaveTextContent("每 100 g：130 kcal");
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument();
		await userEvent.click(within(hit).getByRole("button", { name: "用這個" }));

		await waitFor(() =>
			expect(onFoodPicked).toHaveBeenCalledWith(LIBRARY_RICE),
		);
		expect(calls(fetchMock, "GET", "/api/foods/7")).toHaveLength(1);
		expect(onItemsReady).not.toHaveBeenCalled();
		expect(
			screen.queryByRole("region", { name: "食物庫裡的食物" }),
		).not.toBeInTheDocument();
	});

	it("搜尋框沒有字：只有拍照估算", () => {
		mockPanel();
		renderPanel("   ");

		expect(screen.queryByRole("button", { name: /用 AI 估算/ })).toBeNull();
		expect(screen.getByLabelText("拍照估算")).toBeInTheDocument();
	});

	it.each([
		[
			"AI_BAD_RESPONSE",
			() => apiError(502, "AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON"),
			"AI 這次的回答看不懂，可以再試一次",
		],
		[
			"AI_DAILY_LIMIT",
			() => apiError(429, "AI_DAILY_LIMIT", "今天用了 20/20 次，請明天再試"),
			"今天用了 20/20 次，請明天再試",
		],
		[
			"AI_UPSTREAM_ERROR",
			() =>
				apiError(502, "AI_UPSTREAM_ERROR", "AI 服務暫時無法使用，請稍後再試"),
			"AI 服務暫時無法使用，請稍後再試",
		],
	])(
		"估算失敗（%s）：顯示跟單樣面板同一句話",
		async (_code, respond, message) => {
			mockPanel({ estimate: respond });
			renderPanel();

			await userEvent.click(
				screen.getByRole("button", { name: "用 AI 估算「雞腿便當」" }),
			);

			expect(await screen.findByRole("alert")).toHaveTextContent(message);
			expect(
				screen.queryByRole("region", { name: "AI 估算結果" }),
			).not.toBeInTheDocument();
		},
	);

	it("AI 看不出任何食物（AI_NO_FOOD_FOUND）：顯示後端那一句，不是「可以再試一次」", async () => {
		// 不是食物的照片：再按一次只會再吃一次額度。通用的「看不懂，可以再試一次」
		// 對這種情況是錯的指示——後端的訊息說的是該換照片或換說法。
		const message =
			"AI 看不出這一餐有什麼食物，換一張照片或換個說法再試（這一次也算在今天的次數裡）";
		mockPanel({
			estimate: () => apiError(502, "AI_NO_FOOD_FOUND", message),
		});
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「雞腿便當」" }),
		);

		// 整句相等（`toHaveTextContent` 給字串是「包含」）。
		expect((await screen.findByRole("alert")).textContent).toBe(message);
		expect(screen.queryByText(/可以再試一次/)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument();
		// 這不是「AI 沒設定」：拍照估算照樣能按（換一張照片）。
		expect(screen.getByLabelText("拍照估算")).toBeEnabled();
	});

	it("AI 沒設定：顯示後端的訊息，並停用拍照估算（文字仍可按——命中食物庫不用 AI）", async () => {
		mockPanel({
			estimate: () => apiError(503, "AI_NOT_CONFIGURED", "AI 分析未設定"),
		});
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「雞腿便當」" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent("AI 分析未設定");
		expect(screen.getByLabelText("拍照估算")).toBeDisabled();
		expect(
			screen.getByRole("button", { name: "用 AI 估算「雞腿便當」" }),
		).toBeEnabled();
	});

	it("再估算一次：上一次的清單與錯誤都換掉", async () => {
		let round = 0;
		mockPanel({
			estimate: () => {
				round += 1;
				return round === 1
					? json(ESTIMATE)
					: json({ ...ESTIMATE, description: "只有白飯", items: [RICE] });
			},
		});
		renderPanel();
		await estimate();

		const card = await estimate();

		await waitFor(() =>
			expect(within(card).getByText("只有白飯")).toBeInTheDocument(),
		);
		expect(screen.queryByRole("checkbox", { name: /^滷雞腿/ })).toBeNull();
		expect(
			screen.getByRole("button", { name: "加入這 1 樣" }),
		).toBeInTheDocument();
	});
});
