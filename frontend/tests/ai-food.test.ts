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
	it("每份換算成每 100、份量用改過的重量、標記成使用者，AI 原本的仍然附上", () => {
		const result = editedFoodRequest(ESTIMATE, {
			...draftFromEstimate(ESTIMATE),
			kcal: "550",
		});

		expect(result).toEqual({
			ok: true,
			body: {
				name: "牛肉麵",
				brand: null,
				nutrition: {
					base_unit: "g",
					kcal: "100.00",
					protein_g: "5.82",
					fat_g: "3.27",
					carb_g: "14.55",
				},
				default_portion: { label: "一份", grams: "550" },
				source: "user",
				ai_confidence: "0.37",
				ai_raw_response: ESTIMATE,
			},
		});
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
