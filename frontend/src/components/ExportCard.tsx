import { useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import { downloadExport, EXPORT_KINDS, type ExportKind } from "../api/export";
import { saveBlob } from "../lib/save-file";
import { Card } from "./Card";
import styles from "./ExportCard.module.css";
import ui from "./ui.module.css";

function describeError(caught: unknown): string {
	// 429：後端的訊息加上還要等多久，同改密碼的寫法。「匯出太頻繁」有秒數；「已經有一個
	// 匯出在進行」沒有（後端不知道前一個什麼時候結束，不帶 Retry-After）——只顯示訊息。
	if (caught instanceof ApiError && caught.status === 429) {
		return caught.retryAfterSeconds !== null
			? `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`
			: caught.message;
	}
	return "下載失敗，請再試一次";
}

/** 「我的」的「匯出資料」（報表月份與匯出規格 §4.2）：三顆按鈕，各下載一種資料的
 *  全部歷史（CSV）。
 *
 *  **不用 `useMutation`**：mutation 在瀏覽器回報離線時會「暫停」，等恢復連線才送
 *  ——下載不該在使用者早就離開這一頁之後自己冒出來。離線時 `fetch` 直接失敗，
 *  顯示錯誤就好。
 *
 *  下載中三顆一起不能按：一次一個請求（後端也只讓一個人同時跑一個匯出），也不會連按
 *  把每分鐘的額度用掉。
 *
 *  **「不能按」是 `aria-disabled`，不是原生的 `disabled`**（審查 M5）：三顆裡有一顆正在
 *  焦點上（剛按下去的那顆），原生停用會讓它把焦點弄丟——用鍵盤的人得從頭 Tab 回來，
 *  螢幕閱讀器的人不知道自己在哪。代價是瀏覽器不再替我們擋 click：`busy` 這個 ref 擋
 *  （不用 `pending` 這個 state 擋：它要等下一次 render 才更新）。 */
export function ExportCard() {
	const titleId = useId();
	const [pending, setPending] = useState<ExportKind | null>(null);
	const busy = useRef(false);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	async function handleDownload(kind: ExportKind) {
		if (busy.current) return;
		busy.current = true;
		setPending(kind);
		setError(null);
		setDone(null);
		try {
			const { blob, filename } = await downloadExport(kind);
			const result = await saveBlob(blob, filename, "text/csv");
			// 分享面板自己就是回饋；點了下載連結的才需要說一聲（瀏覽器不一定有動靜）。
			if (result === "downloaded") setDone(`已下載 ${filename}`);
		} catch (caught) {
			setError(describeError(caught));
		} finally {
			busy.current = false;
			setPending(null);
		}
	}

	return (
		<Card testId="export-card">
			<h2 id={titleId} className={`${ui.sectionTitle} ${styles.title}`}>
				匯出資料
			</h2>
			<p className={styles.hint}>
				下載你自己的全部紀錄（CSV 檔，Excel、Numbers 都能打開）。
			</p>
			{/* biome-ignore lint/a11y/useSemanticElements: role=group 與 fieldset 語意相同；fieldset 要另外重設 border、padding、min-inline-size（同 MoneyKeypad） */}
			<div className={styles.actions} role="group" aria-labelledby={titleId}>
				{EXPORT_KINDS.map(({ kind, label }) => (
					<button
						key={kind}
						type="button"
						className={ui.secondary}
						aria-disabled={pending !== null}
						onClick={() => void handleDownload(kind)}
					>
						{pending === kind ? "下載中…" : label}
					</button>
				))}
			</div>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
			{/* role="status" 的區塊一直都在、先是空的，下載完才把字放進去（同總覽的 notice）：
			    整個區塊連字一起插進來的話，有些螢幕閱讀器不會唸。 */}
			<div role="status">
				{done !== null && <p className={styles.hint}>{done}</p>}
			</div>
		</Card>
	);
}
