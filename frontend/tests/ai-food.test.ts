import { describe, expect, it } from "vitest";
import type { AnalyzeResponse } from "../src/api/ai";
import {
	confirmedFoodRequest,
	draftFromEstimate,
	editedFoodRequest,
} from "../src/lib/ai-food";

const ESTIMATE: AnalyzeResponse = {
	analysis_id: 12,
	food_id: null,
	name: "牛肉麵",
	brand: null,
	nutrition: {
		base_unit: "g",
		serving_grams: "550.00",
		kcal: "112.73",
		protein_g: "5.82",
		fat_g: "3.27",
		carb_g: "14.55",
		serving_kcal: "620.00",
		serving_protein_g: "32.00",
		serving_fat_g: "18.00",
		serving_carb_g: "80.00",
	},
	confidence: "0.37",
	consistency: { atwater_kcal: "610.00", deviation: "10.00", flagged: false },
	remaining_today: 19,
};

describe("confirmedFoodRequest：直接確認", () => {
	it("用後端算好的每 100 值、建「一份」預設份量、標記成 AI", () => {
		expect(confirmedFoodRequest(ESTIMATE)).toEqual({
			name: "牛肉麵",
			brand: null,
			nutrition: {
				base_unit: "g",
				kcal: "112.73",
				protein_g: "5.82",
				fat_g: "3.27",
				carb_g: "14.55",
			},
			default_portion: { label: "一份", grams: "550.00" },
			source: "ai",
			ai_confidence: "0.37",
			ai_raw_response: ESTIMATE,
		});
	});
});

describe("draftFromEstimate：修改表單的初始值", () => {
	it("一份的值，去掉多餘的零", () => {
		expect(draftFromEstimate(ESTIMATE)).toEqual({
			name: "牛肉麵",
			servingGrams: "550",
			kcal: "620",
			protein_g: "32",
			fat_g: "18",
			carb_g: "80",
		});
	});
});

describe("editedFoodRequest：改過才確認", () => {
	it("每份換算成每 100、名稱與份量用使用者改的、標記成使用者，AI 原本的仍然附上", () => {
		const result = editedFoodRequest(ESTIMATE, {
			...draftFromEstimate(ESTIMATE),
			name: "自己煮的牛肉麵",
			servingGrams: "500",
			kcal: "550",
		});

		expect(result).toEqual({
			ok: true,
			body: {
				name: "自己煮的牛肉麵",
				brand: null,
				nutrition: {
					base_unit: "g",
					kcal: "110.00",
					protein_g: "6.40",
					fat_g: "3.60",
					carb_g: "16.00",
				},
				default_portion: { label: "一份", grams: "500" },
				source: "user",
				ai_confidence: "0.37",
				ai_raw_response: ESTIMATE,
			},
		});
	});

	it("base_unit 是 ml：確認與修改兩種 body 都帶 ml", () => {
		const ml: AnalyzeResponse = {
			...ESTIMATE,
			nutrition: { ...ESTIMATE.nutrition, base_unit: "ml" },
		};

		expect(confirmedFoodRequest(ml).nutrition.base_unit).toBe("ml");
		const edited = editedFoodRequest(ml, draftFromEstimate(ml));
		if (!edited.ok) throw new Error("應該通過");
		expect(edited.body.nutrition.base_unit).toBe("ml");
	});

	it("巨量營養素換算後超過 1000：擋下", () => {
		// 一份 10 g、蛋白質 200 → 每 100 是 2000。
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "10",
				kcal: "10",
				protein_g: "200",
			}),
		).toEqual({ ok: false, error: "換算後超過上限，請確認一份的重量" });
	});

	it("名稱超過 100 個字：擋下（後端的上限）", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				name: ` ${"飯".repeat(101)} `,
			}),
		).toEqual({ ok: false, error: "名稱不能超過 100 個字" });

		const ok = editedFoodRequest(ESTIMATE, {
			...draftFromEstimate(ESTIMATE),
			name: "飯".repeat(100),
		});
		expect(ok.ok).toBe(true);
	});

	it("一份重量前後空白會去掉", () => {
		const result = editedFoodRequest(ESTIMATE, {
			...draftFromEstimate(ESTIMATE),
			servingGrams: " 500 ",
		});
		if (!result.ok) throw new Error("應該通過");
		expect(result.body.default_portion?.grams).toBe("500");
	});

	it("名稱空白：擋下", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				name: "  ",
			}),
		).toEqual({ ok: false, error: "請輸入名稱" });
	});

	it("一份重量不是正數：擋下", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "0",
			}),
		).toEqual({ ok: false, error: "一份的重量要大於 0" });
	});

	it("一份重量超過 10000：擋下", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "10001",
			}),
		).toEqual({ ok: false, error: "一份的重量不能超過 10000" });
	});

	it("營養素空白：說是哪一個", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				fat_g: "",
			}),
		).toEqual({ ok: false, error: "請輸入一份的脂肪" });
	});

	it("營養素不是數字：說是哪一個", () => {
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				protein_g: "abc",
			}),
		).toEqual({ ok: false, error: "一份的蛋白質必須是 0 以上的數字" });
	});

	it("換算後超過上限：提示重量可能少打一位數", () => {
		// 一份 5 g、熱量 600 → 每 100 是 12000，超過 10000。
		expect(
			editedFoodRequest(ESTIMATE, {
				...draftFromEstimate(ESTIMATE),
				servingGrams: "5",
				kcal: "600",
			}),
		).toEqual({ ok: false, error: "換算後超過上限，請確認一份的重量" });
	});
});
