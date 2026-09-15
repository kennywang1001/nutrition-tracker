import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../src/App";
import { queryClient } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	// `queryClient` 是模組層的單例（Task 4：`clearQueryCacheOnForcedLogout`
	// 要在 logout()／refresh 失敗時清的就是這一個 instance），在同一個測試
	// 檔案裡的多個 it() 之間會留存。不清的話，這裡任一則測試對 /api/stats/daily
	// 的 mock 回應（形狀常常只是隨手塞的 `[]`）會被 <Today /> 快取住，
	// 下一則測試一 mount 就讀到上一則的舊快取，值的形狀對不上會直接把
	// render 炸掉——這正是 §6.5 要清快取的同一個道理，只是這裡的「下一個
	// 使用者」換成了「下一個測試」。
	queryClient.clear();
});

describe("App", () => {
	it("沒有 token 時顯示登入畫面", () => {
		render(<App />);
		expect(screen.getByRole("heading", { name: "登入" })).toBeInTheDocument();
	});

	it("有 token 時顯示今日總覽，而不是登入畫面", () => {
		// 重新整理之後不該被踢回登入頁——refresh token 還在 localStorage 裡。
		setTokens({ access_token: "a", refresh_token: "r" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(JSON.stringify([]), {
				status: 200,
				headers: { "content-type": "application/json" },
			}),
		);

		render(<App />);

		expect(
			screen.queryByRole("heading", { name: "登入" }),
		).not.toBeInTheDocument();
	});

	it("登出之後回到登入畫面", async () => {
		setTokens({ access_token: "a", refresh_token: "r" });
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response(null, { status: 204 }),
		);

		render(<App />);
		await userEvent.click(screen.getByRole("button", { name: "登出" }));

		expect(
			await screen.findByRole("heading", { name: "登入" }),
		).toBeInTheDocument();
	});
});
