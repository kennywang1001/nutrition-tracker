import { describe, expect, it } from "vitest";
import {
	entriesInSpan,
	movingAverage,
	recentAverage,
	weekChange,
} from "../src/lib/weights";

const e = (date: string, weight_kg: string) => ({ date, weight_kg });

describe("movingAverage（7 個日曆天，不是 7 筆）", () => {
	it("每一筆是 [這天 − 6, 這天] 之間所有紀錄的平均", () => {
		const entries = [
			e("2026-10-01", "80"),
			e("2026-10-03", "79"),
			e("2026-10-07", "78"),
			e("2026-10-08", "77"),
		];
		expect(movingAverage(entries)).toEqual([
			e("2026-10-01", "80"),
			e("2026-10-03", "79.5"),
			e("2026-10-07", "79"), // 10/01–10/07：80、79、78
			e("2026-10-08", "78"), // 10/02–10/08：79、78、77（10/01 掉出去了）
		]);
	});
	it("沒記的日子不當 0", () => {
		expect(
			movingAverage([e("2026-10-01", "80"), e("2026-10-20", "70")]),
		).toEqual([e("2026-10-01", "80"), e("2026-10-20", "70")]);
	});
});

describe("weekChange", () => {
	it("最新一筆跟「日期 ≤ 最新 − 7 天」的最新一筆比", () => {
		const entries = [
			e("2026-10-01", "81"),
			e("2026-10-06", "80.5"),
			e("2026-10-07", "80"),
			e("2026-10-14", "79"),
		];
		expect(weekChange(entries)).toEqual({
			latest: e("2026-10-14", "79"),
			since: e("2026-10-07", "80"),
			change: "-1",
		});
	});
	it("七天以前沒有紀錄就是 null；沒有紀錄也是 null", () => {
		expect(
			weekChange([e("2026-10-10", "80"), e("2026-10-14", "79")]),
		).toBeNull();
		expect(weekChange([])).toBeNull();
	});
});

describe("entriesInSpan", () => {
	const all = [
		e("2026-07-01", "82"),
		e("2026-09-20", "81"),
		e("2026-10-14", "79"),
	];
	it("30 天是 [今天 − 29, 今天]", () => {
		expect(entriesInSpan(all, "2026-10-14", 30)).toEqual({
			start: "2026-09-15",
			entries: all.slice(1),
		});
	});
	it("全部從第一筆開始；沒有紀錄時從今天開始", () => {
		expect(entriesInSpan(all, "2026-10-14", "all")).toEqual({
			start: "2026-07-01",
			entries: all,
		});
		expect(entriesInSpan([], "2026-10-14", "all")).toEqual({
			start: "2026-10-14",
			entries: [],
		});
	});
});

describe("recentAverage", () => {
	it("[今天 − 6, 今天] 的平均；沒有就是 null", () => {
		expect(
			recentAverage(
				[e("2026-10-07", "80"), e("2026-10-08", "79"), e("2026-10-14", "78")],
				"2026-10-14",
			),
		).toBe("78.5");
		expect(recentAverage([e("2026-10-01", "80")], "2026-10-14")).toBeNull();
	});
});
