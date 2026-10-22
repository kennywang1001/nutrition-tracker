import { type Ref, type RefObject, useEffect, useId, useState } from "react";
import base from "./AiEstimatePanel.module.css";
import styles from "./PhotoHintStep.module.css";

/** 跟後端 `hint` 的 `max_length` 同一個數字（量的是清理之前的字；照片說明規格 D1）。 */
export const HINT_MAX_LENGTH = 200;
/** 打到這麼多字才說還能打幾字：一直顯示的話，多數不打說明的人每次都多讀一行沒用的字。 */
const COUNT_FROM = 150;

/** 選了照片之後把焦點移到這張卡片——**晚一個 task**。選檔的視窗關掉時，瀏覽器會把焦點還給
 *  `<input type=file>`，而且不保證在 `change` 之前還（user-event 也照「change 之後才還」模擬）：
 *  在 change 的那一次 render 裡同步移過去，會被這一下蓋回照片按鈕。卡片已經不在（取消、卸載）
 *  就什麼都不做。 */
export function focusStepAfterFileDialog(ref: RefObject<HTMLElement | null>) {
	window.setTimeout(() => ref.current?.focus(), 0);
}

type Props = {
	file: File;
	hint: string;
	onHintChange: (hint: string) => void;
	/** 「開始估算」或「開始讀取」。 */
	startLabel: string;
	placeholder: string;
	/** 真的有請求在路上：兩顆按鈕 aria-disabled、說明唯讀。 */
	busy: boolean;
	/** 只停用「開始」（已經知道 AI 沒設定）：「取消」照樣能按——沒有東西在路上，卡片一定要
	 *  收得起來（審查 M1）。 */
	startDisabled?: boolean;
	onStart: () => void;
	onCancel: () => void;
	/** 選了照片時呼叫端把焦點移到這張卡片。 */
	sectionRef?: Ref<HTMLElement>;
};

/** 選了照片之後、送出之前的那一步（照片說明規格 §6）：看一眼照片、選填一段補充說明、按開始。
 *  三個拍照入口（單樣、整餐、營養標示）共用。
 *
 *  - **不自動對焦到說明**：手機會直接跳出鍵盤、蓋住「開始估算」，多數人不打說明。焦點由呼叫端移到卡片本身。
 *  - 按鈕用 `aria-disabled`：按下「開始估算」的當下焦點在它身上，原生 `disabled` 會讓焦點掉到 body。
 *  - 「取消」送出中也停用：已經送出的那一次照樣會回來、照樣算額度，這時收起卡片，結果卻在 20 秒後
 *    冒出來，比等它回來更讓人困惑（規格 §6.3）。**只有**送出中停用：AI 沒設定只停用「開始」
 *    （`startDisabled`），不然卡片收不起來（審查 M1）。
 *  - 剩幾字那一行是 `aria-describedby`，不是 live region：聚焦時念一次，打字時不吵。 */
export function PhotoHintStep({
	file,
	hint,
	onHintChange,
	startLabel,
	placeholder,
	busy,
	startDisabled = false,
	onStart,
	onCancel,
	sectionRef,
}: Props) {
	const id = useId();
	const startOff = busy || startDisabled;
	const [previewUrl, setPreviewUrl] = useState<string | null>(null);
	useEffect(() => {
		const url = URL.createObjectURL(file);
		setPreviewUrl(url);
		// 換照片或卡片收起來時釋放，不然每選一次就漏一份 blob（同記一餐的照片預覽）。
		return () => URL.revokeObjectURL(url);
	}, [file]);

	const hintId = `${id}-hint`;
	const limitId = `${id}-limit`;
	const count =
		hint.length >= COUNT_FROM
			? `，還能打 ${HINT_MAX_LENGTH - hint.length} 字`
			: "";

	return (
		<section
			ref={sectionRef}
			tabIndex={-1}
			aria-label="確認照片"
			className={`${base.card} ${styles.step}`}
		>
			{previewUrl !== null && (
				<img
					src={previewUrl}
					alt="要送給 AI 的照片"
					className={styles.preview}
				/>
			)}
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
				readOnly={busy}
				aria-describedby={limitId}
				onChange={(event) => onHintChange(event.target.value)}
			/>
			<p id={limitId} className={base.muted}>
				{`最多 ${HINT_MAX_LENGTH} 字${count}`}
			</p>
			<div className={base.actions}>
				<button
					type="button"
					className={base.primary}
					aria-disabled={startOff}
					onClick={() => {
						if (!startOff) onStart();
					}}
				>
					{startLabel}
				</button>
				<button
					type="button"
					className={base.secondary}
					aria-disabled={busy}
					onClick={() => {
						if (!busy) onCancel();
					}}
				>
					取消
				</button>
			</div>
		</section>
	);
}
