import { Link } from "react-router";
import {
	type DailyStats,
	exerciseInBudgetOf,
	kcalBudgetOf,
} from "../api/stats";
import { kcalBalance, ratioOf, roundForDisplay } from "../lib/decimal";
import styles from "./BudgetSummary.module.css";
import { CalorieRing, type RingTone } from "./CalorieRing";
import { MacroBar } from "./MacroBar";

/** 總覽「今天熱量」卡片的內容（首頁改版規格 §3）：圓環＋中間的字、三大營養素、一行「已吃・預算」。
 *
 *  - 額度一律經過 `kcalBudgetOf`（目標＋運動，設定關掉是目標；離線快取的舊回應退回目標）；「含運動」經過
 *    `exerciseInBudgetOf`——不直接碰 `stats.kcal_budget`（運動規格的規矩）。
 *  - 「還能吃／超過」是 `kcalBalance` 的整數（D3）；已吃、預算、含運動只是顯示，`roundForDisplay(…, 0)`（D19）。
 *  - 沒有額度（沒有目標，或熱量沒設）：中間寫已吃，下面「還沒有每日目標」＋「設定每日目標」（D20）。
 *  - 載入中、讀不到由呼叫端處理（總覽的 `TodayBudgetCard`），這裡一定有 `stats`。 */
export function BudgetSummary({ stats }: { stats: DailyStats }) {
	const budget = kcalBudgetOf(stats);
	const added = exerciseInBudgetOf(stats);
	const eaten = roundForDisplay(stats.actual.kcal, 0);
	const balance =
		budget === null ? null : kcalBalance(budget, stats.actual.kcal);
	const tone: RingTone =
		balance === null ? "none" : balance.over ? "over" : "normal";
	// `target` 整個是 null＝今天沒有目標：三列都是「未設定」（MacroBar 的 target 傳 null）。
	const target = stats.target;

	return (
		<div>
			<div className={styles.top}>
				<div className={styles.ringBox}>
					<CalorieRing
						ratio={budget === null ? null : ratioOf(stats.actual.kcal, budget)}
						tone={tone}
					/>
					{/* 三段之間的空白是念出來的一部分：「還能吃 843 kcal」。 */}
					<p
						data-tone={tone}
						className={
							tone === "over"
								? `${styles.center} ${styles.centerOver}`
								: styles.center
						}
					>
						<span className={styles.centerLabel}>
							{balance === null ? "已吃" : balance.over ? "超過" : "還能吃"}
						</span>{" "}
						<span className={styles.centerNumber}>
							{balance === null ? eaten : balance.amount}
						</span>{" "}
						<span className={styles.centerUnit}>kcal</span>
					</p>
				</div>
				<div className={styles.macros}>
					<MacroBar
						field="protein_g"
						label="蛋白質"
						actual={stats.actual.protein_g}
						target={target?.protein_g ?? null}
					/>
					<MacroBar
						field="fat_g"
						label="脂肪"
						actual={stats.actual.fat_g}
						target={target?.fat_g ?? null}
					/>
					<MacroBar
						field="carb_g"
						label="碳水"
						actual={stats.actual.carb_g}
						target={target?.carb_g ?? null}
					/>
				</div>
			</div>
			{budget === null ? (
				<div className={styles.noTarget}>
					<p className={styles.line}>還沒有每日目標</p>
					{/* 直接到表單（建議目標也在那一頁），不繞身體與目標（D20）。 */}
					<Link to="/me/targets" className={styles.link}>
						設定每日目標
					</Link>
				</div>
			) : (
				// 「・」放在前一段的尾巴：放在下一段開頭的話段與段之間沒有地方換行（handover §7）。
				<p className={styles.line}>
					<span className={styles.nowrap}>已吃 {eaten}・</span>
					<span className={styles.nowrap}>
						預算 {roundForDisplay(budget, 0)}
					</span>
					{added !== null && (
						<span className={styles.nowrap}>
							（含運動 +{roundForDisplay(added, 0)}）
						</span>
					)}
				</p>
			)}
		</div>
	);
}
