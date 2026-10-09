import { useQueryClient } from "@tanstack/react-query";
import { Heart } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { ApiError } from "../api/errors";
import { afterLikeChange, type LikeState, setLike } from "../api/social";
import styles from "./LikeButton.module.css";
import ui from "./ui.module.css";

type Props = {
	mealId: number;
	/** 這是誰的哪一餐（「鮑伯的午餐」）：一頁有好幾顆，螢幕閱讀器要分得出來。 */
	label: string;
	count: number;
	liked: boolean;
};

/** 蓋過 props 的狀態。 */
type Held = {
	state: LikeState;
	/** `null`＝這一輪還在送：樂觀的狀態，一律蓋過 props。
	 *  有值＝送完了，`state` 是伺服器的回應，`over` 是那一刻的 props：
	 *  props 還是那個樣子（快取的通知還沒到）就繼續蓋，props 一變就照 props。 */
	over: LikeState | null;
};

function same(a: LikeState, b: LikeState): boolean {
	return a.like_count === b.like_count && a.liked_by_me === b.liked_by_me;
}

function describeError(caught: unknown): string {
	if (caught instanceof ApiError && caught.status === 429) {
		// `retryAfterSeconds` 沒有標頭時是 null，不是 0（見 `ApiError`）。
		return caught.retryAfterSeconds !== null
			? `${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`
			: caught.message;
	}
	// 剛被解除好友、那一餐被關起來或刪掉了：再按幾次都一樣，不叫人「再試一次」。
	if (caught instanceof ApiError && caught.status === 404) {
		return "這一餐已經看不到了";
	}
	return "沒有送出，請再試一次";
}

/** 讚（社群規格 D18、D19）。
 *
 *  **名稱固定、狀態用 `aria-pressed`**：名稱跟著狀態換（「按讚」／「收回讚」）再加
 *  `aria-pressed`，會唸成「收回讚，已按下」。數字用 `aria-describedby`。
 *
 *  **連按**：畫面立刻照最後一次按的意圖變；請求一次一個，送完再看 `wanted`——
 *  跟伺服器剛回的不一樣才再送。所以請求不會亂序，最後的狀態一定等於最後一次按的。
 *  按鈕從來不會變成不能按（所以不需要 `aria-disabled`）。
 *
 *  **回應回來之後不是直接把樂觀的狀態清掉**：伺服器的數字寫進快取之後，props 要等
 *  TanStack 的通知（下一個 macrotask）才跟上；直接清掉的話按鈕會先退回按之前的 props
 *  再變成新的——閃一下。先留著伺服器的回應，蓋到 props 變了為止（`Held.over`）。
 *
 *  **回傳的是兩個並排的元素**（按鈕、錯誤訊息），沒有包一層：錯誤訊息要能落在上層那一列的
 *  下面（`LikeButton.module.css` 的 `.error`），不把旁邊的「留言 N」擠走。 */
export function LikeButton({ mealId, label, count, liked }: Props) {
	const queryClient = useQueryClient();
	const countId = useId();
	const [held, setHeld] = useState<Held | null>(null);
	const [error, setError] = useState<string | null>(null);
	// 最後一次按下去想要的狀態；null＝沒有還沒送的意圖。
	const wanted = useRef<boolean | null>(null);
	const sending = useRef(false);
	const fromProps: LikeState = { like_count: count, liked_by_me: liked };
	// 這一輪送完的那一刻 props 是什麼：`toggle` 的閉包裡是按下去那一刻的，可能已經舊了。
	const latestProps = useRef(fromProps);
	useEffect(() => {
		latestProps.current = { like_count: count, liked_by_me: liked };
	}, [count, liked]);
	const shown =
		held !== null && (held.over === null || same(held.over, fromProps))
			? held.state
			: fromProps;

	async function toggle() {
		const next = !shown.liked_by_me;
		setError(null);
		setHeld({
			state: {
				liked_by_me: next,
				like_count: Math.max(0, shown.like_count + (next ? 1 : -1)),
			},
			over: null,
		});
		wanted.current = next;
		// 已經有一輪在送：它送完會看到上面這個 wanted。
		if (sending.current) return;
		sending.current = true;

		// 這一輪裡最後一次**成功**的回應＝伺服器現在的狀態。
		let server: LikeState | null = null;
		let failure: { caught: unknown } | null = null;
		try {
			while (wanted.current !== null) {
				const target: boolean = wanted.current;
				wanted.current = null;
				// 按了三下（讚、收回、讚）而第一個回應已經是「讚」：伺服器已經是這個樣子了。
				if (server !== null && server.liked_by_me === target) continue;
				server = await setLike(mealId, target);
			}
		} catch (caught) {
			failure = { caught };
			// 還沒送的意圖一起丟掉：不知道伺服器現在怎麼了，不替使用者自己再送。
			wanted.current = null;
		}
		sending.current = false;
		// 從這裡到函式結束沒有 await：不會有另一次按下插在「寫快取」與「換掉樂觀狀態」中間。
		// 中間的回應（連按時的第一個）不寫進快取：伺服器的狀態還會變，畫面不該跟著跳。
		if (server !== null) afterLikeChange(queryClient, mealId, server);
		// 失敗而且一個都沒成功：退回 props。有成功過的：伺服器停在那一個回應上。
		setHeld(
			server === null ? null : { state: server, over: latestProps.current },
		);
		if (failure !== null) setError(describeError(failure.caught));
	}

	return (
		<>
			<button
				type="button"
				className={styles.like}
				aria-pressed={shown.liked_by_me}
				aria-label={`讚，${label}`}
				aria-describedby={countId}
				onClick={() => void toggle()}
			>
				<Heart
					aria-hidden="true"
					size={20}
					className={shown.liked_by_me ? styles.on : undefined}
				/>
				<span id={countId}>
					<span aria-hidden="true">{shown.like_count}</span>
					<span className={ui.srOnly}>{shown.like_count} 個讚</span>
				</span>
			</button>
			{error !== null && (
				<p role="alert" className={styles.error}>
					{error}
				</p>
			)}
		</>
	);
}
