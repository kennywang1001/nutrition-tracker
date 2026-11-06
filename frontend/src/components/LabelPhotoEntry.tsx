import { type ChangeEvent, useId } from "react";
import styles from "./LabelPhotoEntry.module.css";
import { PhotoPickerButton } from "./PhotoPickerButton";

type Props = {
	/** 選好了一張照片。太大不在這裡擋：新增食物的 `LabelReader` 一進去就擋，跟在那裡選照片同一個地方說
	 *  （改名規格 D7）。 */
	onPhoto: (file: File) => void;
};

/** 「拍營養標示」的入口（改名規格 D1、D2）：記一餐與編輯這一餐的「加一項」（`FoodPicker`）、食物庫。
 *  選好就交給呼叫端帶到新增食物（`labelPhotoState`），那裡一進去就在手機上辨識——不用 AI 額度。
 *
 *  **是檔案選擇的標籤，不是連到新增食物再自動打開相機**：iOS 只在使用者手勢裡開檔案選擇器，導頁之後
 *  程式化 `click()` 會被擋（同總覽的「拍照記」）。說明那一行讓人分得出這條路跟「拍照估算」（AI）不一樣。 */
export function LabelPhotoEntry({ onPhoto }: Props) {
	const id = useId();
	const noteId = `${id}-note`;

	function handleChange(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉：同一張再選一次（例如從新增食物取消回來）也要觸發 change。
		event.target.value = "";
		if (file !== undefined) onPhoto(file);
	}

	return (
		<div className={styles.row}>
			<PhotoPickerButton
				id={id}
				className={styles.button}
				label="拍營養標示"
				accept="image/*"
				capture="environment"
				describedBy={noteId}
				onChange={handleChange}
			/>
			<p id={noteId} className={styles.note}>
				在手機上讀數字，不用 AI 額度
			</p>
		</div>
	);
}
