import { Link } from "react-router";
import type { FriendMeal } from "../api/friends";
import { MEAL_TYPE_LABELS } from "../api/meals";
import { useFriendMealPhoto } from "../api/photos";
import { formatDateTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import styles from "./FriendMealCard.module.css";

function FriendPhoto({ meal }: { meal: FriendMeal }) {
	const { objectUrl, isError } = useFriendMealPhoto(meal.user.id, meal.id);
	return (
		<>
			{objectUrl !== null && (
				<img
					src={objectUrl}
					alt={`${meal.user.display_name}的${MEAL_TYPE_LABELS[meal.meal_type]}`}
				/>
			)}
			{isError && <p>照片無法顯示</p>}
		</>
	);
}

/** 好友的一餐。`showName`：動態裡要寫是誰（連到他的一天）；在他自己的那一天就不重複。 */
export function FriendMealCard({
	meal,
	showName,
}: {
	meal: FriendMeal;
	showName: boolean;
}) {
	return (
		<li className={styles.card}>
			<div className={styles.header}>
				{showName && (
					<Link to={`/friends/${meal.user.id}`} className={styles.name}>
						{meal.user.display_name}
					</Link>
				)}
				<span className={styles.when}>
					{formatDateTime(meal.eaten_at)} · {MEAL_TYPE_LABELS[meal.meal_type]}
				</span>
			</div>
			{meal.has_photo && <FriendPhoto meal={meal} />}
			<ul className={styles.items}>
				{meal.items.map((item, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 白名單回應沒有項目 id，順序由後端固定
					<li key={index}>
						{item.food_name}
						<span> · {formatMacro(item.quantity_g)} g</span>
					</li>
				))}
			</ul>
			<p className={styles.macros}>
				{formatMacro(meal.kcal)} kcal · 蛋白質 {formatMacro(meal.protein_g)} g ·
				脂肪 {formatMacro(meal.fat_g)} g · 碳水 {formatMacro(meal.carb_g)} g
			</p>
		</li>
	);
}
