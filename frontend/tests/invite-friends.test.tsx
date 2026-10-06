import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Me } from "../src/screens/Me";
import { json, mockApi, type Route } from "./helpers/mock-api";

function me(role: "user" | "admin") {
	return {
		id: 1,
		email: "kenny@example.com",
		display_name: "Kenny",
		role,
		timezone: "Asia/Taipei",
	};
}

const PENDING = {
	id: 7,
	note: "給阿華",
	status: "pending",
	created_at: "2026-10-06T01:00:00Z",
	expires_at: "2026-10-13T01:00:00Z",
	used_at: null,
	used_by: null,
};
const USED = {
	id: 6,
	note: "給小明",
	status: "used",
	created_at: "2026-10-05T01:00:00Z",
	expires_at: "2026-10-12T01:00:00Z",
	used_at: "2026-10-05T03:00:00Z",
	used_by: { display_name: "小明", email: "ming@example.com" },
};
const CREATED = {
	id: 8,
	token: "tok-abc",
	note: "給小華",
	expires_at: "2026-10-13T02:00:00Z",
};

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

/** 管理員的後端。`counts` 記每個端點被打了幾次——「成功之後清單重新載入」
 *  要看到第二次 GET，不是看 invalidateQueries 有沒有被呼叫（第 50 種）。 */
function adminBackend(extra: Route[] = []) {
	const counts = { list: 0 };
	const spy = mockApi([
		...extra,
		{
			method: "GET",
			path: "/api/admin/invites",
			handler: () => {
				counts.list += 1;
				return json([PENDING, USED]);
			},
		},
		{ method: "GET", path: "/api/me", handler: () => json(me("admin")) },
	]);
	return { spy, counts };
}

function sentBodies(spy: ReturnType<typeof mockApi>, method: string) {
	return spy.mock.calls
		.filter(
			([url, init]) =>
				String(url).includes("/api/admin/invites") &&
				(init?.method ?? "GET").toUpperCase() === method,
		)
		.map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("邀請朋友", () => {
	it("一般使用者看不到，也不打邀請的端點", async () => {
		const spy = mockApi([
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		// 先證明畫面載入完了（第 41 種），再斷言「沒有」。
		expect(await screen.findByText("kenny@example.com")).toBeInTheDocument();
		expect(
			screen.queryByRole("heading", { name: "邀請朋友" }),
		).not.toBeInTheDocument();
		expect(
			spy.mock.calls.some(([url]) =>
				String(url).includes("/api/admin/invites"),
			),
		).toBe(false);
	});

	it("管理員看到還沒用的與已經用掉的邀請", async () => {
		adminBackend();

		render(wrap(<Me onLoggedOut={vi.fn()} />));

		expect(
			await screen.findByRole("heading", { name: "邀請朋友" }),
		).toBeInTheDocument();
		expect(await screen.findByText("給阿華")).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "撤銷給阿華" }),
		).toBeInTheDocument();
		expect(screen.getByText("小明（ming@example.com）")).toBeInTheDocument();
		// 用掉的不能撤銷。
		expect(
			screen.queryByRole("button", { name: "撤銷給小明" }),
		).not.toBeInTheDocument();
	});

	it("產生邀請連結：送備註、顯示整條連結與「只會顯示這一次」、清單重新載入", async () => {
		const { spy, counts } = adminBackend([
			{
				method: "POST",
				path: "/api/admin/invites",
				handler: () => json(CREATED, 201),
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("給阿華");

		await userEvent.type(screen.getByLabelText("給誰？（選填）"), "  給小華 ");
		await userEvent.click(screen.getByRole("button", { name: "產生邀請連結" }));

		expect(await screen.findByLabelText("邀請連結")).toHaveValue(
			`${window.location.origin}/join#tok-abc`,
		);
		expect(screen.getByText(/這個連結只會顯示這一次/)).toBeInTheDocument();
		expect(sentBodies(spy, "POST")).toEqual([{ note: "給小華" }]);
		await waitFor(() => expect(counts.list).toBe(2));
		expect(screen.getByLabelText("給誰？（選填）")).toHaveValue("");
	});

	it("備註留空時不送 note", async () => {
		const { spy } = adminBackend([
			{
				method: "POST",
				path: "/api/admin/invites",
				handler: () => json({ ...CREATED, note: null }, 201),
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("給阿華");

		await userEvent.click(screen.getByRole("button", { name: "產生邀請連結" }));

		await screen.findByLabelText("邀請連結");
		expect(sentBodies(spy, "POST")).toEqual([{}]);
	});

	it("複製：連結寫進剪貼簿、顯示「已複製」", async () => {
		const user = userEvent.setup();
		adminBackend([
			{
				method: "POST",
				path: "/api/admin/invites",
				handler: () => json(CREATED, 201),
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));
		await screen.findByText("給阿華");

		await user.click(screen.getByRole("button", { name: "產生邀請連結" }));
		await user.click(await screen.findByRole("button", { name: "複製" }));

		expect(await screen.findByText("已複製")).toBeInTheDocument();
		expect(await navigator.clipboard.readText()).toBe(
			`${window.location.origin}/join#tok-abc`,
		);
	});

	it("撤銷要先確認；取消不送", async () => {
		let deletes = 0;
		const { counts } = adminBackend([
			{
				method: "DELETE",
				path: "/api/admin/invites/7",
				handler: () => {
					deletes += 1;
					return new Response(null, { status: 204 });
				},
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "撤銷給阿華" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認撤銷給阿華" });
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(deletes).toBe(0);

		await userEvent.click(screen.getByRole("button", { name: "撤銷給阿華" }));
		await userEvent.click(
			within(screen.getByRole("alertdialog")).getByRole("button", {
				name: "確定撤銷",
			}),
		);

		await waitFor(() => expect(deletes).toBe(1));
		await waitFor(() => expect(counts.list).toBe(2));
	});

	it("撤銷時已經被用掉：顯示後端訊息並重新載入清單", async () => {
		const { counts } = adminBackend([
			{
				method: "DELETE",
				path: "/api/admin/invites/7",
				handler: () =>
					json(
						{
							error: {
								code: "INVITE_USED",
								message: "這個邀請已經有人用過了，不能撤銷",
								details: {},
							},
						},
						409,
					),
			},
		]);
		render(wrap(<Me onLoggedOut={vi.fn()} />));

		await userEvent.click(
			await screen.findByRole("button", { name: "撤銷給阿華" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確定撤銷" }));

		expect(
			await screen.findByText("這個邀請已經有人用過了，不能撤銷"),
		).toBeInTheDocument();
		await waitFor(() => expect(counts.list).toBe(2));
	});

	it("每次打開都重抓清單，即使快取裡的還算新鮮", async () => {
		// app 的 queryClient 預設 staleTime 60 秒、快取還會持久化：不覆寫的話，
		// 朋友剛用掉邀請、管理員一分鐘內重新整理「我的」，看到的是舊清單
		// （第 17 種的同一個機制，e2e 抓到的）。「誰用掉了」正是回來看的理由。
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
		});
		client.setQueryData(queryKeys.invites, [PENDING]);
		const { counts } = adminBackend();

		render(
			<QueryClientProvider client={client}>
				<MemoryRouter>
					<Me onLoggedOut={vi.fn()} />
				</MemoryRouter>
			</QueryClientProvider>,
		);

		expect(
			await screen.findByText("小明（ming@example.com）"),
		).toBeInTheDocument();
		expect(counts.list).toBe(1);
	});
});
