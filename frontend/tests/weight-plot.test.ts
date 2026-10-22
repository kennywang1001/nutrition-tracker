import { describe, expect, it } from "vitest";
import { polylinePoints, weightScale } from "../src/lib/weight-plot";

const AREA = { left: 10, right: 110, top: 0, bottom: 40 };

describe("weightScale（首頁改版規格 D21）", () => {
	it("x 照日期：起點在左、終點在右、中間照天數比例（不是照第幾筆）", () => {
		const scale = weightScale(["80"], "1", "2026-10-01", "2026-10-11", AREA);
		if (scale === null) throw new Error("應該有比例尺");
		expect(scale.x("2026-10-01")).toBeCloseTo(10);
		expect(scale.x("2026-10-11")).toBeCloseTo(110);
		expect(scale.x("2026-10-04")).toBeCloseTo(10 + (3 / 10) * 100);
	});

	it("起點就是終點：不除以零，畫在左邊界", () => {
		const scale = weightScale(["80"], "1", "2026-10-01", "2026-10-01", AREA);
		expect(scale?.x("2026-10-01")).toBeCloseTo(10);
	});

	it("y：範圍是 paddedExtent（各往外 pad、取整），重的在上面", () => {
		const scale = weightScale(
			["78", "80"],
			"1",
			"2026-10-01",
			"2026-10-02",
			AREA,
		);
		if (scale === null) throw new Error("應該有比例尺");
		expect([scale.lo, scale.hi]).toEqual(["77", "81"]);
		expect(scale.y("81")).toBeCloseTo(0);
		expect(scale.y("77")).toBeCloseTo(40);
		expect(scale.y("80")).toBeCloseTo(40 * (1 - 3 / 4));
	});

	it("y 從 area.top 開始算（上面留白的圖，例如迷你折線）", () => {
		const scale = weightScale(["78", "80"], "1", "2026-10-01", "2026-10-02", {
			left: 0,
			right: 100,
			top: 2,
			bottom: 30,
		});
		if (scale === null) throw new Error("應該有比例尺");
		expect(scale.y("81")).toBeCloseTo(2);
		expect(scale.y("77")).toBeCloseTo(30);
	});

	it("範圍是 0（pad 0、值都一樣）：畫在正中間；沒有值是 null", () => {
		const flat = weightScale(
			["80", "80"],
			"0",
			"2026-10-01",
			"2026-10-02",
			AREA,
		);
		expect(flat?.y("80")).toBeCloseTo(20);
		expect(weightScale([], "1", "2026-10-01", "2026-10-02", AREA)).toBeNull();
	});
});

describe("polylinePoints", () => {
	it("照傳進來的順序，每一點「x,y」、空白隔開", () => {
		const scale = {
			x: (date: string) => Number(date.slice(8)),
			y: (kg: string) => Number(kg),
		};
		expect(
			polylinePoints(
				[
					{ date: "2026-10-01", weight_kg: "80" },
					{ date: "2026-10-05", weight_kg: "79.5" },
				],
				scale,
			),
		).toBe("1,80 5,79.5");
		expect(polylinePoints([], scale)).toBe("");
	});
});
