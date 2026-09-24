import type { ReactNode } from "react";
import type { Food } from "../api/foods";
import { formatMacro } from "../lib/decimal";

type Props = {
	foods: readonly Food[];
	/** 每一筆要渲染成什麼。食物庫給一個 `<Link>`，記一餐給一個 `<button>` ——
	 *  這個元件不決定去向（規格 §5.4：共用 query hook，不共用元件的去向）。 */
	renderAction: (food: Food) => ReactNode;
};

export function FoodResultList({ foods, renderAction }: Props) {
	if (foods.length === 0) {
		return <p>找不到符合的食物</p>;
	}
	return (
		<ul className="food-results">
			{foods.map((food) => (
				<li key={food.id} data-testid={`food-${food.id}`}>
					{renderAction(food)}
					{food.brand !== null && (
						<span className="food-brand">{food.brand}</span>
					)}
					{food.is_global && <span className="food-tag">公開</span>}
					{food.nutrition === null ? (
						// 規格 §5.5：這不是邊界情況，是後端明寫的合法狀態
						// （全域食物的初版被駁回）。實測確認過搜尋查得到這種食物。
						// 空白一片會讓人以為畫面壞了，所以明講。
						<span className="food-no-nutrition">尚無營養素資料</span>
					) : (
						<span>
							{formatMacro(food.nutrition.kcal)} kcal / 100
							{food.nutrition.base_unit}
						</span>
					)}
				</li>
			))}
		</ul>
	);
}
