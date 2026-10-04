import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Camera, X } from "lucide-react";
import { type ChangeEvent, type ReactNode, useState } from "react";
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
import { formatMoney } from "../lib/decimal";
import styles from "./EditMeal.module.css";
import { EditMealItems } from "./EditMealItems";

type MealChanges = {
	meal_type?: MealType;
	cost?: string | null;
	note?: string | null;
};

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
	draft: { mealType: MealType; cost: string; note: string },
): MealChanges | null {
	const changes: MealChanges = {};
	if (draft.mealType !== meal.meal_type) {
		changes.meal_type = draft.mealType;
	}
	const cost = draft.cost.trim();
	if (cost !== initialCost(meal)) {
		changes.cost = cost === "" ? null : cost;
	}
	const note = draft.note.trim();
	if (note !== (meal.note ?? "")) {
		changes.note = note === "" ? null : note;
	}
	return Object.keys(changes).length === 0 ? null : changes;
}

function describeSaveError(error: unknown): string {
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

/** 餐別、金額、備註（編輯餐點規格 §4.2 第 2 點）。一顆「儲存」，只送有改的欄位。
 *
 *  草稿在掛載時從這一餐帶入。存好之後 `meals` 失效、這一餐重抓，草稿跟
 *  新的值一樣，「儲存」回到 disabled。 */
function MealDetailsForm({ meal }: { meal: Meal }) {
	const queryClient = useQueryClient();
	const [mealType, setMealType] = useState<MealType>(meal.meal_type);
	const [cost, setCost] = useState(initialCost(meal));
	const [note, setNote] = useState(meal.note ?? "");

	const changes = mealChanges(meal, { mealType, cost, note });

	const save = useMutation({
		mutationFn: (body: MealChanges) =>
			apiFetch<Meal>(`/api/meals/${meal.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
		onSuccess: (_meal, body) => {
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			// 餐費改了（改、補、拿掉）——報表與總覽的支出都要重取。
			if ("cost" in body) {
				queryClient.invalidateQueries({ queryKey: queryKeys.expensesAll });
			}
		},
	});

	// 一改欄位就把上一次的「已儲存」或錯誤收掉，不然它會掛在一個已經不是
	// 那次送出內容的表單上。
	function edit<T>(setter: (value: T) => void) {
		return (value: T) => {
			setter(value);
			save.reset();
		};
	}

	return (
		<form
			aria-labelledby="edit-meal-details"
			className={styles.section}
			onSubmit={(event) => {
				event.preventDefault();
				if (changes !== null) save.mutate(changes);
			}}
		>
			<h2 id="edit-meal-details">這一餐</h2>

			<label htmlFor="edit-meal-type">餐別</label>
			<select
				id="edit-meal-type"
				value={mealType}
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
				value={cost}
				onChange={(event) => edit(setCost)(event.target.value)}
			/>

			<label htmlFor="edit-meal-note">備註（選填）</label>
			<input
				id="edit-meal-note"
				type="text"
				value={note}
				onChange={(event) => edit(setNote)(event.target.value)}
			/>

			{save.isError && <p role="alert">{describeSaveError(save.error)}</p>}
			{save.isSuccess && <p role="status">已儲存</p>}
			<button
				type="submit"
				className={styles.primary}
				disabled={changes === null || save.isPending}
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
	const hasPhoto = meal.photo_path !== null;

	const removePhoto = useMutation({
		mutationFn: () =>
			apiFetch(`/api/meals/${meal.id}/photo`, { method: "DELETE" }),
		onSuccess: () => {
			setConfirming(false);
			queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			// **移除，不是失效**：失效會讓還掛著的 PhotoPreview 立刻重抓一張
			// 已經刪掉的照片（404）。這一餐重抓回來 photo_path 是 null，
			// PhotoPreview 就卸載了。
			queryClient.removeQueries({ queryKey: queryKeys.mealPhoto(meal.id) });
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
			{upload.isError && (
				<p role="alert">{describePhotoUploadError(upload.error)}</p>
			)}

			{hasPhoto &&
				(confirming ? (
					<div role="alertdialog" aria-label="確認刪除照片">
						<p>確定要刪除這張照片嗎？</p>
						<button
							type="button"
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
 *
 *  不能改時間（規格 §1.3）。 */
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
