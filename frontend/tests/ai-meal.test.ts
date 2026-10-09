import { describe, expect, it } from "vitest";
import type { AnalyzeMealResponse } from "../src/api/ai";
import {
	initialChecklist,
	itemAmount,
	itemName,
	nameKey,
	pendingItems,
	toEstimate,
	wasRenamed,
} from "../src/lib/ai-meal";

// 白飯：食物庫有同名的（熱量跟 AI 的不同：260 對 280）。滷雞腿：沒有。
const RESULT: AnalyzeMealResponse = {
	analysis_id: 41,
	description: "一碗白飯、滷雞腿一隻",
	remaining_today: 18,
	items: [
		{
			name: "白飯",
			brand: null,
			nutrition: {
				base_unit: "g",
				serving_grams: "200.00",
				kcal: "140.00",
				protein_g: "2.50",
				fat_g: "0.25",
				carb_g: "31.00",
				serving_kcal: "280.00",
				serving_protein_g: "5.00",
				serving_fat_g: "0.50",
				serving_carb_g: "62.00",
			},
			confidence: "0.80",
			consistency: {
				atwater_kcal: "272.50",
				deviation: "7.50",
				flagged: false,
			},
			library_food: {
				food_id: 7,
				name: "白飯（食物庫）",
				base_unit: "ml",
				serving_kcal: "260.00",
			},
		},
		{
			name: "滷雞腿",
			brand: "阿嬤的店",
			nutrition: {
				base_unit: "g",
				serving_grams: "150.00",
				kcal: "200.00",
				protein_g: "18.00",
				fat_g: "13.33",
				carb_g: "2.00",
				serving_kcal: "300.00",
				serving_protein_g: "27.00",
				serving_fat_g: "20.00",
				serving_carb_g: "3.00",
			},
			confidence: "0.60",
			consistency: {
				atwater_kcal: "300.00",
				deviation: "0.00",
				flagged: false,
			},
			library_food: null,
		},
	],
};

const DRAFT = {
	name: " 烤雞腿 ",
	servingGrams: " 180 ",
	kcal: " 333 ",
	protein_g: "30",
	fat_g: "22",
	carb_g: "1",
};

describe("AI 多樣估算的清單", () => {
	it("toEstimate：一樣＋外層的 analysis_id／remaining_today 拼成單樣流程認得的形狀", () => {
		const [rice, chicken] = RESULT.items;
		if (rice === undefined || chicken === undefined) {
			throw new Error("測試資料要有兩樣");
		}

		expect(toEstimate(RESULT, chicken)).toEqual({
			analysis_id: 41,
			food_id: null,
			name: "滷雞腿",
			brand: "阿嬤的店",
			nutrition: chicken.nutrition,
			confidence: "0.60",
			consistency: chicken.consistency,
			remaining_today: 18,
		});
		// 食物庫有同名的那一樣也一樣是 null：食物庫的那一筆放在清單項目的 `library`，
		// 不混進這個物件（它會被整個存成食物的 `ai_raw_response`）。只看滷雞腿的話，
		// 把 `library_food.food_id` 抄進來也看不出來——它本來就沒有。
		expect(toEstimate(RESULT, rice).food_id).toBeNull();
	});

	it("initialChecklist：每一樣預設勾著，食物庫同名的帶著那一筆，其餘都是空的", () => {
		const items = initialChecklist(RESULT);

		expect(items.map((item) => item.key)).toEqual([0, 1]);
		expect(items.map((item) => item.checked)).toEqual([true, true]);
		expect(items.map((item) => item.library?.food_id ?? null)).toEqual([
			7,
			null,
		]);
		for (const item of items) {
			expect(item).toMatchObject({
				draft: null,
				pickedFoodId: null,
				skipSameNameCheck: false,
				added: false,
				error: null,
				conflict: null,
			});
		}
		expect(items[1]?.estimate.name).toBe("滷雞腿");
	});

	it("用食物庫的：名稱、單位、熱量都是食物庫那一筆的；量是 AI 估的", () => {
		const [rice] = initialChecklist(RESULT);
		if (rice === undefined) throw new Error("測試資料要有兩樣");

		expect(itemName(rice)).toBe("白飯（食物庫）");
		expect(itemAmount(rice)).toEqual({
			quantity: "200",
			unit: "ml",
			kcal: "260",
		});
	});

	it("改用 AI 的數字（library 是 null）：名稱、單位、熱量都是 AI 的", () => {
		const [rice] = initialChecklist(RESULT);
		if (rice === undefined) throw new Error("測試資料要有兩樣");

		const ai = { ...rice, library: null };

		expect(itemName(ai)).toBe("白飯");
		expect(itemAmount(ai)).toEqual({ quantity: "200", unit: "g", kcal: "280" });
	});

	it("改過的：名稱、量、熱量都是草稿的（去掉頭尾空白）", () => {
		const [, chicken] = initialChecklist(RESULT);
		if (chicken === undefined) throw new Error("測試資料要有兩樣");

		const edited = { ...chicken, draft: DRAFT };

		expect(itemName(edited)).toBe("烤雞腿");
		expect(itemAmount(edited)).toEqual({
			quantity: "180",
			unit: "g",
			kcal: "333",
		});
	});

	it("pendingItems：勾著而且還沒加入的", () => {
		const [rice, chicken] = initialChecklist(RESULT);
		if (rice === undefined || chicken === undefined) {
			throw new Error("測試資料要有兩樣");
		}

		expect(pendingItems([rice, chicken]).map((item) => item.key)).toEqual([
			0, 1,
		]);
		expect(
			pendingItems([{ ...rice, checked: false }, chicken]).map(
				(item) => item.key,
			),
		).toEqual([1]);
		expect(
			pendingItems([{ ...rice, added: true }, chicken]).map((item) => item.key),
		).toEqual([1]);
		expect(
			pendingItems([
				{ ...rice, added: true },
				{ ...chicken, checked: false },
			]),
		).toEqual([]);
	});

	it("wasRenamed：只有草稿的名稱跟 AI 的不同才算（去頭尾空白、不分大小寫）", () => {
		const [, chicken] = initialChecklist(RESULT);
		if (chicken === undefined) throw new Error("測試資料要有兩樣");

		expect(wasRenamed(chicken)).toBe(false);
		expect(wasRenamed({ ...chicken, draft: DRAFT })).toBe(true);
		expect(
			wasRenamed({ ...chicken, draft: { ...DRAFT, name: " 滷雞腿 " } }),
		).toBe(false);
		expect(nameKey("  Latte ")).toBe("latte");
	});
});
