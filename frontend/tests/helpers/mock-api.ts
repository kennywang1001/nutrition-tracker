import { vi } from "vitest";

/** 一條路由。`method` 省略時代表**任何 method 都算符合** ——
 *  那是 5 個既有測試檔原本的 `Record` 版本的語意，抽出來時不能偷偷改掉。 */
export type Route = {
	method?: string;
	path: string;
	handler: () => Response;
};

/** 依 (method, path) 分派的 fetch mock。**一律先驗 Authorization** ——
 *  沒帶就回 401 信封 —— 這是**後備防線**，不是主守衛。
 *
 *  「所有請求都要帶 token」由 `tests/client.test.ts` 的「帶上 Authorization」
 *  與 `tests/meal-photo.test.tsx` 的同名斷言守著（兩者合起來蓋住
 *  `src/api/client.ts` 的 `fetchWithAuthRetry` 內核）。舊版的註解寫
 *  「mock 不檢查 header 的話這個保證零鑑別力」—— 那句話誇大了，不是零。
 *
 *  這道後備防線的價值在於：`apiFetch` 哪天以那兩則測試抓不到的方式漏掉
 *  token，用這個 mock 的畫面測試會紅，而不是靜默通過。
 *  它自己由 `tests/mock-api-helper.test.ts` 守著 —— 需要那則測試的理由
 *  見那個檔案（簡短說：這個分支在那 6 個畫面測試裡從來沒被走過，
 *  跑覆蓋率的人會把它當死碼清掉）。
 *
 *  `routes` 用陣列、依序比對第一個符合的 —— `/api/meals/11/photo` 這個
 *  URL 同時「包含」`/api/meals`，所以呼叫端要把更具體的路徑排在前面，
 *  否則泛用的 `/api/meals` 路由會搶先吃掉照片端點的請求。
 *
 *  **比對用 `url.includes(path)` 而不是相等**：測試裡的 URL 是相對路徑
 *  （`/api/stats/daily`），但有些呼叫會帶 query string。
 */
export function mockApi(routes: readonly Route[]) {
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
					(candidate.method === undefined ||
						candidate.method.toUpperCase() === method) &&
					url.includes(candidate.path),
			);
			if (route === undefined) {
				throw new Error(`測試沒有為這個路徑準備回應：${method} ${url}`);
			}
			return route.handler();
		});
}

/** 只比對路徑、不管 method 的舊形式。
 *
 *  **保留它是為了讓這次抽取是純粹的刪除** —— 5 個既有測試檔的呼叫端
 *  一個字都不用改。新的測試請用 `mockApi`：計畫二要分辨
 *  `GET /api/foods`（搜尋）與 `POST /api/foods`（新增），那是同一個路徑。
 */
export function mockApiByPath(routes: Record<string, () => Response>) {
	return mockApi(
		Object.entries(routes).map(([path, handler]) => ({ path, handler })),
	);
}

/** JSON 回應。`status` 預設 200 —— `meal-photo-upload.test.tsx` 需要用它
 *  造 422，其他檔案原本的版本沒有這個參數，預設值讓兩邊相容。 */
export function json(body: unknown, status = 200) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}
