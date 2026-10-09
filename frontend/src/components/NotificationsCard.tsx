import { Link } from "react-router";
import { useUnreadCount } from "../api/notifications";
import { Card } from "./Card";
import styles from "./NotificationsCard.module.css";
import ui from "./ui.module.css";

/** 「我的」最上面的通知卡片（社群規格 §6.4）：有幾則新的、進通知頁的入口。
 *
 *  未讀數跟分頁上的數字是同一個 query（外框也掛著它）：這裡不會多打一次。
 *  抓不到（斷線）就當成 0——「沒有新通知」，連結照樣在。 */
export function NotificationsCard() {
	const unread = useUnreadCount().data ?? 0;
	return (
		<Card testId="notifications-card">
			<h2 className={`${ui.sectionTitle} ${styles.title}`}>通知</h2>
			<div className={styles.row}>
				<p className={unread > 0 ? styles.fresh : styles.none}>
					{unread > 0 ? `${unread} 則新通知` : "沒有新通知"}
				</p>
				{/* 數字不放進連結的名稱：名稱固定是「看通知」，e2e 與螢幕閱讀器都好找。 */}
				<Link to="/notifications" className={styles.link}>
					看通知
				</Link>
			</div>
		</Card>
	);
}
