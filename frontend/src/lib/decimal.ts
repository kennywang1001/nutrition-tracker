import Decimal from "decimal.js";

/** 後端的所有數值都是字串（規格 §5.1）—— `Decimal` 序列化成字串以避免
 *  浮點誤差。這個別名讓型別簽章讀得出「這不是一般的 string」。 */
export type Numeric = string;

/** **這個模組是整個前端唯一允許 `new Decimal()` 的地方。**
 *
 *  跟後端把「每 100 單位的 100」關在 `app/nutrition.py` 是同一個手法：
 *  一個概念只有一個實作位置，其他地方想用錯都沒有入口。
 *
 *  對外只暴露「字串進、字串或 number 出」的函式，不回傳 `Decimal` 實例 ——
 *  回傳的話呼叫端就能在模組外做運算，這個約束等於沒有。
 */

export function formatMacro(value: Numeric): string {
	return new Decimal(value).toString();
}

export function sumMacros(values: readonly Numeric[]): Numeric {
	return values
		.reduce((total, value) => total.plus(value), new Decimal(0))
		.toString();
}

/** 攝取 / 目標的比例。`0.9` 代表 90%。
 *
 *  **目標是 `null` 或 `0` 時回 `null`，不是 0 也不是 Infinity。**
 *  「沒有標準可比」跟「0%」是兩件不同的事（規格 §5.7）——
 *  回 0 的話 UI 會畫出一條空的進度條，看起來像「完全沒吃」。
 *
 *  而**實際值**是 0 時要回 `0`：那是一個真實的「還沒吃」。
 */
export function ratioOf(
	actual: Numeric,
	target: Numeric | null,
): number | null {
	if (target === null) return null;
	const targetValue = new Decimal(target);
	if (targetValue.isZero()) return null;
	return new Decimal(actual).dividedBy(targetValue).toNumber();
}
