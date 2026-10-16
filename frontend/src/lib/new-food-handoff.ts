import type { BarcodePrefill } from "../api/barcode";
import type { Food } from "../api/foods";
import { isFood } from "./planner";

/** 新增食物存好之後可以回去的地方（白名單；history 裡壞掉或舊版本的 state 不能把人導到別處）。
 *  只認記一餐與編輯這一餐（掃條碼規格 D20）；id 是正整數、不帶結尾的「/」、不帶查詢字串。 */
const RETURN_TO = /^\/meals\/(new|[1-9]\d{0,15}\/edit)$/;

export type NewFoodHandoff = {
	barcode: string | null;
	prefill: BarcodePrefill | null;
	returnTo: string | null;
};

/** 「用這個條碼建立食物」帶給 `/foods/new` 的 router state。 */
export function newFoodState(
	code: string,
	prefill: BarcodePrefill | null,
	returnTo: string | null,
) {
	return { barcodeCode: code, barcodePrefill: prefill, returnTo };
}

export function returnToFrom(value: unknown): string | null {
	return typeof value === "string" && RETURN_TO.test(value) ? value : null;
}

function isPrefill(value: unknown): value is BarcodePrefill {
	if (typeof value !== "object" || value === null) return false;
	const p = value as Record<string, unknown>;
	const per100 = p.per100 as Record<string, unknown> | null | undefined;
	return (
		(p.base_unit === "g" || p.base_unit === "ml") &&
		(p.name === null || typeof p.name === "string") &&
		typeof per100 === "object" &&
		per100 !== null &&
		["kcal", "protein_g", "fat_g", "carb_g"].every(
			(key) => typeof per100[key] === "string",
		)
	);
}

/** `/foods/new` 收到的 state → 交接。條碼不是 8／13 位數字（後端回的一定是標準形式）就整個不要；
 *  預填形狀不對只丟預填——條碼本身還是對的，使用者照樣省一次輸入。 */
export function newFoodHandoffFrom(state: unknown): NewFoodHandoff | null {
	if (typeof state !== "object" || state === null) return null;
	const s = state as Record<string, unknown>;
	if (
		typeof s.barcodeCode !== "string" ||
		!/^(\d{8}|\d{13})$/.test(s.barcodeCode)
	) {
		return null;
	}
	return {
		barcode: s.barcodeCode,
		prefill: isPrefill(s.barcodePrefill) ? s.barcodePrefill : null,
		returnTo: returnToFrom(s.returnTo),
	};
}

/** 新增食物存好、回到記一餐（或編輯這一餐）時帶回來的那個食物。 */
export function pickedFoodFrom(state: unknown): Food | null {
	if (typeof state !== "object" || state === null) return null;
	const picked = (state as Record<string, unknown>).pickedFood;
	return isFood(picked) ? picked : null;
}
