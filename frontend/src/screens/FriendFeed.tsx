import { useFriendFeed, useFriends } from "../api/friends";
import { FriendMealCard } from "../components/FriendMealCard";
import styles from "./Today.module.css";

/** 飲食頁「好友」：所有好友的餐，新的在前（好友規格 §5.1）。 */
export function FriendFeed() {
	const friends = useFriends();
	const feed = useFriendFeed();
	const meals = feed.data?.pages.flatMap((page) => page.meals) ?? [];

	if (feed.isPending) return <p>載入中…</p>;
	if (feed.isError) return <p role="alert">無法載入好友動態</p>;
	if (meals.length === 0) {
		return (
			<p>
				{friends.data?.length === 0
					? "還沒有好友。到「我的」→「好友」用好友碼加朋友"
					: "好友還沒有記錄餐點"}
			</p>
		);
	}

	return (
		<section aria-label="好友動態">
			<ul className={styles.feed}>
				{meals.map((meal) => (
					<FriendMealCard key={meal.id} meal={meal} showName />
				))}
			</ul>
			{feed.hasNextPage && (
				<button
					type="button"
					className={styles.more}
					disabled={feed.isFetchingNextPage}
					onClick={() => void feed.fetchNextPage()}
				>
					{feed.isFetchingNextPage ? "載入中…" : "載入更多"}
				</button>
			)}
		</section>
	);
}
