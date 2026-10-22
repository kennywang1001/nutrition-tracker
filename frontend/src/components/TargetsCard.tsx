import { Link } from "react-router";
import { useTargetSuggestion } from "../api/body";
import { useDailyStats } from "../api/stats";
import { formatMacro } from "../lib/decimal";
import { TARGET_FIELDS } from "../lib/targets";
import { signedKg } from "../lib/weights";
import { Card } from "./Card";
import { ExerciseBudgetSwitch } from "./ExerciseBudgetSwitch";
import styles from "./TargetsCard.module.css";
import ui from "./ui.module.css";

/** 身體與目標的每日目標（帳號設定規格 §5.1；首頁改版從「我的」搬過來）。讀 `stats/daily` 的 `target`——那是後端用使用者的
 *  今天算的「今天生效的目標」，不另外加讀取端點（規格 決定 6）；存完 `/me/targets` 失效它，
 *  這裡跟總覽、飲食頁一起更新。 */
export function TargetsCard() {
	const stats = useDailyStats();
	// `target` 整個是 null＝今天沒有任何目標；某一格是 null＝那一格沒設。兩種都寫「未設定」。
	const target = stats.data?.target ?? null;
	// 重算提示（身體資料規格 §6.6）：判斷在後端（`resuggest`），這裡只顯示。只對「目前的目標
	// 來自建議」有意義——手動存目標時後端清掉套用時的體重，`resuggest` 就是 false（D16）。
	// 離線快取裡的舊回應可能少了欄位：用 `?? null` 收。
	const suggestion = useTargetSuggestion().data;
	const change =
		suggestion?.ready && suggestion.resuggest
			? (suggestion.weight_change_kg ?? null)
			: null;

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
			{change !== null && (
				<div className={styles.prompt}>
					<p className={styles.text}>
						體重變了 {signedKg(change)} 公斤，要重算建議目標嗎？
					</p>
					<Link to="/me/targets" className={styles.link}>
						重算建議目標
					</Link>
				</div>
			)}
			{/* 看得到的字只有「修改」：卡片標題已經說了改什麼；可及名稱補完整，螢幕閱讀器
			    在連結清單裡才分得出是哪一個「修改」。 */}
			<Link to="/me/targets" aria-label="修改每日目標" className={styles.link}>
				修改
			</Link>
			{/* 卡片底部（運動規格 D25）：它改的是熱量的分母。放在「修改」後面、隔一條線——
			    「修改」是改上面那四個數字，開關是另一件事。 */}
			<ExerciseBudgetSwitch />
		</Card>
	);
}
