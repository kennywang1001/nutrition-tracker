import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter, Route, Routes, useParams } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { NewFood } from "../src/screens/NewFood";
import { json, mockApi } from "./helpers/mock-api";

/** `/foods/:id`（Task 5）不存在，所以這裡放一個假的目的地路由——不是
 *  佔位畫面（那是 `App.tsx` 的事，這裡刻意不放），只是讓測試能用**真的**
 *  react-router 比對，確認「導航發生了，而且導到正確的 id」，不是靠
 *  mock `useNavigate` 斷言「有被呼叫」那種只驗證呼叫、不驗證實際路由
 *  比對結果的寫法。 */
function FakeFoodDetail() {
	const { id } = useParams();
	return <p>food-detail:{id}</p>;
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/foods/new"]}>
				<Routes>
					<Route path="/foods/new" element={children} />
					<Route path="/foods/:id" element={<FakeFoodDetail />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

/** 填完表單需要的欄位（除了 name / brand，那兩個各條測試自己填）。 */
async function fillNutrition(overrides: Partial<Record<string, string>> = {}) {
	const values: Record<string, string> = {
		"熱量（每 100 單位 kcal）": "165",
		"蛋白質（g）": "31",
		"脂肪（g）": "3.6",
		"碳水化合物（g）": "0",
		...overrides,
	};
	for (const [label, value] of Object.entries(values)) {
		await userEvent.type(screen.getByLabelText(label), value);
	}
}

describe("新增食物 /foods/new", () => {
	it("送出時 body 的形狀正確，而且四個數值是字串不是 number", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/foods",
				handler: () =>
					json(
						{
							id: 42,
							name: "雞胸肉",
							brand: "全聯",
							is_global: false,
							nutrition: {
								base_unit: "g",
								kcal: "165.00",
								protein_g: "31.00",
								fat_g: "3.60",
								carb_g: "0.00",
							},
						},
						201,
					),
			},
		]);

		render(wrap(<NewFood />));
		await userEvent.type(screen.getByLabelText("名稱"), "雞胸肉");
		await userEvent.type(screen.getByLabelText("品牌（選填）"), "全聯");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		const call = await vi.waitFor(() => {
			const found = fetchMock.mock.calls.find(
				([input, init]) =>
					String(input).includes("/api/foods") && init?.method === "POST",
			);
			expect(found).toBeDefined();
			return found;
		});
		const body = JSON.parse(String(call?.[1]?.body));

		expect(body).toEqual({
			name: "雞胸肉",
			brand: "全聯",
			nutrition: {
				base_unit: "g",
				kcal: "165",
				protein_g: "31",
				fat_g: "3.6",
				carb_g: "0",
			},
		});
		expect(typeof body.nutrition.kcal).toBe("string");
		expect(typeof body.nutrition.protein_g).toBe("string");
		expect(typeof body.nutrition.fat_g).toBe("string");
		expect(typeof body.nutrition.carb_g).toBe("string");
	});

	it("brand 留空時送的是 null，不是空字串", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/foods",
				handler: () =>
					json(
						{
							id: 43,
							name: "白飯",
							brand: null,
							is_global: false,
							nutrition: {
								base_unit: "g",
								kcal: "130.00",
								protein_g: "2.70",
								fat_g: "0.30",
								carb_g: "28.00",
							},
						},
						201,
					),
			},
		]);

		render(wrap(<NewFood />));
		await userEvent.type(screen.getByLabelText("名稱"), "白飯");
		// 品牌刻意不填。
		await fillNutrition({
			"熱量（每 100 單位 kcal）": "130",
			"蛋白質（g）": "2.7",
			"脂肪（g）": "0.3",
			"碳水化合物（g）": "28",
		});
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		const call = await vi.waitFor(() => {
			const found = fetchMock.mock.calls.find(
				([input, init]) =>
					String(input).includes("/api/foods") && init?.method === "POST",
			);
			expect(found).toBeDefined();
			return found;
		});
		const body = JSON.parse(String(call?.[1]?.body));

		expect(body.brand).toBeNull();
	});

	it("409 FOOD_EXISTS 顯示「你已經建過同名的食物了」，不是通用錯誤", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/foods",
				handler: () =>
					json(
						{
							error: {
								code: "FOOD_EXISTS",
								message: "你已經建過同名的食物了",
								details: {},
							},
						},
						409,
					),
			},
		]);

		render(wrap(<NewFood />));
		await userEvent.type(screen.getByLabelText("名稱"), "雞胸肉");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(
			await screen.findByText("你已經建過同名的食物了"),
		).toBeInTheDocument();
		// 不是被通用文案蓋過去。
		expect(screen.queryByText("建立失敗，請再試一次")).not.toBeInTheDocument();
	});

	it("422 的欄位錯誤顯示得出來", async () => {
		// 前端只對齊 kcal 的上下限（0–10000），不重做 decimal_places 檢查——
		// "12.345" 通過前端驗證（在範圍內），但後端的 max_digits=8,
		// decimal_places=2 會擋下來。這正是規格說的「前端驗證是為了少一個
		// 往返，不是為了取代它」：這條測試要驗的就是取代不了的那一段。
		mockApi([
			{
				method: "POST",
				path: "/api/foods",
				handler: () =>
					json(
						{
							error: {
								code: "VALIDATION_ERROR",
								message: "輸入資料格式錯誤",
								details: {
									errors: [
										{
											loc: ["body", "nutrition", "kcal"],
											msg: "小數點最多兩位",
											type: "decimal_max_places",
										},
									],
								},
							},
						},
						422,
					),
			},
		]);

		render(wrap(<NewFood />));
		await userEvent.type(screen.getByLabelText("名稱"), "雞胸肉");
		await fillNutrition({ "熱量（每 100 單位 kcal）": "12.345" });
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		expect(
			await screen.findByText("nutrition.kcal：小數點最多兩位"),
		).toBeInTheDocument();
	});

	it("成功之後導到新食物的詳情頁", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/foods",
				handler: () =>
					json(
						{
							id: 99,
							name: "雞胸肉",
							brand: null,
							is_global: false,
							nutrition: {
								base_unit: "g",
								kcal: "165.00",
								protein_g: "31.00",
								fat_g: "3.60",
								carb_g: "0.00",
							},
						},
						201,
					),
			},
		]);

		render(wrap(<NewFood />));
		await userEvent.type(screen.getByLabelText("名稱"), "雞胸肉");
		await fillNutrition();
		await userEvent.click(screen.getByRole("button", { name: "建立食物" }));

		// 真的走 react-router 的路由比對——不是斷言一個被 mock 掉的
		// useNavigate「有被呼叫」，而是確認 URL 真的變成 /foods/99，
		// 而且 <Route path="/foods/:id"> 真的比對到、把 id 解析出來。
		expect(await screen.findByText("food-detail:99")).toBeInTheDocument();
	});
});
