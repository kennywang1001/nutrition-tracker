import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Exercise } from "../src/api/exercises";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { EditExercise } from "../src/screens/EditExercise";
import { exerciseRoutes, RUN } from "./helpers/exercise-routes";
import { json, type Route as MockRoute, mockApi } from "./helpers/mock-api";

const MANUAL: Exercise = {
	...RUN,
	kcal: "250.00",
	kcal_source: "manual",
	note: "河濱",
};

/** 單筆的路由排在 `exerciseRoutes()` 前面：`/api/exercises` 會吃掉 `/api/exercises/31`。 */
function routes(exercise: unknown = RUN, extra: MockRoute[] = []): MockRoute[] {
	return [
		...extra,
		{ method: "GET", path: "/api/exercises/31", handler: () => json(exercise) },
		{
			method: "PATCH",
			path: "/api/exercises/31",
			handler: () => json(exercise),
		},
		{
			method: "DELETE",
			path: "/api/exercises/31",
			handler: () => new Response(null, { status: 204 }),
		},
		{
			method: "GET",
			path: "/api/exercise/estimate",
			handler: () =>
				json({
					ready: true,
					kcal: "343",
					met: "9.8",
					weight_kg: "70.00",
					weight_date: "2026-10-14",
				}),
		},
		...exerciseRoutes(),
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

function patchedBody(fetchMock: ReturnType<typeof mockApi>): unknown {
	const call = calls(fetchMock, "PATCH", "/api/exercises/31")[0];
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function renderEdit(
	path = "/exercises/31/edit",
	client = new QueryClient({ defaultOptions: { queries: { retry: false } } }),
) {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/", path]} initialIndex={1}>
				<Routes>
					<Route path="/" element={<p>總覽頁</p>} />
					<Route path="/exercises/:id/edit" element={<EditExercise />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

/** 預填好了（分鐘欄有值）才動作。 */
async function prefilled() {
	await waitFor(() => expect(screen.getByLabelText("分鐘")).toHaveValue("30"));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
	// RUN 是台北 18:30：「現在」要在那之後，不然存的時候是「未來的時間」。
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-14T20:00:00"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("編輯運動", () => {
	it("預填估算的那一筆：手動輸入熱量沒勾、時間是裝置時區", async () => {
		mockApi(routes());
		renderEdit();

		expect(
			screen.getByRole("heading", { name: "編輯運動", level: 1 }),
		).toBeInTheDocument();
		await prefilled();
		await waitFor(() =>
			expect(screen.getByLabelText("活動")).toHaveValue("running"),
		);
		expect(screen.getByLabelText("日期")).toHaveValue("2026-10-14");
		expect(screen.getByLabelText("時間")).toHaveValue("18:30");
		expect(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		).not.toBeChecked();
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
	});

	it("快取裡有舊的那一筆：預填等掛載之後抓回來的，不用快取的", async () => {
		// 儲存送的是完整的一組：拿舊值預填，沒動的欄位會被改回去（另一台裝置改成 30 分鐘）。
		mockApi(routes());
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		client.setQueryData(queryKeys.exercise(31), { ...RUN, minutes: 20 });
		renderEdit("/exercises/31/edit", client);

		await prefilled();
	});

	it("預填手動的那一筆：手動輸入熱量勾著、熱量去掉尾數的 0、備註", async () => {
		mockApi(routes(MANUAL));
		renderEdit();

		await prefilled();
		expect(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		).toBeChecked();
		expect(screen.getByLabelText("熱量（kcal）")).toHaveValue("250");
		expect(screen.getByLabelText("備註（選填）")).toHaveValue("河濱");
	});

	it("只改分鐘：PATCH 送完整的一組，kcal: null（改回估算）；存好回總覽", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEdit();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await prefilled();
		const minutes = screen.getByLabelText("分鐘");
		await userEvent.clear(minutes);
		await userEvent.type(minutes, "60");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(patchedBody(fetchMock)).toEqual({
			activity: "running",
			name: null,
			minutes: 60,
			performed_at: "2026-10-14T10:30:00.000Z",
			note: null,
			kcal: null,
		});
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toEqual(
			expect.arrayContaining([queryKeys.exercisesAll, queryKeys.dailyStats]),
		);
	});

	it("把手動的那一筆改回估算：取消勾選，送 kcal: null", async () => {
		const fetchMock = mockApi(routes(MANUAL));
		renderEdit();

		await prefilled();
		await userEvent.click(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(patchedBody(fetchMock)).toMatchObject({ kcal: null, note: "河濱" });
	});

	it('勾手動、填 400：送 kcal: "400"', async () => {
		const fetchMock = mockApi(routes());
		renderEdit();

		await prefilled();
		await userEvent.click(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		);
		await userEvent.type(screen.getByLabelText("熱量（kcal）"), "400");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(patchedBody(fetchMock)).toMatchObject({ kcal: "400", minutes: 30 });
	});

	it("刪除要按兩次：第一次只開確認框，焦點在取消；取消不送", async () => {
		const fetchMock = mockApi(routes());
		renderEdit();

		await prefilled();
		await userEvent.click(screen.getByRole("button", { name: "刪除這筆運動" }));
		const dialog = screen.getByRole("alertdialog", { name: "刪除這筆運動？" });
		const cancel = within(dialog).getByRole("button", { name: "取消" });
		expect(cancel).toHaveFocus();
		expect(calls(fetchMock, "DELETE", "/api/exercises/31")).toHaveLength(0);

		await userEvent.click(cancel);
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "刪除這筆運動" })).toHaveFocus();
		expect(calls(fetchMock, "DELETE", "/api/exercises/31")).toHaveLength(0);
	});

	it("確定刪除：DELETE、移除這一筆的快取、失效、回總覽；之後不再抓這一筆", async () => {
		const fetchMock = mockApi(routes());
		const client = renderEdit();
		const remove = vi.spyOn(client, "removeQueries");
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await prefilled();
		await userEvent.click(screen.getByRole("button", { name: "刪除這筆運動" }));
		const dialog = screen.getByRole("alertdialog", { name: "刪除這筆運動？" });
		await userEvent.click(within(dialog).getByRole("button", { name: "刪除" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(calls(fetchMock, "DELETE", "/api/exercises/31")).toHaveLength(1);
		expect(remove.mock.calls.map((call) => call[0]?.queryKey)).toContainEqual(
			queryKeys.exercise(31),
		);
		expect(invalidate.mock.calls.map((call) => call[0]?.queryKey)).toEqual(
			expect.arrayContaining([queryKeys.exercisesAll, queryKeys.dailyStats]),
		);
		// 刪掉之後沒有人再去抓這一筆（會是一個 404）。
		expect(calls(fetchMock, "GET", "/api/exercises/31")).toHaveLength(1);
	});

	it("確定刪除送出中：刪除是 aria-disabled，再按不多送", async () => {
		let release: (response: Response) => void = () => {};
		const fetchMock = mockApi(
			routes(RUN, [
				{
					method: "DELETE",
					path: "/api/exercises/31",
					handler: () =>
						new Promise<Response>((resolve) => {
							release = resolve;
						}),
				},
			]),
		);
		renderEdit();

		await prefilled();
		await userEvent.click(screen.getByRole("button", { name: "刪除這筆運動" }));
		const dialog = screen.getByRole("alertdialog", { name: "刪除這筆運動？" });
		const confirm = within(dialog).getByRole("button", { name: "刪除" });
		await userEvent.click(confirm);
		await waitFor(() =>
			expect(confirm).toHaveAttribute("aria-disabled", "true"),
		);
		await userEvent.click(confirm);
		expect(calls(fetchMock, "DELETE", "/api/exercises/31")).toHaveLength(1);

		release(new Response(null, { status: 204 }));
		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
	});

	it("404：找不到這筆運動，有連結回總覽", async () => {
		mockApi([
			{
				method: "GET",
				path: "/api/exercises/31",
				handler: () =>
					json(
						{
							error: {
								code: "EXERCISE_NOT_FOUND",
								message: "找不到這筆運動",
								details: {},
							},
						},
						404,
					),
			},
			...exerciseRoutes(),
		]);
		renderEdit();

		expect(await screen.findByText("找不到這筆運動")).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "回總覽" })).toHaveAttribute(
			"href",
			"/",
		);
	});

	it("網址不是 id（/exercises/abc/edit）：不發請求，直接找不到", async () => {
		const fetchMock = mockApi(exerciseRoutes());
		renderEdit("/exercises/abc/edit");

		expect(await screen.findByText("找不到這筆運動")).toBeInTheDocument();
		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).includes("/api/exercises/"),
			),
		).toHaveLength(0);
	});
});
