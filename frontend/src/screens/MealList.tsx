import { useQuery } from "@tanstack/react-query";
import type { ChangeEvent } from "react";
import { apiFetch } from "../api/client";
import { ApiError } from "../api/errors";
import {
	PhotoTooLargeError,
	useMealPhoto,
	useUploadMealPhoto,
} from "../api/photos";
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

/** 把上傳失敗的原因翻成使用者看得懂的訊息。
 *
 *  **不是直接顯示 `error.message`**：後端 `INVALID_PHOTO` 的訊息是
 *  「無法識別的圖片內容」，這裡刻意換成更短的「無法識別的圖片」——
 *  這個 code 理論上不會發生（前端已經先用 `shrinkToLongestEdge` 把圖
 *  降尺寸過，能被降尺寸就代表瀏覽器認得那是一張圖），但「理論上不會
 *  發生」的東西如果讓畫面白掉，代價不對稱，所以仍然要有對應的文字，
 *  不能放著讓一個沒被接住的例外把畫面炸掉。 */
function describeUploadError(error: unknown): string {
	if (error instanceof PhotoTooLargeError) return error.message;
	if (error instanceof ApiError) {
		if (error.code === "PHOTO_TOO_LARGE") return error.message;
		if (error.code === "INVALID_PHOTO") return "無法識別的圖片";
	}
	return "上傳照片失敗，請再試一次";
}

/** 上傳／取代一餐照片的控制項。**每一餐都有這個控制項**，不管目前有沒有
 *  照片——後端的 `upload_meal_photo` 本來就是「有就取代、沒有就新增」
 *  的語意（`app/api/routes/meals.py` 的函式註解）。
 *
 *  `capture="environment"` 讓手機點下去直接開後鏡頭相機，而不是先跳到
 *  相簿選擇畫面——這是記錄「現在正在吃的這一餐」的最短路徑。 */
function MealPhotoUpload({ mealId }: { mealId: number }) {
	const upload = useUploadMealPhoto(mealId);
	const inputId = `meal-photo-upload-${mealId}`;

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 讓使用者重選同一個檔案也會再次觸發 onChange（例如上傳失敗後
		// 想重試同一張照片）。
		event.target.value = "";
		if (file === undefined) return;
		upload.mutate(file);
	}

	return (
		<div>
			<label htmlFor={inputId}>上傳照片</label>
			<input
				id={inputId}
				type="file"
				accept="image/*"
				capture="environment"
				onChange={handleChange}
			/>
			{upload.isError && (
				<p role="alert">{describeUploadError(upload.error)}</p>
			)}
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
			<MealPhotoUpload mealId={meal.id} />
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
