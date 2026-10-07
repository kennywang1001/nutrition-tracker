import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AnalyzeResponse } from "../src/api/ai";
import { MAX_PHOTO_BYTES } from "../src/api/photos";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { AiEstimatePanel } from "../src/components/AiEstimatePanel";
import { shrinkToLongestEdge } from "../src/lib/resize-image";
import { json, mockApi, type Route } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const ESTIMATE: AnalyzeResponse = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	// 一個不會跟畫面上其他數字撞的值——用來證明它沒有被顯示。
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

const CREATED = {
	id: 30,
	name: "牛肉麵",
	brand: null,
	is_global: false,
	nutrition: {
		base_unit: "g",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
	},
};

const EXISTING = { ...CREATED, id: 7, name: "滷肉飯" };

function apiError(status: number, code: string, message: string, details = {}) {
	return () => json({ error: { code, message, details } }, status);
}

/** `extra` 排在前面：mockApi 依序用 url.includes 比對。 */
function routes(
	analyzeResult: () => Response = () => json(ESTIMATE),
	extra: Route[] = [],
): Route[] {
	return [
		...extra,
		{ method: "POST", path: "/api/ai/analyze", handler: analyzeResult },
		{ method: "GET", path: "/api/foods/7", handler: () => json(EXISTING) },
		// 存之前的同名檢查（規格 §2 第 3 項）：預設食物庫裡沒有同名的。
		{ method: "GET", path: "/api/foods?", handler: () => json([]) },
		{ method: "POST", path: "/api/foods", handler: () => json(CREATED, 201) },
	];
}

/** 存之前搜尋食物庫回這些食物。 */
function library(foods: unknown[]): Route {
	return { method: "GET", path: "/api/foods?", handler: () => json(foods) };
}

/** 存之前的同名檢查查了哪些名稱。**每一次都斷言 `scope=all`、`limit=200`**：
 *  只查自己的（`mine`）會漏掉公開的同名食物；少了 `limit`，短的名稱會被後端
 *  預設的 50 筆截掉、排不到完全同名的那一筆。 */
function searchedFor(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls
		.map(([input]) => String(input))
		.filter((url) => url.includes("/api/foods?"))
		.map((url) => {
			const params = new URL(url, "http://x").searchParams;
			expect(params.get("scope")).toBe("all");
			expect(params.get("limit")).toBe("200");
			return params.get("q") ?? "";
		});
}

function renderPanel(text = "一碗牛肉麵") {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const onFoodReady = vi.fn();
	render(
		<QueryClientProvider client={client}>
			<AiEstimatePanel text={text} onFoodReady={onFoodReady} />
		</QueryClientProvider>,
	);
	return { client, onFoodReady };
}

function bodyOf(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
): unknown {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).includes(path),
	);
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function posted(fetchMock: ReturnType<typeof mockApi>, path: string): number {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).endsWith(path),
	).length;
}

async function estimateByText() {
	await userEvent.click(
		screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
	);
	return screen.findByRole("region", { name: "AI 估算結果" });
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("AI 估算面板：估算", () => {
	it("文字估算：顯示一份的數字、一致性、今天還能用幾次", async () => {
		const fetchMock = mockApi(routes());
		renderPanel();

		const card = await estimateByText();

		expect(bodyOf(fetchMock, "POST", "/api/ai/analyze")).toEqual({
			kind: "text",
			text: "一碗牛肉麵",
		});
		expect(
			within(card).getByRole("heading", { name: "牛肉麵" }),
		).toBeInTheDocument();
		expect(within(card).getByText("一份 550 g · 620 kcal")).toBeInTheDocument();
		expect(
			within(card).getByText("蛋白質 32 g 脂肪 18 g 碳水 80 g"),
		).toBeInTheDocument();
		expect(
			within(card).getByText("✓ 熱量與三大營養素對得起來"),
		).toBeInTheDocument();
		expect(within(card).getByText("今天還能用 19 次")).toBeInTheDocument();
	});

	it("不顯示 AI 自己報的信心值（P2 規格 §4.1）", async () => {
		mockApi(routes());
		renderPanel();

		const card = await estimateByText();

		expect(card).not.toHaveTextContent("0.37");
		expect(card).not.toHaveTextContent("37%");
		expect(card).not.toHaveTextContent("信心");
	});

	it("一致性對不起來：提醒看一眼", async () => {
		mockApi(
			routes(() =>
				json({
					...ESTIMATE,
					consistency: {
						atwater_kcal: "300.00",
						deviation: "320.00",
						flagged: true,
					},
				}),
			),
		);
		renderPanel();

		const card = await estimateByText();

		expect(
			within(card).getByText("⚠ 熱量跟三大營養素對不太起來，建議看一眼"),
		).toBeInTheDocument();
	});

	it("沒有文字時只有拍照估算", () => {
		mockApi(routes());
		renderPanel("   ");

		expect(
			screen.queryByRole("button", { name: /用 AI 估算/ }),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("拍照估算")).toBeInTheDocument();
	});

	it("照片估算：送 kind=image（縮小後的）；確認後交回的是原本那張照片", async () => {
		const fetchMock = mockApi(routes());
		const { onFoodReady } = renderPanel();
		const photo = new File(["fake-jpeg"], "noodle.jpg", { type: "image/jpeg" });
		// 縮圖會回另一個 File：送出去的是它，交回的必須是原圖（規格 §5.1）。
		vi.mocked(shrinkToLongestEdge).mockResolvedValueOnce(
			new File(["small"], "small.jpg", { type: "image/jpeg" }),
		);

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		const card = await screen.findByRole("region", { name: "AI 估算結果" });

		expect(bodyOf(fetchMock, "POST", "/api/ai/analyze")).toEqual({
			kind: "image",
			image_base64: btoa("small"),
		});
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		await waitFor(() => expect(onFoodReady).toHaveBeenCalled());
		expect(onFoodReady.mock.calls[0]?.[1].image).toBe(photo);
	});

	it("估算進行中：狀態區塊念「AI 估算中…」，結束後清空", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchMock = mockApi(routes());
		const original = fetchMock.getMockImplementation();
		fetchMock.mockImplementation(async (input, init) => {
			await gate;
			return original?.(input, init) ?? new Response(null, { status: 500 });
		});
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);
		expect(screen.getByRole("status")).toHaveTextContent("AI 估算中…");

		release();
		await screen.findByRole("region", { name: "AI 估算結果" });
		expect(screen.getByRole("status")).toBeEmptyDOMElement();
	});

	it("照片太大：選的當下就擋，不打網路", async () => {
		const fetchMock = mockApi(routes());
		renderPanel();
		const photo = new File(["x"], "big.jpg", { type: "image/jpeg" });
		Object.defineProperty(photo, "size", { value: MAX_PHOTO_BYTES + 1 });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);

		expect(await screen.findByRole("alert")).toHaveTextContent("照片超過");
		expect(fetchMock).not.toHaveBeenCalled();
	});
});

describe("AI 估算面板：確認與修改", () => {
	it("確認：存成食物（AI 標記、一份預設份量），交回那個食物，失效搜尋", async () => {
		const fetchMock = mockApi(routes());
		const { client, onFoodReady } = renderPanel();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: null }),
		);
		expect(bodyOf(fetchMock, "POST", "/api/foods")).toMatchObject({
			source: "ai",
			default_portion: { label: "一份", grams: "550.00" },
			nutrition: { kcal: "112.73" },
		});
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: queryKeys.foodSearchAll,
		});
		// 交回之後面板回到起點，不會一直掛著上一次的結果。
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument();
	});

	it("需要修改：改過再存，標記成使用者、換算成每 100", async () => {
		const fetchMock = mockApi(routes());
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		const kcal = within(form).getByLabelText("一份的熱量（kcal）");
		expect(kcal).toHaveValue("620");
		await userEvent.clear(kcal);
		await userEvent.type(kcal, "550");
		await userEvent.click(
			within(form).getByRole("button", { name: "存成食物" }),
		);

		await waitFor(() => expect(onFoodReady).toHaveBeenCalled());
		expect(bodyOf(fetchMock, "POST", "/api/foods")).toMatchObject({
			source: "user",
			ai_confidence: "0.37",
			nutrition: { kcal: "100.00" },
		});
	});

	it("修改的內容不合法：擋下，不送", async () => {
		const fetchMock = mockApi(routes());
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		await userEvent.clear(within(form).getByLabelText("食物名稱"));
		await userEvent.click(
			within(form).getByRole("button", { name: "存成食物" }),
		);

		expect(within(form).getByRole("alert")).toHaveTextContent("請輸入名稱");
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	it("放棄修改：回到結果卡片", async () => {
		mockApi(routes());
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "放棄修改" }));

		expect(
			screen.getByRole("region", { name: "AI 估算結果" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("form", { name: "修改 AI 估算" }),
		).not.toBeInTheDocument();
	});
});

describe("AI 估算面板：食物庫已經有", () => {
	it("命中食物庫：「用這個」交回那一筆，不建新食物", async () => {
		const fetchMock = mockApi(
			routes(() =>
				json({ ...ESTIMATE, food_id: 7, name: "滷肉飯", analysis_id: null }),
			),
		);
		const { onFoodReady } = renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);
		const hit = await screen.findByRole("region", { name: "食物庫裡的食物" });
		expect(hit).toHaveTextContent("食物庫裡已經有「滷肉飯」");
		await userEvent.click(within(hit).getByRole("button", { name: "用這個" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(EXISTING, { image: null }),
		);
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	it("存的時候撞名：「用現有的」交回撞到的那一筆", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了", {
						food_id: 7,
					}),
				},
			]),
		);
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		expect(
			await within(card).findByText("你已經有「牛肉麵」了"),
		).toBeInTheDocument();
		await userEvent.click(
			within(card).getByRole("button", { name: "用現有的" }),
		);

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(EXISTING, { image: null }),
		);
	});

	it("撞名時「改名」打開修改模式", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了", {
						food_id: 7,
					}),
				},
			]),
		);
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		await userEvent.click(
			await within(card).findByRole("button", { name: "改名" }),
		);

		expect(
			screen.getByRole("form", { name: "修改 AI 估算" }),
		).toBeInTheDocument();
	});
});

describe("AI 估算面板：狀態", () => {
	const EXISTS_7 = {
		method: "POST",
		path: "/api/foods",
		handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了", {
			food_id: 7,
		}),
	};

	it("放棄修改：清掉撞名，回到有「確認」的卡片", async () => {
		mockApi(routes(undefined, [EXISTS_7]));
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		await userEvent.click(
			within(form).getByRole("button", { name: "存成食物" }),
		);
		expect(
			await within(form).findByText("你已經有同名的食物了，換個名稱"),
		).toBeInTheDocument();
		await userEvent.click(
			within(form).getByRole("button", { name: "放棄修改" }),
		);

		const back = screen.getByRole("region", { name: "AI 估算結果" });
		expect(
			within(back).getByRole("button", { name: "確認" }),
		).toBeInTheDocument();
		expect(back).not.toHaveTextContent("你已經有");
	});

	it("存失敗之後再估算一次：新卡片不帶舊的錯誤", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(500, "INTERNAL_ERROR", "boom"),
				},
			]),
		);
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		expect(await within(card).findByRole("alert")).toHaveTextContent(
			"存成食物失敗",
		);

		const next = await estimateByText();
		expect(next).not.toHaveTextContent("存成食物失敗");
	});

	it("「用這個」失敗之後再估算一次：新卡片不帶舊的錯誤", async () => {
		mockApi(
			routes(
				() =>
					json({ ...ESTIMATE, food_id: 7, name: "滷肉飯", analysis_id: null }),
				[
					{
						method: "GET",
						path: "/api/foods/7",
						handler: apiError(500, "INTERNAL_ERROR", "boom"),
					},
				],
			),
		);
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);
		const hit = await screen.findByRole("region", { name: "食物庫裡的食物" });
		await userEvent.click(within(hit).getByRole("button", { name: "用這個" }));
		expect(await within(hit).findByRole("alert")).toHaveTextContent(
			"讀取食物失敗",
		);

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);
		const again = await screen.findByRole("region", { name: "食物庫裡的食物" });
		expect(again).not.toHaveTextContent("讀取食物失敗");
	});

	it("離開畫面之後才存好：不再交回食物", async () => {
		let release: () => void = () => {};
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const fetchMock = mockApi(routes());
		const original = fetchMock.getMockImplementation();
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const onFoodReady = vi.fn();
		const view = render(
			<QueryClientProvider client={client}>
				<AiEstimatePanel text="一碗牛肉麵" onFoodReady={onFoodReady} />
			</QueryClientProvider>,
		);
		const card = await estimateByText();
		fetchMock.mockImplementation(async (input, init) => {
			if (String(input).endsWith("/api/foods")) await gate;
			return original?.(input, init) ?? new Response(null, { status: 500 });
		});
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		view.unmount();
		release();
		await new Promise((resolve) => setTimeout(resolve, 50));

		expect(onFoodReady).not.toHaveBeenCalled();
	});

	it("撞名但沒附 food_id：顯示後端的訊息", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了"),
				},
			]),
		);
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		expect(await within(card).findByRole("alert")).toHaveTextContent(
			"你已經建過同名的食物了",
		);
	});
});

describe("AI 估算面板：錯誤", () => {
	it("今天的次數用完：顯示後端的訊息", async () => {
		mockApi(
			routes(apiError(429, "AI_DAILY_LIMIT", "今天用了 20/20 次，請明天再試")),
		);
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"今天用了 20/20 次，請明天再試",
		);
	});

	it("AI 沒設定：說缺什麼，只停用拍照，文字估算按鈕還能按", async () => {
		mockApi(
			routes(
				apiError(503, "AI_NOT_CONFIGURED", "AI 分析未設定：缺 GEMINI_API_KEY"),
			),
		);
		renderPanel();

		const button = screen.getByRole("button", {
			name: "用 AI 估算「一碗牛肉麵」",
		});
		await userEvent.click(button);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"AI 分析未設定：缺 GEMINI_API_KEY",
		);
		// 文字估算可能直接命中食物庫、不用 AI，所以不停用。
		expect(button).toBeEnabled();
		expect(screen.getByLabelText("拍照估算")).toBeDisabled();
	});

	it("AI 回了看不懂的東西：可以再試一次", async () => {
		mockApi(
			routes(apiError(502, "AI_BAD_RESPONSE", "AI 回傳的內容不是有效的 JSON")),
		);
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"AI 這次的回答看不懂，可以再試一次",
		);
		expect(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		).toBeEnabled();
	});
});

describe("AI 估算面板：後端分類過的 AI 錯誤", () => {
	it("AI 設定有問題（金鑰或模型）：顯示後端的訊息，不是通用的估算失敗", async () => {
		mockApi(
			routes(
				apiError(
					503,
					"AI_MISCONFIGURED",
					"AI 設定有問題（金鑰或模型），請管理員檢查",
				),
			),
		);
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent(
			"AI 設定有問題（金鑰或模型），請管理員檢查",
		);
		expect(alert).not.toHaveTextContent("AI 估算失敗");
	});

	it("AI 服務暫時無法使用：顯示後端的訊息，不是通用的估算失敗", async () => {
		mockApi(
			routes(
				apiError(502, "AI_UPSTREAM_ERROR", "AI 服務暫時無法使用，請稍後再試"),
			),
		);
		renderPanel();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「一碗牛肉麵」" }),
		);

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("AI 服務暫時無法使用，請稍後再試");
		expect(alert).not.toHaveTextContent("AI 估算失敗");
	});
});

describe("AI 估算面板：切換時的焦點", () => {
	it("需要修改：焦點到表單的第一個欄位（食物名稱）", async () => {
		mockApi(routes());
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);

		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		expect(within(form).getByLabelText("食物名稱")).toHaveFocus();
	});

	it("撞名之後按「改名」：焦點也到食物名稱", async () => {
		mockApi(
			routes(undefined, [
				{
					method: "POST",
					path: "/api/foods",
					handler: apiError(409, "FOOD_EXISTS", "你已經建過同名的食物了", {
						food_id: 7,
					}),
				},
			]),
		);
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		await userEvent.click(
			await within(card).findByRole("button", { name: "改名" }),
		);

		expect(screen.getByLabelText("食物名稱")).toHaveFocus();
	});

	it("放棄修改：焦點回到結果卡片的標題", async () => {
		mockApi(routes());
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "放棄修改" }));

		const back = screen.getByRole("region", { name: "AI 估算結果" });
		expect(within(back).getByRole("heading", { name: "牛肉麵" })).toHaveFocus();
	});

	it("剛估算完：焦點不會被搶到卡片標題", async () => {
		mockApi(routes());
		renderPanel();

		const button = screen.getByRole("button", {
			name: "用 AI 估算「一碗牛肉麵」",
		});
		await userEvent.click(button);
		const card = await screen.findByRole("region", { name: "AI 估算結果" });

		expect(
			within(card).getByRole("heading", { name: "牛肉麵" }),
		).not.toHaveFocus();
	});
});

describe("AI 估算面板：存之前先看食物庫有沒有同名的", () => {
	// 看得到的公開食物，名稱跟估算的一模一樣。
	const LIBRARY = { ...CREATED, id: 40, is_global: true };
	// 名稱只是「包含」估算的名稱——搜尋是子字串比對，會一起回來。
	const LARGE_BOWL = { ...CREATED, id: 41, name: "牛肉麵（大碗）" };

	it("有同名的：先問；「用食物庫的」交回那一筆，不建新食物", async () => {
		const fetchMock = mockApi(
			routes(undefined, [library([LARGE_BOWL, LIBRARY])]),
		);
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		expect(
			await within(card).findByText("食物庫裡已經有「牛肉麵」"),
		).toBeInTheDocument();
		expect(searchedFor(fetchMock)).toEqual(["牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(0);
		await userEvent.click(
			within(card).getByRole("button", { name: "用食物庫的" }),
		);

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(LIBRARY, { image: null }),
		);
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	it("有同名的：「還是用 AI 的數字建一個」照樣存成食物", async () => {
		const fetchMock = mockApi(routes(undefined, [library([LIBRARY])]));
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));
		await userEvent.click(
			await within(card).findByRole("button", {
				name: "還是用 AI 的數字建一個",
			}),
		);

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: null }),
		);
		expect(searchedFor(fetchMock)).toEqual(["牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(1);
		expect(bodyOf(fetchMock, "POST", "/api/foods")).toMatchObject({
			name: "牛肉麵",
			source: "ai",
		});
	});

	it("比對不分大小寫、去掉頭尾空白", async () => {
		const fetchMock = mockApi(
			routes(
				() => json({ ...ESTIMATE, name: "Big Mac" }),
				[library([{ ...LIBRARY, name: " BIG MAC " }])],
			),
		);
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		expect(
			await within(card).findByRole("button", { name: "用食物庫的" }),
		).toBeInTheDocument();
		expect(searchedFor(fetchMock)).toEqual(["Big Mac"]);
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	it("名稱只是包含估算的名稱：不算同名，照樣存", async () => {
		const fetchMock = mockApi(routes(undefined, [library([LARGE_BOWL])]));
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: null }),
		);
		expect(searchedFor(fetchMock)).toEqual(["牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(1);
		expect(
			screen.queryByRole("button", { name: "用食物庫的" }),
		).not.toBeInTheDocument();
	});

	it("同名的食物沒有生效的營養素：記不了，不拿來問，照樣存", async () => {
		const fetchMock = mockApi(
			routes(undefined, [library([{ ...LIBRARY, nutrition: null }])]),
		);
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: null }),
		);
		expect(searchedFor(fetchMock)).toEqual(["牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(1);
	});

	it("搜尋食物庫失敗：不擋使用者，照樣存", async () => {
		const fetchMock = mockApi(
			routes(undefined, [
				{
					method: "GET",
					path: "/api/foods?",
					handler: apiError(500, "INTERNAL_ERROR", "boom"),
				},
			]),
		);
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(CREATED, { image: null }),
		);
		expect(searchedFor(fetchMock)).toEqual(["牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(1);
	});

	it("改過名稱再存：用改過的名稱查；問的時候在表單裡，改名稱就收起來", async () => {
		const RED = { ...LIBRARY, id: 42, name: "紅燒牛肉麵" };
		const fetchMock = mockApi(routes(undefined, [library([RED])]));
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		const name = within(form).getByLabelText("食物名稱");
		await userEvent.clear(name);
		await userEvent.type(name, "紅燒牛肉麵");
		await userEvent.click(
			within(form).getByRole("button", { name: "存成食物" }),
		);

		expect(
			await within(form).findByText("食物庫裡已經有「紅燒牛肉麵」"),
		).toBeInTheDocument();
		expect(searchedFor(fetchMock)).toEqual(["紅燒牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(0);

		// 名稱一改，剛才的提問就不算數了（不然「還是建一個」會送出舊的名稱）。
		await userEvent.type(name, "（小碗）");
		expect(
			within(form).queryByRole("button", { name: "用食物庫的" }),
		).not.toBeInTheDocument();
		expect(onFoodReady).not.toHaveBeenCalled();
	});

	it("改過名稱、有同名的：「用食物庫的」交回那一筆", async () => {
		const RED = { ...LIBRARY, id: 42, name: "紅燒牛肉麵" };
		const fetchMock = mockApi(routes(undefined, [library([RED])]));
		const { onFoodReady } = renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		const name = within(form).getByLabelText("食物名稱");
		await userEvent.clear(name);
		await userEvent.type(name, "紅燒牛肉麵");
		await userEvent.click(
			within(form).getByRole("button", { name: "存成食物" }),
		);
		await userEvent.click(
			await within(form).findByRole("button", { name: "用食物庫的" }),
		);

		await waitFor(() =>
			expect(onFoodReady).toHaveBeenCalledWith(RED, { image: null }),
		);
		expect(searchedFor(fetchMock)).toEqual(["紅燒牛肉麵"]);
		expect(posted(fetchMock, "/api/foods")).toBe(0);
	});

	// 問的時候「確認」／「存成食物」那顆按鈕被換掉（卡片）或停用過，焦點會掉到
	// body——鍵盤與讀屏的使用者不知道畫面多了一個問題要回答。
	it("問同名的時候：焦點移到「用食物庫的」（結果卡片）", async () => {
		mockApi(routes(undefined, [library([LIBRARY])]));
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(within(card).getByRole("button", { name: "確認" }));

		expect(
			await within(card).findByRole("button", { name: "用食物庫的" }),
		).toHaveFocus();
	});

	it("問同名的時候：焦點移到「用食物庫的」（修改表單）", async () => {
		mockApi(routes(undefined, [library([LIBRARY])]));
		renderPanel();

		const card = await estimateByText();
		await userEvent.click(
			within(card).getByRole("button", { name: "需要修改" }),
		);
		const form = screen.getByRole("form", { name: "修改 AI 估算" });
		await userEvent.click(
			within(form).getByRole("button", { name: "存成食物" }),
		);

		expect(
			await within(form).findByRole("button", { name: "用食物庫的" }),
		).toHaveFocus();
	});
});
