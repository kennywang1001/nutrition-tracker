import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateDisplayName } from "../src/api/me";
import { setTargetFromToday } from "../src/api/targets";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { changePassword } from "../src/auth/session";
import {
	clearTokens,
	getAccessToken,
	getRefreshToken,
	setTokens,
} from "../src/auth/store";
import { readLinkToken } from "../src/lib/link-token";
import { readInviteToken } from "../src/screens/Join";
import { json, mockApi } from "./helpers/mock-api";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "old-a", refresh_token: "old-r" });
});

function bodyOf(spy: ReturnType<typeof mockApi>, index = 0): unknown {
	const init = spy.mock.calls[index]?.[1];
	return JSON.parse(String(init?.body));
}

describe("帳號設定的 API 層", () => {
	it("改密碼成功之後換上新的一組票", async () => {
		const spy = mockApi([
			{
				method: "POST",
				path: "/api/me/password",
				handler: () =>
					json({
						access_token: "new-a",
						refresh_token: "new-r",
						token_type: "bearer",
					}),
			},
		]);

		await changePassword("old-password", "new-password-1");

		expect(bodyOf(spy)).toEqual({
			current_password: "old-password",
			new_password: "new-password-1",
		});
		expect(getAccessToken()).toBe("new-a");
		expect(getRefreshToken()).toBe("new-r");
	});

	it("改密碼失敗時票不變", async () => {
		mockApi([
			{
				method: "POST",
				path: "/api/me/password",
				handler: () =>
					json(
						{
							error: {
								code: "CURRENT_PASSWORD_INCORRECT",
								message: "目前的密碼不正確",
								details: {},
							},
						},
						422,
					),
			},
		]);

		await expect(
			changePassword("wrong", "new-password-1"),
		).rejects.toMatchObject({
			code: "CURRENT_PASSWORD_INCORRECT",
		});
		expect(getAccessToken()).toBe("old-a");
		expect(getRefreshToken()).toBe("old-r");
	});

	it("存目標用 PUT，四個鍵都送", async () => {
		const spy = mockApi([
			{
				method: "PUT",
				path: "/api/targets/today",
				handler: () =>
					json({
						id: 1,
						kcal: "1800.00",
						protein_g: null,
						fat_g: null,
						carb_g: null,
						label: null,
						effective_from: "2019-07-04",
						effective_to: null,
					}),
			},
		]);

		await setTargetFromToday({
			kcal: "1800",
			protein_g: null,
			fat_g: null,
			carb_g: null,
		});

		expect(spy.mock.calls[0]?.[1]?.method).toBe("PUT");
		expect(bodyOf(spy)).toEqual({
			kcal: "1800",
			protein_g: null,
			fat_g: null,
			carb_g: null,
		});
	});

	it("改名稱只送 display_name", async () => {
		const spy = mockApi([
			{
				method: "PATCH",
				path: "/api/me",
				handler: () =>
					json({
						id: 1,
						email: "k@example.com",
						display_name: "新名字",
						role: "user",
						timezone: "Asia/Taipei",
					}),
			},
		]);

		const updated = await updateDisplayName("新名字");

		expect(bodyOf(spy)).toEqual({ display_name: "新名字" });
		expect(updated.display_name).toBe("新名字");
	});

	it("連結的碼：# 之後連續的 token_urlsafe 字元；邀請沿用同一個函式", () => {
		expect(readLinkToken("#abc_DEF-123。")).toBe("abc_DEF-123");
		expect(readLinkToken("")).toBe("");
		expect(readInviteToken).toBe(readLinkToken);
	});
});
