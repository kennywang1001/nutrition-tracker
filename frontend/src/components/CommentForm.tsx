import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import {
	afterCommentChange,
	COMMENT_MAX_LENGTH,
	postComment,
	refreshIfMealGone,
} from "../api/social";
import styles from "./Comments.module.css";
import ui from "./ui.module.css";

/** 剩這麼多字以內才顯示「還可以輸入 N 個字」。 */
const HINT_WITHIN = 20;

function describeError(caught: unknown): string {
	if (caught instanceof ApiError && caught.status === 429) {
		// `retryAfterSeconds` 沒有標頭時是 null，不是 0（見 `ApiError`）。
		return caught.retryAfterSeconds !== null
			? `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`
			: caught.message;
	}
	// 剛被解除好友、那一餐被關起來或刪掉了：再送幾次都一樣，不叫人「再試一次」
	// （跟讚的按鈕同一句開頭）。
	if (caught instanceof ApiError && caught.status === 404) {
		return "這一餐已經看不到了，沒有送出";
	}
	return "沒有送出，請再試一次";
}

/** 餐點頁最下面的留言框（社群規格 §6.3）：一行、1 到 200 個字。
 *
 *  送出鍵在「空的、超過、送出中」時是 **`aria-disabled`，不是 `disabled`**：送出中
 *  焦點可能就在它身上，原生的 `disabled` 會讓瀏覽器把焦點丟掉（`ExportCard` 的慣例）。
 *  所以它照樣收得到點擊與 Enter，擋在 `submit` 裡。 */
export function CommentForm({ mealId }: { mealId: number }) {
	const queryClient = useQueryClient();
	const inputId = useId();
	const hintId = useId();
	const formRef = useRef<HTMLFormElement>(null);
	const inputRef = useRef<HTMLInputElement>(null);
	const [text, setText] = useState("");
	const [pending, setPending] = useState(false);
	// `pending` 是 state，要等下一次 render 才看得到；連按兩下的第二下靠這個擋。
	const busy = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [sent, setSent] = useState(false);

	// 頭尾的空白不算、也不送：後端本來就會去掉。
	const body = text.trim();
	// code point，不是 UTF-16 的長度：一個表情符號算一個字，跟後端一致。
	// 後端量的是清理（壓空白、去控制字元）之後的長度，只會比這裡短，不會比這裡長。
	const length = Array.from(body).length;
	const left = COMMENT_MAX_LENGTH - length;
	const blocked = length === 0 || left < 0 || pending;

	async function submit(event: FormEvent) {
		event.preventDefault();
		// aria-disabled 的按鈕照樣收得到點擊與 Enter：在這裡擋，並把焦點放回輸入框
		// （空的時候按了送出鍵：該做的事是去打字）。
		if (blocked || busy.current) {
			inputRef.current?.focus();
			return;
		}
		busy.current = true;
		setPending(true);
		setError(null);
		setSent(false);
		try {
			await postComment(mealId, body);
			setText("");
			setSent(true);
			// 等這一餐重抓完：新留言出現在清單裡之後才放開送出鍵。
			await afterCommentChange(queryClient, mealId);
		} catch (caught) {
			// 失敗：字留著，不用重打。
			setError(describeError(caught));
			// 404：餐點頁重抓，整頁換成「看不到這一餐」（這個表單跟著卸載）。
			refreshIfMealGone(queryClient, mealId, caught);
		} finally {
			busy.current = false;
			setPending(false);
			// 按的是送出鍵的話焦點在按鈕上：放回輸入框，可以接著打下一則。
			// 只在焦點還在這個表單裡（或哪裡都不在）時才移——送出中人已經去按別的東西
			// （例如某一則留言的「刪除」）就不搶。
			const active = document.activeElement;
			if (
				active === null ||
				active === document.body ||
				formRef.current?.contains(active)
			) {
				inputRef.current?.focus();
			}
		}
	}

	return (
		<form
			ref={formRef}
			className={styles.form}
			onSubmit={(event) => void submit(event)}
		>
			<label htmlFor={inputId}>寫留言</label>
			<div className={styles.row}>
				<input
					id={inputId}
					ref={inputRef}
					type="text"
					value={text}
					autoComplete="off"
					enterKeyHint="send"
					aria-describedby={hintId}
					aria-invalid={left < 0}
					onChange={(event) => {
						setText(event.target.value);
						// 開始打下一則：上一則的「已送出」不用再留著。
						setSent(false);
					}}
				/>
				<button
					type="submit"
					className={`${ui.primary} ${styles.submit}`}
					aria-disabled={blocked}
				>
					{pending ? "送出中…" : "送出"}
				</button>
			</div>
			{/* 這一塊一直都在：提示是輸入框的 aria-describedby，狀態是 live region
			    （先有空的區塊、之後才放字進去，螢幕閱讀器才會唸）。 */}
			<div className={styles.feedback}>
				<p id={hintId} className={left < 0 ? styles.over : styles.hint}>
					{left < 0
						? `超過 ${-left} 個字`
						: left <= HINT_WITHIN
							? `還可以輸入 ${left} 個字`
							: ""}
				</p>
				{error !== null && (
					<p role="alert" className={styles.error}>
						{error}
					</p>
				)}
				<div role="status">{sent && <p className={styles.hint}>已送出</p>}</div>
			</div>
		</form>
	);
}
