import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, getRefreshToken } from "../src/auth/store";
import { INVITE_INVALID_TEXT, Join } from "../src/screens/Join";

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

const USER = {
	id: 9,
	email: "friend@example.com",
	display_name: "小明",
	role: "user",
	timezone: "Asia/Taipei",
};
const TOKENS = { access_token: "a", refresh_token: "r", token_type: "bearer" };

type Handler = (body: Record<string, unknown>) => Response;

/** 沒登入的畫面不能用 `mockApi`（它對沒帶 Authorization 的請求一律回 401）。 */
function backend(
	handlers: { status?: Handler; register?: Handler; login?: Handler } = {},
) {
	return vi
		.spyOn(globalThis, "fetch")
		.mockImplementation(async (input, init) => {
			const url = String(input);
			const body = init?.body
				? (JSON.parse(String(init.body)) as Record<string, unknown>)
				: {};
			if (url.endsWith("/api/auth/invite-status"))
				return (handlers.status ?? (() => jsonResponse(200, { valid: true })))(
					body,
				);
			if (url.endsWith("/api/auth/register"))
				return (handlers.register ?? (() => jsonResponse(201, USER)))(body);
			if (url.endsWith("/api/auth/login"))
				return (handlers.login ?? (() => jsonResponse(200, TOKENS)))(body);
			throw new Error(`join.test 沒有準備：${url}`);
		});
}

function bodiesSentTo(spy: ReturnType<typeof backend>, path: string) {
	return spy.mock.calls
		.filter(([url]) => String(url).endsWith(path))
		.map(
			([, init]) => JSON.parse(String(init?.body)) as Record<string, unknown>,
		);
}

async function fillAndSubmit(password = "a-good-password", confirm = password) {
	await userEvent.type(
		await screen.findByLabelText("Email"),
		"friend@example.com",
	);
	await userEvent.type(screen.getByLabelText("名字"), "小明");
	await userEvent.type(screen.getByLabelText("密碼"), password);
	await userEvent.type(screen.getByLabelText("再輸入一次密碼"), confirm);
	await userEvent.click(screen.getByRole("button", { name: "建立帳號" }));
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	window.history.replaceState(null, "", "/join#tok-123");
});

afterEach(() => {
	window.history.replaceState(null, "", "/");
});

describe("建立帳號（/join）", () => {
	it("打開時拿網址 # 後面的邀請碼去確認，有效就顯示表單", async () => {
		const spy = backend();

		render(<Join onSuccess={vi.fn()} />);

		expect(await screen.findByLabelText("再輸入一次密碼")).toBeInTheDocument();
		expect(bodiesSentTo(spy, "/api/auth/invite-status")).toEqual([
			{ token: "tok-123" },
		]);
	});

	it("失效的連結只顯示說明與「去登入」，沒有表單", async () => {
		backend({ status: () => jsonResponse(200, { valid: false }) });

		render(<Join onSuccess={vi.fn()} />);

		expect(await screen.findByText(INVITE_INVALID_TEXT)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "建立帳號" }),
		).not.toBeInTheDocument();
		expect(screen.getByRole("link", { name: "去登入" })).toHaveAttribute(
			"href",
			"/",
		);
	});

	it("# 後面是空的：直接當成失效，不打 API", async () => {
		window.history.replaceState(null, "", "/join");
		const spy = backend();

		render(<Join onSuccess={vi.fn()} />);

		expect(await screen.findByText(INVITE_INVALID_TEXT)).toBeInTheDocument();
		expect(spy).not.toHaveBeenCalled();
	});

	it("兩次密碼不一樣：不送出", async () => {
		const spy = backend();
		render(<Join onSuccess={vi.fn()} />);

		await fillAndSubmit("a-good-password", "another-password");

		expect(await screen.findByText("兩次輸入的密碼不一樣")).toBeInTheDocument();
		expect(bodiesSentTo(spy, "/api/auth/register")).toEqual([]);
	});

	it("密碼不到 8 個字：不送出", async () => {
		const spy = backend();
		render(<Join onSuccess={vi.fn()} />);

		await fillAndSubmit("short");

		expect(await screen.findByText("密碼至少要 8 個字")).toBeInTheDocument();
		expect(bodiesSentTo(spy, "/api/auth/register")).toEqual([]);
	});

	it("成功：註冊帶邀請碼、自動登入、網址換成 /（邀請碼從網址列消失）", async () => {
		const spy = backend();
		const onSuccess = vi.fn();
		render(<Join onSuccess={onSuccess} />);

		await fillAndSubmit();

		await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
		const [registered] = bodiesSentTo(spy, "/api/auth/register");
		expect(registered).toMatchObject({
			email: "friend@example.com",
			display_name: "小明",
			password: "a-good-password",
			invite_token: "tok-123",
		});
		expect(typeof registered?.timezone).toBe("string");
		expect(bodiesSentTo(spy, "/api/auth/login")).toEqual([
			{ email: "friend@example.com", password: "a-good-password" },
		]);
		expect(getRefreshToken()).toBe("r");
		expect(window.location.pathname).toBe("/");
		expect(window.location.hash).toBe("");
	});

	it("email 撞名：顯示後端訊息，表單還在", async () => {
		backend({
			register: () =>
				errorResponse(409, "EMAIL_TAKEN", "這個 email 已經註冊過了"),
		});
		const onSuccess = vi.fn();
		render(<Join onSuccess={onSuccess} />);

		await fillAndSubmit();

		expect(
			await screen.findByText("這個 email 已經註冊過了"),
		).toBeInTheDocument();
		expect(
			screen.getByRole("button", { name: "建立帳號" }),
		).toBeInTheDocument();
		expect(onSuccess).not.toHaveBeenCalled();
	});

	it("送出時邀請已經失效：切到失效畫面", async () => {
		backend({
			register: () =>
				errorResponse(403, "INVITE_INVALID", "這個邀請連結已經失效"),
		});
		render(<Join onSuccess={vi.fn()} />);

		await fillAndSubmit();

		expect(await screen.findByText(INVITE_INVALID_TEXT)).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "建立帳號" }),
		).not.toBeInTheDocument();
	});

	it("瀏覽器的時區被後端拒絕：改用 Asia/Taipei 重送一次", async () => {
		const real = Intl.DateTimeFormat.prototype.resolvedOptions;
		vi.spyOn(
			Intl.DateTimeFormat.prototype,
			"resolvedOptions",
		).mockImplementation(function (this: Intl.DateTimeFormat) {
			return { ...real.call(this), timeZone: "Mars/Olympus" };
		});
		const spy = backend({
			register: (body) =>
				body.timezone === "Mars/Olympus"
					? errorResponse(422, "VALIDATION_ERROR", "輸入資料格式錯誤", {
							errors: [{ loc: ["body", "timezone"], msg: "未知的時區" }],
						})
					: jsonResponse(201, USER),
		});
		const onSuccess = vi.fn();
		render(<Join onSuccess={onSuccess} />);

		await fillAndSubmit();

		await waitFor(() => expect(onSuccess).toHaveBeenCalledTimes(1));
		expect(
			bodiesSentTo(spy, "/api/auth/register").map((body) => body.timezone),
		).toEqual(["Mars/Olympus", "Asia/Taipei"]);
	});

	it("帳號建好但自動登入失敗：請他自己登入", async () => {
		backend({
			login: () => errorResponse(500, "INTERNAL_ERROR", "伺服器錯誤"),
		});
		const onSuccess = vi.fn();
		render(<Join onSuccess={onSuccess} />);

		await fillAndSubmit();

		expect(
			await screen.findByText("帳號建好了，請用剛剛的 email 登入"),
		).toBeInTheDocument();
		expect(onSuccess).not.toHaveBeenCalled();
	});
});
