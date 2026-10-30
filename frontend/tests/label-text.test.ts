import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LabelReadResponse } from "../src/api/ai";
import { ApiError } from "../src/api/errors";
import {
	describeLabelTextError,
	type LabelTextParse,
	parseLabelText,
} from "../src/api/label-text";
import { resetRefreshStateForTests } from "../src/auth/refresh";
import { clearTokens, setTokens } from "../src/auth/store";
import {
	describeLabelParse,
	fillFromAi,
	fillFromParse,
	hasFoundValues,
} from "../src/lib/label-text";
import { COMPLETE_PARSE, PARTIAL_PARSE } from "./helpers/label-text";
import { json, mockApi } from "./helpers/mock-api";

beforeEach(() => {
	localStorage.clear();
	clearTokens();
	resetRefreshStateForTests();
	vi.restoreAllMocks();
	setTokens({ access_token: "a", refresh_token: "r" });
});

function mockParse() {
	return mockApi([
		{
			method: "POST",
			path: "/api/foods/parse-label-text",
			handler: () => json(COMPLETE_PARSE),
		},
	]);
}

function sentBody(fetchMock: ReturnType<typeof mockApi>): { text: string } {
	const call = fetchMock.mock.calls[0];
	return JSON.parse(String(call?.[1]?.body)) as { text: string };
}

/** 同 `new-food-barcode.test.tsx` 的那一份（AI 讀的營養標示）。 */
const LABEL = {
	analysis_id: 31,
	name: "海苔洋芋片",
	nutrition: {
		base_unit: "g",
		kcal: "514.29",
		protein_g: "6.00",
		fat_g: "28.00",
		carb_g: "60.86",
	},
	serving: { amount: "35.00", unit: "g" },
	servings_per_package: "4.00",
	basis: "per_serving",
	confidence: "0.80",
	consistency: { atwater_kcal: "519.44", deviation: "5.15", flagged: false },
	remaining_today: 17,
} satisfies LabelReadResponse;

describe("營養標示文字的 API", () => {
	it("送 POST 與剛好 {text}，回後端的結果", async () => {
		const fetchMock = mockParse();

		const result = await parseLabelText("營養標示");

		const call = fetchMock.mock.calls[0];
		expect(String(call?.[0])).toBe("/api/foods/parse-label-text");
		expect(call?.[1]?.method).toBe("POST");
		expect(sentBody(fetchMock)).toEqual({ text: "營養標示" });
		expect(result).toEqual(COMPLETE_PARSE);
	});

	it("超過 4000 字的切掉再送", async () => {
		const fetchMock = mockParse();

		await parseLabelText("字".repeat(4001));

		expect(sentBody(fetchMock).text.length).toBe(4000);
	});

	it("被限速說後端那一句；送不出去說檢查網路", () => {
		expect(
			describeLabelTextError(
				new ApiError(429, "TOO_MANY_LABEL_PARSES", "讀得太頻繁了，請稍後再試"),
			),
		).toBe("讀得太頻繁了，請稍後再試");
		expect(describeLabelTextError(new TypeError("Failed to fetch"))).toBe(
			"讀不了，請檢查網路再試一次",
		);
	});
});

describe("營養標示文字的說法與填表單", () => {
	it("缺幾項：說讀到什麼（每 100）、讀不到什麼", () => {
		expect(describeLabelParse(PARTIAL_PARSE)).toBe(
			"讀到：熱量 514 kcal、蛋白質 6 g、脂肪 28 g（每 100 g）；讀不到：碳水化合物",
		);
	});

	it("缺幾項、可是讀到的都不合理（found 全是 null）：不說「讀到：」空的那一句", () => {
		// 後端真的會這樣回（審查的 three_insane_no_carb：熱量 9999、蛋白質 600、脂肪 280、沒有碳水）：
		// 讀到的三項都超過物理上限、被拿掉，原因還是 missing_fields。
		const parse: LabelTextParse = {
			...PARTIAL_PARSE,
			found: { kcal: null, protein_g: null, fat_g: null, carb_g: null },
			missing: ["kcal", "protein_g", "fat_g", "carb_g"],
			reason: "missing_fields",
		};

		expect(describeLabelParse(parse)).toBe(
			"讀到的數字不太合理（可能少了小數點）",
		);
	});

	it.each([
		["needs_serving_size", "只有每份的數字，但讀不到每一份量"],
		["columns_unknown", "看不出是每份還是每 100 的數字"],
		["implausible", "讀到的數字不太合理（可能少了小數點）"],
		["no_values", "讀不出營養標示的數字"],
	] as const)("%s：%s", (reason, sentence) => {
		const parse: LabelTextParse = {
			...PARTIAL_PARSE,
			found: { kcal: null, protein_g: null, fat_g: null, carb_g: null },
			missing: ["kcal", "protein_g", "fat_g", "carb_g"],
			reason,
		};

		expect(describeLabelParse(parse)).toBe(sentence);
	});

	it("填入讀到的：讀不到的是空字串、一份照填、沒有名稱", () => {
		expect(fillFromParse(PARTIAL_PARSE)).toEqual({
			baseUnit: "g",
			values: {
				kcal: "514.00",
				protein_g: "6.00",
				fat_g: "28.00",
				carb_g: "",
			},
			serving: "35.00",
			name: null,
		});
	});

	it("AI 讀的：名稱、單位、四個數字、一份", () => {
		expect(fillFromAi(LABEL)).toEqual({
			baseUnit: "g",
			values: {
				kcal: "514.29",
				protein_g: "6.00",
				fat_g: "28.00",
				carb_g: "60.86",
			},
			serving: "35.00",
			name: "海苔洋芋片",
		});
		expect(fillFromAi({ ...LABEL, serving: null }).serving).toBeNull();
	});

	it("有沒有讀到任何一個數字", () => {
		const none: LabelTextParse = {
			...PARTIAL_PARSE,
			found: { kcal: null, protein_g: null, fat_g: null, carb_g: null },
		};
		const one: LabelTextParse = {
			...none,
			found: { ...none.found, fat_g: "28.00" },
		};

		expect(hasFoundValues(none)).toBe(false);
		expect(hasFoundValues(one)).toBe(true);
	});
});
