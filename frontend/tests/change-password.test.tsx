import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, getRefreshToken, setTokens } from "../src/auth/store";
import { ChangePassword } from "../src/screens/ChangePassword";
import { json, mockApi } from "./helpers/mock-api";

const NEW_TOKENS = {
	access_token: "new-a",
	refresh_token: "new-r",
	token_type: "bearer",
};

function errorResponse(
	status: number,
	code: string,
	message: string,
	headers: Record<string, string> = {},
) {
	return new Response(
		JSON.stringify({ error: { code, message, details: {} } }),
		{ status, headers: { "content-type": "application/json", ...headers } },
	);
}

/** `/api/me/password` 一定要寫 method：`mockApi` 用子字串比對（第 43 種），
 *  換票的 `/api/auth/refresh` 也要準備——數它被打了幾次（第 18 種）。 */
function backend(handler: () => Response | Promise<Response>) {
	return mockApi([
		{ method: "POST", path: "/api/me/password", handler },
		{
			method: "POST",
			path: "/api/auth/refresh",
			handler: () => json(NEW_TOKENS),
		},
	]);
}

function renderScreen() {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	render(
		<QueryClientProvider client={client}>
			<MemoryRouter initialEntries={["/me/password"]}>
				<Routes>
					<Route path="/me/password" element={<ChangePassword />} />
				</Routes>
			</MemoryRouter>
		</QueryClientProvider>,
	);
}

async function fill(
	current: string,
	next: string,
	confirm = next,
): Promise<void> {
	await userEvent.type(screen.getByLabelText("目前的密碼"), current);
	// 「新密碼」是「再輸入一次新密碼」的子字串：testing-library 預設完整比對，
	// 這裡仍寫 exact，讀的人不用回頭查預設值。
	await userEvent.type(screen.getByLabelText("新密碼", { exact: true }), next);
	await userEvent.type(screen.getByLabelText("再輸入一次新密碼"), confirm);
	await userEvent.click(screen.getByRole("button", { name: "更新密碼" }));
}

function passwordPosts(spy: ReturnType<typeof mockApi>): unknown[] {
	return spy.mock.calls
		.filter(([url]) => String(url).includes("/api/me/password"))
		.map(([, init]) => JSON.parse(String(init?.body)));
}

function refreshCalls(spy: ReturnType<typeof mockApi>): number {
	return spy.mock.calls.filter(([url]) =>
		String(url).includes("/api/auth/refresh"),
	).length;
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

describe("修改密碼（/me/password）", () => {
	it("成功：換上新的票、顯示確認並把焦點移過去、有「回我的」，表單不見了", async () => {
		const spy = backend(() => json(NEW_TOKENS));
		renderScreen();

		await fill("old-password", "new-password-1");

		const done = await screen.findByRole("status");
		expect(done).toHaveTextContent(
			"密碼已更新。其他裝置都已登出，這台不用重新登入。",
		);
		expect(done).toHaveFocus();
		expect(getRefreshToken()).toBe("new-r");
		expect(screen.getByRole("link", { name: "回我的" })).toHaveAttribute(
			"href",
			"/me",
		);
		expect(
			screen.queryByRole("button", { name: "更新密碼" }),
		).not.toBeInTheDocument();
		expect(passwordPosts(spy)).toEqual([
			{ current_password: "old-password", new_password: "new-password-1" },
		]);
	});

	it.each([
		[
			"新密碼不到 8 個字",
			"old-password",
			"short-7",
			"short-7",
			"新密碼至少要 8 個字",
		],
		[
			"兩次不一樣",
			"old-password",
			"new-password-1",
			"new-password-2",
			"兩次輸入的新密碼不一樣",
		],
		[
			"跟目前的一樣",
			"same-password",
			"same-password",
			"same-password",
			"新密碼不能跟目前的密碼一樣",
		],
	])("%s：顯示訊息、不送出", async (_name, current, next, confirm, message) => {
		const spy = backend(() => json(NEW_TOKENS));
		renderScreen();

		await fill(current, next, confirm);

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		// 等一下：送出是非同步的，立刻斷言「沒有送」在守衛壞掉時也會成立（第 41 種）。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(passwordPosts(spy)).toEqual([]);
		expect(getRefreshToken()).toBe("r");
	});

	it("目前的密碼錯：後端訊息，票沒換，也沒有觸發換票", async () => {
		const spy = backend(() =>
			errorResponse(422, "CURRENT_PASSWORD_INCORRECT", "目前的密碼不正確"),
		);
		renderScreen();

		await fill("wrong-password", "new-password-1");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"目前的密碼不正確",
		);
		expect(getRefreshToken()).toBe("r");
		// 422 不是 401：畫面上的訊息一樣，只有數請求分得出有沒有換票重送（第 18 種）。
		expect(passwordPosts(spy)).toHaveLength(1);
		expect(refreshCalls(spy)).toBe(0);
		expect(
			screen.getByRole("button", { name: "更新密碼" }),
		).toBeInTheDocument();
	});

	it("後端說新密碼跟目前的一樣（PASSWORD_UNCHANGED）：後端訊息", async () => {
		backend(() =>
			errorResponse(422, "PASSWORD_UNCHANGED", "新密碼不能跟目前的密碼一樣"),
		);
		renderScreen();

		// 前端比的是畫面上的字串；這條模擬前端放行、後端仍然擋下的情況。
		await fill("old-password", "new-password-1");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"新密碼不能跟目前的密碼一樣",
		);
	});

	it("太頻繁（429）：後端訊息加上秒數", async () => {
		const spy = backend(() =>
			errorResponse(
				429,
				"TOO_MANY_LOGIN_ATTEMPTS",
				"登入嘗試次數過多，請稍後再試",
				{ "retry-after": "42" },
			),
		);
		renderScreen();

		await fill("old-password", "new-password-1");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"登入嘗試次數過多，請稍後再試（42 秒後可再試）",
		);
		expect(refreshCalls(spy)).toBe(0);
	});

	it("其他 422（欄位錯誤）：describeFieldErrors", async () => {
		backend(() =>
			json(
				{
					error: {
						code: "VALIDATION_ERROR",
						message: "輸入有誤",
						details: {
							errors: [
								{
									loc: ["body", "new_password"],
									msg: "太長了",
									type: "string_too_long",
								},
							],
						},
					},
				},
				422,
			),
		);
		renderScreen();

		await fill("old-password", "new-password-1");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"new_password：太長了",
		);
	});

	it("網路錯誤：「修改失敗，請再試一次」", async () => {
		backend(() => {
			throw new TypeError("Failed to fetch");
		});
		renderScreen();

		await fill("old-password", "new-password-1");

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"修改失敗，請再試一次",
		);
		expect(getRefreshToken()).toBe("r");
	});
});
