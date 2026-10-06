import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CATEGORY_COLORS } from "../src/api/expenses";
import { CategoryDonut } from "../src/components/CategoryDonut";

// 半徑 45 的圓周——跟 CategoryDonut 裡的常數同一個數字。測試自己算一次，
// 不 import 元件的常數：import 的話，元件把半徑改錯，測試跟著錯。
const CIRCUMFERENCE = 2 * Math.PI * 45;

function arc(category: string) {
	return screen.getByTestId(`donut-${category}`);
}

function lengthOf(category: string): number {
	return Number(arc(category).getAttribute("stroke-dasharray")?.split(" ")[0]);
}

function offsetOf(category: string): number {
	return Number(arc(category).getAttribute("stroke-dashoffset"));
}

describe("CategoryDonut", () => {
	it("每一段的長度比例等於金額比例", () => {
		render(
			<CategoryDonut
				rows={[
					{ category: "food", total: "300.00", count: 3 },
					{ category: "transport", total: "100.00", count: 1 },
				]}
				total="400.00"
			/>,
		);

		expect(lengthOf("food")).toBeCloseTo(CIRCUMFERENCE * 0.75, 5);
		expect(lengthOf("transport")).toBeCloseTo(CIRCUMFERENCE * 0.25, 5);
	});

	it("換一組金額比例也對——寫死比例的實作過不了", () => {
		render(
			<CategoryDonut
				rows={[
					{ category: "food", total: "50.00", count: 1 },
					{ category: "daily", total: "150.00", count: 2 },
				]}
				total="200.00"
			/>,
		);

		expect(lengthOf("food")).toBeCloseTo(CIRCUMFERENCE * 0.25, 5);
		expect(lengthOf("daily")).toBeCloseTo(CIRCUMFERENCE * 0.75, 5);
	});

	it("每一段接在前一段後面", () => {
		render(
			<CategoryDonut
				rows={[
					{ category: "food", total: "300.00", count: 3 },
					{ category: "transport", total: "100.00", count: 1 },
				]}
				total="400.00"
			/>,
		);

		expect(offsetOf("food")).toBeCloseTo(0, 5);
		expect(offsetOf("transport")).toBeCloseTo(-CIRCUMFERENCE * 0.75, 5);
	});

	it("只有一個分類時畫成整圈", () => {
		render(
			<CategoryDonut
				rows={[{ category: "food", total: "120.00", count: 1 }]}
				total="120.00"
			/>,
		);

		expect(lengthOf("food")).toBeCloseTo(CIRCUMFERENCE, 5);
	});

	it("每一段是那個分類的顏色", () => {
		render(
			<CategoryDonut
				rows={[{ category: "transport", total: "10.00", count: 1 }]}
				total="10.00"
			/>,
		);

		expect(arc("transport")).toHaveAttribute(
			"stroke",
			CATEGORY_COLORS.transport,
		);
	});

	it("圖是裝飾：清單已經有全部的數字，螢幕閱讀器不唸第二次", () => {
		render(
			<CategoryDonut
				rows={[{ category: "food", total: "10.00", count: 1 }]}
				total="10.00"
			/>,
		);

		expect(screen.getByTestId("category-donut")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
	});
});
