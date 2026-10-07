import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, X } from "lucide-react";
import { type ChangeEvent, type ReactNode, useEffect, useState } from "react";
import { useLocation, useNavigate, useParams } from "react-router";
import { apiFetch } from "../api/client";
import { ApiError, hasFieldError } from "../api/errors";
import { AMOUNT_FORMAT_ERROR } from "../api/expenses";
import {
	MEAL_TYPE_LABELS,
	MEAL_TYPE_ORDER,
	type Meal,
	type MealType,
	useMeal,
} from "../api/meals";
import {
	describePhotoUploadError,
	useMealPhoto,
	useUploadMealPhoto,
} from "../api/photos";
import { queryKeys } from "../api/queries";
import { fromLocalDateTime, localDateTime } from "../lib/dates";
import { formatMoney } from "../lib/decimal";
import styles from "./EditMeal.module.css";
import { EditMealItems } from "./EditMealItems";

type MealChanges = {
	meal_type?: MealType;
	cost?: string | null;
	note?: string | null;
	is_private?: boolean;
	eaten_at?: string;
};

/** 日期最早能選到哪一天（`<input type="date" min>` 與 `dateTimeProblem` 共用）。
 *  更早的多半是手滑——例如年份只打了「2」。 */
const MIN_DATE = "2000-01-01";

function initialCost(meal: Meal): string {
	return meal.cost === null ? "" : formatMoney(meal.cost);
}

/** 跟目前的這一餐比，有改的欄位才放進 body（`PATCH` 是 `exclude_unset`：
 *  不帶＝不動）。沒有任何改動回 `null`。
 *
 *  金額清空＝`cost: null`＝拿掉餐費（編輯餐點規格 §3.2）；備註清空＝
 *  `note: null`。 */
function mealChanges(
	meal: Meal,
	draft: {
		mealType: MealType | undefined;
		cost: string | undefined;
		note: string | undefined;
		isPrivate: boolean | undefined;
		date: string | undefined;
		time: string | undefined;
	},
): MealChanges | null {
	const changes: MealChanges = {};
	if (draft.date !== undefined || draft.time !== undefined) {
		const original = localDateTime(meal.eaten_at);
		const date = draft.date ?? original.date;
		const time = draft.time ?? original.time;
		const chosen = fromLocalDateTime(date, time);
		// 清空到一半（日期或時間是空的）不是有效的時刻：這裡不算改動，
		// 擋的是 dateTimeProblem。
		// 比的是到分鐘的日期與時間字串，不是時刻：原本的秒數不會讓「改了又改
		// 回來」被當成有改（比時刻的話 12:30:00 ≠ 12:30:45）。
		if (chosen !== null && (date !== original.date || time !== original.time)) {
			changes.eaten_at = chosen.toISOString();
		}
	}
	if (draft.mealType !== undefined && draft.mealType !== meal.meal_type) {
		changes.meal_type = draft.mealType;
	}
	if (draft.cost !== undefined) {
		const cost = draft.cost.trim();
		if (cost !== initialCost(meal)) {
			changes.cost = cost === "" ? null : cost;
		}
	}
	if (draft.note !== undefined) {
		const note = draft.note.trim();
		if (note !== (meal.note ?? "")) {
			changes.note = note === "" ? null : note;
		}
	}
	if (draft.isPrivate !== undefined && draft.isPrivate !== meal.is_private) {
		changes.is_private = draft.isPrivate;
	}
	return Object.keys(changes).length === 0 ? null : changes;
}

/** 日期與時間的草稿有問題就回訊息：空的、早於 `MIN_DATE`、或比現在晚（到分鐘，
 *  依這台裝置的時鐘；改時間規格 §4）。 */
function dateTimeProblem(
	meal: Meal,
	date?: string,
	time?: string,
): string | null {
	if (date === undefined && time === undefined) return null;
	const original = localDateTime(meal.eaten_at);
	const chosenDate = date ?? original.date;
	const chosenTime = time ?? original.time;
	const chosen = fromLocalDateTime(chosenDate, chosenTime);
	if (chosen === null) return "請選日期與時間";
	// 格式驗過了（四位數年份的 YYYY-MM-DD）：字串比較就是日期比較。
	if (chosenDate < MIN_DATE) return "日期太早了";
	if (chosen.getTime() > Date.now()) return "不能選未來的時間";
	return null;
}

function describeSaveError(error: unknown): string {
	// 另一台裝置剛補了這一餐的金額（安全補強規格 §4.2）：用後端的訊息。
	if (error instanceof ApiError && error.code === "MEAL_COST_CONFLICT") {
		return error.message;
	}
	// VALIDATION_ERROR 只有在真的是 cost 時才說金額（同記一餐）。
	if (
		error instanceof ApiError &&
		error.code === "VALIDATION_ERROR" &&
		hasFieldError(error, "cost")
	) {
		return AMOUNT_FORMAT_ERROR;
	}
	return "儲存失敗，請再試一次";
}

const DATE_TIME_PROBLEM_ID = "edit-meal-date-time-problem";

/** 日期、時間、餐別、金額、備註、隱私（編輯餐點規格 §4.2 第 2 點、改時間規格）。
 *  一顆「儲存」，只送有改的欄位。
 *
 *  每個欄位的草稿是 `undefined`＝沒動過，顯示的是伺服器現在的值
 *  （`draft ?? 伺服器值`）；使用者動過才有草稿。這樣背景重抓帶來另一台
 *  裝置的新值時，沒動過的欄位跟著更新，不會被誤算成「有改動」而在儲存時
 *  蓋回去。只送動過、且跟伺服器不同的欄位。存好之後六個草稿（餐別、金額、
 *  備註、隱私、日期、時間）都清掉，表單顯示伺服器的值，「儲存」回到
 *  disabled。 */
function MealDetailsForm({ meal }: { meal: Meal }) {
	const queryClient = useQueryClient();
	const [mealType, setMealType] = useState<MealType | undefined>(undefined);
	const [cost, setCost] = useState<string | undefined>(undefined);
	const [note, setNote] = useState<string | undefined>(undefined);
	const [isPrivate, setIsPrivate] = useState<boolean | undefined>(undefined);
	const [date, setDate] = useState<string | undefined>(undefined);
	const [time, setTime] = useState<string | undefined>(undefined);

	const changes = mealChanges(meal, {
		mealType,
		cost,
		note,
		isPrivate,
		date,
		time,
	});
	const problem = dateTimeProblem(meal, date, time);
	// 有問題時兩個欄位都標成無效，並指到那則訊息（讀屏念欄位時一起念）。
	const dateTimeInvalid =
		problem === null
			? {}
			: {
					"aria-invalid": true,
					"aria-describedby": DATE_TIME_PROBLEM_ID,
				};

	const save = useMutation({
		mutationFn: (body: MealChanges) =>
			apiFetch<Meal>(`/api/meals/${meal.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onError: (caught: unknown) => {
			if (caught instanceof ApiError && caught.code === "MEAL_COST_CONFLICT") {
				// 清掉金額草稿、重抓：欄位換成另一台存的值。`meals` 是前綴，
				// 這一餐（`meal(id)`）也一起重抓；總覽的清單與報表的支出同樣要
				// 拿到另一台存的金額。
				setCost(undefined);
				queryClient.invalidateQueries({ queryKey: queryKeys.meals });
				queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			}
		},
		onSuccess: (updated, body) => {
			// PATCH 的回應就是更新後的整餐：先寫進這一餐的快取，再清草稿。
			// 只清草稿的話，重抓回來之前表單會閃回舊的伺服器值（慢速連線上
			// 使用者會以為沒存成功）。重抓（下面的失效）照樣做：今日清單與
			// 其他快取還需要它。
			if (updated != null) {
				queryClient.setQueryData(queryKeys.meal(meal.id), updated);
			}
			setMealType(undefined);
			setCost(undefined);
			setNote(undefined);
			setIsPrivate(undefined);
			setDate(undefined);
			setTime(undefined);
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			// 改了時間：那一天的營養素、趨勢、餐費日期、「最近吃」的順序都變了。
			if ("eaten_at" in body) {
				for (const queryKey of [
					queryKeys.dailyStats,
					queryKeys.rangeStatsAll,
					queryKeys.expensesAll,
					queryKeys.recentFoods,
				]) {
					queryClient.invalidateQueries({ queryKey });
				}
			}
			// 餐費改了（改、補、拿掉）——報表與總覽的支出都要重取。
			if ("cost" in body) {
				queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			}
		},
	});

	// 一改欄位就把上一次的「已儲存」或錯誤收掉，不然它會掛在一個已經不是
	// 那次送出內容的表單上。
	// 送出中不 reset：reset 會讓進行中的那次送出不再回報結果。
	function edit<T>(setter: (value: T) => void) {
		return (value: T) => {
			setter(value);
			if (!save.isPending) save.reset();
		};
	}

	return (
		<form
			aria-labelledby="edit-meal-details"
			className={styles.section}
			onSubmit={(event) => {
				event.preventDefault();
				if (changes !== null && problem === null && !save.isPending) {
					save.mutate(changes);
				}
			}}
		>
			<h2 id="edit-meal-details">這一餐</h2>

			<label htmlFor="edit-meal-date">日期</label>
			<input
				id="edit-meal-date"
				type="date"
				min={MIN_DATE}
				max={localDateTime(new Date().toISOString()).date}
				value={date ?? localDateTime(meal.eaten_at).date}
				onChange={(event) => edit(setDate)(event.target.value)}
				{...dateTimeInvalid}
			/>
			<label htmlFor="edit-meal-time">時間</label>
			<input
				id="edit-meal-time"
				type="time"
				value={time ?? localDateTime(meal.eaten_at).time}
				onChange={(event) => edit(setTime)(event.target.value)}
				{...dateTimeInvalid}
			/>
			{problem !== null && (
				<p id={DATE_TIME_PROBLEM_ID} role="alert">
					{problem}
				</p>
			)}

			<label htmlFor="edit-meal-type">餐別</label>
			<select
				id="edit-meal-type"
				value={mealType ?? meal.meal_type}
				onChange={(event) => edit(setMealType)(event.target.value as MealType)}
			>
				{MEAL_TYPE_ORDER.map((value) => (
					<option key={value} value={value}>
						{MEAL_TYPE_LABELS[value]}
					</option>
				))}
			</select>

			<label htmlFor="edit-meal-cost">金額（選填）</label>
			<input
				id="edit-meal-cost"
				type="text"
				inputMode="decimal"
				value={cost ?? initialCost(meal)}
				onChange={(event) => edit(setCost)(event.target.value)}
			/>

			<label htmlFor="edit-meal-note">備註（選填）</label>
			<input
				id="edit-meal-note"
				type="text"
				value={note ?? meal.note ?? ""}
				onChange={(event) => edit(setNote)(event.target.value)}
			/>

			<label className={styles.privateToggle}>
				<input
					type="checkbox"
					checked={isPrivate ?? meal.is_private}
					onChange={(event) => edit(setIsPrivate)(event.target.checked)}
				/>
				只有我看得到（好友看不到這一餐）
			</label>

			{save.isError && <p role="alert">{describeSaveError(save.error)}</p>}
			{save.isSuccess && <p role="status">已儲存</p>}
			<button
				type="submit"
				className={styles.primary}
				disabled={changes === null || problem !== null || save.isPending}
			>
				{save.isPending ? "儲存中…" : "儲存"}
			</button>
		</form>
	);
}

function PhotoPreview({ mealId }: { mealId: number }) {
	const { objectUrl, isError } = useMealPhoto(mealId);
	return (
		<>
			{objectUrl !== null && (
				<img className={styles.photo} src={objectUrl} alt="這一餐的照片" />
			)}
			{isError && <p>照片無法顯示</p>}
		</>
	);
}

/** 照片：換、加、刪（編輯餐點規格 §4.2 第 4 點）。
 *
 *  **只有 `photo_path` 不是 null 才掛 `PhotoPreview`**——沒有照片時抓圖
 *  一定是 404，白打一個請求。 */
function MealPhotoSection({ meal }: { meal: Meal }) {
	const queryClient = useQueryClient();
	const upload = useUploadMealPhoto(meal.id);
	const [confirming, setConfirming] = useState(false);
	const mealId = meal.id;
	const hasPhoto = meal.photo_path !== null;

	// 沒有照片了（這裡刪的、或別台裝置刪的）：收起確認框，並丟掉照片快取。
	// 此時 PhotoPreview 已經卸載，移除不會讓它把 query 重建回來。
	useEffect(() => {
		if (hasPhoto) return;
		setConfirming(false);
		queryClient.removeQueries({ queryKey: queryKeys.mealPhoto(mealId) });
	}, [hasPhoto, queryClient, mealId]);

	const removePhoto = useMutation({
		mutationFn: () =>
			apiFetch(`/api/meals/${meal.id}/photo`, { method: "DELETE" }),
		onSuccess: () => {
			// **順序有講究。** 還掛著的 PhotoPreview 訂閱著 mealPhoto：這裡立刻
			// removeQueries 的話，PhotoPreview 在卸載之前又 render 一次，把剛移除
			// 的 query 重建出來、重抓一張已經刪掉的照片（404）。所以這裡只先把
			// 快取裡這一餐的 photo_path 改成 null（PhotoPreview 隨之卸載），再失效
			// meals；照片 query 與確認框由下面的 effect 在 photo_path 變成 null
			// （PhotoPreview 已經不在）之後收掉。同樣不呼叫 setConfirming(false)：
			// 它會比 TanStack 排程的通知早一步 render，跟上面同一個問題。
			queryClient.setQueryData<Meal | null | undefined>(
				queryKeys.meal(meal.id),
				(cached) => (cached ? { ...cached, photo_path: null } : cached),
			);
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
		},
	});

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：上傳失敗後重選同一張，change 才會再觸發。
		event.target.value = "";
		if (file === undefined) return;
		upload.mutate(file);
	}

	return (
		<section aria-labelledby="edit-meal-photo-title" className={styles.section}>
			<h2 id="edit-meal-photo-title">照片</h2>
			{hasPhoto && <PhotoPreview mealId={meal.id} />}

			<label htmlFor="edit-meal-photo" className={styles.photoButton}>
				<Camera aria-hidden="true" size={18} />
				{hasPhoto ? "換照片" : "加照片"}
			</label>
			<input
				id="edit-meal-photo"
				type="file"
				accept="image/*"
				className={styles.fileInput}
				disabled={upload.isPending}
				onChange={handleChange}
			/>
			{upload.isPending && <p role="status">上傳中…</p>}
			{upload.isError && (
				<p role="alert">{describePhotoUploadError(upload.error)}</p>
			)}

			{hasPhoto &&
				(confirming ? (
					<div role="alertdialog" aria-label="確認刪除照片">
						<p>確定要刪除這張照片嗎？</p>
						<button
							type="button"
							className={styles.danger}
							disabled={removePhoto.isPending}
							onClick={() => removePhoto.mutate()}
						>
							確定刪除
						</button>
						<button type="button" onClick={() => setConfirming(false)}>
							取消
						</button>
					</div>
				) : (
					<button
						type="button"
						className={styles.danger}
						onClick={() => setConfirming(true)}
					>
						刪除照片
					</button>
				))}
			{removePhoto.isError && <p role="alert">刪除照片失敗，請再試一次</p>}
		</section>
	);
}

/** 刪除整餐（編輯餐點規格 §4.2 第 5 點）。後端連餐費一起刪（同一個交易），
 *  所以確認文字要把餐費講出來。 */
function DeleteMeal({
	meal,
	onDeleted,
}: {
	meal: Meal;
	onDeleted: () => void;
}) {
	const queryClient = useQueryClient();
	const [confirming, setConfirming] = useState(false);

	const remove = useMutation({
		mutationFn: () => apiFetch(`/api/meals/${meal.id}`, { method: "DELETE" }),
		onSuccess: () => {
			// **先移除這一餐自己的快取，再失效其他。** 順序反過來的話，
			// 失效 `meals` 會前綴比對到 `meal(id)`，讓還掛著的 useMeal 去重抓
			// 一個已經刪掉的餐（404）。照片同理。
			queryClient.removeQueries({ queryKey: queryKeys.meal(meal.id) });
			queryClient.removeQueries({ queryKey: queryKeys.mealPhoto(meal.id) });
			// 營養素、趨勢、常吃／最近吃都少了這一餐；餐費也刪了。
			for (const queryKey of [
				queryKeys.meals,
				queryKeys.dailyStats,
				queryKeys.rangeStatsAll,
				queryKeys.frequentFoods,
				queryKeys.recentFoods,
				queryKeys.expensesAll,
			]) {
				queryClient.invalidateQueries({ queryKey });
			}
			onDeleted();
		},
	});

	return (
		<section className={styles.section}>
			{confirming ? (
				<div role="alertdialog" aria-label="確認刪除這一餐">
					<p>確定要刪除這一餐嗎？</p>
					{meal.cost !== null && (
						<p>這一餐的餐費 ${formatMoney(meal.cost)} 也會一起刪除。</p>
					)}
					{/* 送出中停用：刪兩次第二次會 404，顯示一個誤導的錯誤。 */}
					<button
						type="button"
						className={styles.danger}
						disabled={remove.isPending}
						onClick={() => remove.mutate()}
					>
						確定刪除
					</button>
					<button type="button" onClick={() => setConfirming(false)}>
						取消
					</button>
				</div>
			) : (
				<button
					type="button"
					className={styles.danger}
					onClick={() => setConfirming(true)}
				>
					刪除這一餐
				</button>
			)}
			{remove.isError && <p role="alert">刪除失敗，請再試一次</p>}
		</section>
	);
}

/** `/meals/:id/edit`：修改或刪除一筆已經記下的餐（編輯餐點規格 §4.2）。
 *
 *  **每個區塊各自立即送出**，沒有「全部儲存」——每個動作在後端是一個交易，
 *  畫面不會有「改了一半」的狀態。錯誤也顯示在各自的區塊裡。
 *  日期與時間在「這一餐」表單裡改（改時間規格）。 */
export function EditMeal() {
	const params = useParams<{ id: string }>();
	const mealId = params.id !== undefined ? Number(params.id) : Number.NaN;
	const mealQuery = useMeal(mealId);
	const navigate = useNavigate();
	const location = useLocation();

	// 直接打開網址（書籤、PWA 重新整理）時沒有上一頁，navigate(-1) 會離開
	// app 或什麼都不做。react-router 的第一個 history entry 的 key 是
	// "default"（介面改版 Task 5 實測）。
	function close() {
		if (location.key === "default") {
			navigate("/");
		} else {
			navigate(-1);
		}
	}

	const meal = mealQuery.data;
	const notFound =
		!Number.isFinite(mealId) ||
		(mealQuery.error instanceof ApiError && mealQuery.error.status === 404);

	let body: ReactNode;
	if (notFound) {
		body = <p>找不到這一餐</p>;
	} else if (meal != null) {
		// 資料優先於錯誤：重抓失敗但手上有資料就照樣顯示。
		body = (
			<>
				<MealDetailsForm key={meal.id} meal={meal} />
				<EditMealItems meal={meal} />
				<MealPhotoSection meal={meal} />
				<DeleteMeal meal={meal} onDeleted={close} />
			</>
		);
	} else if (mealQuery.isPending) {
		body = <p>載入中…</p>;
	} else {
		body = <p>無法載入這一餐</p>;
	}

	return (
		<section className={styles.screen}>
			<header className={styles.header}>
				<button
					type="button"
					className={styles.close}
					aria-label="關閉"
					onClick={close}
				>
					<X aria-hidden="true" size={20} />
				</button>
				<h1>編輯這一餐</h1>
			</header>
			{body}
		</section>
	);
}
