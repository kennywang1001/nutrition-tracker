import { Camera, Dumbbell, ScanBarcode, Weight } from "lucide-react";
import type { ChangeEvent } from "react";
import { Link } from "react-router";
import { CATEGORY_COLORS } from "../api/expenses";
import { SCAN_STATE, WEIGHT_FORM_STATE } from "../lib/quick-actions";
import { EXERCISE_COLOR, IconBadge, WEIGHT_COLOR } from "./IconBadge";
import styles from "./QuickActions.module.css";

type Props = {
	/** 拍照記選好了一張照片（太大不在這裡擋：記一餐的 AI 面板選的當下就擋，同一個地方說）。 */
	onPhoto: (file: File) => void;
};

/** 總覽的四個快速記錄（首頁改版規格 §4）。
 *
 *  **拍照記是 `<label>`＋視覺隱藏的檔案輸入**，不是連到記一餐再自動打開相機：iOS 只在使用者手勢裡開檔案選擇器，
 *  點標籤本身就是那個手勢——一按就開相機；導頁之後再程式化 `click()` 會被擋（D8）。`capture="environment"`：
 *  直接開後鏡頭（從相簿選用記一餐裡的「拍照估算」）。輸入框不用 `display:none`：鍵盤要能對焦。
 *
 *  掃條碼、記運動、記體重是普通的連結；掃條碼與記體重帶 router state（`lib/quick-actions.ts`）。
 *  「記運動」「記體重」跟「＋」選單同名（D18）。 */
export function QuickActions({ onPhoto }: Props) {
	function handlePhoto(event: ChangeEvent<HTMLInputElement>) {
		const file = event.target.files?.[0];
		// 清掉 input 的值：從記一餐回來（或同一張再選一次）時 change 才會再觸發。
		event.target.value = "";
		if (file !== undefined) onPhoto(file);
	}

	return (
		<ul className={styles.actions} aria-label="快速記錄">
			<li>
				<label htmlFor="quick-photo" className={styles.action}>
					<IconBadge icon={Camera} color={CATEGORY_COLORS.food} size="large" />
					拍照記
				</label>
				<input
					id="quick-photo"
					type="file"
					accept="image/*"
					capture="environment"
					className={styles.fileInput}
					onChange={handlePhoto}
				/>
			</li>
			<li>
				<Link to="/meals/new" state={SCAN_STATE} className={styles.action}>
					<IconBadge
						icon={ScanBarcode}
						color="var(--color-action)"
						size="large"
					/>
					掃條碼
				</Link>
			</li>
			<li>
				<Link to="/exercises/new" className={styles.action}>
					<IconBadge icon={Dumbbell} color={EXERCISE_COLOR} size="large" />
					記運動
				</Link>
			</li>
			<li>
				<Link to="/weight" state={WEIGHT_FORM_STATE} className={styles.action}>
					<IconBadge icon={Weight} color={WEIGHT_COLOR} size="large" />
					記體重
				</Link>
			</li>
		</ul>
	);
}
