import { Link } from "react-router";
import type { FriendMeal } from "../api/friends";
import { MEAL_TYPE_LABELS } from "../api/meals";
import { useFriendMealPhoto } from "../api/photos";
import { formatDateTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import styles from "./FriendMealCard.module.css";
import { ZoomablePhoto } from "./ZoomablePhoto";

function FriendPhoto({ meal }: { meal: FriendMeal }) {
	const thumb = useFriendMealPhoto(meal.user.id, meal.id, "thumb");
	return (
		<>
			{thumb.objectUrl !== null && (
				<ZoomablePhoto
					alt={`${meal.user.display_name}的${MEAL_TYPE_LABELS[meal.meal_type]}`}
					thumbUrl={thumb.objectUrl}
					// biome-ignore lint/correctness/useHookAtTopLevel: 只在 ZoomablePhoto 的 Viewer 裡、每次 render 都以同樣順序呼叫，符合 hooks 規則
					useFull={() => useFriendMealPhoto(meal.user.id, meal.id)}
				/>
			)}
			{thumb.isError && <p>照片無法顯示</p>}
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
			{meal.description ? (
				<p
					data-testid={`friend-meal-description-${meal.id}`}
					className={styles.description}
				>
					{meal.description}
				</p>
			) : null}
			{meal.has_photo && <FriendPhoto meal={meal} />}
			<ul className={styles.items}>
				{meal.items.map((item, index) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: 白名單回應沒有項目 id，順序由後端固定
					<li key={index}>
						{item.food_name}
						<span>
							{" "}
							· {formatMacro(item.quantity_g)} {item.base_unit}
						</span>
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
