import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type ChangeEvent,
	type FormEvent,
	useEffect,
	useId,
	useRef,
	useState,
} from "react";
import {
	type AnalyzeMealResponse,
	analyzeMealImage,
	analyzeMealText,
	describeAnalyzeError,
} from "../api/ai";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors } from "../api/errors";
import { type Food, searchFoods } from "../api/foods";
import { queryKeys } from "../api/queries";
import {
	confirmedFoodRequest,
	draftFromEstimate,
	type EstimateDraft,
	editedFoodRequest,
	findSameNameFood,
} from "../lib/ai-food";
import {
	type ChecklistItem,
	initialChecklist,
	itemAmount,
	itemName,
	nameKey,
	pendingItems,
	wasRenamed,
} from "../lib/ai-meal";
import { formatMacro } from "../lib/decimal";
import base from "./AiEstimatePanel.module.css";
import styles from "./AiMealPanel.module.css";
import { EstimateDraftFields } from "./EstimateDraftFields";
import { PhotoPickerButton } from "./PhotoPickerButton";
import ui from "./ui.module.css";

type AnalyzeInput =
	| { kind: "text"; text: string }
	| { kind: "image"; file: File };

/** 交給記一餐的一樣：食物＋量（g 或 ml——直接輸入的那種，不是「幾份」）。 */
export type ReadyItem = { food: Food; quantity: string };

type Props = {
	/** 文字估算要用的字（記一餐搜尋框的字）。trim 之後是空的就只有拍照估算。 */
	text: string;
	/** 整段文字就是食物庫裡的一個食物（沒有呼叫 AI）：「用這個」交回那個食物——
	 *  跟從搜尋結果選一個一樣，由記一餐接成「已選擇」。 */
	onFoodPicked: (food: Food) => void;
	/** 「加入這 N 樣」每一輪成功的那幾樣（至少一樣才呼叫）。`image` 是估算用的照片
	 *  （文字估算是 null）、`description` 是 AI 說的那句話——記一餐拿去當這一餐的
	 *  照片與描述，已經有就不覆蓋（AI 多樣估算規格 D20）。 */
	onItemsReady: (
		items: ReadyItem[],
		source: { image: File | null; description: string },
	) => void;
};

/** 同名檢查搜尋的筆數（同 `AiEstimatePanel`：用後端的上限）。 */
const SAME_NAME_SEARCH_LIMIT = 200;

/** 改過名稱的那一樣，跟看得到的某個食物同名：停下來問使用者。 */
class SameNameError extends Error {
	readonly food: Food;

	constructor(food: Food) {
		super("食物庫裡已經有同名的食物");
		this.food = food;
	}
}

/** 一樣 → 一個可以記的食物。**依序**的五種來源（規格 §6.2「加入」）：
 *  使用者在衝突時選的那一筆、食物庫同名的那一筆、這一輪剛建好的同名食物、
 *  （改過名稱的先查同名）、新建一個。
 *
 *  `createdThisRound`：這一輪**建出來**的食物，照名稱記。只有「要建食物」的那幾樣
 *  會查它、會寫它——同一輪兩樣同名都要建時，第二樣沿用第一樣剛建好的（再建一次
 *  會撞 409 FOOD_EXISTS）。**用食物庫的那一樣不經過它**：同名只是名稱一樣，「用食物庫
 *  的」與「改用 AI 的數字」是一樣一樣選的，不能因為同名就互相沿用（審查 M4）。 */
async function resolveFood(
	item: ChecklistItem,
	createdThisRound: Map<string, Food>,
): Promise<Food> {
	const foodId =
		item.pickedFoodId ??
		(item.draft === null ? (item.library?.food_id ?? null) : null);
	if (foodId !== null) {
		const food = await apiFetch<Food>(`/api/foods/${foodId}`);
		if (food === null) throw new Error("讀取食物沒有回傳結果");
		return food;
	}

	let body = confirmedFoodRequest(item.estimate);
	if (item.draft !== null) {
		// 「套用」的時候驗過了；這裡再驗一次是為了拿到換算好的 body。
		const edited = editedFoodRequest(item.estimate, item.draft);
		if (!edited.ok) throw new Error(edited.error);
		body = edited.body;
	}

	// 鍵是**真的要送出去的名稱**。在查同名之前：改名成這一輪剛建好的那個名稱時，
	// 查同名會查到它自己——那不是「食物庫裡已經有」，不用停下來問。
	const createdKey = nameKey(body.name);
	const alreadyCreated = createdThisRound.get(createdKey);
	if (alreadyCreated !== undefined) return alreadyCreated;

	if (wasRenamed(item) && !item.skipSameNameCheck) {
		let match: Food | null = null;
		try {
			match = findSameNameFood(
				await searchFoods(body.name, "all", SAME_NAME_SEARCH_LIMIT),
				body.name,
			);
		} catch {
			// 同名檢查只是提醒：查不到（多半是暫時的）不擋使用者存（同單樣面板）。
		}
		if (match !== null) throw new SameNameError(match);
	}

	const created = await apiFetch<Food>("/api/foods", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});
	if (created === null) throw new Error("建立食物沒有回傳結果");
	createdThisRound.set(createdKey, created);
	return created;
}

/** 這一樣為什麼沒加進去：要使用者決定的（衝突），或一句錯誤。 */
function failureOf(
	item: ChecklistItem,
	error: unknown,
): Partial<ChecklistItem> {
	if (error instanceof SameNameError) {
		return {
			error: null,
			conflict: {
				source: "library",
				foodId: error.food.id,
				name: error.food.name,
			},
		};
	}
	if (error instanceof ApiError && error.code === "FOOD_EXISTS") {
		const foodId = error.details.food_id;
		if (typeof foodId === "number") {
			return {
				error: null,
				conflict: { source: "own", foodId, name: itemName(item) },
			};
		}
		return { error: error.message, conflict: null };
	}
	if (error instanceof ApiError && error.code === "VALIDATION_ERROR") {
		return { error: describeFieldErrors(error).join("；"), conflict: null };
	}
	const reading =
		item.pickedFoodId !== null ||
		(item.library !== null && item.draft === null);
	return {
		error: reading ? "讀取食物失敗，請再試一次" : "存成食物失敗，請再試一次",
		conflict: null,
	};
}

/** 記一餐的 AI 入口（AI 多樣估算規格 §6.2）：文字或照片 → 一句描述＋這一餐的每一樣，
 *  勾選、必要時修改，「加入這 N 樣」把每一樣變成食物並交回給記一餐。
 *
 *  **跟 `AiEstimatePanel` 的分工**：那個是「估一樣、存成一個食物」（新增食物、
 *  編輯這一餐的加一項）；這個是「估一餐」。兩者共用錯誤訊息（`describeAnalyzeError`）、
 *  修改表單的欄位（`EstimateDraftFields`）、存食物的內容（`lib/ai-food.ts`）與外觀
 *  （`AiEstimatePanel.module.css`）。
 *
 *  **什麼都還沒存成餐**：這裡只建食物（或拿食物庫的）。餐由記一餐的「記錄」存。
 *
 *  **不顯示 `confidence`**（同單樣面板）：那是模型自己說的。 */
export function AiMealPanel({ text, onFoodPicked, onItemsReady }: Props) {
	const queryClient = useQueryClient();
	const id = useId();
	const trimmed = text.trim();

	const [result, setResult] = useState<AnalyzeMealResponse | null>(null);
	// 估算用的照片——加入之後跟食物一起交回。
	const [image, setImage] = useState<File | null>(null);
	const [items, setItems] = useState<ChecklistItem[]>([]);
	// 正在修改哪一樣（一次只開一個）。草稿「套用」之後才寫回那一樣。
	const [editing, setEditing] = useState<{
		key: number;
		draft: EstimateDraft;
		error: string | null;
	} | null>(null);
	const [adding, setAdding] = useState(false);
	// 一輪加入之後的結果（有沒成功的才寫）。
	const [summary, setSummary] = useState("");
	// 這一次畫面上已經知道 AI 沒設定：只停用拍照（文字仍可按——命中食物庫不用 AI）。
	const [aiUnavailable, setAiUnavailable] = useState(false);

	// 同一時間只跑一輪「加入」。平常 React 在兩次點擊之間就會重畫，下面按鈕的
	// `adding` 檢查擋得住；這個 ref 是**不靠重畫時機**的那一半——同一批更新裡進來的
	// 第二次呼叫（看到的 `adding` 還是舊的）、以及衝突按鈕直接呼叫 `addItems`。
	const runningRef = useRef(false);
	// 卸載之後不再碰 state、不再交回食物（使用者已經離開記一餐）。
	const mountedRef = useRef(true);
	useEffect(() => {
		mountedRef.current = true;
		return () => {
			mountedRef.current = false;
		};
	}, []);

	// 修改表單 ↔ 那一列的按鈕切換時，按下去的那顆按鈕會消失、焦點掉到 body。
	// 開表單 → 焦點到「食物名稱」；關表單（或「改用 AI 的數字」）→ 焦點到那一列的
	// 「修改」。只在切換那一次移（旗標），不是每次 render——剛估算完不搶焦點。
	const focusNextRef = useRef<"form" | { editButton: number } | null>(null);
	const nameInputRef = useRef<HTMLInputElement>(null);
	const editButtonsRef = useRef(new Map<number, HTMLButtonElement>());
	useEffect(() => {
		const next = focusNextRef.current;
		if (next === null) return;
		const target =
			next === "form"
				? nameInputRef.current
				: (editButtonsRef.current.get(next.editButton) ?? null);
		if (target !== null) {
			focusNextRef.current = null;
			target.focus();
		}
	});

	const pickExisting = useMutation({
		mutationFn: (foodId: number) => apiFetch<Food>(`/api/foods/${foodId}`),
	});

	function clearResult() {
		setResult(null);
		setImage(null);
		setItems([]);
		setEditing(null);
		setSummary("");
		pickExisting.reset();
	}

	const analyze = useMutation({
		mutationFn: (input: AnalyzeInput) =>
			input.kind === "text"
				? analyzeMealText(input.text)
				: analyzeMealImage(input.file),
		onMutate: () => clearResult(),
		onSuccess: (response, input) => {
			setResult(response);
			setItems(initialChecklist(response));
			setImage(input.kind === "image" ? input.file : null);
		},
		onError: (error) => {
			if (error instanceof ApiError && error.code === "AI_NOT_CONFIGURED") {
				setAiUnavailable(true);
			}
		},
	});

	const busy = analyze.isPending || pickExisting.isPending || adding;

	function close() {
		clearResult();
		analyze.reset();
	}

	function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：同一張再選一次，change 才會再觸發。
		event.target.value = "";
		if (file === undefined) return;
		analyze.mutate({ kind: "image", file });
	}

	/** 改一樣的狀態。回傳新的清單——要接著用它跑「加入」的呼叫端不能等 state 更新。 */
	function update(key: number, patch: Partial<ChecklistItem>): ChecklistItem[] {
		const next = items.map((item) =>
			item.key === key ? { ...item, ...patch } : item,
		);
		setItems(next);
		return next;
	}

	/** 把 `list` 裡勾著、還沒加入的每一樣（`only` 有給就只做那一樣）**依序**變成食物。
	 *
	 *  依序而不是同時：同一輪兩樣同名都要建時，第二樣直接用第一樣剛建好的食物
	 *  （`createdThisRound`，見 `resolveFood`），不會自己撞 409。成功的標成
	 *  `added`——之後任何一輪都不會再碰它。 */
	async function addItems(list: ChecklistItem[], only?: number) {
		if (runningRef.current || result === null) return;
		const targets = pendingItems(list).filter(
			(item) => only === undefined || item.key === only,
		);
		if (targets.length === 0) return;
		runningRef.current = true;
		setAdding(true);
		setSummary("");
		// 開著沒套用的修改表單收起來：這一輪用的是清單上顯示的那一組。
		setEditing(null);
		const source = { image, description: result.description };

		const createdThisRound = new Map<string, Food>();
		const ready: ReadyItem[] = [];
		const outcomes = new Map<number, Partial<ChecklistItem>>();
		for (const item of targets) {
			// 使用者已經離開記一餐：還沒輪到的就不做了（審查 M3）。少了這一行，迴圈會
			// 把剩下的每一樣都建成食物——交回已經被下面那一行擋住，建出來的就是一個個
			// 沒有人要的私人食物。已經送出去的那一個請求收不回來，所以是每一輪開頭看。
			if (!mountedRef.current) break;
			try {
				const food = await resolveFood(item, createdThisRound);
				ready.push({ food, quantity: itemAmount(item).quantity });
				outcomes.set(item.key, { added: true, error: null, conflict: null });
			} catch (error) {
				outcomes.set(item.key, failureOf(item, error));
			}
		}

		runningRef.current = false;
		if (!mountedRef.current) return;
		setAdding(false);
		const next = list.map((item) => ({ ...item, ...outcomes.get(item.key) }));
		if (ready.length > 0) {
			// 新食物要出現在食物庫與之後的搜尋裡。
			queryClient.invalidateQueries({ queryKey: queryKeys.foodSearchAll });
			onItemsReady(ready, source);
		}
		if (pendingItems(next).length === 0) {
			// 勾著的都加入了：收起（沒勾的那幾樣是使用者不要的）。
			close();
			return;
		}
		setItems(next);
		const failed = targets.length - ready.length;
		if (failed > 0) {
			setSummary(`已加入 ${ready.length} 樣，${failed} 樣沒有成功`);
		}
	}

	function startEditing(item: ChecklistItem) {
		setEditing({
			key: item.key,
			draft: item.draft ?? draftFromEstimate(item.estimate),
			error: null,
		});
		focusNextRef.current = "form";
	}

	function stopEditing(key: number) {
		setEditing(null);
		focusNextRef.current = { editButton: key };
	}

	function applyDraft(event: FormEvent, item: ChecklistItem) {
		event.preventDefault();
		if (editing === null) return;
		const checked = editedFoodRequest(item.estimate, editing.draft);
		if (!checked.ok) {
			setEditing({ ...editing, error: checked.error });
			return;
		}
		// 改過就不是剛才問的那一樣了：衝突、錯誤、之前的選擇都清掉。
		update(item.key, {
			draft: editing.draft,
			error: null,
			conflict: null,
			pickedFoodId: null,
			skipSameNameCheck: false,
		});
		stopEditing(item.key);
	}

	const libraryHit =
		result !== null && result.analysis_id === null
			? result.items[0]
			: undefined;
	const count = pendingItems(items).length;

	return (
		<div className={base.panel}>
			<div className={base.entry}>
				{trimmed !== "" && (
					<button
						type="button"
						className={base.aiButton}
						disabled={busy}
						onClick={() => analyze.mutate({ kind: "text", text: trimmed })}
					>
						{`用 AI 估算「${trimmed}」`}
					</button>
				)}
				<PhotoPickerButton
					id={`${id}-photo`}
					label="拍照估算"
					accept="image/*"
					variant="accent"
					disabled={busy || aiUnavailable}
					onChange={handlePhoto}
				/>
			</div>

			{/* 一直掛著、只換文字：動態插入的 live region 常被讀屏軟體略過。 */}
			<p role="status" className={styles.status}>
				{analyze.isPending ? "AI 估算中…" : adding ? "加入中…" : summary}
			</p>
			{analyze.isError && (
				<p role="alert" className={styles.error}>
					{describeAnalyzeError(analyze.error)}
				</p>
			)}

			{libraryHit !== undefined && (
				<section aria-label="食物庫裡的食物" className={base.card}>
					<p>食物庫裡已經有「{libraryHit.name}」</p>
					<p className={base.muted}>
						{`每 100 ${libraryHit.nutrition.base_unit}：${formatMacro(libraryHit.nutrition.kcal)} kcal`}
					</p>
					<div className={base.actions}>
						<button
							type="button"
							className={base.primary}
							disabled={busy}
							onClick={() => {
								const foodId = libraryHit.library_food?.food_id;
								if (foodId === undefined) return;
								// 交回放在這一次呼叫的 onSuccess：卸載之後不會跑（TanStack v5）。
								pickExisting.mutate(foodId, {
									onSuccess: (food) => {
										if (!food) return;
										close();
										onFoodPicked(food);
									},
								});
							}}
						>
							用這個
						</button>
					</div>
					{pickExisting.isError && <p role="alert">讀取食物失敗，請再試一次</p>}
				</section>
			)}

			{result !== null && result.analysis_id !== null && (
				<section aria-label="AI 估算結果" className={base.card}>
					<p className={styles.description}>{result.description}</p>
					<p className={base.muted}>
						{`今天還能用 ${result.remaining_today} 次`}
					</p>
					<ul className={styles.items}>
						{items.map((item) => {
							const name = itemName(item);
							const amount = itemAmount(item);
							const usingLibrary = item.library !== null && item.draft === null;
							const isEditing = editing?.key === item.key;
							const conflict = item.conflict;
							return (
								<li key={item.key} className={styles.item}>
									<label className={styles.check}>
										<input
											type="checkbox"
											checked={item.checked}
											disabled={item.added || adding}
											onChange={(event) =>
												update(item.key, { checked: event.target.checked })
											}
										/>
										{/* 中間的空白是可及名稱的一部分：沒有它，讀屏念成「白飯200 g」。 */}
										<span className={styles.name}>{name}</span>{" "}
										<span className={base.muted}>
											{`${amount.quantity} ${amount.unit} · ${amount.kcal} kcal`}
										</span>
									</label>
									{item.added && <span className={ui.tag}>已加入</span>}
									{!item.added && usingLibrary && (
										<span className={ui.tag}>用食物庫的</span>
									)}
									{!item.added && !isEditing && conflict === null && (
										<div className={styles.rowActions}>
											{usingLibrary ? (
												<button
													type="button"
													className={base.secondary}
													disabled={adding}
													aria-label={`${name}：改用 AI 的數字`}
													onClick={() => {
														update(item.key, { library: null });
														// 這顆按鈕會被「修改」換掉：焦點移過去。
														focusNextRef.current = { editButton: item.key };
													}}
												>
													改用 AI 的數字
												</button>
											) : (
												<button
													ref={(node) => {
														if (node === null) {
															editButtonsRef.current.delete(item.key);
														} else {
															editButtonsRef.current.set(item.key, node);
														}
													}}
													type="button"
													className={base.secondary}
													disabled={adding}
													aria-label={`修改 ${name}`}
													onClick={() => startEditing(item)}
												>
													修改
												</button>
											)}
										</div>
									)}
									{/* 放在那一列的按鈕後面：提示佔一整行，放前面的話「修改」會被擠到
									    下一行的左邊，跟其他列的位置不一樣。 */}
									{!item.added &&
										!usingLibrary &&
										item.draft === null &&
										item.estimate.consistency.flagged && (
											<p className={base.warning}>
												⚠ 熱量跟三大營養素對不太起來，建議看一眼
											</p>
										)}
									{item.error !== null && <p role="alert">{item.error}</p>}
									{conflict !== null && !isEditing && (
										<div className={styles.conflict}>
											<p role="alert">
												{conflict.source === "own"
													? `你已經有「${conflict.name}」了`
													: `食物庫裡已經有「${conflict.name}」`}
											</p>
											<div className={base.actions}>
												<button
													type="button"
													className={base.primary}
													disabled={adding}
													onClick={() =>
														void addItems(
															update(item.key, {
																pickedFoodId: conflict.foodId,
																conflict: null,
															}),
															item.key,
														)
													}
												>
													{conflict.source === "own"
														? "用現有的"
														: "用食物庫的"}
												</button>
												{conflict.source === "own" ? (
													<button
														type="button"
														className={base.secondary}
														disabled={adding}
														onClick={() => startEditing(item)}
													>
														改名
													</button>
												) : (
													<button
														type="button"
														className={base.secondary}
														disabled={adding}
														onClick={() =>
															void addItems(
																update(item.key, {
																	skipSameNameCheck: true,
																	conflict: null,
																}),
																item.key,
															)
														}
													>
														還是建一個
													</button>
												)}
											</div>
										</div>
									)}
									{isEditing && editing !== null && (
										<form
											aria-label={`修改 ${name}`}
											className={`${base.form} ${styles.editForm}`}
											onSubmit={(event) => applyDraft(event, item)}
										>
											<EstimateDraftFields
												idPrefix={id}
												unit={item.estimate.nutrition.base_unit}
												draft={editing.draft}
												nameInputRef={nameInputRef}
												onChange={(patch) =>
													setEditing({
														...editing,
														draft: { ...editing.draft, ...patch },
														error: null,
													})
												}
											/>
											{editing.error !== null && (
												<p role="alert">{editing.error}</p>
											)}
											<div className={base.actions}>
												<button type="submit" className={base.primary}>
													套用
												</button>
												<button
													type="button"
													className={base.secondary}
													onClick={() => stopEditing(item.key)}
												>
													放棄修改
												</button>
											</div>
										</form>
									)}
								</li>
							);
						})}
					</ul>
					<div className={`${base.actions} ${styles.footer}`}>
						{/* aria-disabled 而不是原生 disabled：按下去的當下它正在焦點上，
						    原生停用會讓它把焦點弄丟（同 ExportCard、報表的月份切換）。 */}
						<button
							type="button"
							className={`${base.primary} ${styles.add}`}
							aria-disabled={adding || count === 0}
							onClick={() => {
								if (adding || count === 0) return;
								void addItems(items);
							}}
						>
							{adding ? "加入中…" : `加入這 ${count} 樣`}
						</button>
						<button
							type="button"
							className={base.secondary}
							disabled={adding}
							onClick={close}
						>
							收起
						</button>
					</div>
				</section>
			)}
		</div>
	);
}
