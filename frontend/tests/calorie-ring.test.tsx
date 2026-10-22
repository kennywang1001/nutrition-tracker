import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CalorieRing, ringDasharray } from "../src/components/CalorieRing";

describe("ringDasharray（規格 D4）", () => {
	it.each([
		[null, "0.00 345.58"],
		[0, "0.00 345.58"],
		[-0.2, "0.00 345.58"],
		[0.5, "172.79 345.58"],
		[1500 / 2343, "221.24 345.58"],
		[1, "345.58 345.58"],
		[1.3, "345.58 345.58"],
	])("比例 %s → %s", (ratio, expected) => {
		expect(ringDasharray(ratio)).toBe(expected);
	});
});

describe("CalorieRing", () => {
	it("整張是裝飾（aria-hidden）；一般：弧照比例、data-tone normal", () => {
		const { container } = render(<CalorieRing ratio={0.5} tone="normal" />);
		expect(container.querySelector("svg")).toHaveAttribute(
			"aria-hidden",
			"true",
		);
		const arc = screen.getByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "normal");
		expect(arc).toHaveAttribute("stroke-dasharray", "172.79 345.58");
	});

	it("超過：畫滿，不看比例", () => {
		render(<CalorieRing ratio={0.2} tone="over" />);
		const arc = screen.getByTestId("calorie-ring-arc");
		expect(arc).toHaveAttribute("data-tone", "over");
		expect(arc).toHaveAttribute("stroke-dasharray", "345.58 345.58");
	});

	it("沒有額度：只有底圈", () => {
		const { container } = render(<CalorieRing ratio={null} tone="none" />);
		expect(screen.queryByTestId("calorie-ring-arc")).not.toBeInTheDocument();
		expect(container.querySelectorAll("circle")).toHaveLength(1);
	});
});
