import type { ReactNode } from "react";
import type { Food } from "../api/foods";
import { formatMacro } from "../lib/decimal";

type Props = {
	foods: readonly Food[];
	/** 每一筆要渲染成什麼。食物庫給一個 `<Link>`，記一餐給一個 `<button>` ——
	 *  這個元件不決定去向（規格 §5.4：共用 query hook，不共用元件的去向）。 */
	renderAction: (food: Food) => ReactNode;
	/** `food.nutrition === null` 時，`renderAction` 旁邊顯示的說明文字。
	 *
	 *  **預設「尚無營養素資料」，是資訊性標示，不影響能不能點。** 食物庫
	 *  這邊這種食物照常點得進詳情頁——那正是你想知道「為什麼它沒有數值」
	 *  的地方（看編輯歷史與駁回理由），擋住連結等於把唯一的答案也擋住
	 *  （規格 §5.5）。
	 *
	 *  **記一餐（Task 6）傳入不同的文字。** 那邊 `renderAction` 回傳的按鈕
	 *  同時是 `disabled`——因為這種食物選了也記不了（`POST /api/meals`
	 *  對它一律回 `409 FOOD_HAS_NO_REVISION`）。文字要說明「為什麼不能
	 *  選」，不只是「沒有資料」，所以不能沿用這裡的預設值。 */
	noNutritionMessage?: string;
};

export function FoodResultList({
	foods,
	renderAction,
	noNutritionMessage = "尚無營養素資料",
}: Props) {
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
						<span className="food-no-nutrition">{noNutritionMessage}</span>
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
