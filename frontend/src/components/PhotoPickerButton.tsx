import { Camera } from "lucide-react";
import type { ChangeEvent, InputHTMLAttributes, ReactNode } from "react";
import styles from "./PhotoPickerButton.module.css";

type Props = {
	/** input 的 id；標籤用 htmlFor 指向它，可及名稱因此就是 `label`。 */
	id: string;
	/** 標籤文字＝input 的可及名稱（測試用 getByLabelText 找它）。 */
	label: ReactNode;
	accept: string;
	capture?: InputHTMLAttributes<HTMLInputElement>["capture"];
	disabled?: boolean;
	onChange: (event: ChangeEvent<HTMLInputElement>) => void;
	/** `muted`：灰色虛線框（記一餐、編輯這一餐、今日餐點卡片）；
	 *  `accent`：珊瑚橘虛線框（AI 估算面板，跟旁邊的「估算」按鈕同一套）。 */
	variant?: "muted" | "accent";
	/** 加在標籤上的額外 class：各畫面自己的字級等小差異。 */
	className?: string;
};

/** 「選一張照片」的按鈕：虛線框的標籤＋相機圖示，真的 `<input type=file>`
 *  緊接在標籤後面、視覺上藏起來。記一餐、編輯這一餐、今日餐點卡片、AI 估算
 *  面板四個地方原本各寫一份一樣的 CSS，抽到這裡只留一份。
 *
 *  - **input 不用 display:none**：那樣不能用鍵盤對焦，鍵盤使用者就選不了照片；
 *    Playwright 的 setInputFiles 也還找得到它。對焦外框畫在標籤上。
 *  - **input 一定緊接在標籤後面**（回傳的是 fragment，不包一層）：CSS 靠
 *    `.button:has(+ .input:…)` 從 input 的狀態畫標籤；多包一層的話呼叫端的
 *    flex 版面（記一餐的直排、AI 面板的橫排）也會跟著變。
 *  - 停用時標籤跟著淡掉——上傳／儲存中 input 是 disabled，但標籤看起來還能按。
 *  - 圖示 aria-hidden：可及名稱只有標籤文字。 */
export function PhotoPickerButton({
	id,
	label,
	accept,
	capture,
	disabled,
	onChange,
	variant = "muted",
	className,
}: Props) {
	const labelClass = [
		styles.button,
		variant === "accent" ? styles.accent : null,
		className,
	]
		.filter(Boolean)
		.join(" ");

	return (
		<>
			<label htmlFor={id} className={labelClass}>
				<Camera aria-hidden="true" size={18} />
				{label}
			</label>
			<input
				id={id}
				type="file"
				accept={accept}
				capture={capture}
				className={styles.input}
				disabled={disabled}
				onChange={onChange}
			/>
		</>
	);
}
