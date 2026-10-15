import {
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import {
	act,
	fireEvent,
	render,
	screen,
	waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { LogExercise } from "../src/screens/LogExercise";
import { ACTIVITY_LIST, RUN } from "./helpers/exercise-routes";
import { json, type Route as MockRoute, mockApi } from "./helpers/mock-api";

const READY = {
	ready: true,
	kcal: "343",
	met: "9.8",
	weight_kg: "70.00",
	weight_date: "2026-10-14",
};
const NO_WEIGHT = { ready: false, missing: "weight" };

function error(code: string, message: string, status = 422) {
	return json({ error: { code, message, details: {} } }, status);
}

/** `extra` 排在前面（`url.includes` 依序比對）。預覽預設回 343。 */
function routes(
	extra: MockRoute[] = [],
	estimate: () => Response = () => json(READY),
) {
	return [
		...extra,
		{
			method: "GET",
			path: "/api/exercise/activities",
			handler: () => json(ACTIVITY_LIST),
		},
		{ method: "GET", path: "/api/exercise/estimate", handler: estimate },
		{ method: "POST", path: "/api/exercises", handler: () => json(RUN, 201) },
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
			String(input).includes(path),
	);
}

function postedBody(fetchMock: ReturnType<typeof mockApi>): unknown {
	const call = calls(fetchMock, "POST", "/api/exercises")[0];
	return call === undefined ? undefined : JSON.parse(String(call[1]?.body));
}

function renderForm() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/", "/exercises/new"]} initialIndex={1}>
				<Routes>
					<Route path="/" element={<p>總覽頁</p>} />
					<Route path="/weight" element={<p>體重頁</p>} />
					<Route path="/exercises/new" element={<LogExercise />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

/** 活動清單回來了才算表單好了（選單在那之前是停用的）。 */
async function choose(activity: string) {
	const select = screen.getByLabelText("活動");
	await waitFor(() => expect(select).toBeEnabled());
	await userEvent.selectOptions(select, activity);
}

async function typeMinutes(minutes: string) {
	const field = screen.getByLabelText("分鐘");
	await userEvent.clear(field);
	await userEvent.type(field, minutes);
}

const NOON_UTC = "2026-10-14T04%3A00%3A00.000Z";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
	// 只假 Date：debounce 與 TanStack 的計時器要照常走。
	vi.useFakeTimers({ toFake: ["Date"] });
	vi.setSystemTime(new Date("2026-10-14T12:00:00"));
});

afterEach(() => {
	vi.useRealTimers();
});

describe("記運動：表單", () => {
	it("活動選單來自後端的清單；日期與時間預設是現在，日期最多到今天", async () => {
		mockApi(routes());
		renderForm();

		expect(
			screen.getByRole("heading", { name: "記運動", level: 1 }),
		).toBeInTheDocument();
		expect(
			await screen.findByRole("option", { name: "走路" }),
		).toBeInTheDocument();
		expect(
			screen.getByRole("option", { name: "跑步（約 10 km/h）" }),
		).toBeInTheDocument();
		expect(screen.getByRole("option", { name: "其他" })).toBeInTheDocument();
		expect(screen.getByLabelText("日期")).toHaveValue("2026-10-14");
		expect(screen.getByLabelText("日期")).toHaveAttribute("max", "2026-10-14");
		expect(screen.getByLabelText("時間")).toHaveValue("12:00");
	});

	it("跑步 30 分鐘：分鐘停下來之後才估算，只問一次", async () => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("running");
		await typeMinutes("30");

		expect(
			await screen.findByText("約 343 kcal（依 10/14 的體重 70 公斤）"),
		).toBeInTheDocument();
		expect(
			calls(fetchMock, "GET", "/api/exercise/estimate").map(([url]) =>
				String(url),
			),
		).toEqual([
			`/api/exercise/estimate?activity=running&minutes=30&performed_at=${NOON_UTC}`,
		]);
	});

	it("沒有體重記住到下一個答案：改分鐘時熱量欄不會消失；換到有體重的答案才解鎖", async () => {
		// 30 分鐘那天沒有體重、45 分鐘有（測試裡用分鐘代替「改了日期」）。
		// `mockApi` 的 handler 看不到網址：這一條要依分鐘回不同的答案，直接接 fetch。
		vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
			const url = String(input);
			if (url.includes("/api/exercise/estimate"))
				return url.includes("minutes=45") ? json(READY) : json(NO_WEIGHT);
			if (url.includes("/api/exercise/activities")) return json(ACTIVITY_LIST);
			throw new Error(`沒有準備：${init?.method ?? "GET"} ${url}`);
		});
		renderForm();

		await choose("running");
		await typeMinutes("30");
		await screen.findByText("先記一次體重，就能自動估算");

		// 改分鐘：debounce 期間沒有答案，熱量欄仍然在、仍然鎖著。
		await typeMinutes("45");
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		).toHaveAttribute("aria-disabled", "true");

		// 45 分鐘的答案回來（有體重）：解鎖、回到預覽。
		expect(
			await screen.findByText("約 343 kcal（依 10/14 的體重 70 公斤）"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		).not.toBeChecked();
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
	});

	it("沒有體重：說明、連到記錄體重、手動輸入熱量勾起來而且鎖住、熱量欄出現", async () => {
		mockApi(routes([], () => json(NO_WEIGHT)));
		renderForm();

		await choose("running");
		await typeMinutes("30");

		expect(
			await screen.findByText("先記一次體重，就能自動估算"),
		).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "記錄體重" })).toHaveAttribute(
			"href",
			"/weight",
		);
		const manual = screen.getByRole("checkbox", { name: "手動輸入熱量" });
		expect(manual).toBeChecked();
		expect(manual).toHaveAttribute("aria-disabled", "true");
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();

		await userEvent.click(manual);
		expect(manual).toBeChecked();
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
	});

	it("其他：多一格名稱、熱量一定手動，不問估算", async () => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("other");
		await typeMinutes("30");

		expect(screen.getByLabelText("名稱")).toBeInTheDocument();
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
		expect(
			screen.queryByRole("checkbox", { name: "手動輸入熱量" }),
		).not.toBeInTheDocument();
		// 等過 debounce 的時間：真的沒有問。
		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(calls(fetchMock, "GET", "/api/exercise/estimate")).toHaveLength(0);
	});

	it("送出估算的：body 沒有 kcal 這個鍵；存好失效運動與統計、回總覽", async () => {
		const fetchMock = mockApi(routes());
		const client = renderForm();
		const invalidate = vi.spyOn(client, "invalidateQueries");

		await choose("running");
		await typeMinutes("30");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		const body = postedBody(fetchMock);
		expect(body).toEqual({
			activity: "running",
			name: null,
			minutes: 30,
			performed_at: "2026-10-14T04:00:00.000Z",
			note: null,
		});
		expect(body).not.toHaveProperty("kcal");
		const keys = invalidate.mock.calls.map((call) => call[0]?.queryKey);
		expect(keys).toEqual(
			expect.arrayContaining([queryKeys.exercisesAll, queryKeys.dailyStats]),
		);
	});

	it("送出手動的：body 帶熱量的字串；備註去掉前後空白", async () => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("running");
		await typeMinutes("30");
		await userEvent.click(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		);
		await userEvent.type(screen.getByLabelText("熱量（kcal）"), "250");
		await userEvent.type(screen.getByLabelText("備註（選填）"), "  河濱  ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(postedBody(fetchMock)).toEqual({
			activity: "running",
			name: null,
			minutes: 30,
			performed_at: "2026-10-14T04:00:00.000Z",
			note: "河濱",
			kcal: "250",
		});
	});

	it("送出其他：名稱去掉空白、熱量手動", async () => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("other");
		await userEvent.type(screen.getByLabelText("名稱"), " 拳擊 ");
		await typeMinutes("45");
		await userEvent.type(screen.getByLabelText("熱量（kcal）"), "400.5");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(postedBody(fetchMock)).toEqual({
			activity: "other",
			name: "拳擊",
			minutes: 45,
			performed_at: "2026-10-14T04:00:00.000Z",
			note: null,
			kcal: "400.5",
		});
	});

	it.each(["", "0", "601", "1.5"])(
		"分鐘 %j：不送，說分鐘要是 1 到 600 的整數",
		async (minutes) => {
			const fetchMock = mockApi(routes());
			renderForm();

			await choose("running");
			if (minutes !== "") await typeMinutes(minutes);
			await userEvent.click(screen.getByRole("button", { name: "儲存" }));

			expect(await screen.findByRole("alert")).toHaveTextContent(
				"分鐘要是 1 到 600 的整數",
			);
			expect(calls(fetchMock, "POST", "/api/exercises")).toHaveLength(0);
		},
	);

	it.each(["0", "5000.001"])("手動熱量 %j：不送", async (kcal) => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("running");
		await typeMinutes("30");
		await userEvent.click(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		);
		await userEvent.type(screen.getByLabelText("熱量（kcal）"), kcal);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"熱量要在 1 到 5000 之間，最多兩位小數",
		);
		expect(calls(fetchMock, "POST", "/api/exercises")).toHaveLength(0);
	});

	it("其他沒有名稱：不送", async () => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("other");
		await typeMinutes("30");
		await userEvent.type(screen.getByLabelText("熱量（kcal）"), "200");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("請填名稱");
		expect(calls(fetchMock, "POST", "/api/exercises")).toHaveLength(0);
	});

	it("時間是未來：不送，說不能選未來的時間", async () => {
		const fetchMock = mockApi(routes());
		renderForm();

		await choose("running");
		await typeMinutes("30");
		fireEvent.change(screen.getByLabelText("時間"), {
			target: { value: "12:01" },
		});
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"不能選未來的時間",
		);
		expect(calls(fetchMock, "POST", "/api/exercises")).toHaveLength(0);
	});

	it("伺服器說要體重（另一個分頁剛刪了體重）：換成手動、說明", async () => {
		// 體重在預覽之後、儲存之前被刪了：之後再問預覽也是沒有體重。
		let weight = true;
		mockApi(
			routes(
				[
					{
						method: "POST",
						path: "/api/exercises",
						handler: () => {
							weight = false;
							return error(
								"EXERCISE_NEEDS_WEIGHT",
								"先記一次體重，就能自動估算；或是直接輸入熱量",
							);
						},
					},
				],
				() => json(weight ? READY : NO_WEIGHT),
			),
		);
		renderForm();

		await choose("running");
		await typeMinutes("30");
		await screen.findByText("約 343 kcal（依 10/14 的體重 70 公斤）");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"先記一次體重，就能自動估算",
		);
		expect(
			screen.getByRole("checkbox", { name: "手動輸入熱量" }),
		).toBeChecked();
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
	});

	it("伺服器說要體重之後又記了體重：預覽再問到有體重就解鎖（審查 M2）", async () => {
		let weight = true;
		mockApi(
			routes(
				[
					{
						method: "POST",
						path: "/api/exercises",
						handler: () => {
							weight = false;
							return error(
								"EXERCISE_NEEDS_WEIGHT",
								"先記一次體重，就能自動估算；或是直接輸入熱量",
							);
						},
					},
				],
				() => json(weight ? READY : NO_WEIGHT),
			),
		);
		const client = renderForm();

		await choose("running");
		await typeMinutes("30");
		await screen.findByText("約 343 kcal（依 10/14 的體重 70 公斤）");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));
		await screen.findByRole("alert");
		const manual = screen.getByRole("checkbox", { name: "手動輸入熱量" });
		expect(manual).toBeChecked();
		expect(manual).toHaveAttribute("aria-disabled", "true");

		// 另一個分頁記了體重；預覽重問（回到這個分頁時 TanStack 會自己重抓）。
		weight = true;
		await act(() => client.refetchQueries({ queryKey: ["exercise-estimate"] }));

		expect(
			await screen.findByText("約 343 kcal（依 10/14 的體重 70 公斤）"),
		).toBeInTheDocument();
		expect(manual).not.toBeChecked();
		expect(manual).not.toHaveAttribute("aria-disabled", "true");
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
	});

	it("伺服器的其他錯誤：顯示它的訊息，留在表單", async () => {
		mockApi(
			routes([
				{
					method: "POST",
					path: "/api/exercises",
					handler: () => error("EXERCISE_IN_FUTURE", "不能記未來的運動"),
				},
			]),
		);
		renderForm();

		await choose("running");
		await typeMinutes("30");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"不能記未來的運動",
		);
		expect(screen.queryByText("總覽頁")).not.toBeInTheDocument();
	});

	it("送出中「儲存」是 aria-disabled，再按不會多送", async () => {
		let release: (response: Response) => void = () => {};
		const fetchMock = mockApi(
			routes([
				{
					method: "POST",
					path: "/api/exercises",
					handler: () =>
						new Promise<Response>((resolve) => {
							release = resolve;
						}),
				},
			]),
		);
		renderForm();

		await choose("running");
		await typeMinutes("30");
		const save = screen.getByRole("button", { name: "儲存" });
		await userEvent.click(save);
		await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
		await userEvent.click(save);
		expect(calls(fetchMock, "POST", "/api/exercises")).toHaveLength(1);

		release(json(RUN, 201));
		expect(await screen.findByText("總覽頁")).toBeInTheDocument();
		expect(calls(fetchMock, "POST", "/api/exercises")).toHaveLength(1);
	});

	it("估算太高（422）：顯示那句話，可以改成手動", async () => {
		mockApi(
			routes([], () =>
				error(
					"EXERCISE_ESTIMATE_TOO_HIGH",
					"估算是 5880 kcal，超過 5000：請手動輸入熱量，或拆成兩筆",
				),
			),
		);
		renderForm();

		await choose("running");
		await typeMinutes("600");

		expect(
			await screen.findByText(
				"估算是 5880 kcal，超過 5000：請手動輸入熱量，或拆成兩筆",
			),
		).toBeInTheDocument();
		const manual = screen.getByRole("checkbox", { name: "手動輸入熱量" });
		expect(manual).not.toBeChecked();
		expect(manual).not.toHaveAttribute("aria-disabled", "true");
		await userEvent.click(manual);
		expect(manual).toBeChecked();
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
	});

	it("活動清單載入失敗：說出來", async () => {
		mockApi(
			routes([
				{
					method: "GET",
					path: "/api/exercise/activities",
					handler: () => error("INTERNAL_ERROR", "壞了", 500),
				},
			]),
		);
		renderForm();

		expect(await screen.findByText("無法載入活動清單")).toBeInTheDocument();
	});

	it("離線打開（活動清單不進離線快取，審查 M3）：說無法載入，不是一直「載入中」", async () => {
		const fetchMock = mockApi(routes());
		onlineManager.setOnline(false);
		try {
			renderForm();

			expect(await screen.findByText("無法載入活動清單")).toBeInTheDocument();
			expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
			expect(screen.getByLabelText("活動")).toBeDisabled();
			expect(calls(fetchMock, "GET", "/api/exercise/activities")).toHaveLength(
				0,
			);
		} finally {
			onlineManager.setOnline(true);
		}
		// 連上之後自己抓回來。
		await waitFor(() => expect(screen.getByLabelText("活動")).toBeEnabled());
		expect(screen.queryByText("無法載入活動清單")).not.toBeInTheDocument();
	});
});
