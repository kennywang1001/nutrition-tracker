import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { FriendsCard } from "../src/components/FriendsCard";
import { json, mockApi, type Route } from "./helpers/mock-api";

const REQUESTS = {
	incoming: [
		{
			id: 31,
			person: { id: 3, display_name: "卡蘿" },
			created_at: "2026-10-06T01:00:00Z",
		},
	],
	outgoing: [
		{
			id: 32,
			person: { id: 4, display_name: "戴夫" },
			created_at: "2026-10-06T02:00:00Z",
		},
	],
};
const FRIENDS = [
	{ id: 2, display_name: "鮑伯", since: "2026-10-01T00:00:00Z" },
];

/** `counts` 記 GET 的次數——「成功之後重新載入」要看到第二次 GET，
 *  不是看 invalidateQueries 有沒有被呼叫（第 50 種）。 */
function backend(extra: Route[] = []) {
	const counts = { requests: 0, friends: 0 };
	const spy = mockApi([
		...extra,
		{
			method: "GET",
			path: "/api/friends/me/code",
			handler: () => json({ code: "K7MX-Q2PD" }),
		},
		{
			method: "GET",
			path: "/api/friends/requests",
			handler: () => {
				counts.requests += 1;
				return json(REQUESTS);
			},
		},
		{
			method: "GET",
			path: "/api/friends",
			handler: () => {
				counts.friends += 1;
				return json(FRIENDS);
			},
		},
	]);
	return { spy, counts };
}

function sent(spy: ReturnType<typeof mockApi>, method: string, path: string) {
	return spy.mock.calls
		.filter(
			([url, init]) =>
				String(url).endsWith(path) &&
				(init?.method ?? "GET").toUpperCase() === method,
		)
		.map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : null));
}

function renderCard(
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<FriendsCard />
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("好友卡片", () => {
	it("顯示我的好友碼、收到與送出的邀請、好友名單；標題寫新邀請的數量", async () => {
		backend();
		renderCard();

		expect(await screen.findByTestId("friend-code")).toHaveTextContent(
			"K7MX-Q2PD",
		);
		expect(
			await screen.findByRole("heading", { name: "好友（1 個新邀請）" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "接受卡蘿的邀請" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "收回給戴夫的邀請" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "解除和鮑伯的好友" }),
		).toBeInTheDocument();
	});

	it("複製好友碼", async () => {
		const user = userEvent.setup();
		backend();
		renderCard();

		await user.click(await screen.findByRole("button", { name: "複製好友碼" }));

		expect(await screen.findByText("已複製")).toBeInTheDocument();
		expect(await navigator.clipboard.readText()).toBe("K7MX-Q2PD");
	});

	it("重設要先確認；確認之後換成新的碼", async () => {
		const { spy } = backend([
			{
				method: "POST",
				path: "/api/friends/me/code/reset",
				handler: () => json({ code: "ABCD-EFGH" }),
			},
		]);
		renderCard();

		await userEvent.click(
			await screen.findByRole("button", { name: "重設好友碼" }),
		);
		const dialog = screen.getByRole("alertdialog", { name: "確認重設好友碼" });
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(sent(spy, "POST", "/api/friends/me/code/reset")).toEqual([]);

		await userEvent.click(screen.getByRole("button", { name: "重設好友碼" }));
		await userEvent.click(screen.getByRole("button", { name: "確定重設" }));

		await waitFor(() =>
			expect(screen.getByTestId("friend-code")).toHaveTextContent("ABCD-EFGH"),
		);
	});

	it("送出邀請：送輸入的碼，成功之後清空並重新載入邀請", async () => {
		const { spy, counts } = backend([
			{
				method: "POST",
				path: "/api/friends/requests",
				handler: () =>
					json(
						{ status: "pending", person: { id: 5, display_name: "艾琳" } },
						201,
					),
			},
		]);
		renderCard();
		await screen.findByTestId("friend-code");

		await userEvent.type(screen.getByLabelText("朋友的好友碼"), "abcd-efgh");
		await userEvent.click(screen.getByRole("button", { name: "送出邀請" }));

		expect(
			await screen.findByText("已送出邀請給艾琳，等對方接受"),
		).toBeInTheDocument();
		expect(sent(spy, "POST", "/api/friends/requests")).toEqual([
			{ code: "abcd-efgh" },
		]);
		expect(screen.getByLabelText("朋友的好友碼")).toHaveValue("");
		await waitFor(() => expect(counts.requests).toBe(2));
	});

	it("對方先邀過我：直接成為好友", async () => {
		backend([
			{
				method: "POST",
				path: "/api/friends/requests",
				handler: () =>
					json({ status: "accepted", person: { id: 5, display_name: "艾琳" } }),
			},
		]);
		renderCard();
		await screen.findByTestId("friend-code");

		await userEvent.type(screen.getByLabelText("朋友的好友碼"), "ABCDEFGH");
		await userEvent.click(screen.getByRole("button", { name: "送出邀請" }));

		expect(await screen.findByText("你和艾琳已經是好友了")).toBeInTheDocument();
	});

	it("找不到的好友碼：顯示後端的訊息", async () => {
		backend([
			{
				method: "POST",
				path: "/api/friends/requests",
				handler: () =>
					json(
						{
							error: {
								code: "FRIEND_CODE_NOT_FOUND",
								message: "找不到這個好友碼",
								details: {},
							},
						},
						404,
					),
			},
		]);
		renderCard();
		await screen.findByTestId("friend-code");

		await userEvent.type(screen.getByLabelText("朋友的好友碼"), "ZZZZZZZZ");
		await userEvent.click(screen.getByRole("button", { name: "送出邀請" }));

		expect(await screen.findByText("找不到這個好友碼")).toBeInTheDocument();
	});

	it("接受與收回各打對的端點，之後重新載入邀請與名單", async () => {
		const { spy, counts } = backend([
			{
				method: "POST",
				path: "/api/friends/requests/31/accept",
				handler: () =>
					json({ id: 3, display_name: "卡蘿", since: "2026-10-07T00:00:00Z" }),
			},
			{
				method: "DELETE",
				path: "/api/friends/requests/32",
				handler: () => new Response(null, { status: 204 }),
			},
		]);
		renderCard();

		await userEvent.click(
			await screen.findByRole("button", { name: "接受卡蘿的邀請" }),
		);
		await userEvent.click(
			screen.getByRole("button", { name: "收回給戴夫的邀請" }),
		);

		await waitFor(() => {
			expect(sent(spy, "POST", "/api/friends/requests/31/accept")).toHaveLength(
				1,
			);
			expect(sent(spy, "DELETE", "/api/friends/requests/32")).toHaveLength(1);
		});
		await waitFor(() => expect(counts.requests).toBeGreaterThanOrEqual(2));
		await waitFor(() => expect(counts.friends).toBeGreaterThanOrEqual(2));
	});

	it("解除要先確認；確認之後移除這個好友的快取", async () => {
		const { spy } = backend([
			{
				method: "DELETE",
				path: "/api/friends/2",
				handler: () => new Response(null, { status: 204 }),
			},
		]);
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.friendFeed, { pages: [], pageParams: [] });
		client.setQueryData(queryKeys.friendDay(2, null), { meals: [] });
		client.setQueryData(queryKeys.friendPhoto(2, 7), new Blob());
		renderCard(client);

		await userEvent.click(
			await screen.findByRole("button", { name: "解除和鮑伯的好友" }),
		);
		const dialog = screen.getByRole("alertdialog", {
			name: "確認解除和鮑伯的好友",
		});
		expect(dialog).toHaveTextContent(
			"已經看過的照片可能還留在對方手機的快取裡",
		);
		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(sent(spy, "DELETE", "/api/friends/2")).toEqual([]);

		await userEvent.click(
			screen.getByRole("button", { name: "解除和鮑伯的好友" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "確定解除" }));

		await waitFor(() =>
			expect(sent(spy, "DELETE", "/api/friends/2")).toHaveLength(1),
		);
		await waitFor(() => {
			expect(client.getQueryData(queryKeys.friendFeed)).toBeUndefined();
			expect(client.getQueryData(queryKeys.friendDay(2, null))).toBeUndefined();
			expect(client.getQueryData(queryKeys.friendPhoto(2, 7))).toBeUndefined();
		});
	});
});
