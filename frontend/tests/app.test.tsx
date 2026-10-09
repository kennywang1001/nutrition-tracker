import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { OFFLINE_CACHE_STORAGE_KEY } from "../src/api/persist";
import { queryClient, queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import {
	clearTokens,
	getAccessToken,
	getRefreshToken,
	setTokens,
} from "../src/auth/store";
import { PHOTO_UPLOAD_FAILED_NOTICE } from "../src/screens/LogMeal";
import { setDesktop } from "../src/test/media";

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
	extra: (
		url: string,
		method: string,
		body: unknown,
	) => Response | Promise<Response> | undefined = () => undefined,
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
			const custom = extra(
				url,
				method,
				typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
			);
			if (custom !== undefined) return custom;
			// **`/api/meals` 必須在 `/api/me` 之前**："/api/meals".includes("/api/me")
			// 為真——順序反過來，總覽的餐點清單會拿到使用者物件然後當掉。
			if (url.includes("/api/meals")) return jsonResponse([]);
			if (url.includes("/api/me")) return jsonResponse(ME);
			// 外框一掛上去就會問未讀通知數（社群規格 §6.4）。
			if (url.includes("/api/notifications/unread-count"))
				return jsonResponse({ count: 0 });
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
		// 自己按的登出不需要解釋：「已被登出」只給不是自己按的那種。
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("記帳畫面不顯示分頁列，關閉回到總覽後分頁列回來", async () => {
		// 矮螢幕（iPhone SE）上分頁列會蓋住數字鍵盤的最下面幾列（記帳與離線
		// 規格 §2 (b)）。記帳有自己的「關閉」，所以只有這一頁隱藏。
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("navigation", { name: "主要導覽" }),
		).toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "新增紀錄" }));
		await userEvent.click(screen.getByRole("link", { name: "記帳" }));
		// 換頁後的第一個斷言要對準只有記帳頁才有的東西（handover §6 第 53 種）。
		expect(
			await screen.findByRole("button", { name: "記一筆" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/expenses/new");
		expect(
			screen.queryByRole("navigation", { name: "主要導覽" }),
		).not.toBeInTheDocument();

		await userEvent.click(screen.getByRole("button", { name: "關閉" }));
		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("navigation", { name: "主要導覽" }),
		).toBeInTheDocument();
	});

	it("直接打開 /expenses/new 也不顯示分頁列", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		window.history.replaceState(null, "", "/expenses/new");

		render(<App />);

		expect(
			await screen.findByRole("button", { name: "記一筆" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("navigation", { name: "主要導覽" }),
		).not.toBeInTheDocument();
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

describe("App：被登出（帳號設定審查 I2）", () => {
	const NOTICE = "已被登出，請重新登入";

	function unauthorized() {
		return new Response(
			JSON.stringify({
				error: {
					code: "INVALID_TOKEN",
					message: "token 無效或已過期",
					details: {},
				},
			}),
			{ status: 401, headers: { "content-type": "application/json" } },
		);
	}

	/** 另一個分頁把票拿掉了。jsdom 跟瀏覽器一樣，不會把 storage 事件送給動手的那個
	 *  視窗——「另一個分頁」要自己送。 */
	function tokenRemovedInAnotherTab() {
		localStorage.removeItem("refresh_token");
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", {
					storageArea: localStorage,
					key: "refresh_token",
					oldValue: "r",
					newValue: null,
				}),
			);
		});
	}

	it("換票被拒（別的裝置改了密碼）：切回登入畫面並說明；重新登入後提示消失", async () => {
		// 以前：refresh.ts 清掉票與快取，但 App 的 loggedIn 只在開頁時讀一次——登入後的
		// 外框留在原地，之後每個請求都失敗，要自己重新整理才看得到登入畫面。改密碼會讓
		// 其他每一台裝置在 15 分鐘內走到這裡。
		setTokens({ access_token: "a", refresh_token: "r" });
		let revoked = false;
		mockBackend((url, method) => {
			if (method === "POST" && url.includes("/api/auth/login")) {
				revoked = false;
				return jsonResponse({
					access_token: "a2",
					refresh_token: "r2",
					token_type: "bearer",
				});
			}
			// 被撤銷之後：帶舊 access token 的請求 401，換票也 401。
			return revoked ? unauthorized() : undefined;
		});
		render(<App />);
		await userEvent.click(await screen.findByRole("link", { name: "我的" }));
		const refreshButton = await screen.findByRole("button", {
			name: "重新整理",
		});

		revoked = true;
		await userEvent.click(refreshButton);

		expect(
			await screen.findByRole("heading", { name: "登入" }),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(NOTICE);
		expect(
			screen.queryByRole("navigation", { name: "主要導覽" }),
		).not.toBeInTheDocument();
		expect(getRefreshToken()).toBeNull();

		// 重新登入 → 回到 app（登出不換網址，所以是「我的」）。
		await userEvent.type(screen.getByLabelText("Email"), "kenny@example.com");
		await userEvent.type(screen.getByLabelText("密碼"), "a-new-password");
		await userEvent.click(screen.getByRole("button", { name: "登入" }));
		await userEvent.click(await screen.findByRole("button", { name: "登出" }));

		// 這一次是自己按的：上一次的「已被登出」不能還留著。
		expect(
			await screen.findByRole("heading", { name: "登入" }),
		).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("另一個分頁登出（refresh token 從 localStorage 消失）：這個分頁也回到登入畫面", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		render(<App />);
		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		// 下面要斷言快取被清空——先確認它本來有東西。
		await waitFor(() =>
			expect(queryClient.getQueryCache().getAll().length).toBeGreaterThan(0),
		);

		// 跟登出無關的 storage 事件不能把人踢出去：別的鍵、票被換成新的一張（另一個分頁
		// 換了票或改了密碼）。
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", {
					storageArea: localStorage,
					key: "nutrition-tracker-offline-cache",
					oldValue: "{}",
					newValue: null,
				}),
			);
			window.dispatchEvent(
				new StorageEvent("storage", {
					storageArea: localStorage,
					key: "refresh_token",
					oldValue: "r",
					newValue: "r2",
				}),
			);
		});
		expect(screen.getByRole("heading", { name: "總覽" })).toBeInTheDocument();

		tokenRemovedInAnotherTab();

		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
		// 不是這個分頁按的登出：說明一下畫面為什麼突然變了。
		expect(screen.getByRole("status")).toHaveTextContent(NOTICE);
		// 這個分頁記憶體裡的東西也要丟：access token（還能用 15 分鐘）與上一個人的資料。
		expect(getAccessToken()).toBeNull();
		expect(queryClient.getQueryCache().getAll()).toEqual([]);
	});

	it("本來就沒登入的分頁收到同一個事件：不顯示「已被登出」", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();

		tokenRemovedInAnotherTab();

		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("登入確認過、碼已經從網址列拿掉之後才被登出（停在 /reset-password）：登入畫面與說明，不是「連結失效」", async () => {
		// 已登入的人打開邀請或重設連結，確認登入還有效之後碼會從網址列拿掉、路徑留著。這時被登出，
		// 未登入的那兩個畫面讀不到碼，會說連結失效——那不是發生的事。
		setTokens({ access_token: "a", refresh_token: "r" });
		mockBackend();
		window.history.replaceState(null, "", "/reset-password#tok-1");
		render(<App />);
		expect(
			await screen.findByRole("heading", { name: "重設密碼連結" }),
		).toBeInTheDocument();
		await waitFor(() => expect(window.location.hash).toBe(""));

		tokenRemovedInAnotherTab();

		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(NOTICE);
	});
});

// 忘記密碼的人手上的裝置，常常還留著一張早就過期或被撤銷的 refresh token。`App` 開頁時只看
// 「localStorage 裡有沒有票」，會先當成登入中——以前「已登入打開連結」的畫面一掛上去就把碼從網址列
// 拿掉，接著第一個請求 401、換票 401、被登出，落在登入畫面：碼沒了，也沒有任何說明。拿到重設連結的
// 人最常走的就是這條路。
describe("App：票已經失效的裝置打開邀請或重設連結", () => {
	const NOTICE = "已被登出，請重新登入";

	function unauthorized() {
		return new Response(
			JSON.stringify({
				error: {
					code: "INVALID_TOKEN",
					message: "token 無效或已過期",
					details: {},
				},
			}),
			{ status: 401, headers: { "content-type": "application/json" } },
		);
	}

	/** 整頁載入：localStorage 裡有票，記憶體裡沒有 access token。 */
	function reloadedWithRefreshToken() {
		setTokens({ access_token: "a", refresh_token: "r" });
		clearTokens({ keepStorage: true });
	}

	/** 票已經失效的後端：公開的確認端點照常回，其他（含換票）一律 401。記下確認端點收到的 body。 */
	function backendWithDeadSession(statusPath: string) {
		const statusBodies: unknown[] = [];
		const spy = mockBackend((url, _method, body) => {
			if (url.endsWith(statusPath)) {
				statusBodies.push(body);
				return jsonResponse({ valid: true });
			}
			return unauthorized();
		});
		return { spy, statusBodies };
	}

	function refreshWasTried(spy: ReturnType<typeof mockBackend>): boolean {
		return spy.mock.calls.some(([url]) =>
			String(url).includes("/api/auth/refresh"),
		);
	}

	function meWasRequested(spy: ReturnType<typeof mockBackend>): boolean {
		return spy.mock.calls.some(([url]) => String(url).endsWith("/api/me"));
	}

	/** 等過一輪再斷言「沒有發生」：立刻斷言在 effect 還沒跑的時候也成立（第 41 種）。 */
	function settle() {
		return act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
	}

	it("/reset-password#碼：直接是重設密碼的表單（碼還在、拿去確認），沒有「已被登出」", async () => {
		reloadedWithRefreshToken();
		const { spy, statusBodies } = backendWithDeadSession(
			"/api/auth/password-reset-status",
		);
		window.history.replaceState(null, "", "/reset-password#tok-1");

		render(<App />);

		expect(
			await screen.findByLabelText("再輸入一次新密碼"),
		).toBeInTheDocument();
		// 可及名稱是整個字串比對：「重設密碼連結」（已登入的說明頁）不算。
		expect(
			screen.getByRole("heading", { name: "重設密碼" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "重設密碼連結" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
		expect(statusBodies).toEqual([{ token: "tok-1" }]);
		// 「已被登出」跟眼前這張表單無關：他本來就是來設新密碼的。
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
		// 真的是被登出之後走到這裡的（不是 mock 剛好讓它一開始就沒登入）。
		expect(refreshWasTried(spy)).toBe(true);
		expect(getRefreshToken()).toBeNull();
		expect(screen.getAllByRole("main")).toHaveLength(1);
		expect(screen.getByRole("main")).toHaveClass("app-auth");
	});

	it("離線快取裡還留著上一次的 `me`：那不算「登入還有效」，一樣是重設密碼的表單", async () => {
		// 「確認登入」如果讀的是 query 快取（`useMe().isSuccess`），離線快取還原回來的那一份就會
		// 被當成確認：碼被拿掉，而且 60 秒內的快取不重抓，連被登出都不會發生——停在「你已經登入了」。
		// 同 /me/targets 踩過的那一種（帳號設定審查 M5）：快取裡有，不等於剛剛問過後端。
		const now = Date.now();
		localStorage.setItem(
			OFFLINE_CACHE_STORAGE_KEY,
			JSON.stringify({
				buster: "",
				timestamp: now,
				clientState: {
					mutations: [],
					queries: [
						{
							queryKey: queryKeys.me,
							queryHash: JSON.stringify(queryKeys.me),
							state: {
								data: ME,
								dataUpdateCount: 1,
								dataUpdatedAt: now,
								error: null,
								errorUpdateCount: 0,
								errorUpdatedAt: 0,
								fetchFailureCount: 0,
								fetchFailureReason: null,
								fetchMeta: null,
								isInvalidated: false,
								status: "success",
								fetchStatus: "idle",
							},
						},
					],
				},
			}),
		);
		reloadedWithRefreshToken();
		const { statusBodies } = backendWithDeadSession(
			"/api/auth/password-reset-status",
		);
		window.history.replaceState(null, "", "/reset-password#tok-1");

		render(<App />);

		expect(
			await screen.findByLabelText("再輸入一次新密碼"),
		).toBeInTheDocument();
		expect(statusBodies).toEqual([{ token: "tok-1" }]);
		expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
	});

	it("/join#碼：直接是建立帳號的表單（碼還在、拿去確認），沒有「已被登出」", async () => {
		reloadedWithRefreshToken();
		const { spy, statusBodies } = backendWithDeadSession(
			"/api/auth/invite-status",
		);
		window.history.replaceState(null, "", "/join#tok-1");

		render(<App />);

		expect(await screen.findByLabelText("再輸入一次密碼")).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "建立帳號" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "邀請連結" }),
		).not.toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
		expect(statusBodies).toEqual([{ token: "tok-1" }]);
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
		expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
		expect(refreshWasTried(spy)).toBe(true);
		expect(getRefreshToken()).toBeNull();
	});

	it.each([
		// 路徑是連結的路徑，但 # 後面沒有碼：照路徑走只會顯示「連結失效」。
		"/reset-password",
		"/join",
		// 有 # 但不是連結的路徑。
		"/me#tok-1",
		"/",
	])("%s（不是帶著碼的連結）：照舊是登入畫面與「已被登出」", async (path) => {
		reloadedWithRefreshToken();
		mockBackend(() => unauthorized());
		window.history.replaceState(null, "", path);

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "登入" }),
		).toBeInTheDocument();
		expect(screen.getByRole("status")).toHaveTextContent(NOTICE);
		expect(screen.queryByText(/連結已經失效/)).not.toBeInTheDocument();
		expect(getRefreshToken()).toBeNull();
	});

	it.each([
		["/reset-password#tok-1", "重設密碼連結"],
		["/join#tok-1", "邀請連結"],
	])(
		"登入還有效，打開 %s：`/api/me` 回來之前碼留在網址列，回來之後才拿掉",
		async (path, heading) => {
			reloadedWithRefreshToken();
			let respondMe: (response: Response) => void = () => undefined;
			let refreshed = false;
			const spy = mockBackend((url, method) => {
				if (method === "POST" && url.includes("/api/auth/refresh")) {
					refreshed = true;
					return jsonResponse({ access_token: "a2", refresh_token: "r2" });
				}
				// 整頁載入之後沒有 access token：第一次 401，換票之後重送的那一次掛著不回。
				if (url.endsWith("/api/me")) {
					if (!refreshed) return unauthorized();
					return new Promise<Response>((resolve) => {
						respondMe = resolve;
					});
				}
				return undefined;
			});
			window.history.replaceState(null, "", path);

			render(<App />);

			expect(
				await screen.findByRole("heading", { name: heading }),
			).toBeInTheDocument();
			await waitFor(() => expect(getRefreshToken()).toBe("r2"));
			await settle();
			expect(window.location.hash).toBe("#tok-1");

			respondMe(jsonResponse(ME));

			await waitFor(() => expect(window.location.hash).toBe(""));
			expect(window.location.pathname).toBe(path.replace("#tok-1", ""));
			expect(
				screen.getByRole("heading", { name: heading }),
			).toBeInTheDocument();
			expect(meWasRequested(spy)).toBe(true);
		},
	);

	it("連不上（`/api/me` 沒有回應）：不知道登入還有沒有效——碼留著、說明照舊、不登出", async () => {
		reloadedWithRefreshToken();
		const spy = mockBackend((url) => {
			// 斷線時 fetch 是直接 reject，連 Response 都沒有。
			if (url.includes("/api/")) throw new TypeError("network request failed");
			return undefined;
		});
		window.history.replaceState(null, "", "/reset-password#tok-1");

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "重設密碼連結" }),
		).toBeInTheDocument();
		await waitFor(() => expect(meWasRequested(spy)).toBe(true));
		await settle();
		expect(window.location.hash).toBe("#tok-1");
		expect(screen.getByRole("heading", { name: "重設密碼連結" })).toBeVisible();
		expect(getRefreshToken()).toBe("r");
	});

	it("還沒確認登入（碼還在網址列）時另一個分頁登出了：這個分頁直接變成重設密碼的表單", async () => {
		// 說明頁叫忘記密碼的人「先登出，再重新打開這個連結」；碼還在的話，登出之後不用再點一次。
		reloadedWithRefreshToken();
		const statusBodies: unknown[] = [];
		const spy = mockBackend((url, _method, body) => {
			if (url.endsWith("/api/auth/password-reset-status")) {
				statusBodies.push(body);
				return jsonResponse({ valid: true });
			}
			if (url.includes("/api/")) throw new TypeError("network request failed");
			return undefined;
		});
		window.history.replaceState(null, "", "/reset-password#tok-1");
		render(<App />);
		expect(
			await screen.findByRole("heading", { name: "重設密碼連結" }),
		).toBeInTheDocument();
		await waitFor(() => expect(meWasRequested(spy)).toBe(true));
		await settle();

		localStorage.removeItem("refresh_token");
		act(() => {
			window.dispatchEvent(
				new StorageEvent("storage", {
					storageArea: localStorage,
					key: "refresh_token",
					oldValue: "r",
					newValue: null,
				}),
			);
		});

		expect(
			await screen.findByLabelText("再輸入一次新密碼"),
		).toBeInTheDocument();
		expect(statusBodies).toEqual([{ token: "tok-1" }]);
		expect(screen.queryByText(NOTICE)).not.toBeInTheDocument();
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
		// 確認這台真的還登入著（`/api/me` 回來）之後才拿掉，所以要等。
		await waitFor(() => expect(window.location.hash).toBe(""));
		expect(window.location.pathname).toBe("/join");
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/auth/")),
		).toBe(false);
	});
});

describe("App 的 /reset-password（帳號設定規格 §5.5）", () => {
	it("沒登入時打開 /reset-password 顯示重設密碼，不是登入；包在 app-auth 裡", async () => {
		window.history.replaceState(null, "", "/reset-password#tok-1");
		mockBackend((url) =>
			url.includes("/api/auth/password-reset-status")
				? jsonResponse({ valid: true })
				: undefined,
		);

		render(<App />);

		expect(
			await screen.findByLabelText("再輸入一次新密碼"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { name: "重設密碼" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
		expect(screen.getAllByRole("main")).toHaveLength(1);
		expect(screen.getByRole("main")).toHaveClass("app-auth");
	});

	it("沒登入時打開 /reset-password/（多一個斜線）也是重設密碼", async () => {
		window.history.replaceState(null, "", "/reset-password/#tok-1");
		mockBackend((url) =>
			url.includes("/api/auth/password-reset-status")
				? jsonResponse({ valid: true })
				: undefined,
		);

		render(<App />);

		expect(
			await screen.findByLabelText("再輸入一次新密碼"),
		).toBeInTheDocument();
	});

	it("已登入打開 /reset-password：說明文字，不打任何重設端點，碼從網址列拿掉", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		const spy = mockBackend();
		window.history.replaceState(null, "", "/reset-password#tok-1");

		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "重設密碼連結" }),
		).toBeInTheDocument();
		expect(
			screen.getByText(/忘記密碼的話，先登出，再重新打開這個連結/),
		).toBeInTheDocument();
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/auth/")),
		).toBe(false);
		// 連結還能用：留在網址列（歷史紀錄、螢幕截圖）就是一條能改別人密碼的連結。
		// 確認這台真的還登入著（`/api/me` 回來）之後才拿掉，所以要等。
		await waitFor(() => expect(window.location.hash).toBe(""));
		expect(window.location.pathname).toBe("/reset-password");
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/auth/")),
		).toBe(false);
	});
});

describe("App 的電腦版外框（電腦版版面規格 §3）", () => {
	// 路徑、token、fetch mock 由檔案最上面的 beforeEach 重設；寬度由
	// src/test/setup.ts 的 beforeEach 重設回手機版。
	beforeEach(() => {
		setTokens({ access_token: "a", refresh_token: "r" });
	});

	it("寬螢幕：左側導覽在外框裡、第一個控制項是「新增紀錄」，外框有 app-desktop", async () => {
		setDesktop(true);
		mockBackend();
		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		const nav = screen.getByRole("navigation", { name: "主要導覽" });
		expect(nav.closest(".app-desktop")).not.toBeNull();
		// DOM 順序就是 Tab 順序：左側導覽的「新增」在最上面（規格 §2）。
		expect(
			nav.querySelector("a[href], button")?.getAttribute("aria-label"),
		).toBe("新增紀錄");
		const main = screen.getByRole("main");
		expect(main.closest(".app-desktop")).not.toBeNull();
		// 底部留白（沒有分頁列）與內容寬度是 CSS，jsdom 量不到——幾何在
		// e2e/desktop-layout.spec.ts。這裡只測結構。
		expect(main.querySelector(".app-content-wide")).not.toBeNull();
		// 只有一個導覽（不是 SideNav＋TabBar 都在）。
		expect(
			screen.getAllByRole("navigation", { name: "主要導覽" }),
		).toHaveLength(1);
	});

	it("寬螢幕的記帳頁：照樣有左側導覽，內容是表單寬度", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/expenses/new");
		render(<App />);

		expect(
			await screen.findByRole("button", { name: "記一筆" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("navigation", { name: "主要導覽" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("main").querySelector(".app-content-form"),
		).not.toBeNull();
	});

	it("其他頁（我的）是窄的內容寬度", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/me");
		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "我的" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("main").querySelector(".app-content-narrow"),
		).not.toBeNull();
	});

	it("/meals/7 是餐點頁（唯讀的一餐與留言），窄的內容寬度；/meals/new 仍然是記一餐", async () => {
		// 路由的接線只有 App 層看得到：兩種卡片上的「留言 N」連到 /meals/:id
		// （社群規格 §6.3）。`/meals/new` 與 `/meals/:id` 長得一樣，靠 react-router
		// 的排名分（靜態的比動態的具體）。
		setDesktop(true);
		const spy = mockBackend((url) =>
			url.includes("/api/social/meals/7")
				? jsonResponse({
						meal: {
							id: 7,
							user: { id: 1, display_name: "Kenny" },
							eaten_at: "2026-10-02T04:00:00Z",
							meal_type: "lunch",
							description: null,
							items: [],
							kcal: "0.00",
							protein_g: "0.00",
							fat_g: "0.00",
							carb_g: "0.00",
							has_photo: false,
							like_count: 0,
							comment_count: 0,
							liked_by_me: false,
						},
						is_mine: true,
						likes: [],
						comments: [],
						comments_truncated: false,
					})
				: undefined,
		);
		window.history.replaceState(null, "", "/meals/7");
		const { unmount } = render(<App />);

		expect(
			await screen.findByRole("heading", { level: 1, name: "我的午餐" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("heading", { level: 2, name: "留言（0）" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("main").querySelector(".app-content-narrow"),
		).not.toBeNull();
		unmount();

		spy.mockClear();
		window.history.replaceState(null, "", "/meals/new");
		render(<App />);

		expect(
			await screen.findByRole("heading", { level: 1, name: "記一餐" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("main").querySelector(".app-content-form"),
		).not.toBeNull();
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/social/")),
		).toBe(false);
	});

	it("視窗從寬拉窄：換回手機版（沒有 app-desktop，記帳頁沒有導覽）", async () => {
		setDesktop(true);
		mockBackend();
		window.history.replaceState(null, "", "/expenses/new");
		render(<App />);
		expect(
			await screen.findByRole("button", { name: "記一筆" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("navigation", { name: "主要導覽" }),
		).toBeInTheDocument();

		act(() => setDesktop(false));

		expect(
			screen.queryByRole("navigation", { name: "主要導覽" }),
		).not.toBeInTheDocument();
		expect(document.querySelector(".app-desktop")).toBeNull();
		expect(screen.getByRole("main")).toHaveClass("app-main-no-tab-bar");
	});

	it("手機版（預設）：沒有 app-desktop，也沒有內容寬度的外層", async () => {
		mockBackend();
		render(<App />);

		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		expect(document.querySelector(".app-desktop")).toBeNull();
		expect(document.querySelector(".app-content")).toBeNull();
	});
});

describe("App 的未登入畫面（電腦版版面規格 §3）", () => {
	it("登入畫面包在 app-auth 的 main 裡（置中、最寬 400px）", () => {
		render(<App />);
		const main = screen.getByRole("main");
		expect(main).toHaveClass("app-auth");
		expect(main).toContainElement(
			screen.getByRole("heading", { name: "登入" }),
		);
	});

	it("建立帳號畫面也是 app-auth，只有一個 main", async () => {
		window.history.replaceState(null, "", "/join#tok-1");
		mockBackend((url) =>
			url.includes("/api/auth/invite-status")
				? jsonResponse({ valid: true })
				: undefined,
		);
		render(<App />);

		expect(await screen.findByLabelText("再輸入一次密碼")).toBeInTheDocument();
		expect(screen.getAllByRole("main")).toHaveLength(1);
		expect(screen.getByRole("main")).toHaveClass("app-auth");
	});
});

describe("App：未讀通知（社群規格 §6.4、D16、D17）", () => {
	const UNREAD_URL = "/api/notifications/unread-count";

	beforeEach(() => {
		setTokens({ access_token: "a", refresh_token: "r" });
	});

	/** 某個網址被請求了幾次（只看 GET）。 */
	function requested(spy: ReturnType<typeof mockBackend>, path: string) {
		return spy.mock.calls.filter(
			([url, init]) =>
				String(url).includes(path) &&
				(init?.method ?? "GET").toUpperCase() === "GET",
		).length;
	}

	it("有未讀：分頁列的「我的」名稱不變，描述是幾則新通知", async () => {
		mockBackend((url) =>
			url.includes(UNREAD_URL) ? jsonResponse({ count: 2 }) : undefined,
		);
		render(<App />);

		const link = await screen.findByRole("link", { name: "我的" });
		await waitFor(() => expect(link).toHaveAccessibleDescription("2 則新通知"));
		expect(link).toHaveTextContent(/^我的2$/);
	});

	it("電腦版：左側導覽的「我的」也有", async () => {
		setDesktop(true);
		mockBackend((url) =>
			url.includes(UNREAD_URL) ? jsonResponse({ count: 12 }) : undefined,
		);
		render(<App />);

		const link = await screen.findByRole("link", { name: "我的" });
		await waitFor(() =>
			expect(link).toHaveAccessibleDescription("12 則新通知"),
		);
		expect(link.closest(".app-desktop")).not.toBeNull();
	});

	it("沒有未讀（或抓不到）：沒有描述、沒有數字", async () => {
		const spy = mockBackend((url) =>
			url.includes(UNREAD_URL)
				? new Response("{}", { status: 500 })
				: undefined,
		);
		render(<App />);

		const link = await screen.findByRole("link", { name: "我的" });
		await waitFor(() => expect(requested(spy, UNREAD_URL)).toBe(1));
		expect(link).not.toHaveAttribute("aria-describedby");
		expect(link.textContent).toBe("我的");
	});

	it("剛載入只問一次未讀數；每換一頁再問一次", async () => {
		// 手機上的 PWA 很少有「視窗取得焦點」，最常發生的事是換頁（規格 D16）。
		const spy = mockBackend();
		render(<App />);
		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		await waitFor(() => expect(requested(spy, UNREAD_URL)).toBe(1));
		// 等一下再看：第一次掛載不該另外重抓一次（那一次本來就在抓）。
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(requested(spy, UNREAD_URL)).toBe(1);

		await userEvent.click(screen.getByRole("link", { name: "報表" }));
		expect(
			await screen.findByRole("heading", { name: "報表" }),
		).toBeInTheDocument();
		await waitFor(() => expect(requested(spy, UNREAD_URL)).toBe(2));

		await userEvent.click(screen.getByRole("link", { name: "飲食" }));
		expect(
			await screen.findByRole("heading", { name: "飲食" }),
		).toBeInTheDocument();
		await waitFor(() => expect(requested(spy, UNREAD_URL)).toBe(3));
	});

	it("未讀數變多了：自己的餐點清單跟著重抓（上面的讚與留言數變了）；沒變多就不抓", async () => {
		// `["meals"]` 用 app 預設的 staleTime（60 秒），同一次載入裡不會自己重抓：
		// 別人剛按的讚、剛留的言要有東西通知它。未讀數變多就是那個訊號。
		let count = 0;
		const spy = mockBackend((url) =>
			url.includes(UNREAD_URL) ? jsonResponse({ count }) : undefined,
		);
		render(<App />);
		expect(
			await screen.findByRole("heading", { name: "總覽" }),
		).toBeInTheDocument();
		await waitFor(() => expect(requested(spy, UNREAD_URL)).toBe(1));
		await waitFor(() => expect(requested(spy, "/api/meals")).toBe(1));

		// 再問一次，數字一樣：餐點清單不動。
		await act(() =>
			queryClient.refetchQueries({ queryKey: queryKeys.unreadCount }),
		);
		expect(requested(spy, UNREAD_URL)).toBe(2);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(requested(spy, "/api/meals")).toBe(1);

		// 有人按了讚。
		count = 1;
		await act(() =>
			queryClient.refetchQueries({ queryKey: queryKeys.unreadCount }),
		);
		await waitFor(() => expect(requested(spy, "/api/meals")).toBe(2));
		// 通知的清單與餐點頁也標成過期（沒有人掛著，所以不會真的抓）。
		expect(
			screen.getByRole("link", { name: "我的" }),
		).toHaveAccessibleDescription("1 則新通知");

		// 數字變少（看過了）：不抓。
		count = 0;
		await act(() =>
			queryClient.refetchQueries({ queryKey: queryKeys.unreadCount }),
		);
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(requested(spy, "/api/meals")).toBe(2);
	});

	it("未讀數變多了：快取裡的通知清單與餐點頁標成過期；第一次拿到數字不算變多", async () => {
		let count = 3;
		mockBackend((url) =>
			url.includes(UNREAD_URL) ? jsonResponse({ count }) : undefined,
		);
		queryClient.setQueryData(queryKeys.notifications, []);
		queryClient.setQueryData(queryKeys.socialMeal(7), { comments: [] });
		render(<App />);
		const link = await screen.findByRole("link", { name: "我的" });
		await waitFor(() => expect(link).toHaveAccessibleDescription("3 則新通知"));
		// 剛載入：還不知道 → 3 不是「變多」。
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(
			queryClient.getQueryState(queryKeys.notifications)?.isInvalidated,
		).toBe(false);
		expect(
			queryClient.getQueryState(queryKeys.socialMeal(7))?.isInvalidated,
		).toBe(false);

		count = 4;
		await act(() =>
			queryClient.refetchQueries({ queryKey: queryKeys.unreadCount }),
		);

		await waitFor(() =>
			expect(
				queryClient.getQueryState(queryKeys.notifications)?.isInvalidated,
			).toBe(true),
		);
		expect(
			queryClient.getQueryState(queryKeys.socialMeal(7))?.isInvalidated,
		).toBe(true);
	});

	it("從「我的」的通知卡片進通知頁：看到清單、送已讀，分頁上的數字消失", async () => {
		const NOTICE = {
			id: 53,
			type: "like",
			actor_name: "鮑伯",
			meal: { id: 7, meal_type: "lunch", eaten_at: "2026-10-02T04:00:00Z" },
			comment_preview: null,
			created_at: "2026-10-02T05:00:00Z",
			is_read: false,
		};
		let read = false;
		const spy = mockBackend((url, method, body) => {
			// 越具體的排越前面：這兩個網址都「包含」清單的網址。
			if (url.includes(UNREAD_URL)) {
				return jsonResponse({ count: read ? 0 : 1 });
			}
			if (url.includes("/api/notifications/read-all") && method === "POST") {
				expect(body).toEqual({ up_to: 53 });
				read = true;
				return jsonResponse({ count: 0 });
			}
			if (url.includes("/api/notifications")) {
				return jsonResponse({ items: [NOTICE] });
			}
			return undefined;
		});
		render(<App />);

		const tab = await screen.findByRole("link", { name: "我的" });
		await waitFor(() => expect(tab).toHaveAccessibleDescription("1 則新通知"));
		await userEvent.click(tab);
		const card = await screen.findByTestId("notifications-card");
		expect(card).toHaveTextContent("1 則新通知");

		await userEvent.click(screen.getByRole("link", { name: "看通知" }));

		expect(
			await screen.findByRole("heading", { level: 1, name: "通知" }),
		).toBeInTheDocument();
		expect(window.location.pathname).toBe("/notifications");
		expect(
			await screen.findByRole("link", { name: /鮑伯 對你的午餐按了讚/ }),
		).toHaveAttribute("href", "/meals/7");
		// 已讀送出去之後，分頁上的數字不見了（名稱從頭到尾都是「我的」）。
		await waitFor(() =>
			expect(screen.getByRole("link", { name: "我的" })).not.toHaveAttribute(
				"aria-describedby",
			),
		);
		expect(
			spy.mock.calls.filter(([url]) =>
				String(url).includes("/api/notifications/read-all"),
			),
		).toHaveLength(1);
	});

	it("電腦版的通知頁是窄的內容寬度", async () => {
		setDesktop(true);
		mockBackend((url) =>
			url.includes("/api/notifications") && !url.includes(UNREAD_URL)
				? jsonResponse({ items: [] })
				: undefined,
		);
		window.history.replaceState(null, "", "/notifications");
		render(<App />);

		expect(await screen.findByText("還沒有通知")).toBeInTheDocument();
		expect(
			screen.getByRole("main").querySelector(".app-content-narrow"),
		).not.toBeNull();
	});
});
