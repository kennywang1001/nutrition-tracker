import { describe, expect, it, vi } from "vitest";
import { json, mockApi } from "./helpers/mock-api";

describe("共用的 fetch mock", () => {
	it("沒帶 Authorization 就回 401 信封", async () => {
		// **這則測試守的是一個後備檢查，而它需要被守的理由很具體。**
		//
		// 用這個 mock 的 6 個測試檔，beforeEach 都先 clearTokens() 再
		// setTokens()，而且沒有任何一則測試在 render 之後清掉 token ——
		// 所以 mock 裡「沒帶 header 就回 401」那個分支在它們裡面
		// **從來沒有被走過**。（P3-B 計畫一 Task 1 對它做突變驗證時發現的：
		// 把那個檢查停掉，138 則測試全部照樣綠。）
		//
		// 那代表下一個跑覆蓋率的人會看到一個沒被觸及的分支，而「清掉死碼」
		// 是很現實的下一步。清掉之後，這個 mock 會開始靜默地接受未認證的
		// 請求 —— 於是那 6 個檔案的測試在 apiFetch 不再附上 token 時
		// 依然會綠。
		//
		// **這個檢查不是「所有請求都要帶 token」的主守衛** —— 那件事由
		// tests/client.test.ts 的「帶上 Authorization」與
		// tests/meal-photo.test.tsx 的同名斷言守著（兩者合起來蓋住
		// src/api/client.ts 的 fetchWithAuthRetry 內核）。這裡守的是
		// 那道後備防線本身還在。
		mockApi([{ path: "/api/anything", handler: () => json({ ok: true }) }]);

		const response = await fetch("/api/anything");

		expect(response.status).toBe(401);
		const body = (await response.json()) as { error: { code: string } };
		expect(body.error.code).toBe("NOT_AUTHENTICATED");

		vi.restoreAllMocks();
	});

	it("帶了 Authorization 就交給對應的 handler", async () => {
		mockApi([{ path: "/api/anything", handler: () => json({ ok: true }) }]);

		const response = await fetch("/api/anything", {
			headers: { authorization: "Bearer a" },
		});

		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({ ok: true });

		vi.restoreAllMocks();
	});

	it("method 省略時任何 method 都算符合，指定了就只吃那一個", async () => {
		// mockApiByPath 的語意（5 個既有檔案原本的行為）就是靠 method
		// 省略時的這個放行。搬移時不能偷偷改掉它。
		mockApi([{ path: "/api/anything", handler: () => json({ any: true }) }]);
		const anyMethod = await fetch("/api/anything", {
			method: "DELETE",
			headers: { authorization: "Bearer a" },
		});
		expect(await anyMethod.json()).toEqual({ any: true });
		vi.restoreAllMocks();

		mockApi([
			{
				method: "POST",
				path: "/api/anything",
				handler: () => json({ posted: true }),
			},
		]);
		await expect(
			fetch("/api/anything", {
				method: "GET",
				headers: { authorization: "Bearer a" },
			}),
		).rejects.toThrow("測試沒有為這個路徑準備回應");
		vi.restoreAllMocks();
	});
});
