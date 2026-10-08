import { Link } from "react-router";
import { useDailyStats } from "../api/stats";
import { formatMacro } from "../lib/decimal";
import { TARGET_FIELDS } from "../lib/targets";
import { Card } from "./Card";
import styles from "./TargetsCard.module.css";
import ui from "./ui.module.css";

/** 「我的」的每日目標（帳號設定規格 §5.1）。讀 `stats/daily` 的 `target`——那是後端用使用者的
 *  今天算的「今天生效的目標」，不另外加讀取端點（規格 決定 6）；存完 `/me/targets` 失效它，
 *  這裡跟總覽、飲食頁一起更新。 */
export function TargetsCard() {
	const stats = useDailyStats();
	// `target` 整個是 null＝今天沒有任何目標；某一格是 null＝那一格沒設。兩種都寫「未設定」。
	const target = stats.data?.target ?? null;

	return (
		<Card testId="targets-card">
			<h2 className={`${ui.sectionTitle} ${styles.title}`}>每日目標</h2>
			{stats.isPending ? (
				<p className={styles.text}>載入中…</p>
			) : stats.data == null ? (
				<p className={styles.text}>無法載入目前的目標</p>
			) : (
				<dl className={styles.list}>
					{TARGET_FIELDS.map((field) => {
						const value = target?.[field.key] ?? null;
						return (
							<div key={field.key} className={styles.row}>
								<dt>{field.label}</dt>
								<dd>
									{value === null
										? "未設定"
										: `${formatMacro(value)} ${field.unit}`}
								</dd>
							</div>
						);
					})}
				</dl>
			)}
			{/* 看得到的字只有「修改」：卡片標題已經說了改什麼；可及名稱補完整，螢幕閱讀器
			    在連結清單裡才分得出是哪一個「修改」。 */}
			<Link to="/me/targets" aria-label="修改每日目標" className={styles.link}>
				修改
			</Link>
		</Card>
	);
}
