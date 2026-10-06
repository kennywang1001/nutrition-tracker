import { type FormEvent, useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, describeFieldErrors } from "../api/errors";
import { checkInvite, registerWithInvite } from "../api/invites";
import { login } from "../auth/session";
import ui from "../components/ui.module.css";

export const INVITE_INVALID_TEXT =
	"這個邀請連結已經失效，請跟邀請你的人要一個新的";

const FALLBACK_TIMEZONE = "Asia/Taipei";

/** `#tok` → `tok`。邀請碼在 `#` 後面（規格 §4.1）。 */
export function readInviteToken(hash: string): string {
	return hash.startsWith("#") ? hash.slice(1) : hash;
}

function browserTimezone(): string {
	try {
		return (
			Intl.DateTimeFormat().resolvedOptions().timeZone || FALLBACK_TIMEZONE
		);
	} catch {
		return FALLBACK_TIMEZONE;
	}
}

/** 後端的 422 是不是指到 `timezone`（瀏覽器回報了一個後端的 tzdata 不認得的時區）。 */
function rejectsTimezone(caught: unknown): boolean {
	if (!(caught instanceof ApiError) || caught.status !== 422) return false;
	const errors = caught.details.errors;
	return (
		Array.isArray(errors) &&
		errors.some((item) => {
			if (typeof item !== "object" || item === null) return false;
			const loc = (item as { loc?: unknown }).loc;
			return Array.isArray(loc) && loc.includes("timezone");
		})
	);
}

type Phase = "checking" | "invalid" | "unreachable" | "form" | "registered";

type Props = { onSuccess: () => void };

/** 用邀請連結建立帳號（邀請規格 §4.1）。沒登入、網址是 `/join` 時由 `App` 顯示。 */
export function Join({ onSuccess }: Props) {
	const [token] = useState(() => readInviteToken(window.location.hash));
	const [phase, setPhase] = useState<Phase>(
		token === "" ? "invalid" : "checking",
	);
	const [email, setEmail] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [password, setPassword] = useState("");
	const [confirm, setConfirm] = useState("");
	const [error, setError] = useState<string | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (token === "") return;
		let cancelled = false;
		checkInvite(token).then(
			(valid) => {
				if (!cancelled) setPhase(valid ? "form" : "invalid");
			},
			(caught: unknown) => {
				if (cancelled) return;
				// 422（邀請碼長得根本不對）＝失效；其他（網路）不能說它失效。
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

	async function register(timezone: string) {
		await registerWithInvite({
			email,
			password,
			display_name: displayName,
			timezone,
			invite_token: token,
		});
	}

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		if (password.length < 8) {
			setError("密碼至少要 8 個字");
			return;
		}
		if (password !== confirm) {
			setError("兩次輸入的密碼不一樣");
			return;
		}
		setBusy(true);
		try {
			const timezone = browserTimezone();
			try {
				await register(timezone);
			} catch (caught) {
				if (timezone === FALLBACK_TIMEZONE || !rejectsTimezone(caught)) {
					throw caught;
				}
				await register(FALLBACK_TIMEZONE);
			}
		} catch (caught) {
			setBusy(false);
			if (caught instanceof ApiError && caught.code === "INVITE_INVALID") {
				setPhase("invalid");
			} else if (caught instanceof ApiError && caught.code === "EMAIL_TAKEN") {
				setError(caught.message);
			} else if (caught instanceof ApiError && caught.status === 422) {
				setError(describeFieldErrors(caught).join("；"));
			} else {
				setError("建立失敗，請再試一次");
			}
			return;
		}

		try {
			await login(email, password);
		} catch {
			setBusy(false);
			setPhase("registered");
			return;
		}
		// 邀請碼從網址列消失，接著 App 換成登入後的 BrowserRouter，從 / 開始。
		window.history.replaceState(null, "", "/");
		onSuccess();
	}

	return (
		<section className={ui.screen}>
			<h1>建立帳號</h1>
			{phase === "checking" && <p>確認邀請中…</p>}
			{phase === "invalid" && (
				<>
					<p role="alert">{INVITE_INVALID_TEXT}</p>
					<a href="/">去登入</a>
				</>
			)}
			{phase === "unreachable" && (
				<p role="alert">無法確認邀請連結，請檢查網路後重新整理</p>
			)}
			{phase === "registered" && (
				<>
					<p role="alert">帳號建好了，請用剛剛的 email 登入</p>
					<a href="/">去登入</a>
				</>
			)}
			{phase === "form" && (
				<form onSubmit={handleSubmit} noValidate>
					<label htmlFor="join-email">Email</label>
					<input
						id="join-email"
						type="email"
						autoComplete="username"
						required
						value={email}
						onChange={(event) => setEmail(event.target.value)}
					/>
					<label htmlFor="join-name">名字</label>
					<input
						id="join-name"
						autoComplete="nickname"
						required
						maxLength={50}
						value={displayName}
						onChange={(event) => setDisplayName(event.target.value)}
					/>
					<label htmlFor="join-password">密碼</label>
					<input
						id="join-password"
						type="password"
						autoComplete="new-password"
						required
						value={password}
						onChange={(event) => setPassword(event.target.value)}
					/>
					<label htmlFor="join-confirm">再輸入一次密碼</label>
					<input
						id="join-confirm"
						type="password"
						autoComplete="new-password"
						required
						value={confirm}
						onChange={(event) => setConfirm(event.target.value)}
					/>
					{error !== null && <p role="alert">{error}</p>}
					<button type="submit" disabled={busy}>
						建立帳號
					</button>
				</form>
			)}
		</section>
	);
}

/** 已登入的人打開邀請連結：不打任何邀請端點，邀請不被用掉（規格 §4.1）。 */
export function JoinWhileLoggedIn() {
	return (
		<section className={ui.screen}>
			<h1>邀請連結</h1>
			<p>你已經登入了。這個連結是給新朋友開帳號用的。</p>
			<Link to="/">回總覽</Link>
		</section>
	);
}
