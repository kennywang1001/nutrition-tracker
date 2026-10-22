import { useMutation, useQueryClient } from "@tanstack/react-query";
import {
	type ChangeEvent,
	type FormEvent,
	useEffect,
	useRef,
	useState,
} from "react";
import { useNavigate } from "react-router";
import {
	describeAnalyzeError,
	type LabelReadResponse,
	readLabel,
} from "../api/ai";
import { describeBarcodeError, updateFoodBarcode } from "../api/barcode";
import { apiFetch } from "../api/client";
import { ApiError, describeFieldErrors, hasFieldError } from "../api/errors";
import { useMe } from "../api/me";
import { MAX_PHOTO_BYTES, PhotoTooLargeError } from "../api/photos";
import { queryKeys } from "../api/queries";
import type { components } from "../api/schema";
import { AiEstimatePanel } from "../components/AiEstimatePanel";
import { OffAttribution } from "../components/BarcodeScanEntry";
import { ElapsedSeconds } from "../components/ElapsedSeconds";
import {
	focusStepAfterFileDialog,
	PhotoHintStep,
} from "../components/PhotoHintStep";
import { PhotoPickerButton } from "../components/PhotoPickerButton";
import ui from "../components/ui.module.css";
import { BARCODE_LENGTH_HINT, cleanBarcodeInput } from "../lib/barcode";
import {
	formatMacro,
	isPlainPositiveDecimal,
	perServingToPer100,
} from "../lib/decimal";
import type { NewFoodHandoff } from "../lib/new-food-handoff";
import styles from "./NewFood.module.css";

type Food = components["schemas"]["FoodResponse"];
type BaseUnit = components["schemas"]["BaseUnit"];
/** 選好、還沒送出的營養標示照片與補充說明。 */
type LabelPhoto = { file: File; hint: string };

// 匯出給 FoodDetail.tsx（提議修改，Task 5）重用——兩個表單填的都是同一個
// NutritionInput，欄位、label、上下限沒有理由各寫一份。
export const BASE_UNITS: ReadonlyArray<{ value: BaseUnit; label: string }> = [
	{ value: "g", label: "克（g）" },
	{ value: "ml", label: "毫升（ml）" },
];

export type NumericField = "kcal" | "protein_g" | "fat_g" | "carb_g";

// NutritionInput 的上下限（app/schemas/food.py）：kcal 0–10000，其餘三個
// 巨量營養素 0–1000，都是 max_digits=8, decimal_places=2。這裡只對齊
// 上下限（少一個往返），**刻意不重做 decimal_places 檢查**——後端的 422
// 仍然要能顯示，前端驗證不是拿來取代它的（規格 §5.2）。
export const NUMERIC_FIELDS: ReadonlyArray<{
	field: NumericField;
	label: string;
	max: number;
}> = [
	{ field: "kcal", label: "熱量（每 100 單位 kcal）", max: 10000 },
	{ field: "protein_g", label: "蛋白質（g）", max: 1000 },
	{ field: "fat_g", label: "脂肪（g）", max: 1000 },
	{ field: "carb_g", label: "碳水化合物（g）", max: 1000 },
];

/** 「每一份」模式的欄位標籤。**只有 NewFood 用**——`NUMERIC_FIELDS` 的
 *  標籤不能動（FoodDetail 共用、e2e 用它找欄位）。 */
const PER_SERVING_LABELS: Record<NumericField, string> = {
	kcal: "熱量（每份 kcal）",
	protein_g: "蛋白質（每份 g）",
	fat_g: "脂肪（每份 g）",
	carb_g: "碳水化合物（每份 g）",
};

/** 份量重量的後端上限（`DefaultPortionInput.grams` 的 `le=10000`）。 */
const MAX_PORTION_GRAMS = 10000;

type NutritionBasis = "per100" | "perServing";

/** 新增食物（規格 §5.2）。預設是**私人食物**——`POST /api/foods` 不帶
 *  `is_global` 時建立的是 `owner_id = user.id`，立刻生效，不用送審（送審是
 *  §5.3 對「既有的全域食物」提議修改，Task 5 的事）。
 *
 *  管理員多一個「公開到共用食物庫」的勾選（最後幾件規格 §2），預設不勾；
 *  勾了才送 `is_global: true`，不勾就不送這個欄位。一般使用者看不到它——
 *  藏起來只是可用性，授權在後端（`is_global` 只有管理員能用）。AI 面板存出
 *  的食物不受這個勾選影響（照舊私人）。
 *
 *  成功後直接導到新食物的詳情頁（`/foods/:id`，Task 5 才存在——導過去
 *  現在會是空白畫面，那是刻意的，不放佔位畫面）。用 `useNavigate` 自己做，
 *  不透過 App.tsx 的 route wrapper 傳 callback：新食物的 id 來自 mutation
 *  的回應本體，導去哪裡是這個畫面自己才知道的事，不是像 `LogMeal` 的
 *  `onSaved` 那樣「導回一個固定路徑」。 */
type Props = {
	/** 掃條碼沒命中帶來的交接（掃條碼規格 D20）：條碼、Open Food Facts 的預填、存好要回去的地方。
	 *  **只在掛載時讀**（`NewFoodRoute` 讀一次 router state 就清掉）。 */
	handoff?: NewFoodHandoff | null;
};

/** 預填「一份」時的份量名稱（掃條碼規格 D29：包裝上的一份）。 */
const SERVING_LABEL = "份";

export function NewFood({ handoff = null }: Props) {
	const navigate = useNavigate();
	const queryClient = useQueryClient();
	const prefill = handoff?.prefill ?? null;
	const returnTo = handoff?.returnTo ?? null;

	const [aiText, setAiText] = useState("");
	const [name, setName] = useState(prefill?.name ?? "");
	const [brand, setBrand] = useState(prefill?.brand ?? "");
	// 送出前才去分隔符號（cleanBarcodeInput）；輸入框裡留使用者打的樣子。
	const [barcode, setBarcode] = useState(handoff?.barcode ?? "");
	const [baseUnit, setBaseUnit] = useState<BaseUnit>(prefill?.base_unit ?? "g");
	const isAdmin = useMe().data?.role === "admin";
	const [isGlobal, setIsGlobal] = useState(false);
	const [values, setValues] = useState<Record<NumericField, string>>(
		prefill === null
			? { kcal: "", protein_g: "", fat_g: "", carb_g: "" }
			: { ...prefill.per100 },
	);

	// 「一份」（選填，食物份量規格 §4.1）。兩個要一起填。OFF 的一份（單位跟食物一樣才有，後端擋過）
	// 預填成「份」＋那個量。
	const prefillServing = prefill?.serving?.amount ?? null;
	const [portionLabel, setPortionLabel] = useState(
		prefillServing === null ? "" : SERVING_LABEL,
	);
	const [portionGrams, setPortionGrams] = useState(prefillServing ?? "");
	// 帶進來的那一份的量（OFF 或營養標示）：還是那個值時提醒「不要的話清掉」，改了就不提醒。
	const [filledServing, setFilledServing] = useState<string | null>(
		prefillServing,
	);
	const showServingHint =
		filledServing !== null &&
		portionLabel === SERVING_LABEL &&
		portionGrams === filledServing;
	const [basisChoice, setBasisChoice] = useState<NutritionBasis>("per100");
	// 重量合法與否用跟換算同一條嚴格規則（isPlainPositiveDecimal：會 trim、
	// 只收一般小數、要大於 0）。
	// isPositiveAmount 不 trim 又接受 "1e3"，會讓「 45」停用每一份、"1e3" 卻啟用
	// 它，再因為換算失敗而把錯誤怪到熱量欄位。
	const servingGramsValid = isPlainPositiveDecimal(portionGrams);
	// 實際生效的模式。重量無法換算時退回每 100（規格：不能停在無法換算的狀態），
	// 重量重新合法後回到使用者的選擇。舊的單向切換會在重量清掉又重打之後
	// 停在每 100，把每份的數字默默當成每 100 存進去。
	const basis: NutritionBasis =
		basisChoice === "perServing" && servingGramsValid ? "perServing" : "per100";

	const [clientError, setClientError] = useState<string | null>(null);
	const [conflictError, setConflictError] = useState<string | null>(null);
	const [fieldErrors, setFieldErrors] = useState<string[]>([]);

	// 送出與預覽用的「每 100」值。「每一份」模式下換算不了的欄位是 null。
	const per100: Record<NumericField, string | null> =
		basis === "per100"
			? values
			: {
					kcal: perServingToPer100(values.kcal, portionGrams),
					protein_g: perServingToPer100(values.protein_g, portionGrams),
					fat_g: perServingToPer100(values.fat_g, portionGrams),
					carb_g: perServingToPer100(values.carb_g, portionGrams),
				};
	const hasPortion = portionLabel.trim() !== "" && portionGrams.trim() !== "";

	const createFood = useMutation({
		mutationFn: async () =>
			apiFetch<Food>("/api/foods", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					name: name.trim(),
					// brand 是 str | None（app/schemas/food.py）。空字串一樣能通過
					// 後端驗證並存成 ""——「同名同品牌」的唯一約束對 "" 與 null
					// 是兩個不同的值，留空不轉成 null 的話，使用者會建出兩筆
					// 看起來一模一樣的食物（開工前查證過的事實）。
					brand: brand.trim() === "" ? null : brand.trim(),
					// 條碼（掃條碼規格 D22）：空的就不帶。validate() 已經保證有字時整理得出來；
					// 檢查碼由後端驗（D3）。
					...(barcode.trim() !== ""
						? { barcode: cleanBarcodeInput(barcode) }
						: {}),
					nutrition: {
						base_unit: baseUnit,
						// 四個數值一律以字串送出（規格 §5.1）。「每一份」模式送的是
						// 換算後的每 100 值——後端只存每 100（食物份量規格 §4.2）。
						// validate() 已經保證走到這裡時不會是 null。
						kcal: per100.kcal,
						protein_g: per100.protein_g,
						fat_g: per100.fat_g,
						carb_g: per100.carb_g,
					},
					// 只有管理員勾了才帶；勾選在載入角色之前不存在，所以一般使用者
					// 的 isGlobal 永遠是 false。
					...(isAdmin && isGlobal ? { is_global: true } : {}),
					...(hasPortion
						? {
								default_portion: {
									label: portionLabel.trim(),
									grams: portionGrams.trim(),
								},
							}
						: {}),
				}),
			}),
		onSuccess: () => {
			// 新食物要搜得到（queryKeys.foodSearchAll 的註解就是這麼說的）。
			queryClient.invalidateQueries({ queryKey: queryKeys.foodSearchAll });
		},
		onError: (caught: unknown) => {
			setConflictError(null);
			setFieldErrors([]);
			if (caught instanceof ApiError) {
				// 名稱與條碼都撞到時後端回 FOOD_EXISTS（名稱優先）；兩種都是後端那一句。
				if (caught.code === "FOOD_EXISTS" || caught.code === "BARCODE_EXISTS") {
					setConflictError(caught.message);
					return;
				}
				// 出在條碼的 422 說人話（拿掉「barcode：Value error, 」）；其他欄位照舊列出來。
				if (
					caught.code === "VALIDATION_ERROR" &&
					hasFieldError(caught, "barcode")
				) {
					setClientError(describeBarcodeError(caught));
					return;
				}
				if (caught.code === "VALIDATION_ERROR") {
					setFieldErrors(describeFieldErrors(caught));
					return;
				}
			}
			setClientError("建立失敗，請再試一次");
		},
	});

	/** 存好之後去哪裡（掃條碼規格 D20）：從記一餐（或編輯這一餐）來的回去、交出這個食物——
	 *  去與回都用 `replace`，history 裡不會多出兩個一樣的記一餐；其餘照舊到詳情頁。
	 *  手動建立與 AI 面板存好的都走這裡（同一個「存好」）。 */
	function finish(food: Food) {
		if (returnTo !== null) {
			navigate(returnTo, { replace: true, state: { pickedFood: food } });
		} else {
			navigate(`/foods/${food.id}`);
		}
	}

	// AI 面板（文字估算）自己 POST /api/foods、或交回食物庫裡現有的食物，都不知道交接來的條碼
	// （審查 M2）。交回之後補上：只補**自己的、還沒有條碼的**食物——公開的一般使用者改不了（403），
	// 已經有條碼的不蓋掉。PATCH 失敗（例如 409）照樣交出去：食物已經建好了，條碼可以在詳情頁再設。
	const attachBarcode = useMutation({
		mutationFn: ({ food, code }: { food: Food; code: string }) =>
			updateFoodBarcode(food.id, code),
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: queryKeys.foodSearchAll });
		},
	});

	function finishFromAiPanel(food: Food) {
		const code = barcode.trim() === "" ? null : cleanBarcodeInput(barcode);
		if (code === null || food.is_global || food.barcode) {
			finish(food);
			return;
		}
		// 交出去放在 mutate 的第二個參數：元件卸載之後不跑（handover §7）。
		attachBarcode.mutate(
			{ food, code },
			{ onSuccess: (updated) => finish(updated), onError: () => finish(food) },
		);
	}

	function validate(): string | null {
		if (name.trim() === "") return "請輸入名稱";
		if (barcode.trim() !== "" && cleanBarcodeInput(barcode) === null) {
			return BARCODE_LENGTH_HINT;
		}

		const labelFilled = portionLabel.trim() !== "";
		const gramsFilled = portionGrams.trim() !== "";
		if (labelFilled !== gramsFilled) return "份量名稱與重量要一起填";
		if (gramsFilled) {
			if (!servingGramsValid) return "每份重量要大於 0";
			if (Number(portionGrams) > MAX_PORTION_GRAMS) {
				return `每份重量不能超過 ${MAX_PORTION_GRAMS}`;
			}
		}

		for (const { field, label, max } of NUMERIC_FIELDS) {
			const raw = values[field];
			const shownLabel =
				basis === "perServing" ? PER_SERVING_LABELS[field] : label;
			if (raw.trim() === "") return `請輸入${shownLabel}`;
			if (basis === "perServing") {
				const converted = per100[field];
				if (converted === null) return `${shownLabel}必須是 0 以上的數字`;
				// 換算後超過上限，通常代表每份重量少打一位數。
				if (Number(converted) > max) return "換算後超過上限，請確認每份重量";
				continue;
			}
			const parsed = Number(raw);
			if (!Number.isFinite(parsed) || parsed < 0 || parsed > max) {
				return `${label}必須介於 0 到 ${max} 之間`;
			}
		}
		return null;
	}

	function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setClientError(null);
		setConflictError(null);
		setFieldErrors([]);
		const validationError = validate();
		if (validationError !== null) {
			setClientError(validationError);
			return;
		}
		// 導頁放在 mutate 的第二個參數：元件卸載之後（使用者已經離開）不跑（handover §7）。
		createFood.mutate(undefined, {
			// apiFetch<T> 回的是 T | null（204 → null），201 不會是 null，
			// 但型別上仍要 narrow——truthy 判斷，不是 === undefined。
			onSuccess: (created) => {
				if (created) finish(created);
			},
		});
	}

	// 拍營養標示（掃條碼規格 §8.5）：AI 照抄、後端換算成每 100。
	// 包一層：TanStack Query 會把 mutation 的 context 當第二個參數傳進來，直接傳 readLabel 的話
	// 那個物件會被當成補充說明。
	const readLabelMutation = useMutation({
		mutationFn: ({ file, hint }: LabelPhoto) => readLabel(file, hint),
	});
	const [labelResult, setLabelResult] = useState<LabelReadResponse | null>(
		null,
	);
	// 選好、還沒送出的營養標示照片＋補充說明（照片說明規格 §6）：按「開始讀取」才送。
	const [labelPending, setLabelPending] = useState<LabelPhoto | null>(null);
	// 選的當下就知道太大（規格 D9）：不出卡片，直接說。
	const [labelPickError, setLabelPickError] = useState<string | null>(null);
	// 讀完：「開始讀取」跟著卡片消失（焦點本來在它身上），所以移到狀態那一段（讀到的結果）。
	// 旗標只在讀完那一次移，同記一餐的「已選擇」。
	const labelResultRef = useRef<HTMLDivElement>(null);
	const focusLabelResultRef = useRef(false);
	useEffect(() => {
		if (focusLabelResultRef.current && labelResultRef.current !== null) {
			focusLabelResultRef.current = false;
			labelResultRef.current.focus();
		}
	});
	// 選了照片 → 卡片本身（不是說明欄：手機會跳鍵盤）；取消 → 照片按鈕（「取消」跟著卡片消失）。
	const labelInputRef = useRef<HTMLInputElement>(null);
	const labelStepRef = useRef<HTMLElement>(null);
	const focusLabelNextRef = useRef<"step" | "picker" | null>(null);
	useEffect(() => {
		const next = focusLabelNextRef.current;
		if (next === "step" && labelStepRef.current !== null) {
			focusLabelNextRef.current = null;
			focusStepAfterFileDialog(labelStepRef);
		} else if (next === "picker" && labelInputRef.current !== null) {
			focusLabelNextRef.current = null;
			labelInputRef.current.focus();
		}
	});

	/** 讀到的東西填進表單。**名稱是空的才填**（使用者打的字不蓋掉）；品牌、條碼不動（標示上通常
	 *  沒有品牌、條碼是掃來的）。讀到的是每 100 那一組，所以「營養標示是」切回每 100。 */
	function applyLabel(result: LabelReadResponse) {
		setName((current) =>
			current.trim() === "" ? (result.name ?? "") : current,
		);
		setBaseUnit(result.nutrition.base_unit);
		setValues({
			kcal: result.nutrition.kcal,
			protein_g: result.nutrition.protein_g,
			fat_g: result.nutrition.fat_g,
			carb_g: result.nutrition.carb_g,
		});
		setBasisChoice("per100");
		if (result.serving !== null) {
			setPortionLabel(SERVING_LABEL);
			setPortionGrams(result.serving.amount);
			setFilledServing(result.serving.amount);
		}
		setLabelResult(result);
	}

	function handleLabelPhoto(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0] ?? null;
		// 清掉：同一張照片再選一次也要觸發 change。
		event.target.value = "";
		if (file === null) return;
		// 太大在選的當下就擋（規格 D9）：不要讓人打完說明才知道白打。preparePhoto 送出前照樣再擋一次。
		if (file.size > MAX_PHOTO_BYTES) {
			setLabelPending(null);
			setLabelPickError(new PhotoTooLargeError().message);
			return;
		}
		setLabelPickError(null);
		readLabelMutation.reset();
		// 換一張照片：說明留著（多半是同一個包裝、只是拍糊了）。
		setLabelPending((current) => ({ file, hint: current?.hint ?? "" }));
		focusLabelNextRef.current = "step";
	}

	function startLabel(pending: LabelPhoto) {
		setLabelResult(null);
		// 填表單放在 mutate 的第二個參數：元件卸載之後不跑（handover §7）。
		// 失敗時卡片留著（規格 D10）：再按一次「開始讀取」就是重試。
		readLabelMutation.mutate(pending, {
			onSuccess: (result) => {
				applyLabel(result);
				setLabelPending(null);
				focusLabelResultRef.current = true;
			},
		});
	}

	return (
		<section className={ui.screen}>
			<h1>新增食物</h1>
			{/* 掃到的條碼查不到任何資料（掃條碼規格 §11）：放在「用 AI 填」上面，指出下一步。 */}
			{handoff !== null && prefill === null && (
				<p className={styles.notice}>
					找不到這個條碼的資料。拍營養標示讓 AI 讀數字，或自己填。
				</p>
			)}
			{/* 用 AI 填（AI 估算前端規格 §5.2）：跟記一餐同一個面板。存好之後跟
			    手動建立成功一樣走 finish（詳情頁，或回到記一餐）。放在表單外面——
			    面板自己的修改模式也是一個 <form>，巢狀 form 不合法。 */}
			<section aria-labelledby="new-food-ai">
				<h2 id="new-food-ai">用 AI 填</h2>
				<label htmlFor="ai-describe">描述這個食物</label>
				<input
					id="ai-describe"
					type="text"
					value={aiText}
					onChange={(event) => setAiText(event.target.value)}
				/>
				<AiEstimatePanel
					text={aiText}
					textButtonLabel={() => "估算"}
					onFoodReady={finishFromAiPanel}
				/>
				{/* 拍包裝背面的營養標示（掃條碼規格 §8.5）：要拍，所以帶 capture（掃描層的「從照片讀
				    條碼」不帶——那一顆要能選相簿）。讀到的填進下面的表單，不直接建食物。 */}
				<div className={styles.labelRow}>
					<PhotoPickerButton
						id="label-photo"
						label="拍營養標示"
						accept="image/*"
						capture="environment"
						variant="accent"
						disabled={readLabelMutation.isPending}
						inputRef={labelInputRef}
						onChange={handleLabelPhoto}
					/>
				</div>
				{labelPickError !== null && <p role="alert">{labelPickError}</p>}
				{labelPending !== null && (
					<PhotoHintStep
						file={labelPending.file}
						hint={labelPending.hint}
						onHintChange={(hint) => setLabelPending({ ...labelPending, hint })}
						startLabel="開始讀取"
						placeholder="例：這是每 100 ml、一包 2 份"
						busy={readLabelMutation.isPending}
						sectionRef={labelStepRef}
						onStart={() => startLabel(labelPending)}
						onCancel={() => {
							setLabelPending(null);
							readLabelMutation.reset();
							focusLabelNextRef.current = "picker";
						}}
					/>
				)}
				<div ref={labelResultRef} tabIndex={-1} className={styles.labelResult}>
					{/* 秒數在 role="status" 外面（規格 D11）：每秒變一次的字放進 live region，讀屏會每秒念一次。 */}
					<div className={styles.statusRow}>
						<div role="status">
							{readLabelMutation.isPending && <p>AI 讀取中…</p>}
							{labelResult !== null && !readLabelMutation.isPending && (
								<>
									<p className={styles.labelCheck}>
										AI 讀的數字，請對照包裝確認
									</p>
									{labelResult.consistency.flagged && (
										<p className={styles.warning}>
											熱量跟三大營養素算起來對不太上，請特別確認
										</p>
									)}
									{labelResult.servings_per_package !== null && (
										<p>
											本包裝含 {formatMacro(labelResult.servings_per_package)}{" "}
											份
										</p>
									)}
									<p className={styles.muted}>
										今天還能用 {labelResult.remaining_today} 次
									</p>
								</>
							)}
						</div>
						{readLabelMutation.isPending && (
							<ElapsedSeconds className={styles.muted} />
						)}
					</div>
					{readLabelMutation.isError && (
						<p role="alert">{describeAnalyzeError(readLabelMutation.error)}</p>
					)}
				</div>
			</section>
			<form onSubmit={handleSubmit}>
				{prefill !== null && (
					<div className={styles.prefilled}>
						<p>已從 Open Food Facts 帶入，請對照包裝確認</p>
						<OffAttribution />
					</div>
				)}
				<label htmlFor="food-name">名稱</label>
				<input
					id="food-name"
					type="text"
					maxLength={100}
					value={name}
					onChange={(event) => setName(event.target.value)}
					required
				/>

				<label htmlFor="food-brand">品牌（選填）</label>
				<input
					id="food-brand"
					type="text"
					maxLength={100}
					value={brand}
					onChange={(event) => setBrand(event.target.value)}
				/>

				<label htmlFor="food-barcode">條碼（選填）</label>
				<input
					id="food-barcode"
					type="text"
					inputMode="numeric"
					autoComplete="off"
					maxLength={32}
					value={barcode}
					onChange={(event) => setBarcode(event.target.value)}
				/>

				<label htmlFor="food-base-unit">單位</label>
				<select
					id="food-base-unit"
					value={baseUnit}
					onChange={(event) => setBaseUnit(event.target.value as BaseUnit)}
				>
					{BASE_UNITS.map((option) => (
						<option key={option.value} value={option.value}>
							{option.label}
						</option>
					))}
				</select>

				<fieldset>
					<legend>一份（選填）</legend>
					{showServingHint && <span>已帶入包裝上的一份，不要的話清掉</span>}
					<label htmlFor="portion-label">份量名稱</label>
					<input
						id="portion-label"
						type="text"
						maxLength={50}
						placeholder="例如：碗、片、包"
						value={portionLabel}
						onChange={(event) => setPortionLabel(event.target.value)}
					/>
					<label htmlFor="portion-grams">每份重量（{baseUnit}）</label>
					<input
						id="portion-grams"
						type="text"
						inputMode="decimal"
						value={portionGrams}
						onChange={(event) => setPortionGrams(event.target.value)}
					/>
				</fieldset>

				<fieldset>
					<legend>營養標示是</legend>
					<label>
						<input
							type="radio"
							name="nutrition-basis"
							value="per100"
							checked={basis === "per100"}
							onChange={() => setBasisChoice("per100")}
						/>
						每 100 {baseUnit}
					</label>
					<label>
						<input
							type="radio"
							name="nutrition-basis"
							value="perServing"
							checked={basis === "perServing"}
							disabled={!servingGramsValid}
							aria-describedby={servingGramsValid ? undefined : "serving-hint"}
							onChange={() => setBasisChoice("perServing")}
						/>
						每一份
					</label>
					{!servingGramsValid && <span id="serving-hint">先填每份的重量</span>}
				</fieldset>

				{NUMERIC_FIELDS.map(({ field, label }) => (
					<div key={field}>
						<label htmlFor={`food-${field}`}>
							{basis === "perServing" ? PER_SERVING_LABELS[field] : label}
						</label>
						<input
							id={`food-${field}`}
							type="text"
							inputMode="decimal"
							value={values[field]}
							onChange={(event) =>
								setValues((prev) => ({ ...prev, [field]: event.target.value }))
							}
							required
						/>
					</div>
				))}

				{basis === "perServing" && (
					<p data-testid="per100-preview">
						換算成每 100 {baseUnit}：熱量 {per100.kcal ?? "—"} kcal、蛋白質{" "}
						{per100.protein_g ?? "—"} g、脂肪 {per100.fat_g ?? "—"} g、碳水{" "}
						{per100.carb_g ?? "—"} g
					</p>
				)}

				{isAdmin && (
					<label>
						<input
							type="checkbox"
							checked={isGlobal}
							onChange={(event) => setIsGlobal(event.target.checked)}
						/>
						公開到共用食物庫（所有人都看得到）
					</label>
				)}

				{clientError !== null && <p role="alert">{clientError}</p>}
				{conflictError !== null && <p role="alert">{conflictError}</p>}
				{fieldErrors.length > 0 && (
					<ul role="alert">
						{fieldErrors.map((message, index) => (
							// biome-ignore lint/suspicious/noArrayIndexKey: 後端的欄位錯誤陣列沒有天然的唯一鍵，且同一次送出裡不會重排序。
							<li key={`${message}-${index}`}>{message}</li>
						))}
					</ul>
				)}

				<button type="submit" disabled={createFood.isPending}>
					建立食物
				</button>
				{/* 從記一餐（或編輯這一餐）來的：不建了也要回得去（規格 D20）。瀏覽器的上一頁會回到
				    記一餐**之前**的那一頁（那一筆 history 被換掉了，§14 第 3 點）。同樣 replace、不帶食物。 */}
				{returnTo !== null && (
					<button
						type="button"
						onClick={() => navigate(returnTo, { replace: true })}
					>
						{returnTo === "/meals/new"
							? "取消，回到記一餐"
							: "取消，回到這一餐"}
					</button>
				)}
			</form>
		</section>
	);
}
