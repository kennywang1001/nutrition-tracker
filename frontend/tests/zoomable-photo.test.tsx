import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ZoomablePhoto } from "../src/components/ZoomablePhoto";

const ALT = "午餐（12:30）的照片";

function renderPhoto(full: { objectUrl: string | null; isError: boolean }) {
	const useFull = vi.fn(() => full);
	render(<ZoomablePhoto alt={ALT} thumbUrl="blob:thumb" useFull={useFull} />);
	return useFull;
}

describe("可以放大的照片", () => {
	it("一開始只顯示縮圖，還沒抓原圖", () => {
		const useFull = renderPhoto({ objectUrl: "blob:full", isError: false });

		expect(screen.getByRole("img", { name: ALT })).toHaveAttribute(
			"src",
			"blob:thumb",
		);
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(useFull).not.toHaveBeenCalled();
	});

	it("點了打開大圖、抓原圖、焦點在「關閉」", async () => {
		const useFull = renderPhoto({ objectUrl: "blob:full", isError: false });

		await userEvent.click(
			screen.getByRole("button", { name: `看大圖：${ALT}` }),
		);

		const dialog = screen.getByRole("dialog", { name: ALT });
		expect(within(dialog).getByRole("img")).toHaveAttribute("src", "blob:full");
		expect(within(dialog).getByRole("button", { name: "關閉" })).toHaveFocus();
		expect(useFull).toHaveBeenCalled();
	});

	it("原圖還沒好時先顯示縮圖", async () => {
		renderPhoto({ objectUrl: null, isError: false });

		await userEvent.click(
			screen.getByRole("button", { name: `看大圖：${ALT}` }),
		);

		expect(within(screen.getByRole("dialog")).getByRole("img")).toHaveAttribute(
			"src",
			"blob:thumb",
		);
	});

	it("Esc 關閉，焦點回到照片按鈕", async () => {
		renderPhoto({ objectUrl: "blob:full", isError: false });
		const trigger = screen.getByRole("button", { name: `看大圖：${ALT}` });

		await userEvent.click(trigger);
		await userEvent.keyboard("{Escape}");

		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
		expect(trigger).toHaveFocus();
	});

	it("「關閉」與點遮罩都會關；點圖本身不會", async () => {
		renderPhoto({ objectUrl: "blob:full", isError: false });
		const trigger = screen.getByRole("button", { name: `看大圖：${ALT}` });

		await userEvent.click(trigger);
		await userEvent.click(within(screen.getByRole("dialog")).getByRole("img"));
		expect(screen.getByRole("dialog")).toBeInTheDocument();

		await userEvent.click(screen.getByRole("dialog"));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();

		await userEvent.click(trigger);
		await userEvent.click(screen.getByRole("button", { name: "關閉" }));
		expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
	});
});
