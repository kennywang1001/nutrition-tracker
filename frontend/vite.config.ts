import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";
// 用 "vitest/config" 而不是 "vite" 的 defineConfig：前者是後者的型別超集，
// 讓下面的 test 區塊有型別檢查，不需要額外的 /// <reference types="vitest" />。
import { defineConfig } from "vitest/config";

// https://vite.dev/config/
export default defineConfig({
	plugins: [
		react(),
		VitePWA({
			registerType: "autoUpdate",
			manifest: {
				name: "飲食紀錄",
				short_name: "飲食",
				start_url: "/",
				display: "standalone",
				background_color: "#ffffff",
				theme_color: "#ffffff",
				icons: [
					{ src: "/icon-192.png", sizes: "192x192", type: "image/png" },
					{ src: "/icon-512.png", sizes: "512x512", type: "image/png" },
				],
			},
			workbox: {
				// L1：只快取 app shell（建置產物）。
				// **不在這裡加 runtimeCaching 快取 API 回應** —— 那是 L2，
				// 而 L2 需要「顯示陳舊資料時明確標示它是陳舊的」（規格 §8），
				// 那是 UI 的責任，不是 service worker 設定能單獨完成的事。
				// 先快取了資料卻沒有標示，比不快取更糟。
				globPatterns: ["**/*.{js,css,html,ico,png,svg,woff2}"],
			},
		}),
	],
	server: {
		proxy: {
			// 規格決策 1：dev 也同源。瀏覽器看到的一律是 http://localhost:5173/api/...，
			// 由 Vite 轉給 localhost:8000 —— 所以 app 的程式碼裡永遠只寫相對路徑
			// "/api/..."，沒有任何地方需要知道後端在哪裡。
			//
			// 這也代表**不需要 CORS**：後端 app/main.py 沒有 CORSMiddleware，
			// 而同源之下也不該有。哪天有人為了「方便」在後端加 CORS，
			// 那是一個訊號：某個地方的同源假設破了。
			"/api": {
				target: "http://localhost:8000",
				changeOrigin: false,
			},
		},
	},
	test: {
		environment: "jsdom",
		setupFiles: ["./src/test/setup.ts"],
		globals: true,
		// 讓 expectTypeOf 真的被檢查，而不是一個永遠通過的 no-op。
		// Vitest 5 的 typecheck.include 預設只認 *.test-d.ts，我們把型別層
		// 測試跟一般測試放在同一個 *.test.ts 檔案裡，所以要覆寫成同一個
		// glob——這樣同一支檔案會被跑兩次：一次當一般測試執行，一次交給
		// tsc 做型別檢查（`npm run test` 就會觸發，不需要額外的 CLI flag）。
		//
		// tsconfig 必須明講：不指定的話 vitest 會找到 frontend/tsconfig.json
		// ——那份只是 project references 的殼（"files": []、沒有自己的
		// compilerOptions），不是 tsconfig.app.json 那份有 strict、有
		// include: ["src","tests"] 的實際設定。實測過：不指定時，把
		// schema.d.ts 的 protein_g 從 string 改成 number，typecheck 還是
		// 全線通過——是假綠燈。指到 tsconfig.app.json 之後同一個突變才會紅。
		// glob 蓋 .test.ts 也蓋 .test.tsx（Task 8 加了第一個 .tsx 測試檔）。
		// 實測過兩種寫法的差異：tsconfig.app.json 的 include 涵蓋整個
		// src/tests，所以 tsc 的 Program 本來就會把 .tsx 檔也編進去，
		// 一個純型別錯誤（例如把 login.test.tsx 裡的字串塞進 number
		// 變數）就算 include 只寫 *.test.ts 也還是會讓 npm run test
		// 的 exit code 變成 1——不是完全沒有防護，只是被歸類成一則
		// 語氣不確定的「Unhandled Errors ... may cause false positive
		// tests」，沒有掛在對應的檔案底下、Test Files 也不會顯示那支
		// 檔案失敗。把 .tsx 補進這個 glob 之後，同一個突變會變成乾淨的
		// FAIL tests/login.test.tsx，可以在報告裡直接看出是哪一支
		// 檔案、哪一行——不再是仰賴「診斷剛好從整個 Program 漏出來」
		// 這個沒有文件保證的行為。
		typecheck: {
			enabled: true,
			tsconfig: "./tsconfig.app.json",
			include: ["tests/**/*.test.?(c|m)[jt]s?(x)"],
		},
	},
});
