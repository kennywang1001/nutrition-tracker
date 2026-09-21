import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_PHOTO_BYTES } from "../src/api/photos";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { MealList } from "../src/screens/MealList";

// ⚠️ jsdom 沒有實作 canvas 的 2D 繪圖 context——`canvas.getContext("2d")`
// 在這裡是 `null`。上傳流程真的用到 canvas 的那一步已經抽成獨立模組
// （`src/lib/resize-image.ts` 的 `shrinkToLongestEdge`），這裡整個 mock
// 掉、原樣回傳傳進去的 File。這四條測試要驗的是上傳流程本身——欄位名、
// 前端擋大小、失效、錯誤訊息——不是「canvas 降尺寸真的有效」。降尺寸
// 本身沒有單元測試，是刻意接受的代價，只有瀏覽器（手動）驗得到，
// 見 resize-image.ts 開頭的註解。
vi.mock("../src/lib/resize-image", () => ({
	shrinkToLongestEdge: vi.fn((file: File) => Promise.resolve(file)),
}));

// helper 們跟 meal-list.test.tsx 的 wrap / json 同一個理由——刻意不抽成
// 共用模組。這裡的 mockApi 比 meal-list.test.tsx 那份多認一個 HTTP
// method：同一個路徑 `/api/meals/{id}/photo` 底下 GET 用來取圖、POST 用來
// 上傳，只比對路徑分不出兩者。

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

type Route = { method: string; path: string; handler: () => Response };

/** 依 (method, path) 分派的 fetch mock。**一律先驗 Authorization**——
 *  理由跟 meal-list.test.tsx 的 mockApi 一樣（規格 §9.2 第 2 條）。
 *
 *  `routes` 用陣列、依序比對第一個符合的——`/api/meals/11/photo` 這個
 *  URL 同時「包含」`/api/meals`，所以呼叫端要把更具體的路徑排在前面，
 *  否則泛用的 `/api/meals` 路由會搶先吃掉照片端點的請求。 */
function mockApi(routes: Route[]) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : String(input);
			if (!new Headers(init?.headers).has("authorization")) {
				return new Response(
					JSON.stringify({
						error: {
							code: "NOT_AUTHENTICATED",
							message: "需要登入",
							details: {},
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
			const method = (init?.method ?? "GET").toUpperCase();
			const route = routes.find(
				(candidate) =>
					candidate.method === method && url.includes(candidate.path),
			);
			if (route === undefined) {
				throw new Error(`測試沒有為這個路徑準備回應：${method} ${url}`);
			}
			return route.handler();
		});
}

function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function meal(overrides: Record<string, unknown> = {}) {
	return {
		id: 11,
		eaten_at: "2026-09-21T12:30:00+08:00",
		meal_type: "lunch",
		note: null,
		photo_path: null,
		items: [],
		kcal: "440.00",
		protein_g: "13.00",
		fat_g: "14.00",
		carb_g: "44.00",
		...overrides,
	};
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("上傳餐點照片", () => {
	it("上傳時用 multipart，欄位名是 file", async () => {
		// 後端的簽章是 `file: UploadFile = File(...)`——欄位名寫錯的話
		// FastAPI 會回 422 VALIDATION_ERROR，而那個錯誤訊息不會直接說
		// 「你的欄位名叫錯了」。
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/meals/11/photo",
				handler: () => json(meal({ photo_path: "11/new.jpg" })),
			},
			{ method: "GET", path: "/api/meals", handler: () => json([meal()]) },
		]);

		render(wrap(<MealList />));
		const input = await screen.findByLabelText("上傳照片");
		const file = new File(["fake-jpeg"], "lunch.jpg", {
			type: "image/jpeg",
		});
		await userEvent.upload(input, file);

		await waitFor(() => {
			const uploadCall = fetchMock.mock.calls.find(
				([reqInput, reqInit]) =>
					String(reqInput).includes("/api/meals/11/photo") &&
					reqInit?.method === "POST",
			);
			expect(uploadCall).toBeDefined();
		});

		const uploadCall = fetchMock.mock.calls.find(
			([reqInput, reqInit]) =>
				String(reqInput).includes("/api/meals/11/photo") &&
				reqInit?.method === "POST",
		);
		const body = uploadCall?.[1]?.body;
		expect(body).toBeInstanceOf(FormData);
		expect((body as FormData).get("file")).not.toBeNull();
		// 欄位名寫錯最常見的形式是拿資源名當欄位名（"photo"）——
		// 直接斷言它不存在，寫錯的話這裡會紅。
		expect((body as FormData).has("photo")).toBe(false);
	});

	it("超過 10MB 的檔案在前端就被擋下來，不會送出", async () => {
		// 後端有 PHOTO_TOO_LARGE（413），所以這不是不信任後端——
		// 是不要讓手機在慢速連線上傳了 30 秒才被拒。
		const fetchMock = mockApi([
			{ method: "GET", path: "/api/meals", handler: () => json([meal()]) },
		]);

		render(wrap(<MealList />));
		const input = await screen.findByLabelText("上傳照片");
		const tooBig = new File([new Uint8Array(MAX_PHOTO_BYTES + 1)], "huge.jpg", {
			type: "image/jpeg",
		});
		await userEvent.upload(input, tooBig);

		expect(await screen.findByRole("alert")).toHaveTextContent("10MB");

		// 沒有任何一次 fetch 打到照片端點——擋下來的意思是「根本沒送出」，
		// 不是「送出後被 UI 忽略」。
		expect(
			fetchMock.mock.calls.some(
				([reqInput, reqInit]) =>
					String(reqInput).includes("/api/meals/11/photo") &&
					reqInit?.method === "POST",
			),
		).toBe(false);
	});

	it("上傳成功後讓餐點清單與該餐的照片 key 失效", async () => {
		// 照片不影響營養素，但 MealResponse 的 photo_path 變了——
		// 清單要重取才看得到新照片。這一餐本來就有照片（photo_path 不是
		// null），所以 MealPhoto／useMealPhoto 會一起掛載，兩個 key
		// （queryKeys.meals 與 queryKeys.mealPhoto(11)）的失效都測得到。
		const existingMeal = meal({ photo_path: "11/old.jpg" });
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/meals/11/photo",
				handler: () =>
					new Response(new Blob(["fake-jpeg"], { type: "image/jpeg" }), {
						status: 200,
						headers: { "content-type": "image/jpeg" },
					}),
			},
			{
				method: "POST",
				path: "/api/meals/11/photo",
				handler: () => json(meal({ photo_path: "11/new.jpg" })),
			},
			{
				method: "GET",
				path: "/api/meals",
				handler: () => json([existingMeal]),
			},
		]);

		function countCalls(method: string, matches: (url: string) => boolean) {
			return fetchMock.mock.calls.filter(
				([reqInput, reqInit]) =>
					matches(String(reqInput)) && (reqInit?.method ?? "GET") === method,
			).length;
		}
		const listCalls = () => countCalls("GET", (url) => url === "/api/meals");
		const photoGetCalls = () =>
			countCalls("GET", (url) => url.includes("/api/meals/11/photo"));
		const photoPostCalls = () =>
			countCalls("POST", (url) => url.includes("/api/meals/11/photo"));

		render(wrap(<MealList />));
		await screen.findByTestId("meal-photo-11");
		await waitFor(() => expect(listCalls()).toBe(1));
		await waitFor(() => expect(photoGetCalls()).toBe(1));

		const input = screen.getByLabelText("上傳照片");
		const file = new File(["fake-jpeg"], "lunch.jpg", {
			type: "image/jpeg",
		});
		await userEvent.upload(input, file);

		await waitFor(() => expect(photoPostCalls()).toBe(1));
		// invalidateQueries(queryKeys.meals)：清單要重取。
		await waitFor(() => expect(listCalls()).toBe(2));
		// invalidateQueries(queryKeys.mealPhoto(11))：這一餐的照片 blob 也要重取。
		await waitFor(() => expect(photoGetCalls()).toBe(2));
	});

	it("後端回 INVALID_PHOTO 時顯示的是「無法識別的圖片」", async () => {
		// 422 INVALID_PHOTO。前端先降尺寸之後理論上不會發生，
		// 但「理論上不會發生」的東西如果讓畫面白掉，代價不對稱。
		mockApi([
			{ method: "GET", path: "/api/meals", handler: () => json([meal()]) },
			{
				method: "POST",
				path: "/api/meals/11/photo",
				handler: () =>
					json(
						{
							error: {
								code: "INVALID_PHOTO",
								// 刻意跟前端顯示的文字不同——如果前端只是原樣轉貼
								// error.message，這條測試會抓到「無法識別的圖片內容」
								// 而不是「無法識別的圖片」，斷言就會失敗。
								message: "無法識別的圖片內容",
								details: {},
							},
						},
						422,
					),
			},
		]);

		render(wrap(<MealList />));
		const input = await screen.findByLabelText("上傳照片");
		const file = new File(["not-really-an-image"], "broken.jpg", {
			type: "image/jpeg",
		});
		await userEvent.upload(input, file);

		expect(await screen.findByText("無法識別的圖片")).toBeInTheDocument();
	});
});
