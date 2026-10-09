import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogMeal } from "../src/screens/LogMeal";
import { json, mockApi } from "./helpers/mock-api";

vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function nutrition(kcal: string) {
	return {
		base_unit: "g",
		kcal,
		protein_g: "5.00",
		fat_g: "5.00",
		carb_g: "5.00",
	};
}

function estimated(name: string, grams: string, kcal: string) {
	return {
		name,
		brand: null,
		nutrition: {
			...nutrition("100.00"),
			serving_grams: grams,
			serving_kcal: kcal,
			serving_protein_g: "5.00",
			serving_fat_g: "5.00",
			serving_carb_g: "5.00",
		},
		confidence: "0.70",
		consistency: { atwater_kcal: kcal, deviation: "0.00", flagged: false },
		library_food: null,
	};
}

// 白飯：食物庫有（id 7）；滷雞腿：要建（id 30）。
const ESTIMATE = {
	analysis_id: 41,
	description: "一碗白飯、滷雞腿一隻",
	items: [
		{
			...estimated("白飯", "200.00", "280.00"),
			library_food: {
				food_id: 7,
				name: "白飯",
				base_unit: "g",
				serving_kcal: "260.00",
			},
		},
		estimated("滷雞腿", "150.00", "300.00"),
	],
	remaining_today: 18,
};

const LIBRARY_RICE = {
	id: 7,
	name: "白飯",
	brand: null,
	is_global: true,
	nutrition: nutrition("130.00"),
};
const CREATED_CHICKEN = {
	id: 30,
	name: "滷雞腿",
	brand: null,
	is_global: false,
	nutrition: nutrition("200.00"),
};
// 常吃的食物：手選用。
const NOODLES = {
	id: 10,
	name: "牛肉麵",
	brand: null,
	is_global: true,
	nutrition: nutrition("110.00"),
};
// 整段文字命中食物庫時的回應（沒有呼叫 AI）。
const SHORTCUT = {
	analysis_id: null,
	description: "白飯",
	items: [
		{
			...estimated("白飯", "100", "130.00"),
			library_food: {
				food_id: 7,
				name: "白飯",
				base_unit: "g",
				serving_kcal: "130.00",
			},
		},
	],
	remaining_today: 20,
};

/** 路徑順序：mockApi 依序用 url.includes 比對——具體的排前面。
 *  **沒有 `/api/ai/analyze`（單樣）的路由**：記一餐打到它的話 mock 會炸。 */
function mockLogMeal(estimate: unknown = ESTIMATE) {
	return mockApi([
		{ path: "/api/foods/frequent", handler: () => json([NOODLES]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
		{ path: "/api/foods/10/portions", handler: () => json([]) },
		{ path: "/api/foods/7/portions", handler: () => json([]) },
		{ method: "GET", path: "/api/foods?q=", handler: () => json([]) },
		{ method: "GET", path: "/api/foods/7", handler: () => json(LIBRARY_RICE) },
		{
			method: "POST",
			path: "/api/ai/analyze-meal",
			handler: () => json(estimate),
		},
		{
			method: "POST",
			path: "/api/foods",
			handler: () => json(CREATED_CHICKEN, 201),
		},
		{
			method: "POST",
			path: "/api/meals/99/photo",
			handler: () => json({ id: 99 }),
		},
		{
			method: "POST",
			path: "/api/meals",
			handler: () => json({ id: 99 }, 201),
		},
	]);
}

type FetchMock = ReturnType<typeof mockApi>;

function mealBody(fetchMock: FetchMock): unknown {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).endsWith("/api/meals"),
	);
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function uploadedPhotoName(fetchMock: FetchMock): string | null {
	const call = fetchMock.mock.calls.find(([input]) =>
		String(input).includes("/api/meals/99/photo"),
	);
	if (call === undefined) return null;
	const body = call[1]?.body;
	if (!(body instanceof FormData)) return null;
	const file = body.get("file");
	return file instanceof File ? file.name : null;
}

/** 按「加入這 N 樣」，等到面板收起：收起＝食物（與照片、描述）已經交回給記一餐。 */
async function addAll() {
	const card = await screen.findByRole("region", { name: "AI 估算結果" });
	await userEvent.click(
		within(card).getByRole("button", { name: /^加入這 \d 樣$/ }),
	);
	await waitFor(() =>
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument(),
	);
}

async function estimateByText(text = "雞腿便當") {
	await userEvent.type(screen.getByLabelText("搜尋食物"), text);
	await userEvent.click(
		screen.getByRole("button", { name: `用 AI 估算「${text}」` }),
	);
}

function aiItems() {
	return screen.getByRole("region", { name: "AI 估的項目" });
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記一餐：AI 多樣估算", () => {
	it("估算 → 加入 → 「AI 估的項目」每一樣一列、量是估的、描述先填好；記錄送出每一樣", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await estimateByText();
		await addAll();

		const list = aiItems();
		expect(within(list).getByLabelText("白飯（g）")).toHaveValue("200");
		expect(within(list).getByLabelText("滷雞腿（g）")).toHaveValue("150");
		expect(screen.getByLabelText("描述（選填）")).toHaveValue(
			"一碗白飯、滷雞腿一隻",
		);
		// 沒有手選的食物：沒有「已選擇」、也沒有份量欄位。
		expect(screen.queryByText(/^已選擇：/)).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).toBeDefined());
		const body = mealBody(fetchMock) as Record<string, unknown>;
		// 整個比：不能多出 portion_id 或自己算的公克數。
		expect(body.items).toEqual([
			{ food_id: 7, quantity: "200" },
			{ food_id: 30, quantity: "150" },
		]);
		expect(body.description).toBe("一碗白飯、滷雞腿一隻");
	});

	it("加入之後，焦點在「AI 估的項目」的標題", async () => {
		mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await estimateByText();
		await addAll();

		await waitFor(() =>
			expect(
				screen.getByRole("heading", { name: "AI 估的項目" }),
			).toHaveFocus(),
		);
	});

	it("拍照估算：那張照片自動當這一餐的照片", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const photo = new File(["fake-jpeg"], "bento.jpg", { type: "image/jpeg" });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		await addAll();
		// 預覽是 effect 裡建的 object URL——等它出現。
		expect(await screen.findByAltText("選好的照片")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(uploadedPhotoName(fetchMock)).toBe("bento.jpg"));
	});

	it("已經選了別張照片、已經打了描述：估算的照片與 AI 的描述都不覆蓋", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const chosen = new File(["a"], "chosen.jpg", { type: "image/jpeg" });
		const forEstimate = new File(["b"], "bento.jpg", { type: "image/jpeg" });

		// 表單要先有東西才會出現：手選一個食物，選照片、打描述，再拍照估算。
		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		await userEvent.upload(screen.getByLabelText("照片（選填）"), chosen);
		await userEvent.type(screen.getByLabelText("描述（選填）"), "我自己寫的");
		await userEvent.upload(screen.getByLabelText("拍照估算"), forEstimate);
		await addAll();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(uploadedPhotoName(fetchMock)).toBe("chosen.jpg"),
		);
		expect(mealBody(fetchMock)).toMatchObject({ description: "我自己寫的" });
	});

	it("手選的食物與 AI 的項目並存：AI 的在前、手選的在後；「不記這一樣」拿掉手選的", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		// 沒有 AI 的項目時沒有「不記這一樣」——畫面跟以前一樣。
		expect(screen.queryByRole("button", { name: "不記這一樣" })).toBeNull();
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "450");
		await estimateByText();
		await addAll();
		expect(screen.getByText("已選擇：牛肉麵")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(mealBody(fetchMock)).toMatchObject({
				items: [
					{ food_id: 7, quantity: "200" },
					{ food_id: 30, quantity: "150" },
					{ food_id: 10, quantity: "450" },
				],
			}),
		);
	});

	it("「不記這一樣」：只送 AI 的項目", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		await estimateByText();
		await addAll();
		await userEvent.click(screen.getByRole("button", { name: "不記這一樣" }));

		expect(screen.queryByText("已選擇：牛肉麵")).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(mealBody(fetchMock)).toBeDefined());
		expect((mealBody(fetchMock) as { items: unknown[] }).items).toEqual([
			{ food_id: 7, quantity: "200" },
			{ food_id: 30, quantity: "150" },
		]);
	});

	it("改一列的量、移除另一列：送出的是改過的那一組", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await estimateByText();
		await addAll();

		const rice = within(aiItems()).getByLabelText("白飯（g）");
		await userEvent.clear(rice);
		await userEvent.type(rice, "250");
		await userEvent.click(screen.getByRole("button", { name: "移除 滷雞腿" }));

		expect(within(aiItems()).queryByLabelText("滷雞腿（g）")).toBeNull();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(mealBody(fetchMock)).toBeDefined());
		expect((mealBody(fetchMock) as { items: unknown[] }).items).toEqual([
			{ food_id: 7, quantity: "250" },
		]);
	});

	it("最後一列也移除、又沒有手選的食物：表單收起來", async () => {
		mockLogMeal({ ...ESTIMATE, items: [ESTIMATE.items[0]] });
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await estimateByText();
		await addAll();

		await userEvent.click(screen.getByRole("button", { name: "移除 白飯" }));

		expect(screen.queryByRole("button", { name: "記錄" })).toBeNull();
	});

	it.each(["", "0", "abc", "-5"])(
		"某一列的量是「%s」：不送出，說是哪一樣",
		async (bad) => {
			const fetchMock = mockLogMeal();
			render(wrap(<LogMeal onSaved={vi.fn()} />));
			await estimateByText();
			await addAll();

			const chicken = within(aiItems()).getByLabelText("滷雞腿（g）");
			await userEvent.clear(chicken);
			if (bad !== "") await userEvent.type(chicken, bad);
			await userEvent.click(screen.getByRole("button", { name: "記錄" }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"「滷雞腿」的份量要是大於 0 的數字",
			);
			expect(mealBody(fetchMock)).toBeUndefined();
		},
	);

	it("估算兩次：第二次加入的接在後面，不會蓋掉第一次的", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await estimateByText();
		await addAll();

		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「雞腿便當」" }),
		);
		const card = await screen.findByRole("region", { name: "AI 估算結果" });
		await userEvent.click(
			within(card).getByRole("checkbox", { name: /^滷雞腿/ }),
		);
		await addAll();

		expect(within(aiItems()).getAllByLabelText("白飯（g）")).toHaveLength(2);
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(mealBody(fetchMock)).toBeDefined());
		expect((mealBody(fetchMock) as { items: unknown[] }).items).toEqual([
			{ food_id: 7, quantity: "200" },
			{ food_id: 30, quantity: "150" },
			{ food_id: 7, quantity: "200" },
		]);
	});

	it("存好之後 AI 的項目與描述都清空", async () => {
		const onSaved = vi.fn();
		mockLogMeal();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await estimateByText();
		await addAll();

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(screen.queryByRole("region", { name: "AI 估的項目" })).toBeNull();
		expect(screen.queryByLabelText("描述（選填）")).toBeNull();
	});
});

// 審查 M5：AI 的項目全部移除之後，表單收起來，但 AI 填的那句描述與那張照片還留在
// state 裡——之後手選一個食物，表單再出現時它們也跟著回來，一按「記錄」就把「一碗白飯、
// 滷雞腿一隻」與便當的照片記在一碗牛肉麵上（描述好友看得到）。
describe("記一餐：AI 的項目全部移除之後", () => {
	const BENTO = new File(["fake-jpeg"], "bento.jpg", { type: "image/jpeg" });
	const AI_DESCRIPTION = "一碗白飯、滷雞腿一隻";

	async function estimateByPhoto() {
		await userEvent.upload(screen.getByLabelText("拍照估算"), BENTO);
		await addAll();
		// 預覽是 effect 裡建的 object URL——等它出現，才知道照片真的放進去了。
		await screen.findByAltText("選好的照片");
	}

	async function removeAiItem(name: string) {
		await userEvent.click(screen.getByRole("button", { name: `移除 ${name}` }));
	}

	async function pickNoodles() {
		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		await screen.findByText("已選擇：牛肉麵");
	}

	async function save(fetchMock: FetchMock) {
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(mealBody(fetchMock)).toBeDefined());
		return mealBody(fetchMock) as Record<string, unknown>;
	}

	it("AI 填的描述與照片沒有動過：跟著清掉——之後手選的那一餐是乾淨的", async () => {
		const onSaved = vi.fn();
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await estimateByPhoto();
		expect(screen.getByLabelText("描述（選填）")).toHaveValue(AI_DESCRIPTION);

		// 還有一樣的時候不清：描述說的東西還有一樣在。
		await removeAiItem("白飯");
		expect(screen.getByLabelText("描述（選填）")).toHaveValue(AI_DESCRIPTION);
		expect(screen.getByAltText("選好的照片")).toBeInTheDocument();
		await removeAiItem("滷雞腿");
		expect(screen.queryByRole("button", { name: "記錄" })).toBeNull();
		await pickNoodles();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue("");
		expect(screen.queryByAltText("選好的照片")).toBeNull();
		const body = await save(fetchMock);
		// 只有手選的那一樣——移除的 AI 項目沒有跟著送出去。
		expect(body.items).toEqual([expect.objectContaining({ food_id: 10 })]);
		expect(body).not.toHaveProperty("description");
		// 存好了（onSaved 在照片那一步之後才呼叫）而且沒有傳照片。
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(uploadedPhotoName(fetchMock)).toBeNull();
	});

	it("改過的描述、換過的照片：是使用者自己的，不清", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const chosen = new File(["a"], "chosen.jpg", { type: "image/jpeg" });
		await estimateByPhoto();

		await userEvent.type(screen.getByLabelText("描述（選填）"), "，加一顆蛋");
		await userEvent.upload(screen.getByLabelText("照片（選填）"), chosen);
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");
		await pickNoodles();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue(
			`${AI_DESCRIPTION}，加一顆蛋`,
		);
		const body = await save(fetchMock);
		expect(body.description).toBe(`${AI_DESCRIPTION}，加一顆蛋`);
		await waitFor(() =>
			expect(uploadedPhotoName(fetchMock)).toBe("chosen.jpg"),
		);
	});

	it("估算之前自己打的描述、自己選的照片（AI 沒有覆蓋的）：不清", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const chosen = new File(["a"], "chosen.jpg", { type: "image/jpeg" });

		await pickNoodles();
		await userEvent.type(screen.getByLabelText("描述（選填）"), "我自己寫的");
		await userEvent.upload(screen.getByLabelText("照片（選填）"), chosen);
		await userEvent.upload(screen.getByLabelText("拍照估算"), BENTO);
		await addAll();
		await userEvent.click(screen.getByRole("button", { name: "不記這一樣" }));
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");
		expect(screen.queryByRole("button", { name: "記錄" })).toBeNull();
		await pickNoodles();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue("我自己寫的");
		const body = await save(fetchMock);
		expect(body.description).toBe("我自己寫的");
		await waitFor(() =>
			expect(uploadedPhotoName(fetchMock)).toBe("chosen.jpg"),
		);
	});

	it("描述是 AI 的、照片是自己選的：只清描述", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const chosen = new File(["a"], "chosen.jpg", { type: "image/jpeg" });
		// 文字估算：沒有估算用的照片。
		await estimateByText();
		await addAll();

		await userEvent.upload(screen.getByLabelText("照片（選填）"), chosen);
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");
		await pickNoodles();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue("");
		const body = await save(fetchMock);
		expect(body).not.toHaveProperty("description");
		await waitFor(() =>
			expect(uploadedPhotoName(fetchMock)).toBe("chosen.jpg"),
		);
	});

	it("照片是 AI 的、描述是自己改的：只清照片", async () => {
		const onSaved = vi.fn();
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await estimateByPhoto();

		const description = screen.getByLabelText("描述（選填）");
		await userEvent.clear(description);
		await userEvent.type(description, "今天的午餐");
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");
		await pickNoodles();

		expect(screen.queryByAltText("選好的照片")).toBeNull();
		const body = await save(fetchMock);
		expect(body.description).toBe("今天的午餐");
		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(uploadedPhotoName(fetchMock)).toBeNull();
	});

	it("改了又改回原樣的描述：跟 AI 填的一模一樣，一樣清掉", async () => {
		// 看的是「現在的字是不是 AI 填的那一句」，不是「有沒有碰過鍵盤」：多打一個字
		// 又刪掉，留下的仍然是在說已經移除的那幾樣。
		mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await estimateByText();
		await addAll();

		await userEvent.type(screen.getByLabelText("描述（選填）"), "x{Backspace}");
		expect(screen.getByLabelText("描述（選填）")).toHaveValue(AI_DESCRIPTION);
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");
		await pickNoodles();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue("");
	});

	it("還有手選的食物：表單還在，描述與照片都留著（看得到，要不要改由使用者決定）", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await pickNoodles();
		await estimateByPhoto();

		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");

		expect(screen.getByLabelText("描述（選填）")).toHaveValue(AI_DESCRIPTION);
		expect(screen.getByAltText("選好的照片")).toBeInTheDocument();
		const body = await save(fetchMock);
		expect(body.description).toBe(AI_DESCRIPTION);
		await waitFor(() => expect(uploadedPhotoName(fetchMock)).toBe("bento.jpg"));
	});

	it("清掉之後再估算一次：新的描述與照片照樣填得進來", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await estimateByPhoto();
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");

		await estimateByPhoto();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue(AI_DESCRIPTION);
		const body = await save(fetchMock);
		expect(body.description).toBe(AI_DESCRIPTION);
		await waitFor(() => expect(uploadedPhotoName(fetchMock)).toBe("bento.jpg"));
	});

	it("存好之後，上一餐 AI 填的描述不會讓下一餐自己打的同一句話被清掉", async () => {
		// 來歷跟著這一餐走：存好就歸零。不歸零的話，下一餐自己打了同一句、又剛好
		// 加過再移除 AI 的項目（那一次 AI 沒有覆蓋），自己打的字會被當成 AI 的清掉。
		const onSaved = vi.fn();
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await estimateByText();
		await addAll();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
		fetchMock.mockClear();

		await pickNoodles();
		await userEvent.type(screen.getByLabelText("描述（選填）"), AI_DESCRIPTION);
		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「雞腿便當」" }),
		);
		await addAll();
		await userEvent.click(screen.getByRole("button", { name: "不記這一樣" }));
		await removeAiItem("白飯");
		await removeAiItem("滷雞腿");
		await pickNoodles();

		expect(screen.getByLabelText("描述（選填）")).toHaveValue(AI_DESCRIPTION);
	});
});

describe("記一餐：整段文字就是食物庫裡的食物", () => {
	it("「用這個」→ 跟從清單選一個一樣：「已選擇」＋份量欄位，焦點在「已選擇」", async () => {
		const fetchMock = mockLogMeal(SHORTCUT);
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await estimateByText("白飯");
		const hit = await screen.findByRole("region", { name: "食物庫裡的食物" });
		await userEvent.click(within(hit).getByRole("button", { name: "用這個" }));

		await waitFor(() =>
			expect(document.activeElement).toBe(screen.getByText("已選擇：白飯")),
		);
		// 不是 AI 的項目：沒有那個清單，描述也不會被填。
		expect(screen.queryByRole("region", { name: "AI 估的項目" })).toBeNull();
		expect(screen.getByLabelText("描述（選填）")).toHaveValue("");
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "180");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(mealBody(fetchMock)).toMatchObject({
				items: [{ food_id: 7, quantity: "180" }],
			}),
		);
		expect(mealBody(fetchMock)).not.toHaveProperty("description");
	});

	it("原本選的食物份量打了 300：改用食物庫的那一個之後份量歸位", async () => {
		mockLogMeal(SHORTCUT);
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "牛肉麵" }),
		);
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "300");
		await estimateByText("白飯");
		const hit = await screen.findByRole("region", { name: "食物庫裡的食物" });
		await userEvent.click(within(hit).getByRole("button", { name: "用這個" }));

		await screen.findByText("已選擇：白飯");
		expect(screen.getByLabelText("份量")).not.toHaveValue("300");
	});
});
