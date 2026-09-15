import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { apiFetch } from "./api/client";
import { logout } from "./auth/session";
import { getRefreshToken } from "./auth/store";
import { Login } from "./screens/Login";

function App() {
	const [loggedIn, setLoggedIn] = useState(getRefreshToken() !== null);
	const [displayName, setDisplayName] = useState<string | null>(null);

	if (!loggedIn) return <Login onSuccess={() => setLoggedIn(true)} />;

	return (
		<main>
			<h1>已登入</h1>
			<button
				type="button"
				onClick={async () => {
					await logout();
					setLoggedIn(false);
				}}
			>
				登出
			</button>
			<button
				type="button"
				onClick={async () => {
					const me = await apiFetch<{ display_name: string }>("/api/me");
					setDisplayName(me?.display_name ?? null);
				}}
			>
				重新整理
			</button>
			{displayName !== null && <p>{displayName}</p>}
		</main>
	);
}

const root = document.getElementById("root");
if (root === null) throw new Error("找不到 #root");
createRoot(root).render(
	<StrictMode>
		<App />
	</StrictMode>,
);
