import { QueryClient } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
	createOfflinePersistOptions,
	OFFLINE_CACHE_STORAGE_KEY,
} from "../src/api/persist";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { formatTime } from "../src/lib/dates";
import { Today } from "../src/screens/Today";
import { json, mockApiByPath as mockApi } from "./helpers/mock-api";

// wrap 從 today.test.tsx 改寫——這裡額外接一個 QueryClient 參數（今日總覽的
// 離線行為只有在「兩個不同的 QueryClient 透過同一份 localStorage 交接」時
// 才驗得到：同一個 client 重新 render 不會證明持久化真的發生，只會證明
// 記憶體裡的快取沒被清掉）。
function wrap(client: QueryClient, children: ReactNode) {
	return (
		<PersistQueryClientProvider
			client={client}
			persistOptions={createOfflinePersistOptions(window.localStorage)}
		>
			{children}
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
	state: { status: string; dataUpdatedAt: number };
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
 *  `defaultShouldDehydrateQuery` 把它濾掉，寫進去的是空的 `queries: []`。
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
			"/api/meals/11/photo": () =>
				new Response(new Blob(["fake-jpeg-bytes"], { type: "image/jpeg" }), {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
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
});
