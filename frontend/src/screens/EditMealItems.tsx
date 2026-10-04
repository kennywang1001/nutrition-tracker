import type { Meal } from "../api/meals";
import { formatMacro } from "../lib/decimal";
import styles from "./EditMeal.module.css";

/** 編輯畫面的項目區。 */
export function EditMealItems({ meal }: { meal: Meal }) {
	return (
		<section aria-labelledby="edit-meal-items" className={styles.section}>
			<h2 id="edit-meal-items">項目</h2>
			{meal.items.length === 0 ? (
				<p>這一餐沒有項目</p>
			) : (
				<ul className={styles.items}>
					{meal.items.map((item) => (
						<li key={item.id} data-testid={`meal-item-${item.id}`}>
							<span className={styles.itemName}>{item.food_name}</span>
							<span className={styles.itemMeta}>
								{formatMacro(item.quantity_g)} g · {formatMacro(item.kcal)} kcal
							</span>
						</li>
					))}
				</ul>
			)}
		</section>
	);
}
