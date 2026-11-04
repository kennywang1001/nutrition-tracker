import { useId } from "react";
import base from "./AiEstimatePanel.module.css";
import styles from "./PhotoHintStep.module.css";

/** 跟後端 `hint` 的 `max_length` 同一個數字（量的是清理之前的字；照片說明規格 D1）。 */
export const HINT_MAX_LENGTH = 200;
/** 打到這麼多字才說還能打幾字：一直顯示的話，多數不打說明的人每次都多讀一行沒用的字。 */
const COUNT_FROM = 150;

type Props = {
	hint: string;
	onHintChange: (hint: string) => void;
	placeholder: string;
	/** 真的有請求在路上：說明唯讀。 */
	readOnly: boolean;
};

/** 「補充說明（選填）」：標籤、textarea、剩幾字那一行。確認照片的卡片（`PhotoHintStep`）與營養標示的
 *  卡片（`LabelReader`）共用。
 *
 *  - 剩幾字那一行是 `aria-describedby`，不是 live region：聚焦時念一次，打字時不吵。 */
export function HintField({
	hint,
	onHintChange,
	placeholder,
	readOnly,
}: Props) {
	const id = useId();
	const hintId = `${id}-hint`;
	const limitId = `${id}-limit`;
	const count =
		hint.length >= COUNT_FROM
			? `，還能打 ${HINT_MAX_LENGTH - hint.length} 字`
			: "";

	return (
		<>
			<label htmlFor={hintId} className={styles.label}>
				補充說明（選填）
			</label>
			<textarea
				id={hintId}
				className={styles.hint}
				rows={3}
				maxLength={HINT_MAX_LENGTH}
				placeholder={placeholder}
				value={hint}
				readOnly={readOnly}
				aria-describedby={limitId}
				onChange={(event) => onHintChange(event.target.value)}
			/>
			<p id={limitId} className={base.muted}>
				{`最多 ${HINT_MAX_LENGTH} 字${count}`}
			</p>
		</>
	);
}
