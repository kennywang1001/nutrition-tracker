import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Today } from "../src/screens/Today";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

/** 依 URL 分派的 fetch mock。**一律先驗 Authorization** ——
 *  沒帶就回 401 信封。這是規格 §9.2 第 2 條：mock 不檢查 header 的話，
 *  「所有請求都要帶 token」這個保證零鑑別力。 */
function mockApi(routes: Record<string, () => Response>) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = typeof input === "string" ? input : String(input);
			if (!new Headers(init?.headers).has("authorization")) {
				return new Response(
					JSON.stringify({
						error: {
							code: "NOT_AUTHENTICATED",
							message: "需要登入",
							details: {},
						},
					}),
					{ status: 401, headers: { "content-type": "application/json" } },
				);
			}
			// 用 Object.entries 一次拿到 handler，而不是先找 key 再回頭索引。
			// 後者在 noUncheckedIndexedAccess 之下是 `T | undefined`，
			// 需要一個 non-null assertion 才過得了型別——而那正是
			// Biome 的 noNonNullAssertion 在擋的東西。
			const handler = Object.entries(routes).find(([path]) =>
				url.includes(path),
			)?.[1];
			if (handler === undefined)
				throw new Error(`測試沒有為這個路徑準備回應：${url}`);
			return handler();
		});
}

function json(body: unknown) {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
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

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("今日總覽", () => {
	it("不傳 date 參數——日界線由伺服器決定", async () => {
		// 規格 §5.3 與後端 app/days.py：省略 ?date= 時後端用
		// today_in_timezone(user.timezone)。前端自己算「今天」就是建立
		// 第二個事實來源，而且在使用者時區跟瀏覽器時區不同時會靜默算錯
		// ——大部分時候對，只在午夜前後錯。
		const fetchMock = mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));
		await screen.findByText(/1800/);

		const statsCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/stats/daily"),
		);
		expect(String(statsCall?.[0])).toBe("/api/stats/daily");
	});

	it("顯示攝取與目標的比例", async () => {
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByText(/1800/)).toBeInTheDocument();
		expect(screen.getByText(/2000/)).toBeInTheDocument();
	});

	it("某一項沒設目標時只有那一項顯示未設定，其他照常", async () => {
		// 規格 §5.7 的第二層 null：target 存在、但 fat_g 是 null。
		// 把兩層混為一談的話，這個畫面會整個顯示成「尚未設定目標」。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		const fatRow = await screen.findByTestId("macro-fat_g");
		expect(fatRow).toHaveTextContent("未設定");
		expect(screen.getByTestId("macro-protein_g")).not.toHaveTextContent(
			"未設定",
		);
	});

	it("整天沒有目標時顯示的是「尚未設定目標」，不是四個未設定", async () => {
		// 第一層 null：target 整個是 null。
		mockApi({
			"/api/stats/daily": () =>
				json({ ...STATS_WITH_TARGET, target: null, ratio: null }),
			"/api/supplements/today": () => json([]),
		});

		render(wrap(<Today />));

		expect(await screen.findByText("尚未設定目標")).toBeInTheDocument();
	});

	it("有計畫但還沒打卡的補劑可以打卡", async () => {
		const fetchMock = mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: 1,
						supplement_id: 7,
						supplement_name: "魚油",
						dose: "1.00",
						time_of_day: "morning",
						done: false,
						intake_id: null,
					},
				]),
			"/api/supplement-intakes": () => json({ id: 99 }),
		});

		render(wrap(<Today />));
		await userEvent.click(await screen.findByRole("button", { name: /打卡/ }));

		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						String(input).includes("/api/supplement-intakes") &&
						init?.method === "POST",
				),
			).toBe(true);
		});
	});

	it("臨時記錄沒有打卡按鈕——它一定已經完成了", async () => {
		// 規格 §5.8：plan_id 為 null 代表這是一筆臨時記錄（沒有對應的固定
		// 計畫），這種項目一定 done: true。給它一個「打卡」按鈕是沒有意義的。
		mockApi({
			"/api/stats/daily": () => json(STATS_WITH_TARGET),
			"/api/supplements/today": () =>
				json([
					{
						plan_id: null,
						supplement_id: 7,
						supplement_name: "臨時吃的",
						dose: "1.00",
						time_of_day: null,
						done: true,
						intake_id: 55,
					},
				]),
		});

		render(wrap(<Today />));
		await screen.findByText("臨時吃的");

		expect(
			screen.queryByRole("button", { name: /打卡/ }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: /取消/ })).toBeInTheDocument();
	});

	it("強制登出會清掉 query 快取", async () => {
		// 規格 §6.5：不清的話，下一個登入的人會先看到上一個人的今日總覽，
		// 然後才被重新 fetch 覆蓋掉——**那是使用者會親眼看到的跨使用者
		// 資料外洩**，不是理論上的。
		const { clearQueryCacheOnForcedLogout } = await import(
			"../src/api/queries"
		);
		const client = new QueryClient();
		client.setQueryData(queryKeys.dailyStats, { marker: "前一個使用者的資料" });

		clearQueryCacheOnForcedLogout(client);

		expect(client.getQueryData(queryKeys.dailyStats)).toBeUndefined();
	});
});
