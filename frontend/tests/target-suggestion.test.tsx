import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { TargetSuggestion } from "../src/components/TargetSuggestion";
import { SUGGESTION_DISCLAIMER } from "../src/lib/body";
import {
	bodyRoutes,
	EMPTY_PROFILE,
	READY_SUGGESTION,
} from "./helpers/body-routes";
import { type Route as ApiRoute, json, mockApi } from "./helpers/mock-api";

const READY = READY_SUGGESTION;

const PROFILE = {
	...EMPTY_PROFILE,
	sex: "male",
	goal: "lose",
	rate_kg_per_week: "0.50",
};

const SAVED = {
	id: 9,
	kcal: "2110.00",
	protein_g: "144.00",
	fat_g: "59.00",
	carb_g: "251.00",
	label: null,
	effective_from: "2026-10-14",
	effective_to: null,
};

function newClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
}

function renderSection(routes: ApiRoute[], client = newClient()) {
	const spy = mockApi(routes);
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/me/targets"]}>
				<Routes>
					<Route path="/me/targets" element={<TargetSuggestion />} />
					<Route path="/me/health" element={<h1>身體與目標</h1>} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { spy, client };
}

function applyRoute(handler: () => Response | Promise<Response>) {
	return { method: "POST", path: "/api/me/target-suggestion/apply", handler };
}

function errorResponse(status: number, code: string, message: string) {
	return json({ error: { code, message, details: {} } }, status);
}

function posts(spy: ReturnType<typeof mockApi>) {
	return spy.mock.calls
		.filter(([, init]) => init?.method === "POST")
		.map(([url, init]) => ({
			url: String(url),
			body: JSON.parse(String(init?.body)),
		}));
}

function suggestionGets(spy: ReturnType<typeof mockApi>) {
	return spy.mock.calls.filter(
		([url, init]) =>
			(init?.method ?? "GET") === "GET" &&
			String(url).includes("/api/me/target-suggestion"),
	).length;
}

function section() {
	return within(screen.getByTestId("suggestion"));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("建議目標", () => {
	it("四個數字、怎麼算出來的、依哪一天的體重、免責聲明", async () => {
		renderSection(bodyRoutes({ suggestion: READY, profile: PROFILE }));

		expect(
			await screen.findByRole("heading", { name: "建議目標" }),
		).toBeInTheDocument();
		expect(await section().findByTestId("suggestion-kcal")).toHaveTextContent(
			"2110 kcal",
		);
		expect(section().getByText("144 g")).toBeInTheDocument();
		expect(section().getByText("59 g")).toBeInTheDocument();
		expect(section().getByText("251 g")).toBeInTheDocument();
		// 調整那一段的速度來自身體資料（建議的回應只有調整量）。
		expect(
			await section().findByText(
				"基礎代謝 1719 kcal，乘上活動量是每日消耗 2664 kcal；減重每週 0.5 公斤 -550 kcal",
			),
		).toBeInTheDocument();
		expect(section().getByText("依 10/10 的體重 80 公斤")).toBeInTheDocument();
		expect(section().getByText(SUGGESTION_DISCLAIMER)).toBeInTheDocument();
		expect(section().queryByText(/已調到最低建議熱量/)).not.toBeInTheDocument();
	});

	it("維持：「維持體重，不加不減」；增重寫 +", async () => {
		renderSection(
			bodyRoutes({
				suggestion: { ...READY, adjustment_kcal: "0" },
				profile: { ...PROFILE, goal: "maintain" },
			}),
		);
		expect(
			await section().findByText(
				"基礎代謝 1719 kcal，乘上活動量是每日消耗 2664 kcal；維持體重，不加不減",
			),
		).toBeInTheDocument();
	});

	it("增重：速度與 +275 kcal", async () => {
		renderSection(
			bodyRoutes({
				suggestion: { ...READY, adjustment_kcal: "275" },
				profile: { ...PROFILE, goal: "gain", rate_kg_per_week: "0.25" },
			}),
		);
		expect(
			await section().findByText(/；增重每週 0.25 公斤 \+275 kcal$/),
		).toBeInTheDocument();
	});

	it("身體資料讀不到：調整那一段省略速度，只寫「減重 -550 kcal」", async () => {
		renderSection([
			{
				method: "GET",
				path: "/api/me/body-profile",
				handler: () => new Response("boom", { status: 500 }),
			},
			...bodyRoutes({ suggestion: READY }),
		]);
		expect(await section().findByText(/；減重 -550 kcal$/)).toBeInTheDocument();
	});

	it("套用了下限：多一行「已調到最低建議熱量」", async () => {
		renderSection(
			bodyRoutes({
				suggestion: { ...READY, floor_applied: true, floor_kcal: "1200" },
				profile: PROFILE,
			}),
		);
		expect(
			await section().findByText("已調到最低建議熱量 1200 kcal"),
		).toBeInTheDocument();
	});

	it("套用：送畫面上的四個數字（字串原樣），回 /me/health；統計、趨勢、[body] 都失效", async () => {
		const client = newClient();
		const rangeKey = queryKeys.rangeStats("2026-10-08", "2026-10-14");
		client.setQueryData(rangeKey, []);
		client.setQueryData(queryKeys.dailyStats, { date: "2026-10-14" });
		client.setQueryData(queryKeys.weights, {
			today: "2026-10-14",
			entries: [],
		});
		const { spy } = renderSection(
			[applyRoute(() => json(SAVED)), ...bodyRoutes({ suggestion: READY })],
			client,
		);

		await userEvent.click(
			await screen.findByRole("button", { name: "套用建議目標" }),
		);

		expect(
			await screen.findByRole("heading", { name: "身體與目標" }),
		).toBeInTheDocument();
		expect(posts(spy)).toEqual([
			{
				url: "/api/me/target-suggestion/apply",
				body: { kcal: "2110", protein_g: "144", fat_g: "59", carb_g: "251" },
			},
		]);
		for (const key of [rangeKey, queryKeys.dailyStats, queryKeys.weights]) {
			expect(client.getQueryState(key)?.isInvalidated).toBe(true);
		}
	});

	it("409 建議變了：說一聲、重抓建議、留在這一頁；送出中按鈕是 aria-disabled、焦點還在它身上", async () => {
		let respond: (response: Response) => void = () => undefined;
		const { spy } = renderSection([
			applyRoute(
				() =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			),
			...bodyRoutes({ suggestion: READY }),
		]);

		const button = await screen.findByRole("button", { name: "套用建議目標" });
		await userEvent.click(button);
		await waitFor(() =>
			expect(button).toHaveAttribute("aria-disabled", "true"),
		);
		expect(button).not.toBeDisabled();
		expect(button).toHaveFocus();
		// 送出中再按：不會送第二次。
		await userEvent.click(button);
		expect(posts(spy)).toHaveLength(1);
		expect(suggestionGets(spy)).toBe(1);

		respond(errorResponse(409, "SUGGESTION_CHANGED", "建議目標已經變了"));

		expect(await section().findByRole("alert")).toHaveTextContent(
			"建議目標剛剛變了，請看過新的數字再套用",
		);
		await waitFor(() => expect(suggestionGets(spy)).toBe(2));
		expect(screen.queryByRole("heading", { name: "身體與目標" })).toBeNull();
		expect(
			screen.getByRole("button", { name: "套用建議目標" }),
		).not.toHaveAttribute("aria-disabled", "true");
	});

	it("422 資料不全（另一個分頁剛刪了體重）：重抓建議，畫面換成缺什麼（審查 M4）", async () => {
		let suggestion: unknown = READY;
		const { spy } = renderSection([
			// 伺服器上的狀態在按下去之前就變了：之後再讀建議就是缺體重。
			applyRoute(() => {
				suggestion = { ready: false, missing: ["weight"] };
				return json(
					{
						error: {
							code: "PROFILE_INCOMPLETE",
							message: "身體資料或體重還沒填完",
							details: { missing: ["weight"] },
						},
					},
					422,
				);
			}),
			{
				method: "GET",
				path: "/api/me/target-suggestion",
				handler: () => json(suggestion),
			},
			...bodyRoutes(),
		]);

		await userEvent.click(
			await screen.findByRole("button", { name: "套用建議目標" }),
		);

		expect(await section().findByText("還差：體重")).toBeInTheDocument();
		expect(suggestionGets(spy)).toBe(2);
		expect(
			section().getByRole("link", { name: "記錄體重" }),
		).toBeInTheDocument();
		expect(
			section().queryByRole("button", { name: "套用建議目標" }),
		).not.toBeInTheDocument();
		expect(screen.queryByRole("heading", { name: "身體與目標" })).toBeNull();
	});

	it("422 資料不全、重抓回來又是建議（資料剛好又補上了）：說一聲，不是「套用失敗」", async () => {
		const { spy } = renderSection([
			applyRoute(() =>
				json(
					{
						error: {
							code: "PROFILE_INCOMPLETE",
							message: "身體資料或體重還沒填完",
							details: { missing: ["weight"] },
						},
					},
					422,
				),
			),
			...bodyRoutes({ suggestion: READY }),
		]);

		await userEvent.click(
			await screen.findByRole("button", { name: "套用建議目標" }),
		);

		expect(await section().findByRole("alert")).toHaveTextContent(
			"身體資料或體重剛剛變了，已經重新整理建議",
		);
		await waitFor(() => expect(suggestionGets(spy)).toBe(2));
	});

	it("其他 409（目標剛被另一台改過）：顯示後端的訊息", async () => {
		renderSection([
			applyRoute(() =>
				errorResponse(
					409,
					"TARGET_CONFLICT",
					"目標剛被另一台裝置改過，請重新整理再試",
				),
			),
			...bodyRoutes({ suggestion: READY }),
		]);

		await userEvent.click(
			await screen.findByRole("button", { name: "套用建議目標" }),
		);
		expect(await section().findByRole("alert")).toHaveTextContent(
			"目標剛被另一台裝置改過，請重新整理再試",
		);
	});

	it("其他錯誤：「套用失敗，請再試一次」", async () => {
		renderSection([
			applyRoute(() => new Response("boom", { status: 500 })),
			...bodyRoutes({ suggestion: READY }),
		]);

		await userEvent.click(
			await screen.findByRole("button", { name: "套用建議目標" }),
		);
		expect(await section().findByRole("alert")).toHaveTextContent(
			"套用失敗，請再試一次",
		);
	});

	it("缺資料：列出缺什麼，連到身體資料與記錄體重；沒有「套用」；免責聲明照樣在", async () => {
		renderSection(
			bodyRoutes({
				suggestion: { ready: false, missing: ["sex", "goal", "weight"] },
			}),
		);

		expect(
			await section().findByText("還差：性別、目標、體重"),
		).toBeInTheDocument();
		expect(
			section().getByRole("link", { name: "填寫身體資料" }),
		).toHaveAttribute("href", "/me/body");
		expect(section().getByRole("link", { name: "記錄體重" })).toHaveAttribute(
			"href",
			"/weight",
		);
		expect(
			section().queryByRole("button", { name: "套用建議目標" }),
		).not.toBeInTheDocument();
		expect(section().getByText(SUGGESTION_DISCLAIMER)).toBeInTheDocument();
	});

	it("只缺體重：只有「記錄體重」；只缺身體資料：只有「填寫身體資料」", async () => {
		renderSection(
			bodyRoutes({ suggestion: { ready: false, missing: ["weight"] } }),
		);
		expect(
			await section().findByRole("link", { name: "記錄體重" }),
		).toBeInTheDocument();
		expect(
			section().queryByRole("link", { name: "填寫身體資料" }),
		).not.toBeInTheDocument();
	});

	it("只缺身體資料：只有「填寫身體資料」", async () => {
		renderSection(
			bodyRoutes({ suggestion: { ready: false, missing: ["height_cm"] } }),
		);
		expect(
			await section().findByRole("link", { name: "填寫身體資料" }),
		).toBeInTheDocument();
		expect(
			section().queryByRole("link", { name: "記錄體重" }),
		).not.toBeInTheDocument();
	});

	it("讀不到：「無法載入建議目標」，免責聲明照樣在", async () => {
		renderSection([
			{
				method: "GET",
				path: "/api/me/target-suggestion",
				handler: () => new Response("boom", { status: 500 }),
			},
			...bodyRoutes(),
		]);

		expect(await section().findByText("無法載入建議目標")).toBeInTheDocument();
		expect(section().getByText(SUGGESTION_DISCLAIMER)).toBeInTheDocument();
	});
});
