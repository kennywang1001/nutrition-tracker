import { Heart } from "lucide-react";
import { useRef } from "react";
import { Link, useParams } from "react-router";
import { ApiError } from "../api/errors";
import { MEAL_TYPE_LABELS } from "../api/meals";
import { useMealPhoto } from "../api/photos";
import { useSocialMeal } from "../api/social";
import { CommentForm } from "../components/CommentForm";
import { CommentList } from "../components/CommentList";
import { FriendPhoto } from "../components/FriendMealCard";
import { LikeButton } from "../components/LikeButton";
import ui from "../components/ui.module.css";
import { ZoomablePhoto } from "../components/ZoomablePhoto";
import { formatDateTime } from "../lib/dates";
import { formatMacro } from "../lib/decimal";
import styles from "./MealDetail.module.css";

/** 自己那一餐的照片：走 `/api/meals/{id}/photo`（只給主人的那個端點）。好友的餐用
 *  `FriendPhoto`（走好友的端點）——**兩個元件分開**，因為 hook 不能放在條件裡，
 *  而用錯端點的結果是 404（看別人的餐卻打只給主人的端點）。 */
function OwnPhoto({ mealId, alt }: { mealId: number; alt: string }) {
	const thumb = useMealPhoto(mealId, "thumb");
	return (
		<>
			{thumb.objectUrl !== null && (
				<ZoomablePhoto
					alt={alt}
					thumbUrl={thumb.objectUrl}
					// biome-ignore lint/correctness/useHookAtTopLevel: 只在 ZoomablePhoto 的 Viewer 裡、每次 render 都以同樣順序呼叫，符合 hooks 規則
					useFull={() => useMealPhoto(mealId)}
				/>
			)}
			{thumb.isError && <p>照片無法顯示</p>}
		</>
	);
}

/** 網址的 `:id` → 餐的 id；不是正整數就是 `NaN`（`useSocialMeal` 看到 `NaN` 不發請求）。
 *  `Number("1.5")`、`Number("-3")`、`Number("")` 都是「數字」，所以不能只靠 `Number`。 */
function parseMealId(raw: string | undefined): number {
	if (raw === undefined || !/^[1-9]\d*$/.test(raw)) return Number.NaN;
	return Number(raw);
}

/** `/meals/:id`：一餐的唯讀畫面，底下是讚與留言（社群規格 §6.3）。自己的餐與看得到的
 *  好友的餐都走這裡——同一個端點、同一份白名單（沒有餐費、備註）。
 *
 *  **不是 `/meals/:id/edit`**（那是主人改這一餐的畫面），也不是 `/meals/new`。 */
export function MealDetail() {
	const mealId = parseMealId(useParams().id);
	const query = useSocialMeal(mealId);
	const commentsHeading = useRef<HTMLHeadingElement>(null);

	// 404＝看不到（不存在、不是好友、對方設成只有自己看得到——後端刻意不分）。
	// **就算快取裡還有舊資料也不顯示**：剛被解除好友的人不該繼續看著那一餐與底下的留言。
	const gone = query.error instanceof ApiError && query.error.status === 404;
	if (gone || Number.isNaN(mealId)) {
		return (
			// ui.screen：標題的大小跟看得到的時候一樣；直接底下的連結長得像一顆按鈕
			// （44px）——這一頁唯一能做的事就是回去。
			<section className={ui.screen}>
				<h1>餐點</h1>
				<div>
					<p role="alert" className={styles.goneTitle}>
						看不到這一餐
					</p>
					<p className={styles.goneWhy}>
						它可能已經刪除了，或是設成只有本人看得到。
					</p>
				</div>
				<Link to="/diet">回飲食</Link>
			</section>
		);
	}
	if (query.data === undefined) {
		return query.isError ? <p role="alert">無法載入這一餐</p> : <p>載入中…</p>;
	}

	const { meal, is_mine, likes, comments, comments_truncated } = query.data;
	// 「鮑伯的午餐」／「我的午餐」：標題、讚的按鈕、照片的替代文字都用它。
	const label = `${is_mine ? "我" : meal.user.display_name}的${MEAL_TYPE_LABELS[meal.meal_type]}`;
	// `?? 0`：型別上一定有，但後端退版時（migration 0018 可以退）回應裡沒有這幾個欄位。
	const likeCount = meal.like_count ?? 0;
	const commentCount = meal.comment_count ?? 0;

	return (
		<section className={ui.screen}>
			<header className={styles.header}>
				<div className={styles.titleRow}>
					<h1>{label}</h1>
					{is_mine && (
						<Link to={`/meals/${meal.id}/edit`} className={styles.edit}>
							編輯
						</Link>
					)}
				</div>
				<p className={styles.byline}>
					{/* 好友的名字連到他的那一天（跟動態上的卡片一樣）；自己的不用。 */}
					{!is_mine && (
						<Link to={`/friends/${meal.user.id}`} className={styles.name}>
							{meal.user.display_name}
						</Link>
					)}
					<time dateTime={meal.eaten_at}>{formatDateTime(meal.eaten_at)}</time>
				</p>
			</header>

			<section className={styles.meal}>
				{/* 真值判斷：沒有描述時不畫空的段落。內容是文字節點，不會被當成 HTML。 */}
				{meal.description ? (
					<p data-testid="meal-description" className={styles.description}>
						{meal.description}
					</p>
				) : null}
				{meal.has_photo && (
					<div className={styles.photo}>
						{is_mine ? (
							<OwnPhoto mealId={meal.id} alt={label} />
						) : (
							<FriendPhoto meal={meal} />
						)}
					</div>
				)}
				<ul className={styles.items} aria-label="這一餐吃了什麼">
					{meal.items.map((item, index) => (
						// biome-ignore lint/suspicious/noArrayIndexKey: 白名單回應沒有項目 id，順序由後端固定
						<li key={index}>
							{item.food_name}
							<span className={styles.quantity}>
								{" "}
								· {formatMacro(item.quantity_g)} {item.base_unit}
							</span>
							<span className={styles.kcal}>{formatMacro(item.kcal)} kcal</span>
						</li>
					))}
				</ul>
				{/* 合計的熱量在右邊，跟上面每一項的熱量同一欄；三大營養素另外一列
				    （擠在同一列的話手機上會斷成兩行）。 */}
				<p className={styles.total}>
					<span>合計</span>
					<span>{formatMacro(meal.kcal)} kcal</span>
				</p>
				<p className={styles.macros}>
					蛋白質 {formatMacro(meal.protein_g)} g · 脂肪{" "}
					{formatMacro(meal.fat_g)} g · 碳水 {formatMacro(meal.carb_g)} g
				</p>
				{/* 讚：好友看到按鈕；主人不能對自己的餐按讚（後端 422），只看到數字。
				    主人而且還沒有人按：整列不畫。會換行的 flex 列——LikeButton 失敗時的
				    錯誤訊息佔滿一整列，落在按鈕與名單的下面。 */}
				{(!is_mine || likeCount > 0) && (
					<div className={styles.social}>
						{is_mine ? (
							<span className={styles.likes}>
								<Heart aria-hidden="true" size={20} />
								<span aria-hidden="true">{likeCount}</span>
								<span className={ui.srOnly}>{likeCount} 個讚</span>
							</span>
						) : (
							// 數字一定從快取來（`query.data`）：LikeButton 靠 props 變了
							// 才放掉它手上那份伺服器的回應。
							<LikeButton
								mealId={meal.id}
								label={label}
								count={likeCount}
								liked={meal.liked_by_me ?? false}
							/>
						)}
						{likes.length > 0 && (
							<p className={styles.likers}>
								{likes
									.map((like) => (like.is_me ? "我" : like.display_name))
									.join("、")}{" "}
								說讚
							</p>
						)}
					</div>
				)}
			</section>

			<section>
				{/* tabIndex=-1：刪掉一則留言之後焦點移到這裡（那一列連同刪除鈕都不見了）。 */}
				<h2
					ref={commentsHeading}
					tabIndex={-1}
					className={styles.commentsTitle}
				>
					留言（{commentCount}）
				</h2>
				<CommentList
					mealId={meal.id}
					comments={comments}
					truncated={comments_truncated}
					onDeleted={() => commentsHeading.current?.focus()}
				/>
				<CommentForm mealId={meal.id} />
			</section>
		</section>
	);
}
