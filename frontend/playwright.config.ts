import { defineConfig } from "@playwright/test";

export default defineConfig({
	testDir: "./e2e",
	use: {
		baseURL: "http://localhost:5173",
		// 一律明確設時區，而且必須設一個跟 UTC 不同的（規格 §9.2 第 5 條）。
		// CI 的機器是 UTC、本機是 Asia/Taipei——不設的話，「台北宵夜」那一類
		// 跨日界線的缺陷在 CI 上零鑑別力，而那正是後端 §6 第 2 種踩過的坑。
		//
		// 這一份計畫還沒有任何跟日界線有關的畫面，但設定要從一開始就是對的：
		// 第二份加「今日總覽」時，沒有人會記得回來加這一行。
		timezoneId: "Asia/Taipei",
	},
	webServer: {
		command: "npm run dev",
		url: "http://localhost:5173",
		reuseExistingServer: !process.env.CI,
	},
});
