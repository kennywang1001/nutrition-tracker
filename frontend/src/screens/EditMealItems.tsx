import {
	type QueryClient,
	useMutation,
	useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { apiFetch } from "../api/client";
import { ApiError, hasFieldError } from "../api/errors";
import { type Food, useFood } from "../api/foods";
import type { Meal } from "../api/meals";
import { queryKeys } from "../api/queries";
import { AiEstimatePanel } from "../components/AiEstimatePanel";
import { FoodPicker } from "../components/FoodPicker";
import {
	PortionQuantityFields,
	usePortionQuantity,
} from "../components/PortionQuantityFields";
import { formatMacro } from "../lib/decimal";
import { useConfirmFocus } from "../lib/use-confirm-focus";
import styles from "./EditMeal.module.css";

type MealItem = Meal["items"][number];

/** 同一時間只開一個編輯器：改某一項、確認刪某一項，或加一項。兩個同時開
 *  的話，畫面上會有兩組「份量」欄位——標籤對不上（`getByLabelText` 與螢幕
 *  閱讀器都分不清），使用者也分不清在改哪一個。刪除確認也算一個：它不能
 *  跟任何編輯器（同一列或別列）同時開著。 */
type Editor =
	| { kind: "item"; itemId: number }
	| { kind: "confirmDelete"; itemId: number }
	| { kind: "add" }
	| null;

/** 項目變了：這一餐、今天的營養素、趨勢、常吃／最近吃都跟著變（同記一餐）。
 *  餐費不受影響，不失效 `expensesAll`。
 *
 *  `updated`（PATCH／POST 的回應）直接寫進這一餐的快取，不等重抓；
 *  DELETE 回 204 沒有內容，不傳。回傳失效的 Promise：呼叫端可以回傳它，
 *  讓 mutation 到重抓完成才算結束。 */
function afterItemChange(
	queryClient: QueryClient,
	mealId: number,
	updated?: Meal | null,
) {
	if (updated != null) {
		queryClient.setQueryData(queryKeys.meal(mealId), updated);
	}
	return Promise.all(
		[
			queryKeys.meals,
			queryKeys.dailyStats,
			queryKeys.rangeStatsAll,
			queryKeys.frequentFoods,
			queryKeys.recentFoods,
		].map((queryKey) => queryClient.invalidateQueries({ queryKey })),
	);
}

function describeItemError(error: unknown): string {
	if (error instanceof ApiError) {
		if (error.code === "PORTION_FOOD_MISMATCH") {
			return "這個份量不屬於這個食物";
		}
		// 別的裝置把這一項刪掉了。
		if (error.code === "MEAL_ITEM_NOT_FOUND") {
			return "這一項已經不在了（可能在別的裝置刪掉了）";
		}
		// 搜尋到送出之間食物失去生效版本（同記一餐）：用後端的訊息。
		// 份量 × 數量換算後超出範圍：也用後端的訊息。
		if (
			error.code === "FOOD_HAS_NO_REVISION" ||
			error.code === "QUANTITY_OUT_OF_RANGE"
		) {
			return error.message;
		}
		// 限制同 MealItemCreateRequest.quantity。其他欄位的 422 走通用訊息。
		if (error.code === "VALIDATION_ERROR" && hasFieldError(error, "quantity")) {
			return "數量要大於 0、不超過 10000，最多兩位小數";
		}
	}
	return "儲存失敗，請再試一次";
}

/** 一項的份量顯示：用份量記的寫「幾份（幾 g）」，直接輸入的寫公克數。
 *
 *  單位一律寫 g：`MealItemResponse` 沒有帶食物的 `base_unit`（液體會顯示
 *  成 g——handover 已記錄的已知問題，跟飲食頁的 `MealList` 一致）。 */
function amountText(item: MealItem): string {
	const grams = `${formatMacro(item.quantity_g)} g`;
	return item.portion_id === null
		? grams
		: `${formatMacro(item.quantity)} 份（${grams}）`;
}

/** 改一項的份量或數量（`PATCH /api/meals/{id}/items/{item_id}`）。 */
function ItemEditor({
	mealId,
	item,
	onClose,
}: {
	mealId: number;
	item: MealItem;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	// 直接輸入時的單位（g 或 ml）要看食物——MealItemResponse 沒有帶。
	const foodQuery = useFood(item.food_id);
	// 初始值是這一項當初怎麼記的（不是 null）：食物後來才設的預設份量
	// 不能把「直接輸入 200 g」變成 200 碗。
	// `portion_id` 是 ON DELETE SET NULL：份量被刪掉的項目 `portion_id` 變
	// null，但 `quantity` 還是當初的份數，`quantity_g` 才是公克數。
	const portion = usePortionQuantity(item.food_id, {
		choice: item.portion_id ?? "manual",
		quantity: formatMacro(
			item.portion_id === null ? item.quantity_g : item.quantity,
		),
	});

	const save = useMutation({
		mutationFn: () =>
			apiFetch<Meal>(`/api/meals/${mealId}/items/${item.id}`, {
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					quantity: portion.quantity,
					// **一律帶 portion_id**（null＝直接輸入數量）：不帶的話後端
					// 沿用舊的份量，「從碗改回直接輸入 200」會變成 200 碗。
					portion_id: portion.portionId,
				}),
			}),
		// 只做不依賴畫面的事（快取）。「關編輯器」放在 `mutate` 的第二個參數：
		// TanStack v5 在 observer 卸載或 reset 之後會丟掉那種 callback，所以使用
		// 者在存檔還在送的時候改開別的編輯器，存好不會把那個新的關掉。
		onSuccess: (updated) => afterItemChange(queryClient, mealId, updated),
		onError: (error) => {
			if (error instanceof ApiError && error.code === "MEAL_ITEM_NOT_FOUND") {
				queryClient.invalidateQueries({ queryKey: queryKeys.meals });
			}
		},
	});

	return (
		<form
			className={styles.editor}
			aria-label={`修改${item.food_name}`}
			onSubmit={(event) => {
				event.preventDefault();
				save.mutate(undefined, { onSuccess: onClose });
			}}
		>
			<PortionQuantityFields
				state={portion}
				unit={foodQuery.data?.nutrition?.base_unit ?? "g"}
				idPrefix={`item-${item.id}-`}
			/>
			{save.isError && <p role="alert">{describeItemError(save.error)}</p>}
			<button
				type="submit"
				className={styles.primary}
				disabled={save.isPending}
			>
				{save.isPending ? "儲存中…" : "儲存"}
			</button>
			<button type="button" onClick={onClose}>
				放棄
			</button>
		</form>
	);
}

function ItemRow({
	mealId,
	item,
	editing,
	confirming,
	onEdit,
	onConfirmDelete,
	onClose,
}: {
	mealId: number;
	item: MealItem;
	editing: boolean;
	confirming: boolean;
	onEdit: () => void;
	onConfirmDelete: () => void;
	onClose: () => void;
}) {
	const queryClient = useQueryClient();
	const confirmFocus = useConfirmFocus(confirming);

	const remove = useMutation({
		mutationFn: async () => {
			try {
				await apiFetch(`/api/meals/${mealId}/items/${item.id}`, {
					method: "DELETE",
				});
			} catch (error) {
				// 別的裝置已經刪掉了：目的達成，當作成功。
				if (
					!(error instanceof ApiError && error.code === "MEAL_ITEM_NOT_FOUND")
				) {
					throw error;
				}
			}
		},
		// 回傳失效的 Promise：到重抓完成（這一列消失）之前 `isPending` 都是
		// true，確定刪除按鈕不能再按第二次。
		onSuccess: () => afterItemChange(queryClient, mealId),
	});

	return (
		<li data-testid={`meal-item-${item.id}`}>
			<span className={styles.itemName}>{item.food_name}</span>
			<span className={styles.itemMeta}>
				{amountText(item)} · {formatMacro(item.kcal)} kcal
			</span>
			{editing && <ItemEditor mealId={mealId} item={item} onClose={onClose} />}
			{!editing && !confirming && (
				<>
					{/* 名稱帶食物名：每一列都有「修改」「刪除」，只寫動詞的話
					    螢幕閱讀器（與測試）分不出是哪一項。 */}
					<button
						type="button"
						aria-label={`修改${item.food_name}`}
						onClick={onEdit}
					>
						修改
					</button>
					<button
						ref={confirmFocus.triggerRef}
						type="button"
						aria-label={`刪除${item.food_name}`}
						onClick={onConfirmDelete}
					>
						刪除
					</button>
				</>
			)}
			{confirming && (
				<div
					className={styles.confirm}
					role="alertdialog"
					aria-label={`確認刪除${item.food_name}`}
				>
					<p>確定要刪除「{item.food_name}」嗎？</p>
					<button
						type="button"
						className={styles.danger}
						disabled={remove.isPending}
						onClick={() => remove.mutate(undefined, { onSuccess: onClose })}
					>
						確定刪除
					</button>
					<button
						ref={confirmFocus.cancelRef}
						type="button"
						onClick={() => {
							confirmFocus.cancelled();
							onClose();
						}}
					>
						取消
					</button>
				</div>
			)}
			{remove.isError && <p role="alert">刪除失敗，請再試一次</p>}
		</li>
	);
}

/** 加一項（`POST /api/meals/{id}/items`）：選食物、份量、數量——跟記一餐
 *  同一組元件，搜尋框下面同樣有 AI 估算（AI 與編輯畫面的收尾規格 §2 第 1 項）。 */
function AddItem({ mealId, onClose }: { mealId: number; onClose: () => void }) {
	const queryClient = useQueryClient();
	const [food, setFood] = useState<Food | null>(null);
	const portion = usePortionQuantity(food?.id ?? null);
	// 選好食物（清單或 AI 面板交回）之後焦點移到「已選擇」那一行（同記一餐）：
	// AI 面板的「確認」跟著卡片消失，不移的話焦點掉到 body。只在選的那一次
	// 移（旗標），不是每次 render。
	const focusSelectedRef = useRef(false);
	const selectedRef = useRef<HTMLParagraphElement>(null);
	useEffect(() => {
		if (focusSelectedRef.current && selectedRef.current !== null) {
			focusSelectedRef.current = false;
			selectedRef.current.focus();
		}
	});

	const add = useMutation({
		mutationFn: (selected: Food) =>
			apiFetch<Meal>(`/api/meals/${mealId}/items`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					food_id: selected.id,
					quantity: portion.quantity,
					...(portion.portionId !== null
						? { portion_id: portion.portionId }
						: {}),
				}),
			}),
		// 關編輯器放在 `mutate` 的第二個參數，理由見 ItemEditor。
		onSuccess: (updated) => afterItemChange(queryClient, mealId, updated),
	});

	function select(selected: Food) {
		// 換食物時份量選擇由 usePortionQuantity 自己重設。
		setFood(selected);
		focusSelectedRef.current = true;
		add.reset();
	}

	return (
		<div className={styles.editor}>
			<FoodPicker
				onSelect={select}
				renderBelowSearch={(query) => (
					<AiEstimatePanel
						text={query}
						// 估算用的照片不帶：這一餐的照片由照片區處理（規格 §2 第 1 項）。
						onFoodReady={(ready) => {
							// 份量自動是一份 × 1（同記一餐）：數量不會跟著換食物歸位，
							// 先 reset，不然上一個食物打的 200 會留下來。
							portion.reset();
							select(ready);
						}}
					/>
				)}
			/>
			{food !== null && (
				<form
					className={styles.editor}
					aria-label="加一項"
					onSubmit={(event) => {
						event.preventDefault();
						add.mutate(food, { onSuccess: onClose });
					}}
				>
					<p ref={selectedRef} tabIndex={-1}>
						已選擇：{food.name}
					</p>
					<PortionQuantityFields
						state={portion}
						unit={food.nutrition?.base_unit ?? "g"}
						idPrefix="add-"
					/>
					{add.isError && <p role="alert">{describeItemError(add.error)}</p>}
					<button
						type="submit"
						className={styles.primary}
						disabled={add.isPending}
					>
						{add.isPending ? "加入中…" : "加入"}
					</button>
				</form>
			)}
			<button type="button" onClick={onClose}>
				放棄
			</button>
		</div>
	);
}

/** 編輯畫面的項目區（編輯餐點規格 §4.2 第 3 點）：每一項可以改份量／數量、
 *  刪除；最後可以加一項。每個動作各自立即送出。 */
export function EditMealItems({ meal }: { meal: Meal }) {
	const [editor, setEditor] = useState<Editor>(null);
	const close = () => setEditor(null);

	return (
		<section aria-labelledby="edit-meal-items" className={styles.section}>
			<h2 id="edit-meal-items">項目</h2>
			{meal.items.length === 0 ? (
				<p>這一餐沒有項目</p>
			) : (
				<ul className={styles.items}>
					{meal.items.map((item) => (
						<ItemRow
							key={item.id}
							mealId={meal.id}
							item={item}
							editing={editor?.kind === "item" && editor.itemId === item.id}
							confirming={
								editor?.kind === "confirmDelete" && editor.itemId === item.id
							}
							onEdit={() => setEditor({ kind: "item", itemId: item.id })}
							onConfirmDelete={() =>
								setEditor({ kind: "confirmDelete", itemId: item.id })
							}
							onClose={close}
						/>
					))}
				</ul>
			)}
			{editor?.kind === "add" ? (
				<AddItem mealId={meal.id} onClose={close} />
			) : (
				<button type="button" onClick={() => setEditor({ kind: "add" })}>
					＋ 加一項
				</button>
			)}
		</section>
	);
}
