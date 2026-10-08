import {
	ChartPie,
	CircleUser,
	LayoutDashboard,
	type LucideIcon,
	Salad,
} from "lucide-react";

export type NavTab = {
	to: string;
	label: string;
	icon: LucideIcon;
	end?: boolean;
};

/** 四個目的地（介面改版規格 §3.1）。手機的分頁列把「＋」夾在第 2、3 格之間；
 *  電腦版的左側導覽把「新增」放在最上面（電腦版版面規格 §2）。
 *  `/` 的 `end` 在 react-router 8.3.1 是無作用的保險（見 TabBar.tsx）。 */
export const NAV_TABS: readonly NavTab[] = [
	{ to: "/", label: "總覽", icon: LayoutDashboard, end: true },
	{ to: "/reports", label: "報表", icon: ChartPie },
	{ to: "/diet", label: "飲食", icon: Salad },
	{ to: "/me", label: "我的", icon: CircleUser },
];
