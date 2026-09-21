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

/** 帶 token 打一次請求，401 時換一次票並重送**恰好一次**。
 *
 *  **這是 `apiFetch` 與 `fetchPhotoBlob` 共用的內核。** 兩者的差異只在
 *  成功時怎麼解 body（`.json()` 還是 `.blob()`）—— 那個差異留給呼叫端，
 *  這裡不知道、也不該知道。
 *
 *  回傳的是最終那個 `Response`，**可能仍然不 ok**（重送之後又 401、
 *  或換票本身失敗）：呼叫端一律用 `!response.ok` 判斷要不要
 *  `parseErrorResponse`。
 *
 *  重送之後又 401 就不再重試 —— 那代表問題不在票過期，無限重試只會把
 *  429 也一起惹出來（規格 §6.2）。換票失敗（`refreshTokens()` 回 `false`）
 *  時也不重送原請求，直接把當下這個（第一次的 401）response 交回去。 */
async function fetchWithAuthRetry(
	path: string,
	init: RequestInit,
): Promise<Response> {
	let response = await fetch(path, withAuth(init));

	if (response.status === 401) {
		const refreshed = await refreshTokens();
		if (refreshed) {
			response = await fetch(path, withAuth(init));
		}
	}

	return response;
}

/** 打後端 API。路徑一律是相對的 `/api/...` —— 前端沒有任何地方知道後端在哪
 *  （dev 走 Vite proxy、prod 走 caddy，兩邊都同源，規格決策 1）。
 *
 *  成功回解析後的 body（204 回 `null`）；失敗拋 `ApiError`。
 *
 *  401 時會換一次票並重送**一次**（`fetchWithAuthRetry`）。 */
export async function apiFetch<T = unknown>(
	path: string,
	init: RequestInit = {},
): Promise<T | null> {
	const response = await fetchWithAuthRetry(path, init);

	if (!response.ok) {
		throw await parseErrorResponse(response);
	}

	return parseBody<T>(response);
}

/** 取一個需要認證的二進位端點（目前只有餐點照片），回 `Blob`。
 *
 *  **為什麼不是 `apiFetch` 的一個選項：** `apiFetch` 的 `parseBody` 一律
 *  `.json()`，而照片端點回的是 `image/jpeg` 的位元組。硬塞一個
 *  「回傳型別」參數進 `apiFetch` 會讓所有既有呼叫端（一定是 JSON 的那些）
 *  多一個永遠用不到的分支。跟 `apiFetch` 共用的只有
 *  `fetchWithAuthRetry`（帶 token、401 換票重送一次）這個內核，
 *  解 body 的方式各自決定。
 *
 *  失敗（含 404 `MEAL_PHOTO_NOT_FOUND`）一律拋 `ApiError` ——
 *  呼叫端（`useMealPhoto`）決定要不要顯示圖，不在這裡吞掉。 */
export async function fetchPhotoBlob(path: string): Promise<Blob> {
	const response = await fetchWithAuthRetry(path, {});

	if (!response.ok) {
		throw await parseErrorResponse(response);
	}

	return response.blob();
}

export { ApiError };
