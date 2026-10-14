import { Dumbbell } from "lucide-react";
import { type ReactNode, useId } from "react";
import { Link } from "react-router";
import { useTodayExercises } from "../api/exercises";
import { formatTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import { Card } from "./Card";
import { EXERCISE_COLOR, IconBadge } from "./IconBadge";
import styles from "./TodayExercises.module.css";
import ui from "./ui.module.css";

/** 飲食頁的「今日運動」卡片（運動規格 §7.5）。每筆一列連到編輯；合計用後端的 `total_kcal`
 *  （前端不自己加）。**只在「我的」那一邊掛**：運動是自己的，看好友時不畫也不抓（§8）。 */
export function TodayExercises() {
	const query = useTodayExercises();
	const titleId = useId();
	const list = query.data;

	let body: ReactNode;
	if (list !== undefined) {
		body =
			list.entries.length === 0 ? (
				<p className={styles.empty}>今天還沒有運動</p>
			) : (
				<>
					<ul className={styles.list} aria-labelledby={titleId}>
						{list.entries.map((exercise) => (
							<li key={exercise.id}>
								<Link
									to={`/exercises/${exercise.id}/edit`}
									className={styles.row}
								>
									<IconBadge icon={Dumbbell} color={EXERCISE_COLOR} />
									<span className={styles.title}>
										{exercise.label}・{exercise.minutes} 分鐘
									</span>
									<span className={styles.time}>
										{formatTime(exercise.performed_at)}
									</span>
									{/* D27：ASCII 減號，同總覽時間線。 */}
									<span className={styles.value}>
										-{formatMacro(exercise.kcal)} kcal
									</span>
								</Link>
							</li>
						))}
					</ul>
					<p className={styles.total}>
						共 -{formatMacro(list.total_kcal)} kcal
					</p>
				</>
			);
	} else if (query.isError) {
		body = <p className={styles.empty}>無法載入今天的運動</p>;
	} else {
		body = <p className={styles.empty}>載入中…</p>;
	}

	return (
		<Card>
			<h2 id={titleId} className={`${ui.sectionTitle} ${styles.cardTitle}`}>
				今日運動
			</h2>
			<Link to="/exercises/new" className={styles.cardLink}>
				記運動
			</Link>
			{body}
		</Card>
	);
}
