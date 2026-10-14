import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Me } from "../src/screens/Me";
import { bodyRoutes } from "./helpers/body-routes";
import { json, mockApi, type Route } from "./helpers/mock-api";

const NAME = "運動消耗加回今天的熱量額度";

/** 舊快取的形狀：沒有 `exercise_adds_to_budget`。 */
const OLD_ME = {
	id: 1,
	email: "kenny@example.com",
	display_name: "Kenny",
	role: "user",
	timezone: "Asia/Taipei",
};

const ZERO = { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" };
const STATS = {
	date: "2026-10-14",
	actual: ZERO,
	target: { kcal: "2000.00", protein_g: null, fat_g: null, carb_g: null },
	ratio: { kcal: "0.00", protein_g: null, fat_g: null, carb_g: null },
	breakdown: { food: ZERO, supplement: ZERO },
	exercise_kcal: "0.00",
	exercise_adds_to_budget: true,
	kcal_budget: "2000.00",
};

/** 「我的」：`bodyRoutes()` 一定在最前面（`/api/me` 會吃掉 `/api/me/body-profile`）。 */
function routes(me: unknown, extra: Route[] = []): Route[] {
	return [
		...bodyRoutes(),
		...extra,
		{ method: "GET", path: "/api/stats/daily", handler: () => json(STATS) },
		{ method: "GET", path: "/api/me", handler: () => json(me) },
	];
}

function calls(
	fetchMock: ReturnType<typeof mockApi>,
	method: string,
	path: string,
) {
	return fetchMock.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === method &&
			String(input).endsWith(path),
	);
}

function renderMe() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter>
				<Me />
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

describe("運動消耗加回今天的熱量額度（運動規格 §7.6）", () => {
	it.each([
		["開著", { ...OLD_ME, exercise_adds_to_budget: true }, true],
		["關著", { ...OLD_ME, exercise_adds_to_budget: false }, false],
		["舊快取沒有這個欄位 → 開著", OLD_ME, true],
	])("%s", async (_name, me, on) => {
		mockApi(routes(me));
		renderMe();

		const card = await screen.findByTestId("targets-card");
		const toggle = await within(card).findByRole("switch", { name: NAME });
		if (on) expect(toggle).toBeChecked();
		else expect(toggle).not.toBeChecked();
	});

	it("點一下：PATCH 只送這一個鍵；回來之後關著；今天的統計重抓", async () => {
		const fetchMock = mockApi(
			routes({ ...OLD_ME, exercise_adds_to_budget: true }, [
				{
					method: "PATCH",
					path: "/api/me",
					handler: () => json({ ...OLD_ME, exercise_adds_to_budget: false }),
				},
			]),
		);
		renderMe();

		const toggle = await screen.findByRole("switch", { name: NAME });
		await waitFor(() =>
			expect(calls(fetchMock, "GET", "/api/stats/daily")).toHaveLength(1),
		);
		await userEvent.click(toggle);

		await waitFor(() => expect(toggle).not.toBeChecked());
		const patches = calls(fetchMock, "PATCH", "/api/me");
		expect(patches.map(([, init]) => init?.body)).toEqual([
			'{"exercise_adds_to_budget":false}',
		]);
		// 分母變了：今天的統計要重抓（總覽、飲食頁、這張卡片都讀它）。
		await waitFor(() =>
			expect(calls(fetchMock, "GET", "/api/stats/daily")).toHaveLength(2),
		);
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});

	it("送出中：是 aria-disabled、顯示要變成的值；再點不多送", async () => {
		let release: (response: Response) => void = () => {};
		const fetchMock = mockApi(
			routes({ ...OLD_ME, exercise_adds_to_budget: true }, [
				{
					method: "PATCH",
					path: "/api/me",
					handler: () =>
						new Promise<Response>((resolve) => {
							release = resolve;
						}),
				},
			]),
		);
		renderMe();

		const toggle = await screen.findByRole("switch", { name: NAME });
		await userEvent.click(toggle);
		await waitFor(() =>
			expect(toggle).toHaveAttribute("aria-disabled", "true"),
		);
		expect(toggle).not.toBeChecked();
		await userEvent.click(toggle);
		expect(toggle).not.toBeChecked();
		expect(calls(fetchMock, "PATCH", "/api/me")).toHaveLength(1);

		release(json({ ...OLD_ME, exercise_adds_to_budget: false }));
		await waitFor(() =>
			expect(toggle).toHaveAttribute("aria-disabled", "false"),
		);
		expect(toggle).not.toBeChecked();
		expect(calls(fetchMock, "PATCH", "/api/me")).toHaveLength(1);
	});

	it("失敗：說沒有存到，開關回到原值；再點一次成功就把錯誤收掉", async () => {
		let fail = true;
		mockApi(
			routes({ ...OLD_ME, exercise_adds_to_budget: true }, [
				{
					method: "PATCH",
					path: "/api/me",
					handler: () =>
						fail
							? json(
									{
										error: {
											code: "INTERNAL_ERROR",
											message: "壞了",
											details: {},
										},
									},
									500,
								)
							: json({ ...OLD_ME, exercise_adds_to_budget: false }),
				},
			]),
		);
		renderMe();

		const toggle = await screen.findByRole("switch", { name: NAME });
		await userEvent.click(toggle);

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"沒有存到，請再試一次",
		);
		expect(toggle).toBeChecked();

		fail = false;
		await userEvent.click(toggle);
		await waitFor(() => expect(toggle).not.toBeChecked());
		expect(screen.queryByRole("alert")).not.toBeInTheDocument();
	});
});
