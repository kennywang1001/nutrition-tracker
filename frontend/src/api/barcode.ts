import { apiFetch } from "./client";
import { ApiError, describeFieldErrors } from "./errors";
import type { Food } from "./foods";
import type { components } from "./schema";

export type BarcodeLookup = components["schemas"]["BarcodeLookupResponse"];
export type BarcodePrefill = components["schemas"]["BarcodePrefill"];

/** 用條碼找看得到的食物；沒有時 `food` 是 null，Open Food Facts 有資料時多 `prefill`
 *  （掃條碼規格 D6）。**不進快取**：每一次掃都是新的問題，舊答案沒有用（離線快取也不該留著）。 */
export async function lookupBarcode(code: string): Promise<BarcodeLookup> {
	const result = await apiFetch<BarcodeLookup>(
		`/api/foods/by-barcode/${encodeURIComponent(code)}`,
	);
	if (result === null) throw new Error("查詢條碼沒有回傳結果");
	return result;
}

/** 改條碼（`null`＝移除）。私人食物擁有者、公開食物管理員（規格 D5）。
 *  body 一定帶 `barcode` 這個 key：後端把它設成必填，`{}` 是 422——「移除」要明講。 */
export async function updateFoodBarcode(
	foodId: number,
	barcode: string | null,
): Promise<Food> {
	const result = await apiFetch<Food>(`/api/foods/${foodId}`, {
		method: "PATCH",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ barcode }),
	});
	if (result === null) throw new Error("修改條碼沒有回傳結果");
	return result;
}

const PYDANTIC_PREFIX = "Value error, ";

/** 查詢或修改條碼失敗時給人看的話。
 *
 *  `describeFieldErrors` 回的是「欄位路徑：訊息」（`barcode：Value error, …`、路徑參數是
 *  `path.code：…`），而後端的訊息本來就是給人看的一句話——欄位路徑與 Pydantic 的前綴都拿掉。 */
export function describeBarcodeError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "VALIDATION_ERROR") {
			const [first] = describeFieldErrors(error);
			if (first !== undefined) {
				const at = first.indexOf(PYDANTIC_PREFIX);
				return at === -1 ? first : first.slice(at + PYDANTIC_PREFIX.length);
			}
			return "條碼格式不對";
		}
		if (
			error.code === "TOO_MANY_BARCODE_LOOKUPS" ||
			error.code === "BARCODE_EXISTS"
		) {
			return error.message;
		}
	}
	return "查詢失敗，請再試一次";
}
