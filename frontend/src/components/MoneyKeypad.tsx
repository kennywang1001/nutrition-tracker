import { Check, Delete } from "lucide-react";
import { applyKey, type KeypadKey } from "../lib/keypad";
import styles from "./MoneyKeypad.module.css";

type Props = {
	value: string;
	onChange: (next: string) => void;
	/** ✓ 不能按的條件由呼叫端決定（通常是 `!isPositiveAmount(value)` 或送出中）。 */
	submitDisabled: boolean;
};

const DIGIT_ROWS: ReadonlyArray<ReadonlyArray<KeypadKey>> = [
	["7", "8", "9"],
	["4", "5", "6"],
	["1", "2", "3"],
];

/** 記帳的數字鍵盤（規格 §5.1）。**規則全在 `lib/keypad.ts` 的 `applyKey`**，
 *  這裡只畫按鈕。DOM 順序（也就是 Tab 順序）是 7 8 9 4 5 6 1 2 3 . 0 ⌫ ✓，
 *  跟畫面由上到下、由左到右一致；⌫ 與 ✓ 用 grid-column／grid-row 明確擺在第 4 欄。
 *
 *  「記一筆」是 `type="submit"`：鍵盤要放在呼叫端的 `<form>` 裡，送出由
 *  那個表單的 `onSubmit` 處理（備註欄按 Enter 也會走同一條路）。其他按鍵
 *  一律 `type="button"`，不然每按一個數字表單就送出一次。 */
export function MoneyKeypad({ value, onChange, submitDisabled }: Props) {
	const press = (key: KeypadKey) => onChange(applyKey(value, key));

	return (
		// biome-ignore lint/a11y/useSemanticElements: role=group 與 fieldset 語意相同；fieldset 要另外重設 border、padding、min-inline-size，換過去沒有無障礙上的好處
		<div className={styles.keypad} role="group" aria-label="數字鍵盤">
			{DIGIT_ROWS.flat().map((digit) => (
				<button
					key={digit}
					type="button"
					className={styles.key}
					onClick={() => press(digit)}
				>
					{digit}
				</button>
			))}
			<button
				type="button"
				aria-label="小數點"
				className={styles.key}
				onClick={() => press(".")}
			>
				.
			</button>
			<button
				type="button"
				className={`${styles.key} ${styles.zero}`}
				onClick={() => press("0")}
			>
				0
			</button>
			<button
				type="button"
				aria-label="刪除"
				className={`${styles.key} ${styles.backspace}`}
				onClick={() => press("backspace")}
			>
				<Delete aria-hidden="true" />
			</button>
			<button
				type="submit"
				aria-label="記一筆"
				className={`${styles.key} ${styles.submit}`}
				disabled={submitDisabled}
			>
				<Check aria-hidden="true" />
			</button>
		</div>
	);
}
