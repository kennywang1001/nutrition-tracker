import { refreshTokens } from "../auth/refresh";
import { getAccessToken } from "../auth/store";
import { ApiError, parseErrorResponse } from "./errors";

function withAuth(init: RequestInit): RequestInit {
	const token = getAccessToken();
	const headers = new Headers(init.headers);
	if (token !== null) {
		headers.set("authorization", `Bearer ${token}`);
	}
	// 沒有 token 時**不設這個標頭**，而不是設成 "Bearer null" ——
	// 後端的 HTTPBearer 對後者會回 401 INVALID_TOKEN，對前者回
	// 401 NOT_AUTHENTICATED。兩個 code 的意思不一樣，UI 會想分辨。
	return { ...init, headers };
}

async function parseBody<T>(response: Response): Promise<T | null> {
	// 204 沒有 body；對空 body 呼叫 .json() 會拋。
	// 登出的兩個端點都是 204。
	if (response.status === 204) return null;
	return (await response.json()) as T;
}

/** 打後端 API。路徑一律是相對的 `/api/...` —— 前端沒有任何地方知道後端在哪
 *  （dev 走 Vite proxy、prod 走 caddy，兩邊都同源，規格決策 1）。
 *
 *  成功回解析後的 body（204 回 `null`）；失敗拋 `ApiError`。
 *
 *  401 時會換一次票並重送**一次**。重送之後又 401 就直接拋 ——
 *  那代表問題不在票過期，無限重試只會把 429 也一起惹出來（規格 §6.2）。 */
export async function apiFetch<T = unknown>(
	path: string,
	init: RequestInit = {},
): Promise<T | null> {
	let response = await fetch(path, withAuth(init));

	if (response.status === 401) {
		const refreshed = await refreshTokens();
		if (!refreshed) {
			throw await parseErrorResponse(response);
		}
		response = await fetch(path, withAuth(init));
	}

	if (!response.ok) {
		throw await parseErrorResponse(response);
	}

	return parseBody<T>(response);
}

export { ApiError };
