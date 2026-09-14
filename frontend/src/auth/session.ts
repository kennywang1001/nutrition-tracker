import { apiFetch } from "../api/client";
import { clearTokens, getRefreshToken, setTokens, type Tokens } from "./store";

export async function login(email: string, password: string): Promise<void> {
	const tokens = await apiFetch<Tokens>("/api/auth/login", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ email, password }),
	});
	if (tokens === null) throw new Error("登入回應沒有 body");
	setTokens(tokens);
}

/** 登出。**不管伺服器怎麼回都清掉本地狀態**（規格 §6.6）。
 *
 *  網路斷線時「登出」不能失敗 —— 使用者的意圖是「這台裝置上不要留著我的
 *  帳號」，而那件事是本地就能做到的。伺服器端的撤銷會在票過期時自然收斂。 */
export async function logout(): Promise<void> {
	const refreshToken = getRefreshToken();
	try {
		if (refreshToken !== null) {
			await apiFetch("/api/auth/logout", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ refresh_token: refreshToken }),
			});
		}
	} catch {
		// 刻意吞掉
	} finally {
		clearTokens();
	}
}
