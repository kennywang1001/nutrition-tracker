import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import {
	clearTokens,
	getRefreshToken,
	onLoggedOut,
	setTokens,
} from "../src/auth/store";
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

		render(wrap(<Me />));

		expect(await screen.findByText("kenny@example.com")).toBeInTheDocument();
	});

	it("管理員看得到「審核」入口", async () => {
		// 從 tab bar 的第五格搬過來（介面改版）。前端藏起連結只是可用性，
		// 真正的授權在後端 require_admin。
		mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("admin")) },
		]);

		render(wrap(<Me />));

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

		render(wrap(<Me />));

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
		const { unmount } = render(wrap(<Me />));
		expect(
			await screen.findByRole("heading", { name: "所有帳號" }),
		).toBeInTheDocument();
		unmount();

		vi.restoreAllMocks();
		const spy = mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<Me />));
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

		render(wrap(<Me />));

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
		render(wrap(<Me />));
		await screen.findByText("kenny@example.com");
		const before = fetchMock.mock.calls.length;

		await userEvent.click(screen.getByRole("button", { name: "重新整理" }));

		expect(await screen.findByText("重新整理後的名字")).toBeInTheDocument();
		expect(fetchMock.mock.calls.length).toBe(before + 1);
	});

	it("登出：清掉這台的票，並透過 store 通知外層（不是強制登出）", async () => {
		// 外層（App）訂閱 auth/store 的 onLoggedOut 來切回登入畫面——「我的」不再自己
		// 收一個 callback：登出只有一條通知的路，主動登出與換票被拒走同一條。
		const listener = vi.fn();
		const unsubscribe = onLoggedOut(listener);
		mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
			{
				method: "POST",
				path: "/api/auth/logout",
				handler: () => new Response(null, { status: 204 }),
			},
		]);
		render(wrap(<Me />));

		await userEvent.click(screen.getByRole("button", { name: "登出" }));

		await waitFor(() => expect(listener).toHaveBeenCalledTimes(1));
		expect(listener).toHaveBeenCalledWith({ forced: false });
		expect(getRefreshToken()).toBeNull();
		unsubscribe();
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
		render(wrap(<Me />));
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

		render(wrap(<Me />));

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
		render(wrap(<Me />));

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
		render(wrap(<Me />));

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
		render(wrap(<Me />));

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
		render(wrap(<Me />));

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
		render(wrap(<Me />));

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
		render(wrap(<Me />));

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
		render(wrap(<Me />));

		const card = await screen.findByTestId("targets-card");
		expect(
			await within(card).findByText("無法載入目前的目標"),
		).toBeInTheDocument();
		expect(within(card).queryByText("未設定")).not.toBeInTheDocument();
	});
});

describe("我的：匯出資料", () => {
	it("每個人都有「匯出資料」卡片，在登出之前；畫出來的時候不打任何匯出端點", async () => {
		// 卡片自己的行為在 export-card.test.tsx；這裡只守「我的」有沒有把它放進來。
		const fetchMock = mockApi([
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me />));

		await screen.findByText("kenny@example.com");
		const card = screen.getByTestId("export-card");
		expect(
			within(card).getByRole("heading", { name: "匯出資料" }),
		).toBeInTheDocument();
		expect(
			within(card)
				.getAllByRole("button")
				.map((button) => button.textContent),
		).toEqual(["餐點", "花費", "補劑"]);
		const logout = screen.getByRole("button", { name: "登出" });
		expect(
			card.compareDocumentPosition(logout) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			fetchMock.mock.calls
				.map(([input]) => String(input))
				.filter((url) => url.includes("/api/export")),
		).toEqual([]);
	});
});

describe("我的：通知卡片（社群規格 §6.4）", () => {
	function unreadRoute(handler: () => Response) {
		return {
			method: "GET",
			path: "/api/notifications/unread-count",
			handler,
		};
	}

	it("有新通知：寫幾則，「看通知」連到通知頁；是「我的」裡的第一張卡片", async () => {
		mockApi([
			unreadRoute(() => json({ count: 3 })),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me />));

		const card = screen.getByTestId("notifications-card");
		expect(await within(card).findByText("3 則新通知")).toBeInTheDocument();
		expect(
			within(card).getByRole("heading", { level: 2, name: "通知" }),
		).toBeInTheDocument();
		// 數字不在連結的名稱裡：名稱固定。
		expect(within(card).getByRole("link", { name: "看通知" })).toHaveAttribute(
			"href",
			"/notifications",
		);
		// 最上面：緊接在標題後面，帳號卡片之前。
		expect(
			screen.getByRole("heading", { level: 1, name: "我的" })
				.nextElementSibling,
		).toBe(card);
		const account = await screen.findByText("kenny@example.com");
		expect(
			card.compareDocumentPosition(account) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
	});

	it("沒有新通知：「沒有新通知」，連結照樣在", async () => {
		let answered = false;
		mockApi([
			unreadRoute(() => {
				answered = true;
				return json({ count: 0 });
			}),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me />));

		const card = screen.getByTestId("notifications-card");
		// 先等未讀數真的回來：一開始（還沒回來）畫的也是「沒有新通知」。
		await waitFor(() => expect(answered).toBe(true));
		await screen.findByText("kenny@example.com");
		expect(within(card).getByText("沒有新通知")).toBeInTheDocument();
		expect(within(card).queryByText(/則新通知/)).not.toBeInTheDocument();
		expect(within(card).getByRole("link", { name: "看通知" })).toHaveAttribute(
			"href",
			"/notifications",
		);
	});

	it("未讀數抓不到（斷線）：當成沒有新通知，不顯示錯誤", async () => {
		let answered = false;
		mockApi([
			unreadRoute(() => {
				answered = true;
				return json({ error: { code: "X", message: "x", details: {} } }, 500);
			}),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me />));

		await waitFor(() => expect(answered).toBe(true));
		await screen.findByText("kenny@example.com");
		const card = screen.getByTestId("notifications-card");
		expect(within(card).getByText("沒有新通知")).toBeInTheDocument();
		expect(within(card).queryByRole("alert")).not.toBeInTheDocument();
	});
});
