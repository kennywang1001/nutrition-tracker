import { ChevronRight } from "lucide-react";
import { useId } from "react";
import { Link } from "react-router";
import { useWeights } from "../api/body";
import { useDailyStats } from "../api/stats";
import { formatMacro, type Numeric, roundForDisplay } from "../lib/decimal";
import styles from "./BodyHubEntry.module.css";
import { Card } from "./Card";

/** 摘要（首頁改版規格 D14）：目標的熱量（不是額度——這裡講的是「目標」）、最新一筆體重；只有一個就寫一個，都沒有「還沒設定」。 */
export function hubSummary(
	kcal: Numeric | null,
	weightKg: Numeric | null,
): string {
	const parts = [
		kcal === null ? null : `${roundForDisplay(kcal, 0)} kcal`,
		weightKg === null ? null : `${formatMacro(weightKg)} 公斤`,
	].filter((part): part is string => part !== null);
	return parts.length === 0 ? "還沒設定" : parts.join("・");
}

/** 「我的」的身體與目標入口（規格 D13）。
 *
 *  **摘要在連結外面、用 `aria-describedby` 唸**：放在連結裡會併進可及名稱，名稱就跟著資料變（handover §7
 *  「`aria-hidden` 與可及名稱」）。箭頭是裝飾。讀的是跟身體與目標同一個快取（`dailyStats`、`["body","weights"]`），
 *  不多打請求；離線快取裡的舊回應少欄位一律 `?? null`。 */
export function BodyHubEntry() {
	const id = useId();
	const summaryId = `${id}-summary`;
	const stats = useDailyStats();
	const weights = useWeights();

	let summary: string;
	if (stats.isPending || weights.isPending) {
		summary = "載入中…";
	} else if (stats.data == null && weights.data == null) {
		summary = "無法載入";
	} else {
		summary = hubSummary(
			stats.data?.target?.kcal ?? null,
			weights.data?.entries.at(-1)?.weight_kg ?? null,
		);
	}

	return (
		<Card testId="body-hub-entry">
			<Link
				to="/me/health"
				className={styles.link}
				aria-describedby={summaryId}
			>
				身體與目標
				<ChevronRight aria-hidden="true" size={18} />
			</Link>
			<p id={summaryId} className={styles.summary}>
				{summary}
			</p>
		</Card>
	);
}
