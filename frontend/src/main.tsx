import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { logout } from "./auth/session";
import { getRefreshToken } from "./auth/store";
import { Login } from "./screens/Login";

function App() {
	const [loggedIn, setLoggedIn] = useState(getRefreshToken() !== null);

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
