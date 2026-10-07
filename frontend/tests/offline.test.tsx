import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createOfflinePersistOptions,
	OFFLINE_CACHE_STORAGE_KEY,
} from "../src/api/persist";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { formatTime } from "../src/lib/dates";
import { Expenses } from "../src/screens/Expenses";
import { Today } from "../src/screens/Today";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

// wrap 從 today.test.tsx 改寫——這裡額外接一個 QueryClient 參數（今日總覽的
// 離線行為只有在「兩個不同的 QueryClient 透過同一份 localStorage 交接」時
// 才驗得到：同一個 client 重新 render 不會證明持久化真的發生，只會證明
// 記憶體裡的快取沒被清掉）。
//
// 需要 MemoryRouter：P3-C Task 2 在「今日補劑」區塊加了一個連到
// /supplements 的 <Link>，不掛 Router 會直接炸掉（跟 today.test.tsx 同一個
// 理由）。
function wrap(client: QueryClient, children: ReactNode) {
	return (
		<PersistQueryClientProvider
			client={client}
			persistOptions={createOfflinePersistOptions(window.localStorage)}
		>
			<MemoryRouter>{children}</MemoryRouter>
		</PersistQueryClientProvider>
	);
}

const STATS_WITH_TARGET = {
	date: "2026-09-15",
	actual: {
		kcal: "1800.00",
		protein_g: "90.50",
		fat_g: "60.00",
		carb_g: "200.00",
	},
	target: {
		kcal: "2000.00",
		protein_g: "150.00",
		fat_g: null,
		carb_g: "250.00",
	},
	ratio: { kcal: "0.90", protein_g: "0.60", fat_g: null, carb_g: "0.80" },
	breakdown: {
		food: {
			kcal: "1700.00",
			protein_g: "80.50",
			fat_g: "55.00",
			carb_g: "190.00",
		},
		supplement: {
			kcal: "100.00",
			protein_g: "10.00",
			fat_g: "5.00",
			carb_g: "10.00",
		},
	},
};

/** 讓 fetch 一律 reject，模擬「連不上這個後端」——不是回一個 4xx/5xx，是
 *  連 Response 都沒有。這比回 401/500 更接近真的離線：Tailscale 斷線時
 *  瀏覽器的 fetch 是直接 reject，不是收到一個錯誤狀態碼的回應。 */
function goOffline() {
	return vi
		.spyOn(globalThis, "fetch")
		.mockRejectedValue(new TypeError("network request failed"));
}

/** 直接竄改 localStorage 裡已經 persist 好的狀態，把每個 query 的
 *  `dataUpdatedAt`（以及外層的 `timestamp`）往回推 `ms` 毫秒。
 *
 *  **為什麼不用 `vi.useFakeTimers()` 讓時間「過去」：** persist 套件的節流
 *  是用 `setTimeout` 實作的（`asyncThrottle`），跟 fake timers 混用容易卡住
 *  ——不確定它內部拿到的 `setTimeout` 參照是不是 vitest 能攔截到的那一個。
 *  直接改 localStorage 裡的數字更直接：它就是「使用者昨天成功讀取過，
 *  今天離線重新整理」這個情境在儲存層的樣子，不需要假時鐘。 */
function agePersistedCacheBy(ms: number) {
	const raw = localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY);
	if (raw === null) {
		throw new Error("localStorage 裡沒有東西被 persist——前一階段大概沒等夠");
	}
	const parsed = JSON.parse(raw) as {
		timestamp: number;
		clientState: {
			queries: Array<{ state: { dataUpdatedAt?: number } }>;
		};
	};
	parsed.timestamp -= ms;
	for (const query of parsed.clientState.queries) {
		if (typeof query.state.dataUpdatedAt === "number") {
			query.state.dataUpdatedAt -= ms;
		}
	}
	localStorage.setItem(OFFLINE_CACHE_STORAGE_KEY, JSON.stringify(parsed));
}

type PersistedQuerySnapshot = {
	queryKey: unknown[];
	state: {
		status: string;
		dataUpdatedAt: number;
		data?: unknown;
		isInvalidated?: boolean;
	};
};

function readPersistedQueries(): PersistedQuerySnapshot[] {
	const raw = localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY);
	if (raw === null) return [];
	const parsed = JSON.parse(raw) as {
		clientState: { queries: PersistedQuerySnapshot[] };
	};
	return parsed.clientState.queries;
}

/** stats/daily 那筆 query 目前存在 localStorage 裡、且已經成功的快照。
 *
 *  **為什麼不能只等 `localStorage.getItem(...) !== null`：** `persistClient`
 *  在 query 一被建立（`added` 事件，狀態還是 `pending`）就會寫一次——
 *  `shouldDehydrateQuery`（`persist.ts`）把它濾掉，寫進去的是空的 `queries: []`。
 *  真正帶著資料的那次寫入是**下一次**節流視窗到期後才發生（預設
 *  1 秒）。只等「非 null」會抓到那個提早的空快照，之後所有讀取都會找不到
 *  這筆 query——這是實測踩過的（第一版測試因此紅在「找不到 stats/daily
 *  這個 query」，不是離線行為本身有問題）。 */
function findPersistedStatsSuccess(): PersistedQuerySnapshot | undefined {
	return readPersistedQueries().find(
		(query) =>
			Array.isArray(query.queryKey) &&
			query.queryKey[0] === "stats" &&
			query.queryKey[1] === "daily" &&
			query.state.status === "success",
	);
}

function readPersistedStatsUpdatedAt(): number {
	const statsQuery = findPersistedStatsSuccess();
	if (statsQuery === undefined)
		throw new Error("localStorage 裡沒有已經成功的 stats/daily 這個 query");
	return statsQuery.state.dataUpdatedAt;
}

function newTestClient(): QueryClient {
	// staleTime 跟 src/api/queries.ts 的 queryClient 單例一致（60 秒）——
	// 這份測試要驗的是「離線時 hydrate 出來的資料在真實的 staleTime 設定下
	// 會不會被判定為需要重新 fetch」，用一個不同的 staleTime 測不出這件事。
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("離線 L2：持久化與「最後更新於」", () => {
	it("離線時顯示持久化的資料，而不是空白", async () => {
		// 第一階段：在線上把 today 成功讀過一次，讓 TanStack Query 的持久化
		// 把它寫進 localStorage。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const clientA = newTestClient();
		const { unmount } = render(wrap(clientA, <Today />));
		await screen.findByText(/1800/);
		await waitFor(
			() => expect(findPersistedStatsSuccess()).not.toBeUndefined(),
			{ timeout: 3000 },
		);
		unmount();

		// 讓快取「老化」超過 staleTime，這樣第二階段掛載時 TanStack Query
		// 才會真的嘗試背景重新 fetch（而不是因為資料還新鮮而完全不打）——
		// 這條測試要守的正是「那次嘗試失敗了，畫面還是不能變空白」。
		agePersistedCacheBy(5 * 60 * 1000);

		// 第二階段：模擬離線——fetch 全部 reject，換一個全新的 QueryClient
		// （不共用 clientA 的記憶體狀態，只透過 localStorage 溝通）。
		goOffline();
		const clientB = newTestClient();
		render(wrap(clientB, <Today />));

		// 數字還在，即使這次的 fetch 全部失敗。
		expect(await screen.findByText(/1800/)).toBeInTheDocument();
	});

	it("離線重新載入兩次，資料還在（抓取失敗的查詢不會被下一次寫入洗掉）", async () => {
		// 記帳與離線規格 §2 (a)。TanStack v5 的 `defaultShouldDehydrateQuery`
		// 只寫 `status === "success"` 的查詢；離線重新載入後背景重抓失敗，
		// stats 變成 `status: "error"`（`data` 還在、畫面也還有數字），下一次
		// 節流寫入就把它從 localStorage 拿掉了——第二次離線重新載入什麼都沒有。

		// 第一階段：線上成功，寫進 localStorage。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const clientA = newTestClient();
		const first = render(wrap(clientA, <Today />));
		await screen.findByText(/1800/);
		await waitFor(
			() => expect(findPersistedStatsSuccess()).not.toBeUndefined(),
			{ timeout: 3000 },
		);
		first.unmount();
		agePersistedCacheBy(5 * 60 * 1000);

		// 第二階段：離線重新載入。資料從快取來，背景重抓失敗（離線標示只在
		// isError 而且有資料時出現，所以等到它就等於等到了那次失敗）。
		goOffline();
		const clientB = newTestClient();
		const second = render(wrap(clientB, <Today />));
		expect(await screen.findByTestId("offline-banner")).toBeInTheDocument();
		expect(screen.getByText(/1800/)).toBeInTheDocument();
		// 等失敗**之後**的那次寫入：只看「stats 有資料」會被第一階段留下的快照
		// 騙過（那份一直都在，直到下一次寫入蓋掉它），所以要認失敗留下的
		// `isInvalidated: true`——第一階段的快照是 false。不認 status：寫進去
		// 之前 `persist.ts` 會把有資料的 error 改寫成 success（見下一條測試）。
		await waitFor(
			() => {
				const stats = readPersistedQueries().find(
					(query) =>
						query.queryKey[0] === "stats" && query.queryKey[1] === "daily",
				);
				expect(stats?.state.isInvalidated).toBe(true);
				expect(stats?.state.status).toBe("success");
				expect(stats?.state.data).toEqual(STATS_WITH_TARGET);
			},
			{ timeout: 3000 },
		);
		second.unmount();

		// 第三階段：再一次離線重新載入，數字還在。
		const clientC = newTestClient();
		render(wrap(clientC, <Today />));
		expect(await screen.findByText(/1800/)).toBeInTheDocument();
		expect(await screen.findByTestId("offline-banner")).toBeInTheDocument();
	});

	it("上一次離線失敗的查詢，重新上線載入、重抓還在路上時不顯示離線或錯誤", async () => {
		// 審查 I-1。上一條讓「有資料的 error」也寫進 localStorage；如果原樣
		// 寫進去，TanStack restore 回來就是 `status: "error"`——下一次**在線上**
		// 重新載入，背景重抓還沒回來的那段時間，畫面以為剛剛失敗了：今日總覽
		// 冒出「離線資料，最後更新於…」，報表顯示「無法載入本月報表」／
		// 「無法載入花費清單」，即使數字都在。（而且那個 error 經過 JSON 只剩
		// `{}`，ApiError 早就不見了。）
		const routes = {
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
			// 具體的路徑排前面：`/api/expenses` 也「包含」在 summary 的 URL 裡。
			"/api/expenses/summary": () =>
				json({
					month: "2026-09",
					total: "430.50",
					by_category: [
						{ category: "food", total: "180.00", count: 1 },
						{ category: "transport", total: "250.50", count: 1 },
					],
				}),
			"/api/expenses": () =>
				json([
					{
						id: 1,
						amount: "180.00",
						category: "food",
						spent_at: "2026-09-15T04:00:00+00:00",
						note: "便當",
						meal_id: null,
					},
				]),
		};
		const screens = (
			<>
				<Today />
				<Expenses />
			</>
		);
		const persistedFor = (first: string, second?: string) =>
			readPersistedQueries().find(
				(query) =>
					query.queryKey[0] === first &&
					(second === undefined || query.queryKey[1] === second),
			);

		// 第一階段：線上成功。
		mockApi(routes);
		const first = render(wrap(newTestClient(), screens));
		await screen.findByText(/1800/);
		await screen.findByText("430.50");
		await screen.findByText(/便當/);
		await waitFor(
			() => {
				expect(findPersistedStatsSuccess()).not.toBeUndefined();
				expect(persistedFor("expenses", "summary")?.state.data).toBeDefined();
				expect(persistedFor("expenses", "list")?.state.data).toBeDefined();
			},
			{ timeout: 3000 },
		);
		first.unmount();
		agePersistedCacheBy(5 * 60 * 1000);

		// 第二階段：離線重新載入，三個查詢的背景重抓都失敗；等失敗**之後**的
		// 那次寫入（失敗把 `isInvalidated` 設成 true，第一階段的快照是 false）。
		vi.restoreAllMocks();
		goOffline();
		const second = render(wrap(newTestClient(), screens));
		expect(await screen.findByTestId("offline-banner")).toBeInTheDocument();
		await waitFor(
			() => {
				for (const query of [
					persistedFor("stats", "daily"),
					persistedFor("expenses", "summary"),
					persistedFor("expenses", "list"),
				]) {
					expect(query?.state.isInvalidated).toBe(true);
					expect(query?.state.data).toBeDefined();
				}
			},
			{ timeout: 3000 },
		);
		second.unmount();

		// 第三階段：重新上線載入，但重抓還沒回來（fetch 永遠 pending）。
		vi.restoreAllMocks();
		const pendingFetch = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => new Promise<Response>(() => {}));
		render(wrap(newTestClient(), screens));
		// 快取的數字可以顯示。
		expect(await screen.findByText(/1800/)).toBeInTheDocument();
		expect(await screen.findByText("430.50")).toBeInTheDocument();
		expect(await screen.findByText(/便當/)).toBeInTheDocument();
		// 重抓真的發出去了（不然「沒有錯誤」可能只是因為根本沒抓）。
		await waitFor(() => {
			const urls = pendingFetch.mock.calls.map(([input]) => String(input));
			expect(urls.some((url) => url.includes("/api/stats/daily"))).toBe(true);
			expect(urls.some((url) => url.includes("/api/expenses/summary"))).toBe(
				true,
			);
		});
		expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument();
		expect(screen.queryByText(/無法載入/)).not.toBeInTheDocument();
	});

	it("沒有資料的失敗查詢不寫進 localStorage", async () => {
		// 上一條的另一半：放寬成「有資料的 error 也寫」，不是「所有 error 都寫」。
		mockApi({
			"/api/stats/daily": () =>
				json(
					{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
					500,
				),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const client = newTestClient();
		render(wrap(client, <Today />));
		expect(await screen.findByText("無法載入今天的營養素")).toBeInTheDocument();

		// 失敗之後再觸發一次寫入，等到它真的寫進去——這樣讀到的一定是失敗
		// **之後**的快照，「stats 不在」才不是因為那次寫入還沒發生。
		client.setQueryData(["persist-probe"], 1);
		await waitFor(
			() =>
				expect(
					readPersistedQueries().some(
						(query) => query.queryKey[0] === "persist-probe",
					),
				).toBe(true),
			{ timeout: 3000 },
		);
		expect(
			readPersistedQueries().some((query) => query.queryKey[0] === "stats"),
		).toBe(false);
	});

	it("資料來自快取時顯示「最後更新於」，用的是 dataUpdatedAt 不是 Date.now()", async () => {
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const clientA = newTestClient();
		const { unmount } = render(wrap(clientA, <Today />));
		await screen.findByText(/1800/);
		await waitFor(
			() => expect(findPersistedStatsSuccess()).not.toBeUndefined(),
			{ timeout: 3000 },
		);
		unmount();

		// 老化 3 小時——夠大，HH:MM 幾乎不可能剛好跟「現在」撞在同一分鐘,
		// 同時遠遠超過 staleTime，確保會觸發一次失敗的背景 fetch。
		const AGE_MS = 3 * 60 * 60 * 1000;
		agePersistedCacheBy(AGE_MS);
		const expectedLabel = formatTime(readPersistedStatsUpdatedAt());

		goOffline();
		const clientB = newTestClient();
		render(wrap(clientB, <Today />));

		const banner = await screen.findByTestId("offline-banner");
		expect(banner).toHaveTextContent("離線資料");
		expect(banner).toHaveTextContent(expectedLabel);
		// 規格 §8 的警告：顯示陳舊數字而不說明它是陳舊的，比不顯示更糟。
		// 這裡具體化成「不是 Date.now()」——如果實作偷懶顯示 new Date()，
		// 這裡會顯示「現在」的 HH:MM，而 3 小時的老化幾乎必然讓那跟
		// expectedLabel 不同。
		expect(banner).not.toHaveTextContent(formatTime(Date.now()));
	});

	it("連線正常時不顯示「最後更新於」", async () => {
		// 這條跟上一條是一對：只有上一條的話，把標示寫成「永遠顯示」也會
		// 綠——那會讓使用者以為自己一直是離線的。這裡完全不碰
		// localStorage／persist，單純確認一次成功的即時 fetch 不會冒出
		// 那個標示。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const client = newTestClient();
		render(wrap(client, <Today />));

		await screen.findByText(/1800/);

		expect(screen.queryByTestId("offline-banner")).not.toBeInTheDocument();
	});

	it("照片 blob 不會被寫進 localStorage", async () => {
		// **`localStorage` 有 5MB 上限，而一張照片（前端降尺寸後也還有幾百
		// KB——計畫三 Task 3 實測是 571KB）就可能把它塞爆。**
		//
		// 塞爆的症狀很惡劣：`setItem` 丟 QuotaExceededError，於是**整份
		// 離線快取都寫不進去** —— 不是「照片存不了」，是連今日總覽也一起
		// 沒了。而那個失敗發生在背景的節流寫入裡，畫面上完全看不出來。
		//
		// 排除是在 `persist.ts` 的 `shouldDehydrateQuery` 做的，靠的是
		// `queryKeys.mealPhoto` 用了獨立的 `["meal-photo", id]` 命名空間
		// （Task 3 把它從 `["meals", id, "photo"]` 改過來的）。
		// **所以這條測試同時也在守那個命名空間**：把 key 改回巢狀，
		// 第一段就不再是 "meal-photo"，排除失效，這裡會紅。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			// **照片這條必須排在 `/api/meals` 前面。** 比對是
			// `url.includes(path)` 加上「第一個符合的就用」，而
			// `"/api/meals/11/photo".includes("/api/meals")` 為真 ——
			// 排在後面的話，泛用的 `/api/meals` 會把照片請求吃掉，
			// 下面那個假 JPEG 的 handler **永遠不會被呼叫到**。
			//
			// 這不是假設：把這個 handler 換成 `throw` 之後，這個檔案的
			// 8 則測試依然全綠（P3-B 計畫一 Task 1 的審查發現的）。
			// 當時測試還是綠的，因為 `useMealPhoto` 只要拿到 200 就
			// `blob()` 成功、`createObjectURL` 給出一個 url，`<img>` 就出現，
			// 而下面的斷言只看 localStorage 裡有沒有 `"meal-photo"` 這個
			// key —— 那個 key 是 React Query 決定的，跟 fetch 回什麼無關。
			//
			// 也就是說：這條測試宣稱要守的事（照片 query 不進 localStorage）
			// 確實守到了，但它同時留下一條死路由。下次有人依賴這個 handler
			// 的回應內容時會非常難查。
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
			"/api/meals": () =>
				json([
					{
						id: 11,
						eaten_at: "2026-09-21T12:30:00+08:00",
						meal_type: "lunch",
						note: null,
						photo_path: "3/abc123.jpg",
						items: [],
						kcal: "1.00",
						protein_g: "1.00",
						fat_g: "1.00",
						carb_g: "1.00",
					},
				]),
		});

		render(
			wrap(
				new QueryClient({ defaultOptions: { queries: { retry: false } } }),
				<Today />,
			),
		);

		// 等照片真的被取回來。少了這一行，這條測試會因為「還沒 fetch 照片」
		// 而綠 —— 跟排除有沒有生效無關，那是假綠燈。
		await screen.findByRole("img");

		await waitFor(() => {
			const raw = localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY);
			expect(raw).not.toBeNull();
			const persisted: { queryKey: unknown[] }[] = JSON.parse(raw ?? "{}")
				.clientState.queries;
			// 今日總覽、補劑、餐點清單三個都該在
			expect(persisted.length).toBeGreaterThanOrEqual(3);
			// 照片不該在
			expect(persisted.map((query) => query.queryKey[0])).not.toContain(
				"meal-photo",
			);
		});
	});

	it("food-search 的搜尋結果不會被寫進 localStorage", async () => {
		// **不渲染 FoodLibrary**（Task 3 才存在）—— 這條測試要驗的是
		// `shouldDehydrateQuery` 的行為，不是那個畫面。用真畫面會把兩件事
		// 綁在一起，而且會讓 Task 2 等 Task 3。
		//
		// 直接用 `setQueryData` 把一筆 food-search 的結果塞進 client：
		// `setQueryData` 會把那個 query 的狀態設成 "success"，而
		// `shouldDehydrateQuery` 對沒有失敗過的 query 只看 `state.status === "success"`
		// ——跟真的打一次 `useFoodSearch` 對持久化層來說是等價的輸入。
		//
		// **這是避免假綠燈的關鍵**：如果這條測試從沒讓 food-search 這個
		// query 進到 client 裡，那麼「persisted 裡沒有 food-search」會因為
		// 「client 裡本來就沒有這個 query」而綠，跟排除有沒有生效無關。
		// 這裡明確呼叫 setQueryData，之後再驗證 stats/daily 確實被排進
		// persisted 清單（證明 persist 真的跑過一輪、不是因為整個持久化
		// 都沒觸發才巧合地綠），food-search 才不在清單裡才有意義。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const client = newTestClient();
		render(wrap(client, <Today />));
		await screen.findByText(/1800/);

		const searchKey = queryKeys.foodSearch("雞", "all");
		client.setQueryData(searchKey, [
			{
				id: 1,
				name: "雞胸肉",
				brand: null,
				is_global: true,
				nutrition: null,
			},
		]);

		// **比對用 `queryKeys.foodSearch(...)` 產生的實際 key 做深比對，
		// 不是寫死 `queryKey[0] === "food-search"` 這個字面值。**
		//
		// 原因是實測到的一個假綠燈：Step 6 突變（一）把 `foodSearch` 的 key
		// 從 `["food-search", q, scope]` 改成掛到 `["foods", "search", q,
		// scope]` 底下（`persist.ts` 的排除沒有跟著改）。那個突變之後，
		// 搜尋結果真的被寫進了 localStorage——排除確實失效了。但如果這裡
		// 用 `queryKey[0] === "food-search"` 這個寫死的字面值去檢查，
		// 突變後的 key 第一段變成 `"foods"`，同一個斷言會**同時**失去
		// 鑑別力：它既抓不到「exclusion 失效」，也抓不到「namespace 被
		// 改名」，兩件事一起發生時反而全綠。改成用 `queryKeys.foodSearch`
		// 實際產生的 key 做深比對之後，不管 namespace 長什麼樣子，
		// 只要那組特定的搜尋結果進了 persisted 清單，這裡就會紅。
		const searchKeyJson = JSON.stringify(searchKey);

		await waitFor(
			() => {
				const raw = localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY);
				expect(raw).not.toBeNull();
				const persisted: { queryKey: unknown[] }[] = JSON.parse(raw ?? "{}")
					.clientState.queries;
				// stats/daily 在——證明這一輪 persist 真的把東西寫進去了。
				expect(
					persisted.some(
						(query) =>
							Array.isArray(query.queryKey) && query.queryKey[0] === "stats",
					),
				).toBe(true);
				// food-search 的搜尋結果不該在。
				expect(
					persisted.some(
						(query) => JSON.stringify(query.queryKey) === searchKeyJson,
					),
				).toBe(false);
			},
			{ timeout: 3000 },
		);
	});

	it("好友的資料與照片都不會被寫進 localStorage", async () => {
		// 對方可以解除好友、可以把一餐改成「只有我看得到」——那之後這台裝置
		// 不該還能離線翻出舊的好友資料。跟 food-search 那條同一個做法：先讓
		// 這些 query 真的進到 client（setQueryData），再證明 persist 跑過一輪
		// （stats 在），它們不在才有意義；用 queryKeys 產生的 key 做深比對。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
			"/api/meals": () => json([]),
		});
		const client = newTestClient();
		render(wrap(client, <Today />));
		await screen.findByText(/1800/);

		const friendKeys = [
			queryKeys.friends,
			queryKeys.friendDay(2, "2026-10-05"),
			queryKeys.friendPhoto(2, 1),
		];
		client.setQueryData(queryKeys.friends, [
			{ id: 2, display_name: "鮑伯", since: "2026-10-01T00:00:00Z" },
		]);
		client.setQueryData(queryKeys.friendDay(2, "2026-10-05"), {
			friend: { id: 2, display_name: "鮑伯" },
			day: "2026-10-05",
			meals: [],
		});
		client.setQueryData(queryKeys.friendPhoto(2, 1), "blob:photo");
		const friendKeysJson = friendKeys.map((key) => JSON.stringify(key));

		await waitFor(
			() => {
				const raw = localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY);
				expect(raw).not.toBeNull();
				const persisted: { queryKey: unknown[] }[] = JSON.parse(raw ?? "{}")
					.clientState.queries;
				expect(
					persisted.some(
						(query) =>
							Array.isArray(query.queryKey) && query.queryKey[0] === "stats",
					),
				).toBe(true);
				expect(
					persisted
						.map((query) => JSON.stringify(query.queryKey))
						.filter((key) => friendKeysJson.includes(key)),
				).toEqual([]);
			},
			{ timeout: 3000 },
		);
	});
});
