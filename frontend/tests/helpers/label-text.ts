import type { LabelTextParse } from "../../src/api/label-text";

/** `tests/fixtures/label_text/both_photo.txt` 在後端讀出來的（Task 2 的 test_a_complete_label）。 */
export const COMPLETE_PARSE: LabelTextParse = {
	complete: true,
	base_unit: "g",
	nutrition: {
		base_unit: "g",
		kcal: "514.00",
		protein_g: "6.00",
		fat_g: "28.00",
		carb_g: "60.90",
	},
	found: { kcal: "514.00", protein_g: "6.00", fat_g: "28.00", carb_g: "60.90" },
	missing: [],
	reason: null,
	serving: { amount: "35.00", unit: "g" },
	servings_per_package: "4.00",
	basis: "per_100",
	consistency: { atwater_kcal: "519.60", deviation: "5.60", flagged: false },
};

/** 碳水讀不到。 */
export const PARTIAL_PARSE: LabelTextParse = {
	...COMPLETE_PARSE,
	complete: false,
	nutrition: null,
	found: { kcal: "514.00", protein_g: "6.00", fat_g: "28.00", carb_g: null },
	missing: ["carb_g"],
	reason: "missing_fields",
	basis: null,
	consistency: null,
};
