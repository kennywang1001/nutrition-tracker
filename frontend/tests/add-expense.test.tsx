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

	it("實體鍵盤：數字、小數點與 Backspace 輸入到金額", async () => {
		// 桌機（記帳與離線規格 §2 (c)）。焦點在 body，不在任何欄位。
		renderScreen();

		await userEvent.keyboard("12.5{Backspace}");

		// 完整比對：「12.」，不是「12.5」（Backspace 沒作用）也不是「125」（小數點沒作用）。
		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$12\.$/);
	});

	it("實體鍵盤：逗號也是小數點", async () => {
		renderScreen();

		await userEvent.keyboard("3,5");

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$3\.5$/);
	});

	it("實體鍵盤：Enter 送出", async () => {
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		const { onDone } = renderScreen();

		await userEvent.keyboard("7{Enter}");

		await waitFor(() => expect(postBody(fetchMock)?.amount).toBe("7"));
		await waitFor(() => expect(onDone).toHaveBeenCalled());
	});

	it("實體鍵盤：滑鼠點過數字鍵之後按 Enter 是送出，不是再按一次那個數字", async () => {
		// 焦點若留在「5」上，Enter 的預設動作是再點一次它。鍵盤上的按鍵在
		// mousedown 擋掉預設動作，點了也不拿焦點（userEvent.click 會送
		// mousedown，jsdom 下這條規則一樣成立）。
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		renderScreen();

		await pressKeys("5");
		expect(screen.getByRole("button", { name: "5" })).not.toHaveFocus();
		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(postBody(fetchMock)?.amount).toBe("5"));
		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$5$/);
	});

	it("實體鍵盤：焦點在鍵盤以外的按鈕（關閉）時，Enter 是按那顆按鈕，不是送出", async () => {
		const fetchMock = mockApi([]);
		const { onDone } = renderScreen();

		await userEvent.keyboard("7");
		screen.getByRole("button", { name: "關閉" }).focus();
		await userEvent.keyboard("{Enter}");

		await waitFor(() => expect(onDone).toHaveBeenCalled());
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("實體鍵盤：Tab 到數字鍵「2」按 Enter 是按「2」，不是送出", async () => {
		// 鍵盤使用者用 Tab 走到一顆數字鍵，Enter 就是按它——跟任何按鈕一樣。
		const fetchMock = mockApi([]);
		renderScreen();

		await userEvent.keyboard("1");
		const two = screen.getByRole("button", { name: "2" });
		for (let i = 0; i < 30 && document.activeElement !== two; i++) {
			await userEvent.tab();
		}
		expect(two).toHaveFocus();
		await userEvent.keyboard("{Enter}");

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$12$/);
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("實體鍵盤：按住 Enter 的自動重複不會送出", async () => {
		// 按住 Enter：第一下送出，之後的 keydown 都帶 repeat。送出中 ✓ 已經停用，
		// 所以這裡直接測「只有 repeat 的那一下」——它本身就不該送出。
		const fetchMock = mockApi([
			{
				method: "POST",
				path: "/api/expenses",
				handler: () => json(SAVED, 201),
			},
		]);
		renderScreen();

		await userEvent.keyboard("7");
		fireEvent.keyDown(window, { key: "Enter", repeat: true });

		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).not.toHaveBeenCalled();
		// 負向斷言要先證明它有機會看到正向結果：不帶 repeat 的 Enter 會送出。
		fireEvent.keyDown(window, { key: "Enter" });
		await waitFor(() => expect(postBody(fetchMock)?.amount).toBe("7"));
	});

	it("實體鍵盤：輸入法組字中的按鍵不輸入", async () => {
		renderScreen();

		fireEvent.keyDown(window, { key: "1", isComposing: true });
		fireEvent.keyDown(window, { key: "2" });

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$2$/);
	});

	it("實體鍵盤：金額是空的時 Enter 不送出", async () => {
		const fetchMock = mockApi([]);
		renderScreen();

		await userEvent.keyboard("{Enter}");

		// 第 41 種：mutate 是非同步的，讓出一輪，守門被拿掉時請求才來得及出現。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(fetchMock).not.toHaveBeenCalled();
	});

	it("實體鍵盤：焦點在備註欄時數字打進備註，不進金額", async () => {
		renderScreen();

		await userEvent.click(screen.getByLabelText("備註"));
		await userEvent.keyboard("34.5{Backspace}");

		expect(screen.getByLabelText("備註")).toHaveValue("34.");
		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$0$/);
	});

	it("在備註欄打字之後點數字鍵，焦點離開備註，之後的數字進金額", async () => {
		// 鍵盤上的按鍵按下時不拿焦點；但如果焦點原本在備註欄，就讓它離開——
		// 不然手機的螢幕鍵盤一直開著蓋住數字鍵盤，實體鍵盤打的數字也還進備註。
		renderScreen();

		await userEvent.click(screen.getByLabelText("備註"));
		await userEvent.keyboard("午餐");
		await pressKeys("5");
		await userEvent.keyboard("6");

		expect(screen.getByLabelText("備註")).not.toHaveFocus();
		expect(screen.getByLabelText("備註")).toHaveValue("午餐");
		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$56$/);
	});

	it("實體鍵盤：Ctrl＋數字不輸入（其他鍵照常）", async () => {
		renderScreen();

		// 後面接一個普通的 2：證明監聽器確實在，Ctrl+1 沒進來不是因為整個沒接上
		// （第 41 種：負向斷言要先證明它有機會看到正向結果）。
		await userEvent.keyboard("{Control>}1{/Control}2");

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$2$/);
	});

	it("實體鍵盤：Alt＋數字、Meta＋數字也不輸入", async () => {
		renderScreen();

		await userEvent.keyboard("{Alt>}1{/Alt}{Meta>}1{/Meta}2");

		expect(screen.getByLabelText("金額")).toHaveTextContent(/^\$2$/);
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
