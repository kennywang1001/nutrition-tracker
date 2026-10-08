import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useLocation } from "react-router";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, getRefreshToken } from "../src/auth/store";
import {
	RESET_INVALID_TEXT,
	ResetPassword,
	ResetPasswordWhileLoggedIn,
} from "../src/screens/ResetPassword";

function jsonResponse(status: number, body: unknown) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json" },
	});
}

function errorResponse(
	status: number,
	code: string,
	message: string,
	details: Record<string, unknown> = {},
) {
	return jsonResponse(status, { error: { code, message, details } });
}

type Handler = (body: Record<string, unknown>) => Response;

/** 沒登入的畫面不能用 `mockApi`（它對沒帶 Authorization 的請求一律回 401）——同 join.test.tsx。
 *  `endsWith`：`/api/auth/password-reset` 是 `/api/auth/password-reset-status` 的前綴，
 *  用 includes 會分不出來。 */
function backend(handlers: { status?: Handler; reset?: Handler } = {}) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = String(input);
			const body = init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: {};
			if (url.endsWith("/api/auth/password-reset-status"))
				return (handlers.status ?? (() => jsonResponse(200, { valid: true })))(
					body,
				);
			if (url.endsWith("/api/auth/password-reset"))
				return (handlers.reset ?? (() => new Response(null, { status: 204 })))(
					body,
				);
			throw new Error(`reset-password.test 沒有準備：${url}`);
		});
}

function bodiesSentTo(spy: ReturnType<typeof backend>, path: string) {
	return spy.mock.calls
		.filter(([url]) => String(url).endsWith(path))
		.map(
			([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>,
		);
}

async function fillAndSubmit(password = "a-new-password", confirm = password) {
	await userEvent.type(
		await screen.findByLabelText("新密碼", { exact: true }),
		password,
	);
	await userEvent.type(screen.getByLabelText("再輸入一次新密碼"), confirm);
	await userEvent.click(screen.getByRole("button", { name: "重設密碼" }));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/reset-password#tok-1");
});

afterEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("重設密碼（/reset-password）", () => {
	it("打開時拿 # 後面的碼去確認，有效就顯示表單", async () => {
		const spy = backend();

		render(<ResetPassword />);

		expect(screen.getByText("確認連結中…")).toBeInTheDocument();
		expect(
			await screen.findByLabelText("再輸入一次新密碼"),
		).toBeInTheDocument();
		expect(screen.getByLabelText("新密碼", { exact: true })).toHaveAttribute(
			"autocomplete",
			"new-password",
		);
		expect(
			screen.getByRole("button", { name: "重設密碼" }),
		).toBeInTheDocument();
		expect(bodiesSentTo(spy, "/api/auth/password-reset-status")).toEqual([
			{ token: "tok-1" },
		]);
	});

	it("# 後面是空的：直接當成失效，不打 API", async () => {
		window.history.replaceState(null, "", "/reset-password");
		const spy = backend();

		render(<ResetPassword />);

		expect(await screen.findByText(RESET_INVALID_TEXT)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "去登入" })).toHaveAttribute(
			"href",
			"/",
		);
		expect(spy).not.toHaveBeenCalled();
	});

	it("連結失效（valid: false）：說明與「去登入」，沒有表單", async () => {
		backend({ status: () => jsonResponse(200, { valid: false }) });

		render(<ResetPassword />);

		expect(await screen.findByText(RESET_INVALID_TEXT)).toBeInTheDocument();
		expect(screen.getByRole("link", { name: "去登入" })).toHaveAttribute(
			"href",
			"/",
		);
		expect(
			screen.queryByRole("button", { name: "重設密碼" }),
		).not.toBeInTheDocument();
	});

	it("碼的格式根本不對（422）：也是失效", async () => {
		backend({
			status: () => errorResponse(422, "VALIDATION_ERROR", "輸入資料格式錯誤"),
		});

		render(<ResetPassword />);

		expect(await screen.findByText(RESET_INVALID_TEXT)).toBeInTheDocument();
	});

	it.each([
		["伺服器錯誤（500）", () => errorResponse(500, "INTERNAL_ERROR", "壞了")],
		[
			"連不上（fetch 丟例外）",
			() => {
				throw new TypeError("Failed to fetch");
			},
		],
	])("%s：不能說它失效，請他檢查網路", async (_name, status) => {
		backend({ status });

		render(<ResetPassword />);

		expect(
			await screen.findByText("無法確認連結，請檢查網路後重新整理"),
		).toBeInTheDocument();
		expect(screen.queryByText(RESET_INVALID_TEXT)).not.toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "重設密碼" }),
		).not.toBeInTheDocument();
	});

	it.each([
		["新密碼不到 8 個字", "short-7", "short-7", "新密碼至少要 8 個字"],
		[
			"兩次不一樣",
			"a-new-password",
			"another-password",
			"兩次輸入的新密碼不一樣",
		],
	])("%s：顯示訊息、不送出", async (_name, password, confirm, message) => {
		const spy = backend();
		render(<ResetPassword />);

		await fillAndSubmit(password, confirm);

		expect(await screen.findByRole("alert")).toHaveTextContent(message);
		// 等一下：送出是非同步的，立刻斷言「沒有送」在守衛壞掉時也會成立（第 41 種）。
		await new Promise((resolve) => setTimeout(resolve, 50));
		expect(bodiesSentTo(spy, "/api/auth/password-reset")).toEqual([]);
	});

	it("成功：送碼與新密碼、碼從網址列消失、「密碼已重設，請登入」有焦點，不自動登入", async () => {
		const spy = backend();
		render(<ResetPassword />);

		await fillAndSubmit();

		const done = await screen.findByRole("status");
		expect(done).toHaveTextContent("密碼已重設，請登入");
		expect(done).toHaveFocus();
		expect(screen.getByRole("link", { name: "去登入" })).toHaveAttribute(
			"href",
			"/",
		);
		expect(bodiesSentTo(spy, "/api/auth/password-reset")).toEqual([
			{ token: "tok-1", new_password: "a-new-password" },
		]);
		expect(window.location.pathname).toBe("/");
		expect(window.location.hash).toBe("");
		// 不自動登入（規格 決定 16）：沒有任何票落地，也沒有打登入。
		expect(getRefreshToken()).toBeNull();
		expect(
			spy.mock.calls.some(([url]) => String(url).includes("/api/auth/login")),
		).toBe(false);
		expect(
			screen.queryByRole("button", { name: "重設密碼" }),
		).not.toBeInTheDocument();
	});

	it("送出時連結已經失效（403 RESET_LINK_INVALID）：切到失效畫面，網址不動", async () => {
		backend({
			reset: () => errorResponse(403, "RESET_LINK_INVALID", RESET_INVALID_TEXT),
		});
		render(<ResetPassword />);

		await fillAndSubmit();

		expect(await screen.findByText(RESET_INVALID_TEXT)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "重設密碼" }),
		).not.toBeInTheDocument();
		expect(window.location.pathname).toBe("/reset-password");
	});

	it("422：欄位訊息，表單留著", async () => {
		backend({
			reset: () =>
				errorResponse(422, "VALIDATION_ERROR", "輸入資料格式錯誤", {
					errors: [
						{
							loc: ["body", "new_password"],
							msg: "太長了",
							type: "string_too_long",
						},
					],
				}),
		});
		render(<ResetPassword />);

		await fillAndSubmit();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"new_password：太長了",
		);
		expect(
			screen.getByRole("button", { name: "重設密碼" }),
		).toBeInTheDocument();
	});

	it("其他錯誤：「重設失敗，請再試一次」，表單留著", async () => {
		backend({ reset: () => errorResponse(500, "INTERNAL_ERROR", "壞了") });
		render(<ResetPassword />);

		await fillAndSubmit();

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"重設失敗，請再試一次",
		);
		expect(screen.getByRole("button", { name: "重設密碼" })).not.toBeDisabled();
	});
});

/** 讀 MemoryRouter 目前的位置——`ResetPasswordWhileLoggedIn` 用 navigate 拿掉碼，看的是路由的 location。 */
function LocationProbe() {
	const location = useLocation();
	return (
		<output data-testid="location">{location.pathname + location.hash}</output>
	);
}

describe("已登入的人打開重設連結", () => {
	function renderWhileLoggedIn() {
		render(
			<MemoryRouter initialEntries={["/reset-password#tok-1"]}>
				<Routes>
					<Route
						path="/reset-password"
						element={
							<>
								<ResetPasswordWhileLoggedIn />
								<LocationProbe />
							</>
						}
					/>
				</Routes>
			</MemoryRouter>,
		);
	}

	const ME = {
		id: 1,
		email: "kenny@example.com",
		display_name: "Kenny",
		role: "user",
		timezone: "Asia/Taipei",
	};

	/** 等過一輪再斷言「碼還在」：立刻斷言在 effect 還沒跑的時候也成立（第 41 種）。 */
	function settle() {
		return act(() => new Promise<void>((resolve) => setTimeout(resolve, 50)));
	}

	it("兩條路都說清楚（記得密碼／忘記密碼）、連到「我的」；不打任何重設端點；確認登入還有效之後碼才從路由的網址拿掉", async () => {
		// 確認登入的那個請求（`GET /api/me`）掛著不回：這段期間碼要留著。
		let respondMe: (response: Response) => void = () => undefined;
		const spy = vi.spyOn(globalThis, "fetch").mockImplementation(
			() =>
				new Promise<Response>((resolve) => {
					respondMe = resolve;
				}),
		);

		renderWhileLoggedIn();

		// 以前只有「要改自己的密碼，請到『我的』→『修改密碼』」——忘記密碼（所以才拿到這條
		// 連結）但這台剛好還登入著的人，照做會卡在「目前的密碼」那一格（帳號設定審查 M2）。
		expect(
			screen.getByText(/你已經登入了。這個連結是給忘記密碼的人用的/),
		).toBeInTheDocument();
		expect(
			screen.getByText(/還記得密碼的話，到「我的」→「修改密碼」/),
		).toBeInTheDocument();
		// 碼會從網址列拿掉，所以「重新打開」要講清楚是回到收到連結的地方再點一次。
		expect(
			screen.getByText(
				/忘記密碼的話，先登出，再重新打開這個連結.*從收到連結的地方再點一次/,
			),
		).toBeInTheDocument();
		// 「修改密碼」與「登出」都在「我的」。
		expect(screen.getByRole("link", { name: "到我的" })).toHaveAttribute(
			"href",
			"/me",
		);
		expect(screen.getByRole("link", { name: "回總覽" })).toHaveAttribute(
			"href",
			"/",
		);

		// 還不知道這台的登入有沒有效（可能只是留著一張過期的票）：碼不能先拿掉。
		await waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
		await settle();
		expect(screen.getByTestId("location")).toHaveTextContent(
			/^\/reset-password#tok-1$/,
		);

		respondMe(jsonResponse(200, ME));

		await waitFor(() =>
			expect(screen.getByTestId("location")).toHaveTextContent(
				/^\/reset-password$/,
			),
		);
		// 唯一的請求是確認登入的那一個；重設的端點一個都沒碰（連結不被用掉）。
		expect(spy.mock.calls.map(([url]) => String(url))).toEqual(["/api/me"]);
	});

	it("確認不了登入（連不上）：碼留著，說明照舊", async () => {
		const spy = vi
			.spyOn(globalThis, "fetch")
			.mockRejectedValue(new TypeError("network request failed"));

		renderWhileLoggedIn();

		await waitFor(() => expect(spy).toHaveBeenCalled());
		await settle();
		expect(screen.getByTestId("location")).toHaveTextContent(
			/^\/reset-password#tok-1$/,
		);
		expect(
			screen.getByText(/你已經登入了。這個連結是給忘記密碼的人用的/),
		).toBeInTheDocument();
	});
});
