import { Check, Delete } from "lucide-react";
import { type MouseEvent, useEffect, useRef } from "react";
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

const DIGITS: ReadonlySet<string> = new Set("0123456789");

/** 實體鍵盤的一個按鍵對應到鍵盤上的哪一顆；`null` 表示不是鍵盤要的鍵。
 *  `,`：有些語系的數字鍵台小數點送出的是逗號。 */
function keyFromEvent(key: string): KeypadKey | "submit" | null {
	if (DIGITS.has(key)) return key as KeypadKey;
	if (key === "." || key === ",") return ".";
	if (key === "Backspace") return "backspace";
	if (key === "Enter") return "submit";
	return null;
}

/** 焦點在可以打字的地方（備註欄）時，按鍵屬於那個欄位，不是金額。 */
function isTextEntry(target: EventTarget | null): target is HTMLElement {
	return (
		target instanceof HTMLInputElement ||
		target instanceof HTMLTextAreaElement ||
		target instanceof HTMLSelectElement ||
		(target instanceof HTMLElement && target.isContentEditable)
	);
}

/** 滑鼠／觸控按下鍵盤上的按鍵時不搶焦點：焦點留在原處（通常是 body），
 *  實體鍵盤的 Enter 才會是送出，而不是「再按一次剛剛點的那顆」。只擋
 *  mousedown 的預設動作（移動焦點），click 照常觸發——點、觸控都照樣按得到。
 *  Tab 走到按鍵上仍然會有焦點，Enter／空白鍵就按那顆，跟任何按鈕一樣。
 *
 *  例外是焦點原本在文字欄（備註）：擋掉預設動作會讓焦點一直留在備註，手機
 *  的螢幕鍵盤就一直開著蓋住數字鍵盤，實體鍵盤打的數字也繼續進備註。所以
 *  這時把備註 blur 掉——焦點回到 body，跟其他情況一樣。 */
function keepFocus(event: MouseEvent<HTMLButtonElement>) {
	event.preventDefault();
	const active = document.activeElement;
	if (isTextEntry(active)) active.blur();
}

/** 記帳的數字鍵盤（規格 §5.1）。**規則全在 `lib/keypad.ts` 的 `applyKey`**，
 *  這裡只畫按鈕。DOM 順序（也就是 Tab 順序）是 7 8 9 4 5 6 1 2 3 . 0 ⌫ ✓，
 *  跟畫面由上到下、由左到右一致；⌫ 與 ✓ 用 grid-column／grid-row 明確擺在第 4 欄。
 *
 *  「記一筆」是 `type="submit"`：鍵盤要放在呼叫端的 `<form>` 裡，送出由
 *  那個表單的 `onSubmit` 處理（備註欄按 Enter 也會走同一條路）。其他按鍵
 *  一律 `type="button"`，不然每按一個數字表單就送出一次。 */
export function MoneyKeypad({ value, onChange, submitDisabled }: Props) {
	const press = (key: KeypadKey) => onChange(applyKey(value, key));
	const submitRef = useRef<HTMLButtonElement>(null);

	// 實體鍵盤（記帳與離線規格 §2 (c)）：桌機打字直接進金額。掛在 window，
	// 焦點在 body 或任何一顆按鈕上都收得到。
	//
	// - 焦點在文字欄（備註）時不攔：那是在打備註。
	// - 有 Ctrl／Meta／Alt 的組合鍵不攔：那是瀏覽器或系統的快捷鍵（Ctrl+1 換分頁）。
	// - 輸入法組字中（`isComposing`）不攔：那些按鍵屬於輸入法。
	// - Enter：焦點在**任何**按鈕或連結上（Tab 走到「2」、「關閉」、分類、✓）
	//   時屬於那個控制項——瀏覽器的原生行為，Tab 到「2」按 Enter 就是按「2」。
	//   焦點不在控制項上（body）時 Enter 等於按 ✓：點那顆 submit 按鈕，跟 ✓
	//   受同一個 disabled 限制。滑鼠／觸控點鍵盤上的按鍵**不會**把焦點留在
	//   按鍵上（見 `keepFocus`），所以點過數字之後按 Enter 是送出。
	// - 按住 Enter 的自動重複（`repeat`）不算：只有第一下送出。
	// - 處理了的鍵一律 preventDefault。
	useEffect(() => {
		function onKeyDown(event: KeyboardEvent) {
			if (event.isComposing) return;
			if (event.ctrlKey || event.metaKey || event.altKey) return;
			if (isTextEntry(event.target)) return;
			const key = keyFromEvent(event.key);
			if (key === null) return;
			if (key === "submit") {
				if (
					event.target instanceof HTMLButtonElement ||
					event.target instanceof HTMLAnchorElement
				) {
					return;
				}
				event.preventDefault();
				if (!event.repeat && !submitDisabled) submitRef.current?.click();
				return;
			}
			event.preventDefault();
			onChange(applyKey(value, key));
		}
		window.addEventListener("keydown", onKeyDown);
		return () => window.removeEventListener("keydown", onKeyDown);
	}, [value, onChange, submitDisabled]);

	return (
		// biome-ignore lint/a11y/useSemanticElements: role=group 與 fieldset 語意相同；fieldset 要另外重設 border、padding、min-inline-size，換過去沒有無障礙上的好處
		<div className={styles.keypad} role="group" aria-label="數字鍵盤">
			{DIGIT_ROWS.flat().map((digit) => (
				<button
					key={digit}
					type="button"
					className={styles.key}
					onMouseDown={keepFocus}
					onClick={() => press(digit)}
				>
					{digit}
				</button>
			))}
			<button
				type="button"
				aria-label="小數點"
				className={styles.key}
				onMouseDown={keepFocus}
				onClick={() => press(".")}
			>
				.
			</button>
			<button
				type="button"
				className={`${styles.key} ${styles.zero}`}
				onMouseDown={keepFocus}
				onClick={() => press("0")}
			>
				0
			</button>
			<button
				type="button"
				aria-label="刪除"
				className={`${styles.key} ${styles.backspace}`}
				onMouseDown={keepFocus}
				onClick={() => press("backspace")}
			>
				<Delete aria-hidden="true" />
			</button>
			<button
				ref={submitRef}
				type="submit"
				aria-label="記一筆"
				className={`${styles.key} ${styles.submit}`}
				onMouseDown={keepFocus}
				disabled={submitDisabled}
			>
				<Check aria-hidden="true" />
			</button>
		</div>
	);
}
