import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

const root = document.getElementById("root");
if (root === null) throw new Error("找不到 #root");
createRoot(root).render(
	<StrictMode>
		<h1>飲食紀錄</h1>
	</StrictMode>,
);
