import type { LucideIcon } from "lucide-react";
import {
	CATEGORY_COLORS,
	CATEGORY_ICONS,
	type ExpenseCategory,
} from "../api/expenses";
import { MEAL_TYPE_ICONS, type MealType } from "../api/meals";
import styles from "./IconBadge.module.css";

type Size = "small" | "large";

/** 運動的徽章色（「＋」的「記運動」、總覽與飲食頁的運動列共用，運動規格 §7）。用「正面狀態」的
 *  綠：跟每個支出分類的顏色都不一樣，時間線上一眼分得出是運動；它是設計變數，深色模式跟著換。 */
export const EXERCISE_COLOR = "var(--color-success)";

/** 體重的徽章色（總覽的快速記錄、「＋」的記體重；首頁改版規格 D17）。借交通的藍：體重不出現在時間線上，不會跟
 *  交通的支出列混淆；「＋」的四個入口（記帳 `--color-action`、記一餐 food 橘、記運動綠、記體重藍）互不相同。 */
export const WEIGHT_COLOR = CATEGORY_COLORS.transport;

type Props = {
	icon: LucideIcon;
	/** 任何 CSS 顏色：分類色（`CATEGORY_COLORS`）或 `var(--color-action)`。 */
	color: string;
	size?: Size;
};

/** 彩色圓形＋白色圖示（規格 §5.1）。**圖示一律 `aria-hidden`**：
 *  呼叫端一定要在旁邊放文字標籤，徽章本身不是資訊來源。 */
export function IconBadge({ icon: Icon, color, size = "small" }: Props) {
	return (
		<span
			className={size === "large" ? styles.large : styles.small}
			style={{ backgroundColor: color }}
		>
			<Icon aria-hidden="true" size={size === "large" ? 22 : 16} />
		</span>
	);
}

export function CategoryIcon({
	category,
	size,
}: {
	category: ExpenseCategory;
	size?: Size;
}) {
	return (
		<IconBadge
			icon={CATEGORY_ICONS[category]}
			color={CATEGORY_COLORS[category]}
			size={size}
		/>
	);
}

/** 餐別圖示。顏色用飲食分類的橘色——時間線上一眼看出「這一列是吃的」。 */
export function MealTypeIcon({
	mealType,
	size,
}: {
	mealType: MealType;
	size?: Size;
}) {
	return (
		<IconBadge
			icon={MEAL_TYPE_ICONS[mealType]}
			color={CATEGORY_COLORS.food}
			size={size}
		/>
	);
}
