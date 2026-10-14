import { json, type Route } from "./mock-api";

export const EMPTY_PROFILE = {
	sex: null,
	birth_year: null,
	height_cm: null,
	activity_level: null,
	goal: null,
	rate_kg_per_week: null,
	target_weight_kg: null,
};

export const NOT_READY = {
	ready: false,
	missing: [
		"sex",
		"birth_year",
		"height_cm",
		"activity_level",
		"goal",
		"rate_kg_per_week",
		"weight",
	],
};

export const NO_WEIGHTS = { today: "2019-07-04", entries: [] };

/** 會畫出「我的」的新卡片或建議區塊的測試，**放在路由清單最前面**：`/api/me` 的路由用
 *  `url.includes` 比對，會吃掉 `/api/me/body-profile` 與 `/api/me/target-suggestion`。
 *  只放 GET：寫入的路由由各測試自己準備（要看 body）。 */
export function bodyRoutes(
	overrides: {
		profile?: unknown;
		suggestion?: unknown;
		weights?: unknown;
	} = {},
): Route[] {
	return [
		{
			method: "GET",
			path: "/api/me/target-suggestion",
			handler: () => json(overrides.suggestion ?? NOT_READY),
		},
		{
			method: "GET",
			path: "/api/me/body-profile",
			handler: () => json(overrides.profile ?? EMPTY_PROFILE),
		},
		{
			method: "GET",
			path: "/api/weights",
			handler: () => json(overrides.weights ?? NO_WEIGHTS),
		},
	];
}

/** 規格 §3.2 那一組（男、36 歲、175 cm、80 kg、中度、減重每週 0.5）。 */
export const READY_SUGGESTION = {
	ready: true,
	kcal: "2110",
	protein_g: "144",
	fat_g: "59",
	carb_g: "251",
	bmr: "1719",
	tdee: "2664",
	adjustment_kcal: "-550",
	floor_applied: false,
	floor_kcal: "1500",
	weight_kg: "80.00",
	based_on_date: "2026-10-10",
	applied_weight_kg: null,
	weight_change_kg: null,
	resuggest: false,
};
