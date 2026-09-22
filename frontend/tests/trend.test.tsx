import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Trend } from "../src/screens/Trend";
import { json, mockApi } from "./helpers/mock-api";

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

function macros(kcal: string) {
	return { kcal, protein_g: "0.00", fat_g: "0.00", carb_g: "0.00" };
}

const DAILY = {
	date: "2026-09-21",
	actual: macros("1800.00"),
	target: null,
	ratio: null,
	breakdown: { food: macros("1800.00"), supplement: macros("0.00") },
};

function rangeBody(adherence: string | null) {
	return {
		date_from: "2026-09-15",
		date_to: "2026-09-21",
		adherence,
		trend: [
			"2026-09-15",
			"2026-09-16",
			"2026-09-17",
			"2026-09-18",
			"2026-09-19",
			"2026-09-20",
			"2026-09-21",
		].map((date) => ({
			date,
			actual: macros("1800.00"),
			target: null,
			ratio: null,
		})),
	};
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("趨勢畫面", () => {
	it("from / to 是從 stats/daily 回的 date 推出來的，不是前端自己算今天", async () => {
		// **這條是這個畫面的核心保證（規格 §4.1）。**
		//
		// mock 回的「今天」是 2026-09-21，跟這台機器真正的今天無關。
		// 如果實作偷懶用 new Date() 算今天，這裡請求的 from/to 就會是
		// 執行測試的那一天，而不是 09-15 / 09-21——斷言會紅。
		//
		// 這也是為什麼 mock 的日期刻意寫死成一個不可能剛好等於
		// 「執行日」的值：等於的話，錯誤的實作也會通過。
		const fetchMock = mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		const rangeCall = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/stats/range"),
		);
		expect(rangeCall).toBeDefined();
		expect(String(rangeCall?.[0])).toContain("from=2026-09-15");
		expect(String(rangeCall?.[0])).toContain("to=2026-09-21");
	});

	it("錨點還沒回來之前不打 range —— from/to 是必填，沒有錨點就沒得問", async () => {
		// GET /api/stats/range 的 from/to 沒有 default（app/api/routes/stats.py）。
		// 少帶會拿到 422，而那個 422 在畫面上會長得像「趨勢壞了」。
		const fetchMock = mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));

		// 第一批請求裡不該有 range——daily 還沒回來。
		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).includes("/api/stats/range"),
			),
		).toHaveLength(0);

		// 等錨點回來之後才出現。
		await screen.findByTestId("trend-chart");
		expect(
			fetchMock.mock.calls.filter(([input]) =>
				String(input).includes("/api/stats/range"),
			).length,
		).toBeGreaterThan(0);
	});

	it("七天全部畫出來", async () => {
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		expect(screen.getAllByTestId(/^trend-bar-/)).toHaveLength(7);
	});

	it("有依從率時顯示百分比", async () => {
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody("0.85")) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));

		expect(await screen.findByTestId("adherence")).toHaveTextContent("85%");
	});

	it("adherence 是 null 時說沒有計畫，不是 0%", async () => {
		// app/schemas/stats.py 寫明：0 會讀成「一次都沒吃」，1 會讀成
		// 「全部做到」，null 的意思是「沒有計畫，這個比率沒有定義」。
		// 顯示成 0% 是把「沒有標準」講成「做得很差」。
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);

		render(wrap(<Trend />));

		const adherence = await screen.findByTestId("adherence");
		expect(adherence).toHaveTextContent("沒有補劑計畫");
		expect(adherence).not.toHaveTextContent("0%");
	});
});
