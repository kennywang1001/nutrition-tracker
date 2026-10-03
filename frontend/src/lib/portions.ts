/** 記一餐選了食物之後要預先選上哪個份量（食物份量規格 §6）。
 *
 *  自己的預設份量（`is_default && !is_global`）優先，沒有才用公開的預設份量；
 *  都沒有回 `null`（維持「直接輸入數量」）。純函式，不碰畫面。 */
export function pickDefaultPortion<
	T extends { is_default: boolean; is_global: boolean },
>(portions: readonly T[]): T | null {
	return (
		portions.find((portion) => portion.is_default && !portion.is_global) ??
		portions.find((portion) => portion.is_default && portion.is_global) ??
		null
	);
}
