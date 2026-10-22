import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
	cleanup,
	render,
	screen,
	waitFor,
	within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { BodyHub } from "../src/screens/BodyHub";
import {
	bodyRoutes,
	EMPTY_PROFILE,
	READY_SUGGESTION,
} from "./helpers/body-routes";
import { json, mockApi, type Route } from "./helpers/mock-api";

function me(role: "user" | "admin") {
	return {
		id: 1,
		email: "kenny@example.com",
		display_name: "Kenny",
		role,
		timezone: "Asia/Taipei",
	};
}

// 身體與目標的每日目標卡片會打 /api/stats/daily（帳號設定規格 §5.1）。每一條測試都明確準備它：
// 沒準備的話 mock 丟例外、卡片顯示「無法載入」——既有的斷言不會因此紅，但那是靠「丟例外也沒關係」，不好讀。
const ZERO = { kcal: "0", protein_g: "0", fat_g: "0", carb_g: "0" };
const STATS = {
	date: "2019-07-04",
	actual: ZERO,
	target: { kcal: "1800.00", protein_g: "120.00", fat_g: null, carb_g: null },
	ratio: { kcal: "0.00", protein_g: "0.00", fat_g: null, carb_g: null },
	breakdown: { food: ZERO, supplement: ZERO },
};

function statsRoute(body: unknown = STATS, status = 200) {
	return {
		method: "GET",
		path: "/api/stats/daily",
		handler: () => json(body, status),
	};
}

function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return (
		<QueryClientProvider client={client}>
			<MemoryRouter>{children}</MemoryRouter>
		</QueryClientProvider>
	);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("身體與目標：每日目標卡片的重算提示（身體資料規格 §6.6）", () => {
	function renderWith(suggestion: unknown) {
		mockApi([
			...bodyRoutes({ suggestion }),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));
		return screen.getByTestId("targets-card");
	}

	it("resuggest：「體重變了 -1.5 公斤，要重算建議目標嗎？」，連到 /me/targets", async () => {
		const card = renderWith({
			...READY_SUGGESTION,
			applied_weight_kg: "80.00",
			weight_change_kg: "-1.50",
			resuggest: true,
		});

		expect(
			await within(card).findByText("體重變了 -1.5 公斤，要重算建議目標嗎？"),
		).toBeInTheDocument();
		expect(
			within(card).getByRole("link", { name: "重算建議目標" }),
		).toHaveAttribute("href", "/me/targets");
	});

	it("變重了寫 +", async () => {
		const card = renderWith({
			...READY_SUGGESTION,
			applied_weight_kg: "80.00",
			weight_change_kg: "1.00",
			resuggest: true,
		});
		expect(
			await within(card).findByText("體重變了 +1 公斤，要重算建議目標嗎？"),
		).toBeInTheDocument();
	});

	it("resuggest 是 false、或建議還沒準備好：沒有提示", async () => {
		const card = renderWith({
			...READY_SUGGESTION,
			applied_weight_kg: "80.00",
			weight_change_kg: "-0.50",
			resuggest: false,
		});
		// 先等卡片的目標載入完（第 41 種）。
		await within(card).findByText("1800 kcal");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(within(card).queryByText(/體重變了/)).not.toBeInTheDocument();
		expect(
			within(card).queryByRole("link", { name: "重算建議目標" }),
		).not.toBeInTheDocument();
		cleanup();
		vi.restoreAllMocks();

		const second = renderWith({ ready: false, missing: ["weight"] });
		await within(second).findByText("1800 kcal");
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(within(second).queryByText(/體重變了/)).not.toBeInTheDocument();
	});
});

describe("身體與目標：每日目標卡片", () => {
	it("顯示四個值，沒設的寫「未設定」，連到 /me/targets", async () => {
		mockApi([
			...bodyRoutes(),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));

		const card = await screen.findByTestId("targets-card");
		expect(
			within(card).getByRole("heading", { name: "每日目標" }),
		).toBeInTheDocument();
		expect(await within(card).findByText("1800 kcal")).toBeInTheDocument();
		expect(within(card).getByText("120 g")).toBeInTheDocument();
		expect(within(card).getAllByText("未設定")).toHaveLength(2);
		expect(
			within(card).getByRole("link", { name: "修改每日目標" }),
		).toHaveAttribute("href", "/me/targets");
	});

	it("今天沒有目標（target 是 null）：四格都是「未設定」", async () => {
		mockApi([
			...bodyRoutes(),
			statsRoute({ ...STATS, target: null, ratio: null }),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));

		const card = await screen.findByTestId("targets-card");
		await waitFor(() =>
			expect(within(card).getAllByText("未設定")).toHaveLength(4),
		);
	});

	it("讀不到統計：「無法載入目前的目標」", async () => {
		mockApi([
			...bodyRoutes(),
			statsRoute(
				{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
				500,
			),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));

		const card = await screen.findByTestId("targets-card");
		expect(
			await within(card).findByText("無法載入目前的目標"),
		).toBeInTheDocument();
		expect(within(card).queryByText("未設定")).not.toBeInTheDocument();
	});
});

describe("身體與目標：身體資料卡片", () => {
	function renderWith(profile: unknown) {
		mockApi([
			...bodyRoutes({ profile }),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));
		return screen.getByTestId("body-profile-card");
	}

	it("還沒填：「還沒有填」，「修改身體資料」連到 /me/body", async () => {
		const card = renderWith(EMPTY_PROFILE);

		expect(await within(card).findByText("還沒有填")).toBeInTheDocument();
		expect(
			within(card).getByRole("heading", { name: "身體資料" }),
		).toBeInTheDocument();
		expect(
			within(card).getByRole("link", { name: "修改身體資料" }),
		).toHaveAttribute("href", "/me/body");
	});

	it("填了：一行摘要，用「・」隔開", async () => {
		const card = renderWith({
			sex: "male",
			birth_year: 1990,
			height_cm: "175.0",
			activity_level: "moderate",
			goal: "lose",
			rate_kg_per_week: "0.50",
			target_weight_kg: "72.00",
		});

		expect(
			await within(card).findByText(
				"男・1990 年生・175 cm・中度活動・減重每週 0.5 公斤・目標 72 公斤",
			),
		).toBeInTheDocument();
	});

	it("沒設的段落略過；維持不寫速度；減重沒有速度只寫「減重」", async () => {
		const card = renderWith({
			...EMPTY_PROFILE,
			sex: "female",
			height_cm: "160.5",
			goal: "maintain",
			rate_kg_per_week: "0.25",
		});
		expect(
			await within(card).findByText("女・160.5 cm・維持體重"),
		).toBeInTheDocument();
		cleanup();
		vi.restoreAllMocks();

		const second = renderWith({ ...EMPTY_PROFILE, goal: "gain" });
		expect(await within(second).findByText("增重")).toBeInTheDocument();
	});
});

describe("身體與目標：體重卡片", () => {
	const WEIGHTS = {
		today: "2026-10-14",
		entries: [
			{ date: "2026-10-07", weight_kg: "80.00" },
			{ date: "2026-10-10", weight_kg: "79.60" },
			{ date: "2026-10-14", weight_kg: "79.00" },
		],
	};

	function renderWith(weights: unknown, extra: Route[] = []) {
		const spy = mockApi([
			...extra,
			...bodyRoutes({ weights }),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));
		return { spy, card: screen.getByTestId("weight-card") };
	}

	function puts(spy: ReturnType<typeof mockApi>) {
		return spy.mock.calls
			.filter(([, init]) => init?.method === "PUT")
			.map(([url, init]) => ({ url: String(url), body: init?.body }));
	}

	it("最新一筆與「比 7 天前」：跟 7 天前那一筆比，不是跟前一筆比", async () => {
		const { card } = renderWith(WEIGHTS);

		expect(await within(card).findByText("79 公斤・10/14")).toBeInTheDocument();
		// 前一筆是 10/10 的 79.6（差 −0.6）；7 天前是 10/07 的 80（差 −1）。
		expect(within(card).getByText("比 7 天前 -1 公斤")).toBeInTheDocument();
		expect(
			within(card).getByRole("heading", { name: "體重" }),
		).toBeInTheDocument();
		expect(within(card).getByRole("link", { name: "看全部" })).toHaveAttribute(
			"href",
			"/weight",
		);
	});

	it("變重了寫 +；七天以前沒有紀錄就不寫「比 7 天前」；沒有紀錄寫「還沒有體重紀錄」", async () => {
		const { card } = renderWith({
			today: "2026-10-14",
			entries: [
				{ date: "2026-10-01", weight_kg: "70" },
				{ date: "2026-10-14", weight_kg: "70.5" },
			],
		});
		expect(
			await within(card).findByText("比 7 天前 +0.5 公斤"),
		).toBeInTheDocument();
		cleanup();
		vi.restoreAllMocks();

		const second = renderWith({
			today: "2026-10-14",
			entries: [{ date: "2026-10-10", weight_kg: "70" }],
		}).card;
		expect(
			await within(second).findByText("70 公斤・10/10"),
		).toBeInTheDocument();
		expect(within(second).queryByText(/比 7 天前/)).not.toBeInTheDocument();
		cleanup();
		vi.restoreAllMocks();

		const third = renderWith({ today: "2026-10-14", entries: [] }).card;
		expect(
			await within(third).findByText("還沒有體重紀錄"),
		).toBeInTheDocument();
	});

	it("記錄體重：展開表單（日期預設、上下限是後端給的今天），存了收起來、焦點回到按鈕", async () => {
		const { spy, card } = renderWith(WEIGHTS, [
			{
				method: "PUT",
				path: "/api/weights/2026-10-14",
				handler: () => json({ date: "2026-10-14", weight_kg: "78.50" }),
			},
		]);

		await userEvent.click(
			await within(card).findByRole("button", { name: "記錄體重" }),
		);
		const weight = within(card).getByLabelText("體重（公斤）");
		expect(weight).toHaveFocus();
		expect(weight).toHaveAttribute("inputmode", "decimal");
		const date = within(card).getByLabelText("日期");
		expect(date).toHaveAttribute("type", "date");
		expect(date).toHaveValue("2026-10-14");
		expect(date).toHaveAttribute("max", "2026-10-14");
		expect(date).toHaveAttribute("min", "2024-10-14");

		await userEvent.type(weight, "78.5");
		await userEvent.click(within(card).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(puts(spy)).toEqual([
				{ url: "/api/weights/2026-10-14", body: '{"weight_kg":"78.5"}' },
			]),
		);
		await waitFor(() =>
			expect(
				within(card).getByRole("button", { name: "記錄體重" }),
			).toHaveFocus(),
		);
		expect(
			within(card).queryByLabelText("體重（公斤）"),
		).not.toBeInTheDocument();
	});

	it("體重不合規則不送；取消收起來、焦點回到「記錄體重」", async () => {
		const { spy, card } = renderWith(WEIGHTS, [
			{
				method: "PUT",
				path: "/api/weights/",
				handler: () => new Promise<Response>(() => {}),
			},
		]);

		await userEvent.click(
			await within(card).findByRole("button", { name: "記錄體重" }),
		);
		await userEvent.type(within(card).getByLabelText("體重（公斤）"), "24");
		await userEvent.click(within(card).getByRole("button", { name: "儲存" }));

		expect(await within(card).findByRole("alert")).toHaveTextContent(
			"體重要在 25 到 350 公斤之間，最多兩位小數",
		);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(puts(spy)).toEqual([]);

		await userEvent.click(within(card).getByRole("button", { name: "取消" }));
		expect(
			within(card).getByRole("button", { name: "記錄體重" }),
		).toHaveFocus();
	});

	it("送出中「儲存」是 aria-disabled（焦點還在它身上），再按不會送第二次", async () => {
		const { spy, card } = renderWith(WEIGHTS, [
			{
				method: "PUT",
				path: "/api/weights/",
				handler: () => new Promise<Response>(() => {}),
			},
		]);

		await userEvent.click(
			await within(card).findByRole("button", { name: "記錄體重" }),
		);
		await userEvent.type(within(card).getByLabelText("體重（公斤）"), "78");
		const save = within(card).getByRole("button", { name: "儲存" });
		await userEvent.click(save);
		await waitFor(() => expect(save).toHaveAttribute("aria-disabled", "true"));
		expect(save).not.toBeDisabled();
		await userEvent.click(save);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(puts(spy)).toHaveLength(1);
	});
});

describe("身體與目標：頁面（首頁改版規格 D16）", () => {
	it("標題「身體與目標」；順序：每日目標 → 體重 → 身體資料", async () => {
		mockApi([
			...bodyRoutes(),
			statsRoute(),
			{ method: "GET", path: "/api/me", handler: () => json(me("user")) },
		]);
		render(wrap(<BodyHub />));

		expect(
			screen.getByRole("heading", { level: 1, name: "身體與目標" }),
		).toBeInTheDocument();
		const targets = await screen.findByTestId("targets-card");
		const weight = screen.getByTestId("weight-card");
		const body = screen.getByTestId("body-profile-card");
		expect(
			targets.compareDocumentPosition(weight) &
				Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		expect(
			weight.compareDocumentPosition(body) & Node.DOCUMENT_POSITION_FOLLOWING,
		).toBeTruthy();
		// 運動加回的開關照樣在每日目標卡片的底部（搬家，不是改功能）。它等 /api/me 回來才畫。
		expect(
			await within(targets).findByRole("switch", {
				name: "運動消耗加回今天的熱量額度",
			}),
		).toBeInTheDocument();
		// 等三張卡片的資料都回來（不然 act 警告）。
		await within(body).findByText("還沒有填");
	});
});
