import { shrinkToLongestEdge } from "../lib/resize-image";
import { apiFetch } from "./client";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "./photos";
import type { components } from "./schema";

export type AnalyzeResponse = components["schemas"]["AnalyzeResponse"];

async function analyze(body: unknown): Promise<AnalyzeResponse> {
	const result = await apiFetch<AnalyzeResponse>("/api/ai/analyze", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (result === null) {
		// 後端成功時一律回 200 + AnalyzeResponse；null 代表 apiFetch 的假設被破壞。
		throw new Error("AI 估算沒有回傳結果");
	}
	return result;
}

/** 文字估算。後端會先查食物庫（精確比對名稱），命中就不呼叫 AI、不扣次數。 */
export function analyzeText(text: string): Promise<AnalyzeResponse> {
	return analyze({ kind: "text", text });
}

/** 照片估算。**前處理跟上傳餐點照片同一套**（`uploadMealPhoto`）：先擋大小
 *  （原始檔案的位元組數，不必為註定被拒的檔案花 CPU 縮圖），再把長邊縮到
 *  1280，最後轉 base64。照片只拿來估算，後端不存（P2 規格 §6）。 */
export async function analyzeImage(file: File): Promise<AnalyzeResponse> {
	if (file.size > MAX_PHOTO_BYTES) {
		throw new PhotoTooLargeError();
	}
	const resized = await shrinkToLongestEdge(file, 1280);
	return analyze({ kind: "image", image_base64: await fileToBase64(resized) });
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
