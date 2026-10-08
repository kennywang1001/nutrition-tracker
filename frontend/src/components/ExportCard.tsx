import { useId, useState } from "react";
import { ApiError } from "../api/errors";
import { downloadExport, EXPORT_KINDS, type ExportKind } from "../api/export";
import { saveBlob } from "../lib/save-file";
import { Card } from "./Card";
import styles from "./ExportCard.module.css";
import ui from "./ui.module.css";

function describeError(caught: unknown): string {
	// 429：後端的訊息（「匯出太頻繁，請稍後再試」）加上還要等多久，同改密碼的寫法。
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
 *  下載中三顆一起停用：一次一個請求（每個請求後端都握著一條資料庫連線直到傳完），
 *  也不會連按把每分鐘的額度用掉。 */
export function ExportCard() {
	const titleId = useId();
	const [pending, setPending] = useState<ExportKind | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [done, setDone] = useState<string | null>(null);

	async function handleDownload(kind: ExportKind) {
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
						disabled={pending !== null}
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
			{done !== null && (
				<p role="status" className={styles.hint}>
					{done}
				</p>
			)}
		</Card>
	);
}
