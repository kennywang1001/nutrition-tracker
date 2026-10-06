import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { queryClient } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { PHOTO_UPLOAD_FAILED_NOTICE } from "../src/screens/LogMeal";

// 上傳會呼叫 shrinkToLongestEdge（用 canvas，jsdom 沒有）。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

const ME = {
	id: 1,
	email: "kenny@example.com",
	display_name: "Kenny",
	role: "user",
	timezone: "Asia/Taipei",
};
const STATS = {
	date: "2026-10-02",
	actual: { kcal: "0.00", protein_g: "0.00", fat_g: "0.00", carb_g: "0.00" },
	target: null,
	ratio: null,
};
const EMPTY_SUMMARY = { month: "2026-10", total: "0.00", by_category: [] };

function jsonResponse(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

/** App 一掛上去會打好幾個端點（總覽、tab bar 切過去的畫面、我的）。
 *
 *  用子字串依序比對，**更具體的路徑排前面**（`/api/expenses/summary`
 *  在 `/api/expenses` 之前、`/api/meals` 在 `/api/me` 之前）。
 *
 *  **每個端點都回正確的形狀**：舊版「所有請求都回 `[]`」會讓總覽拿到
 *  `[]` 當月報表，`formatMoney(undefined)` 直接把 render 炸掉。 */
function mockBackend(
	extra: (url: string, method: string) => Response | undefined = () =>
		undefined,
) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = String(input);
			const method = (init?.method ?? "GET").toUpperCase();
			if (method === "POST" && url.includes("/api/auth/logout")) {
				return new Response(null, { status: 204 });
			}
			// 個別測試的客製回應排在最前面（例如 `/api/meals/99/photo` 必須在
			// `/api/meals` 之前）。
			const custom = extra(url, method);
			if (custom !== undefined) return custom;
			// **`/api/meals` 必須在 `/api/me` 之前**："/api/meals".includes("/api/me")
			// 為真——順序反過來，總覽的餐點清單會拿到使用者物件然後當掉。
			if (url.includes("/api/meals")) return jsonResponse([]);
			if (url.includes("/api/me")) return jsonResponse(ME);
			if (url.includes("/api/stats/daily")) return jsonResponse(STATS);
			if (url.includes("/api/expenses/summary"))
				return jsonResponse(EMPTY_SUMMARY);
			if (url.includes("/api/expenses")) return jsonResponse([]);
			if (url.includes("/api/supplements/today")) return jsonResponse([]);
			throw new Error(`app.test 沒有為這個請求準備回應：${method} ${url}`);
		});
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	// queryClient 是模組層單例，同一個檔案的多個 it() 之間會留存。
	queryClient.clear();
	// App 用 BrowserRouter，路徑來自 jsdom 的 window.location——每一條
	// 測試都從根路徑開始，轉址測試再自己換。
	window.history.replaceState(null, "", "/");
});

describe("App", () => {
	it("沒有 token 時顯示登入畫面", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
	});

	it("有 token 時首頁是總覽", async () => {
		// 介面改版：`/` 從「記一餐」換成「總覽」，記一餐要從「＋」進去
		// （規格 §3.3：這是使用者選了「＋ 先選」的直接代價，不是迴歸）。
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
	});

	it("舊網址 /today 轉到飲食", async () => {
		// 手機上可能有書籤或 PWA 的舊狀態（規格 §3.3）。
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		window.history.replaceState(null, "", "/today");

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "飲食" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/diet");
	});

	it("舊網址 /expenses 轉到報表", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		window.history.replaceState(null, "", "/expenses");

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "報表" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/reports");
	});

	it("從「我的」登出之後回到登入畫面", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		render(<App />);

		await userEvent.click(await screen.findByRole("link", { name: "我的" }));
		await userEvent.click(await screen.findByRole("button", { name: "登出" }));

		expect(
			await screen.findByRole("heading", { name: "登入" }),
		).toBeInTheDocument();
	});

	it("記一餐存好、照片沒傳上去：回到總覽並顯示通知", async () => {
		// LogMealRoute 的接線只有 App 層看得到：onSaved 的結果 → navigate 的 state
		// → 總覽的 role="status"。
		setTokens({ access_token: "a", refresh_token: "r" });
		const food = {
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
		mockBackend((url, method) => {
			if (url.includes("/api/foods/frequent")) return jsonResponse([food]);
			if (url.includes("/api/foods/recent")) return jsonResponse([]);
			if (url.includes("/api/foods/1/portions")) return jsonResponse([]);
			if (method === "POST" && url.includes("/api/meals/99/photo")) {
				return new Response(
					JSON.stringify({
						error: { code: "INTERNAL_ERROR", message: "壞了", details: {} },
					}),
					{ status: 500, headers: { "content-type": "application/json" } },
				);
			}
			if (method === "POST" && url.includes("/api/meals")) {
				return new Response(JSON.stringify({ id: 99 }), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			}
			return undefined;
		});
		window.history.replaceState(null, "", "/meals/new");

		render(<App />);
		await userEvent.click(await screen.findByText("滷肉飯"));
		await userEvent.upload(
			screen.getByLabelText("照片（選填）"),
			new File(["fake-jpeg"], "lunch.jpg", { type: "image/jpeg" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "記錄" }));

		expect(await screen.findByRole("heading", { name: "總覽" })).toBeVisible();
		await waitFor(() =>
			expect(screen.getByRole("status")).toHaveTextContent(
				PHOTO_UPLOAD_FAILED_NOTICE,
			),
		);
		expect(window.location.pathname).toBe("/");
	});
});

describe("App 的 /join（邀請規格 §4.1）", () => {
	it("沒登入時打開 /join 顯示建立帳號，不是登入", async () => {
		window.history.replaceState(null, "", "/join#tok-1");
		mockBackend((url) =>
			url.includes("/api/auth/invite-status")
				? jsonResponse({ valid: true })
				: undefined,
		);

		render(<App />);

		expect(await screen.findByLabelText("再輸入一次密碼")).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
	});

	it("沒登入時打開 /join/（多一個斜線）也是建立帳號", async () => {
		window.history.replaceState(null, "", "/join/#tok-1");
		mockBackend((url) =>
			url.includes("/api/auth/invite-status")
				? jsonResponse({ valid: true })
				: undefined,
		);

		render(<App />);

		expect(await screen.findByLabelText("再輸入一次密碼")).toBeInTheDocument();
	});

	it("用邀請建立帳號之後直接進總覽，網址換成 /", async () => {
		window.history.replaceState(null, "", "/join#tok-1");
		mockBackend((url, method) => {
			if (url.includes("/api/auth/invite-status"))
				return jsonResponse({ valid: true });
			if (method === "POST" && url.includes("/api/auth/register"))
				return new Response(JSON.stringify(ME), {
					status: 201,
					headers: { "content-type": "application/json" },
				});
			if (method === "POST" && url.includes("/api/auth/login"))
				return jsonResponse({
					access_token: "a",
					refresh_token: "r",
					token_type: "bearer",
				});
			return undefined;
		});

		render(<App />);
		await userEvent.type(
			await screen.findByLabelText("Email"),
			"friend@example.com",
		);
		await userEvent.type(screen.getByLabelText("名字"), "小明");
		await userEvent.type(screen.getByLabelText("密碼"), "a-good-password");
		await userEvent.type(
			screen.getByLabelText("再輸入一次密碼"),
			"a-good-password",
		);
		await userEvent.click(screen.getByRole("button", { name: "建立帳號" }));

		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/");
		expect(window.location.hash).toBe("");
	});

	it("已登入打開 /join：說明文字，不打任何邀請端點，邀請碼從網址列拿掉", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		const spy = mockBackend();
		window.history.replaceState(null, "", "/join#tok-1");

		render(<App />);

		expect(
			await screen.findByText("你已經登入了。這個連結是給新朋友開帳號用的。"),
		).toBeInTheDocument();
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/auth/")),
		).toBe(false);
		// 邀請還能用：留在網址列（歷史紀錄、螢幕截圖）就是一條能開帳號的連結。
		expect(window.location.pathname).toBe("/join");
		expect(window.location.hash).toBe("");
	});
});
