import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { changePassword } from "../auth/session";
import ui from "../components/ui.module.css";

// 後端的 MIN_PASSWORD_LENGTH（app/security/password.py）。前端先擋，只是為了不必來回一趟才知道太短。
const MIN_LENGTH = 8;

/** `/me/password`（帳號設定規格 §5.3）：改自己的密碼。成功後後端撤銷了所有 session、回一組新的票，
 *  `changePassword` 把它換上——其他裝置登出，這台照常用。 */
export function ChangePassword() {
	const [current, setCurrent] = useState("");
	const [next, setNext] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const [done, setDone] = useState(false);
	const doneRef = useRef<HTMLParagraphElement>(null);

	// 表單（連同剛按的送出鈕）整個不見了——焦點要有地方去，不然會掉回 body，螢幕閱讀器也不會念出結果。
	useEffect(() => {
		if (done) doneRef.current?.focus();
	}, [done]);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		if (next.length < MIN_LENGTH) {
			setError("新密碼至少要 8 個字");
			return;
		}
		if (next !== confirm) {
			setError("兩次輸入的新密碼不一樣");
			return;
		}
		// 後端也會擋（PASSWORD_UNCHANGED），但那要多走一趟、還吃掉一次限速額度。
		if (next === current) {
			setError("新密碼不能跟目前的密碼一樣");
			return;
		}
		setBusy(true);
		try {
			await changePassword(current, next);
			setDone(true);
		} catch (caught) {
			// 錯誤都是 422／429，不是 401：client.ts 不會換票重送，錯的密碼不會被驗兩次（規格 決定 8）。
			if (caught instanceof ApiError && caught.retryAfterSeconds !== null) {
				setError(`${caught.message}（${caught.retryAfterSeconds} 秒後可再試）`);
			} else if (
				caught instanceof ApiError &&
				(caught.code === "CURRENT_PASSWORD_INCORRECT" ||
					caught.code === "PASSWORD_UNCHANGED")
			) {
				setError(caught.message);
			} else if (caught instanceof ApiError && caught.status === 422) {
				setError(describeFieldErrors(caught).join("；"));
			} else {
				setError("修改失敗，請再試一次");
			}
		} finally {
			setBusy(false);
		}
	}

	return (
		<section className={ui.screen}>
			<h1>修改密碼</h1>
			{done ? (
				<>
					<div>
						<p role="status" tabIndex={-1} ref={doneRef}>
							密碼已更新。其他裝置都已登出，這台不用重新登入。
						</p>
					</div>
					{/* 放在 .screen 正下方：`.screen > a` 給它 44px 的點擊高度，不用再抄一份連結樣式。 */}
					<Link to="/me">回我的</Link>
				</>
			) : (
				<form onSubmit={handleSubmit} noValidate>
					<label htmlFor="current-password">目前的密碼</label>
					<input
						id="current-password"
						type="password"
						autoComplete="current-password"
						value={current}
						onChange={(event) => setCurrent(event.target.value)}
					/>
					<label htmlFor="new-password">新密碼</label>
					<input
						id="new-password"
						type="password"
						autoComplete="new-password"
						value={next}
						onChange={(event) => setNext(event.target.value)}
					/>
					<label htmlFor="confirm-password">再輸入一次新密碼</label>
					<input
						id="confirm-password"
						type="password"
						autoComplete="new-password"
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
					/>
					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={busy}>
						更新密碼
					</button>
				</form>
			)}
		</section>
	);
}
