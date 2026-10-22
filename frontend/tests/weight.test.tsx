import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { VIEW_HEIGHT } from "../src/components/WeightChart";
import { Weight } from "../src/screens/Weight";
import { bodyRoutes, EMPTY_PROFILE } from "./helpers/body-routes";
import { type Route as ApiRoute, json, mockApi } from "./helpers/mock-api";

const e = (date: string, weight_kg: string) => ({ date, weight_kg });

const TWO = {
	today: "2026-10-14",
	entries: [e("2026-07-01", "82.00"), e("2026-10-10", "78.40")],
};

function newClient() {
	return new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: 60_000 } },
	});
}

function renderScreen(
	routes: ApiRoute[],
	client = newClient(),
	element = <Weight />,
) {
	const spy = mockApi(routes);
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/weight"]}>
				<Routes>
					<Route path="/weight" element={element} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
	return { spy, client };
}

function sent(spy: ReturnType<typeof mockApi>, method: string) {
	return spy.mock.calls
		.filter(([, init]) => (init?.method ?? "GET").toUpperCase() === method)
		.map(([url, init]) => ({
			url: String(url),
			body: typeof init?.body === "string" ? init.body : null,
		}));
}

function dots(): string[] {
	return within(screen.getByRole("group", { name: "體重" }))
		.getAllByRole("img")
		.map((dot) => dot.getAttribute("aria-label") ?? "");
}

/** 斷言「沒有送出」之前先等一下（第 41 種）。 */
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

describe("/weight", () => {
	it("預設 30 天；「全部」畫兩點、「90 天」只有一點（7/01 在 7/17 之前）", async () => {
		renderScreen(bodyRoutes({ weights: TWO }));

		const period = await screen.findByRole("group", { name: "期間" });
		expect(within(period).getAllByRole("radio")).toHaveLength(3);
		expect(within(period).getByRole("radio", { name: "30 天" })).toBeChecked();
		expect(dots()).toEqual(["10/10，78.4 公斤"]);

		await userEvent.click(within(period).getByRole("radio", { name: "全部" }));
		expect(dots()).toEqual(["7/1，82 公斤", "10/10，78.4 公斤"]);

		await userEvent.click(within(period).getByRole("radio", { name: "90 天" }));
		expect(dots()).toEqual(["10/10，78.4 公斤"]);
	});

	it("平均線用全部的紀錄算：範圍開頭那一筆的平均算進範圍外的前幾天", async () => {
		// 30 天從 9/15 起；9/12 的 80 在範圍外，但 9/16 的平均（9/10–9/16）要算它：(80 + 78) / 2 = 79。
		renderScreen(
			bodyRoutes({
				weights: {
					today: "2026-10-14",
					entries: [e("2026-09-12", "80"), e("2026-09-16", "78")],
				},
			}),
		);

		await screen.findByRole("group", { name: "體重" });
		expect(dots()).toEqual(["9/16，78 公斤"]);
		const [first] = (
			screen.getByTestId("weight-average").getAttribute("points") ?? ""
		).split(" ");
		// y 軸是 77–80（點 78、平均 79，各往外 1 公斤）：79 在 2/3 高。
		expect(Number(first?.split(",")[1])).toBeCloseTo(VIEW_HEIGHT * (1 - 2 / 3));
	});

	it("這段期間沒有紀錄：說一聲，不畫空的圖", async () => {
		renderScreen(
			bodyRoutes({
				weights: { today: "2026-10-14", entries: [e("2026-07-01", "82")] },
			}),
		);

		expect(await screen.findByText("這段期間沒有體重紀錄")).toBeInTheDocument();
		expect(
			screen.queryByRole("group", { name: "體重" }),
		).not.toBeInTheDocument();
	});

	it("清單由新到舊；修改：就地變成輸入框，存了送 PUT、失效 [body]", async () => {
		const { spy, client } = renderScreen([
			{
				method: "PUT",
				path: "/api/weights/2026-10-10",
				handler: () => json(e("2026-10-10", "78.20")),
			},
			...bodyRoutes({ weights: TWO }),
		]);
		client.setQueryData(queryKeys.targetSuggestion, {
			ready: false,
			missing: ["sex"],
		});

		const list = await screen.findByRole("list", { name: "體重紀錄" });
		expect(
			within(list)
				.getAllByRole("listitem")
				.map((item) => item.textContent),
		).toEqual([
			expect.stringContaining("10/10"),
			expect.stringContaining("7/1"),
		]);

		await userEvent.click(screen.getByRole("button", { name: "修改 10/10" }));
		const input = screen.getByLabelText("10/10 的體重（公斤）");
		expect(input).toHaveValue("78.4");
		expect(input).toHaveFocus();
		await userEvent.clear(input);
		await userEvent.type(input, "78.2");
		await userEvent.click(within(list).getByRole("button", { name: "儲存" }));

		await waitFor(() =>
			expect(sent(spy, "PUT")).toEqual([
				{ url: "/api/weights/2026-10-10", body: '{"weight_kg":"78.2"}' },
			]),
		);
		await waitFor(() =>
			expect(
				client.getQueryState(queryKeys.targetSuggestion)?.isInvalidated,
			).toBe(true),
		);
		// 存好收起來，焦點回到「修改 10/10」。
		await waitFor(() =>
			expect(screen.getByRole("button", { name: "修改 10/10" })).toHaveFocus(),
		);
	});

	it("修改的值不合規則：不送，說哪裡不對；取消回到原本的樣子", async () => {
		const { spy } = renderScreen(bodyRoutes({ weights: TWO }));

		await userEvent.click(
			await screen.findByRole("button", { name: "修改 10/10" }),
		);
		const input = screen.getByLabelText("10/10 的體重（公斤）");
		await userEvent.clear(input);
		await userEvent.type(input, "400");
		const list = screen.getByRole("list", { name: "體重紀錄" });
		await userEvent.click(within(list).getByRole("button", { name: "儲存" }));

		expect(await within(list).findByRole("alert")).toHaveTextContent(
			"體重要在 25 到 350 公斤之間，最多兩位小數",
		);
		await settle();
		expect(sent(spy, "PUT")).toEqual([]);

		await userEvent.click(within(list).getByRole("button", { name: "取消" }));
		expect(
			screen.queryByLabelText("10/10 的體重（公斤）"),
		).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "修改 10/10" })).toHaveFocus();
	});

	it("刪除要確認：焦點在「取消」；取消回到「刪除 10/10」；確認才送 DELETE", async () => {
		const { spy } = renderScreen([
			{
				method: "DELETE",
				path: "/api/weights/2026-10-10",
				handler: () => new Response(null, { status: 204 }),
			},
			...bodyRoutes({ weights: TWO }),
		]);

		await userEvent.click(
			await screen.findByRole("button", { name: "刪除 10/10" }),
		);
		const dialog = screen.getByRole("alertdialog", {
			name: "刪除 10/10 的體重？",
		});
		expect(within(dialog).getByRole("button", { name: "取消" })).toHaveFocus();
		await settle();
		expect(sent(spy, "DELETE")).toEqual([]);

		await userEvent.click(within(dialog).getByRole("button", { name: "取消" }));
		expect(screen.queryByRole("alertdialog")).not.toBeInTheDocument();
		expect(screen.getByRole("button", { name: "刪除 10/10" })).toHaveFocus();

		await userEvent.click(screen.getByRole("button", { name: "刪除 10/10" }));
		await userEvent.click(
			within(screen.getByRole("alertdialog")).getByRole("button", {
				name: "刪除",
			}),
		);
		await waitFor(() =>
			expect(sent(spy, "DELETE")).toEqual([
				{ url: "/api/weights/2026-10-10", body: null },
			]),
		);
	});

	it("沒有紀錄：「還沒有體重紀錄」，記錄的表單在（日期預設是後端給的今天）", async () => {
		renderScreen(bodyRoutes({ weights: { today: "2026-10-14", entries: [] } }));

		expect(await screen.findByText("還沒有體重紀錄")).toBeInTheDocument();
		expect(screen.getByLabelText("日期")).toHaveValue("2026-10-14");
		expect(screen.getByLabelText("體重（公斤）")).toBeInTheDocument();
		expect(
			screen.queryByRole("group", { name: "體重" }),
		).not.toBeInTheDocument();
	});

	it("從這一頁記一筆：PUT 選的日期，存好清空輸入框", async () => {
		const { spy } = renderScreen([
			{
				method: "PUT",
				path: "/api/weights/2026-10-12",
				handler: () => json(e("2026-10-12", "77.00")),
			},
			...bodyRoutes({ weights: TWO }),
		]);

		const weight = await screen.findByLabelText("體重（公斤）");
		await userEvent.type(weight, "77");
		const date = screen.getByLabelText("日期");
		await userEvent.clear(date);
		await userEvent.type(date, "2026-10-12");
		await userEvent.click(
			within(screen.getByTestId("weight-form")).getByRole("button", {
				name: "儲存",
			}),
		);

		await waitFor(() =>
			expect(sent(spy, "PUT")).toEqual([
				{ url: "/api/weights/2026-10-12", body: '{"weight_kg":"77"}' },
			]),
		);
		await waitFor(() => expect(weight).toHaveValue(""));
	});

	it("圖下面：最近 7 天平均與目標體重", async () => {
		renderScreen(
			bodyRoutes({
				weights: {
					today: "2026-10-14",
					entries: [e("2026-10-09", "80"), e("2026-10-14", "79")],
				},
				profile: { ...EMPTY_PROFILE, target_weight_kg: "72.00" },
			}),
		);

		expect(
			await screen.findByText("最近 7 天平均 79.5 公斤"),
		).toBeInTheDocument();
		expect(await screen.findByText("目標 72 公斤")).toBeInTheDocument();
		expect(screen.getByTestId("weight-target")).toBeInTheDocument();
	});

	it("圖例：每天的紀錄、7 天平均，色塊是裝飾", async () => {
		renderScreen(bodyRoutes({ weights: TWO }));

		const card = await screen.findByTestId("weight-chart-card");
		const daily = within(card).getByText("每天的紀錄");
		const average = within(card).getByText("7 天平均");
		// 每一項是「色塊＋字」：色塊是 aria-hidden 的 span，字本身就說了。
		expect(daily.querySelector("span")).toHaveAttribute("aria-hidden", "true");
		expect(average.querySelector("span")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});

	it("切期間：線只連範圍內的點", async () => {
		renderScreen(
			bodyRoutes({
				weights: {
					today: "2026-10-14",
					entries: [
						e("2026-07-01", "82"),
						e("2026-09-01", "80"),
						e("2026-10-01", "79"),
						e("2026-10-10", "78.4"),
					],
				},
			}),
		);
		const linePairs = () =>
			(screen.getByTestId("weight-line").getAttribute("points") ?? "").split(
				" ",
			);

		const period = await screen.findByRole("group", { name: "期間" });
		expect(dots()).toHaveLength(2);
		expect(linePairs()).toHaveLength(2);

		await userEvent.click(within(period).getByRole("radio", { name: "全部" }));
		expect(dots()).toHaveLength(4);
		expect(linePairs()).toHaveLength(4);

		await userEvent.click(within(period).getByRole("radio", { name: "30 天" }));
		expect(dots()).toHaveLength(2);
		expect(linePairs()).toHaveLength(2);
	});

	it("讀不到：「無法載入體重」", async () => {
		renderScreen([
			{
				method: "GET",
				path: "/api/weights",
				handler: () =>
					json(
						{ error: { code: "INTERNAL_ERROR", message: "壞了", details: {} } },
						500,
					),
			},
			...bodyRoutes(),
		]);

		expect(await screen.findByRole("alert")).toHaveTextContent("無法載入體重");
	});
});

describe("/weight：從記體重來（首頁改版規格 D11）", () => {
	it("focusForm：資料回來、表單掛上去，焦點在「體重（公斤）」", async () => {
		renderScreen(
			bodyRoutes({ weights: TWO }),
			newClient(),
			<Weight focusForm />,
		);

		const input = await screen.findByLabelText("體重（公斤）");
		await waitFor(() => expect(input).toHaveFocus());
	});

	it("沒有 focusForm：焦點不在體重欄位", async () => {
		renderScreen(bodyRoutes({ weights: TWO }));

		const input = await screen.findByLabelText("體重（公斤）");
		// 等圖畫完（表單的 effect 早就跑過了）再看焦點。
		await screen.findByRole("group", { name: "體重" });
		await settle();
		expect(input).not.toHaveFocus();
	});
});
