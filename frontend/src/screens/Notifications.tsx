import { useQueryClient } from "@tanstack/react-query";
import {
	Heart,
	type LucideIcon,
	MessageCircle,
	UserCheck,
	UserPlus,
} from "lucide-react";
import { useEffect, useRef } from "react";
import { Link } from "react-router";
import { MEAL_TYPE_LABELS } from "../api/meals";
import {
	markAllRead,
	type NotificationItem,
	useNotifications,
} from "../api/notifications";
import { queryKeys } from "../api/queries";
import ui from "../components/ui.module.css";
import { formatDateTime } from "../lib/dates";
import styles from "./Notifications.module.css";

const ICONS: Record<NotificationItem["type"], LucideIcon> = {
	like: Heart,
	comment: MessageCircle,
	friend_request: UserPlus,
	friend_accepted: UserCheck,
};

/** 一則通知的句子與點下去的去處（社群規格 §6.4）。讚與留言到那一餐；好友的兩種到
 *  「我的」——好友卡片在那裡（接受邀請、看名單）。 */
function describeItem(item: NotificationItem): { text: string; to: string } {
	const who = item.actor_name;
	// 讚與留言一定帶著餐（後端的 CHECK）；`?? "餐點"` 是型別上的保險，不是會走到的路。
	const meal = item.meal ? MEAL_TYPE_LABELS[item.meal.meal_type] : "餐點";
	const mealPath = item.meal ? `/meals/${item.meal.id}` : "/diet";
	switch (item.type) {
		case "like":
			return { text: `${who} 對你的${meal}按了讚`, to: mealPath };
		case "comment":
			return {
				text: `${who} 在你的${meal}留言：${item.comment_preview ?? ""}`,
				to: mealPath,
			};
		case "friend_request":
			return { text: `${who} 想加你為好友`, to: "/me" };
		case "friend_accepted":
			return { text: `${who} 接受了你的好友邀請`, to: "/me" };
	}
}

function NotificationRow({ item }: { item: NotificationItem }) {
	const { text, to } = describeItem(item);
	const Icon = ICONS[item.type];
	return (
		<li className={styles.item}>
			{/* 整列是一個連結（觸控目標 ≥ 44px）。 */}
			<Link
				to={to}
				className={item.is_read ? styles.row : `${styles.row} ${styles.unread}`}
			>
				<Icon aria-hidden="true" size={20} className={styles.icon} />
				<span className={styles.main}>
					{/* 在句子前面：螢幕閱讀器逐一唸連結時先聽到「未讀」。看得到的標記是
					    右邊那個點與粗體。 */}
					{!item.is_read && <span className={ui.srOnly}>未讀</span>}
					{/* 文字節點：名字與留言的預覽都是別人打的字，不會被當成 HTML。 */}
					<span className={styles.text}>{text}</span>
					<time dateTime={item.created_at} className={styles.when}>
						{formatDateTime(item.created_at)}
					</time>
				</span>
				{!item.is_read && <span aria-hidden="true" className={styles.dot} />}
			</Link>
		</li>
	);
}

/** `/notifications`：最近 50 則通知（社群規格 §6.4）。打開、清單載入之後把看到的標成
 *  已讀；分頁上的數字跟著變。 */
export function Notifications() {
	const queryClient = useQueryClient();
	const query = useNotifications();
	const items = query.data;
	// 清單是新的在前：第一則的 id 最大。
	const newest = items?.[0]?.id;
	const hasUnread = items?.some((item) => !item.is_read) ?? false;
	// **這一次打開之後抓回來的**清單才算「看到了」。回到這一頁時先畫的是快取裡上一次的
	// 那一份——裡面的「未讀」是上一次的事（那時已經送過已讀了），不照它送。
	const fresh = query.isFetchedAfterMount;
	// 已經替哪一則（最新的 id）送過已讀：StrictMode 的 effect 跑兩次、同一份清單重抓
	// 回來（回到這個視窗）都不再送。
	const marked = useRef<number | null>(null);
	// `dataUpdatedAt`：清單每抓回來一次就再看一次（就算內容一樣）——已讀失敗之後，
	// 下一次清單回來時才有機會再試。
	const fetchedAt = query.dataUpdatedAt;

	// biome-ignore lint/correctness/useExhaustiveDependencies: fetchedAt 是觸發條件（清單又抓回來一次），不是用到的值
	useEffect(() => {
		if (!fresh || newest === undefined || !hasUnread) return;
		if (marked.current === newest) return;
		marked.current = newest;
		// 帶清單裡最新那一則的 id（規格 D15）：清單載入之後才到的通知不會沒被看過就
		// 變成已讀。平常只更新未讀數，**不重抓清單**——這一次的畫面上，剛看到的還標著未讀。
		markAllRead(newest).then(
			async (count) => {
				// 還在路上的未讀數重抓先取消：它可能在已讀寫進資料庫之前就讀完了、卻比
				// 這個回應晚到（換到這一頁的那一刻外框才剛重抓一次），會把數字蓋回去。
				await queryClient.cancelQueries({ queryKey: queryKeys.unreadCount });
				queryClient.setQueryData(queryKeys.unreadCount, count);
				// **還剩沒讀的＝有通知落在「清單的 GET」與這個 POST 中間**（社群審查 M5）：
				// 比 `newest` 舊的這一次都標掉了，剩下的只會是更新的。分頁上的數字會是它，
				// 開著的清單卻沒有它——而數字是變少的，外框（`useUnreadNotifications`）
				// 只在變多時才讓清單過期。所以這裡重抓一次清單；新的那一則回來之後
				// `newest` 變了，上面的 effect 照平常的路再送一次已讀。
				//
				// 不會繞圈：重抓只跟在「已讀成功而且還剩」後面，已讀只在 `newest` 變了
				// 才送（`marked`）。重抓回來沒有新的（那一則剛好又看不到了）就停在這裡；
				// 一直有新的進來，就是每到一則多一輪。離開這一頁之後清單沒有人在看，
				// `invalidateQueries` 只會把它標成過期，不會去抓。
				// 代價：重抓回來的那一份裡，剛看到的那幾則已經是已讀，「未讀」的標記
				// 會提早消失——只發生在這個空檔真的有東西進來的時候。
				if (count > 0) {
					void queryClient.invalidateQueries({
						queryKey: queryKeys.notifications,
					});
				}
			},
			() => {
				// 失敗：分頁上的數字不動；下一次清單回來時再試。不是畫面上的錯誤——
				// 清單照樣看得到。
				marked.current = null;
			},
		);
	}, [fresh, newest, hasUnread, fetchedAt, queryClient]);

	return (
		<section className={ui.screen}>
			<h1>通知</h1>
			{items === undefined ? (
				query.isError ? (
					<p role="alert">無法載入通知</p>
				) : (
					<p>載入中…</p>
				)
			) : items.length === 0 ? (
				<p className={styles.empty}>還沒有通知</p>
			) : (
				<ul className={styles.list} aria-label="通知">
					{items.map((item) => (
						<NotificationRow key={item.id} item={item} />
					))}
				</ul>
			)}
		</section>
	);
}
