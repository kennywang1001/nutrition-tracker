import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { FoodPicker } from "../src/components/FoodPicker";
import { makeFood } from "./helpers/foods";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const RICE = {
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
};
const NO_NUTRITION = {
	id: 2,
	name: "沒有營養素的食物",
	brand: null,
	is_global: true,
	nutrition: null,
};
const SEARCHED = { ...RICE, id: 3, name: "白飯" };

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("FoodPicker", () => {
	it("點常吃的食物，把那個食物交給 onSelect", async () => {
		mockApi({
			"/api/foods/frequent": () => json([RICE, NO_NUTRITION]),
			"/api/foods/recent": () => json([RICE]),
		});
		const onSelect = vi.fn();
		render(wrap(<FoodPicker onSelect={onSelect} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "滷肉飯" }),
		);

		expect(onSelect).toHaveBeenCalledWith(RICE);
	});

	it("常吃與最近吃重複的食物只出現一次", async () => {
		mockApi({
			"/api/foods/frequent": () => json([RICE]),
			"/api/foods/recent": () => json([RICE]),
		});
		render(wrap(<FoodPicker onSelect={vi.fn()} />));

		await screen.findByRole("button", { name: "滷肉飯" });
		expect(screen.getAllByRole("button", { name: "滷肉飯" })).toHaveLength(1);
	});

	it("沒有生效營養素的食物不能選，旁邊寫原因", async () => {
		mockApi({
			"/api/foods/frequent": () => json([NO_NUTRITION]),
			"/api/foods/recent": () => json([]),
		});
		render(wrap(<FoodPicker onSelect={vi.fn()} />));

		expect(
			await screen.findByRole("button", { name: "沒有營養素的食物" }),
		).toBeDisabled();
		expect(
			screen.getByText("這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
	});

	it("搜尋到的食物也能選", async () => {
		mockApi({
			"/api/foods/frequent": () => json([]),
			"/api/foods/recent": () => json([]),
			"/api/foods?q=": () => json([SEARCHED]),
		});
		const onSelect = vi.fn();
		render(wrap(<FoodPicker onSelect={onSelect} />));

		await userEvent.type(screen.getByLabelText("搜尋食物"), "白飯");
		await userEvent.click(await screen.findByRole("button", { name: "白飯" }));

		expect(onSelect).toHaveBeenCalledWith(SEARCHED);
	});
});

describe("FoodPicker：掃條碼（掃條碼規格 D18、D19）", () => {
	beforeEach(() => {
		HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
	});

	async function scanManually(code: string) {
		await userEvent.click(screen.getByRole("button", { name: "掃條碼" }));
		const dialog = screen.getByRole("dialog", { name: "掃條碼" });
		await userEvent.click(
			within(dialog).getByRole("button", { name: "手動輸入條碼" }),
		);
		await userEvent.type(within(dialog).getByLabelText("條碼"), code);
		await userEvent.click(within(dialog).getByRole("button", { name: "查詢" }));
	}

	it("掃到：跟從清單選一樣，交給 onSelect", async () => {
		const food = makeFood({ id: 7, name: "洋芋片", barcode: "4710088432094" });
		// `/api/foods/by-barcode/…` 不包含下面兩個路徑；照樣排在前面（具體的在前）。
		mockApi({
			"/api/foods/by-barcode/": () =>
				json({ code: "4710088432094", food, prefill: null }),
			"/api/foods/frequent": () => json([]),
			"/api/foods/recent": () => json([]),
		});
		const onSelect = vi.fn();
		render(wrap(<FoodPicker onSelect={onSelect} />));

		await scanManually("4710088432094");

		await waitFor(() => expect(onSelect).toHaveBeenCalledWith(food));
	});

	it("掃到沒有生效版本的食物：說明、不交出（記不了）", async () => {
		mockApi({
			"/api/foods/by-barcode/": () =>
				json({
					code: "4710088432094",
					food: makeFood({ id: 7, name: "洋芋片", nutrition: null }),
					prefill: null,
				}),
			"/api/foods/frequent": () => json([]),
			"/api/foods/recent": () => json([]),
		});
		const onSelect = vi.fn();
		render(wrap(<FoodPicker onSelect={onSelect} />));

		await scanManually("4710088432094");

		expect(
			await screen.findByText("洋芋片：這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
		expect(onSelect).not.toHaveBeenCalled();
	});

	it("沒命中的「用這個條碼建立食物」交給 onCreateFromBarcode", async () => {
		mockApi({
			"/api/foods/by-barcode/": () =>
				json({ code: "4710088432094", food: null, prefill: null }),
			"/api/foods/frequent": () => json([]),
			"/api/foods/recent": () => json([]),
		});
		const onCreateFromBarcode = vi.fn();
		render(
			wrap(
				<FoodPicker
					onSelect={vi.fn()}
					onCreateFromBarcode={onCreateFromBarcode}
				/>,
			),
		);

		await scanManually("4710088432094");
		await userEvent.click(
			await screen.findByRole("button", { name: "用這個條碼建立食物" }),
		);

		expect(onCreateFromBarcode).toHaveBeenCalledWith("4710088432094", null);
	});
});
