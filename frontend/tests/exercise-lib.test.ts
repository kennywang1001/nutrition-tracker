import { describe, expect, it } from "vitest";
import type { Exercise, ExerciseInput } from "../src/api/exercises";
import { fromLocalDateTime } from "../src/lib/dates";
import {
	charCount,
	type ExerciseFormValues,
	estimateParams,
	exercisePatch,
	exerciseProblems,
	sameEstimateInputs,
} from "../src/lib/exercise";
import { RUN } from "./helpers/exercise-routes";

/** 「現在」＝裝置時區的 2026-10-14 12:00（跟表單的兩格同一套換算）。 */
const NOW = (fromLocalDateTime("2026-10-14", "12:00") as Date).getTime();

function values(
	overrides: Partial<ExerciseFormValues> = {},
): ExerciseFormValues {
	return {
		activity: "running",
		name: "",
		minutes: "30",
		manual: false,
		kcal: "",
		date: "2026-10-14",
		time: "11:30",
		note: "",
		...overrides,
	};
}

describe("charCount", () => {
	it("用 code point 算：emoji 是一個字", () => {
		expect(charCount("😀")).toBe(1);
		expect("😀".length).toBe(2);
		expect(charCount("跑步")).toBe(2);
	});
});

describe("exerciseProblems", () => {
	it("估算的、什麼都對 → 沒有問題", () => {
		expect(exerciseProblems(values(), false, NOW)).toEqual([]);
	});

	it("沒選活動", () => {
		expect(exerciseProblems(values({ activity: "" }), false, NOW)).toEqual([
			"請選活動",
		]);
	});

	it.each([
		["", "請填名稱"],
		["   ", "請填名稱"],
		["拳".repeat(51), "名稱最多 50 字"],
	])("其他的名稱 %j → %s", (name, problem) => {
		expect(
			exerciseProblems(
				values({ activity: "other", name, kcal: "200" }),
				true,
				NOW,
			),
		).toEqual([problem]);
	});

	it("其他的名稱剛好 50 字（emoji 算一個）→ 沒有問題", () => {
		expect(
			exerciseProblems(
				values({ activity: "other", name: "😀".repeat(50), kcal: "200" }),
				true,
				NOW,
			),
		).toEqual([]);
	});

	it("不是其他時，名稱不看", () => {
		expect(
			exerciseProblems(values({ name: "拳".repeat(80) }), false, NOW),
		).toEqual([]);
	});

	it.each(["", "0", "601", "1.5", "abc", "1e2"])(
		"分鐘 %j → 分鐘要是 1 到 600 的整數",
		(minutes) => {
			expect(exerciseProblems(values({ minutes }), false, NOW)).toEqual([
				"分鐘要是 1 到 600 的整數",
			]);
		},
	);

	it.each(["1", "600", " 45 "])("分鐘 %j 沒有問題", (minutes) => {
		expect(exerciseProblems(values({ minutes }), false, NOW)).toEqual([]);
	});

	it.each(["", "0", "5000.01", "5000.001", "12.345"])(
		"手動時熱量 %j → 熱量的問題",
		(kcal) => {
			expect(exerciseProblems(values({ kcal }), true, NOW)).toEqual([
				"熱量要在 1 到 5000 之間，最多兩位小數",
			]);
		},
	);

	it.each(["1", "5000", "250.5"])("手動時熱量 %j 沒有問題", (kcal) => {
		expect(exerciseProblems(values({ kcal }), true, NOW)).toEqual([]);
	});

	it("不是手動時熱量不看（空的也行）", () => {
		expect(exerciseProblems(values({ kcal: "0" }), false, NOW)).toEqual([]);
	});

	it("日期或時間不對", () => {
		expect(exerciseProblems(values({ time: "" }), false, NOW)).toEqual([
			"請選日期與時間",
		]);
		expect(
			exerciseProblems(values({ date: "2026-02-30" }), false, NOW),
		).toEqual(["請選日期與時間"]);
	});

	it("剛好是現在 → 沒有問題；晚一分鐘 → 不能選未來的時間", () => {
		expect(exerciseProblems(values({ time: "12:00" }), false, NOW)).toEqual([]);
		expect(exerciseProblems(values({ time: "12:01" }), false, NOW)).toEqual([
			"不能選未來的時間",
		]);
	});

	it("備註 200 字可以、201 字不行（前後空白不算）", () => {
		expect(
			exerciseProblems(values({ note: ` ${"記".repeat(200)} ` }), false, NOW),
		).toEqual([]);
		expect(
			exerciseProblems(values({ note: "記".repeat(201) }), false, NOW),
		).toEqual(["備註最多 200 字"]);
	});

	it("好幾個問題一起列出來", () => {
		expect(
			exerciseProblems(
				values({ activity: "", minutes: "0", time: "13:00" }),
				false,
				NOW,
			),
		).toEqual(["請選活動", "分鐘要是 1 到 600 的整數", "不能選未來的時間"]);
	});
});

describe("estimateParams", () => {
	it("估算的、什麼都對 → 參數（分鐘去掉空白、時刻是 ISO）", () => {
		expect(estimateParams(values({ minutes: " 30 " }), false, NOW)).toEqual({
			activity: "running",
			minutes: "30",
			performedAt: (
				fromLocalDateTime("2026-10-14", "11:30") as Date
			).toISOString(),
		});
	});

	it.each([
		["沒選活動", values({ activity: "" }), false],
		["其他", values({ activity: "other" }), false],
		["手動", values(), true],
		["分鐘不對", values({ minutes: "601" }), false],
		["時間不對", values({ time: "" }), false],
		["未來", values({ time: "12:01" }), false],
	] as const)("%s → null", (_why, form, manual) => {
		expect(estimateParams(form, manual, NOW)).toBeNull();
	});
});

describe("sameEstimateInputs", () => {
	const stored = {
		activity: "running",
		minutes: "30",
		date: "2026-10-14",
		time: "11:30",
	} as const;

	it("活動、分鐘、日期、時間都一樣 → true；分鐘比數字（030 等於 30）", () => {
		expect(sameEstimateInputs(values(), stored)).toBe(true);
		expect(sameEstimateInputs(values({ minutes: " 030 " }), stored)).toBe(true);
	});

	it.each([
		["活動", values({ activity: "walking" })],
		["分鐘", values({ minutes: "31" })],
		["分鐘打到一半", values({ minutes: "" })],
		["日期", values({ date: "2026-10-13" })],
		["時間", values({ time: "11:31" })],
	] as const)("%s不一樣 → false", (_why, form) => {
		expect(sameEstimateInputs(form, stored)).toBe(false);
	});
});

describe("exercisePatch（編輯只送改了的欄位，審查 I1）", () => {
	/** RUN：跑步 30 分鐘、台北 18:30、估算 343。表單送出的完整一組（估算的不帶 kcal）。 */
	function full(overrides: Partial<ExerciseInput> = {}): ExerciseInput {
		return {
			activity: "running",
			name: null,
			minutes: 30,
			performed_at: "2026-10-14T10:30:00.000Z",
			note: null,
			...overrides,
		};
	}
	const MANUAL: Exercise = { ...RUN, kcal: "250.00", kcal_source: "manual" };

	it("什麼都沒改 → 空的", () => {
		expect(exercisePatch(RUN, full())).toEqual({});
	});

	it("只改備註 → 只有備註；清掉備註 → null", () => {
		expect(exercisePatch(RUN, full({ note: "晨跑" }))).toEqual({
			note: "晨跑",
		});
		expect(exercisePatch({ ...RUN, note: "晨跑" }, full())).toEqual({
			note: null,
		});
	});

	it("時間只比到分鐘：存好的帶秒數，表單同一分鐘 → 沒改", () => {
		expect(
			exercisePatch({ ...RUN, performed_at: "2026-10-14T10:30:45Z" }, full()),
		).toEqual({});
	});

	it("改了活動、分鐘、時間：各自送出，估算的不帶 kcal（後端看值變了自己重估）", () => {
		expect(
			exercisePatch(
				RUN,
				full({
					activity: "walking",
					minutes: 60,
					performed_at: "2026-10-14T11:00:00.000Z",
				}),
			),
		).toEqual({
			activity: "walking",
			minutes: 60,
			performed_at: "2026-10-14T11:00:00.000Z",
		});
	});

	it("估算 → 手動：送熱量", () => {
		expect(exercisePatch(RUN, full({ kcal: "343" }))).toEqual({ kcal: "343" });
	});

	it("手動 → 估算：送 kcal: null", () => {
		expect(exercisePatch(MANUAL, full())).toEqual({ kcal: null });
	});

	it("手動的熱量：數字一樣（250 對 250.00）不送；改了才送", () => {
		expect(exercisePatch(MANUAL, full({ kcal: "250" }))).toEqual({});
		expect(exercisePatch(MANUAL, full({ kcal: "260.5" }))).toEqual({
			kcal: "260.5",
		});
	});

	it("其他：名稱改了才送", () => {
		const other: Exercise = {
			...MANUAL,
			activity: "other",
			name: "划船",
			label: "划船",
		};
		const same = full({ activity: "other", name: "划船", kcal: "250" });
		expect(exercisePatch(other, same)).toEqual({});
		expect(exercisePatch(other, { ...same, name: "獨木舟" })).toEqual({
			name: "獨木舟",
		});
	});
});
