import type { LucideIcon } from "lucide-react";
import {
	CATEGORY_COLORS,
	CATEGORY_ICONS,
	type ExpenseCategory,
} from "../api/expenses";
import { MEAL_TYPE_ICONS, type MealType } from "../api/meals";
import styles from "./IconBadge.module.css";

type Size = "small" | "large";

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
