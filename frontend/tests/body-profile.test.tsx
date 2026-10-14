import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useBodyProfile } from "../src/api/body";
import {
	createOfflinePersistOptions,
	OFFLINE_CACHE_STORAGE_KEY,
} from "../src/api/persist";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { BodyProfile } from "../src/screens/BodyProfile";
import { EMPTY_PROFILE } from "./helpers/body-routes";
import { json, mockApi } from "./helpers/mock-api";

/** 伺服器上現在的那一份（減重、每週 0.5、沒有目標體重）。 */
const PROFILE = {
	sex: "male",
	birth_year: 1990,
	height_cm: "175.0",
	activity_level: "moderate",
	goal: "lose",
	rate_kg_per_week: "0.50",
	target_weight_kg: null,
};

/** 快取裡的舊的那一份：每一格都跟 PROFILE 不一樣，預填用錯哪一份都看得出來。 */
const OLD = {
	sex: "female",
	birth_year: 1985,
	height_cm: "160.0",
	activity_level: "light",
	goal: "gain",
	rate_kg_per_week: "0.25",
	target_weight_kg: "55.00",
};

function profileRoute(body: unknown = PROFILE, status = 200) {
	return {
		method: "GET",
		path: "/api/me/body-profile",
		handler: () => json(body, status),
	};
}

function putRoute(handler: () => Response | Promise<Response>) {
	return { method: "PUT", path: "/api/me/body-profile", handler };
}

function errorResponse(status: number, code: string, message: string) {
	return json({ error: { code, message, details: {} } }, status);
}

function putBodies(spy: ReturnType<typeof mockApi>): unknown[] {
	return spy.mock.calls
		.filter(([, init]) => init?.method === "PUT")
		.map(([, init]) => JSON.parse(String(init?.body)));
}

function profileGets(spy: ReturnType<typeof mockApi>): number {
	return spy.mock.calls.filter(
		([input, init]) =>
			(init?.method ?? "GET") === "GET" &&
			String(input).includes("/api/me/body-profile"),
	).length;
}

/** 斷言「沒有送出」之前先等一下：mutate 是非同步的，立刻斷言在守衛壞掉時也成立（第 41 種）。 */
function settle(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 50));
}

function newClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
}

/** QueryClient 由測試建立：要讀快取、證明失效。`staleTime` 跟 app 一樣是 60 秒。 */
function renderScreen(client = newClient()) {
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/me/body"]}>
				<Routes>
					<Route path="/me/body" element={<BodyProfile />} />
					<Route path="/me" element={<h1>我的</h1>} />
				</Routes>
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

describe("/me/body", () => {
	it("預填的是掛載之後抓回來的那一份，不是快取裡的舊值", async () => {
		let respond: (response: Response) => void = () => undefined;
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/me/body-profile",
				handler: () =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			},
		]);
		const client = newClient();
		// 還新鮮的快取（60 秒內）：沒有特別要求的話，掛載不會重抓。
		client.setQueryData(queryKeys.bodyProfile, OLD);
		renderScreen(client);

		await waitFor(() => expect(profileGets(spy)).toBe(1));
		expect(screen.getByText("載入中…")).toBeInTheDocument();
		expect(screen.queryByLabelText("身高（cm）")).not.toBeInTheDocument();

		respond(json(PROFILE));

		expect(await screen.findByLabelText("身高（cm）")).toHaveValue("175");
		expect(screen.getByLabelText("出生年")).toHaveValue("1990");
		expect(screen.getByLabelText("目標體重（kg，選填）")).toHaveValue("");
		expect(screen.getByRole("radio", { name: "男" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "減重" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "每週 0.5 公斤" })).toBeChecked();
		expect(screen.getByRole("combobox", { name: "活動量" })).toHaveValue(
			"moderate",
		);
		expect(screen.queryByDisplayValue("160")).not.toBeInTheDocument();
	});

	it("還沒填過（七個都是 null）：空白的表單，什麼都沒選", async () => {
		mockApi([profileRoute(EMPTY_PROFILE)]);
		renderScreen();

		expect(await screen.findByLabelText("身高（cm）")).toHaveValue("");
		expect(screen.getByLabelText("出生年")).toHaveValue("");
		expect(screen.getByRole("radio", { name: "男" })).not.toBeChecked();
		expect(screen.getByRole("radio", { name: "女" })).not.toBeChecked();
		expect(screen.getByRole("combobox", { name: "活動量" })).toHaveValue("");
		// 沒選目標：速度不出現（不知道是減重還是增重）。
		expect(
			screen.queryByRole("group", { name: "速度" }),
		).not.toBeInTheDocument();
	});

	it("讀不到就不給表單：「無法載入身體資料」，沒有「儲存」", async () => {
		mockApi([
			profileRoute(
				{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
				500,
			),
		]);
		renderScreen();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"無法載入身體資料",
		);
		expect(
			screen.queryByRole("button", { name: "儲存" }),
		).not.toBeInTheDocument();
	});

	it("送出整組七個鍵：維持時速度藏起來但照送原本的值、空白的目標體重是 null；存好回 /me、失效 [body]", async () => {
		const spy = mockApi([
			profileRoute(),
			putRoute(() => json({ ...PROFILE, goal: "maintain" })),
		]);
		const client = renderScreen();
		// 建議不在這一頁掛著：失效之後不會重抓，`isInvalidated` 留著，看得到。
		client.setQueryData(queryKeys.targetSuggestion, {
			ready: false,
			missing: ["weight"],
		});

		const height = await screen.findByLabelText("身高（cm）");
		await userEvent.clear(height);
		await userEvent.type(height, " 176.5 ");
		await userEvent.click(screen.getByRole("radio", { name: "維持" }));
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		expect(
			await screen.findByRole("heading", { name: "我的" }),
		).toBeInTheDocument();
		expect(putBodies(spy)).toEqual([
			{
				sex: "male",
				birth_year: 1990,
				height_cm: "176.5",
				activity_level: "moderate",
				goal: "maintain",
				rate_kg_per_week: "0.5",
				target_weight_kg: null,
			},
		]);
		expect(
			client.getQueryState(queryKeys.targetSuggestion)?.isInvalidated,
		).toBe(true);
	});

	it("速度只在減重、增重時出現", async () => {
		mockApi([profileRoute()]);
		renderScreen();

		expect(
			await screen.findByRole("group", { name: "速度" }),
		).toBeInTheDocument();
		await userEvent.click(screen.getByRole("radio", { name: "維持" }));
		expect(
			screen.queryByRole("group", { name: "速度" }),
		).not.toBeInTheDocument();
		await userEvent.click(screen.getByRole("radio", { name: "增重" }));
		const rate = screen.getByRole("group", { name: "速度" });
		// 切回來時原本選的還在（維持時沒有清掉）。
		expect(
			within(rate).getByRole("radio", { name: "每週 0.5 公斤" }),
		).toBeChecked();
	});

	it("前端擋範圍：身高 99、目標體重 24.9、出生年 199 → 三則錯誤，不送出", async () => {
		// PUT 掛著不回：守衛壞掉時請求送出去了、畫面不會導走，紅的是「沒有 PUT」那一行。
		const spy = mockApi([
			profileRoute(),
			putRoute(() => new Promise<Response>(() => {})),
		]);
		renderScreen();

		const height = await screen.findByLabelText("身高（cm）");
		await userEvent.clear(height);
		await userEvent.type(height, "99");
		await userEvent.type(screen.getByLabelText("目標體重（kg，選填）"), "24.9");
		const birth = screen.getByLabelText("出生年");
		await userEvent.clear(birth);
		await userEvent.type(birth, "199");
		await userEvent.click(screen.getByRole("button", { name: "儲存" }));

		const alert = await screen.findByRole("alert");
		expect(within(alert).getAllByRole("listitem")).toHaveLength(3);
		expect(alert).toHaveTextContent("出生年要是四位數的西元年");
		expect(alert).toHaveTextContent("身高要在 100 到 250 公分之間");
		expect(alert).toHaveTextContent("目標體重要在 25 到 350 公斤之間");
		await settle();
		expect(putBodies(spy)).toHaveLength(0);
	});

	it("後端的 422（出生年超出範圍）：顯示後端的訊息，留在這一頁", async () => {
		mockApi([
			profileRoute(),
			putRoute(() =>
				errorResponse(
					422,
					"BIRTH_YEAR_OUT_OF_RANGE",
					"出生年要在 1926 到 2013 之間",
				),
			),
		]);
		renderScreen();

		await userEvent.click(await screen.findByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"出生年要在 1926 到 2013 之間",
		);
		expect(screen.getByLabelText("身高（cm）")).toBeInTheDocument();
	});

	it("其他錯誤：「儲存失敗，請再試一次」", async () => {
		mockApi([
			profileRoute(),
			putRoute(() => new Response("boom", { status: 500 })),
		]);
		renderScreen();

		await userEvent.click(await screen.findByRole("button", { name: "儲存" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"儲存失敗，請再試一次",
		);
	});

	it("可及性：性別、目標、速度各是一組；活動量是下拉選單，選項帶說明", async () => {
		mockApi([profileRoute()]);
		renderScreen();

		const sex = await screen.findByRole("group", { name: "性別" });
		expect(within(sex).getAllByRole("radio")).toHaveLength(2);
		const goal = screen.getByRole("group", { name: "目標" });
		expect(within(goal).getAllByRole("radio")).toHaveLength(3);
		const rate = screen.getByRole("group", { name: "速度" });
		expect(within(rate).getAllByRole("radio")).toHaveLength(2);
		const activity = screen.getByRole("combobox", { name: "活動量" });
		expect(
			within(activity).getByRole("option", { name: "中度（每週運動 3–5 天）" }),
		).toBeInTheDocument();
		expect(screen.getByLabelText("身高（cm）")).toHaveAttribute(
			"inputmode",
			"decimal",
		);
		expect(screen.getByLabelText("出生年")).toHaveAttribute(
			"inputmode",
			"numeric",
		);
	});
});

// 整頁重新載入停在 /me/body（同 targets.test.tsx 的那一組，D27）：還原離線快取期間建立的
// observer 記下的是空的狀態，還原把 localStorage 裡的舊資料蓋上去之後 `isFetchedAfterMount`
// 就是 true——一個請求都還沒回來，舊值已經被當成新鮮的填進表單。
describe("/me/body：整頁重新載入，離線快取裡有舊的身體資料", () => {
	function wrap(client: QueryClient, at: string) {
		return (
			<PersistQueryClientProvider
				client={client}
				persistOptions={createOfflinePersistOptions(window.localStorage)}
			>
				<MemoryRouter initialEntries={[at]}>
					<Routes>
						<Route path="/" element={<Probe />} />
						<Route path="/me/body" element={<BodyProfile />} />
					</Routes>
				</MemoryRouter>
			</PersistQueryClientProvider>
		);
	}

	/** 上一次載入：「我的」的卡片讀過身體資料，它就進了離線快取。 */
	function Probe() {
		const profile = useBodyProfile();
		return <p>上一次載入：{profile.data?.height_cm ?? "還沒有"}</p>;
	}

	async function persistOldProfile() {
		mockApi([profileRoute(OLD)]);
		const first = render(wrap(newClient(), "/"));
		await screen.findByText("上一次載入：160.0");
		await waitFor(
			() =>
				expect(localStorage.getItem(OFFLINE_CACHE_STORAGE_KEY) ?? "").toContain(
					"160.0",
				),
			{ timeout: 3000 },
		);
		first.unmount();
		vi.restoreAllMocks();
	}

	it("還原期間不預填：重抓回來之前沒有表單，回來之後是新的值", async () => {
		await persistOldProfile();
		let respond: (response: Response) => void = () => undefined;
		const spy = mockApi([
			{
				method: "GET",
				path: "/api/me/body-profile",
				handler: () =>
					new Promise<Response>((resolve) => {
						respond = resolve;
					}),
			},
		]);
		render(wrap(newClient(), "/me/body"));

		// 重抓發出去＝還原已經做完了；再等一下，還原的結果是排程之後才通知畫面的。
		await waitFor(() => expect(profileGets(spy)).toBe(1));
		await act(() => settle());
		expect(screen.queryByLabelText("身高（cm）")).not.toBeInTheDocument();
		expect(screen.queryByDisplayValue("160")).not.toBeInTheDocument();
		expect(screen.getByText("載入中…")).toBeInTheDocument();

		respond(json(PROFILE));

		expect(await screen.findByLabelText("身高（cm）")).toHaveValue("175");
		expect(screen.getByLabelText("目標體重（kg，選填）")).toHaveValue("");
	});
});
