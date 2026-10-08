import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Trend } from "../src/screens/Trend";
import trendStyles from "../src/screens/Trend.module.css";
import { json, mockApi } from "./helpers/mock-api";
import { percentText } from "./helpers/percent";

/** 換期間時調淡卡片的 class。CSS module 的型別是 `string | undefined`；
 *  真的不見了會變成 "undefined"，斷言一樣紅，不會空字串假綠。 */
const STALE_CLASS = String(trendStyles.stale);

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
	date: "2019-07-04",
	actual: macros("1800.00"),
	target: null,
	ratio: null,
	breakdown: { food: macros("1800.00"), supplement: macros("0.00") },
};

function rangeBody(adherence: string | null) {
	return {
		date_from: "2019-06-28",
		date_to: "2019-07-04",
		adherence,
		trend: [
			"2019-06-28",
			"2019-06-29",
			"2019-06-30",
			"2019-07-01",
			"2019-07-02",
			"2019-07-03",
			"2019-07-04",
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
		// mock 回的「今天」是 2019-07-04，跟這台機器真正的今天無關。
		//
		// **為什麼挑一個過去的日期，而不是「大概是今天」的那種：**
		// 計畫原本用 2026-09-21，而計畫本身就是 2026-09-21 寫的 ——
		// 也就是說**在寫它的那一天，這條測試的鑑別力是零**：錯誤的實作
		// （`new Date()` 算今天）會算出一模一樣的 from/to，斷言照樣綠。
		// 隔一天執行才碰巧有效（實測於 2026-09-22，突變確實轉紅）。
		//
		// 一條「只在某一天失效、而且沒有任何東西會提醒你」的測試是最糟的
		// 那種。挑 2019-07-04 之後，真實的今天永遠不可能等於它。
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
		expect(String(rangeCall?.[0])).toContain("from=2019-06-28");
		expect(String(rangeCall?.[0])).toContain("to=2019-07-04");
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

		expect(await screen.findByTestId("adherence")).toHaveTextContent(
			percentText(0.85),
		);
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
		expect(adherence).not.toHaveTextContent(percentText(0));
	});
});

/** 今天（最後一天）有熱量與蛋白質的目標、脂肪與碳水沒設。整個換掉最後一天，
 *  不去改 rangeBody 回傳的物件（它的 target 型別是 null）。 */
function rangeWithTodayTargets() {
	const body = rangeBody(null);
	return {
		...body,
		trend: [
			...body.trend.slice(0, -1),
			{
				date: "2019-07-04",
				actual: {
					kcal: "1240.00",
					protein_g: "60.00",
					fat_g: "0.00",
					carb_g: "0.00",
				},
				target: {
					kcal: "2000.00",
					protein_g: "80.00",
					fat_g: null,
					carb_g: null,
				},
				ratio: null,
			},
		],
	};
}

function mockTrend() {
	return mockApi([
		{ path: "/api/stats/daily", handler: () => json(DAILY) },
		{ path: "/api/stats/range", handler: () => json(rangeWithTodayTargets()) },
	]);
}

describe("趨勢：營養素切換", () => {
	it("預設是熱量，今天的摘要寫實際 / 目標", async () => {
		mockTrend();
		render(wrap(<Trend />));

		// 切換鈕在知道今天之後就出現了，不等 range——要等的是摘要本身。
		expect(await screen.findByRole("radio", { name: "熱量" })).toBeChecked();
		expect(await screen.findByTestId("today-summary")).toHaveTextContent(
			"今天 1240 / 2000 kcal",
		);
	});

	it("切到蛋白質：圖與今天的摘要都換成蛋白質", async () => {
		mockTrend();
		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		await userEvent.click(screen.getByRole("radio", { name: "蛋白質" }));

		expect(
			screen.getByRole("group", { name: "最近幾天的蛋白質" }),
		).toBeInTheDocument();
		expect(screen.getByTestId("today-summary")).toHaveTextContent(
			"今天 60 / 80 g",
		);
	});

	it("那一項沒有目標：摘要只寫實際值", async () => {
		mockTrend();
		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		await userEvent.click(screen.getByRole("radio", { name: "脂肪" }));

		expect(screen.getByTestId("today-summary")).toHaveTextContent("今天 0 g");
		expect(screen.getByTestId("today-summary")).not.toHaveTextContent("/");
	});

	it("畫面把 today 傳給圖：今天那一根有 trend-bar-today", async () => {
		mockTrend();
		render(wrap(<Trend />));

		await screen.findByTestId("trend-chart");

		expect(screen.getByTestId("trend-bar-2019-07-04")).toHaveClass(
			"trend-bar-today",
		);
		expect(screen.getByTestId("trend-bar-2019-07-03")).not.toHaveClass(
			"trend-bar-today",
		);
	});

	it("今天整天都沒有目標：摘要只寫實際值", async () => {
		mockApi([
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
		]);
		render(wrap(<Trend />));

		const summary = await screen.findByTestId("today-summary");
		expect(summary).toHaveTextContent("今天 1800 kcal");
		expect(summary).not.toHaveTextContent("/");
	});
});

/** 2019-07-04 往回 30 天（含當天），由舊到新。刻意手寫，不用 `shiftDays`
 *  產生——用被測的函式產生期望值，錯的時候兩邊一起錯。 */
const THIRTY_DAYS = [
	"2019-06-05",
	"2019-06-06",
	"2019-06-07",
	"2019-06-08",
	"2019-06-09",
	"2019-06-10",
	"2019-06-11",
	"2019-06-12",
	"2019-06-13",
	"2019-06-14",
	"2019-06-15",
	"2019-06-16",
	"2019-06-17",
	"2019-06-18",
	"2019-06-19",
	"2019-06-20",
	"2019-06-21",
	"2019-06-22",
	"2019-06-23",
	"2019-06-24",
	"2019-06-25",
	"2019-06-26",
	"2019-06-27",
	"2019-06-28",
	"2019-06-29",
	"2019-06-30",
	"2019-07-01",
	"2019-07-02",
	"2019-07-03",
	"2019-07-04",
];

function rangeOf(dates: readonly string[]) {
	return {
		date_from: dates[0],
		date_to: dates[dates.length - 1],
		adherence: null,
		trend: dates.map((date) => ({
			date,
			actual: macros("1800.00"),
			target: null,
			ratio: null,
		})),
	};
}

function rangeCalls(fetchMock: ReturnType<typeof mockApi>) {
	return fetchMock.mock.calls
		.map(([input]) => String(input))
		.filter((url) => url.includes("/api/stats/range"));
}

describe("趨勢：期間切換", () => {
	it("預設 7 天", async () => {
		mockApi([
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);
		render(wrap(<Trend />));

		const period = await screen.findByRole("group", { name: "期間" });
		expect(period).toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "7 天" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "30 天" })).not.toBeChecked();
	});

	it("切到 30 天：from 是今天往回 29 天（兩端都含），柱子 30 根", async () => {
		// 30 天的路由排在前面：mockApi 用 includes 比對、取第一個符合的。
		// 7 天的請求（from=2019-06-28）不會命中第一條。
		const fetchMock = mockApi([
			{
				path: "/api/stats/range?from=2019-06-05&to=2019-07-04",
				handler: () => json(rangeOf(THIRTY_DAYS)),
			},
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);
		render(wrap(<Trend />));

		await userEvent.click(await screen.findByRole("radio", { name: "30 天" }));

		expect(screen.getByRole("radio", { name: "30 天" })).toBeChecked();
		await screen.findByTestId("trend-bar-2019-06-05");
		expect(screen.getAllByTestId(/^trend-bar-/)).toHaveLength(30);
		// 斷言請求本身，不只看畫面：from 錯一天（例如 -30）的話 30 天的
		// 路由不會命中，請求會落到 7 天那條。
		expect(rangeCalls(fetchMock)).toContain(
			"/api/stats/range?from=2019-06-05&to=2019-07-04",
		);
		expect(
			rangeCalls(fetchMock).filter((url) => url.includes("from=2019-06-04")),
		).toHaveLength(0);
	});

	it("切回 7 天：from 回到往回 6 天", async () => {
		const fetchMock = mockApi([
			{
				path: "/api/stats/range?from=2019-06-05&to=2019-07-04",
				handler: () => json(rangeOf(THIRTY_DAYS)),
			},
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);
		render(wrap(<Trend />));

		await userEvent.click(await screen.findByRole("radio", { name: "30 天" }));
		await screen.findByTestId("trend-bar-2019-06-05");
		await userEvent.click(screen.getByRole("radio", { name: "7 天" }));

		expect(screen.getAllByTestId(/^trend-bar-/)).toHaveLength(7);
		expect(rangeCalls(fetchMock)).toContain(
			"/api/stats/range?from=2019-06-28&to=2019-07-04",
		);
	});

	it("30 天還在載入：留著 7 天的圖但標成載入中，剛按的單選鈕還在、焦點沒跑掉", async () => {
		// 換期間時 `keepPreviousData` 讓 7 天的資料先留著——不然整個畫面退回
		// 「載入中…」，兩組切換鈕一起被拆掉，剛按下去的「30 天」就失去焦點。
		// 但留著的是**上一段**的資料：圖與摘要要標成過時（aria-busy），
		// 摘要不能在「30 天」底下寫「有記錄的 7 天」。
		let resolveThirty: (response: Response) => void = () => {};
		const thirty = new Promise<Response>((resolve) => {
			resolveThirty = resolve;
		});
		mockApi([
			{
				path: "/api/stats/range?from=2019-06-05&to=2019-07-04",
				handler: () => thirty,
			},
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);
		render(wrap(<Trend />));
		expect(await summaryText()).toBe("有記錄的 7 天，平均 1800 kcal");
		expect(screen.getByTestId("trend-period-card")).not.toHaveAttribute(
			"aria-busy",
		);

		const thirtyRadio = screen.getByRole("radio", { name: "30 天" });
		await userEvent.click(thirtyRadio);

		// 30 天的回應還掛著。
		expect(thirtyRadio).toBeInTheDocument();
		expect(thirtyRadio).toBeChecked();
		expect(document.activeElement).toBe(thirtyRadio);
		expect(screen.getByTestId("trend-period-card")).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByTestId("trend-period-card")).toHaveClass(STALE_CLASS);
		expect(screen.getByTestId("adherence").parentElement).toHaveAttribute(
			"aria-busy",
			"true",
		);
		expect(screen.getByTestId("period-summary").textContent).toBe("載入中…");

		resolveThirty(json(rangeOf(THIRTY_DAYS)));
		await screen.findByTestId("trend-bar-2019-06-05");

		expect(screen.getByTestId("trend-period-card")).not.toHaveAttribute(
			"aria-busy",
		);
		expect(screen.getByTestId("trend-period-card")).not.toHaveClass(
			STALE_CLASS,
		);
		expect(screen.getByTestId("adherence").parentElement).not.toHaveAttribute(
			"aria-busy",
		);
		expect(await summaryText()).toBe("有記錄的 30 天，平均 1800 kcal");
	});

	it("30 天載入失敗：說無法載入，切換鈕還在，切回 7 天看得到快取的圖", async () => {
		// 失敗時沒有資料可畫（keepPreviousData 只在載入中留著上一段）。
		// 切換鈕要留著：使用者唯一能做的事就是切回已經有快取的那一段。
		mockApi([
			{
				path: "/api/stats/range?from=2019-06-05&to=2019-07-04",
				handler: () =>
					json({ error: { code: "X", message: "x", details: {} } }, 500),
			},
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);
		render(wrap(<Trend />));
		await screen.findByTestId("trend-chart");

		await userEvent.click(screen.getByRole("radio", { name: "30 天" }));

		expect(await screen.findByText("無法載入趨勢")).toBeInTheDocument();
		expect(screen.queryByText("載入中…")).not.toBeInTheDocument();
		expect(screen.queryByTestId("trend-chart")).not.toBeInTheDocument();
		expect(screen.getByRole("radio", { name: "30 天" })).toBeChecked();
		expect(screen.getByRole("radio", { name: "熱量" })).toBeInTheDocument();

		await userEvent.click(screen.getByRole("radio", { name: "7 天" }));

		expect(screen.getAllByTestId(/^trend-bar-/)).toHaveLength(7);
		expect(screen.queryByText("無法載入趨勢")).not.toBeInTheDocument();
		expect(screen.getByTestId("period-summary").textContent).toBe(
			"有記錄的 7 天，平均 1800 kcal",
		);
	});
});

type Macro = "kcal" | "protein_g" | "fat_g" | "carb_g";

/** 一天的資料：沒寫的實際值是 "0.00"（沒記錄）；`target` 是 null 表示
 *  那天整天沒有目標，物件裡沒寫的項目是 null（有目標但那一項沒設）。 */
function summaryDay(
	date: string,
	actual: Partial<Record<Macro, string>>,
	target: Partial<Record<Macro, string>> | null,
) {
	return {
		date,
		actual: {
			kcal: "0.00",
			protein_g: "0.00",
			fat_g: "0.00",
			carb_g: "0.00",
			...actual,
		},
		target:
			target === null
				? null
				: { kcal: null, protein_g: null, fat_g: null, carb_g: null, ...target },
		ratio: null,
	};
}

/** 資料 A。熱量：有記錄的 4 天（1800、2100、1500、1200）平均 1650；
 *  把沒記錄的 3 天也算進去會是 942.857…。
 *  熱量目標：1800 那天 2000、2100 那天 2200；1500 那天整天沒目標、
 *  1200 那天有目標但熱量沒設；6/29 沒記錄但有 5000 的目標（不能算進去）。
 *  → 目標平均 2100（把沒目標的當 0 會是 1050；算進沒記錄的那天會是 3066.67）。
 *  蛋白質：60（目標沒設）與 75.5（目標 80）→ 平均 67.75、目標平均 80。
 *  脂肪：一天都沒有。碳水：只有 250 那天，整段期間沒有碳水目標。 */
const DATASET_A = [
	summaryDay(
		"2019-06-28",
		{ kcal: "1800.00", protein_g: "60.00" },
		{ kcal: "2000.00" },
	),
	summaryDay("2019-06-29", {}, { kcal: "5000.00" }),
	summaryDay("2019-06-30", { kcal: "2100.00" }, { kcal: "2200.00" }),
	summaryDay("2019-07-01", {}, null),
	summaryDay("2019-07-02", { kcal: "1500.00", carb_g: "250.00" }, null),
	summaryDay("2019-07-03", {}, null),
	summaryDay(
		"2019-07-04",
		{ kcal: "1200.00", protein_g: "75.50" },
		{ protein_g: "80.00" },
	),
];

/** 資料 B。熱量：有記錄的 2 天（1000、1300）平均 1150；只有 1000 那天有
 *  目標（1800）→ 目標平均 1800（把 1300 那天當 0 會是 900）。 */
const DATASET_B = [
	summaryDay("2019-06-28", {}, { kcal: "9999.00" }),
	summaryDay("2019-06-29", { kcal: "1000.00" }, { kcal: "1800.00" }),
	summaryDay("2019-06-30", {}, null),
	summaryDay("2019-07-01", {}, null),
	summaryDay("2019-07-02", { kcal: "1300.00" }, null),
	summaryDay("2019-07-03", {}, null),
	summaryDay("2019-07-04", {}, null),
];

function mockDataset(trend: ReturnType<typeof summaryDay>[]) {
	return mockApi([
		{ path: "/api/stats/daily", handler: () => json(DAILY) },
		{
			path: "/api/stats/range",
			handler: () => json({ ...rangeBody(null), trend }),
		},
	]);
}

async function summaryText() {
	return (await screen.findByTestId("period-summary")).textContent;
}

describe("趨勢：期間摘要", () => {
	// 每條斷言都比整行文字（textContent 相等），不是「包含」——
	// 「包含 有記錄的 4 天」擋不住後面多接一段不該出現的目標平均。

	it("沒記錄的日子不算（兩組資料，寫死的數字過不了）", async () => {
		mockDataset(DATASET_A);
		const { unmount } = render(wrap(<Trend />));
		expect(await summaryText()).toBe(
			"有記錄的 4 天，平均 1650 kcal，目標平均 2100 kcal",
		);
		unmount();

		mockDataset(DATASET_B);
		render(wrap(<Trend />));
		expect(await summaryText()).toBe(
			"有記錄的 2 天，平均 1150 kcal，目標平均 1800 kcal",
		);
	});

	it("那一項整段期間都沒有目標：不寫目標平均", async () => {
		mockDataset(DATASET_A);
		render(wrap(<Trend />));

		await userEvent.click(await screen.findByRole("radio", { name: "碳水" }));

		expect(await summaryText()).toBe("有記錄的 1 天，平均 250 g");
	});

	it("有的天有目標、有的沒有：目標平均只算有目標的那幾天", async () => {
		// 熱量（資料 A）：有記錄的 4 天裡只有 2 天有熱量目標。
		// 蛋白質（資料 A）：有記錄的 2 天裡，有目標（但蛋白質沒設）的那天
		// 也不算——第二層 null 跟整天沒目標一樣不參與。
		mockDataset(DATASET_A);
		const { unmount } = render(wrap(<Trend />));
		expect(await summaryText()).toBe(
			"有記錄的 4 天，平均 1650 kcal，目標平均 2100 kcal",
		);
		await userEvent.click(screen.getByRole("radio", { name: "蛋白質" }));
		expect(await summaryText()).toBe(
			"有記錄的 2 天，平均 67.75 g，目標平均 80 g",
		);
		unmount();

		// 資料 B：有記錄的 2 天裡只有 1 天有目標。
		mockDataset(DATASET_B);
		render(wrap(<Trend />));
		expect(await summaryText()).toBe(
			"有記錄的 2 天，平均 1150 kcal，目標平均 1800 kcal",
		);
	});

	it("切換營養素：數字與單位都跟著換，切回來也回來", async () => {
		mockDataset(DATASET_A);
		render(wrap(<Trend />));
		expect(await summaryText()).toBe(
			"有記錄的 4 天，平均 1650 kcal，目標平均 2100 kcal",
		);

		await userEvent.click(screen.getByRole("radio", { name: "蛋白質" }));
		expect(await summaryText()).toBe(
			"有記錄的 2 天，平均 67.75 g，目標平均 80 g",
		);

		await userEvent.click(screen.getByRole("radio", { name: "熱量" }));
		expect(await summaryText()).toBe(
			"有記錄的 4 天，平均 1650 kcal，目標平均 2100 kcal",
		);
	});

	it("那一項一天都沒記：說還沒有記錄，不是「平均 0」", async () => {
		mockDataset(DATASET_A);
		render(wrap(<Trend />));

		await userEvent.click(await screen.findByRole("radio", { name: "脂肪" }));

		expect(await summaryText()).toBe("這段期間還沒有記錄");
	});

	it("平均除不盡時顯示兩位小數", async () => {
		mockDataset([
			summaryDay("2019-06-28", { kcal: "1000.00" }, { kcal: "2000.00" }),
			summaryDay("2019-06-29", { kcal: "1000.00" }, { kcal: "2000.00" }),
			summaryDay("2019-06-30", { kcal: "1001.00" }, { kcal: "2001.00" }),
			summaryDay("2019-07-01", {}, null),
			summaryDay("2019-07-02", {}, null),
			summaryDay("2019-07-03", {}, null),
			summaryDay("2019-07-04", {}, null),
		]);
		render(wrap(<Trend />));

		expect(await summaryText()).toBe(
			"有記錄的 3 天，平均 1000.33 kcal，目標平均 2000.33 kcal",
		);
	});

	it("30 天的摘要算的是 30 天", async () => {
		mockApi([
			{
				path: "/api/stats/range?from=2019-06-05&to=2019-07-04",
				handler: () => json(rangeOf(THIRTY_DAYS)),
			},
			{ path: "/api/stats/range", handler: () => json(rangeBody(null)) },
			{ path: "/api/stats/daily", handler: () => json(DAILY) },
		]);
		render(wrap(<Trend />));
		expect(await summaryText()).toBe("有記錄的 7 天，平均 1800 kcal");

		await userEvent.click(screen.getByRole("radio", { name: "30 天" }));
		await screen.findByTestId("trend-bar-2019-06-05");

		expect(await summaryText()).toBe("有記錄的 30 天，平均 1800 kcal");
	});
});
