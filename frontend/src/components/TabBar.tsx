import {
	ChartPie,
	CircleUser,
	LayoutDashboard,
	type LucideIcon,
	Plus,
	Salad,
} from "lucide-react";
import { useState } from "react";
import { NavLink } from "react-router";
import { AddSheet } from "./AddSheet";
import styles from "./TabBar.module.css";

type Tab = { to: string; label: string; icon: LucideIcon; end?: boolean };

/** 底部導覽：總覽｜報表｜＋｜飲食｜我的（介面改版規格 §3.1）。
 *
 *  **用 `NavLink` 而不是 `Link`**：NavLink 自己依目前路由加上
 *  `aria-current="page"`。自己拿 `useLocation()` 比字串的話，「哪一格是
 *  亮的」會退化成只有 class 名稱看得出來的狀態，而 `"/diet".startsWith("/")`
 *  為真——總覽會跟著亮（`tests/tab-bar.test.tsx` 守這件事）。
 *
 *  **`/` 那一格的 `end` 在 react-router 8.3.1 是無作用的保險**：NavLink 對
 *  `to="/"` 有內建特例。留著是因為它精確表達意圖。
 *
 *  **「＋」不是一個路由**，是一顆打開 `AddSheet` 的按鈕。管理員的「審核」
 *  搬到「我的」——tab bar 因此對所有人都是固定的 4＋1 格，320px 寬時每格
 *  64px，圖示加兩個字的標籤放得下。 */
const LEFT_TABS: readonly Tab[] = [
	{ to: "/", label: "總覽", icon: LayoutDashboard, end: true },
	{ to: "/reports", label: "報表", icon: ChartPie },
];

const RIGHT_TABS: readonly Tab[] = [
	{ to: "/diet", label: "飲食", icon: Salad },
	{ to: "/me", label: "我的", icon: CircleUser },
];

function TabLink({ tab }: { tab: Tab }) {
	const Icon = tab.icon;
	return (
		<NavLink
			to={tab.to}
			end={tab.end}
			className={({ isActive }) =>
				isActive ? `${styles.tab} ${styles.active}` : styles.tab
			}
		>
			<Icon aria-hidden="true" size={22} />
			<span>{tab.label}</span>
		</NavLink>
	);
}

export function TabBar() {
	const [sheetOpen, setSheetOpen] = useState(false);

	return (
		<>
			<nav className={styles.bar} aria-label="主要導覽">
				{LEFT_TABS.map((tab) => (
					<TabLink key={tab.to} tab={tab} />
				))}
				<div className={styles.addSlot}>
					<button
						type="button"
						className={styles.add}
						aria-label="新增紀錄"
						aria-haspopup="dialog"
						aria-expanded={sheetOpen}
						onClick={() => setSheetOpen(true)}
					>
						<Plus aria-hidden="true" size={28} />
					</button>
				</div>
				{RIGHT_TABS.map((tab) => (
					<TabLink key={tab.to} tab={tab} />
				))}
			</nav>
			{sheetOpen && <AddSheet onClose={() => setSheetOpen(false)} />}
		</>
	);
}
