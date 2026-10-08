import {
	onlineManager,
	QueryClient,
	QueryClientProvider,
} from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createOfflinePersistOptions,
	OFFLINE_CACHE_STORAGE_KEY,
} from "../src/api/persist";
import { queryKeys } from "../src/api/queries";
import { useDailyStats } from "../src/api/stats";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Targets } from "../src/screens/Targets";
import { json, mockApi } from "./helpers/mock-api";

const ZERO = { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" };
const STATS = {
	date: "2019-07-04",
	actual: ZERO,
	target: { kcal: "1800.00", protein_g: "120.00", fat_g: null, carb_g: null },
	ratio: { kcal: "0.00", protein_g: "0.00", fat_g: null, carb_g: null },
	breakdown: { food: ZERO, supplement: ZERO },
};

const SAVED = {
	id: 7,
	kcal: "1800.00",
	protein_g: null,
	fat_g: "60.00",
	carb_g: null,
	label: null,
	effective_from: "2019-07-04",
	effective_to: null,
};

function statsRoute(body: unknown = STATS, status = 200) {
	return {
		method: "GET",
		path: "/api/stats/daily",
		handler: () => json(body, status),
	};
}

function putRoute(handler: () => Response | Promise<Response>) {
	return { method: "PUT", path: "/api/targets/today", handler };
}

function errorResponse(status: number, code: string, message: string) {
	return json({ error: { code, message, details: {} } }, status);
}

/** QueryClient 由測試建立：要讀快取、證明失效。`staleTime` 跟 app 一樣是 60 秒——
 *  預設的 0 會讓重新掛載自己重抓，「有沒有失效」就看不出來（handover「開帳號的路」）。 */
function renderScreen() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/me/targets"]}>
				<Routes>
					<Route path="/me/targets" element={<Targets />} />
					<Route path="/me" element={<h1>我的</h1>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return client;
}

function putBodies(spy: ReturnType<typeof mockApi>): unknown[] {
	return spy.mock.calls
		.filter(([, init]) => init?.method === "PUT")
		.map(([, init]) => JSON.parse(String(init?.body)));
}

function statsGets(spy: ReturnType<typeof mockApi>): number {
	return spy.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET") === "GET" &&
			String(input).includes("/api/stats/daily"),
	).length;
}

/** 斷言「沒有送出」之前先等一下：mutate 是非同步的，立刻斷言在守衛壞掉時也成立（第 41 種）。 */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("/me/targets", () => {
	it("預填今天生效的目標，沒設的空白", async () => {
		mockApi([statsRoute()]);
		renderScreen();

		expect(await screen.findByLabelText("熱量（kcal）")).toHaveValue("1800");
		expect(screen.getByLabelText("蛋白質（g）")).toHaveValue("120");
		expect(screen.getByLabelText("脂肪（g）")).toHaveValue("");
		expect(screen.getByLabelText("碳水（g）")).toHaveValue("");
		expect(screen.getByLabelText("熱量（kcal）")).toHaveAttribute(
			"inputmode",
			"decimal",
		);
	});

	it("送出的 body：四個鍵都在，空白是 null", async () => {
		const spy = mockApi([statsRoute(), putRoute(() => json(SAVED))]);
		renderScreen();

		await userEvent.clear(await screen.findByLabelText("蛋白質（g）"));
		await userEvent.type(screen.getByLabelText("脂肪（g）"), " 60 ");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() => expect(putBodies(spy)).toHaveLength(1));
		expect(putBodies(spy)[0]).toEqual({
			kcal: "1800",
			protein_g: null,
			fat_g: "60",
			carb_g: null,
		});
	});

	it("全部清空也能存（今天起沒有目標）：四個 null", async () => {
		const spy = mockApi([statsRoute(), putRoute(() => json(SAVED))]);
		renderScreen();

		await userEvent.clear(await screen.findByLabelText("熱量（kcal）"));
		await userEvent.clear(screen.getByLabelText("蛋白質（g）"));
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		await waitFor(() => expect(putBodies(spy)).toHaveLength(1));
		expect(putBodies(spy)[0]).toEqual({
			kcal: null,
			protein_g: null,
			fat_g: null,
			carb_g: null,
		});
	});

	it("存好之後失效今天的統計與所有期間的趨勢，回到 /me", async () => {
		const spy = mockApi([statsRoute(), putRoute(() => json(SAVED))]);
		const client = renderScreen();
		// 趨勢不在這一頁掛著：沒人觀察的 query 失效之後不會重抓，`isInvalidated` 留著，看得到。
		// key 用 queryKeys 產生，不寫死字面值（第 23 種）。
		const rangeKey = queryKeys.rangeStats("2019-06-28", "2019-07-04");
		client.setQueryData(rangeKey, []);
		expect(client.getQueryState(rangeKey)?.isInvalidated).toBe(false);

		await userEvent.type(await screen.findByLabelText("碳水（g）"), "200");
		expect(statsGets(spy)).toBe(1);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(
			await screen.findByRole("heading", { name: "我的" }),
		).toBeInTheDocument();
		expect(client.getQueryState(rangeKey)?.isInvalidated).toBe(true);
		// 今天的統計在這一頁掛著：失效會立刻重抓（staleTime 60 秒，不失效就不會再打一次）。
		await waitFor(() => expect(statsGets(spy)).toBe(2));
	});

	it.each([
		["0", "熱量要是大於 0 的數字"],
		["12.345", "熱量最多兩位小數"],
		["20001", "熱量不能超過 20000"],
	])("前端檢查：熱量 %s → 「%s」、不送出", async (value, message) => {
		// PUT 掛著不回：守衛壞掉時請求送出去了、但畫面不會導走，紅的是「沒有 PUT」那一行，
		// 不是「找不到 alert」（紅燈要紅在被測的性質上，第 12 種）。
		const spy = mockApi([
			statsRoute(),
			putRoute(() => new Promise<Response>(() => {})),
		]);
		renderScreen();

		const kcal = await screen.findByLabelText("熱量（kcal）");
		await userEvent.clear(kcal);
		await userEvent.type(kcal, value);
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		await settle();
		expect(putBodies(spy)).toHaveLength(0);
	});

	it("讀不到目前的目標：不顯示表單（空白表單存下去等於清掉目標）", async () => {
		mockApi([
			statsRoute(
				{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
				500,
			),
		]);
		renderScreen();

		expect(await screen.findByText("無法載入目前的目標")).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "儲存" }),
		).not.toBeInTheDocument();
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
	});

	// 快取裡的目標可能是舊的（另一台裝置改過、離線快取還原的）。表單從快取預填的話，
	// 使用者只改一格按儲存，其他三格就被悄悄改回舊的值（帳號設定審查 M5）。
	const CACHED = {
		...STATS,
		target: {
			kcal: "1500.00",
			protein_g: "90.00",
			fat_g: "50.00",
			carb_g: null,
		},
	};

	/** 跟 `renderScreen` 一樣，但快取裡先有一份**還新鮮**的統計（staleTime 60 秒內）——
	 *  沒有特別要求的話，掛載不會重抓。 */
	function renderScreenWithCache() {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
		});
		client.setQueryData(queryKeys.dailyStats, CACHED);
		render(
			<QueryClientProvider client={client}>
				<MemoryRouter initialEntries={["/me/targets"]}>
					<Routes>
						<Route path="/me/targets" element={<Targets />} />
					</Routes>
				</MemoryRouter>
			</QueryClientProvider>,
		);
		return client;
	}

	it("快取裡是舊的目標：等重抓回來才顯示表單，預填的是新的值", async () => {
		let respond: (response: Response) => void = () => undefined;
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/stats/daily",
				handler: () =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			},
		]);
		renderScreenWithCache();

		// 重抓還在路上：不能已經拿快取的值畫出表單。
		await waitFor(() => expect(statsGets(spy)).toBe(1));
		expect(screen.getByText("載入中…")).toBeInTheDocument();
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();

		respond(json(STATS));

		expect(await screen.findByLabelText("熱量（kcal）")).toHaveValue("1800");
		expect(screen.getByLabelText("蛋白質（g）")).toHaveValue("120");
		// 快取裡有、伺服器上已經清掉的那一格是空白，不是舊的 50。
		expect(screen.getByLabelText("脂肪（g）")).toHaveValue("");
	});

	it("快取裡有舊的目標、重抓失敗：顯示「無法載入目前的目標」，不顯示帶著舊值的表單", async () => {
		mockApi([
			statsRoute(
				{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
				500,
			),
		]);
		renderScreenWithCache();

		expect(await screen.findByText("無法載入目前的目標")).toBeInTheDocument();
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "儲存" }),
		).not.toBeInTheDocument();
	});

	it("離線（重抓被暫停、不會自己結束）：顯示讀不到，不是一直「載入中」", async () => {
		const spy = mockApi([statsRoute()]);
		onlineManager.setOnline(false);
		try {
			renderScreenWithCache();

			expect(await screen.findByText("無法載入目前的目標")).toBeInTheDocument();
			expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
			expect(statsGets(spy)).toBe(0);
		} finally {
			onlineManager.setOnline(true);
		}
	});

	it("表單出來之後的背景重抓（失敗或帶回別的值）不動使用者正在打的字", async () => {
		let stats: () => Response = () => json(STATS);
		mockApi([
			{ method: "GET", path: "/api/stats/daily", handler: () => stats() },
		]);
		const client = renderScreen();
		const kcal = await screen.findByLabelText("熱量（kcal）");
		await userEvent.clear(kcal);
		await userEvent.type(kcal, "1950");

		// 帶回別的值（另一台裝置剛改過）：不覆蓋打到一半的。
		stats = () => json(CACHED);
		await client.refetchQueries({ queryKey: queryKeys.dailyStats });
		expect(screen.getByLabelText("熱量（kcal）")).toHaveValue("1950");

		// 失敗（切回分頁時剛好斷線）：表單不能換成錯誤訊息——打的字會不見。
		stats = () =>
			json(
				{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
				500,
			);
		await client.refetchQueries({ queryKey: queryKeys.dailyStats });
		expect(client.getQueryState(queryKeys.dailyStats)?.status).toBe("error");
		// query 的結果是排程之後才通知畫面的：不等這一下，下面的斷言看到的還是重抓之前的
		// 畫面，表單被換掉了也是綠的（第 41 種）。
		await act(() => settle());
		expect(screen.getByLabelText("熱量（kcal）")).toHaveValue("1950");
		expect(screen.queryByText("無法載入目前的目標")).not.toBeInTheDocument();
	});

	it("409：顯示後端的訊息，留在這一頁", async () => {
		mockApi([
			statsRoute(),
			putRoute(() =>
				errorResponse(
					409,
					"TARGET_CONFLICT",
					"目標剛被另一台裝置改過，請重新整理再試",
				),
			),
		]);
		renderScreen();

		await userEvent.click(await screen.findByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"目標剛被另一台裝置改過，請重新整理再試",
		);
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
	});

	it("422：顯示欄位訊息", async () => {
		mockApi([
			statsRoute(),
			putRoute(() =>
				json(
					{
						error: {
							code: "VALIDATION_ERROR",
							message: "輸入有誤",
							details: {
								errors: [
									{
										loc: ["body", "kcal"],
										msg: "Input should be greater than 0",
										type: "greater_than",
									},
								],
							},
						},
					},
					422,
				),
			),
		]);
		renderScreen();

		await userEvent.click(await screen.findByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"kcal：Input should be greater than 0",
		);
	});

	it("其他錯誤：「儲存失敗，請再試一次」", async () => {
		mockApi([
			statsRoute(),
			putRoute(() => new Response("boom", { status: 500 })),
		]);
		renderScreen();

		await userEvent.click(await screen.findByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"儲存失敗，請再試一次",
		);
		expect(screen.getByLabelText("熱量（kcal）")).toBeInTheDocument();
	});
});

// 整頁重新載入停在 /me/targets（帳號設定審查 M5 的第二輪）。`App` 用 `PersistQueryClientProvider`：
// 還原離線快取的那段時間，畫面已經 render 了。那時候建立的 observer 記下的「掛載時的狀態」是空的，
// 還原把 localStorage 裡那份（`dataUpdateCount` ≥ 1）蓋上去之後，`isFetchedAfterMount` 就是 true——
// 一個請求都還沒回來，舊的目標已經被當成「掛載之後才抓回來的」填進表單，而且預填只做一次。
//
// 只有「兩個 QueryClient 透過同一份 localStorage 交接」驗得到（同 offline.test.tsx）：上面
// `renderScreenWithCache` 的 `setQueryData` 是在 observer 建立**之前**就把資料放進快取，走不到這條路。
describe("/me/targets：整頁重新載入，離線快取裡有舊的目標", () => {
	const OLD = {
		...STATS,
		target: {
			kcal: "1500.00",
			protein_g: "90.00",
			fat_g: "50.00",
			carb_g: null,
		},
	};

	function newClient() {
		return new QueryClient({
			defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
		});
	}

	function wrap(client: QueryClient, at: string) {
		return (
			<PersistQueryClientProvider
				client={client}
				persistOptions={createOfflinePersistOptions(window.localStorage)}
			>
				<MemoryRouter initialEntries={[at]}>
					<Routes>
						<Route path="/" element={<Probe />} />
						<Route path="/me/targets" element={<Targets />} />
					</Routes>
				</MemoryRouter>
			</PersistQueryClientProvider>
		);
	}

	/** 上一次載入：別的畫面（總覽、飲食、「我的」）讀過今天的統計，它就進了離線快取。 */
	function Probe() {
		const stats = useDailyStats();
		return <p>上一次載入：{stats.data?.target?.kcal ?? "還沒有"}</p>;
	}

	/** 第一階段：線上讀到舊的目標，等它真的寫進 localStorage（節流寫入，約 1 秒）。 */
	async function persistOldTarget() {
		mockApi([statsRoute(OLD)]);
		const first = render(wrap(newClient(), "/"));
		await screen.findByText("上一次載入：1500.00");
		await waitFor(
			() =>
				expect(localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY) ?? "").toContain(
					"1500.00",
				),
			{ timeout: 3000 },
		);
		first.unmount();
		vi.restoreAllMocks();
	}

	it("伺服器上已經是新的目標：重抓回來之前沒有表單，回來之後預填新的值", async () => {
		await persistOldTarget();
		let respond: (response: Response) => void = () => undefined;
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/stats/daily",
				handler: () =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			},
		]);
		render(wrap(newClient(), "/me/targets"));

		// 重抓發出去＝還原已經做完了。再等一下：還原的結果是排程之後才通知畫面的，
		// 立刻斷言會在「表單還沒來得及畫出來」的時候就通過（第 41 種）。
		await waitFor(() => expect(statsGets(spy)).toBe(1));
		await act(() => settle());
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("1500")).not.toBeInTheDocument();
		expect(screen.getByText("載入中…")).toBeInTheDocument();

		respond(json(STATS));

		expect(await screen.findByLabelText("熱量（kcal）")).toHaveValue("1800");
		expect(screen.getByLabelText("蛋白質（g）")).toHaveValue("120");
		// 離線快取裡有、伺服器上已經清掉的那一格是空白，不是舊的 50。
		expect(screen.getByLabelText("脂肪（g）")).toHaveValue("");
	});

	it("連不上（重抓失敗）：「無法載入目前的目標」，不顯示帶著舊值的表單", async () => {
		await persistOldTarget();
		// 連 Response 都沒有——斷線時瀏覽器的 fetch 是直接 reject（同 offline.test.tsx 的 goOffline）。
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new TypeError("network request failed"));
		render(wrap(newClient(), "/me/targets"));

		expect(await screen.findByText("無法載入目前的目標")).toBeInTheDocument();
		expect(spy).toHaveBeenCalled();
		expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "儲存" }),
		).not.toBeInTheDocument();
	});

	it("瀏覽器知道自己離線（重抓被暫停）：也是「無法載入目前的目標」，沒有表單", async () => {
		await persistOldTarget();
		const spy = mockApi([statsRoute()]);
		onlineManager.setOnline(false);
		try {
			render(wrap(newClient(), "/me/targets"));

			expect(await screen.findByText("無法載入目前的目標")).toBeInTheDocument();
			// 還原做完之後畫面才會換：等一下再看，表單不能在這之後冒出來。
			await act(() => settle());
			expect(screen.queryByLabelText("熱量（kcal）")).not.toBeInTheDocument();
			expect(statsGets(spy)).toBe(0);
		} finally {
			onlineManager.setOnline(true);
		}
	});
});
