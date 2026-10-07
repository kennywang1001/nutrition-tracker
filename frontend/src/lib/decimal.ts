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

/** 金額的顯示字串，固定兩位小數。
 *
 *  **不能用 `formatMacro()`。** 那個函式走 `Decimal.toString()`，而 Decimal
 *  會把尾數的 0 正規化掉——`"250.50"` 變成 `"250.5"`（已用 node 實測）。
 *  營養素顯示成 `250.5` 沒問題；金額顯示成 `250.5` 是錯的，而且是那種
 *  「看起來只是少一個字」、實際上讓人懷疑系統算錯錢的錯。
 *
 *  後端的 `amount` 是 `numeric(10,2)`、`summary.total` 是 Decimal 相加的
 *  結果，兩者都保證最多兩位小數，所以 `toFixed(2)` 不會四捨五入掉任何
 *  真實的精度——它只是把顯示補齊。
 */
export function formatMoney(value: Numeric): string {
	return new Decimal(value).toFixed(2);
}

/** 金額字串是否大於 0。空字串、`"0."`、`"abc"` 都回 `false`，**不丟例外**——
 *  記帳鍵盤打到一半的字串是常態，✓ 按鈕每次重繪都會問一次。
 *
 *  它驗的是鍵盤組出來的字串；decimal.js 也接受 "1e5"、"0x10"、"Infinity"
 *  這類寫法，鍵盤不可能產生它們，所以這個函式不特別拒絕。
 *
 *  放在這裡而不是 `lib/keypad.ts`：判斷「是不是 0」要經過 `Decimal`
 *  （`"0.00"`、`"0."` 用字串比對很容易漏），而只有這個檔案可以 import
 *  decimal.js（`tests/decimal-containment.test.ts`）。 */
export function isPositiveAmount(value: string): boolean {
	if (value.trim() === "") return false;
	try {
		return new Decimal(value).greaterThan(0);
	} catch {
		return false;
	}
}

const PLAIN_DECIMAL = /^(\d+(\.\d*)?|\.\d+)$/;

/** 「嚴格的正小數」：前後空白會先去掉，只接受 `12`、`4.`、`.5`、`12.5`
 *  這類一般寫法（不接受 `1e3`、`0x10`、`+5`、`-1`），而且要大於 0。
 *  跟 `perServingToPer100` 的重量參數用同一條規則。不丟例外。 */
export function isPlainPositiveDecimal(value: string): boolean {
	const v = value.trim();
	if (!PLAIN_DECIMAL.test(v)) return false;
	try {
		return new Decimal(v).greaterThan(0);
	} catch {
		return false;
	}
}

/** 「每一份」的營養素換算成「每 100 單位」（食物份量規格 §4.2）。
 *
 *  結果四捨五入到小數兩位（half-up）——後端的 `NutritionInput` 是
 *  `decimal_places=2`。
 *
 *  **精度**：存的是每 100、兩位小數；記一餐用「1 份」時會再乘回去，誤差
 *  在第三位小數以下。例：每份 45 g、210 kcal → 存 466.67 → 記一份算出
 *  210.0015，顯示 210。可以接受，但要知道它存在。
 *
 *  任何一個參數不是一般的小數寫法（前後空白會先去掉；只接受 `12`、`4.`、
 *  `.5`、`12.5` 這類，不接受 `1e3`、`0x10`、`+5`、`-1`、`Infinity`、`NaN`）、
 *  或份量不是正數 → `null`。
 *  **不丟例外、不除以零**：表單打到一半的值是常態。
 *
 *  **不會被夾在後端上限內**：結果可能超過 `NutritionInput` 的範圍
 *  （例：份量 "0.01" 會換出 ≥ 10000 的值），呼叫端要自己檢查範圍。 */
export function perServingToPer100(
	value: string,
	servingGrams: string,
): string | null {
	const v = value.trim();
	const g = servingGrams.trim();
	if (!PLAIN_DECIMAL.test(v) || !PLAIN_DECIMAL.test(g)) return null;
	try {
		const grams = new Decimal(g);
		if (!grams.greaterThan(0)) return null;
		return new Decimal(v)
			.times(100)
			.dividedBy(grams)
			.toFixed(2, Decimal.ROUND_HALF_UP);
	} catch {
		return null;
	}
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

/** 一組數值的平均。**空陣列回 `null`，不是 `"0"`**——沒有資料就沒有平均，
 *  「平均 0」讀起來是「每天都吃了 0」（跟 `ratioOf` 的 null 同一個道理）。
 *
 *  **四捨五入到小數兩位（half-up）**——後端的營養素都是兩位小數，平均不需要
 *  比原始資料更精確。不四捨五入的話三天平均 1000、1000、1001 會是
 *  `"1000.3333333333333333"`（Decimal 預設 20 位有效數字），直接印在畫面上。
 *  結果走 `toString()`，所以 `"2.00"` 回 `"2"`，跟 `formatMacro` 一致。
 *
 *  給趨勢畫面的期間摘要用（趨勢期間規格 §2）。哪些值該算進來（例如「沒記錄
 *  的日子不算」）是呼叫端的事，這裡只負責把給它的值平均。 */
export function averageOf(values: readonly Numeric[]): Numeric | null {
	if (values.length === 0) return null;
	return values
		.reduce((total, value) => total.plus(value), new Decimal(0))
		.dividedBy(values.length)
		.toDecimalPlaces(2, Decimal.ROUND_HALF_UP)
		.toString();
}

/** 一組數值的最大值。空陣列回 `"0"`。
 *
 *  給 `TrendChart` 算 y 軸上限用。**放在這裡而不是圖表元件裡**，是因為
 *  比較兩個 `Numeric` 必須經過 `Decimal` —— 用 `Math.max(...values.map(Number))`
 *  就是把浮點誤差請回來，而這個模組存在的理由正是把它擋在外面。 */
export function maxOf(values: readonly Numeric[]): Numeric {
	return values
		.reduce(
			(largest, value) =>
				new Decimal(value).greaterThan(largest) ? new Decimal(value) : largest,
			new Decimal(0),
		)
		.toString();
}
