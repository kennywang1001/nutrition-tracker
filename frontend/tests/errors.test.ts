import { describe, expect, it } from "vitest";
import { ApiError, parseErrorResponse } from "../src/api/errors";

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

describe("parseErrorResponse", () => {
	it("解析後端的錯誤信封", async () => {
		const response = jsonResponse(404, {
			error: { code: "MEAL_NOT_FOUND", message: "找不到該餐點", details: {} },
		});

		const error = await parseErrorResponse(response);

		expect(error).toBeInstanceOf(ApiError);
		expect(error.status).toBe(404);
		expect(error.code).toBe("MEAL_NOT_FOUND");
		expect(error.message).toBe("找不到該餐點");
	});

	it("保留 VALIDATION_ERROR 的欄位層級細節", async () => {
		// 規格 §5.4：details.errors 有 loc / msg / type，前端要對應到欄位。
		// 後端已經移除了 input 欄位，所以這裡不會有使用者送的原始值。
		const response = jsonResponse(422, {
			error: {
				code: "VALIDATION_ERROR",
				message: "輸入資料格式錯誤",
				details: {
					errors: [
						{
							loc: ["body", "email"],
							msg: "不是有效的 email",
							type: "value_error",
						},
					],
				},
			},
		});

		const error = await parseErrorResponse(response);

		expect(error.code).toBe("VALIDATION_ERROR");
		expect(error.details.errors).toHaveLength(1);
	});

	it("429 帶的 Retry-After 會被解析成秒數", async () => {
		const response = jsonResponse(
			429,
			{
				error: {
					code: "TOO_MANY_LOGIN_ATTEMPTS",
					message: "登入嘗試次數過多，請稍後再試",
					details: {},
				},
			},
			{ "retry-after": "37" },
		);

		const error = await parseErrorResponse(response);

		expect(error.code).toBe("TOO_MANY_LOGIN_ATTEMPTS");
		expect(error.retryAfterSeconds).toBe(37);
	});

	it("沒有 Retry-After 時是 null，不是 0", async () => {
		// 0 會讓 UI 顯示「0 秒後可重試」並立刻放行，那是錯的。
		const response = jsonResponse(429, {
			error: {
				code: "TOO_MANY_LOGIN_ATTEMPTS",
				message: "太多次",
				details: {},
			},
		});

		const error = await parseErrorResponse(response);

		expect(error.retryAfterSeconds).toBeNull();
	});

	it("body 不是 JSON 時也要回 ApiError，不能讓解析例外漏出去", async () => {
		// 這不是假設情境：caddy 或 Tailscale 在後端掛掉時會回 HTML 錯誤頁。
		// 那時整個 app 不該因為 JSON.parse 炸掉而白畫面。
		const response = new Response("<html>502 Bad Gateway</html>", {
			status: 502,
			headers: { "content-type": "text/html" },
		});

		const error = await parseErrorResponse(response);

		expect(error).toBeInstanceOf(ApiError);
		expect(error.status).toBe(502);
		expect(error.code).toBe("UNPARSEABLE_ERROR");
	});

	it("body 是 JSON 但不是信封形狀時也要回 ApiError", async () => {
		// 後端的四個 handler 涵蓋了所有路徑，所以理論上不會發生——
		// 但「理論上不會發生」的東西如果讓 app 白畫面，代價不對稱。
		const response = jsonResponse(500, { detail: "something else" });

		const error = await parseErrorResponse(response);

		expect(error.code).toBe("UNPARSEABLE_ERROR");
	});
});
