import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import {
	MemoryRouter,
	Route,
	Routes,
	useLocation,
	useNavigate,
	useParams,
} from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelReadResponse } from "../src/api/ai";
import type { BarcodePrefill } from "../src/api/barcode";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import type { NewFoodHandoff } from "../src/lib/new-food-handoff";
import { NewFood } from "../src/screens/NewFood";
import { pickPhoto } from "./helpers/ai-photo";
import { makeFood } from "./helpers/foods";
import { json, mockApi } from "./helpers/mock-api";

// 照片會先經過 shrinkToLongestEdge（canvas，jsdom 沒有）——原樣回傳。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const COLA: BarcodePrefill = {
	name: "可口可樂",
	brand: "Coca-Cola",
	base_unit: "ml",
	per100: { kcal: "42.00", protein_g: "0.00", fat_g: "0.00", carb_g: "10.60" },
	serving: { amount: "330.00", unit: "ml" },
	source: "openfoodfacts",
};

/** 規格 §8.4 的那一份。 */
const LABEL: LabelReadResponse = {
	analysis_id: 31,
	name: "海苔洋芋片",
	nutrition: {
		base_unit: "g",
		kcal: "514.29",
		protein_g: "6.00",
		fat_g: "28.00",
		carb_g: "60.86",
	},
	serving: { amount: "35.00", unit: "g" },
	servings_per_package: "4.00",
	basis: "per_serving",
	confidence: "0.80",
	consistency: { atwater_kcal: "519.44", deviation: "5.15", flagged: false },
	remaining_today: 17,
};

const CREATED = makeFood({
	id: 30,
	name: "可口可樂",
	barcode: "5449000000996",
});

const AI_ESTIMATE = {
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
	confidence: "0.37",
	consistency: {
		atwater_kcal: "610.00",
		deviation: "10.00",
		flagged: false,
	},
	remaining_today: 19,
};

/** 「描述這個食物」→「估算」→「確認」。回傳結果卡片。 */
async function confirmAiEstimate() {
	await userEvent.type(screen.getByLabelText("描述這個食物"), "一碗牛肉麵");
	await userEvent.click(screen.getByRole("button", { name: "估算" }));
	const card = await screen.findByRole("region", { name: "AI 估算結果" });
	await userEvent.click(within(card).getByRole("button", { name: "確認" }));
	return card;
}

function patchBodies(fetchMock: ReturnType<typeof mockApi>): unknown[] {
	return fetchMock.mock.calls
		.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === "PATCH")
		.map(([, init]) => JSON.parse(String(init?.body)));
}

function handoff(overrides: Partial<NewFoodHandoff> = {}): NewFoodHandoff {
	return {
		barcode: "4710088432094",
		prefill: null,
		returnTo: null,
		...overrides,
	};
}

function FakeFoodDetail() {
	const { id } = useParams();
	return <p>food-detail:{id}</p>;
}

/** 記一餐（或編輯這一餐）的假頁面：看得到帶回來的 state，「返回」看得出是 push 還是 replace。 */
function ReturnProbe({ title }: { title: string }) {
	const location = useLocation();
	const navigate = useNavigate();
	return (
		<>
			<h1>{title}</h1>
			<p data-testid="state">{JSON.stringify(location.state)}</p>
			<button type="button" onClick={() => navigate(-1)}>
				返回
			</button>
		</>
	);
}

/** 從 `/before`（記一餐之前的那一頁）進來；記一餐那一筆 history 已經被 replace 成 /foods/new。 */
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/before", "/foods/new"]} initialIndex={1}>
				<Routes>
					<Route path="/before" element={<p>之前的那一頁</p>} />
					<Route path="/foods/new" element={children} />
					<Route path="/foods/:id" element={<FakeFoodDetail />} />
					<Route path="/meals/new" element={<ReturnProbe title="記一餐頁" />} />
					<Route
						path="/meals/:id/edit"
						element={<ReturnProbe title="編輯這一餐頁" />}
					/>
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

function postBody(
	fetchMock: ReturnType<typeof mockApi>,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input) === "/api/foods",
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function mockCreate(response: () => Response = () => json(CREATED, 201)) {
	return mockApi([{ method: "POST", path: "/api/foods", handler: response }]);
}

async function fillNutrition() {
	await userEvent.type(screen.getByLabelText("熱量（每 100 單位 kcal）"), "42");
	await userEvent.type(screen.getByLabelText("蛋白質（g）"), "0");
	await userEvent.type(screen.getByLabelText("脂肪（g）"), "0");
	await userEvent.type(screen.getByLabelText("碳水化合物（g）"), "10.6");
}

const JPEG = () => new File(["fake-jpeg"], "label.jpg", { type: "image/jpeg" });

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("新增食物：掃條碼帶來的預填（掃條碼規格 §11、D29）", () => {
	it("Open Food Facts 的預填：名稱、品牌、單位、四個數字、一份、條碼；出處與確認的提醒", () => {
		mockApi([]);
		render(
			wrap(
				<NewFood
					handoff={handoff({ barcode: "5449000000996", prefill: COLA })}
				/>,
			),
		);

		expect(screen.getByLabelText("名稱")).toHaveValue("可口可樂");
		expect(screen.getByLabelText("品牌（選填）")).toHaveValue("Coca-Cola");
		expect(screen.getByLabelText("單位")).toHaveValue("ml");
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue(
			"42.00",
		);
		expect(screen.getByLabelText("蛋白質（g）")).toHaveValue("0.00");
		expect(screen.getByLabelText("脂肪（g）")).toHaveValue("0.00");
		expect(screen.getByLabelText("碳水化合物（g）")).toHaveValue("10.60");
		expect(screen.getByLabelText("份量名稱")).toHaveValue("份");
		expect(screen.getByLabelText("每份重量（ml）")).toHaveValue("330.00");
		expect(screen.getByLabelText("條碼（選填）")).toHaveValue("5449000000996");
		expect(screen.getByRole("radio", { name: "每 100 ml" })).toBeChecked();

		expect(
			screen.getByText("已從 Open Food Facts 帶入，請對照包裝確認"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("link", { name: "Open Food Facts" }),
		).toHaveAttribute("href", "https://world.openfoodfacts.org");
		expect(
			screen.getByText("已帶入包裝上的一份，不要的話清掉"),
		).toBeInTheDocument();
		expect(
			screen.queryByText(
				"找不到這個條碼的資料。拍營養標示讓 AI 讀數字，或自己填。",
			),
		).not.toBeInTheDocument();
	});

	it("預填沒有名稱、品牌、一份：那幾欄留空", () => {
		mockApi([]);
		render(
			wrap(
				<NewFood
					handoff={handoff({
						barcode: "5449000000996",
						prefill: { ...COLA, name: null, brand: null, serving: null },
					})}
				/>,
			),
		);

		expect(screen.getByLabelText("名稱")).toHaveValue("");
		expect(screen.getByLabelText("品牌（選填）")).toHaveValue("");
		expect(screen.getByLabelText("份量名稱")).toHaveValue("");
		expect(screen.getByLabelText("每份重量（ml）")).toHaveValue("");
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue(
			"42.00",
		);
		expect(
			screen.queryByText("已帶入包裝上的一份，不要的話清掉"),
		).not.toBeInTheDocument();
	});

	it("只有條碼：條碼填好、其餘空；提示拍營養標示", () => {
		mockApi([]);
		render(wrap(<NewFood handoff={handoff()} />));

		expect(screen.getByLabelText("條碼（選填）")).toHaveValue("4710088432094");
		expect(screen.getByLabelText("名稱")).toHaveValue("");
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue("");
		expect(
			screen.getByText(
				"找不到這個條碼的資料。拍營養標示讓 AI 讀數字，或自己填。",
			),
		).toBeInTheDocument();
		expect(screen.queryByText(/資料來源/)).not.toBeInTheDocument();
	});

	it("沒有交接（從食物庫的「新增食物」來）：沒有提示、條碼空的", () => {
		mockApi([]);
		render(wrap(<NewFood />));

		expect(screen.getByLabelText("條碼（選填）")).toHaveValue("");
		expect(screen.queryByText(/找不到這個條碼/)).not.toBeInTheDocument();
		expect(screen.queryByText(/資料來源/)).not.toBeInTheDocument();
	});
});

describe("新增食物：條碼欄位（掃條碼規格 D22）", () => {
	it("條碼欄位：數字鍵盤、不自動完成", () => {
		mockApi([]);
		render(wrap(<NewFood />));

		const input = screen.getByLabelText("條碼（選填）");
		expect(input).toHaveAttribute("inputmode", "numeric");
		expect(input).toHaveAttribute("autocomplete", "off");
	});

	it("送出：去掉分隔符號帶 barcode；空的就不帶這個 key", async () => {
		const fetchMock = mockCreate();
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "洋芋片");
		await userEvent.type(
			screen.getByLabelText("條碼（選填）"),
			"4710088-432094",
		);
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		await screen.findByText("food-detail:30");
		expect(postBody(fetchMock)?.barcode).toBe("4710088432094");
	});

	it("條碼空的：body 沒有 barcode", async () => {
		const fetchMock = mockCreate();
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "洋芋片");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		await screen.findByText("food-detail:30");
		expect(postBody(fetchMock)).not.toHaveProperty("barcode");
	});

	it("不像條碼（123）：擋下來、不送", async () => {
		const fetchMock = mockCreate();
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "洋芋片");
		await userEvent.type(screen.getByLabelText("條碼（選填）"), "123");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"條碼要是 8、12 或 13 位數字",
		);
		expect(postBody(fetchMock)).toBeNull();
	});

	it("409 BARCODE_EXISTS：後端那一句", async () => {
		mockCreate(() =>
			json(
				{
					error: {
						code: "BARCODE_EXISTS",
						message: "你已經有一個用這個條碼的食物了",
						details: { food_id: 3 },
					},
				},
				409,
			),
		);
		render(wrap(<NewFood handoff={handoff()} />));

		await userEvent.type(screen.getByLabelText("名稱"), "洋芋片");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"你已經有一個用這個條碼的食物了",
		);
	});

	it("422 出在條碼：後端的那一句，不是「barcode：Value error, …」", async () => {
		mockCreate(() =>
			json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: "輸入格式不對",
						details: {
							errors: [
								{
									loc: ["body", "barcode"],
									msg: "Value error, 條碼的檢查碼不對，請再確認一次",
									type: "value_error",
								},
							],
						},
					},
				},
				422,
			),
		);
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "洋芋片");
		await userEvent.type(
			screen.getByLabelText("條碼（選填）"),
			"4710088432096",
		);
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		const alert = await screen.findByRole("alert");
		expect(alert).toHaveTextContent("條碼的檢查碼不對，請再確認一次");
		expect(alert).not.toHaveTextContent("Value error");
	});
});

describe("新增食物：存好之後回去（掃條碼規格 D20）", () => {
	it("returnTo /meals/new：存好回到記一餐、replace、帶著建好的食物", async () => {
		mockCreate();
		render(wrap(<NewFood handoff={handoff({ returnTo: "/meals/new" })} />));

		await userEvent.type(screen.getByLabelText("名稱"), "可口可樂");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(
			await screen.findByRole("heading", { name: "記一餐頁" }),
		).toBeInTheDocument();
		expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual({
			pickedFood: CREATED,
		});
		// replace：返回不會回到新增食物，而是記一餐之前的那一頁。
		await userEvent.click(screen.getByRole("button", { name: "返回" }));
		expect(await screen.findByText("之前的那一頁")).toBeInTheDocument();
	});

	it("沒有 returnTo：照舊到詳情頁", async () => {
		mockCreate();
		render(wrap(<NewFood handoff={handoff()} />));

		await userEvent.type(screen.getByLabelText("名稱"), "可口可樂");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(await screen.findByText("food-detail:30")).toBeInTheDocument();
	});

	it("「取消，回到記一餐」：replace 回去、不帶食物", async () => {
		mockApi([]);
		render(wrap(<NewFood handoff={handoff({ returnTo: "/meals/new" })} />));

		await userEvent.click(
			screen.getByRole("button", { name: "取消，回到記一餐" }),
		);

		expect(
			await screen.findByRole("heading", { name: "記一餐頁" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("state")).toHaveTextContent("null");
		await userEvent.click(screen.getByRole("button", { name: "返回" }));
		expect(await screen.findByText("之前的那一頁")).toBeInTheDocument();
	});

	it("從編輯這一餐來：「取消，回到這一餐」", async () => {
		mockApi([]);
		render(wrap(<NewFood handoff={handoff({ returnTo: "/meals/5/edit" })} />));

		await userEvent.click(
			screen.getByRole("button", { name: "取消，回到這一餐" }),
		);

		expect(
			await screen.findByRole("heading", { name: "編輯這一餐頁" }),
		).toBeInTheDocument();
	});

	it("沒有 returnTo：沒有取消的按鈕", () => {
		mockApi([]);
		render(wrap(<NewFood handoff={handoff()} />));

		expect(
			screen.queryByRole("button", { name: /^取消，回到/ }),
		).not.toBeInTheDocument();
	});

	it("有 returnTo 時，AI 面板存好的食物也交回去——帶著條碼（審查 M2）", async () => {
		// AI 面板自己 POST /api/foods、不知道交接來的條碼：存好之後 PATCH 上去（自己的食物）。
		const saved = makeFood({ id: 31, name: "牛肉麵" });
		const patched = { ...saved, barcode: "4710088432094" };
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json(AI_ESTIMATE),
			},
			{ method: "GET", path: "/api/foods?", handler: () => json([]) },
			{ method: "PATCH", path: "/api/foods/31", handler: () => json(patched) },
			{ method: "POST", path: "/api/foods", handler: () => json(saved, 201) },
		]);
		render(wrap(<NewFood handoff={handoff({ returnTo: "/meals/new" })} />));

		await confirmAiEstimate();

		expect(
			await screen.findByRole("heading", { name: "記一餐頁" }),
		).toBeInTheDocument();
		expect(JSON.parse(screen.getByTestId("state").textContent ?? "")).toEqual({
			pickedFood: patched,
		});
		expect(patchBodies(fetchMock)).toEqual([{ barcode: "4710088432094" }]);
	});

	it("AI 面板交回食物庫裡的公開食物：不 PATCH（一般使用者會 403），原樣交回", async () => {
		const library = makeFood({ id: 40, name: "牛肉麵", is_global: true });
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json(AI_ESTIMATE),
			},
			{ method: "GET", path: "/api/foods?", handler: () => json([library]) },
			{ method: "GET", path: "/api/foods/40", handler: () => json(library) },
		]);
		render(wrap(<NewFood handoff={handoff()} />));

		const card = await confirmAiEstimate();
		await userEvent.click(
			await within(card).findByRole("button", { name: "用食物庫的" }),
		);

		expect(await screen.findByText("food-detail:40")).toBeInTheDocument();
		expect(patchBodies(fetchMock)).toEqual([]);
	});

	it("AI 面板交回自己已經有條碼的食物：不蓋掉那個條碼", async () => {
		const mine = makeFood({ id: 41, name: "牛肉麵", barcode: "96385074" });
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json(AI_ESTIMATE),
			},
			{ method: "GET", path: "/api/foods?", handler: () => json([mine]) },
			{ method: "GET", path: "/api/foods/41", handler: () => json(mine) },
		]);
		render(wrap(<NewFood handoff={handoff()} />));

		const card = await confirmAiEstimate();
		await userEvent.click(
			await within(card).findByRole("button", { name: "用食物庫的" }),
		);

		expect(await screen.findByText("food-detail:41")).toBeInTheDocument();
		expect(patchBodies(fetchMock)).toEqual([]);
	});

	it("條碼欄位清空了：不 PATCH", async () => {
		const saved = makeFood({ id: 31, name: "牛肉麵" });
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json(AI_ESTIMATE),
			},
			{ method: "GET", path: "/api/foods?", handler: () => json([]) },
			{ method: "POST", path: "/api/foods", handler: () => json(saved, 201) },
		]);
		render(wrap(<NewFood handoff={handoff()} />));
		await userEvent.clear(screen.getByLabelText("條碼（選填）"));

		await confirmAiEstimate();

		expect(await screen.findByText("food-detail:31")).toBeInTheDocument();
		expect(patchBodies(fetchMock)).toEqual([]);
	});

	it("PATCH 失敗（例如 409）：食物已經建好了，照樣交出去（條碼可以在詳情頁再設）", async () => {
		const saved = makeFood({ id: 31, name: "牛肉麵" });
		mockApi([
			{
				method: "POST",
				path: "/api/ai/analyze",
				handler: () => json(AI_ESTIMATE),
			},
			{ method: "GET", path: "/api/foods?", handler: () => json([]) },
			{
				method: "PATCH",
				path: "/api/foods/31",
				handler: () =>
					json(
						{
							error: {
								code: "BARCODE_EXISTS",
								message: "x",
								details: { food_id: 9 },
							},
						},
						409,
					),
			},
			{ method: "POST", path: "/api/foods", handler: () => json(saved, 201) },
		]);
		render(wrap(<NewFood handoff={handoff()} />));

		await confirmAiEstimate();

		expect(await screen.findByText("food-detail:31")).toBeInTheDocument();
	});
});

describe("新增食物：拍營養標示（掃條碼規格 §8.5）", () => {
	function mockLabel(response: () => Response | Promise<Response>) {
		return mockApi([
			{ method: "POST", path: "/api/ai/read-label", handler: response },
		]);
	}

	it("讀好：名稱、單位、四個數字、一份填好；提醒、幾份、剩幾次；條碼不動", async () => {
		const fetchMock = mockLabel(() => json(LABEL));
		render(wrap(<NewFood handoff={handoff()} />));

		const picker = screen.getByLabelText("拍營養標示");
		expect(picker).toHaveAttribute("capture", "environment");
		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		expect(
			await screen.findByText("AI 讀的數字，請對照包裝確認"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("名稱")).toHaveValue("海苔洋芋片");
		expect(screen.getByLabelText("單位")).toHaveValue("g");
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue(
			"514.29",
		);
		expect(screen.getByLabelText("蛋白質（g）")).toHaveValue("6.00");
		expect(screen.getByLabelText("脂肪（g）")).toHaveValue("28.00");
		expect(screen.getByLabelText("碳水化合物（g）")).toHaveValue("60.86");
		expect(screen.getByLabelText("份量名稱")).toHaveValue("份");
		expect(screen.getByLabelText("每份重量（g）")).toHaveValue("35.00");
		expect(screen.getByRole("radio", { name: "每 100 g" })).toBeChecked();
		expect(screen.getByText("本包裝含 4 份")).toBeInTheDocument();
		expect(screen.getByText("今天還能用 17 次")).toBeInTheDocument();
		expect(
			screen.getByText("已帶入包裝上的一份，不要的話清掉"),
		).toBeInTheDocument();
		expect(
			screen.queryByText("熱量跟三大營養素算起來對不太上，請特別確認"),
		).not.toBeInTheDocument();
		expect(screen.getByLabelText("條碼（選填）")).toHaveValue("4710088432094");

		const call = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/ai/read-label"),
		);
		expect(JSON.parse(String(call?.[1]?.body))).toEqual({
			image_base64: btoa("fake-jpeg"),
		});
	});

	it("名稱已經打了字：不覆蓋；品牌不動", async () => {
		mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));

		await userEvent.type(screen.getByLabelText("名稱"), "我的洋芋片");
		await userEvent.type(screen.getByLabelText("品牌（選填）"), "某牌");
		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(screen.getByLabelText("名稱")).toHaveValue("我的洋芋片");
		expect(screen.getByLabelText("品牌（選填）")).toHaveValue("某牌");
	});

	it("切成「每一份」之後讀：切回每 100（讀到的是每 100 的數字）", async () => {
		mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));
		await userEvent.type(screen.getByLabelText("每份重量（g）"), "50");
		await userEvent.click(screen.getByRole("radio", { name: "每一份" }));

		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(screen.getByRole("radio", { name: "每 100 g" })).toBeChecked();
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue(
			"514.29",
		);
	});

	it("沒有一份、沒有幾份：那兩行不出現", async () => {
		mockLabel(() =>
			json({ ...LABEL, serving: null, servings_per_package: null }),
		);
		render(wrap(<NewFood />));

		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(screen.getByLabelText("份量名稱")).toHaveValue("");
		expect(screen.queryByText(/本包裝含/)).not.toBeInTheDocument();
		expect(
			screen.queryByText("已帶入包裝上的一份，不要的話清掉"),
		).not.toBeInTheDocument();
	});

	it("一致性被標記：多一句", async () => {
		mockLabel(() =>
			json({
				...LABEL,
				consistency: {
					atwater_kcal: "900.00",
					deviation: "385.71",
					flagged: true,
				},
			}),
		);
		render(wrap(<NewFood />));

		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		expect(
			await screen.findByText("熱量跟三大營養素算起來對不太上，請特別確認"),
		).toBeInTheDocument();
	});

	it("502 AI_LABEL_UNREADABLE：原樣顯示後端那一句、表單沒動", async () => {
		const message =
			"AI 讀不出這張營養標示的數字，換一張清楚一點、整個表格都在畫面裡的照片再試（這一次也算在今天的次數裡）";
		mockLabel(() =>
			json(
				{ error: { code: "AI_LABEL_UNREADABLE", message, details: {} } },
				502,
			),
		);
		render(wrap(<NewFood handoff={handoff()} />));

		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		expect(screen.getByLabelText("名稱")).toHaveValue("");
		expect(screen.getByLabelText("熱量（每 100 單位 kcal）")).toHaveValue("");
		expect(screen.getByLabelText("條碼（選填）")).toHaveValue("4710088432094");
	});

	it("讀的時候：「AI 讀取中…」、照片的選擇停用；讀完焦點到結果那一段（不掉到 body）", async () => {
		let release: (response: Response) => void = () => {};
		mockLabel(
			() =>
				new Promise<Response>((done) => {
					release = done;
				}),
		);
		render(wrap(<NewFood />));
		const picker = screen.getByLabelText("拍營養標示");

		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		expect(await screen.findByText("AI 讀取中…")).toBeInTheDocument();
		expect(picker).toBeDisabled();
		release(json(LABEL));
		const done = await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(picker).not.toBeDisabled();
		await waitFor(() => expect(done.closest("[tabindex]")).toHaveFocus());
	});
});

describe("新增食物：拍營養標示＋補充說明（照片說明規格 §6）", () => {
	function mockLabel(response: () => Response | Promise<Response>) {
		return mockApi([
			{ method: "POST", path: "/api/ai/read-label", handler: response },
		]);
	}

	function labelBodies(fetchMock: ReturnType<typeof mockApi>) {
		return fetchMock.mock.calls
			.filter(([input]) => String(input).includes("/api/ai/read-label"))
			.map(([, init]) => JSON.parse(String(init?.body)));
	}

	function step() {
		return screen.getByRole("region", { name: "確認照片" });
	}

	it("選了照片：不打網路、出卡片（placeholder 是營養標示的例子），焦點在卡片上", async () => {
		const fetchMock = mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));

		await userEvent.upload(screen.getByLabelText("拍營養標示"), JPEG());

		await waitFor(() => expect(step()).toHaveFocus());
		// 新增食物自己會讀 /api/me：斷言的是沒有讀營養標示。
		expect(labelBodies(fetchMock)).toEqual([]);
		expect(within(step()).getByLabelText("補充說明（選填）")).toHaveAttribute(
			"placeholder",
			"例：這是每 100 ml、一包 2 份",
		);
		expect(
			within(step()).getByRole("button", { name: "開始讀取" }),
		).toBeInTheDocument();
	});

	it("打說明、開始讀取：body 帶 hint；讀好卡片收起、焦點到結果那一段", async () => {
		const fetchMock = mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));

		await pickPhoto("拍營養標示", JPEG(), {
			hint: "這是每 100 ml",
			start: "開始讀取",
		});

		const done = await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(labelBodies(fetchMock)).toEqual([
			{ image_base64: btoa("fake-jpeg"), hint: "這是每 100 ml" },
		]);
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		await waitFor(() => expect(done.closest("[tabindex]")).toHaveFocus());
	});

	it("失敗：卡片與說明都還在；再按「開始讀取」帶同一段說明再讀一次", async () => {
		let attempt = 0;
		const fetchMock = mockLabel(() => {
			attempt += 1;
			return attempt === 1
				? json(
						{
							error: {
								code: "AI_UPSTREAM_ERROR",
								message: "AI 暫時無法使用，請稍後再試",
								details: {},
							},
						},
						502,
					)
				: json(LABEL);
		});
		render(wrap(<NewFood />));

		await pickPhoto("拍營養標示", JPEG(), {
			hint: "一包 2 份",
			start: "開始讀取",
		});

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"AI 暫時無法使用，請稍後再試",
		);
		expect(within(step()).getByLabelText("補充說明（選填）")).toHaveValue(
			"一包 2 份",
		);
		await userEvent.click(
			within(step()).getByRole("button", { name: "開始讀取" }),
		);

		await screen.findByText("AI 讀的數字，請對照包裝確認");
		const bodies = labelBodies(fetchMock);
		expect(bodies).toHaveLength(2);
		expect(bodies[1]).toEqual(bodies[0]);
		expect(bodies[1].hint).toBe("一包 2 份");
	});

	it("照片太大：選的當下就擋，不出卡片、不打網路", async () => {
		const fetchMock = mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));
		const big = JPEG();
		Object.defineProperty(big, "size", { value: 10 * 1024 * 1024 + 1 });

		await userEvent.upload(screen.getByLabelText("拍營養標示"), big);

		expect(await screen.findByRole("alert")).toHaveTextContent("照片超過");
		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		// 新增食物自己會讀 /api/me：斷言的是沒有讀營養標示。
		expect(labelBodies(fetchMock)).toEqual([]);
	});

	it("取消：卡片收起、沒打網路，焦點回到「拍營養標示」", async () => {
		const fetchMock = mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));
		await userEvent.upload(screen.getByLabelText("拍營養標示"), JPEG());

		await userEvent.click(within(step()).getByRole("button", { name: "取消" }));

		expect(
			screen.queryByRole("region", { name: "確認照片" }),
		).not.toBeInTheDocument();
		// 新增食物自己會讀 /api/me：斷言的是沒有讀營養標示。
		expect(labelBodies(fetchMock)).toEqual([]);
		await waitFor(() =>
			expect(screen.getByLabelText("拍營養標示")).toHaveFocus(),
		);
	});

	it("讀取中：「開始讀取」aria-disabled、旁邊數秒；status 只念「AI 讀取中…」不含秒數", async () => {
		let release: (response: Response) => void = () => {};
		mockLabel(
			() =>
				new Promise<Response>((resolve) => {
					release = resolve;
				}),
		);
		render(wrap(<NewFood />));

		await pickPhoto("拍營養標示", JPEG(), { start: "開始讀取" });

		expect(
			within(step()).getByRole("button", { name: "開始讀取" }),
		).toHaveAttribute("aria-disabled", "true");
		expect(await screen.findByText("0 秒")).toBeInTheDocument();
		const status = screen.getByText("AI 讀取中…").closest("[role=status]");
		expect(status).not.toBeNull();
		expect(status).not.toHaveTextContent("秒");

		release(json(LABEL));
		await screen.findByText("AI 讀的數字，請對照包裝確認");
		expect(screen.queryByText(/秒$/)).not.toBeInTheDocument();
	});

	it("「用 AI 填」與營養標示的卡片同時開著：兩個說明欄各是各的", async () => {
		mockLabel(() => json(LABEL));
		render(wrap(<NewFood />));
		const photo = new File(["p"], "dish.jpg", { type: "image/jpeg" });

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		await userEvent.upload(screen.getByLabelText("拍營養標示"), JPEG());

		const [estimateStep, labelStep] = screen.getAllByRole("region", {
			name: "確認照片",
		});
		if (estimateStep === undefined || labelStep === undefined) {
			throw new Error("兩張確認照片的卡片都要在");
		}
		expect(
			within(estimateStep).getByRole("button", { name: "開始估算" }),
		).toBeInTheDocument();
		expect(
			within(labelStep).getByRole("button", { name: "開始讀取" }),
		).toBeInTheDocument();
		await userEvent.type(
			within(estimateStep).getByLabelText("補充說明（選填）"),
			"飯半碗",
		);
		await userEvent.type(
			within(labelStep).getByLabelText("補充說明（選填）"),
			"一包 2 份",
		);

		expect(within(estimateStep).getByLabelText("補充說明（選填）")).toHaveValue(
			"飯半碗",
		);
		expect(within(labelStep).getByLabelText("補充說明（選填）")).toHaveValue(
			"一包 2 份",
		);
	});
});
