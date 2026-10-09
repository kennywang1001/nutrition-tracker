import { useQueryClient } from "@tanstack/react-query";
import { useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import {
	afterCommentChange,
	deleteComment,
	type MealComment,
} from "../api/social";
import { formatDateTime } from "../lib/dates";
import { useConfirmFocus } from "../lib/use-confirm-focus";
import styles from "./Comments.module.css";
import ui from "./ui.module.css";

type RowProps = {
	mealId: number;
	comment: MealComment;
	onDeleted: () => void;
};

function CommentRow({ mealId, comment, onDeleted }: RowProps) {
	const queryClient = useQueryClient();
	const bodyId = useId();
	const [confirming, setConfirming] = useState(false);
	const confirmFocus = useConfirmFocus(confirming);
	const [pending, setPending] = useState(false);
	// `pending` 是 state，要等下一次 render 才看得到；連按兩下的第二下靠這個擋。
	const busy = useRef(false);
	const [failed, setFailed] = useState(false);

	async function remove() {
		if (busy.current) return;
		busy.current = true;
		setPending(true);
		setFailed(false);
		try {
			await deleteComment(mealId, comment.id);
		} catch (caught) {
			// 404＝這一則已經不在了（別的裝置刪過），或整餐都看不到了：兩種都不是
			// 「再試一次」會好的事。當成刪好了，往下重抓——畫面會照伺服器現在的樣子
			// （少一則，或整頁換成「看不到這一餐」）。
			if (!(caught instanceof ApiError && caught.status === 404)) {
				busy.current = false;
				setPending(false);
				setFailed(true);
				return;
			}
		}
		// 等這一餐重抓完再移焦點：那時這一列（與焦點所在的「確定刪除」）才真的不見。
		// 不用 `useMutation` 的 callback：這一列在重抓回來的那一刻就卸載了，掛在
		// 元件上的 callback 不會跑（handover §7），而焦點正是那之後才要移。
		await afterCommentChange(queryClient, mealId);
		// 重抓失敗的話這一列還在：把它恢復成可以再按的樣子（下面兩行在已經卸載的
		// 元件上沒有作用）。
		busy.current = false;
		setPending(false);
		setConfirming(false);
		onDeleted();
	}

	return (
		<li className={styles.comment}>
			<div className={styles.meta}>
				<span className={styles.author}>
					{comment.display_name}
					{comment.is_me && "（我）"}
				</span>
				<time dateTime={comment.created_at} className={styles.when}>
					{formatDateTime(comment.created_at)}
				</time>
				{/* 能不能刪是伺服器說的（作者，或這一餐的主人）。名稱帶是誰的留言、
				    描述是內容：一頁有好幾顆「刪除」，螢幕閱讀器要分得出來。 */}
				{comment.can_delete && !confirming && (
					<button
						ref={confirmFocus.triggerRef}
						type="button"
						className={styles.delete}
						aria-label={`刪除 ${comment.display_name} 的留言`}
						aria-describedby={bodyId}
						onClick={() => {
							setFailed(false);
							setConfirming(true);
						}}
					>
						刪除
					</button>
				)}
			</div>
			{/* React 的文字節點：留言是別人打的字，不會被當成 HTML。 */}
			<p id={bodyId} className={styles.body}>
				{comment.body}
			</p>
			{confirming && (
				<div
					role="alertdialog"
					aria-label="確認刪除留言"
					className={styles.confirm}
				>
					<p>確定要刪除這則留言嗎？</p>
					{/* aria-disabled，不是 disabled：按下去的那一刻焦點就在這顆上。 */}
					<button
						type="button"
						className={`${ui.danger} ${styles.confirmDelete}`}
						aria-disabled={pending}
						onClick={() => void remove()}
					>
						確定刪除
					</button>
					<button
						ref={confirmFocus.cancelRef}
						type="button"
						onClick={() => {
							// 送出中不讓它收起來：收起來之後刪除照樣會完成，看起來像取消成功了。
							if (busy.current) return;
							confirmFocus.cancelled();
							setConfirming(false);
							setFailed(false);
						}}
					>
						取消
					</button>
				</div>
			)}
			{failed && (
				<p role="alert" className={styles.error}>
					刪除失敗，請再試一次
				</p>
			)}
		</li>
	);
}

type Props = {
	mealId: number;
	/** 由舊到新（後端排好的）。 */
	comments: readonly MealComment[];
	/** 伺服器只回了最近 100 則。 */
	truncated: boolean;
	/** 刪掉一則、清單重抓回來之後：被刪的那一列連同焦點所在的按鈕都不見了，
	 *  由上層決定焦點去哪裡（餐點頁：留言的標題）。 */
	onDeleted: () => void;
};

/** 一餐的留言（社群規格 §6.3）。 */
export function CommentList({ mealId, comments, truncated, onDeleted }: Props) {
	return (
		<>
			{truncated && <p className={styles.note}>只顯示最近 100 則</p>}
			{comments.length === 0 ? (
				<p className={styles.note}>還沒有留言</p>
			) : (
				<ol className={styles.list} aria-label="留言">
					{comments.map((comment) => (
						<CommentRow
							key={comment.id}
							mealId={mealId}
							comment={comment}
							onDeleted={onDeleted}
						/>
					))}
				</ol>
			)}
		</>
	);
}
