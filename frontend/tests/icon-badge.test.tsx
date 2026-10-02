import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CATEGORY_COLORS } from "../src/api/expenses";
import { CategoryIcon, MealTypeIcon } from "../src/components/IconBadge";

describe("IconBadge", () => {
	it("分類圖示：圖示對螢幕閱讀器隱藏，底色是那個分類的顏色", () => {
		const { container } = render(<CategoryIcon category="transport" />);

		const svg = container.querySelector("svg");
		expect(svg).not.toBeNull();
		// 圖示旁邊一定有文字標籤；圖示本身要隱藏，不然螢幕閱讀器會念兩次
		// （或念出一個沒意義的 SVG 名稱）。
		expect(svg).toHaveAttribute("aria-hidden", "true");
		expect(container.firstElementChild).toHaveStyle({
			backgroundColor: CATEGORY_COLORS.transport,
		});
	});

	it("餐別圖示用飲食分類的顏色", () => {
		const { container } = render(<MealTypeIcon mealType="lunch" />);

		expect(container.firstElementChild).toHaveStyle({
			backgroundColor: CATEGORY_COLORS.food,
		});
	});

	it("每個分類的顏色都不一樣", () => {
		// 複製貼上一列忘了改顏色，畫面上兩個分類就分不出來——型別擋不住這個。
		const colors = Object.values(CATEGORY_COLORS);
		expect(new Set(colors).size).toBe(colors.length);
	});
});
