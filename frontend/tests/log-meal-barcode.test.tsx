import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BarcodePrefill } from "../src/api/barcode";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogMeal } from "../src/screens/LogMeal";
import { makeFood } from "./helpers/foods";
import { json, mockApi } from "./helpers/mock-api";

const CODE = "4710088432094";
const PREFILL: BarcodePrefill = {
	name: "可口可樂",
	brand: null,
	base_unit: "ml",
	per100: { kcal: "42.00", protein_g: "0.00", fat_g: "0.00", carb_g: "10.60" },
	serving: null,
	source: "openfoodfacts",
};

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** `/api/foods/by-barcode/…` 與 `/api/foods/9/portions` 都包含 `/api/foods`——具體的排前面。 */
function routes() {
	return mockApi([
		{
			method: "GET",
			path: "/api/foods/by-barcode/",
			handler: () => json({ code: CODE, food: null, prefill: PREFILL }),
		},
		{ path: "/api/foods/9/portions", handler: () => json([]) },
		{ path: "/api/foods/frequent", handler: () => json([]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
	]);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
	HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
});

describe("記一餐與掃條碼（掃條碼規格 D19–D21）", () => {
	it("initialFood（新增食物存好交回來的）：一開始就選好、焦點在「已選擇」那一行", async () => {
		routes();
		render(
			wrap(
				<LogMeal
					onSaved={vi.fn()}
					initialFood={makeFood({ id: 9, name: "洋芋片" })}
				/>,
			),
		);

		const selected = await screen.findByText("已選擇：洋芋片");
		await waitFor(() => expect(selected).toHaveFocus());
	});

	it("initialFood 的份量還在載入時按「記錄」什麼都不送；載入好選上預設份量再送（審查 I2）", async () => {
		// 掃條碼回來的路徑最容易撞到：LogMeal 帶著 initialFood 掛載、份量清單是冷的、焦點就在
		// 「已選擇」旁邊。以前這時按「記錄」送的是 quantity 1、沒有 portion_id＝1 g。
		let releasePortions: (response: Response) => void = () => {};
		const portionsPending = new Promise<Response>((resolve) => {
			releasePortions = resolve;
		});
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/meals",
				handler: () => json({ id: 1 }, 201),
			},
			{ path: "/api/foods/9/portions", handler: () => portionsPending },
			{ path: "/api/foods/frequent", handler: () => json([]) },
			{ path: "/api/foods/recent", handler: () => json([]) },
		]);
		const onSaved = vi.fn();
		render(
			wrap(
				<LogMeal
					onSaved={onSaved}
					initialFood={makeFood({ id: 9, name: "洋芋片" })}
				/>,
			),
		);
		const posts = () =>
			fetchMock.mock.calls.filter(([, init]) => init?.method === "POST");

		const submit = await screen.findByRole("button", { name: "記錄" });
		expect(submit).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByText("載入份量中…")).toHaveAttribute("role", "status");
		await userEvent.click(submit);
		expect(posts()).toHaveLength(0);

		releasePortions(
			json([
				{
					id: 4,
					label: "一包",
					grams: "35.00",
					is_default: true,
					is_global: false,
				},
			]),
		);
		await screen.findByRole("option", { name: "一包" });
		expect(submit).toHaveAttribute("aria-disabled", "false");
		expect(screen.queryByText("載入份量中…")).toBeNull();
		await userEvent.click(submit);

		await waitFor(() => expect(onSaved).toHaveBeenCalled());
		expect(posts()).toHaveLength(1);
		const body = JSON.parse(String(posts()[0]?.[1]?.body));
		expect(body.items).toEqual([{ food_id: 9, quantity: "1", portion_id: 4 }]);
	});

	it("掃條碼的入口在搜尋框下面", async () => {
		routes();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		expect(screen.getByRole("button", { name: "掃條碼" })).toBeInTheDocument();
		expect(
			screen.getByText("查不到時，條碼可能會送到 Open Food Facts 查詢"),
		).toBeInTheDocument();
	});

	it("沒命中 →「用這個條碼建立食物」：交給 onCreateFromBarcode（條碼、預填）", async () => {
		routes();
		const onCreateFromBarcode = vi.fn();
		render(
			wrap(
				<LogMeal onSaved={vi.fn()} onCreateFromBarcode={onCreateFromBarcode} />,
			),
		);

		await userEvent.click(screen.getByRole("button", { name: "掃條碼" }));
		const dialog = screen.getByRole("dialog", { name: "掃條碼" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "手動輸入條碼" }),
		);
		await userEvent.type(within(dialog).getByLabelText("條碼"), CODE);
		await userEvent.click(within(dialog).getByRole("button", { name: "查詢" }));
		const card = await screen.findByRole("region", { name: "找不到這個條碼" });
		await userEvent.click(
			within(card).getByRole("button", { name: "用這個條碼建立食物" }),
		);

		expect(onCreateFromBarcode).toHaveBeenCalledWith(CODE, PREFILL);
	});
});
