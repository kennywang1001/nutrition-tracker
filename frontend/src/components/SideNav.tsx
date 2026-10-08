import { Plus } from "lucide-react";
import { NavLink } from "react-router";
import { AddSheet } from "./AddSheet";
import { NAV_TABS } from "./nav-tabs";
import styles from "./SideNav.module.css";
import { useAddSheet } from "./use-add-sheet";

/** 電腦版的左側導覽（電腦版版面規格 §3、§5）。
 *
 *  **名稱跟手機的分頁列一模一樣**（導覽「主要導覽」、按鈕「新增紀錄」、
 *  四個連結）：既有的單元測試與 e2e 用 getByRole 找，兩種版面都找得到。
 *  看得到的字是「新增」，可及名稱「新增紀錄」包含它（WCAG 2.5.3）。
 *
 *  「新增」在最上面——DOM 順序就是 Tab 順序，所以這裡不能跟 TabBar 共用
 *  一份 JSX 再用 CSS 換位置。 */
export function SideNav() {
	const sheet = useAddSheet();
	return (
		<>
			<nav className={styles.side} aria-label="主要導覽">
				<button
					ref={sheet.buttonRef}
					type="button"
					className={styles.add}
					aria-label="新增紀錄"
					aria-haspopup="dialog"
					aria-expanded={sheet.open}
					onClick={sheet.show}
				>
					<Plus aria-hidden="true" size={20} />
					<span aria-hidden="true">新增</span>
				</button>
				<ul className={styles.links}>
					{NAV_TABS.map((tab) => {
						const Icon = tab.icon;
						return (
							<li key={tab.to}>
								<NavLink
									to={tab.to}
									end={tab.end}
									className={({ isActive }) =>
										isActive ? `${styles.link} ${styles.active}` : styles.link
									}
								>
									<Icon aria-hidden="true" size={20} />
									<span>{tab.label}</span>
								</NavLink>
							</li>
						);
					})}
				</ul>
			</nav>
			{sheet.open && (
				<AddSheet
					onDismiss={sheet.dismiss}
					onNavigate={sheet.closeForNavigation}
				/>
			)}
		</>
	);
}
