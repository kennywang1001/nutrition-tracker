import { apiFetch } from "./client";

const JSON_HEADERS = { "content-type": "application/json" };

/** 沒登入時打的兩個端點（帳號設定規格 §3.5、§3.6）。碼一律放 body，不放網址——
 *  網址會進存取紀錄，body 不會。 */
export async function checkResetLink(token: string): Promise<boolean> {
	const result = await apiFetch<{ valid: boolean }>(
		"/api/auth/password-reset-status",
		{ method: "POST", headers: JSON_HEADERS, body: JSON.stringify({ token }) },
	);
	return result?.valid === true;
}

/** 成功是 204、不回票（規格 決定 16）：使用者要用新密碼親自登入一次，確認記得住。 */
export async function resetPassword(
	token: string,
	newPassword: string,
): Promise<void> {
	await apiFetch("/api/auth/password-reset", {
		method: "POST",
		headers: JSON_HEADERS,
		body: JSON.stringify({ token, new_password: newPassword }),
	});
}
