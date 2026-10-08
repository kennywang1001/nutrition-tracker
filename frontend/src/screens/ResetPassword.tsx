import { type FormEvent, useEffect, useRef, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { checkResetLink, resetPassword } from "../api/password-reset";
import ui from "../components/ui.module.css";
import { readLinkToken } from "../lib/link-token";

/** 後端 `RESET_INVALID_MESSAGE` 的同一句話。四種失效（不存在、用過、過期、撤銷）一律這一句（規格 §3.6）。 */
export const RESET_INVALID_TEXT =
	"這個重設密碼連結已經失效，請跟管理員要一個新的";

// 後端的 MIN_PASSWORD_LENGTH（app/security/password.py）。
const MIN_LENGTH = 8;

type Phase = "checking" | "invalid" | "unreachable" | "form" | "done";

/** 用管理員給的一次性連結設新密碼（帳號設定規格 §5.5）。沒登入、網址是 `/reset-password` 時由 `App` 顯示。
 *  結構照 `Join`：先問連結還能不能用，再給表單。 */
export function ResetPassword() {
	const [token] = useState(() => readLinkToken(window.location.hash));
	const [phase, setPhase] = useState<Phase>(
		token === "" ? "invalid" : "checking",
	);
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);
	const doneRef = useRef<HTMLParagraphElement>(null);

	useEffect(() => {
		if (token === "") return;
		let cancelled = false;
		checkResetLink(token).then(
			(valid) => {
				if (!cancelled) setPhase(valid ? "form" : "invalid");
			},
			(caught: unknown) => {
				if (cancelled) return;
				// 422（碼長得根本不對）＝失效；其他（網路、伺服器）不能說它失效——
				// 說了，使用者會去跟管理員要一條新的，而手上這條其實還能用。
				setPhase(
					caught instanceof ApiError && caught.status === 422
						? "invalid"
						: "unreachable",
				);
			},
		);
		return () => {
			cancelled = true;
		};
	}, [token]);

	// 表單（連同剛按的送出鈕）整個不見了——焦點要有地方去。
	useEffect(() => {
		if (phase === "done") doneRef.current?.focus();
	}, [phase]);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		if (password.length < MIN_LENGTH) {
			setError("新密碼至少要 8 個字");
			return;
		}
		if (password !== confirm) {
			setError("兩次輸入的新密碼不一樣");
			return;
		}
		setBusy(true);
		try {
			await resetPassword(token, password);
		} catch (caught) {
			setBusy(false);
			if (caught instanceof ApiError && caught.code === "RESET_LINK_INVALID") {
				// 確認之後才失效的（過期、被用掉、管理員又產生了一條新的）：表單留著也送不出去。
				setPhase("invalid");
			} else if (caught instanceof ApiError && caught.status === 422) {
				setError(describeFieldErrors(caught).join("；"));
			} else {
				setError("重設失敗，請再試一次");
			}
			return;
		}
		// 碼從網址列消失（同 Join 成功時）。換成 "/" 而不是留在 /reset-password：重新整理會落在
		// 登入畫面，而不是一個「連結失效」的畫面。
		window.history.replaceState(null, "", "/");
		setPhase("done");
	}

	return (
		<section className={ui.screen}>
			<h1>重設密碼</h1>
			{phase === "checking" && <p>確認連結中…</p>}
			{phase === "invalid" && (
				<>
					<p role="alert">{RESET_INVALID_TEXT}</p>
					<a href="/">去登入</a>
				</>
			)}
			{phase === "unreachable" && (
				<p role="alert">無法確認連結，請檢查網路後重新整理</p>
			)}
			{phase === "done" && (
				<>
					<p role="status" tabIndex={-1} ref={doneRef}>
						密碼已重設，請登入
					</p>
					{/* 不自動登入（規格 決定 16）：讓使用者用新密碼親自登入一次，確認記得住。
					    整頁的 <a>：App 重新載入，沒有票，落在登入畫面。 */}
					<a href="/">去登入</a>
				</>
			)}
			{phase === "form" && (
				<form onSubmit={handleSubmit} noValidate>
					<label htmlFor="reset-password">新密碼</label>
					<input
						id="reset-password"
						type="password"
						autoComplete="new-password"
						required
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
					<label htmlFor="reset-confirm">再輸入一次新密碼</label>
					<input
						id="reset-confirm"
						type="password"
						autoComplete="new-password"
						required
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
					/>
					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={busy}>
						重設密碼
					</button>
				</form>
			)}
		</section>
	);
}

/** 已登入的人打開重設連結：不打任何重設端點，連結不被用掉（帳號設定規格 §5.5）。 */
export function ResetPasswordWhileLoggedIn() {
	// 連結還能用：不留在網址列（歷史紀錄、截圖、分享目前頁面）。同 JoinWhileLoggedIn：
	// 走 navigate 而不是直接 history.replaceState——這裡在 BrowserRouter 裡面，直接改會蓋掉
	// react-router 記在 history.state 的 key/idx，路由的 location 也還帶著舊的 hash。
	const navigate = useNavigate();
	useEffect(() => {
		navigate("/reset-password", { replace: true });
	}, [navigate]);

	return (
		<section className={ui.screen}>
			<h1>重設密碼連結</h1>
			<p>
				你已經登入了。這個連結是給忘記密碼的人用的；要改自己的密碼，請到「我的」→「修改密碼」。
			</p>
			<Link to="/">回總覽</Link>
		</section>
	);
}
