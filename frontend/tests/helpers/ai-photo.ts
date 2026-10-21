import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

/** 選一張照片 →（選填）打補充說明 → 按「開始估算」或「開始讀取」（照片說明規格 §6）。
 *  照片的選擇不再直接送出——既有的照片測試都改用這個。
 *
 *  說明與按鈕在「確認照片」那張卡片裡找：新增食物可以同時開著兩張（「用 AI 填」與營養標示），
 *  在整個畫面找會找到兩個說明欄。兩張的開始按鈕名稱不同，用它分出是哪一張；找到的不是剛好
 *  一張就丟錯，不要猜。 */
export async function pickPhoto(
	label: string,
	file: File,
	{ hint, start = "開始估算" }: { hint?: string; start?: string } = {},
): Promise<void> {
	await userEvent.upload(screen.getByLabelText(label), file);
	const cards = screen
		.getAllByRole("region", { name: "確認照片" })
		.filter(
			(region) =>
				within(region).queryByRole("button", { name: start }) !== null,
		);
	const [card, ...others] = cards;
	if (card === undefined || others.length > 0) {
		throw new Error(`有「${start}」的確認照片卡片有 ${cards.length} 張`);
	}
	if (hint !== undefined) {
		await userEvent.type(within(card).getByLabelText("補充說明（選填）"), hint);
	}
	await userEvent.click(within(card).getByRole("button", { name: start }));
}
