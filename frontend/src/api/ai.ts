import { preparePhoto } from "../lib/photo";
import { apiFetch } from "./client";
import { ApiError } from "./errors";
import { describePhotoUploadError, PhotoTooLargeError } from "./photos";
import type { components } from "./schema";

export type AnalyzeResponse = components["schemas"]["AnalyzeResponse"];
export type AnalyzeMealResponse = components["schemas"]["AnalyzeMealResponse"];
export type AnalyzedMealItem = components["schemas"]["AnalyzedMealItem"];
export type LibraryFoodMatch = components["schemas"]["LibraryFoodMatch"];

const ANALYZE = "/api/ai/analyze";
const ANALYZE_MEAL = "/api/ai/analyze-meal";

async function post<T>(path: string, body: unknown): Promise<T> {
	const result = await apiFetch<T>(path, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (result === null) {
		// 後端成功時一律回 200 + JSON；null 代表 apiFetch 的假設被破壞。
		throw new Error("AI 估算沒有回傳結果");
	}
	return result;
}

/** 文字估算（一樣食物）。後端會先查食物庫（精確比對名稱），命中就不呼叫 AI、不扣次數。 */
export function analyzeText(text: string): Promise<AnalyzeResponse> {
	return post(ANALYZE, { kind: "text", text });
}

/** 照片估算（一樣食物）。**前處理跟上傳餐點照片同一套**（`preparePhoto`：先擋大小，
 *  再把長邊縮到 1280），最後轉 base64。照片只拿來估算，後端不存（P2 規格 §6）。 */
export async function analyzeImage(file: File): Promise<AnalyzeResponse> {
	const resized = await preparePhoto(file);
	return post(ANALYZE, {
		kind: "image",
		image_base64: await fileToBase64(resized),
	});
}

/** 一餐的文字估算（AI 多樣估算規格 §3.1）：回一句描述＋最多 8 樣。整段文字剛好是
 *  食物庫裡一個食物的名稱時不呼叫 AI（`analysis_id` 是 null、只有那一樣）。
 *  算一次額度，不管估出幾樣。 */
export function analyzeMealText(text: string): Promise<AnalyzeMealResponse> {
	return post(ANALYZE_MEAL, { kind: "text", text });
}

/** 一餐的照片估算。照片的前處理同 `analyzeImage`。 */
export async function analyzeMealImage(
	file: File,
): Promise<AnalyzeMealResponse> {
	const resized = await preparePhoto(file);
	return post(ANALYZE_MEAL, {
		kind: "image",
		image_base64: await fileToBase64(resized),
	});
}

/** 估算失敗時給人看的話。兩個端點的錯誤碼是同一組（後端是同一批函式丟的），
 *  單樣面板與多樣面板共用這一份。 */
export function describeAnalyzeError(error: unknown): string {
	if (error instanceof PhotoTooLargeError) return error.message;
	if (error instanceof ApiError) {
		switch (error.code) {
			case "AI_DAILY_LIMIT":
				// 後端的訊息含「今天用了 N/20」。
				return error.message;
			case "AI_NOT_CONFIGURED":
				// 後端的訊息說缺什麼（「AI 分析未設定：缺 GEMINI_API_KEY」），
				// 部署手冊叫操作者照著它補。
				return error.message;
			case "AI_MISCONFIGURED":
			case "AI_UPSTREAM_ERROR":
				// 後端把供應商的錯誤分成兩類（AI 與編輯畫面的收尾規格 §2 第 2 項）：
				// 「設定有問題，請管理員檢查」與「暫時無法使用，請稍後再試」——
				// 該做的事不同，通用的「再試一次」對前者是錯的指示。
				return error.message;
			case "AI_BAD_RESPONSE":
				return "AI 這次的回答看不懂，可以再試一次";
			case "PHOTO_TOO_LARGE":
			case "INVALID_PHOTO":
				return describePhotoUploadError(error);
		}
	}
	return "AI 估算失敗，請再試一次";
}

/** `readAsDataURL` 給的是 `data:image/jpeg;base64,....`——後端只要逗號後面那段。 */
export function fileToBase64(file: Blob): Promise<string> {
	return new Promise((resolve, reject) => {
		const reader = new FileReader();
		reader.onload = () => {
			const dataUrl = String(reader.result);
			resolve(dataUrl.slice(dataUrl.indexOf(",") + 1));
		};
		reader.onerror = () => reject(reader.error ?? new Error("讀取照片失敗"));
		reader.readAsDataURL(file);
	});
}
