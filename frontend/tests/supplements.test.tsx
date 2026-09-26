import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { Supplements } from "../src/screens/Supplements";
import { json, mockApi } from "./helpers/mock-api";

// 不需要 MemoryRouter：跟 FoodLibrary/NewFood 不一樣，這個畫面完全沒有
// <Link>／useNavigate（P3-C Task 2 刻意的設計：新增跟「今天吃了」都留在
// 同一個畫面裡，見 Supplements.tsx 的說明）。
function wrap(children: ReactNode) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}

const FISH_OIL = {
	id: 7,
	name: "魚油",
	brand: null,
	is_global: false,
	serving_unit: "顆",
	serving_size: "1.00",
	kcal: "9.00",
	protein_g: "0.00",
	fat_g: "1.00",
	carb_g: "0.00",
};

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("補劑 /supplements", () => {
	it("一進畫面不發搜尋請求——q 是空的", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/supplements/today",
				handler: () => json([]),
			},
			{
				method: "GET",
				path: "/api/supplements",
				handler: () => json([FISH_OIL]),
			},
		]);

		render(wrap(<Supplements />));

		// 等超過 debounce 的 300ms，確認「什麼都沒打字」不會在計時器到期時
		// 意外觸發一次查詢（跟 food-library.test.tsx 同一招）。
		await new Promise((resolve) => setTimeout(resolve, 350));

		expect(
			fetchMock.mock.calls.some(([input]) =>
				String(input).includes("/api/supplements?q="),
			),
		).toBe(false);
	});

	it("輸入之後（等過 debounce）發出帶 q 的請求，結果顯示出來", async () => {
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/supplements/today",
				handler: () => json([]),
			},
			{
				method: "GET",
				path: "/api/supplements",
				handler: () => json([FISH_OIL]),
			},
		]);

		render(wrap(<Supplements />));
		await userEvent.type(screen.getByLabelText("搜尋補劑"), "魚");

		expect(await screen.findByText("魚油")).toBeInTheDocument();

		const call = fetchMock.mock.calls.find(([input]) =>
			String(input).includes("/api/supplements?q="),
		);
		expect(call).toBeDefined();
		expect(String(call?.[0])).toContain(`q=${encodeURIComponent("魚")}`);
	});

	it('新增補劑：body 形狀正確，四個營養素留空時送 "0"——不是省略、也不是 null', async () => {
		// 這是這個 task 兩個要自己判斷的點之一（見 Supplements.tsx 裡
		// createSupplement 的註解）：後端雖然有預設值 0，但 SupplementCreateRequest
		// 的型別是 Decimal（不是 Decimal | None），送 null 會被 422 擋下來，
		// 而 schema.d.ts 產生的型別也沒有把這四個欄位標成可省略。
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/supplements/today",
				handler: () => json([]),
			},
			{
				method: "POST",
				path: "/api/supplements",
				handler: () => json(FISH_OIL, 201),
			},
		]);

		render(wrap(<Supplements />));
		await userEvent.type(screen.getByLabelText("名稱"), "魚油");
		await userEvent.type(
			screen.getByLabelText("單位（例如：顆、粒、g）"),
			"顆",
		);
		await userEvent.type(screen.getByLabelText("每份份量"), "1");
		// 四個營養素欄位刻意不填。
		await userEvent.click(screen.getByRole("button", { name: "新增補劑" }));

		const call = await vi.waitFor(() => {
			const found = fetchMock.mock.calls.find(
				([input, init]) =>
					String(input).includes("/api/supplements") &&
					!String(input).includes("/today") &&
					init?.method === "POST",
			);
			expect(found).toBeDefined();
			return found;
		});
		const body = JSON.parse(String(call?.[1]?.body));

		expect(body).toEqual({
			name: "魚油",
			brand: null,
			serving_unit: "顆",
			serving_size: "1",
			kcal: "0",
			protein_g: "0",
			fat_g: "0",
			carb_g: "0",
		});
		// 三種選擇裡唯一被排除不掉的是「省略」——用 toEqual 已經隱含驗過
		// （物件形狀不對就會不相等），這裡再明講一次「不是 null」，避免
		// 日後有人把 "0" 改回 null 卻恰好通過 toEqual（不會，但這條斷言
		// 讓意圖看得見）。
		expect(body.kcal).not.toBeNull();
		expect(typeof body.kcal).toBe("string");
	});

	it('「今天吃了」送出的 plan_id 是 null，dose 是 "1"，taken_at 是 ISO 字串', async () => {
		// 核心行為：這個畫面完全沒有固定計畫，每一次「今天吃了」都必須是
		// plan_id: null 的臨時記錄——後端會把非 null 的 plan_id 當成「對某個
		// 計畫打卡」處理（app/api/routes/supplement_intakes.py 的
		// _load_owned_plan），而使用者根本沒有計畫，那條路徑對這個畫面來說
		// 完全是錯的。
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/supplements/today",
				handler: () => json([]),
			},
			{
				method: "GET",
				path: "/api/supplements",
				handler: () => json([FISH_OIL]),
			},
			{
				method: "POST",
				path: "/api/supplement-intakes",
				handler: () =>
					json(
						{
							id: 1,
							supplement_id: 7,
							plan_id: null,
							dose: "1.00",
							taken_at: new Date().toISOString(),
							kcal: "9.00",
							protein_g: "0.00",
							fat_g: "1.00",
							carb_g: "0.00",
						},
						201,
					),
			},
		]);

		render(wrap(<Supplements />));
		await userEvent.type(screen.getByLabelText("搜尋補劑"), "魚");
		await screen.findByText("魚油");
		await userEvent.click(screen.getByRole("button", { name: "今天吃了" }));

		const call = await vi.waitFor(() => {
			const found = fetchMock.mock.calls.find(
				([input, init]) =>
					String(input).includes("/api/supplement-intakes") &&
					init?.method === "POST",
			);
			expect(found).toBeDefined();
			return found;
		});
		const body = JSON.parse(String(call?.[1]?.body));

		expect(body.plan_id).toBeNull();
		expect(body.dose).toBe("1");
		expect(body.supplement_id).toBe(7);
		expect(body.taken_at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
	});

	it("記錄成功後 supplementsToday 失效——今日總覽要看得到新記的這一筆", async () => {
		// 用「/api/supplements/today 被再打一次」證明失效真的發生了，
		// 不是只看 UI 有沒有變（跟 api/queries.ts 裡 mealPhoto 那段註解
		// 講的「3 次照片 GET 而不是 2 次」同一種驗法）。
		let todayCallCount = 0;
		const fetchMock = mockApi([
			{
				method: "GET",
				path: "/api/supplements/today",
				handler: () => {
					todayCallCount += 1;
					return json([]);
				},
			},
			{
				method: "GET",
				path: "/api/supplements",
				handler: () => json([FISH_OIL]),
			},
			{
				method: "POST",
				path: "/api/supplement-intakes",
				handler: () => json({ id: 1 }, 201),
			},
		]);

		render(wrap(<Supplements />));
		await waitFor(() => expect(todayCallCount).toBe(1));

		await userEvent.type(screen.getByLabelText("搜尋補劑"), "魚");
		await screen.findByText("魚油");
		await userEvent.click(screen.getByRole("button", { name: "今天吃了" }));

		await waitFor(() => {
			expect(
				fetchMock.mock.calls.some(
					([input, init]) =>
						String(input).includes("/api/supplement-intakes") &&
						init?.method === "POST",
				),
			).toBe(true);
		});

		// invalidateQueries 之後 TanStack Query 在這個測試用的 QueryClient
		// （staleTime 預設 0，跟正式站的 60 秒不同）會立刻重新 fetch。
		await waitFor(() => expect(todayCallCount).toBeGreaterThanOrEqual(2));
	});

	it("today 清單裡 plan_id === null 的項目顯示成「已記錄」，不是「待打卡」", async () => {
		// 規格對照：TodaySupplementItem 的 docstring 說 plan_id 為 null 一定
		// done=True（臨時記錄本身就代表已經吃了），跟「打卡」是兩件事——
		// 這個畫面刻意用不同的字，不要讓使用者以為自己設了一個計畫。
		mockApi([
			{
				method: "GET",
				path: "/api/supplements/today",
				handler: () =>
					json([
						{
							plan_id: 1,
							supplement_id: 5,
							supplement_name: "維他命D",
							dose: "1.00",
							time_of_day: "morning",
							done: false,
							intake_id: null,
						},
						{
							plan_id: null,
							supplement_id: 9,
							supplement_name: "維他命C",
							dose: "1.00",
							time_of_day: null,
							done: true,
							intake_id: 55,
						},
					]),
			},
		]);

		render(wrap(<Supplements />));

		const adhocRow = (await screen.findByText("維他命C")).closest("li");
		expect(adhocRow).not.toBeNull();
		expect(
			within(adhocRow as HTMLElement).getByText("已記錄"),
		).toBeInTheDocument();
		expect(
			within(adhocRow as HTMLElement).queryByText("待打卡"),
		).not.toBeInTheDocument();

		const planRow = screen.getByText("維他命D").closest("li");
		expect(planRow).not.toBeNull();
		expect(
			within(planRow as HTMLElement).getByText("待打卡"),
		).toBeInTheDocument();
	});
});
