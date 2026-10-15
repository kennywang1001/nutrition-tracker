import { describe, expect, it } from "vitest";
import {
	itemsState,
	plannerHandoffFrom,
	SUGGEST_STATE,
} from "../src/lib/planner";
import { CHICKEN, OK_SUGGESTIONS, RICE } from "./helpers/planner-routes";

const FIRST = OK_SUGGESTIONS.combos[0];
if (FIRST === undefined) throw new Error("OK_SUGGESTIONS 至少要有一組");

const EXPECTED_ITEMS = [
	{ food: CHICKEN, quantity: "175", portion: null },
	{ food: RICE, quantity: "1.5", portion: { id: 9, label: "1 碗" } },
];

describe("itemsState（「記成一餐」帶的 router state）", () => {
	it("每一樣只留食物、量（後端給的字串）與份量的 id、label", () => {
		// `toStrictEqual`：份量多帶了 `grams`、多帶了 `quantity_g` 或 `nutrition` 都會紅。
		expect(itemsState(FIRST)).toStrictEqual({ plannerItems: EXPECTED_ITEMS });
	});
});

describe("plannerHandoffFrom（記一餐讀 router state）", () => {
	it("「記成一餐」的 state → 那幾樣", () => {
		expect(plannerHandoffFrom(itemsState(FIRST))).toStrictEqual({
			kind: "items",
			items: EXPECTED_ITEMS,
		});
	});

	it("經過 history（結構化複製）之後一樣讀得出來", () => {
		const copied: unknown = structuredClone(itemsState(FIRST));
		expect(plannerHandoffFrom(copied)).toStrictEqual({
			kind: "items",
			items: EXPECTED_ITEMS,
		});
	});

	it("「讓 AI 配一餐」的 state → suggest", () => {
		expect(plannerHandoffFrom(SUGGEST_STATE)).toStrictEqual({
			kind: "suggest",
		});
	});

	const chickenItem = { food: CHICKEN, quantity: "175", portion: null };
	it.each<[string, unknown]>([
		["undefined", undefined],
		["null", null],
		["字串", "x"],
		["空物件", {}],
		["總覽的通知", { notice: "照片沒有傳上去" }],
		["空的清單", { plannerItems: [] }],
		["清單不是陣列", { plannerItems: "x" }],
		["量是數字", { plannerItems: [{ ...chickenItem, quantity: 175 }] }],
		[
			"食物的 id 是字串",
			{ plannerItems: [{ ...chickenItem, food: { ...CHICKEN, id: "1" } }] },
		],
		[
			"份量的 id 是字串",
			{
				plannerItems: [{ ...chickenItem, portion: { id: "9", label: "1 碗" } }],
			},
		],
		[
			"營養素是字串",
			{
				plannerItems: [
					{ ...chickenItem, food: { ...CHICKEN, nutrition: "x" } },
				],
			},
		],
		[
			"一樣對、一樣不對（不收半套）",
			{ plannerItems: [chickenItem, { ...chickenItem, quantity: 1 }] },
		],
		["plannerSuggest 不是 true", { plannerSuggest: "yes" }],
	])("不像交接的一律 null：%s", (_name, state) => {
		expect(plannerHandoffFrom(state)).toBeNull();
	});
});
