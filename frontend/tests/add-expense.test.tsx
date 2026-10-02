import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "../src/api/queries";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import { AddExpense } from "../src/screens/AddExpense";
import { json, mockApi } from "./helpers/mock-api";

const SAVED = {
	id: 2,
	amount: "250.50",
	category: "transport",
	spent_at: "2026-12-14T02:00:00+00:00",
	note: null,
	meal_id: null,
};

function renderScreen(onDone = vi.fn()) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	const invalidate = vi.spyOn(client, "invalidateQueries");
	render(
		<QueryClientProvider client={client}>
			<AddExpense onDone={onDone} />
		</QueryClientProvider>,
	);
	return { onDone, invalidate };
}

async function pressKeys(...names: string[]) {
	for (const name of names) {
		await userEvent.click(screen.getByRole("button", { name }));
	}
}

function postBody(
	fetchMock: ReturnType<typeof mockApi>,
): Record<string, unknown> | null {
	const call = fetchMock.mock.calls.find(
		([input, init]) =>
			(init?.method ?? "GET").toUpperCase() === "POST" &&
			String(input).includes("/api/expenses"),
	);
	return call === undefined ? null : JSON.parse(String(call[1]?.body));
}

function errorResponse(status: number, code: string) {
	return json({ error: { code, message: "後端訊息", details: {} } }, status);
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("記帳 /expenses/new", () => {
	it("送出的金額、分類、時間與備註", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		renderScreen();

		await pressKeys("2", "5", "0", "小數點", "5", "0");
		await userEvent.click(screen.getByRole("button", { name: "交通" }));
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(postBody(fetchMock)).not.toBeNull());
		const sent = postBody(fetchMock);
		// 金額以字串送出，不經過 Number()（規格 §2.4）。
		expect(sent?.amount).toBe("250.50");
		expect(sent?.category).toBe("transport");
		// **關鍵斷言**：後端是 AwareDatetime，沒有 offset 的時間會 422。
		expect(sent?.spent_at).toMatch(/(Z|[+-]\d{2}:\d{2})$/);
		expect(sent?.note).toBeNull();
	});

	it("結尾的小數點不會被送出", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		renderScreen();

		await pressKeys("5", "小數點");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(postBody(fetchMock)?.amount).toBe("5"));
	});

	it("金額是 0 時不能送出", async () => {
		const fetchMock = mockApi([]);
		renderScreen();

		await pressKeys("0");

		expect(screen.getByRole("button", { name: "記一筆" })).toBeDisabled();
		// 按鈕停用時瀏覽器本來就不會送出，所以直接觸發 submit 事件，
		// 才測得到 handleSubmit 的守門。
		fireEvent.submit(
			screen
				.getByRole("button", { name: "記一筆" })
				.closest("form") as HTMLFormElement,
		);
		// mutate 是非同步送出的：讓出一輪再斷言，守門被拿掉時請求才來得及出現。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(postBody(fetchMock)).toBeNull();
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("預設分類是飲食，點別的分類會換過去", async () => {
		renderScreen();

		expect(screen.getByRole("button", { name: "飲食" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);

		await userEvent.click(screen.getByRole("button", { name: "交通" }));

		expect(screen.getByRole("button", { name: "交通" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(screen.getByRole("button", { name: "飲食" })).toHaveAttribute(
			"aria-pressed",
			"false",
		);
	});

	it("成功後失效 expensesAll 並離開", async () => {
		// 報表、總覽的今天支出都掛在 expensesAll 底下（queries.test.tsx 的
		// 前綴測試）。少了這一行，記完一筆回到總覽，數字不會變——
		// 使用者會以為沒記到，再記一次。
		mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		const { onDone, invalidate } = renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(onDone).toHaveBeenCalled());
		expect(invalidate).toHaveBeenCalledWith({
			queryKey: queryKeys.expensesAll,
		});
	});

	it("後端拒絕金額時顯示具體訊息，金額不清掉", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => errorResponse(422, "VALIDATION_ERROR"),
			},
		]);
		const { onDone } = renderScreen();

		await pressKeys("2", "5", "0");
		await userEvent.click(screen.getByRole("button", { name: "交通" }));
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"金額格式不對，請輸入大於 0、最多兩位小數的數字",
		);
		expect(screen.getByLabelText("金額")).toHaveTextContent("250");
		// 分類也不清掉（規格 §5.3）。
		expect(screen.getByRole("button", { name: "交通" })).toHaveAttribute(
			"aria-pressed",
			"true",
		);
		expect(onDone).not.toHaveBeenCalled();
	});

	it("送出中 ✓ 停用，只送一次", async () => {
		// mockApi 的 handler 必須同步回 Response，做不出「還沒回來」，
		// 所以這條直接 spy fetch，回一個永遠不 resolve 的 promise。
		const fetchMock = vi
			.spyOn(globalThis, "fetch")
			.mockImplementation(() => new Promise(() => {}));
		renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() =>
			expect(screen.getByRole("button", { name: "記一筆" })).toBeDisabled(),
		);
		expect(fetchMock).toHaveBeenCalledTimes(1);
	});

	it("備註去掉頭尾空白後送出", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		renderScreen();

		await pressKeys("1");
		await userEvent.type(screen.getByLabelText("備註"), "  高鐵  ");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		await waitFor(() => expect(postBody(fetchMock)?.note).toBe("高鐵"));
	});

	it("其他失敗顯示通用訊息", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => errorResponse(500, "INTERNAL_ERROR"),
			},
		]);
		renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "記一筆" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"記帳失敗，請再試一次",
		);
	});

	it("關閉不送任何請求", async () => {
		const fetchMock = mockApi([]);
		const { onDone } = renderScreen();

		await pressKeys("1");
		await userEvent.click(screen.getByRole("button", { name: "關閉" }));

		expect(onDone).toHaveBeenCalled();
		expect(fetchMock).not.toHaveBeenCalled();
	});
});
