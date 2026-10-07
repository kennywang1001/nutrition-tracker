import { useState } from "react";
import { Link, useParams } from "react-router";
import { useFriendDay } from "../api/friends";
import { FriendMealCard } from "../components/FriendMealCard";
import { formatCivilDate, shiftDays } from "../lib/civil-date";
import styles from "./FriendDay.module.css";

/** `/friends/:id`：某個好友某一天的餐（好友規格 §5.2）。一開始 `day` 是 null，
 *  讓後端用**好友的時區**決定他的今天；之後的前一天／後一天從回應的 `day` 推。 */
export function FriendDay() {
	const friendId = Number(useParams().id);
	const [day, setDay] = useState<string | null>(null);
	const query = useFriendDay(friendId, day);

	if (query.isError) {
		return (
			<section>
				<h1>好友</h1>
				<p role="alert">看不到這個人的餐點</p>
				<Link to="/diet?view=friends" className={styles.back}>
					回飲食
				</Link>
			</section>
		);
	}
	if (query.data === undefined) return <p>載入中…</p>;

	const shown = query.data.day;
	return (
		<section>
			<h1>{query.data.friend.display_name}</h1>
			<div className={styles.nav}>
				<button type="button" onClick={() => setDay(shiftDays(shown, -1))}>
					前一天
				</button>
				<span>{formatCivilDate(shown)}</span>
				<button type="button" onClick={() => setDay(shiftDays(shown, 1))}>
					後一天
				</button>
			</div>
			{query.data.meals.length === 0 ? (
				<p>這一天沒有可以看的餐點</p>
			) : (
				<ul className={styles.list}>
					{query.data.meals.map((meal) => (
						<FriendMealCard key={meal.id} meal={meal} showName={false} />
					))}
				</ul>
			)}
		</section>
	);
}
