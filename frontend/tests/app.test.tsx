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

	it("有 token 時顯示記一餐（首頁），而不是登入畫面", () => {
		// P3-C Task 3：首頁從今日總覽換成記一餐（使用者原話「記一餐應該
		// 放在首頁」）。重新整理之後不該被踢回登入頁——refresh token 還在
		// localStorage 裡。
		//
		// 這條原本只斷言「沒看到登入畫面」，那個斷言在首頁換成記一餐之後
		// 依然會綠（不管首頁是今日總覽還是記一餐，登入畫面都不在），但
		// 那不是這個 task 改動的行為要被守住的方式——加一行明確斷言看到
		// 的是「記一餐」，這樣如果哪天首頁被誰不小心導回今日總覽，這裡
		// 才會紅。
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
		expect(screen.getByRole("heading", { name: "記一餐" })).toBeInTheDocument();
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
