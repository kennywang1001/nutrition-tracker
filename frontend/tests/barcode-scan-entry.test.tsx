import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { BarcodeLookup, BarcodePrefill } from "../src/api/barcode";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { BarcodeScanEntry } from "../src/components/BarcodeScanEntry";
import { makeFood } from "./helpers/foods";
import { json, mockApi } from "./helpers/mock-api";

// 真的 BarcodeScanner：jsdom 沒有 navigator.mediaDevices →「找不到可以用的相機」，走手動輸入。
// 偵測器是 setup 換掉的 ponyfill（永遠讀不到），這裡不用它。

const CODE = "4710088432094";

const PREFILL: BarcodePrefill = {
	name: "可口可樂",
	brand: "Coca-Cola",
	base_unit: "ml",
	per100: { kcal: "42.00", protein_g: "0.00", fat_g: "0.00", carb_g: "10.60" },
	serving: { amount: "330.00", unit: "ml" },
	source: "openfoodfacts",
};

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function lookupReturns(body: BarcodeLookup | (() => Response)) {
	return mockApi([
		{
			method: "GET",
			path: "/api/foods/by-barcode/",
			handler: typeof body === "function" ? body : () => json(body),
		},
	]);
}

/** 打開掃描層、手動輸入、查詢。 */
async function scanManually(code = CODE) {
	await userEvent.click(screen.getByRole("button", { name: "掃條碼" }));
	const dialog = screen.getByRole("dialog", { name: "掃條碼" });
	await userEvent.click(
		within(dialog).getByRole("button", { name: "手動輸入條碼" }),
	);
	await userEvent.type(within(dialog).getByLabelText("條碼"), code);
	await userEvent.click(within(dialog).getByRole("button", { name: "查詢" }));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
	HTMLMediaElement.prototype.play = vi.fn(async () => undefined);
});

describe("BarcodeScanEntry", () => {
	it("入口旁邊有隱私的提醒（掃條碼規格 D18）", () => {
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} />));

		expect(
			screen.getByText("查不到時，條碼可能會送到 Open Food Facts 查詢"),
		).toBeInTheDocument();
	});

	it("命中：交出那個食物、掃描層關掉；打的是 by-barcode 那一支", async () => {
		const food = makeFood({ id: 7, barcode: CODE });
		const fetchMock = lookupReturns({ code: CODE, food, prefill: null });
		const onFood = vi.fn();
		render(wrap(<BarcodeScanEntry onFood={onFood} requireNutrition />));

		await scanManually();

		await waitFor(() => expect(onFood).toHaveBeenCalledWith(food));
		expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
			`/api/foods/by-barcode/${CODE}`,
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});

	it("命中但沒有生效版本＋requireNutrition：說明、不交出", async () => {
		lookupReturns({
			code: CODE,
			food: makeFood({ id: 7, name: "洋芋片", nutrition: null }),
			prefill: null,
		});
		const onFood = vi.fn();
		render(wrap(<BarcodeScanEntry onFood={onFood} requireNutrition />));

		await scanManually();

		expect(
			await screen.findByText("洋芋片：這個食物還沒有生效的營養素資料"),
		).toBeInTheDocument();
		expect(onFood).not.toHaveBeenCalled();
	});

	it("命中、沒有生效版本、沒有 requireNutrition（食物庫）：照樣交出（詳情頁看得到）", async () => {
		const food = makeFood({ id: 7, nutrition: null });
		lookupReturns({ code: CODE, food, prefill: null });
		const onFood = vi.fn();
		render(wrap(<BarcodeScanEntry onFood={onFood} />));

		await scanManually();

		await waitFor(() => expect(onFood).toHaveBeenCalledWith(food));
	});

	it("沒命中＋預填：找不到、OFF 有什麼、出處、用這個條碼建立食物", async () => {
		lookupReturns({ code: CODE, food: null, prefill: PREFILL });
		const onCreate = vi.fn();
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} onCreate={onCreate} />));

		await scanManually();

		const card = await screen.findByRole("region", { name: "找不到這個條碼" });
		expect(card).toHaveTextContent(`找不到這個條碼（${CODE}）`);
		expect(
			within(card).getByText("Open Food Facts 有這個商品：可口可樂"),
		).toBeInTheDocument();
		const link = within(card).getByRole("link", { name: "Open Food Facts" });
		expect(link).toHaveAttribute("href", "https://world.openfoodfacts.org");
		expect(card).toHaveTextContent("資料來源：Open Food Facts（ODbL）");

		await userEvent.click(
			within(card).getByRole("button", { name: "用這個條碼建立食物" }),
		);
		expect(onCreate).toHaveBeenCalledWith(CODE, PREFILL);
	});

	it("沒命中、預填沒有名稱：「（沒有名稱）」", async () => {
		lookupReturns({
			code: CODE,
			food: null,
			prefill: { ...PREFILL, name: null },
		});
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} onCreate={vi.fn()} />));

		await scanManually();

		expect(
			await screen.findByText("Open Food Facts 有這個商品：（沒有名稱）"),
		).toBeInTheDocument();
	});

	it("用後端回的標準形式（12 位的 UPC-A 掃進來，後端補成 13 位）", async () => {
		lookupReturns({ code: "0036000291452", food: null, prefill: null });
		const onCreate = vi.fn();
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} onCreate={onCreate} />));

		await scanManually("036000291452");

		const card = await screen.findByRole("region", { name: "找不到這個條碼" });
		expect(card).toHaveTextContent("找不到這個條碼（0036000291452）");
		await userEvent.click(
			within(card).getByRole("button", { name: "用這個條碼建立食物" }),
		);
		expect(onCreate).toHaveBeenCalledWith("0036000291452", null);
	});

	it("沒命中、沒預填：沒有 Open Food Facts 那兩行", async () => {
		lookupReturns({ code: CODE, food: null, prefill: null });
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} onCreate={vi.fn()} />));

		await scanManually();

		const card = await screen.findByRole("region", { name: "找不到這個條碼" });
		expect(card).toHaveTextContent(`找不到這個條碼（${CODE}）`);
		expect(card).not.toHaveTextContent("Open Food Facts");
		expect(
			within(card).getByRole("button", { name: "用這個條碼建立食物" }),
		).toBeInTheDocument();
	});

	it("沒給 onCreate：只說找不到、沒有按鈕", async () => {
		lookupReturns({ code: CODE, food: null, prefill: PREFILL });
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} />));

		await scanManually();

		const card = await screen.findByRole("region", { name: "找不到這個條碼" });
		expect(
			within(card).queryByRole("button", { name: "用這個條碼建立食物" }),
		).not.toBeInTheDocument();
	});

	it("422：後端的那一句（不是「barcode：Value error, …」）", async () => {
		lookupReturns(() =>
			json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: "輸入格式不對",
						details: {
							errors: [
								{
									loc: ["path", "code"],
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
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} />));

		await scanManually("4710088432096");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"條碼的檢查碼不對，請再確認一次",
		);
	});

	it("429：後端的訊息", async () => {
		lookupReturns(() =>
			json(
				{
					error: {
						code: "TOO_MANY_BARCODE_LOOKUPS",
						message: "查詢條碼太頻繁，請一分鐘後再試",
						details: {},
					},
				},
				429,
			),
		);
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} />));

		await scanManually();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"查詢條碼太頻繁，請一分鐘後再試",
		);
	});

	it("查詢中：狀態一行；「掃條碼」暫停（aria-disabled，焦點還在它身上）", async () => {
		let release: (response: Response) => void = () => {};
		lookupReturns(
			() =>
				new Promise<Response>((done) => {
					release = done;
				}) as unknown as Response,
		);
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} />));

		await scanManually();

		expect(await screen.findByText("查詢中…")).toBeInTheDocument();
		const scan = screen.getByRole("button", { name: "掃條碼" });
		expect(scan).toHaveAttribute("aria-disabled", "true");
		await userEvent.click(scan);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		release(json({ code: CODE, food: null, prefill: null }));
		expect(
			await screen.findByRole("region", { name: "找不到這個條碼" }),
		).toBeInTheDocument();
		expect(scan).toHaveAttribute("aria-disabled", "false");
	});

	it("取消：掃描層關掉、焦點回到「掃條碼」", async () => {
		mockApi([]);
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} />));

		await userEvent.click(screen.getByRole("button", { name: "掃條碼" }));
		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "掃條碼" })).toHaveFocus();
	});

	it("查完（掃描層關掉）：焦點回到「掃條碼」", async () => {
		lookupReturns({ code: CODE, food: null, prefill: null });
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} onCreate={vi.fn()} />));

		await scanManually();

		await screen.findByRole("region", { name: "找不到這個條碼" });
		expect(screen.getByRole("button", { name: "掃條碼" })).toHaveFocus();
	});

	it("再掃一次：上一次的卡片收掉", async () => {
		lookupReturns({ code: CODE, food: null, prefill: null });
		render(wrap(<BarcodeScanEntry onFood={vi.fn()} onCreate={vi.fn()} />));
		await scanManually();
		await screen.findByRole("region", { name: "找不到這個條碼" });

		await userEvent.click(screen.getByRole("button", { name: "掃條碼" }));

		expect(
			screen.queryByRole("region", { name: "找不到這個條碼" }),
		).not.toBeInTheDocument();
	});
});
