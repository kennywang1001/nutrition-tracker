import { type APIRequestContext, expect, type Page } from "@playwright/test";
import { ADMIN } from "./accounts.ts";

export type NewAccount = { email: string; password: string; name: string };

/** 每條測試自己開一個帳號（帳號設定規格 §7.3）：這些測試會改密碼、改目標——
 *  動共用的示範帳號會弄壞別的 spec（它們用固定密碼登入、斷言總覽的數字）。 */
export async function newAccount(
	request: APIRequestContext,
	label: string,
): Promise<NewAccount> {
	const login = await request.post("/api/auth/login", {
		data: { email: ADMIN.email, password: ADMIN.password },
	});
	expect(login.ok()).toBe(true);
	const { access_token } = await login.json();
	const invite = await request.post("/api/admin/invites", {
		headers: { authorization: `Bearer ${access_token}` },
		data: { note: `e2e ${label}` },
	});
	expect(invite.status()).toBe(201);
	const { token } = await invite.json();
	const stamp = `${Date.now()}${Math.floor(Math.random() * 1000)}`;
	const account = {
		email: `e2e.${label}.${stamp}@example.com`,
		password: "first-pass-12345",
		name: `E2E ${label} ${stamp}`,
	};
	const register = await request.post("/api/auth/register", {
		data: {
			email: account.email,
			password: account.password,
			display_name: account.name,
			invite_token: token,
		},
	});
	expect(register.status()).toBe(201);
	return account;
}

/** 用 UI 登入（`page.goto` 只在還沒登入時用：登入之後換頁一律點擊）。 */
export async function loginAs(
	page: Page,
	account: { email: string; password: string },
) {
	await page.goto("/");
	await page.getByLabel("Email", { exact: true }).fill(account.email);
	await page.getByLabel("密碼", { exact: true }).fill(account.password);
	await page.getByRole("button", { name: "登入", exact: true }).click();
	await expect(
		page.getByRole("heading", { name: "總覽", exact: true }),
	).toBeVisible();
}
