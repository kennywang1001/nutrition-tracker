/** 後端的統一錯誤信封（規格 §5.4）。`app/errors.py` 的四個 handler
 *  涵蓋所有路徑，包含路由 404 與未處理例外，所以任何 4xx/5xx 都應該是這個形狀。 */
export type ErrorEnvelope = {
	error: {
		code: string;
		message: string;
		details: Record<string, unknown>;
	};
};

/** 解析不出信封時用的 code。
 *
 *  不是後端會回的值——它代表「這個回應根本不是後端產生的」，
 *  最可能的來源是反向代理或 Tailscale 的錯誤頁。分成獨立的 code
 *  是為了讓 UI 能說「連不上伺服器」而不是「伺服器說了一句我聽不懂的話」。 */
export const UNPARSEABLE_ERROR = "UNPARSEABLE_ERROR";

export class ApiError extends Error {
	// tsconfig.app.json 開了 erasableSyntaxOnly，禁止建構子的參數屬性寫法
	// （那需要實際產生程式碼，不是純型別抹除）。所以欄位宣告與賦值分開寫。
	readonly status: number;
	readonly code: string;
	readonly details: Record<string, unknown>;
	/** 429 的 `Retry-After`，秒。沒有這個標頭時是 `null`，**不是 0** ——
	 *  0 會讓 UI 顯示「0 秒後可重試」並立刻放行。 */
	readonly retryAfterSeconds: number | null;

	constructor(
		status: number,
		code: string,
		message: string,
		details: Record<string, unknown> = {},
		retryAfterSeconds: number | null = null,
	) {
		super(message);
		this.name = "ApiError";
		this.status = status;
		this.code = code;
		this.details = details;
		this.retryAfterSeconds = retryAfterSeconds;
	}
}

function parseRetryAfter(response: Response): number | null {
	const raw = response.headers.get("retry-after");
	if (raw === null) return null;
	const seconds = Number.parseInt(raw, 10);
	return Number.isFinite(seconds) ? seconds : null;
}

function isEnvelope(value: unknown): value is ErrorEnvelope {
	if (typeof value !== "object" || value === null) return false;
	const envelope = value as { error?: unknown };
	if (typeof envelope.error !== "object" || envelope.error === null)
		return false;
	const inner = envelope.error as { code?: unknown; message?: unknown };
	return typeof inner.code === "string" && typeof inner.message === "string";
}

/** 把一個失敗的 `Response` 變成 `ApiError`。**永遠不拋例外** ——
 *  呼叫端已經在處理錯誤路徑了，這裡再拋一次只會把原本的錯誤蓋掉。 */
export async function parseErrorResponse(
	response: Response,
): Promise<ApiError> {
	const retryAfter = parseRetryAfter(response);

	let body: unknown;
	try {
		body = await response.json();
	} catch {
		return new ApiError(
			response.status,
			UNPARSEABLE_ERROR,
			"無法連線到伺服器",
			{},
			retryAfter,
		);
	}

	if (!isEnvelope(body)) {
		return new ApiError(
			response.status,
			UNPARSEABLE_ERROR,
			"無法連線到伺服器",
			{},
			retryAfter,
		);
	}

	return new ApiError(
		response.status,
		body.error.code,
		body.error.message,
		body.error.details ?? {},
		retryAfter,
	);
}
