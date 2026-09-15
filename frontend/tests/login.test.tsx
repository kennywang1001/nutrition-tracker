import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens } from "../src/auth/store";
import { Login } from "../src/screens/Login";

function jsonResponse(
	status: number,
	body: unknown,
	headers: HeadersInit = {},
) {
	return new Response(JSON.stringify(body), {
		status,
		headers: { "content-type": "application/json", ...headers },
	});
}

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
});

describe("登入畫面", () => {
	it("成功登入後呼叫 onSuccess", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(200, {
				access_token: "a",
				refresh_token: "r",
				token_type: "bearer",
			}),
		);
		const onSuccess = vi.fn();
		render(<Login onSuccess={onSuccess} />);

		await userEvent.type(
			screen.getByLabelText("Email"),
			"kenny.demo@example.com",
		);
		await userEvent.type(screen.getByLabelText("密碼"), "demo-pass-12345");
		await userEvent.click(screen.getByRole("button", { name: "登入" }));

		expect(onSuccess).toHaveBeenCalledTimes(1);
	});

	it("登入失敗時顯示不區分原因的訊息", async () => {
		// 規格 6.3 節:後端花了 DUMMY_PASSWORD_HASH 與「按送進來的 email 計數」
		// 兩道功夫關掉這個側通道，前端顯示兩種不同的訊息就是把它從另一頭加回來。
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(401, {
				error: {
					code: "INVALID_CREDENTIALS",
					message: "email 或密碼不正確",
					details: {},
				},
			}),
		);
		render(<Login onSuccess={vi.fn()} />);

		await userEvent.type(screen.getByLabelText("Email"), "nobody@example.com");
		await userEvent.type(screen.getByLabelText("密碼"), "wrong");
		await userEvent.click(screen.getByRole("button", { name: "登入" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"email 或密碼不正確",
		);
		// 不可以出現任何暗示帳號存不存在的字眼
		expect(screen.getByRole("alert").textContent).not.toMatch(
			/帳號|不存在|未註冊/,
		);
	});

	it("429 時顯示倒數並停用送出鈕", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			jsonResponse(
				429,
				{
					error: {
						code: "TOO_MANY_LOGIN_ATTEMPTS",
						message: "登入嘗試次數過多，請稍後再試",
						details: {},
					},
				},
				{ "retry-after": "42" },
			),
		);
		render(<Login onSuccess={vi.fn()} />);

		await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
		await userEvent.type(screen.getByLabelText("密碼"), "x");
		await userEvent.click(screen.getByRole("button", { name: "登入" }));

		expect(await screen.findByRole("alert")).toHaveTextContent("42");
		expect(screen.getByRole("button", { name: /登入/ })).toBeDisabled();
	});

	it("連不上伺服器時說的是連線問題，不是帳密問題", async () => {
		vi.spyOn(globalThis, "fetch").mockResolvedValue(
			new Response("<html>502</html>", {
				status: 502,
				headers: { "content-type": "text/html" },
			}),
		);
		render(<Login onSuccess={vi.fn()} />);

		await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
		await userEvent.type(screen.getByLabelText("密碼"), "x");
		await userEvent.click(screen.getByRole("button", { name: "登入" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"無法連線到伺服器",
		);
	});

	it("fetch 本身失敗（斷線、DNS 查不到）時也說是連線問題", async () => {
		// 跟上一條「502 + HTML body」不一樣：那條走的是「拿到 Response，
		// 但 body 不是合法的錯誤信封」，parseErrorResponse 會把它包成
		// ApiError（code UNPARSEABLE_ERROR），落在 catch 的第二個分支。
		// 這一條是 fetch() 這個 Promise 本身 reject──連 Response 都沒有，
		// 例如瀏覽器回報 "Failed to fetch"。這種情況 apiFetch 不會包成
		// ApiError，會直接把原始例外丟出來，落在 catch 的最後一個分支。
		// 兩條分支都要各自有測試覆蓋，不能只測前者。
		vi.spyOn(globalThis, "fetch").mockRejectedValue(
			new TypeError("Failed to fetch"),
		);
		render(<Login onSuccess={vi.fn()} />);

		await userEvent.type(screen.getByLabelText("Email"), "a@example.com");
		await userEvent.type(screen.getByLabelText("密碼"), "x");
		await userEvent.click(screen.getByRole("button", { name: "登入" }));

		expect(await screen.findByRole("alert")).toHaveTextContent(
			"無法連線到伺服器",
		);
	});
});
