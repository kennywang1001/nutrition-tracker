import type { ChangeEvent } from "react";
import { Link } from "react-router";
import { MEAL_TYPE_LABELS, type Meal, useTodayMeals } from "../api/meals";
import {
	describePhotoUploadError,
	useMealPhoto,
	useUploadMealPhoto,
} from "../api/photos";
import { PhotoPickerButton } from "../components/PhotoPickerButton";
import ui from "../components/ui.module.css";
import { ZoomablePhoto } from "../components/ZoomablePhoto";
import { formatTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import styles from "./MealList.module.css";

/** 這一餐的照片。**`photo_path` 本身從不出現在這個元件裡** ——
 *  它是伺服器端的相對路徑，不是 URL（規格 §5.2），唯一的用途是讓呼叫端
 *  判斷「這一餐有沒有照片」（見 `MealCard` 的 `photo_path !== null`）。
 *  真的取圖走 `useMealPhoto`：帶 token 打 `GET /api/meals/{id}/photo`，
 *  拿 blob 轉成 object URL。清單用縮圖（`?size=thumb`），點了才由
 *  `ZoomablePhoto` 抓原圖。
 *
 *  外層 `data-testid` 在照片還沒載入完（`objectUrl` 仍是 `null`）時就
 *  先出現——它標的是「這一餐有照片」這個事實，不是「圖已經載好了」。
 *
 *  **404（`MEAL_PHOTO_NOT_FOUND`）是正常可達的狀態**（後端註解：DB 有
 *  `photo_path` 但檔案不在磁碟上，是 `delete_photo()` best-effort 設計下
 *  可能出現的情況）——`isError` 時就不渲染 `<img>`，不是留一個壞掉的
 *  URL 在畫面上。 */
function MealPhoto({ meal }: { meal: Meal }) {
	const thumb = useMealPhoto(meal.id, "thumb");
	const alt = `${MEAL_TYPE_LABELS[meal.meal_type]}（${formatTime(meal.eaten_at)}）的照片`;

	return (
		<div data-testid={`meal-photo-${meal.id}`} className={styles.photo}>
			{thumb.objectUrl !== null && (
				<ZoomablePhoto
					alt={alt}
					thumbUrl={thumb.objectUrl}
					// biome-ignore lint/correctness/useHookAtTopLevel: 只在 ZoomablePhoto 的 Viewer 裡、每次 render 都以同樣順序呼叫，符合 hooks 規則
					useFull={() => useMealPhoto(meal.id)}
				/>
			)}
			{thumb.isError && <p>照片無法顯示</p>}
		</div>
	);
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

	// 外觀同編輯這一餐的「加照片」（PhotoPickerButton）；名稱維持「上傳照片」
	// （測試與螢幕閱讀器都靠它）。
	return (
		<div className={styles.upload}>
			<PhotoPickerButton
				id={inputId}
				label="上傳照片"
				accept="image/*"
				capture="environment"
				className={styles.photoButton}
				// 上傳中停用：不然還能再選一張，兩個 POST 同時在跑，晚回來的那張
				// 蓋掉早回來的——不一定是使用者最後選的。同編輯這一餐的「加照片」。
				disabled={upload.isPending}
				onChange={handleChange}
			/>
			{upload.isPending && <p role="status">上傳中…</p>}
			{upload.isError && (
				<p role="alert">{describePhotoUploadError(upload.error)}</p>
			)}
		</div>
	);
}

function MealCard({ meal }: { meal: Meal }) {
	return (
		<li className={styles.meal}>
			<div className={styles.cardHeader}>
				{/* 標籤放在 h3 外面：放裡面會併進標題的名稱，標題清單念成
				    「12:30 · 午餐只有我」。 */}
				<div className={styles.title}>
					<h3>
						{formatTime(meal.eaten_at)} · {MEAL_TYPE_LABELS[meal.meal_type]}
					</h3>
					{meal.is_private && <span className={styles.privateTag}>只有我</span>}
				</div>
				{/* 名稱帶時間與餐別：一頁有好幾張卡片，每張都寫「編輯」的話
				    螢幕閱讀器分不出是哪一餐。 */}
				<Link
					to={`/meals/${meal.id}/edit`}
					className={styles.editLink}
					aria-label={`編輯 ${formatTime(meal.eaten_at)} ${MEAL_TYPE_LABELS[meal.meal_type]}`}
				>
					編輯
				</Link>
			</div>
			{/* 真值判斷，不是 `!== null`：離線快取裡的舊餐沒有這個欄位（undefined），
			    `!== null` 會畫出一個空的段落。內容是 React 的文字節點——不會被當成 HTML。 */}
			{meal.description ? (
				<p
					data-testid={`meal-description-${meal.id}`}
					className={styles.description}
				>
					{meal.description}
				</p>
			) : null}
			{meal.photo_path !== null && <MealPhoto meal={meal} />}
			<MealPhotoUpload mealId={meal.id} />
			<ul className={styles.items}>
				{meal.items.map((item) => (
					// 食物名稱留在 <li> 自己的直接文字節點裡，份量另外包一層
					// <span>——這樣「滷肉飯」在 DOM 上才是單獨可比對的文字，
					// 不會跟旁邊的份量字串黏成同一段（RTL 的 getByText 是照
					// 「元素自己的直接子文字節點」比對，不是整棵子樹的 textContent）。
					<li key={item.id} className={styles.item}>
						{item.food_name}
						<span className={styles.quantity}>
							{" "}
							· {formatMacro(item.quantity_g)} {item.base_unit}
						</span>
					</li>
				))}
			</ul>
			<p className={styles.total}>合計 {formatMacro(meal.kcal)} kcal</p>
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
	const mealsQuery = useTodayMeals();

	const meals = mealsQuery.data ?? [];

	return (
		<section>
			<h2 className={`${ui.sectionTitle} ${styles.heading}`}>今日餐點</h2>
			{mealsQuery.isLoading && <p>載入中…</p>}
			{mealsQuery.isError && <p>無法載入餐點清單</p>}
			<ul className={styles.meals}>
				{meals.map((meal) => (
					<MealCard key={meal.id} meal={meal} />
				))}
			</ul>
		</section>
	);
}
