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

const ESTIMATE = {
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

// AI 存出來的食物帶一個自己的預設份量「一份」（AI 估算前端規格 §4.1）。
const ONE_SERVING = {
	id: 300,
	label: "一份",
	grams: "550.00",
	is_default: true,
	is_global: false,
};

/** 路徑順序：mockApi 依序用 url.includes 比對——具體的排前面。 */
function mockLogMeal() {
	return mockApi([
		{ path: "/api/foods/frequent", handler: () => json([]) },
		{ path: "/api/foods/recent", handler: () => json([]) },
		{ path: "/api/foods/30/portions", handler: () => json([ONE_SERVING]) },
		{ method: "GET", path: "/api/foods?q=", handler: () => json([]) },
		{ method: "POST", path: "/api/ai/analyze", handler: () => json(ESTIMATE) },
		{ method: "POST", path: "/api/foods", handler: () => json(CREATED, 201) },
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

function mealBody(fetchMock: ReturnType<typeof mockApi>): unknown {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).endsWith("/api/meals"),
	);
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function uploadedPhotoName(
	fetchMock: ReturnType<typeof mockApi>,
): string | null {
	const call = fetchMock.mock.calls.find(([input]) =>
		String(input).includes("/api/meals/99/photo"),
	);
	if (call === undefined) return null;
	const body = call[1]?.body;
	if (!(body instanceof FormData)) return null;
	const file = body.get("file");
	return file instanceof File ? file.name : null;
}

/** 等到卡片消失才算完成：卡片消失＝面板已經把食物（與照片）交回給記一餐。
 *  只等「已選擇：牛肉麵」不夠——第二次估算時那行字早就在畫面上了，
 *  會在交回之前就往下走（handover §6 第 41 種）。 */
async function confirmEstimate() {
	const card = await screen.findByRole("region", { name: "AI 估算結果" });
	await userEvent.click(within(card).getByRole("button", { name: "確認" }));
	await waitFor(() =>
		expect(
			screen.queryByRole("region", { name: "AI 估算結果" }),
		).not.toBeInTheDocument(),
	);
	expect(screen.getByText("已選擇：牛肉麵")).toBeInTheDocument();
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記一餐：AI 估算", () => {
	it("搜尋框有字就能用 AI 估算；確認後選上那個食物，份量是「一份 × 1」", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));

		await userEvent.type(screen.getByLabelText("搜尋食物"), "牛肉麵");
		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「牛肉麵」" }),
		);
		await confirmEstimate();

		await waitFor(() =>
			expect(screen.getByLabelText("份量選項")).toHaveValue("300"),
		);
		expect(screen.getByLabelText("份量")).toHaveValue("1");
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(mealBody(fetchMock)).toMatchObject({
				items: [{ food_id: 30, quantity: "1", portion_id: 300 }],
			}),
		);
	});

	it("拍照估算：那張照片自動當這一餐的照片", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const photo = new File(["fake-jpeg"], "noodle.jpg", {
			type: "image/jpeg",
		});

		await userEvent.upload(screen.getByLabelText("拍照估算"), photo);
		await confirmEstimate();
		// 預覽是 effect 裡建的 object URL——等它出現。
		expect(await screen.findByAltText("選好的照片")).toBeInTheDocument();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(uploadedPhotoName(fetchMock)).toBe("noodle.jpg"),
		);
	});

	it("已經選了別張照片：拍照估算的照片不覆蓋它", async () => {
		const fetchMock = mockLogMeal();
		render(wrap(<LogMeal onSaved={vi.fn()} />));
		const chosen = new File(["a"], "chosen.jpg", { type: "image/jpeg" });
		const forEstimate = new File(["b"], "noodle.jpg", { type: "image/jpeg" });

		// 「照片（選填）」在選了食物之後的表單裡：先用文字估算選上食物、
		// 選一張照片，再用另一張照片估算一次。
		await userEvent.type(screen.getByLabelText("搜尋食物"), "牛肉麵");
		await userEvent.click(
			screen.getByRole("button", { name: "用 AI 估算「牛肉麵」" }),
		);
		await confirmEstimate();
		await userEvent.upload(screen.getByLabelText("照片（選填）"), chosen);
		await userEvent.upload(screen.getByLabelText("拍照估算"), forEstimate);
		await confirmEstimate();
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		await waitFor(() =>
			expect(uploadedPhotoName(fetchMock)).toBe("chosen.jpg"),
		);
	});
});
