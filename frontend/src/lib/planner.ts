import type { Food } from "../api/foods";
import type { PlannedCombo } from "../api/planner";

/** 交給記一餐的一樣（營養素配餐規格 D22、D23）。`portion` 不是 null 時 `quantity` 是「幾份」
 *  （送 `portion_id`）；是 null 時是直接輸入的 g／ml。`quantity` 是後端給的字串，原樣用——
 *  前端不做營養素或量的運算。 */
export type HandoffItem = {
	food: Food;
	quantity: string;
	portion: { id: number; label: string } | null;
};

export type PlannerHandoff =
	| { kind: "items"; items: HandoffItem[] }
	| { kind: "suggest" };

/** 「讓 AI 配一餐」連到記一餐時的 router state。 */
export const SUGGEST_STATE = { plannerSuggest: true } as const;

/** 「記成一餐」連到記一餐時的 router state。份量只帶 `id`、`label`：記一餐要的是送出的
 *  `portion_id` 與欄位的標籤，`grams` 是後端換算用的，帶過去沒有人讀。 */
export function itemsState(combo: PlannedCombo): {
	plannerItems: HandoffItem[];
} {
	return {
		plannerItems: combo.items.map((item) => ({
			food: item.food,
			quantity: item.quantity,
			portion:
				item.portion === null
					? null
					: { id: item.portion.id, label: item.portion.label },
		})),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function isFood(value: unknown): value is Food {
	return (
		isRecord(value) &&
		typeof value.id === "number" &&
		typeof value.name === "string" &&
		(value.nutrition === null ||
			(isRecord(value.nutrition) &&
				typeof value.nutrition.base_unit === "string"))
	);
}

function handoffItemFrom(value: unknown): HandoffItem | null {
	if (!isRecord(value) || !isFood(value.food)) return null;
	if (typeof value.quantity !== "string") return null;
	const portion = value.portion;
	if (portion === null) {
		return { food: value.food, quantity: value.quantity, portion: null };
	}
	if (
		!isRecord(portion) ||
		typeof portion.id !== "number" ||
		typeof portion.label !== "string"
	) {
		return null;
	}
	return {
		food: value.food,
		quantity: value.quantity,
		portion: { id: portion.id, label: portion.label },
	};
}

/** 記一餐收到的 router state → 交接的內容。state 是 unknown：任何頁面都可能 navigate 過來，
 *  history 裡也可能是舊版本存的形狀——不對就當作沒有（同總覽的 `noticeFrom`）。
 *  一樣不對就整個不要（不收半套：少一樣的組合就不是那一組了）。 */
export function plannerHandoffFrom(state: unknown): PlannerHandoff | null {
	if (!isRecord(state)) return null;
	if (state.plannerSuggest === true) return { kind: "suggest" };
	if (!Array.isArray(state.plannerItems) || state.plannerItems.length === 0) {
		return null;
	}
	const items: HandoffItem[] = [];
	for (const raw of state.plannerItems) {
		const item = handoffItemFrom(raw);
		if (item === null) return null;
		items.push(item);
	}
	return { kind: "items", items };
}
