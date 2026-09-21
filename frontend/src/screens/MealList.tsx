import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { formatTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";

type Meal = components["schemas"]["MealResponse"];
type MealType = components["schemas"]["MealType"];

const MEAL_TYPE_LABELS: Record<MealType, string> = {
	breakfast: "早餐",
	lunch: "午餐",
	dinner: "晚餐",
	snack: "點心",
};

/** 照片區塊的佔位版本。**這個 task（計畫三 Task 1）故意不取圖** ——
 *  `photo_path` 是伺服器端的相對路徑，不是 URL（規格 §5.2）。直接塞進
 *  `<img src>` 的話瀏覽器會對它發一個沒有 Authorization 的請求，在 SPA
 *  fallback 之下拿到的不是 404、是整份 index.html。真的取圖要先驗證
 *  JWT，那是 Task 2（`useMealPhoto` / `GET /api/meals/{id}/photo`）的事。
 *  這裡先只顯示「有照片」這個事實，不渲染任何 `<img>`。 */
function MealPhotoPlaceholder({ mealId }: { mealId: number }) {
	return <p data-testid={`meal-photo-${mealId}`}>📷 有照片</p>;
}

function MealCard({ meal }: { meal: Meal }) {
	return (
		<li>
			<h3>
				{formatTime(meal.eaten_at)} · {MEAL_TYPE_LABELS[meal.meal_type]}
			</h3>
			{meal.photo_path !== null && <MealPhotoPlaceholder mealId={meal.id} />}
			<ul>
				{meal.items.map((item) => (
					// 食物名稱留在 <li> 自己的直接文字節點裡，份量另外包一層
					// <span>——這樣「滷肉飯」在 DOM 上才是單獨可比對的文字，
					// 不會跟旁邊的份量字串黏成同一段（RTL 的 getByText 是照
					// 「元素自己的直接子文字節點」比對，不是整棵子樹的 textContent）。
					<li key={item.id}>
						{item.food_name}
						<span> · {formatMacro(item.quantity_g)} g</span>
					</li>
				))}
			</ul>
			<p>合計 {formatMacro(meal.kcal)} kcal</p>
		</li>
	);
}

/** 今日餐點清單。
 *
 *  **不帶 `date` 參數。** 後端的 `list_meals` 省略 `?date=` 時用
 *  `today_in_timezone(user.timezone)`（`app/days.py`）——跟 `/api/stats/daily`、
 *  `/api/supplements/today` 是同一個函式。前端自己算「今天」就是建立
 *  第二個事實來源，在使用者時區跟瀏覽器時區不同時會在午夜前後靜默算錯。 */
export function MealList() {
	const mealsQuery = useQuery({
		queryKey: queryKeys.meals,
		queryFn: () => apiFetch<Meal[]>("/api/meals"),
	});

	const meals = mealsQuery.data ?? [];

	return (
		<section>
			<h2>今日餐點</h2>
			{mealsQuery.isLoading && <p>載入中…</p>}
			{mealsQuery.isError && <p>無法載入餐點清單</p>}
			<ul>
				{meals.map((meal) => (
					<MealCard key={meal.id} meal={meal} />
				))}
			</ul>
		</section>
	);
}
