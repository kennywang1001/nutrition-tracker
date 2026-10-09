/** 網址的 `:id` → 資源的 id；不是「JS 能精確表示的正整數」就是 `NaN`。
 *
 *  呼叫端把 `NaN` 當成「沒有這個東西」，**一個請求都不送**（`useSocialMeal`、`useMeal`
 *  的 `enabled: Number.isFinite(id)`）。兩道檢查各擋一種：
 *
 *  1. **寫法**：`Number("1.5")`、`Number("-3")`、`Number("")`、`Number("1e3")`、
 *     `Number("0x10")` 都是「數字」，所以不能只靠 `Number`。只收不帶前導零的十進位正整數。
 *  2. **大小**（社群審查 M6）：全是數字、但超過 `Number.MAX_SAFE_INTEGER`（2^53 − 1）的。
 *     `Number()` 會把它**悄悄四捨五入成另一個 id**（…993 變成 …992），去問的就不是網址上
 *     那一個；再大（超過後端 bigint 的 2^63 − 1）後端回 422——不是 404，所以
 *     `retryUnlessNotFound` 會重試三次（約 7 秒），最後畫面是「無法載入」而不是「看不到」。
 *
 *  2^53 − 1 與 2^63 − 1 之間的 id 後端收、這裡不收：整個前端的 id 都是 JSON 解析出來的
 *  `number`，本來就表示不了它們。真的 id 是資料庫從 1 開始發的，離那裡很遠。 */
export function parseResourceId(raw: string | undefined): number {
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return Number.NaN;
	const id = Number(raw);
	return Number.isSafeInteger(id) ? id : Number.NaN;
}
