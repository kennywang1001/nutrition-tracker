import { useQuery } from "@tanstack/react-query";
import { apiFetch } from "../api/client";
import { useMealPhoto } from "../api/photos";
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

/** 這一餐的照片。**`photo_path` 本身從不出現在這個元件裡** ——
 *  它是伺服器端的相對路徑，不是 URL（規格 §5.2），唯一的用途是讓呼叫端
 *  判斷「這一餐有沒有照片」（見 `MealCard` 的 `photo_path !== null`）。
 *  真的取圖走 `useMealPhoto`：帶 token 打 `GET /api/meals/{id}/photo`，
 *  拿 blob 轉成 object URL。
 *
 *  外層 `data-testid` 在照片還沒載入完（`objectUrl` 仍是 `null`）時就
 *  先出現——它標的是「這一餐有照片」這個事實，不是「圖已經載好了」。
 *
 *  **404（`MEAL_PHOTO_NOT_FOUND`）是正常可達的狀態**（後端註解：DB 有
 *  `photo_path` 但檔案不在磁碟上，是 `delete_photo()` best-effort 設計下
 *  可能出現的情況）——`isError` 時就不渲染 `<img>`，不是留一個壞掉的
 *  URL 在畫面上。 */
function MealPhoto({ meal }: { meal: Meal }) {
	const { objectUrl, isError } = useMealPhoto(meal.id);
	const alt = `${MEAL_TYPE_LABELS[meal.meal_type]}（${formatTime(meal.eaten_at)}）的照片`;

	return (
		<div data-testid={`meal-photo-${meal.id}`}>
			{objectUrl !== null && <img src={objectUrl} alt={alt} />}
			{isError && <p>照片無法顯示</p>}
		</div>
	);
}

function MealCard({ meal }: { meal: Meal }) {
	return (
		<li>
			<h3>
				{formatTime(meal.eaten_at)} · {MEAL_TYPE_LABELS[meal.meal_type]}
			</h3>
			{meal.photo_path !== null && <MealPhoto meal={meal} />}
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
