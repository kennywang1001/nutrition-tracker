import { type FormEvent, useEffect, useState } from "react";
import { ApiError } from "../api/errors";
import { login } from "../auth/session";

type Props = { onSuccess: () => void };

export function Login({ onSuccess }: Props) {
	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	// 錯誤的「基礎訊息」與「倒數秒數」分開存──不要把倒數字樣烤進 error
	// 字串裡再想辦法切回來。原始計畫的寫法是
	// `error.split("（")[0]`：那依賴訊息裡剛好有一個全形括號，換一句
	// 沒有括號的後端訊息就切壞；開了 noUncheckedIndexedAccess 之後
	// `[0]` 還是 `string | undefined`，過不了 typecheck。分成兩個
	// state，在畫面渲染時才組字串，兩個問題都不存在。
	const [error, setError] = useState<string | null>(null);
	const [cooldown, setCooldown] = useState<number | null>(null);
	const [busy, setBusy] = useState(false);

	useEffect(() => {
		if (cooldown === null || cooldown <= 0) return;
		const timer = setTimeout(() => setCooldown(cooldown - 1), 1000);
		return () => clearTimeout(timer);
	}, [cooldown]);

	async function handleSubmit(event: FormEvent) {
		event.preventDefault();
		setError(null);
		setCooldown(null);
		setBusy(true);
		try {
			await login(email, password);
			onSuccess();
		} catch (caught) {
			if (caught instanceof ApiError && caught.retryAfterSeconds !== null) {
				setError(caught.message);
				setCooldown(caught.retryAfterSeconds);
			} else if (caught instanceof ApiError) {
				// 後端對「帳號不存在」與「密碼錯誤」回一模一樣的 INVALID_CREDENTIALS
				// （規格 §6.3）。直接顯示它的 message，**不要自己加工成更具體的說法**——
				// 那會把後端關掉的側通道從 UI 這一頭加回來。
				setError(caught.message);
			} else {
				setError("無法連線到伺服器");
			}
		} finally {
			setBusy(false);
		}
	}

	const lockedOut = cooldown !== null && cooldown > 0;
	const displayedError =
		error === null
			? null
			: lockedOut
				? `${error}（${cooldown} 秒後可再試）`
				: error;

	return (
		<form onSubmit={handleSubmit}>
			<h1>登入</h1>
			<label htmlFor="email">Email</label>
			<input
				id="email"
				type="email"
				autoComplete="username"
				value={email}
				onChange={(e) => setEmail(e.target.value)}
				required
			/>
			<label htmlFor="password">密碼</label>
			<input
				id="password"
				type="password"
				autoComplete="current-password"
				value={password}
				onChange={(e) => setPassword(e.target.value)}
				required
			/>
			{displayedError !== null && <p role="alert">{displayedError}</p>}
			<button type="submit" disabled={busy || lockedOut}>
				登入
			</button>
		</form>
	);
}
