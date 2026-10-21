import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PhotoHintStep } from "../src/components/PhotoHintStep";

const PHOTO = new File(["a"], "a.jpg", { type: "image/jpeg" });
const OTHER = new File(["b"], "b.jpg", { type: "image/jpeg" });

/** 呼叫端的樣子：說明由外面的 state 管（換照片時要留著）。 */
function Harness({
	file = PHOTO,
	busy = false,
	startLabel = "開始估算",
	onStart,
	onCancel,
}: {
	file?: File;
	busy?: boolean;
	startLabel?: string;
	onStart: () => void;
	onCancel: () => void;
}) {
	const [hint, setHint] = useState("");
	return (
		<PhotoHintStep
			file={file}
			hint={hint}
			onHintChange={setHint}
			startLabel={startLabel}
			placeholder="例：飯半碗、雞皮沒吃、7-11 的"
			busy={busy}
			onStart={onStart}
			onCancel={onCancel}
		/>
	);
}

let urls: string[];

beforeEach(() => {
	urls = [];
	// 每一次給不同的網址：才分得出釋放的是哪一張。
	vi.spyOn(URL, "createObjectURL").mockImplementation(() => {
		const url = `blob:fake-${urls.length + 1}`;
		urls.push(url);
		return url;
	});
	vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("PhotoHintStep（確認照片）", () => {
	it("「確認照片」的 region、縮圖用 object URL", () => {
		render(<Harness onStart={vi.fn()} onCancel={vi.fn()} />);

		const region = screen.getByRole("region", { name: "確認照片" });
		const img = screen.getByRole("img", { name: "要送給 AI 的照片" });
		expect(region).toContainElement(img);
		expect(img).toHaveAttribute("src", "blob:fake-1");
		expect(URL.createObjectURL).toHaveBeenCalledWith(PHOTO);
	});

	it("標籤「補充說明（選填）」對到 textarea：placeholder、200 字上限、2 行", () => {
		render(<Harness onStart={vi.fn()} onCancel={vi.fn()} />);

		const textarea = screen.getByLabelText("補充說明（選填）");
		expect(textarea.tagName).toBe("TEXTAREA");
		expect(textarea).toHaveAttribute(
			"placeholder",
			"例：飯半碗、雞皮沒吃、7-11 的",
		);
		expect(textarea).toHaveAttribute("maxLength", "200");
		expect(textarea).toHaveAttribute("rows", "2");
		// 不自動對焦到說明：手機會跳出鍵盤蓋住「開始估算」（規格 §6.3）。
		expect(textarea).not.toHaveFocus();
	});

	it("打到 150 字才說還能打幾字；那一行是 textarea 的 aria-describedby", () => {
		render(<Harness onStart={vi.fn()} onCancel={vi.fn()} />);
		const textarea = screen.getByLabelText("補充說明（選填）");

		fireEvent.change(textarea, { target: { value: "飯".repeat(149) } });
		expect(textarea).toHaveAccessibleDescription("最多 200 字");

		fireEvent.change(textarea, { target: { value: "飯".repeat(150) } });
		expect(textarea).toHaveAccessibleDescription("最多 200 字，還能打 50 字");
		// 不是 live region：打字時不吵。
		expect(screen.queryByRole("status")).not.toBeInTheDocument();
	});

	it("按「開始估算」呼叫 onStart 一次", async () => {
		const onStart = vi.fn();
		render(<Harness onStart={onStart} onCancel={vi.fn()} />);

		await userEvent.click(screen.getByRole("button", { name: "開始估算" }));

		expect(onStart).toHaveBeenCalledTimes(1);
		expect(screen.getByRole("button", { name: "開始估算" })).toHaveAttribute(
			"aria-disabled",
			"false",
		);
	});

	it("送出中：兩顆按鈕 aria-disabled、按了不呼叫；說明唯讀", async () => {
		const onStart = vi.fn();
		const onCancel = vi.fn();
		render(<Harness busy onStart={onStart} onCancel={onCancel} />);

		const start = screen.getByRole("button", { name: "開始估算" });
		const cancel = screen.getByRole("button", { name: "取消" });
		expect(start).toHaveAttribute("aria-disabled", "true");
		expect(cancel).toHaveAttribute("aria-disabled", "true");
		// aria-disabled、不是原生 disabled：按下去的當下焦點在它身上，原生的會讓焦點掉到 body。
		expect(start).not.toBeDisabled();
		await userEvent.click(start);
		await userEvent.click(cancel);
		expect(onStart).not.toHaveBeenCalled();
		expect(onCancel).not.toHaveBeenCalled();
		expect(screen.getByLabelText("補充說明（選填）")).toHaveAttribute(
			"readonly",
		);
	});

	it("按「取消」呼叫 onCancel", async () => {
		const onCancel = vi.fn();
		const onStart = vi.fn();
		render(<Harness onStart={onStart} onCancel={onCancel} />);

		await userEvent.click(screen.getByRole("button", { name: "取消" }));

		expect(onCancel).toHaveBeenCalledTimes(1);
		expect(onStart).not.toHaveBeenCalled();
	});

	it("換照片釋放舊的 object URL；卸載釋放新的", () => {
		const props = { onStart: vi.fn(), onCancel: vi.fn() };
		const { rerender, unmount } = render(<Harness {...props} />);
		expect(URL.revokeObjectURL).not.toHaveBeenCalled();

		rerender(<Harness {...props} file={OTHER} />);
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-1");
		expect(URL.revokeObjectURL).not.toHaveBeenCalledWith("blob:fake-2");
		expect(
			screen.getByRole("img", { name: "要送給 AI 的照片" }),
		).toHaveAttribute("src", "blob:fake-2");

		unmount();
		expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:fake-2");
	});

	it("營養標示：按鈕名稱是「開始讀取」", () => {
		render(
			<Harness startLabel="開始讀取" onStart={vi.fn()} onCancel={vi.fn()} />,
		);

		expect(
			screen.getByRole("button", { name: "開始讀取" }),
		).toBeInTheDocument();
		expect(
			screen.queryByRole("button", { name: "開始估算" }),
		).not.toBeInTheDocument();
	});
});
