import { Link } from "react-router";
import { type DailyStats, kcalBudgetOf } from "../api/stats";
import { SUGGEST_STATE } from "../lib/planner";
import { Card } from "./Card";
import styles from "./PlannerCard.module.css";
import ui from "./ui.module.css";

/** 飲食頁的「今天還能吃什麼」（營養素配餐規格 §7.2）。**不顯示剩下的數字**（D26）：數字在
 *  `/planner`——卡片要數字就得多打一個請求、或在前端做第二份「額度」的減法。
 *  有沒有熱量額度用 `kcalBudgetOf`（舊的離線快取沒有 `kcal_budget`，退回目標）。 */
export function PlannerCard({ stats }: { stats: DailyStats }) {
	return (
		<Card testId="planner-card">
			<h2 className={`${ui.sectionTitle} ${styles.title}`}>今天還能吃什麼</h2>
			{kcalBudgetOf(stats) === null ? (
				<p className={styles.hint}>
					先設定每日目標，才知道今天還能吃多少。
					<Link to="/me/targets" className={styles.inlineLink}>
						設定每日目標
					</Link>
				</p>
			) : (
				<div className={styles.actions}>
					<Link to="/planner" className={styles.action}>
						從食物庫配
					</Link>
					{/* 模式 B 在記一餐裡（D15）：帶 router state，記一餐一打開就展開那個表單（D22）。 */}
					<Link to="/meals/new" state={SUGGEST_STATE} className={styles.action}>
						讓 AI 配一餐
					</Link>
				</div>
			)}
		</Card>
	);
}
