import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PHOTO_BYTES } from "../src/api/photos";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogMeal } from "../src/screens/LogMeal";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

// 上傳會先呼叫 shrinkToLongestEdge 降尺寸，它用 canvas，jsdom 沒有。
// 這裡驗的是「兩步驟的順序與失敗處理」，不是降尺寸本身。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const FREQUENT_FOODS = [
	{
		id: 1,
		name: "滷肉飯",
		brand: null,
		is_global: true,
		nutrition: {
			base_unit: "g",
			kcal: "180.00",
			protein_g: "6.50",
			fat_g: "7.00",
			carb_g: "22.00",
		},
	},
	{
		// 全域食物的初版被駁回——nutrition 是 null。
		// 這不是假設情境，是 FoodResponse 明寫的狀態。
		id: 2,
		name: "沒有營養素的食物",
		brand: null,
		is_global: true,
		nutrition: null,
	},
];

const MY_BOWL = {
	id: 7,
	label: "我的碗",
	grams: "220.00",
	is_default: true,
	is_global: false,
};
const PUBLIC_BOWL = {
	id: 8,
	label: "碗",
	grams: "200.00",
	is_default: true,
	is_global: true,
};
const PUBLIC_PLATE = {
	id: 9,
	label: "盤",
	grams: "300.00",
	is_default: false,
	is_global: true,
};

function mealBody(
	fetchMock: ReturnType<typeof mockApi>,
): { items: Array<Record<string, unknown>> } | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/api/meals"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function mockWithPortions(portions: unknown[]) {
	return mockApi({
		"/api/foods/frequent": () => json(FREQUENT_FOODS),
		"/api/foods/recent": () => json([]),
		"/api/foods/1/portions": () => json(portions),
		"/api/meals": () => json({ id: 99 }, 201),
	});
}

function photoFile(size?: number): File {
	const file = new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" });
	if (size !== undefined) {
		// 不真的配置 10MB——只改 size 屬性，前端的大小檢查只看這個。
		Object.defineProperty(file, "size", { value: size });
	}
	return file;
}

function postedUrls(fetchMock: ReturnType<typeof mockApi>): string[] {
	return fetchMock.mock.calls
		.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "POST")
		.map(([input]) => String(input));
}

const SEARCH_RESULT = {
	id: 3,
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

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記一餐", () => {
	it("選了照片：先建立這一餐，再把照片傳到那一餐", async () => {
		// **路徑順序**：mockApiByPath 依物件的鍵順序用 url.includes 比對，
		// "/api/meals/99/photo" 也「包含」"/api/meals"——照片的路徑要排前面。
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals/99/photo": () => json({ id: 99 }),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.upload(screen.getByLabelText("照片（選填）"), photoFile());
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({ photoFailed: false }),
		);
		expect(postedUrls(fetchMock)).toEqual([
			"/api/meals",
			"/api/meals/99/photo",
		]);
		const photoCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/photo"),
		);
		const body = photoCall?.[1]?.body;
		expect(body).toBeInstanceOf(FormData);
		// 欄位名必須是 "file"——後端是 `file: UploadFile = File(...)`。
		expect((body as FormData).get("file")).toBeInstanceOf(File);
	});

	it("沒選照片就只建立這一餐", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({ photoFailed: false }),
		);
		expect(postedUrls(fetchMock)).toEqual(["/api/meals"]);
	});

	it("照片太大：選的當下就擋，不會傳出去", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.upload(
			screen.getByLabelText("照片（選填）"),
			photoFile(MAX_PHOTO_BYTES + 1),
		);

		expect(await screen.findByRole("alert")).toHaveTextContent("MB 上限");
		expect(screen.queryByAltText("選好的照片")).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));
		await waitFor(() => expect(postedUrls(fetchMock)).toEqual(["/api/meals"]));
	});

	it("餐存好了、照片傳失敗：不算整筆失敗，告訴外層照片沒傳上去", async () => {
		// 讓 mutation 失敗的話，使用者會以為沒記到、再記一次——
		// 那一餐（含餐費）已經在後端了，那就是重複記錢。
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals/99/photo": () =>
				json(
					{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
					500,
				),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		const onSaved = vi.fn();
		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.upload(screen.getByLabelText("照片（選填）"), photoFile());
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(onSaved).toHaveBeenCalledWith({ photoFailed: true }),
		);
		expect(screen.queryByText("記錄失敗，請再試一次")).not.toBeInTheDocument();
		// 沒有重複記錄：POST /api/meals 剛好一次，照片失敗不會讓整筆重送。
		expect(
			postedUrls(fetchMock).filter((url) => url === "/api/meals"),
		).toHaveLength(1);
	});

	it("移除照片之後就不會上傳", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.upload(screen.getByLabelText("照片（選填）"), photoFile());
		expect(await screen.findByAltText("選好的照片")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "移除照片" }));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(postedUrls(fetchMock)).toEqual(["/api/meals"]));
	});

	it("列出常吃的食物", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();
	});

	it("nutrition 是 null 的食物不會讓畫面炸掉", async () => {
		// FoodResponse.nutrition 的註解：「沒有生效版本時為 None ——
		// 全域食物的初版被駁回就會是這個狀態」。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(await screen.findByText("沒有營養素的食物")).toBeInTheDocument();
	});

	it("送出時只帶 food_id 與 quantity，不帶自己算的公克數", async () => {
		// 交接文件 §4.3：quantity_g 由伺服器在寫入當下算好並凍結。
		// 前端算一次就是把「凍結歷史」這個保證從另一頭破壞掉。
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 1, items: [] }),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.clear(screen.getByLabelText("份量"));
		await userEvent.type(screen.getByLabelText("份量"), "200");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		const mealCall = fetchMock.mock.calls.find(
			([input, init]) =>
				String(input).includes("/api/meals") && init?.method === "POST",
		);
		const body = JSON.parse(String(mealCall?.[1]?.body));
		expect(body.items[0]).toMatchObject({ food_id: 1, quantity: "200" });
		expect(body.items[0]).not.toHaveProperty("quantity_g");
	});

	it("送出成功後呼叫 onSaved", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 1, items: [] }),
		});
		const onSaved = vi.fn();

		render(wrap(<LogMeal onSaved={onSaved} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
	});

	it("搜尋框輸入之後（等過 debounce）出現搜尋結果，而且常吃/最近吃還在", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			// 更具體的路徑（frequent/recent）排在前面——mockApiByPath 用
			// url.includes(path) 依序比對，"/api/foods" 這個廣義路徑放前面
			// 的話會搶先吃掉 /api/foods/frequent 的請求。
			"/api/foods": () => json([SEARCH_RESULT]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		expect(await screen.findByText("滷肉飯")).toBeInTheDocument();

		await userEvent.type(screen.getByLabelText("搜尋食物"), "白飯");

		expect(await screen.findByText("白飯")).toBeInTheDocument();
		// 常吃/最近吃還在——搜尋結果是加上去的，不是取代掉原本的清單。
		expect(screen.getByText("滷肉飯")).toBeInTheDocument();

		const searchCall = fetchMock.mock.calls.find(
			([input]) =>
				String(input).includes("/api/foods?") &&
				String(input).includes("q=%E7%99%BD%E9%A3%AF"),
		);
		expect(searchCall).toBeDefined();
	});

	it("從搜尋結果選一個食物，行為跟從常吃選一個完全一樣（進份量輸入）", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/3/portions": () => json([]),
			"/api/foods": () => json([SEARCH_RESULT]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.type(screen.getByLabelText("搜尋食物"), "白飯");

		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));

		expect(screen.getByText("已選擇：白飯")).toBeInTheDocument();
		expect(screen.getByLabelText("份量")).toBeInTheDocument();
	});

	it("nutrition === null 的食物不能被選——按鈕 disabled，並顯示原因", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));

		const button = await screen.findByRole("button", {
			name: "沒有營養素的食物",
		});
		expect(button).toBeDisabled();
		expect(
			screen.getByText("這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
	});

	it("填了金額就一起送出 cost", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.type(screen.getByLabelText("金額（選填）"), "180");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => {
			const call = fetchMock.mock.calls.find(
				([input, init]) =>
					(init?.method ?? "GET").toUpperCase() === "POST" &&
					String(input).includes("/api/meals"),
			);
			expect(call).toBeDefined();
			expect(JSON.parse(String(call?.[1]?.body)).cost).toBe("180");
		});
	});

	it("沒填金額時不送 cost 欄位", async () => {
		// **不是送 null、也不是送空字串。** 後端的 cost 是
		// `Decimal | None = Field(default=None, gt=0, ...)`：
		// - 送 "" → Pydantic 擋成 422
		// - 送 null → 合法，但語意上繞了一圈
		// - 不帶 → 後端的 default=None 生效，最乾淨
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => {
			const call = fetchMock.mock.calls.find(
				([input, init]) =>
					(init?.method ?? "GET").toUpperCase() === "POST" &&
					String(input).includes("/api/meals"),
			);
			expect(call).toBeDefined();
			expect(JSON.parse(String(call?.[1]?.body))).not.toHaveProperty("cost");
		});
	});

	it("409 FOOD_HAS_NO_REVISION 顯示具名訊息，不是通用的「記錄失敗，請再試一次」", async () => {
		// 搜尋到送出之間，食物有可能剛好失去生效版本——disabled 擋不住
		// 這種情況（選的當下 nutrition 還不是 null），所以後端這個 409
		// 仍然要具名處理。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () =>
				json(
					{
						error: {
							code: "FOOD_HAS_NO_REVISION",
							message: "這個食物目前沒有生效的版本",
							details: {},
						},
					},
					409,
				),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(
			await screen.findByText("這個食物目前沒有生效的版本"),
		).toBeInTheDocument();
		expect(screen.queryByText("記錄失敗，請再試一次")).not.toBeInTheDocument();
	});

	it("換算後的公克數超出範圍：顯示後端訊息，不是「記錄失敗，請再試一次」", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () =>
				json(
					{
						error: {
							code: "QUANTITY_OUT_OF_RANGE",
							message:
								"換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量",
							details: {},
						},
					},
					422,
				),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(
			await screen.findByText(
				"換算後的公克數超出範圍（0.01 到 999,999.99 g），請改數量",
			),
		).toBeInTheDocument();
		expect(screen.queryByText("記錄失敗，請再試一次")).not.toBeInTheDocument();
	});

	it("cost 格式錯誤顯示金額專屬訊息，不是通用或誤指份量", async () => {
		// 真實信封形狀（規格 §5.4）：details.errors 是 loc / msg / type 的陣列。
		// loc 要含 "cost" 才會顯示這句——同一次 POST 的 quantity 欄位
		// 也可能觸發 VALIDATION_ERROR，不能一律當成金額錯誤。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () =>
				json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "輸入資料格式錯誤",
							details: {
								errors: [
									{
										loc: ["body", "cost"],
										msg: "Input should be greater than 0",
										type: "greater_than",
									},
								],
							},
						},
					},
					422,
				),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.type(screen.getByLabelText("金額（選填）"), "0");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(
			await screen.findByText("金額格式不對，請輸入大於 0、最多兩位小數的數字"),
		).toBeInTheDocument();
		expect(screen.queryByText("記錄失敗，請再試一次")).not.toBeInTheDocument();
	});

	it("quantity 格式錯誤不會被誤報成金額格式不對", async () => {
		// 跟上一條測試對稱：loc 指到 items[0].quantity，不是 cost——
		// 這種 422 該落回通用訊息，不能被誤判成金額錯誤。
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () =>
				json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "輸入資料格式錯誤",
							details: {
								errors: [
									{
										loc: ["body", "items", 0, "quantity"],
										msg: "Input should be greater than 0",
										type: "greater_than",
									},
								],
							},
						},
					},
					422,
				),
		});

		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(await screen.findByText("記錄失敗，請再試一次")).toBeInTheDocument();
		expect(
			screen.queryByText("金額格式不對，請輸入大於 0、最多兩位小數的數字"),
		).not.toBeInTheDocument();
	});

	it("記一餐成功後讓花費（expensesAll）的 query 失效——餐費會建出一筆支出", async () => {
		mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});

		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const invalidateSpy = vi.spyOn(client, "invalidateQueries");

		render(
			<QueryClientProvider client={client}>
				<LogMeal onSaved={vi.fn()} />
			</QueryClientProvider>,
		);
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.type(screen.getByLabelText("金額（選填）"), "180");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => {
			expect(invalidateSpy).toHaveBeenCalledWith({
				queryKey: queryKeys.expensesAll,
			});
		});
	});

	it("有自己的預設份量：自動選上，數量 1，送出帶它的 portion_id", async () => {
		const fetchMock = mockWithPortions([PUBLIC_BOWL, MY_BOWL, PUBLIC_PLATE]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);
		expect(screen.getByLabelText("份量")).toHaveValue("1");

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)?.items[0]).toMatchObject({
			portion_id: 7,
			quantity: "1",
		});
	});

	it("只有公開的預設份量：選公開的", async () => {
		mockWithPortions([PUBLIC_BOWL, PUBLIC_PLATE]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("8"),
		);
	});

	it("沒有預設份量：維持「直接輸入數量」，送出不帶 portion_id", async () => {
		const fetchMock = mockWithPortions([PUBLIC_PLATE]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await screen.findByLabelText("份量選項");

		expect(screen.getByLabelText("份量選項")).toHaveValue("");

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)?.items[0]).not.toHaveProperty("portion_id");
	});

	it("手動改成「直接輸入數量」之後就照使用者的，不會被預設份量蓋回去", async () => {
		const fetchMock = mockWithPortions([MY_BOWL]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)?.items[0]).not.toHaveProperty("portion_id");
	});

	it("使用者動過數量之後，晚到的份量清單不會把「200 g」變成「200 份」", async () => {
		let resolvePortions: (response: Response) => void = () => {};
		const portionsGate = new Promise<Response>((resolve) => {
			resolvePortions = resolve;
		});
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(async (input) => {
				const url = String(input);
				if (url.includes("/api/foods/1/portions")) return portionsGate;
				if (url.includes("/api/foods/frequent")) return json(FREQUENT_FOODS);
				if (url.includes("/api/foods/recent")) return json([]);
				if (url.includes("/api/meals")) return json({ id: 99 }, 201);
				throw new Error(`未預期的請求：${url}`);
			});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		const quantity = screen.getByLabelText("份量");
		await userEvent.clear(quantity);
		await userEvent.type(quantity, "200");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("g");

		resolvePortions(json([MY_BOWL]));
		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toBeInTheDocument(),
		);
		expect(screen.getByLabelText("份量選項")).toHaveValue("");
		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("g");

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		const item = mealBody(fetchMock)?.items[0];
		expect(item).not.toHaveProperty("portion_id");
		expect(item).toMatchObject({ quantity: "200" });
	});

	it("數量旁邊的單位提示：選了份量是「份」，直接輸入是「g」", async () => {
		mockWithPortions([MY_BOWL]);
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));
		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("7"),
		);

		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("份");

		await userEvent.selectOptions(screen.getByLabelText("份量選項"), "");

		expect(screen.getByTestId("quantity-unit")).toHaveTextContent("g");
	});

	it("勾「只有我看得到」就送 is_private: true", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.click(
			screen.getByLabelText("只有我看得到（好友看不到這一餐）"),
		);
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(mealBody(fetchMock)).toMatchObject({ is_private: true }),
		);
	});

	it("不勾就不送 is_private（後端預設給好友看）", async () => {
		const fetchMock = mockApi({
			"/api/foods/frequent": () => json(FREQUENT_FOODS),
			"/api/foods/recent": () => json([]),
			"/api/foods/1/portions": () => json([]),
			"/api/meals": () => json({ id: 99 }, 201),
		});
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		await userEvent.click(await screen.findByText("滷肉飯"));

		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() => expect(mealBody(fetchMock)).not.toBeNull());
		expect(mealBody(fetchMock)).not.toHaveProperty("is_private");
	});
});
