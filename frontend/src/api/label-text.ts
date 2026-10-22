import { apiFetch } from "./client";
import { ApiError } from "./errors";
import type { components } from "./schema";

export type LabelTextParse = components["schemas"]["LabelTextParseResponse"];

/** 跟後端 `LabelTextRequest.text` 的 `max_length` 同一個數字（標示 OCR 規格 §5）。 */
export const LABEL_TEXT_MAX_LENGTH = 4000;

/** 營養標示的文字（手機辨識或貼上的）→ 每 100 的營養素。**不用 AI 額度**；讀不完整也是成功
 *  （`complete: false`）。超過上限的部分切掉再送：JS 的 `length` 數 UTF-16 單位、Python 的 `len`
 *  數字元，前者不會比後者小，切完一定過得了後端。呼叫端不送空字串（後端 422）。 */
export async function parseLabelText(text: string): Promise<LabelTextParse> {
	const result = await apiFetch<LabelTextParse>("/api/foods/parse-label-text", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ text: text.slice(0, LABEL_TEXT_MAX_LENGTH) }),
	});
	if (result === null) {
		throw new Error("讀營養標示的文字沒有回傳結果");
	}
	return result;
}

/** 送不出去、或被限速時說的話。 */
export function describeLabelTextError(error: unknown): string {
	if (error instanceof ApiError && error.code === "TOO_MANY_LABEL_PARSES") {
		return error.message;
	}
	return "讀不了，請檢查網路再試一次";
}
