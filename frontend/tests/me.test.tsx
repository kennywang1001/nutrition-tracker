import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
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

// 「我的」的每日目標卡片會打 /api/stats/daily（帳號設定規格 §5.1）。每一條測試都明確準備它：
// 沒準備的話 mock 丟例外、卡片顯示「無法載入」——既有的斷言不會因此紅，但那是靠「丟例外也沒關係」，不好讀。
const ZERO = { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" };
const STATS = {
	date: "2019-07-04",
	actual: ZERO,
	target: { kcal: "1800.00", protein_g: "120.00", fat_g: null, carb_g: null },
	ratio: { kcal: "0.00", protein_g: "0.00", fat_g: null, carb_g: null },
	breakdown: { food: ZERO, supplement: ZERO },
};

function statsRoute(body: unknown = STATS, status = 200) {
	return {
		method: "GET",
		path: "/api/stats/daily",
		handler: () => json(body, status),
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
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(await screen.findByText("kenny@example.com")).toBeInTheDocument();
	});

	it("管理員看得到「審核」入口", async () => {
		// 從 tab bar 的第五格搬過來（介面改版）。前端藏起連結只是可用性，
		// 真正的授權在後端 require_admin。
		mockApi([
			statsRoute(),
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
			statsRoute(),
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

	it("管理員有「所有帳號」，一般使用者沒有（也不打帳號清單的端點）", async () => {
		// 「所有帳號」的行為在 accounts-admin.test.tsx；這裡只守「我的」有沒有把它放進來、只給管理員。
		mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/admin/users", handler: () => json([]) },
			{ method: "GET", path: "/api/me", handler: () => json(me("admin")) },
		]);
		const { unmount } = render(wrap(<Me onLoggedOut={vi.fn()} />));
		expect(
			await screen.findByRole("heading", { name: "所有帳號" }),
		).toBeInTheDocument();
		unmount();

		vi.restoreAllMocks();
		const spy = mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		// 先等帳號卡片載入完，「沒有」才有意義（第 41 種）。
		await screen.findByText("kenny@example.com");
		expect(
			screen.queryByRole("heading", { name: "所有帳號" }),
		).not.toBeInTheDocument();
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/admin/users")),
		).toBe(false);
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
		//
		// 第二次回應刻意用不同的名字（帳號設定規格 §7.2）：帳號卡片現在也顯示名字，
		// 同一個「Kenny」會撞成兩個元素（handover 第 38 種），而且分不出畫面上的名字
		// 是不是重新整理帶來的（第 52 種）。
		let calls = 0;
		const fetchMock = mockApi([
			statsRoute(),
			{
				method: "GET",
				path: "/api/me",
				handler: () => {
					calls += 1;
					return calls === 1
						? json(me("user"))
						: json({ ...me("user"), display_name: "重新整理後的名字" });
				},
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("kenny@example.com");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "重新整理" }));

		expect(await screen.findByText("重新整理後的名字")).toBeInTheDocument();
		expect(fetchMock.mock.calls.length).toBe(before + 1);
	});

	it("登出之後通知外層", async () => {
		const onLoggedOut = vi.fn();
		mockApi([
			statsRoute(),
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
			statsRoute(),
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

describe("我的：帳號卡片", () => {
	it("顯示名字與 email，有「修改密碼」連結", async () => {
		mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(await screen.findByText("Kenny")).toBeInTheDocument();
		expect(screen.getByText("kenny@example.com")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "修改密碼" })).toHaveAttribute(
			"href",
			"/me/password",
		);
	});

	it("修改名稱：只送 display_name，存好之後畫面換成新名字，焦點回到「修改名稱」", async () => {
		let current = me("user");
		const spy = mockApi([
			statsRoute(),
			{
				method: "PATCH",
				path: "/api/me",
				handler: () => {
					current = { ...current, display_name: "新名字" };
					return json(current);
				},
			},
			{ method: "GET", path: "/api/me", handler: () => json(current) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "修改名稱" }),
		);
		const input = screen.getByLabelText("顯示名稱");
		expect(input).toHaveFocus();
		expect(input).toHaveValue("Kenny");
		await userEvent.clear(input);
		await userEvent.type(input, "  新名字 ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("新名字")).toBeInTheDocument();
		const patch = spy.mock.calls.find(([, init]) => init?.method === "PATCH");
		expect(JSON.parse(String(patch?.[1]?.body))).toEqual({
			display_name: "新名字",
		});
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "修改名稱" })).toHaveFocus(),
		);
	});

	it("名稱是空白不送；取消不送、焦點回到「修改名稱」", async () => {
		const spy = mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "修改名稱" }),
		);
		await userEvent.clear(screen.getByLabelText("顯示名稱"));
		await userEvent.type(screen.getByLabelText("顯示名稱"), "   ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));
		expect(await screen.findByRole("alert")).toHaveTextContent(
			"名稱不能是空白",
		);
		// 等一下：mutate 是非同步送出的，立刻斷言「沒有 PATCH」在守衛壞掉時也會成立（第 41 種）。
		await new Promise((resolve) => setTimeout(resolve, 50));

		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(screen.getByRole("button", { name: "修改名稱" })).toHaveFocus();
		expect(spy.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(
			false,
		);
	});

	it("後端 422 顯示欄位訊息，表單留著", async () => {
		mockApi([
			statsRoute(),
			{
				method: "PATCH",
				path: "/api/me",
				handler: () =>
					json(
						{
							error: {
								code: "VALIDATION_ERROR",
								message: "輸入有誤",
								details: {
									errors: [
										{
											loc: ["body", "display_name"],
											msg: "名稱太長了",
											type: "string_too_long",
										},
									],
								},
							},
						},
						422,
					),
			},
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "修改名稱" }),
		);
		await userEvent.type(screen.getByLabelText("顯示名稱"), "很長");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("名稱太長了");
		expect(screen.getByLabelText("顯示名稱")).toBeInTheDocument();
	});

	it("其他錯誤：「儲存失敗，請再試一次」", async () => {
		mockApi([
			statsRoute(),
			{
				method: "PATCH",
				path: "/api/me",
				handler: () => new Response("boom", { status: 500 }),
			},
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "修改名稱" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"儲存失敗，請再試一次",
		);
	});
});

describe("我的：每日目標卡片", () => {
	it("顯示四個值，沒設的寫「未設定」，連到 /me/targets", async () => {
		mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		const card = await screen.findByTestId("targets-card");
		expect(
			within(card).getByRole("heading", { name: "每日目標" }),
		).toBeInTheDocument();
		expect(await within(card).findByText("1800 kcal")).toBeInTheDocument();
		expect(within(card).getByText("120 g")).toBeInTheDocument();
		expect(within(card).getAllByText("未設定")).toHaveLength(2);
		expect(
			within(card).getByRole("link", { name: "修改每日目標" }),
		).toHaveAttribute("href", "/me/targets");
	});

	it("今天沒有目標（target 是 null）：四格都是「未設定」", async () => {
		mockApi([
			statsRoute({ ...STATS, target: null, ratio: null }),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		const card = await screen.findByTestId("targets-card");
		await waitFor(() =>
			expect(within(card).getAllByText("未設定")).toHaveLength(4),
		);
	});

	it("讀不到統計：「無法載入目前的目標」", async () => {
		mockApi([
			statsRoute(
				{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
				500,
			),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		const card = await screen.findByTestId("targets-card");
		expect(
			await within(card).findByText("無法載入目前的目標"),
		).toBeInTheDocument();
		expect(within(card).queryByText("未設定")).not.toBeInTheDocument();
	});
});
