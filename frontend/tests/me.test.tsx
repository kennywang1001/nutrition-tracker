import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Me } from "../src/screens/Me";
import { json, mockApi } from "./helpers/mock-api";

function me(role: "user" | "admin") {
	return {
		id: 1,
		email: "kenny@example.com",
		display_name: "Kenny",
		role,
		timezone: "Asia/Taipei",
	};
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("我的", () => {
	it("顯示帳號的 email", async () => {
		mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(await screen.findByText("kenny@example.com")).toBeInTheDocument();
	});

	it("管理員看得到「審核」入口", async () => {
		// 從 tab bar 的第五格搬過來（介面改版）。前端藏起連結只是可用性，
		// 真正的授權在後端 require_admin。
		mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("admin")) },
		]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(await screen.findByRole("link", { name: "審核" })).toHaveAttribute(
			"href",
			"/admin/revisions",
		);
	});

	it("一般使用者看不到「審核」", async () => {
		mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		// 先等 email 出現，確保 useMe() 已經解析完——否則下面只是在證明
		// 「還沒 fetch 完」，不是「查完之後仍然沒有」。
		await screen.findByText("kenny@example.com");
		expect(
			screen.queryByRole("link", { name: "審核" }),
		).not.toBeInTheDocument();
	});

	it("useMe 還在載入時看不到「審核」——不要先閃一下再消失", () => {
		vi.spyOn(globalThis, "fetch").mockImplementation(
			() => new Promise(() => {}),
		);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(
			screen.queryByRole("link", { name: "審核" }),
		).not.toBeInTheDocument();
	});

	it("「重新整理」直接打 /api/me 並顯示名稱", async () => {
		// 這顆按鈕是 e2e/auth.spec.ts 測「token 過期自動換票」的唯一路徑。
		// 這條測試守的是「點一下會多發一個 /api/me 請求，並把回應的
		// display_name 顯示出來」。
		const fetchMock = mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("kenny@example.com");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "重新整理" }));

		expect(await screen.findByText("Kenny")).toBeInTheDocument();
		expect(fetchMock.mock.calls.length).toBe(before + 1);
	});

	it("登出之後通知外層", async () => {
		const onLoggedOut = vi.fn();
		mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
			{
				method: "POST",
				path: "/api/auth/logout",
				handler: () => new Response(null, { status: 204 }),
			},
		]);
		render(wrap(<Me onLoggedOut={onLoggedOut} />));

		await userEvent.click(screen.getByRole("button", { name: "登出" }));

		await waitFor(() => expect(onLoggedOut).toHaveBeenCalled());
	});

	it("「重新整理」失敗時顯示提示，不丟出未處理的 rejection", async () => {
		let calls = 0;
		mockApi([
			{
				method: "GET",
				path: "/api/me",
				handler: () => {
					calls += 1;
					return calls === 1
						? json(me("user"))
						: new Response("boom", { status: 500 });
				},
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("kenny@example.com");

		await userEvent.click(screen.getByRole("button", { name: "重新整理" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("無法重新整理");
	});
});
