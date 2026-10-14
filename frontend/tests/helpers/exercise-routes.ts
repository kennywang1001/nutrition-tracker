import type { Activity, Exercise, ExerciseList } from "../../src/api/exercises";
import { json, type Route } from "./mock-api";

/** 測試用的活動清單：一個慢的、一個快的、「其他」（沒有 MET）。真的清單在後端（D2）。 */
export const ACTIVITY_LIST: Activity[] = [
	{ code: "walking", label: "走路", met: "3.5" },
	{ code: "running", label: "跑步（約 10 km/h）", met: "9.8" },
	{ code: "other", label: "其他", met: null },
];

/** 規格 §4.1 那一筆：跑步 30 分鐘、70 kg → 343 kcal。 */
export const RUN: Exercise = {
	id: 31,
	performed_at: "2026-10-14T10:30:00Z",
	activity: "running",
	label: "跑步（約 10 km/h）",
	name: null,
	minutes: 30,
	kcal: "343.00",
	kcal_source: "estimated",
	note: null,
	created_at: "2026-10-14T10:31:00Z",
	updated_at: "2026-10-14T10:31:00Z",
};

export const NO_EXERCISE: ExerciseList = {
	date: "2026-10-14",
	total_kcal: "0.00",
	entries: [],
};

/** 會畫出總覽或飲食頁的測試都要（`GET /api/exercises`）。**放在路由清單裡任何 `/api/exercises/…`
 *  單筆路由的後面**——`url.includes` 依序比對，這一條會吃掉單筆的。 */
export function exerciseRoutes(list: ExerciseList = NO_EXERCISE): Route[] {
	return [
		{
			method: "GET",
			path: "/api/exercise/activities",
			handler: () => json(ACTIVITY_LIST),
		},
		{ method: "GET", path: "/api/exercises", handler: () => json(list) },
	];
}
